#!/usr/bin/env python3
"""Render recorded upstream results, without calculating any Clowder transitions."""
import argparse
import json
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[2]
DOCS_ARCHIVE = Path(os.environ.get('MULTI_AGENT_DOCS_DIR') or PROJECT.parent / 'Multi-Agent-Docs').resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('viewer_destination', nargs='?', help='Optional HTML viewer output, preserving the original positional interface.')
parser.add_argument('--trace', default=os.environ.get('CLOWDER_TRACE_PATH', str(DOCS_ARCHIVE / 'research/clowder-simulation/trace.json')), help='Recorded trace to render; defaults to frozen evidence in MULTI_AGENT_DOCS_DIR or the sibling Multi-Agent-Docs directory.')
parser.add_argument('--output-dir', default=os.environ.get('VALIDATION_OUTPUT_DIR', str(PROJECT / '.local-data/validation/clowder-simulation')), help='Local staging directory; does not replace the published report.')
parser.add_argument('--report', help='Explicit report file override.')
args = parser.parse_args()
TRACE = Path(args.trace).resolve()
REPORT = Path(args.report).resolve() if args.report else Path(args.output_dir).resolve() / 'clowder-collaboration-executable-walkthrough.md'
REPORT.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(TRACE.read_text())
scenarios = {s['id']: s for s in data['scenarios']}

def step(sid, number):
    return scenarios[sid]['steps'][number - 1]

def pick(obj, *keys):
    return {k: obj[k] for k in keys if k in obj}

def block(obj):
    return '```json\n' + json.dumps(obj, ensure_ascii=False, indent=2) + '\n```'

def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')

def table(headers, rows):
    return '\n'.join(['| ' + ' | '.join(map(cell, headers)) + ' |', '| ' + ' | '.join(['---'] * len(headers)) + ' |'] +
                     ['| ' + ' | '.join(map(cell, row)) + ' |' for row in rows])

def result_text(r):
    if not isinstance(r, dict):
        return json.dumps(r, ensure_ascii=False)
    selected = pick(r, 'kind', 'outcome', 'status', 'reason', 'ok', 'accepted', 'applied', 'error')
    return json.dumps(selected, ensure_ascii=False) if selected else '返回对象，见原始记录'

def flow(sid):
    return table(['步骤', '实际调用', '实际返回 / 通过的核对'], [
        [f"{i}. {s['label']}", '`' + s['call'] + '`', result_text(s['result']) + '；' + '；'.join(s['checks'])]
        for i, s in enumerate(scenarios[sid]['steps'], 1)])

task_fields = ('id', 'kind', 'subjectKey', 'threadId', 'ownerCatId', 'ownerRevision', 'status', 'executionRef', 'lastAppliedHandoffMessageRef')
lease_fields = ('key', 'leaseId', 'subjectRef', 'mode', 'holderCatIds', 'holderThreadId', 'predecessorCatId',
                'generation', 'revision', 'status', 'holderOutcomes', 'terminalPredicate', 'completionCandidates')
tokens = {
    'ARCHIVE_OVERVIEW_URL': quote(os.path.relpath(DOCS_ARCHIVE / 'research/clowder/clowder-collaboration-ball-custody-report.md', REPORT.parent), safe='/'),
    'TRACE_URL': quote(os.path.relpath(TRACE, REPORT.parent), safe='/'),
    'RUN_SCRIPT_URL': quote(os.path.relpath(HERE / 'run.mjs', REPORT.parent), safe='/'),
    'GENERATED_DATE': datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d'),
    'TRACE_SCOPE': f"Clowder {data['baseline']['commit']} 的已保存源码实跑记录",
    'META': f"本次记录：{datetime.fromisoformat(data['finished'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')}（北京时间）；Node {data['runtime']['node']}。固定提交 `{data['baseline']['commit']}`。共 **{data['totals']['scenarios']} 个场景、{data['totals']['steps']} 个记录步骤、{data['totals']['checkedStatements']} 项已通过核对**。步骤数包含显式测试输入/外部事实注入，不等于全部是服务端业务调用。",
    'SCENARIOS': table(['场景 ID', '模拟内容', '步骤'], [[s['id'], s['title'], len(s['steps'])] for s in data['scenarios']]),
    'TASK_INITIAL': block(pick(step('task-claim-bind', 1)['after']['task'], *task_fields)),
    'TASK_CLAIMED': block(pick(step('task-claim-bind', 3)['after']['task'], *task_fields)),
    'HANDOFF_REQUEST': block(step('task-handoff-fences', 1)['result']),
    'HANDOFF_FLOW': flow('task-handoff-fences'),
    'TASK_AFTER_APPLY': block(pick(step('task-handoff-fences', 6)['after']['task'], *task_fields)),
    'TASK_DONE': block(pick(step('task-handoff-fences', 12)['after']['task'], *task_fields)),
    'CROSS_TASK': block(pick(step('task-cross-thread-delegation', 4)['after']['task'], *task_fields)),
    'CROSS_FLOW': flow('task-cross-thread-delegation'),
    'QUEUE_INPUT': block(step('message-queue', 1)['input']),
    'QUEUE_OUTPUT': block({
        'message': pick(step('message-queue', 1)['result']['message'], 'id', 'from', 'threadId', 'mentions', 'origin', 'lifecycle'),
        'entry': pick(step('message-queue', 1)['result']['entry'], 'version', 'id', 'kind', 'owner', 'targets', 'payload', 'execution', 'status'),
    }),
    'QUEUE_FLOW': flow('message-queue'),
    'AGG_FLOW': flow('message-aggregate'),
    'TIMEOUT_FLOW': flow('message-timeout'),
    'ACTION_INITIAL': block(pick(step('action-single-replacement-return', 1)['result']['lease'], *lease_fields)),
    'ACTION_FLOW': flow('action-single-replacement-return'),
    'ACTION_RETURN': block(pick(step('action-single-replacement-return', 9)['result']['lease'],
        'holderCatIds', 'holderThreadId', 'predecessorCatId', 'predecessorThreadId', 'generation', 'revision',
        'status', 'returnDeliveryState', 'returnTransitions')),
    'PARALLEL_FLOW': flow('action-parallel-evidence'),
    'WAIT_RECEIPT': block(step('typed-deployment-registration', 1)['result']),
    'WAIT_REGISTRATION_FLOW': flow('typed-deployment-registration'),
    'WAIT_FLOW': flow('wait-generation-renewal-expiry'),
    'WAIT_RENEWED': block(step('wait-generation-renewal-expiry', 1)['after']),
    'PROJECTION_FLOW': flow('projection-replay'),
    'ROUTE_FLOW': '\n\n'.join(scenarios[sid]['scope'] + '\n\n' + flow(sid) for sid in scenarios if sid.startswith('message-route')) or
                  '本次只静态追踪 route 的汇总发表路径；未把它算作 HTTP 或模型端到端实测。',
    'SOURCES': table(['源码', '用途'], [[
        f"[{s['path']}:{s['line']}](https://github.com/zts212653/clowder-ai/blob/{data['baseline']['commit']}/{s['path']}#L{s['line']})", s['purpose']
    ] for s in data['references']]),
}
template = (HERE / 'report.template.md').read_text()
for name, value in tokens.items():
    template = template.replace('{{' + name + '}}', value)
assert not re.search(r'\{\{[A-Z_]+\}\}', template), 'unresolved report token'
# Local link tokens resolve against the chosen archive, exact trace and output
# directory. No assumption about the archive being part of the code checkout.
REPORT.write_text(template)

if args.viewer_destination:
    destination = Path(args.viewer_destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    fragment = (HERE / 'trace-viewer.fragment.html').read_text()
    embedded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    fragment = fragment.replace('__TRACE_DATA__', embedded)
    assert len(fragment.encode()) < 1_000_000, 'inline trace exceeds size limit'
    destination.write_text(fragment)
    print(destination)
print(REPORT)
