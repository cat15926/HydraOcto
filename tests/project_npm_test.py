import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("project_npm", Path(__file__).resolve().parents[1] / "scripts/runtime/project-npm.py")
npm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(npm)


class ProjectNpmTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name, "project")
        self.project.mkdir()
        (self.project / "package.json").write_text("{}")
        self.cache = Path(self.temp.name, "cache")
        self.blob = b"locked test tarball"
        self.digest = hashlib.sha512(self.blob).digest()
        self.url = "https://registry.npmjs.org/@scope/example/-/example-1.2.3.tgz"
        self.item = {"version": "1.2.3", "integrity": "sha512-" + base64.b64encode(self.digest).decode(),
                     "resolved": self.url}
        self.requests = []
        self.authorizations = []

    def open(self, url, timeout):
        self.requests.append(url)
        return io.BytesIO(self.blob)

    def plan(self, path="node_modules/@scope/example"):
        lock = {"lockfileVersion": 3, "packages": {"": {}, path: self.item}}
        (self.project / "package-lock.json").write_text(json.dumps(lock))
        return npm.npm_plan(self.project)

    def prepare(self, bundles, authorize):
        directory = Path(tempfile.mkdtemp(dir=self.temp.name))
        npm.materialize(bundles, directory, self.cache, authorize, lambda: None, self)
        return directory

    def test_scoped_dependency_download_once_then_offline_and_original_lock_unchanged(self):
        lock_sha, lock, bundles = self.plan()
        self.assertEqual(hashlib.sha256((self.project / "package-lock.json").read_bytes()).hexdigest(), lock_sha)
        self.assertIn(self.url, (self.project / "package-lock.json").read_text())
        self.assertEqual(lock["packages"]["node_modules/@scope/example"]["resolved"], "file:/packages/" + self.digest.hex() + ".tgz")
        for _ in range(2):
            files = self.prepare(bundles, self.authorizations.append)
            self.assertEqual((files / "packages" / (self.digest.hex() + ".tgz")).read_bytes(), self.blob)
        self.assertEqual(self.requests, [self.url])
        self.assertEqual(self.authorizations, [["@scope/example@1.2.3"]])

    def test_denied_or_cancelled_preparation_cannot_fetch(self):
        _, _, bundles = self.plan()
        def refuse(*args):
            raise ValueError("拒绝")
        with self.assertRaisesRegex(ValueError, "拒绝"):
            self.prepare(bundles, refuse)
        with self.assertRaisesRegex(ValueError, "拒绝"):
            npm.materialize(bundles, Path(tempfile.mkdtemp(dir=self.temp.name)), self.cache, self.fail, refuse, self)
        self.assertFalse(self.requests)
        self.assertFalse(list(self.cache.iterdir()))

    def test_invalid_network_content_never_becomes_cache_and_corrupt_cache_requires_authorization(self):
        _, _, bundles = self.plan()
        self.blob = b"unexpected"
        with self.assertRaises(npm.IntegrityError):
            self.prepare(bundles, self.authorizations.append)
        self.assertFalse(list(self.cache.iterdir()))
        (self.cache / self.digest.hex()).write_bytes(self.blob)
        self.blob = b"locked test tarball"
        self.prepare(bundles, self.authorizations.append)
        self.assertEqual(len(self.authorizations), 2)
        self.assertEqual((self.cache / self.digest.hex()).read_bytes(), self.blob)

    def test_lock_name_hosts_urls_links_and_integrity_are_restricted(self):
        for value in ("file:/root/example.tgz", "https://example.com/p.tgz", self.url + "?data=value",
                      self.url.replace("example-1.2.3", "other-2.3.4")):
            with self.subTest(value=value):
                self.item["resolved"] = value
                with self.assertRaises(ValueError):
                    self.plan()
        self.item["resolved"] = self.url
        with self.assertRaises(ValueError):
            self.plan(path="node_modules/../../project")
        self.item["integrity"] = "sha512-broken"
        with self.assertRaises(ValueError):
            self.plan()

    def test_project_checks_allow_only_declared_command_shapes(self):
        for argv in (["npm", "test"], ["npm", "test", "--", "--edge"]):
            for project_checks in (True, False):
                self.assertEqual(npm.npm_check_script(argv, project_checks), "test")
        self.assertEqual(npm.npm_check_script(["npm", "test", "--"], False), "test")
        for name in ("typecheck", "build"):
            argv = ["npm", "run", name]
            self.assertEqual(npm.npm_check_script(argv, True), name)
            with self.assertRaises(ValueError):
                npm.npm_check_script(argv, False)
        for argv in (["npm", "test", "--help"], ["npm", "test", "--"], ["npm", "run", "deploy"],
                     ["npm", "--prefix", "..", "run", "build"], ["npm", "run", "build", "--"],
                     ["npm", "run", "typecheck", "--if-present"], ["npm", "run-script", "build"]):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                npm.npm_check_script(argv, True)

    def test_missing_scripts_are_distinct_from_a_broken_manifest(self):
        path = self.project / "package.json"
        path.write_text(json.dumps({"scripts": {"build": "node check.cjs", "typecheck": " "}}))
        self.assertTrue(npm.script_declared(self.project, "build"))
        self.assertFalse(npm.script_declared(self.project, "test"))
        self.assertFalse(npm.script_declared(self.project, "typecheck"))
        for manifest in ("{", "[]", '{"scripts":[]}'):
            path.write_text(manifest)
            with self.subTest(manifest=manifest), self.assertRaisesRegex(ValueError, "package.json"):
                npm.script_declared(self.project, "build")
        path.unlink()
        with self.assertRaisesRegex(ValueError, "package.json"):
            npm.script_declared(self.project, "build")


if __name__ == "__main__":
    unittest.main()
