import { loadSuppliedKeys } from './key-file.js';
const supplied = await loadSuppliedKeys(process.argv[2] ?? '/Users/ruhonglin/lhz/apikey.log');
const probes = [
  { provider: 'deepseek', url: 'https://api.deepseek.com/models', key: supplied.deepseek.key },
  { provider: 'glm', url: 'https://open.bigmodel.cn/api/paas/v4/models', key: supplied.glm.key },
];
for (const probe of probes) {
  try {
    const response = await fetch(probe.url, { headers: { authorization: `Bearer ${probe.key}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); console.log(JSON.stringify({ provider: probe.provider, status: response.status })); continue; }
    const value = await response.json() as { data?: { id?: unknown }[] };
    const models = (value.data ?? []).map(m => m.id).filter(m => typeof m === 'string' && /^[a-zA-Z0-9_.:/-]+$/.test(m)).slice(0, 100);
    console.log(JSON.stringify({ provider: probe.provider, status: response.status, models }));
  } catch { console.log(JSON.stringify({ provider: probe.provider, status: 'unavailable' })); }
}
