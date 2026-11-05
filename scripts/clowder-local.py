#!/usr/bin/env python3
"""Manage only this checkout's compiled Clowder API/Web; Redis stays independent."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


class ManagementError(Exception):
    pass


def command_output(command, absent_ok=False):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ManagementError("无法完成进程或构建身份检查。") from exc
    if result.returncode and not (absent_ok and result.returncode == 1 and not result.stderr.strip()):
        raise ManagementError("系统检查失败；请在具有 ps/lsof 访问权限的本机终端运行。")
    return result.stdout.strip()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError as exc:
        raise ManagementError("无权验证记录中的进程，拒绝操作。") from exc


def listeners(port):
    output = command_output(
        ["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fp"], absent_ok=True
    )
    return {int(line[1:]) for line in output.splitlines() if re.fullmatch(r"p\d+", line)}


class LocalServices:
    def __init__(self, root, node, redis_bin):
        self.root = root.resolve()
        self.node = node.resolve()
        self.redis_bin = redis_bin.resolve()
        self.state_path = self.root / ".cat-cafe/local-processes.json"
        self.commands = {
            "api": [str(self.node), "--env-file=.env", "packages/api/dist/index.js"],
            "web": [str(self.node), "--env-file=.env", "packages/web/node_modules/next/dist/bin/next",
                    "start", "packages/web", "-p", "3003", "-H", "127.0.0.1"],
        }

    def read_state(self):
        try:
            state = json.loads(self.state_path.read_text())
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            raise ManagementError("进程状态文件不可读或格式错误；未修改服务。") from exc
        if not isinstance(state, dict) or set(state) - set(self.commands):
            raise ManagementError("进程状态文件包含未知服务，拒绝操作。")
        for service, record in state.items():
            if not isinstance(record, dict):
                raise ManagementError("进程状态记录格式错误。")
            pid = record.get("pid")
            if type(pid) is not int or pid <= 1 or pid in {os.getpid(), os.getppid()}:
                raise ManagementError("进程状态 PID 不合法。")
            expected_log = str(self.root / f"logs/local-{service}.log")
            if (record.get("cwd") != str(self.root) or record.get("command") != self.commands[service]
                    or record.get("log") != expected_log):
                raise ManagementError("记录中的目录、命令或日志路径不属于当前服务配置。")
        return state

    def write_state(self, state):
        # Atomic metadata replacement; never remove application data or logs.
        with tempfile.NamedTemporaryFile(mode="w", dir=self.state_path.parent,
                                         prefix=".local-processes-", delete=False) as output:
            temporary = Path(output.name)
            json.dump(state, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            os.replace(temporary, self.state_path)
        finally:
            temporary.unlink(missing_ok=True)

    @contextlib.contextmanager
    def lock(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with (self.state_path.parent / "local-processes.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ManagementError("另一项启动或停止操作正在进行。") from exc
            yield

    def verify_process(self, service, record):
        pid = record["pid"]
        if not alive(pid):
            return False
        output = command_output(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd,txt", "-Fn"],
                                absent_ok=True)
        paths = {}
        descriptor = None
        for line in output.splitlines():
            if line.startswith("f"):
                descriptor = line[1:]
            elif line.startswith("n"):
                paths.setdefault(descriptor, []).append(line[1:])
        process_command = command_output(["/bin/ps", "-p", str(pid), "-o", "command="], absent_ok=True)
        if not alive(pid):
            return False
        if str(self.root) not in paths.get("cwd", []) or str(self.node) not in paths.get("txt", []):
            raise ManagementError(f"{service}: PID 工作目录或可执行文件不匹配，拒绝操作。")
        uid = command_output(["/bin/ps", "-p", str(pid), "-o", "uid="])
        if uid != str(os.getuid()):
            raise ManagementError(f"{service}: PID 不属于当前用户，拒绝操作。")
        try:
            matches = shlex.split(process_command) == record["command"]
        except ValueError:
            matches = False
        # Next replaces process.title; require its precise title AND cwd/Node identity above.
        if service == "web" and re.fullmatch(r"next-server \(v\d+\.\d+\.\d+(?:[-+][\w.-]+)?\)", process_command):
            matches = True
        if not matches:
            raise ManagementError(f"{service}: PID 实际命令身份不匹配，拒绝操作。")
        return True

    def check_build(self):
        if not self.root.is_dir() or not self.node.is_file() or not (self.root / ".env").is_file():
            raise ManagementError("源码目录、Node 24 或 .env 缺失。")
        if not command_output([str(self.node), "--version"]).startswith("v24."):
            raise ManagementError("需要指定 Node.js 24。")
        head = command_output(["git", "-C", str(self.root), "rev-parse", "HEAD"])
        for package, directory in (("shared", "dist"), ("mcp-server", "dist"), ("api", "dist"), ("web", ".next")):
            try:
                stamp = (self.root / "packages" / package / directory / ".build-commit").read_text().strip()
            except OSError as exc:
                raise ManagementError(f"{package}: 缺少构建提交标记，请先完成构建。") from exc
            if stamp != head:
                raise ManagementError(f"{package}: 构建提交与 HEAD 不一致，请重新构建。")
        for relative in ("packages/api/dist/index.js", "packages/mcp-server/dist/index.js",
                         "packages/web/.next/BUILD_ID", "packages/web/node_modules/next/dist/bin/next"):
            if not (self.root / relative).is_file():
                raise ManagementError("构建产物不完整，请先完成构建。")

    def environment(self):
        env = os.environ.copy()
        env.update({
            "PATH": os.pathsep.join((str(self.node.parent), str(self.redis_bin), env.get("PATH", ""))),
            "NODE_ENV": "production", "SHARP_IGNORE_GLOBAL_LIBVIPS": "1",
            "CAT_CAFE_RUNTIME_ROOT": str(self.root), "CAT_CAFE_WORKSPACE_ROOT": str(self.root),
            "CAT_CAFE_DEPLOYMENT_ID": "worktree", "CAT_CAFE_RUNTIME_WEB_PORT": "3003",
            "CAT_CAFE_MCP_SERVER_PATH": str(self.root / "packages/mcp-server/dist/index.js"),
            "CAT_CAFE_PROFILE": "opensource",
        })
        env.update({f"{kind}_TTL_SECONDS": "0" for kind in ("MESSAGE", "THREAD", "TASK", "SUMMARY")})
        return env

    def start(self):
        with self.lock():
            self.check_build()
            state = self.read_state()
            running = {name: self.verify_process(name, record) for name, record in state.items()}
            for port, service in ((3003, "web"), (3004, "api"), (4100, "api")):
                allowed = {state[service]["pid"]} if running.get(service) else set()
                if listeners(port) - allowed:
                    raise ManagementError(f"端口 {port} 被当前实例之外的进程占用；未启动任何服务。")
            missing = [name for name in self.commands if not running.get(name)]
            if not missing:
                print("已有归属正确的 API/Web 进程，保留运行。")
            (self.root / "logs").mkdir(exist_ok=True)
            for service in missing:
                log_path = self.root / f"logs/local-{service}.log"
                with log_path.open("ab") as log:
                    process = subprocess.Popen(self.commands[service], cwd=self.root, env=self.environment(),
                                               stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                               start_new_session=True)
                state[service] = {"pid": process.pid, "cwd": str(self.root), "log": str(log_path),
                                  "command": self.commands[service]}
                self.write_state(state)
                print(f"{service}: 已启动，PID {process.pid}。")
        # Bounded startup grace period, with no retries that spawn more processes.
        if missing:
            time.sleep(2)
        return self.status()

    def stop(self):
        with self.lock():
            state = self.read_state()
            # Validate every live record before sending any signal.
            running = {name: self.verify_process(name, record) for name, record in state.items()}
            for service in ("web", "api"):
                if running.get(service) and self.verify_process(service, state[service]):
                    try:
                        os.kill(state[service]["pid"], signal.SIGTERM)
                        print(f"{service}: 已向核实归属的进程发送 TERM。")
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and any(alive(state[name]["pid"]) for name in running if running[name]):
                time.sleep(0.2)
            remaining = [name for name in running if running[name] and alive(state[name]["pid"])]
            if remaining:
                print("仍在退出：" + ", ".join(remaining) + "；未强制终止。")
                return 1
            print("API/Web 已停止；Redis、应用数据和日志保留。")
            return 0

    def status(self):
        state = self.read_state()
        healthy = True
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for service, url in (("api", "http://127.0.0.1:3004/ready"), ("web", "http://127.0.0.1:3003/")):
            owned = service in state and self.verify_process(service, state[service])
            status = None
            if owned:
                try:
                    with opener.open(url, timeout=3) as response:
                        status = response.status
                except urllib.error.HTTPError as exc:
                    status = exc.code
                except (OSError, urllib.error.URLError, TimeoutError):
                    pass
            ok = owned and status == 200
            healthy = healthy and ok
            detail = f"HTTP {status}" if status is not None else "健康端点不可用"
            print(f"{service}: " + (f"健康（{detail}）" if ok else f"未就绪（{detail if owned else '无已核实的存活进程'}）"))
        return 0 if healthy else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "status"))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / "clowder-ai-latest")
    parser.add_argument("--node", type=Path, default=Path.home() / ".local/node-v24/bin/node")
    parser.add_argument("--redis-bin", type=Path, default=Path.home() / ".local/redis/bin")
    args = parser.parse_args()
    try:
        return getattr(LocalServices(args.root, args.node, args.redis_bin), args.action)()
    except (ManagementError, OSError) as exc:
        message = str(exc) if isinstance(exc, ManagementError) else "文件或进程操作失败；请检查本机权限。"
        print(message, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
