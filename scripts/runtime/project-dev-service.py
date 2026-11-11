"""Loopback-only HTTP bridge inside the project's private Linux PID and network namespaces."""
import base64
import http.client
import json
import os
import queue
import re
import select
import socket
import subprocess
import sys
import threading
import time


def main():
    port = 4173  # Each instance owns a separate network namespace.
    os.environ.update(PORT=str(port), HOST="127.0.0.1", BROWSER="none", CI="1", NO_COLOR="1")
    args = ["npm", "--ignore-scripts", "run", "dev"]
    with open("/work/package.json") as source:
        script = json.load(source)["scripts"]["dev"].strip()
    if re.match(r"^vite(?:\s|$)", script):
        args += ["--", "--host", "127.0.0.1", "--port", str(port), "--strictPort"]
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output_lock = threading.Lock()

    def send(**fields):
        with output_lock:
            print(json.dumps(fields, ensure_ascii=True), flush=True)

    def logs():
        budget = 16384
        for line in iter(lambda: child.stdout.readline(1024), b""):
            if budget > 0:
                budget -= len(line)
                send(state="log", message=line.decode(errors="replace").rstrip()[:400])
    threading.Thread(target=logs, daemon=True).start()
    incoming = queue.Queue(8)

    def read_requests():
        while True:
            line = sys.stdin.buffer.readline(180000)
            incoming.put(line)
            if not line:
                return
    threading.Thread(target=read_requests, daemon=True).start()
    ready = False
    started = time.monotonic()
    while child.poll() is None:
        if not ready:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=.2):
                    pass
                ready = True
                send(state="listening", port=port)
            except OSError:
                if time.monotonic() - started > 50:
                    send(state="error", message="开发服务未在分配端口就绪，请检查 dev 脚本是否使用 PORT。")
                    return
        try:
            line = incoming.get(timeout=.2)
        except queue.Empty:
            continue
        if not line:
            return
        msg = json.loads(line)
        path = msg["path"]
        if not path.startswith("/") or path.startswith("//") or msg["method"] not in ("GET", "HEAD", "POST"):
            raise ValueError("预览请求无效")
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request(msg["method"], path, base64.b64decode(msg["body"], validate=True),
                         {"Content-Type":msg["contentType"], "Accept-Encoding":"identity"})
            res = conn.getresponse()
            data = res.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError("预览响应过大")
            send(state="response", id=msg["id"], status=res.status, mime=res.getheader("Content-Type","text/plain"),
                 body=base64.b64encode(data).decode())
        except (ValueError, OSError, http.client.HTTPException):
            send(state="response", id=msg["id"], status=502, mime="text/plain", body="")
        finally:
            conn.close()
    send(state="error", message="开发服务已经退出，退出码 "+str(child.returncode)+"。")


if __name__ == "__main__":
    main()
