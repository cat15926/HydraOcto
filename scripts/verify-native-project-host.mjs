// P0 macOS capability observation using fresh disposable files, no account data or model requests.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
if (process.platform !== 'darwin') throw new Error('此探针仅验证 macOS Seatbelt。');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-host');
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, 'run-'));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'native-project-probe-')));
const project = join(temporary, 'project');
const scratch = join(temporary, 'scratch');
const sibling = join(temporary, 'reference.txt');
const marker = randomUUID();
const report = { platform: process.platform, osRelease: release(), time: new Date().toISOString(), realModelCalls: 0, probes: [],
  unverified: ['live_model_authentication', 'credential_broker_identity', 'login_store_isolation', 'project_identity_during_execution', 'descendant_teardown'] };
const servers = [];
function observe(name, passed, detail) {
  report.probes.push({ name, passed, ...(detail ? { detail } : {}) });
  if (!passed) process.exitCode = 1;
}
async function listen() {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end(marker); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  servers.push(server);
  return { port: server.address().port, requests: () => requests };
}
try {
  await mkdir(project, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  await writeFile(sibling, marker);
  const approved = await listen(), otherListener = await listen();
  // Scope each use to this probe's own directories. Paths use SBPL parameters, never source interpolation.
  const profile = `(version 1)
(deny default (with no-log))
(import "dyld-support.sb")
(allow file-read* file-map-executable
  (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/System/Library") (literal "/private/var/select/sh")
  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
  (literal (param "CLI")) (subpath (param "ROOT")) (subpath (param "SCRATCH")))
(allow file-read-metadata (path-ancestors (param "ROOT")) (path-ancestors (param "SCRATCH")) (path-ancestors (param "CLI")))
(allow file-write* (subpath (param "ROOT")) (subpath (param "SCRATCH")) (literal "/dev/null"))
(allow process-exec process-fork sysctl-read)
(allow signal process-info-pidinfo (target self))
(allow network-outbound (remote tcp "localhost:${approved.port}"))`;
  const env = { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, SHELL: '/bin/sh', LANG: 'C', CODEX_HOME: scratch, CLAUDE_CONFIG_DIR: scratch };
  async function isolated(binary, args) {
    try {
      const { stdout } = await exec('/usr/bin/sandbox-exec',
        ['-D', 'ROOT=' + project, '-D', 'SCRATCH=' + scratch, '-D', 'CLI=' + binary, '-p', profile, binary, ...args],
        { cwd: project, env, timeout: 7000, maxBuffer: 32_000 });
      return { ok: true, stdout, stderr: '' };
    } catch (e) {
      return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }
  const child = await isolated('/bin/sh', ['-c', '/usr/bin/touch generated.txt']);
  const created = await readFile(join(project, 'generated.txt')).then(data => data.length === 0, () => false);
  observe('project_child_write', child.ok && created);
  const read = await isolated('/bin/cat', [sibling]);
  observe('sibling_read_denied', !read.ok && /[Oo]peration not permitted|[Pp]ermission denied/.test(read.stderr));
  const write = await isolated('/bin/sh', ['-c', 'echo changed > "$1"', 'sh', sibling]);
  observe('sibling_write_denied', !write.ok && /[Oo]peration not permitted|[Pp]ermission denied/.test(write.stderr) && await readFile(sibling, 'utf8') === marker);
  const request = port => isolated('/usr/bin/curl', ['-fsS', '--noproxy', '*', '--max-time', '2', 'http://127.0.0.1:' + port]);
  const allowed = await request(approved.port);
  observe('designated_loopback_port', allowed.ok && allowed.stdout === marker && approved.requests() === 1);
  const other = await request(otherListener.port);
  const sandboxRequestsReceived = otherListener.requests();
  const baseline = await fetch('http://127.0.0.1:' + otherListener.port);
  const controlReadMarker = await baseline.text() === marker;
  observe('other_loopback_port_denied', allowed.ok && !other.ok && sandboxRequestsReceived === 0
    && controlReadMarker && otherListener.requests() === 1, { sandboxRequestsReceived, controlReadMarker });
  for (const [cli, configured] of [['codex', process.env.COLLAB_CODEX_PATH], ['claude', process.env.COLLAB_CLAUDE_PATH]]) {
    try {
      const binary = await realpath(configured || (await exec('/usr/bin/which', [cli])).stdout.trim());
      const v = await isolated(binary, ['--version']);
      const version = /\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/.exec(v.stdout)?.[0];
      observe(cli + '_isolated_version', Boolean(v.ok && version), version);
    } catch { observe(cli + '_isolated_version', false, 'executable_unavailable'); }
  }
} catch (e) {
  observe('setup', false, e.code || e.name);
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  console.log(join(run, 'report.json'));
}
