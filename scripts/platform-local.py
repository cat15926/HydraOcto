#!/usr/bin/env python3
"""Manage only this checkout's local platform process."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / '.local-data'
STATE = STATE_DIR / 'process.json'
ENTRY = ROOT / 'dist/server/index.js'


def node_binary():
    candidates = [os.environ.get('PLATFORM_NODE'), str(Path.home() / '.local/node-v24/bin/node'), shutil.which('node')]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            version = subprocess.check_output([candidate, '--version'], text=True).strip()
            if version.startswith('v24.'):
                return candidate
    raise RuntimeError('需要 Node.js 24；请设置 PLATFORM_NODE 为其可执行文件路径。')


def read_state():
    try:
        return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError):
        return None


def owned(state):
    if not state or not isinstance(state.get('pid'), int):
        return False
    result = subprocess.run(['ps', '-p', str(state['pid']), '-o', 'command='], text=True, capture_output=True)
    return result.returncode == 0 and str(ENTRY) in result.stdout


def port():
    value = '4310'
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith('APP_PORT='):
                value = line.split('=', 1)[1].split('#', 1)[0].strip().strip('\"\'')
    return int(os.environ.get('APP_PORT', value))


def health(p):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{p}/health', timeout=1) as response:
            return json.load(response)
    except Exception:
        return None


def start():
    state = read_state()
    if owned(state):
        print(json.dumps({'pid': state['pid'], 'url': state['url'], 'health': health(state['port'])}, ensure_ascii=False))
        return
    if not ENTRY.exists():
        raise RuntimeError('尚未构建，请先运行 npm run build。')
    p = port()
    STATE_DIR.mkdir(exist_ok=True, mode=0o700)
    log_path = STATE_DIR / 'server.log'
    with log_path.open('ab') as log:
        proc = subprocess.Popen([node_binary(), '--env-file-if-exists=.env', str(ENTRY)], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    state = {'pid': proc.pid, 'port': p, 'url': f'http://127.0.0.1:{p}', 'log': str(log_path)}
    STATE.write_text(json.dumps(state, indent=2) + '\n')
    for _ in range(30):
        if proc.poll() is not None:
            STATE.unlink(missing_ok=True)
            raise RuntimeError(f'启动失败，查看日志：{log_path}')
        current = health(p)
        if current:
            print(json.dumps({**state, 'health': current}, ensure_ascii=False))
            return
        time.sleep(0.2)
    print(json.dumps({**state, 'health': '尚未就绪，请运行 status 检查'}, ensure_ascii=False))


def stop():
    state = read_state()
    if not owned(state):
        print('没有本脚本可确认归属的服务进程。')
        return
    os.kill(state['pid'], signal.SIGTERM)
    for _ in range(50):
        if not owned(state):
            STATE.unlink(missing_ok=True)
            print('本平台服务已停止。')
            return
        time.sleep(0.1)
    raise RuntimeError('进程尚未退出；请检查日志，脚本未强制终止。')


def status():
    state = read_state()
    if not owned(state):
        print('本平台未通过此脚本运行。')
        return
    print(json.dumps({**state, 'health': health(state['port'])}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'stop', 'status'])
    args = parser.parse_args()
    try:
        {'start': start, 'stop': stop, 'status': status}[args.command]()
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
