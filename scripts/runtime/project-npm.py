"""Prepare integrity-checked npm tarballs for a disconnected, disposable Linux test workspace."""
import base64
import hashlib
import json
import os
import re
import select
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

MAX_PACKAGES = 1024
MAX_TARBALL = 32 * 1024 ** 2
MAX_TARBALL_TOTAL = 192 * 1024 ** 2
PACKAGE_NAME = r"(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*/)?[a-zA-Z0-9][a-zA-Z0-9._-]*"


def npm_check_script(argv, project_checks):
    if argv == ["npm", "test"]:
        return "test"
    if argv[:3] == ["npm", "test", "--"] and (len(argv) > 3 or not project_checks):
        return "test"
    if project_checks and argv in (["npm", "run", "typecheck"], ["npm", "run", "build"]):
        return argv[2]
    if project_checks:
        raise ValueError("支持 npm test、npm run typecheck 或 npm run build；测试参数请放在 -- 后")
    raise ValueError("请输入 npm test 或在 -- 后添加测试参数")


def script_declared(stage, name):
    path = stage / "package.json"
    if not path.is_file():
        raise ValueError("npm 检查需要根目录的 package.json")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("无法解析项目的 package.json") from None
    if not isinstance(manifest, dict) or not isinstance(manifest.get("scripts", {}), dict):
        raise ValueError("package.json 中的 scripts 格式无效")
    script = manifest.get("scripts", {}).get(name)
    return isinstance(script, str) and bool(script.strip())


def npm_plan(stage):
    lock_path = stage / "package-lock.json"
    if not lock_path.is_file() or not (stage / "package.json").is_file():
        raise ValueError("npm 测试需要 package.json 和 package-lock.json")
    content = lock_path.read_bytes()
    lock = json.loads(content)
    if not isinstance(lock, dict) or lock.get("lockfileVersion") not in (2, 3):
        raise ValueError("支持 package-lock 版本 2 或 3")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or "" not in packages or len(packages) > MAX_PACKAGES + 1:
        raise ValueError("npm 锁文件缺少包清单或超过包数上限")

    bundles = {}
    for path, item in packages.items():
        if path == "":
            continue
        if (not isinstance(item, dict) or len(path) > 1024 or not re.fullmatch(
                r"node_modules/" + PACKAGE_NAME + r"(?:/node_modules/" + PACKAGE_NAME + r")*", path)):
            raise ValueError("当前支持 npm registry 包，请检查工作区或本地依赖")
        name = item.get("name", path.rsplit("node_modules/", 1)[-1])
        version = item.get("version")
        if (not isinstance(name, str) or len(name) > 214 or not re.fullmatch(PACKAGE_NAME, name)
                or not isinstance(version, str) or not re.fullmatch(r"[0-9][A-Za-z0-9.+-]{0,79}", version)):
            raise ValueError("npm 锁文件包含不支持的包名或版本")
        expected = f"https://registry.npmjs.org/{name}/-/{name.split('/')[-1]}-{version}.tgz"
        integrity = item.get("integrity")
        if item.get("link") or item.get("resolved") != expected or not isinstance(integrity, str) or not integrity.startswith("sha512-"):
            raise ValueError("仅支持带 SHA-512 的 npm 官方 registry 锁定包")
        try:
            checksum = base64.b64decode(integrity[7:], validate=True)
        except ValueError:
            raise ValueError("npm 锁文件中的 SHA-512 无效") from None
        if len(checksum) != 64:
            raise ValueError("npm 锁文件中的 SHA-512 无效")
        key = checksum.hex()
        bundles[key] = (f"{name}@{version}", expected)
        item["resolved"] = f"file:/packages/{key}.tgz"
    # npm reads packages for v2 and v3. Drop v2 compatibility data from the installation-only copy.
    lock.pop("dependencies", None)
    return hashlib.sha256(content).hexdigest(), lock, bundles


class IntegrityError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def check_cancel():
    if select.select([sys.stdin], [], [], 0)[0]:
        raise ValueError("依赖准备已停止")


def copy_verified(source, target, key, budget, check):
    digest = hashlib.sha512()
    count = 0
    while True:
        check()
        chunk = source.read(64 * 1024)
        if not chunk:
            break
        count += len(chunk)
        if count > min(budget, MAX_TARBALL):
            raise ValueError("npm 依赖超过测试副本容量")
        target.write(chunk)
        digest.update(chunk)
    if digest.hexdigest() != key:
        raise IntegrityError("npm 依赖内容与锁文件校验不符")
    return count


def materialize(bundles, private, cache, authorize, check=check_cancel, opener=None):
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    chunks = private / "packages"
    chunks.mkdir()
    missing = {}
    remaining = MAX_TARBALL_TOTAL
    for key, package in bundles.items():
        check()
        try:
            with (cache / key).open("rb") as source, (chunks / (key + ".tgz")).open("wb") as target:
                remaining -= copy_verified(source, target, key, remaining, check)
        except (FileNotFoundError, IntegrityError):
            missing[key] = package
    if not missing:
        return
    authorize(sorted({label for label, _ in missing.values()}))
    # Controller uses no project npmrc, cookies, proxy or credentials. Project scripts stay offline.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for key, (_, url) in missing.items():
        check()
        try:
            with opener.open(url, timeout=5) as source, (chunks / (key + ".tgz")).open("wb") as target:
                remaining -= copy_verified(source, target, key, remaining, check)
        except (OSError, urllib.error.URLError):
            raise ValueError("npm registry 下载失败，可检查网络后重试") from None
        check()
        with tempfile.NamedTemporaryFile(dir=cache, prefix=".part-", delete=False) as part:
            path = Path(part.name)
            try:
                with (chunks / (key + ".tgz")).open("rb") as source:
                    shutil.copyfileobj(source, part)
                part.flush()
                os.replace(path, cache / key)
            finally:
                path.unlink(missing_ok=True)


def prepare_npm(stage, private):
    lock_sha, lock, bundles = npm_plan(stage)

    def authorize(missing):
        emit({"state": "download", "lockSha256": lock_sha, "packages": missing})
        line = sys.stdin.buffer.readline(512)
        if not line or json.loads(line) != {"allow": lock_sha}:
            raise ValueError("本次依赖下载未获授权")

    cache = Path.home() / ".cache" / "multi-agent" / "npm-integrity-v1"
    materialize(bundles, private, cache, authorize)
    (private / "install-lock.json").write_text(json.dumps(lock))
