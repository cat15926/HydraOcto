import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runProjectionScenarios(root: string) {
  const path = 'packages/api/src/domains/ball-custody/ball-custody-projection-reducer.ts';
  const { reduceBallCustodyEvent, replayBallCustodyProjection } = await import(pathToFileURL(join(root, path)).href);
  const steps: any[] = [];
  const events: any[] = [];
  let projection: any = null;
  const start = Date.parse('2026-10-31T02:00:00.000Z');
  function step(label: string, kind: string, payload: unknown, expected: any, at: number) {
    const event = { sourceEventId: `research:event:${events.length + 1}`,
      subjectKey: 'ball:thread:research-room', kind, classification: 'state-changing', payload, at };
    const before = structuredClone(projection);
    const result = reduceBallCustodyEvent(projection, event);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(key === 'accepted' ? result.accepted : result.after[key], value, `${label}: ${key}`);
    }
    assert.deepEqual(projection, before, 'reducer must not mutate its input');
    projection = result.after;
    events.push(event);
    steps.push({ label, call: 'reduceBallCustodyEvent', input: structuredClone(event), before,
      result: structuredClone(result), after: structuredClone(projection),
      checks: [...Object.entries(expected).map(([key, value]) => `${key} == ${JSON.stringify(value)}`), 'input not mutated'] });
  }
  step('传给 A：建立投影', 'ball.handed', { toCatId: 'cat-a' }, { accepted: true, state: 'active', holder: 'cat-a' }, start);
  step('A 等待：记录准确 fireAt', 'ball.held', { catId: 'cat-a', fireAt: start + 60_000 }, { accepted: true, heldUntil: start + 60_000 }, start + 1_000);
  step('转给 B：清掉 A 的旧等待时间', 'ball.handed', { toCatId: 'cat-b' }, { accepted: true, holder: 'cat-b', heldUntil: null }, start + 2_000);
  step('A 的旧定时器到达：拒绝变成死球', 'ball.hold_expired', { fireAt: start + 60_000 }, { accepted: false, state: 'active', holder: 'cat-b' }, start + 60_000);
  step('旧 invocation 被退休：不关闭 B 的责任', 'ball.dispatch_dispositioned', { catId: 'cat-a', retired: true }, { accepted: true, state: 'active', holder: 'cat-b' }, start + 61_000);
  step('B 交给用户：parked，holder=cvo', 'ball.handed_cvo', { intent: 'handoff' }, { accepted: true, state: 'parked', holder: 'cvo', intent: 'handoff' }, start + 62_000);
  step('明确放弃：投影 resolved（不是成功）', 'ball.abandoned', { reason: 'research scenario cancelled by user' }, { accepted: true, state: 'resolved' }, start + 63_000);
  step('新交接重新打开投影', 'ball.handed', { toCatId: 'cat-c' }, { accepted: true, state: 'active', holder: 'cat-c', intent: null }, start + 64_000);
  const replay = replayBallCustodyProjection(events);
  assert.deepEqual(replay, projection);
  steps.push({ label: '全量事件回放：所有字段完全一致', call: 'replayBallCustodyProjection',
    input: structuredClone(events), before: null, result: structuredClone(replay), after: structuredClone(replay),
    checks: ['deepEqual(replay, incremental projection)'] });
  return {
    scenarios: [{ id: 'projection-replay', title: '球权投影：旧等待、退休执行与事件回放',
      scope: '实际运行上游纯 reducer；输入事件及时间由研究脚本构造，未经过事件生产路由/Redis 事件日志，不代表 Task owner 或执行权限发生变化。', steps }],
    sources: [{ path, line: 117, purpose: '真实投影归约器与事件回放' },
      { path: 'packages/shared/src/types/ball-custody.ts', line: 45, purpose: '事件与投影数据结构' },
      { path: 'packages/api/src/domains/ball-custody/ball-custody-state-machine.ts', line: 82, purpose: '旧 fireAt、retired 和终态守卫' }],
  };
}
