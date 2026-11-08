#!/bin/sh
# Run in the designated Linux guest: sh probe-native-project-linux.sh '/mounted/project'
# Outputs JSON on stdout. No package installation, project writes, key reads or model calls.
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"schema":1,"available":false,"probe":"missing_python3"}'
  exit 2
fi
exec python3 -I -B - "$@" <<'PY'
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys

def call(args, pass_fds=()):
    try:
        p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=8, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LC_ALL': 'C'},
                           pass_fds=pass_fds)
        return p.returncode, p.stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.TimeoutExpired):
        return -1, ''

def identity(s):
    return str(s.st_dev) + ':' + str(s.st_ino)

def inspect():
    report = {'schema': 1, 'available': False, 'realModelCalls': 0, 'system': platform.system()}
    if sys.platform != 'linux':
        report['probe'] = 'requires_linux_guest'
        return report
    if len(sys.argv) > 2 or len(sys.argv) == 2 and not os.path.isabs(sys.argv[1]):
        report['probe'] = 'supply_one_absolute_project_path'
        return report
    report.update(kernel=platform.release(), architecture=platform.machine(), uid=os.geteuid())
    netns = '/proc/self/ns/net'
    report['proc'] = {
        'namespaceLinks': all(os.path.islink('/proc/self/ns/' + name) for name in ('mnt', 'pid', 'net')),
        'fdDirectory': os.path.isdir('/proc/self/fd'),
        'cgroupV2': os.path.isfile('/sys/fs/cgroup/cgroup.controllers'),
    }
    bins = {name: shutil.which(name) for name in ('bwrap', 'podman', 'docker', 'codex', 'claude', 'node', 'findmnt')}
    report['installedExecutables'] = {name: bool(path) for name, path in bins.items()}
    report['containerRuntimeContacted'] = False
    report['project'] = {'state': 'not_supplied'}
    fd = None
    if len(sys.argv) == 2:
        try:
            fd = os.open(sys.argv[1], os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            report['project'] = {'state': 'opened_directory_fd', 'deviceInode': identity(os.fstat(fd))}
            if bins['findmnt']:
                code, fs = call([bins['findmnt'], '-n', '-o', 'FSTYPE', '-T', sys.argv[1]])
                if code == 0:
                    report['project']['mountType'] = fs.strip()[:100]
        except OSError as e:
            report['project'] = {'state': 'cannot_open_directory_fd', 'errno': e.errno}
    report['bwrap'] = {'state': 'not_installed'}
    report['cliVersions'] = {}
    report['accounts'] = {name: {'api': 'unverified', 'officialLogin': 'unverified'} for name in ('codex', 'claude')}
    report['unverified'] = ['guest_mount_matches_user_project', 'original_directory_write', 'all_descendants_stopped',
                            'credential_broker_peer_identity', 'official_login_store_isolation', 'native_tool_loop']
    if not bins['bwrap']:
        return report
    help_code, help_text = call([bins['bwrap'], '--help'])
    version_code, version = call([bins['bwrap'], '--version'])
    options = ['--bind-fd', '--ro-bind-fd', '--as-pid-1', '--unshare-user', '--unshare-pid', '--unshare-net',
               '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent', '--clearenv']
    missing = [x for x in options if x not in help_text.split()]
    info = {'state': 'unsupported_options' if missing else 'namespace_probe_pending', 'missingOptions': missing}
    report['bwrap'] = info
    if version_code == 0:
        info['version'] = version.strip()[:80]
    if help_code or missing or not report['proc']['namespaceLinks']:
        return report
    base = [bins['bwrap'], '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
            '--as-pid-1', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--clearenv',
            '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    # Only runtime directories are visible. The single user-provided project is always mounted read-only.
    for directory in ['/usr', '/bin', '/lib', '/lib64']:
        if os.path.isdir(directory):
            base.extend(['--ro-bind', directory, directory])
    mounts = ['--ro-bind-fd', str(fd), '/project'] if fd is not None else []
    payload = 'printf "%s\\n" "$$"; readlink /proc/self/ns/pid; readlink /proc/self/ns/net; readlink /proc/self/ns/mnt'
    if mounts:
        payload += '; stat -Lc "%d:%i" /project'
    code, out = call(base + mounts + ['--', '/bin/sh', '-c', payload], (fd,) if mounts else ())
    data = out.strip().splitlines()
    if code or len(data) != (5 if mounts else 4):
        info['state'] = 'namespace_or_fd_mount_failed'
        return report
    info['pidOne'] = data[0] == '1'
    info['separatePidNamespace'] = data[1] != os.readlink('/proc/self/ns/pid')
    info['separateNetworkNamespace'] = data[2] != os.readlink(netns)
    info['separateMountNamespace'] = data[3] != os.readlink('/proc/self/ns/mnt')
    if mounts:
        info['fdMountIdentityMatches'] = data[4] == identity(os.fstat(fd))
    if not all([info['pidOne'], info['separatePidNamespace'], info['separateNetworkNamespace'], info['separateMountNamespace'],
                info.get('fdMountIdentityMatches', True)]):
        info['state'] = 'namespace_or_mount_mismatch'
        return report
    info['state'] = 'read_only_probe_passed'
    # CLI --version runs with a private tmpfs home, empty authentication environment and offline namespace.
    # For user installs outside /usr, mount only the executable. A JS wrapper may need more dependencies.
    for name in ('codex', 'claude', 'node'):
        if not bins[name]:
            continue
        binary = os.path.realpath(bins[name])
        if not stat.S_ISREG(os.stat(binary).st_mode):
            continue
        args = [] if binary.startswith('/usr/') else ['--ro-bind', binary, '/probe-cli']
        code, value = call(base + args + ['--', '/probe-cli' if args else binary, '--version'])
        match = re.search(r'(?<!\w)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b', value)
        report['cliVersions'][name] = match.group(1) if code == 0 and match else 'unverified_in_minimal_root'
    return report

try:
    result = inspect()
    print(json.dumps(result, ensure_ascii=True, indent=2))
except OSError as error:
    print(json.dumps({'schema': 1, 'available': False, 'probe': 'observation_failed', 'errno': error.errno}))
    sys.exit(2)
PY
