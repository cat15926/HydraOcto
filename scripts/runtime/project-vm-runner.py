#!/usr/bin/env python3
"""Trusted Linux guest supervisor. The host owns credentials and the single-use mount challenge."""
import argparse
import asyncio
import base64
import codecs
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import traceback
import uuid

PROJECT = "/mnt/project"
BIN_DIR = "/opt/multi-agent/bin"
HOST_FRAME_LIMIT = 12 * 1024 * 1024
MAX_BODY = 4 * 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
GATEWAY = "__PROJECT_GATEWAY__"


def emit(message):
    sys.stdout.buffer.write(json.dumps(message, separators=(",", ":"), ensure_ascii=True).encode() + b"\n")
    sys.stdout.buffer.flush()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def libc_call(name, *args):
    libc = ctypes.CDLL(None, use_errno=True)
    if name == "mount":
        libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
    if getattr(libc, name)(*args) != 0:
        error = ctypes.get_errno()
        raise OSError(error, f"{name} {args[1] if name == 'mount' else ''}: {os.strerror(error)}")


def directory_fd(opts):
    require(opts.project == PROJECT, "unexpected project mount point")
    fd = os.open(PROJECT, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_PATH)
    info = os.fstat(fd)
    require((info.st_dev, info.st_ino) == (opts.device, opts.inode), "guest directory identity changed")
    require(re.fullmatch(r"\.multi-agent-bind-[0-9a-f]{32}", opts.marker), "invalid challenge filename")
    require(re.fullmatch(r"[0-9a-f]{32,128}", opts.nonce), "invalid challenge nonce")
    marker = os.open(opts.marker, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(marker, "rb") as stream:
        marker_info = os.fstat(stream.fileno())
        require(stat.S_ISREG(marker_info.st_mode) and marker_info.st_nlink == 1 and
                stream.read(256).rstrip(b"\n") == opts.nonce.encode(), "mount challenge failed")
    table = Path("/proc/self/mountinfo").read_text().splitlines()
    require(any(line.split()[4] == PROJECT and line.split(" - ")[1].split()[0] == "virtiofs"
                for line in table), "project must be the root of a dedicated virtiofs mount")
    return fd


def trusted_binary(carrier):
    require(carrier in ("claude", "codex"), "unknown CLI")
    path = Path(BIN_DIR, carrier).resolve(strict=True)
    # Only the resolved executable is exposed, never the install user's home or settings.
    for entry in (path, *path.parents, Path(BIN_DIR), *Path(BIN_DIR).parents):
        meta = entry.stat()
        require(meta.st_uid == 0 and meta.st_mode & 0o022 == 0, "CLI installation must be owned by root")
    require(path.is_file() and os.access(path, os.X_OK), "installed CLI is not executable")
    with path.open("rb") as stream:
        require(stream.read(4) == b"\x7fELF", "guest CLI must be a native ELF")
    return path


# Runs *inside* the same unprivileged mount/PID/network domain as a project CLI.
# Only the supervisor exchanges these records. A command has a separate stdin
# and its output is always data, never interpreted as another control frame.
PROJECT_COMMAND_WORKER = r"""
import json, os, selectors, signal, subprocess, sys, time
for line in sys.stdin.buffer:
    req = json.loads(line)
    command = req["command"]
    if not isinstance(command,str) or not 0 < len(command.encode()) <= 16384 or "\x00" in command:
        raise ValueError("invalid project command")
    proc = subprocess.Popen(["/bin/sh","-c",command],stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
    out = bytearray()
    deadline = time.monotonic()+45
    interrupted = False
    try:
        with selectors.DefaultSelector() as streams:
            streams.register(proc.stdout, selectors.EVENT_READ)
            while len(out) <= 65536 and time.monotonic() < deadline:
                if not streams.select(max(0,deadline-time.monotonic())): break
                data = os.read(proc.stdout.fileno(),8192)
                if not data: break
                out.extend(data)
        if len(out)>65536 or time.monotonic()>=deadline: interrupted=True
        else:
            try: proc.wait(timeout=max(0,deadline-time.monotonic()))
            except subprocess.TimeoutExpired: interrupted=True
    finally:
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
        proc.stdout.close()
    print(json.dumps(dict(id=req["id"],output=out[:65536].decode("utf8","replace")
        + ("\n[command time or output limit reached]" if interrupted else ""),
        exitCode=125 if interrupted else proc.returncode)),flush=True)
"""

def launch_parameters(start, origin):
    require(start.get("type") == "start", "first frame must be start")
    if start.get("executor") == "claude-project-command-v1":
        require(start.get("carrier") == "claude" and start.get("args") == [] and
                start.get("env") == {} and not start.get("history"), "invalid project command worker")
        return Path("/usr/bin/python3").resolve(strict=True), ["-I","-u","-c",PROJECT_COMMAND_WORKER], {}
    require("executor" not in start, "unknown project executor")
    executable = trusted_binary(start.get("carrier"))
    args = start.get("args")
    require(isinstance(args, list) and len(args) <= 200 and
            all(isinstance(item, str) and "\x00" not in item and len(item) <= 65536 for item in args), "invalid CLI arguments")
    args = [item.replace(GATEWAY, origin) for item in args]
    env = start.get("env", {})
    require(isinstance(env, dict) and len(env) <= 20, "invalid environment")
    accepted = {}
    for key, value in env.items():
        require(isinstance(value, str) and 0 < len(value) <= 512 and not re.search(r"[\x00-\x1f]", value), "invalid environment value")
        if key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "COLLAB_SELECTED_RUNTIME_API_KEY"):
            require(value == "project-gateway", "only a synthetic guest credential is accepted")
        elif key == "ANTHROPIC_BASE_URL":
            require(value == GATEWAY + "/model", "unexpected guest API origin")
        elif key in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"):
            require(re.fullmatch(r"[a-zA-Z0-9_./:+-]+", value), "invalid model")
        else:
            raise ValueError("unsupported guest environment variable")
        accepted[key] = value.replace(GATEWAY, origin)
    return executable, args, accepted


def socket_owner_pid(pid, pidfd, executable, client_port, server_port):
    # This namespace contains one invocation and only loopback. Check the CLIENT
    # end of this live TCP four-tuple, not the proxy's accepted server endpoint.
    if select.select([pidfd], [], [], 0)[0]:
        return False
    try:
        proc = Path("/proc", str(pid))
        if not os.path.samefile(proc / "exe", executable):
            return False
        status = (proc / "status").read_text()
        if not re.search(r"^NoNewPrivs:\s+1$", status, re.M) or not re.search(r"^CapEff:\s+0+$", status, re.M):
            return False
        local, remote = (f"0100007F:{port:04X}" for port in (client_port, server_port))
        for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
            row = line.split()
            if row[1:4] != [local, remote, "01"]:
                continue
            inode = row[9]
            for fd in (proc / "fd").iterdir():
                try:
                    if os.readlink(fd) != f"socket:[{inode}]":
                        continue
                    flags = re.search(r"^flags:\s+([0-7]+)$", (proc / "fdinfo" / fd.name).read_text(), re.M)
                    return bool(flags and int(flags.group(1), 8) & os.O_CLOEXEC)
                except FileNotFoundError:
                    continue
    except (OSError, ValueError, IndexError):
        pass
    return False


class Gateway:
    def __init__(self):
        self.pending = {}
        self.peer = None
        self.port = None

    async def serve(self, reader, writer):
        code, headers, data = 403, {}, b""
        try:
            peer_port = writer.get_extra_info("peername")[1]
            require(self.peer and self.peer(peer_port), "not CLI")
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = raw[:-4].decode("ascii").split("\r\n")
            method, path, protocol = lines[0].split(" ")
            require(method == "POST" and protocol in ("HTTP/1.0", "HTTP/1.1") and
                    path in ("/model/v1/responses", "/model/v1/messages", "/model/v1/messages?beta=true",
                             "/model/v1/messages/count_tokens", "/model/v1/messages/count_tokens?beta=true", "/mcp"),
                    "unsupported guest API request")
            incoming = {}
            for line in lines[1:]:
                key, value = line.split(":", 1)
                require(key.lower() not in incoming and re.fullmatch(r"[a-z0-9-]+", key.lower()), "invalid headers")
                incoming[key.lower()] = value.strip()
            require("transfer-encoding" not in incoming and incoming.get("content-length", "").isdigit(), "content length required")
            length = int(incoming["content-length"])
            require(0 < length <= (65536 if path == "/mcp" else MAX_BODY), "request too large")
            require(len(self.pending) < 8, "too many pending requests")
            payload = await asyncio.wait_for(reader.readexactly(length), 20)
            require(self.peer(peer_port), "caller exited")
            request_id = uuid.uuid4().hex
            result = self.pending[request_id] = asyncio.get_running_loop().create_future()
            try:
                emit({"type": "request", "id": request_id, "method": "POST", "path": path,
                      "headers": {k: v for k, v in incoming.items() if k in ("anthropic-version", "anthropic-beta", "accept", "content-type")},
                      "bodyBase64": base64.b64encode(payload).decode()})
                response = await asyncio.wait_for(result, 180)
            finally:
                self.pending.pop(request_id, None)
            code = response["status"]
            require(type(code) is int and 100 <= code <= 599, "invalid response status")
            data = base64.b64decode(response["bodyBase64"], validate=True)
            require(len(data) <= MAX_RESPONSE, "response too large")
            headers = {k.lower(): v for k, v in response.get("headers", {}).items()
                       if k.lower() in ("content-type", "mcp-session-id") and isinstance(v, str) and re.fullmatch(r"[ -~]{1,512}", v)}
        except (OSError, ValueError, KeyError, TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            code, headers, data = 403, {}, b""
        finally:
            try:
                header = f"HTTP/1.1 {code} Response\r\nConnection: close\r\nContent-Length: {len(data)}\r\n"
                header += "".join(f"{key}: {value}\r\n" for key, value in headers.items())
                writer.write((header + "\r\n").encode() + data)
                await asyncio.wait_for(writer.drain(), 10)
            except (OSError, TimeoutError):
                pass
            writer.close()


def prepare_mounts():
    # New mount namespace: make propagation private before adding a mount.
    libc_call("mount", None, b"/", None, 1 << 18 | 16384, None)  # MS_PRIVATE | MS_REC
    libc_call("mount", b"proc", b"/proc", b"proc", 0, None)
    subprocess.run(["/usr/bin/ip" if Path("/usr/bin/ip").exists() else "/usr/sbin/ip", "link", "set", "lo", "up"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    require(set(os.listdir("/sys/class/net")) >= {"lo"}, "guest has no loopback")
    # /sys can describe the parent netns; the route table here belongs to this namespace.
    require(len(Path("/proc/net/route").read_text().strip().splitlines()) == 1, "unexpected route in project namespace")


def caller_thread(tid, proc=Path("/proc"), pid_file=Path("/run/project-cli.pid")):
    expected = int(pid_file.read_text())
    thread = proc / str(tid)
    tgid = re.search(r"^Tgid:\s+([0-9]+)$", (thread / "status").read_text(), re.M)
    require(tgid and int(tgid.group(1)) == expected, "different process")
    return thread


def allowed_fd_path(fd):
    target = os.readlink(fd)
    require(any(target == root or target.startswith(root + "/") for root in (PROJECT, "/tmp")),
            "not a project or scratch path")
    require(not target.endswith(" (deleted)"), "unlinked path")
    mode = fd.stat().st_mode
    require(stat.S_ISREG(mode) or stat.S_ISDIR(mode), "not a regular file or directory")
    return os.fsencode(target)


def rss_stat(thread):
    # Only the RSS page count (field 24) is meaningful to Bun's memoryUsage().
    fields = (thread / "stat").read_text().rsplit(")", 1)[1].split()
    rss = int(fields[21])
    require(rss >= 0, "invalid RSS")
    return f"1 (cli) R{' 0' * 20} {rss} 0\n".encode()


def serve_fd_names():
    """Bun realpath(3) reads /proc/self/fd/N. Return ordinary paths, never magic links to descriptors."""
    import pyfuse3
    import trio

    class PathNames(pyfuse3.Operations):
        def attrs(self, inode, mode):
            attr = pyfuse3.EntryAttributes()
            attr.st_ino = inode
            attr.st_mode = mode
            attr.st_nlink = 1
            attr.attr_timeout = attr.entry_timeout = 0
            return attr

        def caller(self, ctx):
            try:
                # FUSE supplies the kernel caller's TID, which may be a Bun worker thread.
                return caller_thread(ctx.pid)
            except (ValueError, OSError, AttributeError):
                raise pyfuse3.FUSEError(errno.ENOENT)

        def path_for(self, inode, ctx):
            try:
                return allowed_fd_path(self.caller(ctx) / "fd" / str(inode - 3))
            except (ValueError, OSError):
                raise pyfuse3.FUSEError(errno.ENOENT)

        async def lookup(self, parent_inode, name, ctx=None):
            if parent_inode != pyfuse3.ROOT_INODE:
                raise pyfuse3.FUSEError(errno.ENOENT)
            if name == b"rss":
                return await self.getattr(2, ctx)
            if not re.fullmatch(rb"[0-9]{1,8}", name):
                raise pyfuse3.FUSEError(errno.ENOENT)
            return await self.getattr(3 + int(name), ctx)

        async def getattr(self, inode, ctx=None):
            if inode == pyfuse3.ROOT_INODE:
                return self.attrs(inode, stat.S_IFDIR | 0o555)
            if inode == 2:
                self.caller(ctx)
                attr = self.attrs(inode, stat.S_IFREG | 0o444)
                attr.st_size = 128
                return attr
            path = self.path_for(inode, ctx)
            attr = self.attrs(inode, stat.S_IFLNK | 0o777)
            attr.st_size = len(path)
            return attr

        async def readlink(self, inode, ctx):
            return self.path_for(inode, ctx)

        async def open(self, inode, flags, ctx):
            if inode != 2 or flags & os.O_ACCMODE != os.O_RDONLY:
                raise pyfuse3.FUSEError(errno.EACCES)
            self.caller(ctx)
            info = pyfuse3.FileInfo(fh=ctx.pid)
            info.direct_io = True
            return info

        async def read(self, fh, off, size):
            try:
                return rss_stat(caller_thread(fh))[off:off + size]
            except (OSError, ValueError, IndexError):
                raise pyfuse3.FUSEError(errno.ENOENT)

    require(sys.platform == "linux" and os.geteuid() == 0 and os.getppid() == 1, "expected namespace initializer")
    pyfuse3.init(PathNames(), "/run/project-fd-paths", {"fsname=project-fd-paths", "allow_other", "ro", "nosuid", "nodev", "noexec"})
    try:
        trio.run(pyfuse3.main)
    finally:
        pyfuse3.close()


HISTORY_SIZE = 12 * 1024 * 1024
HISTORY_STAGE = Path("/run/multi-agent-project-stage")
HISTORY_STORE = Path("/var/lib/multi-agent-project-history")
UUID_PATTERN = r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"


def private_dir(path):
    path.mkdir(mode=0o700, exist_ok=True)
    meta = path.lstat()
    require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == os.geteuid() and not meta.st_mode & 0o077, "untrusted history directory")
    return path


def history_dirs(scope, run):
    require(re.fullmatch("[0-9a-f]{64}", scope) and re.fullmatch(UUID_PATTERN, run), "invalid history identity")
    work = private_dir(private_dir(HISTORY_STAGE) / scope) / run
    archive = private_dir(private_dir(HISTORY_STORE) / scope)
    return work, archive


def history_relative(carrier, name, session):
    if carrier == "claude":
        return name == f"-mnt-project/{session}.jsonl"
    return bool(re.fullmatch(r"[0-9]{4}/[0-9]{2}/[0-9]{2}/rollout-[0-9T:-]{19}-" + re.escape(session) + r"\.jsonl", name))


def history_rows(carrier, path, session, anchor):
    require(path.is_file() and 0 < path.stat().st_size <= HISTORY_SIZE, "history file unavailable")
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    require(rows and all(isinstance(row, dict) for row in rows), "invalid native transcript")
    if carrier == "codex":
        meta = [row.get("payload") for row in rows if row.get("type") == "session_meta"]
        require(len(meta) == 1 and meta[0].get("id") == session and meta[0].get("cwd") == PROJECT,
                "wrong Codex rollout identity")
        turns = [row["payload"] for row in rows if row.get("type") == "event_msg" and
                 row.get("payload", {}).get("type") in ("task_complete", "task_started", "turn_aborted")]
        require(turns and turns[-1].get("type") == "task_complete" and turns[-1].get("turn_id") == anchor,
                "wrong Codex turn anchor")
        return []

    out = []
    seen = set()
    for row in rows:
        if "uuid" not in row or row.get("isSidechain"):
            continue
        require(row.get("sessionId") == session and row.get("cwd", PROJECT) == PROJECT and
                isinstance(row["uuid"], str) and isinstance(row.get("type"), str) and row["uuid"] not in seen,
                "invalid Claude message identity")
        seen.add(row["uuid"])
        # The host verifies the exact user prompt and UUID chain without retrieving assistant or tool content.
        item = {k: row[k] for k in ("type", "uuid", "parentUuid", "sessionId", "cwd") if k in row}
        if row["type"] == "user":
            content = row.get("message", {}).get("content")
            if isinstance(content, str) or isinstance(content, list) and all(
                    isinstance(x, dict) and x.get("type") == "text" for x in content):
                item["message"] = {"content": content}
        out.append(item)
    last = next((r for r in reversed(out) if r["type"] in ("assistant", "user")), None)
    require(last and last["type"]=="assistant" and last["uuid"]==anchor, "wrong Claude turn anchor")
    return out


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def history_command(action, scope, run, carrier, previous, session, anchor):
    require(carrier in ("claude", "codex"), "unsupported history carrier")
    work, archive = history_dirs(scope, run)
    if action == "discard":
        if work.exists():
            shutil.rmtree(work)
        return {}
    if action == "begin":
        work.mkdir(mode=0o700)
        if previous == "-":
            return {"restored": False}
        require(re.fullmatch(UUID_PATTERN, previous), "invalid previous invocation")
    require(re.fullmatch(UUID_PATTERN, session) and re.fullmatch(UUID_PATTERN, anchor), "invalid native history anchor")
    if action == "begin":
        checkpoint = archive / previous
        try:
            info = json.loads((checkpoint / "meta").read_text())
            name = info["name"]
            require(info["session"] == session and info["anchor"] == anchor and history_relative(carrier, name, session), "checkpoint differs")
            payload = checkpoint / "history"
            require(payload.stat().st_size <= HISTORY_SIZE and hashlib.sha256(payload.read_bytes()).hexdigest() == info["sha256"], "checkpoint checksum differs")
            rows = history_rows(carrier, payload, session, anchor)
            dest = work / name
            dest.parent.mkdir(mode=0o700, parents=True)
            shutil.copyfile(payload, dest)
            return {"restored": True, "name": name, "rows": rows}
        except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
            shutil.rmtree(work)
            work.mkdir(mode=0o700)
            return {"restored": False}
    require(action == "finish", "unknown history operation")
    candidates = [p for p in work.rglob("*.jsonl") if history_relative(carrier, p.relative_to(work).as_posix(), session)]
    if len(candidates) != 1:
        return {"saved": False}
    path = candidates[0]
    try:
        rows = history_rows(carrier, path, session, anchor)
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        return {"saved": False}
    # The guest namespace is already reaped before the host requests this promotion.
    data = path.read_bytes()
    info = {"name": path.relative_to(work).as_posix(), "session": session, "anchor": anchor,
            "sha256": hashlib.sha256(data).hexdigest()}
    published = archive / run
    if published.exists():
        # A retry may acknowledge the very same snapshot but cannot replace it with different bytes.
        if info == json.loads((published / "meta").read_text()) and (published / "history").read_bytes() == data:
            return {"saved": True, "rows": rows}
        return {"saved": False}
    out = Path(tempfile.mkdtemp(dir=archive))
    try:
        with (out / "history").open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        with (out / "meta").open("x") as stream:
            json.dump(info, stream)
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(out)
        out.rename(published)
        sync_directory(archive)
    finally:
        if out.exists():
            shutil.rmtree(out)
    return {"saved": True, "rows": rows}


def serve_history_fs(root_fd):
    """A private CLI session directory. Kernel-authenticate the caller on every open AND on fd IO."""
    from fusepy import FUSE, FuseOSError, Operations, fuse_get_context

    root = Path("/proc/self/fd", str(root_fd))
    class History(Operations):
        def authorized(self):
            try:
                caller_thread(fuse_get_context()[2])
            except (OSError, ValueError, AttributeError):
                raise FuseOSError(errno.EACCES)

        def local(self, path):
            # Only this service can change the private backing tree. All children are plain files or directories.
            if path == "/": return root
            parts = path.lstrip("/").split("/")
            if len(parts) > 8 or any(not re.fullmatch(r"[A-Za-z0-9_.:-]{1,180}", p) or p in (".","..") for p in parts):
                raise FuseOSError(errno.EACCES)
            return root.joinpath(*parts)

        def capacity(self, additional=0):
            files = list(root.rglob("*"))
            if len(files) >= 256 or sum(p.stat().st_size for p in files if p.is_file()) + additional > HISTORY_SIZE:
                raise FuseOSError(errno.ENOSPC)

        def getattr(self, path, fh=None):
            if path != "/": self.authorized()
            st = self.local(path).stat()
            return {"st_uid":os.getuid(), "st_gid":os.getgid(), "st_mode": (stat.S_IFDIR|0o777) if stat.S_ISDIR(st.st_mode) else stat.S_IFREG|0o666,
                    "st_nlink":st.st_nlink,"st_size":st.st_size,"st_mtime":st.st_mtime,"st_atime":st.st_atime,"st_ctime":st.st_ctime}
        def access(self, path, mode):
            if path != "/": self.authorized()
            self.local(path).stat()
            return 0
        def readdir(self, path, fh):
            self.authorized()
            return [".","..",*os.listdir(self.local(path))]
        def mkdir(self, path, mode):
            self.authorized()
            self.capacity()
            self.local(path).mkdir(mode=0o700)
        def create(self, path, mode, fi=None):
            self.authorized()
            self.capacity()
            return os.open(self.local(path),os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_RDWR,0o600)
        def open(self, path, flags):
            self.authorized()
            if flags & os.O_TRUNC:
                raise FuseOSError(errno.EPERM)
            return os.open(self.local(path), flags | os.O_NOFOLLOW)
        def read(self, path, size, offset, fh):
            self.authorized()
            return os.pread(fh,size,offset)
        def write(self, path, data, offset, fh):
            self.authorized()
            if offset != os.fstat(fh).st_size:
                raise FuseOSError(errno.EPERM)
            self.capacity(len(data))
            return os.pwrite(fh, data, offset)
        def truncate(self, path, length, fh=None):
            self.authorized()
            if length != self.local(path).stat().st_size:
                raise FuseOSError(errno.EPERM)
        # The view is append-only. Past records, including a restored checkpoint, are immutable.
        def rename(self, old, new):
            raise FuseOSError(errno.EPERM)
        def unlink(self, path):
            raise FuseOSError(errno.EPERM)
        def rmdir(self, path):
            raise FuseOSError(errno.EPERM)
        def fsync(self, path, datasync, fh):
            self.authorized()
            os.fsync(fh)
            return 0
        def release(self, path, fh):
            os.close(fh)
            return 0

    FUSE(History(), "/run/project-history-view", foreground=True, allow_other=True, nothreads=True,
         direct_io=True, nodev=True, nosuid=True, noexec=True, attr_timeout=0, entry_timeout=0, negative_timeout=0)


def syscall_policy():
    # Linux sockets such as AF_VSOCK can bypass an IP-only network namespace.
    # Apply the filter to the CLI before exec, inherited by every project child.
    library = ctypes.CDLL("libseccomp.so.2")
    allow, denied = 0x7fff0000, 0x00050000 | errno.EPERM
    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint),
                    ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]
    library.seccomp_init.restype = ctypes.c_void_p
    policy = ctypes.c_void_p(library.seccomp_init(allow))
    require(policy.value, "cannot initialize syscall filter")
    fd = os.memfd_create("guest-syscalls", os.MFD_CLOEXEC)
    try:
        def rule(name, comparison=None):
            number = library.seccomp_syscall_resolve_name(name.encode())
            if number == -1:  # Not a syscall on this architecture.
                return
            result = library.seccomp_rule_add_array(policy, denied, number, bool(comparison),
                                                    ctypes.byref(comparison) if comparison else None)
            require(result == 0, "cannot build syscall filter")
        for name in ("socket", "socketpair"):
            # AF_UNIX=1, AF_INET=2 and AF_INET6=10 are sufficient.
            for family in (0, 3, 4, 5, 6, 7, 8, 9):
                rule(name, Comparison(0, 4, family, 0))  # SCMP_CMP_EQ
            rule(name, Comparison(0, 6, 10, 0))  # SCMP_CMP_GT
        for name in ("io_uring_setup", "ptrace", "pidfd_getfd", "process_vm_readv", "process_vm_writev",
                     "perf_event_open", "bpf", "open_by_handle_at"):
            rule(name)
        require(library.seccomp_export_bpf(policy, fd) == 0, "cannot export syscall filter")
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    finally:
        library.seccomp_release(policy)


def sandbox(carrier, executable, args, env, info_fd, gate_fd, filter_fd, project_fd, history=False):
    dest = BIN_DIR + "/" + carrier
    cmd = ["/usr/bin/bwrap", "--unshare-user", "--disable-userns", "--unshare-pid", "--as-pid-1",
           "--new-session", "--die-with-parent", "--cap-drop", "ALL", "--info-fd", str(info_fd),
           "--block-fd", str(gate_fd), "--seccomp", str(filter_fd), "--clearenv", "--ro-bind", "/usr", "/usr"]
    for name in ("/bin", "/sbin", "/lib", "/lib64"):
        if os.path.islink(name):
            cmd += ["--symlink", os.readlink(name), name]
        elif os.path.isdir(name):
            cmd += ["--ro-bind", name, name]
    # Expose specific CPU/VM counters used by Bun/libuv. These files contain no fd or process data.
    for file in ("/proc/stat", "/proc/sys/vm/overcommit_memory", "/proc/sys/vm/mmap_min_addr",
                 "/sys/devices/system/cpu/online", "/sys/kernel/mm/transparent_hugepage/enabled"):
        if Path(file).is_file():
            cmd += ["--ro-bind", file, file]
    if carrier == "claude":
        cmd += ["--ro-bind", "/run/project-fd-paths", "/proc/self/fd", "--symlink", "/proc/self/fd/rss", "/proc/self/stat"]
    # No general procfs, sysfs, SSH agents, VSOCK device, VM services, host HOME or caller configuration.
    cmd += ["--dev", "/dev", "--dir", "/proc/self", "--symlink", dest, "/proc/self/exe",
            "--ro-bind", "/proc/self/maps", "/proc/self/maps",
            "--dir", "/etc", "--tmpfs", "/tmp",
            "--dir", "/tmp/home", "--dir", "/tmp/home/.codex", "--dir", "/tmp/home/.claude", "--ro-bind", str(executable), dest,
            "--bind-fd", str(project_fd), PROJECT, "--chdir", PROJECT, "--remount-ro", "/"]
    if history:
        dest_history = "/tmp/home/.codex/sessions" if carrier == "codex" else "/tmp/home/.claude/projects"
        cmd += ["--bind", "/run/project-history-view", dest_history]
    for key, value in {"HOME": "/tmp/home", "PATH": "/usr/bin:/bin", "TMPDIR": "/tmp",
                       "LANG": "C.UTF-8", "CODEX_HOME": "/tmp/home/.codex", **env}.items():
        cmd += ["--setenv", key, value]
    return cmd + ["--", dest, *args]


async def await_sandbox(pid, pidfd, project_fd, carrier, executable, history=False):
    # --info-fd identifies the future CLI before bwrap actually finishes its mounts.
    # Inspect the live inner root while --block-fd still prevents exec and any CLI input.
    root = Path("/proc", str(pid), "root")
    history_root = root / ("tmp/home/.codex/sessions" if carrier == "codex" else "tmp/home/.claude/projects")
    async with asyncio.timeout(10):
        while True:
            require(not select.select([pidfd], [], [], 0)[0], "sandbox exited before its mounts were ready")
            try:
                if (not os.path.samefile(root, "/") and
                        os.path.samestat((root / PROJECT[1:]).stat(), os.fstat(project_fd)) and
                        os.path.samefile(root / BIN_DIR[1:] / carrier, executable) and
                        (not history or os.path.samefile(history_root, "/run/project-history-view")) and
                        (root / "tmp/home/.codex").is_dir() and not (root / "proc/1/fd").exists() and
                        not (root / "run/project-cli.pid").exists()):
                    return
            except FileNotFoundError:
                pass  # Mount tree is still being assembled.
            await asyncio.sleep(0.01)


async def supervise(opts, fd):
    prepare_mounts()
    # A Linux PID namespace init is reaped by the outer parent only after all its tasks exit.
    require(os.getpid() == 1, "guest supervisor did not become namespace init")
    stdin = asyncio.StreamReader(limit=HOST_FRAME_LIMIT)
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(stdin), sys.stdin.buffer)
    async def frame():
        line = await stdin.readline()
        if not line:
            return {"type": "stop"}
        value = json.loads(line)
        require(isinstance(value, dict), "invalid protocol frame")
        return value
    start = await asyncio.wait_for(frame(), 30)
    gateway = Gateway()
    server = await asyncio.start_server(gateway.serve, "127.0.0.1", 0, limit=32768)
    gateway.port = server.sockets[0].getsockname()[1]
    origin = f"http://127.0.0.1:{gateway.port}"
    executable, args, env = launch_parameters(start, origin)
    fd_service = None
    history = start.get("history")
    history_fd = None
    if history:
        work, _ = history_dirs(history["scope"],history["run"])
        history_fd = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    sandbox_name = "project-command" if start.get("executor") else start["carrier"]
    if sandbox_name == "claude" or history:
        libc_call("mount", b"tmpfs", b"/run", b"tmpfs", 0, b"mode=0755,size=8m")
    if history_fd is not None:
        os.mkdir("/run/project-history-view",0o700)
        service = await asyncio.create_subprocess_exec("/usr/bin/python3","-I",str(Path(__file__).resolve()),"--history-service",str(history_fd),
            pass_fds=(history_fd,), stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd="/",env={"PATH":"/usr/bin:/bin"})
        os.close(history_fd)
        async with asyncio.timeout(6):
            while not os.path.ismount("/run/project-history-view"):
                require(service.returncode is None, "isolated history view unavailable")
                await asyncio.sleep(0.02)
    if sandbox_name == "claude":
        os.mkdir("/run/project-fd-paths", 0o755)
        fd_service = await asyncio.create_subprocess_exec("/usr/bin/python3", "-I", str(Path(__file__).resolve()), "--fd-path-service",
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/", env={"PATH": "/usr/bin:/bin"})
        async with asyncio.timeout(5):
            while not os.path.ismount("/run/project-fd-paths"):
                require(fd_service.returncode is None, "isolated CLI path service unavailable")
                await asyncio.sleep(0.02)
    uid, gid = int(os.environ.get("SUDO_UID", 0)), int(os.environ.get("SUDO_GID", 0))
    require(uid > 0 and gid > 0, "an unprivileged guest account must invoke sudo")
    info_r, info_w = os.pipe()
    gate_r, gate_w = os.pipe()
    filter_fd = syscall_policy()
    cmd = sandbox(sandbox_name, executable, args, env, info_w, gate_r, filter_fd, fd, bool(history))
    # Bubblewrap is started without root privileges. It maps the guest user's UID for project IO.
    # Require Yama's descendant restriction: the project's children may not ptrace/access parent memory.
    require(int(Path("/proc/sys/kernel/yama/ptrace_scope").read_text()) >= 1, "ptrace restriction unavailable")
    libc_call("prctl", 38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
    child = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=subprocess.DEVNULL, cwd="/", env={"PATH": "/usr/bin:/bin"}, user=uid, group=gid,
        extra_groups=[], pass_fds=(info_w, gate_r, filter_fd, fd))
    os.close(filter_fd)
    os.close(info_w)
    os.close(gate_r)
    try:
        # bwrap writes the info before waiting on --block-fd. It closes this fd after the report.
        def report():
            with os.fdopen(info_r, "rb") as stream:
                return json.loads(stream.read(8192))
        info = await asyncio.wait_for(asyncio.to_thread(report), 10)
        pid = info["child-pid"]
        require(type(pid) is int and pid > 1, "missing sandbox PID")
        if fd_service is not None or history:
            Path("/run/project-cli.pid").write_text(str(pid))
        pidfd = os.pidfd_open(pid)
        await await_sandbox(pid, pidfd, fd, sandbox_name, executable, bool(history))
        gateway.peer = lambda port: socket_owner_pid(pid, pidfd, executable, port, gateway.port)
        emit({"type": "ready", "gatewayOrigin": origin, "device": opts.device, "inode": opts.inode})
        async def controls():
            nonlocal gate_w
            while True:
                message = await frame()
                kind = message.get("type")
                if kind == "stop":
                    return 125
                if kind in ("input", "eof"):
                    if gate_w >= 0:
                        os.write(gate_w, b"x")
                        os.close(gate_w)
                        gate_w = -1
                    if kind == "input":
                        payload = message["data"].encode()
                        require(len(payload) <= 1024 * 1024, "CLI input too large")
                        child.stdin.write(payload)
                        await child.stdin.drain()
                    else:
                        child.stdin.close()
                elif kind == "response":
                    pending = gateway.pending.get(message.get("id"))
                    if pending and not pending.done():
                        pending.set_result(message)
                else:
                    raise ValueError("unknown guest control type")
        async def output():
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            while raw := await child.stdout.read(32768):
                emit({"type": "output", "data": decoder.decode(raw)})
            last = decoder.decode(b"", final=True)
            if last:
                emit({"type": "output", "data": last})
            return await child.wait()
        control_task, output_task = asyncio.create_task(controls()), asyncio.create_task(output())
        done, pending = await asyncio.wait([control_task, output_task], return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        return output_task.result() if output_task in done else control_task.result()
    finally:
        # bwrap treats EOF on --block-fd as permission to proceed. If no host input
        # opened the gate, keep the fd intact until the kernel destroys this PID namespace.
        server.close()
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--device", type=int, required=True)
    parser.add_argument("--inode", type=int, required=True)
    parser.add_argument("--marker", required=True)
    parser.add_argument("--nonce", required=True)
    opts = parser.parse_args()
    require(sys.platform == "linux" and os.geteuid() == 0, "requires a privileged Linux guest initializer")
    # Mark NEWPID before fork so this exact child is PID 1, observable with waitpid.
    libc_call("unshare", 0x20000000 | 0x40000000 | 0x00020000 | 0x08000000 | 0x04000000)
    fd = directory_fd(opts)
    parent_fd = os.pidfd_open(os.getpid())
    pid = os.fork()
    if not pid:
        try:
            libc_call("prctl", 1, signal.SIGKILL, 0, 0, 0)
            require(not select.select([parent_fd], [], [], 0)[0], "initializer exited before supervision started")
            os.close(parent_fd)
            code = asyncio.run(supervise(opts, fd))
        except Exception as error:
            site = traceback.extract_tb(error.__traceback__)[-1]
            emit({"type": "error", "reason": str(error)[:256], "site": f"{site.name}:{site.lineno}"})
            code = 125
        os._exit(code if 0 <= code <= 255 else 125)
    os.close(parent_fd)
    os.close(fd)
    def stop(*_):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, stop)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    code = code if code >= 0 else 128 - code
    emit({"type": "exit", "code": code, "treeExited": True})
    return code


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--history-service":
            serve_history_fs(int(sys.argv[2]))
        elif len(sys.argv) == 9 and sys.argv[1] == "--history":
            require(os.geteuid() == 0, "requires guest administrator")
            print(json.dumps(history_command(*sys.argv[2:]), ensure_ascii=False, separators=(",", ":")))
        elif sys.argv[1:] == ["--fd-path-service"]:
            serve_fd_names()
        else:
            sys.exit(main())
    except (ValueError, OSError) as error:
        emit({"type": "error", "reason": str(error)[:256]})
        sys.exit(125)
