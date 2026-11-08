"""Build a Git delivery in a private bare repository, leaving the project index and HEAD alone."""
import hashlib
import json
import os
from pathlib import Path
import re
import pwd
import stat
import subprocess
import sys


class Refused(ValueError):
    pass


def need(ok, message):
    if not ok:
        raise Refused(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def allowed_path(path):
    return (0 < len(path) <= 512 and not re.search(r'[\\:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', path)
            and all(x and not x.startswith('.') and x not in ('node_modules', '__pycache__') for x in path.split('/')))


def safe_read(fd, name, dev):
    entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or entry.st_dev != dev or entry.st_size > 131072:
        return None
    raw = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(raw, 'rb') as stream:
        identity = lambda s: (s.st_dev, s.st_ino, s.st_ctime_ns, s.st_size, s.st_mode, s.st_nlink)
        if identity(os.fstat(raw)) != identity(entry):
            return None
        data = stream.read(131073)
        if len(data) != entry.st_size or identity(os.fstat(raw)) != identity(entry):
            return None
        return data


def inventory(root, dev):
    items = {}
    size = 0
    for name, dirs, files, fd in os.fwalk('.', dir_fd=root):
        parent = name[2:] if name != '.' else ''
        path = lambda child: parent + '/' + child if parent else child
        dirs[:] = [d for d in dirs if allowed_path(path(d))]
        for child in dirs + files:
            rel = path(child)
            if not allowed_path(rel):
                continue
            need(len(items) < 20000 and size < 64 * 1024 * 1024, '此项目超出本轮 Git 文件核对范围。')
            blob = safe_read(fd, child, dev)
            items[rel] = '?' if blob is None else digest(blob)
            size += len(blob) if blob is not None else 0
    return items


def read_path(root, dev, path):
    parts = path.split('/')
    fd = os.dup(root)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        data = safe_read(fd, parts[-1], dev)
        need(data is not None and b'\0' not in data, '只能交付项目中的普通文本文件。')
        data.decode('utf-8')
        return data
    finally:
        os.close(fd)


def git(cwd, *args, data=None, optional=False, identity=None):
    env = {'PATH': '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C'}
    env['HOME'] = pwd.getpwuid(os.getuid()).pw_dir
    for key in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy'):
        if key in os.environ:
            env[key] = os.environ[key]
    if identity:
        env.update(GIT_AUTHOR_NAME='Multi Agent Collab', GIT_COMMITTER_NAME='Multi Agent Collab',
                   GIT_AUTHOR_EMAIL='collab@localhost', GIT_COMMITTER_EMAIL='collab@localhost',
                   GIT_AUTHOR_DATE=identity, GIT_COMMITTER_DATE=identity)
    binary = '/opt/homebrew/bin/git' if os.access('/opt/homebrew/bin/git', os.X_OK) else '/usr/bin/git'
    command = [binary, '-c', 'http.version=HTTP/1.1', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
               '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=' , '-c', 'credential.helper=osxkeychain',
               '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
               '-c', 'push.followTags=false', '-C', str(cwd), *args]
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=35)
    if optional and result.returncode:
        return b''
    if result.returncode:
        msg = result.stderr.lower()
        if any(marker in msg for marker in (b'authentication failed', b'could not read username', b'403', b'permission to')):
            raise Refused('本机 Git 账户未取得目标仓库的访问权限。')
        if b'stale info' in msg or b'non-fast-forward' in msg:
            raise Refused('远端分支已有新提交，请同步后重新预览。')
        raise Refused('Git 操作未完成，请核对分支、网络和本机对该仓库的访问权限。')
    return result.stdout


def target(root):
    db = root / '.git'
    need(db.is_dir() and db.resolve() == db and (db / 'config').resolve() == db / 'config', '请选择普通 Git 项目的根目录。')
    remote = git('/', 'config', '--no-includes', '--file', str(db / 'config'), '--get', 'remote.origin.url').decode().strip()
    match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?/?', remote)
    need(match and all(x not in ('.', '..') for x in match.groups()), '首批支持 origin 指向 GitHub 的项目。')
    url = 'https://github.com/' + '/'.join(match.groups()) + '.git'
    branch = git(root, 'symbolic-ref', '--short', 'HEAD').decode().strip()
    need(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9/._-]{0,130}', branch), '请先检出要交付的本地分支。')
    head = git(root, 'rev-parse', '--verify', 'HEAD').decode().strip()
    need(re.fullmatch(r'[0-9a-f]{40}', head), '本地分支缺少可核对的提交。')
    return url, branch, head


def remote_head(repo, url, branch, *, optional=False):
    ref = 'refs/heads/' + branch
    result = git(repo, 'ls-remote', '--refs', url, ref).decode().split()
    if not result and optional:
        return None
    need(len(result) == 2 and result[1] == ref and re.fullmatch(r'[0-9a-f]{40}', result[0]), '远端分支不存在或无法读取。')
    return result[0]


def selected(root, fd, dev, parent, spec, repo):
    path = spec['path']
    need(allowed_path(path), '文件路径超出项目范围。')
    after = read_path(fd, dev, path)
    need(digest(after) == spec['after'], '文件在成员完成后已改变，请重新核对。')
    index = git(root, 'ls-files', '--stage', '-z', '--', path).split(b'\0')[:-1]
    localtree = git(root, 'ls-tree', '-z', 'HEAD', '--', path).split(b'\0')[:-1]
    if localtree:
        meta, indexed_name = localtree[0].split(b'\t',1)
        localmode, localkind, localoid = meta.decode().split()
        need(len(localtree)==1 and localkind=='blob' and index==[(localmode+' '+localoid+' 0\t').encode()+indexed_name],
             '此文件含有用户暂存的改动。')
    else:
        need(not index,'此文件含有用户暂存的改动。')
    tree = git(repo, 'ls-tree', '-z', parent, '--', path).split(b'\0')[:-1]
    mode = '100644'
    if tree:
        meta, actual = tree[0].split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        need(len(tree) == 1 and kind == 'blob' and actual.decode() == path and mode in ('100644', '100755'), '文件类型不支持。')
        before = git(repo, 'cat-file', 'blob', oid)
        need(digest(before) == spec['before'], '此文件在成员开始前已有改动，请单独整理。')
    else:
        before = b''
        need(spec['before'] is None, '此文件在成员开始前已经存在或被暂存。')
    need(before != after or not tree, '文件没有待提交的差异。')
    return mode, before, after


def prepare(root, fd, dev, repo, cfg):
    url, branch, local = target(root)
    git(repo, 'init', '--bare', '-q', '--template=')
    previous = cfg.get('lastDelivery') or {}
    pull = cfg.get('pull')
    if pull:
        local_branch = branch
        branch = pull['branch']
        base = pull.get('base') or local_branch
        need(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9/._-]{0,130}', base) and
             re.fullmatch(r'codex/collab-[a-z0-9-]{1,80}', branch) and base != branch, 'PR 的来源与目标分支无效。')
        git(repo, 'check-ref-format', 'refs/heads/' + base)
        expected = pull.get('expectedHead')
        need(remote_head(repo, url, branch, optional=True) == expected, 'PR 工作分支已变化，请重新核对。')
        fetch_branch = branch if expected else base
    else:
        fetch_branch = branch
    git(repo, 'fetch', '-q', '--depth=1', '--no-tags', url, 'refs/heads/' + fetch_branch)
    tip = git(repo, 'rev-parse', 'FETCH_HEAD').decode().strip()
    if pull:
        parent = expected or tip
    else:
        parent = previous.get('commit') if (url,branch,local) == (previous.get('remote'),previous.get('branch'),previous.get('local')) else local
    need(tip == parent, '远端分支已有新提交，请同步后重新生成预览。')
    git(repo, 'read-tree', parent)
    for spec in cfg['files']:
        path = spec['path']
        mode, before, after = selected(root, fd, dev, parent, spec, repo)
        oid = git(repo, 'hash-object', '-w', '--stdin', data=after).decode().strip()
        git(repo, 'update-index', '--add', '--cacheinfo', mode, oid, path)
    tree = git(repo, 'write-tree').decode().strip()
    commit = git(repo, 'commit-tree', tree, '-p', parent, '-m', cfg['message'], identity=cfg['date']).decode().strip()
    diff = git(repo,'diff-tree','--no-commit-id','--no-ext-diff','--no-textconv','--no-color','--patch',parent,commit).decode()
    need(len(diff.encode()) <= 32000, '差异过大，请分批交付。')
    return {**({'pull': {'base':base, 'localBranch':local_branch, 'expectedHead':expected, 'repair':pull['repair'],
                          **({'number':pull['number']} if pull.get('number') else {})}} if pull else {}),
            'remote': url, 'branch': branch, 'local':local, 'parent':parent, 'commit':commit, 'message':cfg['message'],
            'files':[x['path'] for x in cfg['files']], 'diff':diff}


def main():
    action, path, device, inode, temp = sys.argv[1:]
    root, repo = Path(path), Path(temp)
    fd = os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    st = os.fstat(fd)
    need((st.st_dev,st.st_ino) == (int(device),int(inode)) and root.resolve() == root, '项目文件夹已经变化。')
    cfg = json.load(sys.stdin)
    if action == 'inventory':
        return inventory(fd,st.st_dev)
    if action == 'prepare':
        return prepare(root,fd,st.st_dev,repo,cfg)
    return complete(action,root,fd,st.st_dev,repo,cfg)


def complete(action,root,fd,dev,repo,cfg):
    plan = cfg['plan']
    url, branch, local = target(root)
    pull = plan.get('pull')
    need((url,branch,local) == (plan['remote'],pull['localBranch'] if pull else plan['branch'],plan['local']), '项目分支或远端已经改变。')
    branch = plan['branch']
    if action == 'check':
        return {'tip':remote_head(repo,url,branch,optional=bool(pull))}
    need(action == 'push', '无效的 Git 操作。')
    for spec in cfg['files']:
        selected(root,fd,dev,plan['parent'],spec,repo)
    expected = pull['expectedHead'] if pull else plan['parent']
    tip = remote_head(repo,url,branch,optional=bool(pull))
    if tip != plan['commit']:
        need(tip == expected, '远端分支已变化，请重新预览。')
        if pull and expected is None:
            need(remote_head(repo,url,pull['base']) == plan['parent'], 'PR 目标分支已前进，请重新预览。')
        ref = 'refs/heads/' + branch
        global sending
        sending = True
        git(repo, 'push', '--no-verify', '--force-with-lease=' + ref + ':' + (tip or ''), url, plan['commit'] + ':' + ref)
    return {'tip':remote_head(repo,url,branch)}


sending = False

if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,Refused) else 'Git 操作超时或文件状态无法核对。', 'sending':sending}))
