"""Portable regressions for the exact project copy passed to a reviewer test."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("review", Path(__file__).resolve().parents[1] / "scripts/runtime/project-review-test.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ProjectReviewSnapshot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name, "source")
        self.root.mkdir()
        self.fd = os.open(self.root, review.DIRECTORY)
        self.addCleanup(os.close, self.fd)

    def copy(self):
        target = Path(tempfile.mkdtemp(dir=self.temp.name))
        return review.snapshot(self.fd, target), target

    def test_snapshot_filters_links_hidden_files_and_dependency_trees(self):
        (self.root / "tests").mkdir()
        (self.root / "tests/check").write_text("source")
        (self.root / ".env").write_text("private")
        (self.root / "Node_Modules").mkdir()
        (self.root / "Node_Modules/tool").write_text("dependency")
        external = Path(self.temp.name, "external")
        external.write_text("outside")
        os.link(external, self.root / "hardlink")
        (self.root / "linked").symlink_to(external.parent)
        digest, target = self.copy()
        self.assertEqual(sorted(str(p.relative_to(target)) for p in target.rglob("*")), ["tests", "tests/check"])
        self.assertEqual((target / "tests/check").read_text(), "source")
        (target / "tests/check").write_text("scratch")
        self.assertEqual(self.copy()[0], digest)
        (self.root / "tests/check").chmod(0o755)
        self.assertNotEqual(self.copy()[0], digest)

    def test_oversized_inputs_fail_before_command_can_start(self):
        (self.root / "large").write_bytes(b"abcde")
        with patch.object(review, "MAX_FILE", 4), self.assertRaises(ValueError):
            self.copy()
        with patch.object(review, "MAX_BYTES", 4), self.assertRaises(ValueError):
            self.copy()
        with patch.object(review, "MAX_ENTRIES", 0), self.assertRaises(ValueError):
            self.copy()


if __name__ == "__main__":
    unittest.main()
