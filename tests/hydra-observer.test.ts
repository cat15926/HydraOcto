import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplication } from '../server/index.js';
import type { PublicRoomView } from '../shared/observer.js';

test('旁观读取公开主责及其交付，私聊不留痕迹，撤回公开回执后下次读取即失效', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-observer-'));
  const release = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<string>();
  const app = await createApplication({ dataDir: dir, port: 0, collaborationRuntime: {
    probe: async () => [],
    invoke: async request => {
      request.onEvent({ kind: 'accepted', detail: { nativeTurnId: request.invocationId } });
      let text = '这是私密处理结果。';
      if (request.member.id === 'claude') {
        const result = await request.onToolCall('obligation_open', { goal: '检查后公开交付' }, 'start') as { obligation: { id: string } };
        opened.resolve(result.obligation.id);
        await release.promise;
        text = '已完成检查，结果可用。';
        await request.onToolCall('obligation_deliver', { obligationId: result.obligation.id, summary: text }, 'finish');
      }
      request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true } });
      return { text, continuity: 'fresh' };
    },
  }});
  try {
    const { url } = await app.start();
    const { csrfToken } = await (await fetch(url + '/api/collaboration/bootstrap')).json();
    async function post(path: string, input: object) {
      const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ requestId: crypto.randomUUID(), ...input }) });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    }
    const { conversation } = await post('/api/conversations', { title: '公开验收', memberIds: ['claude', 'codex'], defaultMemberId: 'claude' });
    const path = '/api/conversations/' + conversation.id;
    const observe = async (): Promise<PublicRoomView> => {
      const response = await fetch(url + path + '/observer');
      assert.equal(response.status, 200);
      return response.json();
    };
    const before = await observe();
    const issued = await post(path + '/factors/issue', { memberId: 'codex', content: '仅收件人知道的查验原件' });
    await post(path + '/messages', { content: '私下处理这件事。', privateTo: ['codex'] });
    const settle = async (count: number) => {
      for (let n = 0; n < 160; n++) {
        if (app.collaborationStore.invocations(conversation.id).filter(i => i.status === 'succeeded').length >= count) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.fail('执行未完成');
    };
    await settle(1);
    app.collaborationStore.systemMessage(conversation.id, '内部调度标识 ' + issued.factorId);
    assert.deepEqual(await observe(), before);
    await post(path + '/messages', { content: '@Claude 帮我完成检查，并向我公开汇报。' });
    const rootId = await opened.promise;
    const working = await observe();
    assert.deepEqual(working.progress, [{ requestMessageId: working.messages[0].id, state: 'open' }]);
    release.resolve();
    await settle(2);
    const done = await observe();
    const receipt = done.messages.find(message => message.content === '已完成检查，结果可用。')!;
    assert.deepEqual(done.progress, [{ requestMessageId: done.messages[0].id, state: 'delivered', deliveryMessageId: receipt.id }]);
    assert.ok(done.factors.length);
    for (const factor of done.factors) {
      assert.deepEqual(Object.keys(factor).sort(), ['id', 'kind', 'messageId']);
      assert.ok(done.messages.some(message => message.id === factor.messageId));
    }
    for (const secret of [rootId, issued.factorId, 'codex', '私密处理', '查验原件']) assert.ok(!JSON.stringify(done).includes(secret));
    const ownerView=await (await fetch(url+path)).json();
    const ownerReceipt=ownerView.messages.find((m:{id:string})=>m.id===receipt.id);
    assert(ownerReceipt?.revision);
    await post(path + '/messages/' + receipt.id + '/visibility', { expectedRevision: ownerReceipt.revision, action: 'delete' });
    const redacted = await observe();
    assert.deepEqual(redacted.progress, []);
    assert.ok(!JSON.stringify(redacted).includes(receipt.id));
    await post(path + '/visibility-organize', { expectedRevision: 1, action: 'delete' });
    assert.equal((await fetch(url + path + '/observer')).status, 404);
  } finally {
    release.resolve();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
