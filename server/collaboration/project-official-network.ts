import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
/** Honor an explicitly enabled macOS static loopback proxy for the host CLI only.
 * Keep operator-provided proxy variables, and never guess an address or use a PAC URL. */
export function applySystemProxy(env:NodeJS.ProcessEnv, settings:string):NodeJS.ProcessEnv {
  const result={...env};
  const fields=new Map<string,string>();
  for (const line of settings.split('\n')) {
    const m=/^\s*(HTTP(?:S)?(?:Enable|Port|Proxy)|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*(\S+)\s*$/.exec(line);
    if (m) fields.set(m[1]!,m[2]!);
  }
  if (result.ALL_PROXY || result.all_proxy || fields.get('ProxyAutoConfigEnable')==='1' || fields.get('ProxyAutoDiscoveryEnable')==='1') return result;
  for (const name of ['HTTP','HTTPS']) {
    const upper=name+'_PROXY',lower=upper.toLowerCase();
    if (result[upper] || result[lower] || fields.get(name+'Enable')!=='1') continue;
    const host=fields.get(name+'Proxy'),port=fields.get(name+'Port') ?? '';
    if ((host==='127.0.0.1' || host==='::1') && /^[1-9]\d{0,4}$/.test(port) && Number(port)<=65535) {
      result[upper]=result[lower]='http://'+(host==='::1'?'[::1]':host)+':'+port;
    }
  }
  return result;
}
export async function officialProjectNetworkEnv(env:NodeJS.ProcessEnv):Promise<NodeJS.ProcessEnv> {
  if (process.platform!=='darwin') return env;
  try {
    const {stdout}=await exec('/usr/sbin/scutil',['--proxy'],{cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:2000,maxBuffer:16384});
    return applySystemProxy(env,stdout);
  } catch { return env; }
}
