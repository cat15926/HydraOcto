import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectVm } from '../../server/collaboration/project-vm.js';

const exec = promisify(execFile);

export async function createMonthlyFixture(work: string, token: string) {
  const inputs = { 'ledger.csv': 'id,amount\nzero,0\ncharge,11\nrefund,-3\ncharge,11\n\n',
    'export.py': `import csv,json\nfrom pathlib import Path\nrows={}\nwith open("ledger.csv") as f:\n    for row in csv.DictReader(f):\n        amount=int(row["amount"])\n        if amount:\n            rows[row["id"]]=amount\nPath("monthly.json").write_text(json.dumps({"rows":rows,"total":sum(rows.values())}))\n`,
    'check.py': `import json,runpy\nfrom pathlib import Path\nrunpy.run_path("export.py")\nactual=json.loads(Path("monthly.json").read_text())\nif actual != {"rows":{"zero":0,"charge":11,"refund":-3},"total":8}:\n    with open("checks.log","a") as f: f.write("fail\\n")\n    raise SystemExit("FAIL_${token}")\nwith open("checks.log","a") as f: f.write("pass\\n")\nprint("PASS_${token}")\n` };
  for (const [file, body] of Object.entries(inputs)) await writeFile(join(work,file), body, {flag:'wx'});
  return inputs;
}

// Re-run the unchanged regression under the guest's disconnected namespace; model-edited Python never runs on macOS.
export async function rerunMonthlyTest(vm: ProjectVm, caseName: string | null, successMarker: string) {
  if (caseName !== null) assert.match(caseName, /^(codex|claude)-monthly-[A-Za-z0-9]+$/);
  const script = `import os,sys
fd=os.open(sys.argv[1],os.O_PATH|os.O_NOFOLLOW|os.O_DIRECTORY)
os.set_inheritable(fd,True)
args=['/usr/bin/bwrap','--unshare-user','--unshare-ipc','--unshare-uts','--unshare-pid','--unshare-net','--as-pid-1','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv','--tmpfs','/tmp']
for path in ['/usr','/bin','/lib','/lib64']:
 if os.path.isdir(path):args+=['--ro-bind',path,path]
args+=['--bind-fd',str(fd),'/project','--chdir','/project','--','/usr/bin/python3','-I','-B','check.py']
os.execv(args[0],args)`;
  const {stdout} = await exec(vm.lima, ['shell','--workdir=/',vm.instance,'--','/usr/bin/python3','-I','-c',script,caseName === null ? '/mnt/project' : '/mnt/project/'+caseName],
    { env:{HOME:process.env.HOME, PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LIMA_HOME:vm.limaHome}, timeout:12000, maxBuffer:32768 });
  assert.equal(stdout.trim(), successMarker, '独立命名空间内重跑测试须得到本次标记');
}
