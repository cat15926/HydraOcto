"""Run one reviewer's test in the registered Linux VM. Project code sees only a disposable copy."""
import hashlib
import json
import os
from pathlib import Path
import resource
import runpy
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

MAX_FILE = 4 * 1024 * 1024
MAX_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_OUTPUT = 16 * 1024
TIME_LIMIT = 45
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
RUNNER = "/opt/multi-agent/project-vm-runner.py"


def snapshot(source_fd, destination):
    """Build a manifest of the exact bytes to be tested. Do not follow user-controlled links."""
    root_stat = os.fstat(source_fd)
    total = entries = 0
    manifest = hashlib.sha256()

    def visit(fd, relative):
        nonlocal entries, total
        before_dir = os.fstat(fd)
        with os.scandir(fd) as iterator:
            names = []
            for entry in iterator:
                entries += 1
                if entries > MAX_ENTRIES:
                    raise ValueError("项目条目超过测试快照上限")
                if not entry.name.startswith(".") and entry.name.lower() not in ("node_modules", "__pycache__"):
                    names.append(entry.name)
        for name in sorted(names):
            path = relative / name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if info.st_dev != root_stat.st_dev:
                continue
            target = destination / path
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIRECTORY, dir_fd=fd)
                try:
                    if not os.path.samestat(info, os.fstat(child)):
                        raise ValueError("目录已变化")
                    target.mkdir()
                    manifest.update(b"D" + os.fsencode(path) + b"\0")
                    visit(child, path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                data_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(data_fd, "rb") as stream:
                    first = os.fstat(stream.fileno())
                    if not os.path.samestat(first, info) or first.st_nlink != 1 or first.st_size > MAX_FILE:
                        raise ValueError("文件变化或超过测试快照上限")
                    if total + first.st_size > MAX_BYTES:
                        raise ValueError("项目超过测试快照上限")
                    data = stream.read(first.st_size + 1)
                    last = os.fstat(stream.fileno())
                    if (len(data) != first.st_size or last.st_ctime_ns != first.st_ctime_ns or
                            not os.path.samestat(last, os.stat(name, dir_fd=fd, follow_symlinks=False))):
                        raise ValueError("文件已变化")
                total += len(data)
                target.write_bytes(data)
                executable = bool(first.st_mode & 0o111)
                target.chmod(0o700 if executable else 0o600)
                manifest.update((b"X" if executable else b"F") + os.fsencode(path) + b"\0" + hashlib.sha256(data).digest())
        if before_dir.st_ctime_ns != os.fstat(fd).st_ctime_ns:
            raise ValueError("目录已变化")
    visit(source_fd, Path(""))
    return manifest.hexdigest()


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def limits(seconds):
    for key, count in ((resource.RLIMIT_CPU, seconds), (resource.RLIMIT_NPROC, 128),
                       (resource.RLIMIT_NOFILE, 256), (resource.RLIMIT_FSIZE, MAX_BYTES),
                       (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(key, (count, count))


def run_test(argv, stage, sandbox_policy, npm_private=None, install=False):
    # All project commands, including shell scripts and their descendants, run inside this namespace.
    # /inputs contains private copies only. No path in the sandbox points to the original project.
    launch = ("import os,shutil,sys;shutil.copytree('/inputs','/work',dirs_exist_ok=True);"
              "os.makedirs('/tmp/home',exist_ok=True);os.execvp(sys.argv[1],sys.argv[1:])")
    info_r, info_w = os.pipe()
    gate_r, gate_w = os.pipe()
    filter_fd = sandbox_policy()
    args = ["/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--disable-userns", "--as-pid-1", "--die-with-parent",
            "--new-session", "--cap-drop", "ALL", "--info-fd", str(info_w), "--block-fd", str(gate_r),
            "--seccomp", str(filter_fd), "--clearenv", "--ro-bind", "/usr", "/usr"]
    for name in ("/bin", "/sbin", "/lib", "/lib64"):
        if os.path.islink(name):
            args += ["--symlink", os.readlink(name), name]
        elif os.path.isdir(name):
            args += ["--ro-bind", name, name]
    seconds = 120 if npm_private else TIME_LIMIT
    tool_path = "/usr/local/bin:/usr/bin:/bin" if npm_private else "/usr/bin:/bin"
    args += ["--dev", "/dev", "--ro-bind", str(stage), "/inputs", "--size", str(128 * 1024 ** 2), "--tmpfs", "/work",
             "--size", str((256 if npm_private else 32) * 1024 ** 2), "--tmpfs", "/tmp"]
    if npm_private:
        # npm needs the node executable location. Do not mount guest or parent procfs.
        node = shutil.which("node", path=tool_path)
        if not node or not shutil.which("npm", path=tool_path):
            raise ValueError("项目虚拟机缺少 Node.js 或 npm")
        # A guest may keep its independently installed Node under /opt. Mount only that executable.
        tool_path = "/runtime/bin:" + tool_path
        args += ["--ro-bind", os.path.realpath(node), "/runtime/bin/node", "--symlink", "/runtime/bin/node", "/proc/self/exe",
                 "--bind", str(npm_private / "node_modules"), "/work/node_modules",
                 "--setenv", "npm_config_offline", "true", "--setenv", "npm_config_audit", "false",
                 "--setenv", "npm_config_fund", "false", "--setenv", "npm_config_update_notifier", "false"]
        if install:
            args += ["--ro-bind", str(npm_private / "packages"), "/packages",
                     "--ro-bind", str(npm_private / "install-lock.json"), "/install-lock.json"]
            launch = launch.replace("os.execvp", "shutil.copyfile('/install-lock.json','/work/package-lock.json');os.execvp")
    args += ["--remount-ro", "/", "--chdir", "/work",
             "--setenv", "HOME", "/tmp/home", "--setenv", "PATH", tool_path, "--setenv", "TMPDIR", "/tmp",
             "--setenv", "LANG", "C.UTF-8", "--", "/usr/bin/python3", "-I", "-c", launch, *argv]
    env = {"PATH": "/usr/bin:/bin"}
    try:
        child = subprocess.Popen(args, cwd="/", env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, pass_fds=(info_w, gate_r, filter_fd), preexec_fn=lambda: limits(seconds))
    finally:
        for fd in (info_w, gate_r, filter_fd):
            os.close(fd)
    init_fd = None
    data = bytearray()
    truncated = False
    try:
        with os.fdopen(info_r, "rb") as info:
            if not select.select([info], [], [], 5)[0]:
                raise ValueError("测试隔离环境启动超时")
            report = info.read(8192)
            if not report:
                startup_error = child.stdout.read(512).decode(errors="replace")
                raise ValueError("测试隔离环境未就绪 " + startup_error.strip()[:95])
            init_pid = json.loads(report)["child-pid"]
            init_fd = os.pidfd_open(init_pid)
        os.write(gate_w, b"x")
        cutoff = time.monotonic() + seconds
        while True:
            left = cutoff - time.monotonic()
            if left <= 0:
                raise ValueError(f"测试超过 {seconds} 秒")
            readable = select.select([child.stdout, sys.stdin], [], [], min(left, 1))[0]
            if sys.stdin in readable:  # EOF (including transport loss) and explicit stop both cancel.
                raise ValueError("测试已停止")
            if child.stdout in readable:
                chunk = os.read(child.stdout.fileno(), 16384)
                if not chunk:
                    break
                available = MAX_OUTPUT - len(data)
                data.extend(chunk[:available])
                truncated |= len(chunk) > available
        code = child.wait(timeout=3)
        return {"exitCode": code, "output": data.decode(errors="replace"), "truncated": truncated}
    finally:
        # SIGKILL to the exact namespace init terminates descendants, including detached background jobs.
        # Never open the bwrap input gate on failure before that init and its monitor have been reaped.
        if init_fd is not None:
            try:
                signal.pidfd_send_signal(init_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if child.poll() is None:
            child.kill()
        child.wait(timeout=4)
        if init_fd is not None:
            if not select.select([init_fd], [], [], 4)[0]:
                os._exit(125)  # no confirmed exit frame: host retains the VM lease
            os.close(init_fd)
        os.close(gate_w)
        child.stdout.close()


def main():
    boot, device, inode, digest = sys.argv[1:]
    if os.geteuid() == 0 or Path("/proc/sys/kernel/random/boot_id").read_text().strip() != boot:
        raise ValueError("测试虚拟机身份已变化")
    if hashlib.sha256(Path(RUNNER).read_bytes()).hexdigest() != digest:
        raise ValueError("测试虚拟机执行器已变化")
    policy = runpy.run_path(RUNNER)
    policy["libc_call"]("prctl", 38, 1, 0, 0, 0)
    fd = os.open("/mnt/project", DIRECTORY)
    try:
        meta = os.fstat(fd)
        if (meta.st_dev, meta.st_ino) != (int(device), int(inode)):
            raise ValueError("测试项目挂载已变化")
        with tempfile.TemporaryDirectory(prefix="review-", dir="/dev/shm") as stage:
            digest = snapshot(fd, Path(stage))
            emit({"state": "ready", "snapshotSha256": digest})
            line = sys.stdin.buffer.readline(16385)
            if not line:
                raise ValueError("测试已停止")
            request = json.loads(line)
            npm = isinstance(request, dict) and request.get("mode") == "npm"
            argv = request.get("argv") if npm else request
            if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(
                    not isinstance(arg, str) or "\x00" in arg for arg in argv) or not argv[0].strip():
                raise ValueError("测试命令无效")
            if npm:
                project_checks = request.get("projectNpmChecks") is True
                script = npm_check_script(argv, project_checks)
                if project_checks and not script_declared(Path(stage), script):
                    emit({"state": "skipped", "script": script})
                    return
                with tempfile.TemporaryDirectory(prefix="review-npm-", dir="/dev/shm") as private_dir:
                    private = Path(private_dir)
                    prepare_npm(Path(stage), private)
                    (private / "node_modules").mkdir()
                    installed = run_test(["npm", "ci", "--offline", "--ignore-scripts"], stage, policy["syscall_policy"], private, install=True)
                    if installed["exitCode"]:
                        reason = installed["output"].strip().splitlines()
                        raise ValueError("npm 离线安装失败 " + " ".join(reason[:2])[:95])
                    emit({"state": "testing"})
                    result = run_test(argv, stage, policy["syscall_policy"], private)
            else:
                result = run_test(argv, stage, policy["syscall_policy"])
    finally:
        os.close(fd)
    emit({"state": "exited", **result})


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        emit({"state": "failed", "reason": str(error)[:128]})
    # An unexpected controller failure is not proof that the command tree exited.
