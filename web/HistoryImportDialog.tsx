import { useEffect, useRef, useState } from 'react';
import type { HistoryChoice, HistoryPreview, HistoryProject } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
type Options = {
  accounts?: { id: string; name: string; provider: string }[];
  terminalRoot?: string;
  projects: HistoryProject[];
  members: { id: string; name: string; account: string; accountId: string; carrier: string }[];
};
const base = '/api/native-history/';
const label = (s: string) =>
  new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function HistoryImportDialog({
  command,
  close,
  open,
  initialPath,
}: {
  command: WorkbenchCommand;
  close: () => void;
  open: (id: string) => void;
  initialPath?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    active = useRef<AbortController | null>(null);
  const call = useRef(command);
  call.current = command;
  const [options, setOptions] = useState<Options>({ projects: [], members: [] }),
    [member, setMember] = useState(''),
    [project, setProject] = useState('');
  const [choices, setChoices] = useState<HistoryChoice[]>([]),
    [preview, setPreview] = useState<HistoryPreview>(),
    [query, setQuery] = useState('');
  const [range, setRange] = useState([0, 0]),
    [stage, setStage] = useState('加载中'),
    [error, setError] = useState(''),
    [ignored, setIgnored] = useState(0),
    [revision, reload] = useState(0);
  const [account, setAccount] = useState(''),
    [next, setNext] = useState<number | null>(null);
  const [session, setSession] = useState(''),
    [initVersion, reinit] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [rangeNotice, setRangeNotice] = useState('');
  const [retryConfirm, setRetryConfirm] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const d = dialog.current!;
    d.showModal();
    return () => {
      active.current?.abort();
      d.close();
    };
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    setError('');
    setStage('加载中');
    call
      .current<Options>(base + 'options', {}, ctrl.signal)
      .then((o) => {
        if (ctrl.signal.aborted) return;
        setOptions(o);
        setMember(o.members[0]?.id ?? '');
        setAccount(o.members[0]?.accountId ?? '');
        setProject((o.projects.find((p) => p.path === initialPath) ?? o.projects[0])?.id ?? '');
        setStage('');
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) {
          setError(e.message);
          setStage('');
        }
      });
    return () => ctrl.abort();
  }, [initialPath, initVersion]);
  useEffect(() => {
    if (!member || !project) return;
    active.current?.abort();
    const ctrl = new AbortController();
    active.current = ctrl;
    setPreview(undefined);
    setRefreshRequired(false);
    setRangeNotice('');
    setRetryConfirm(false);
    setChoices([]);
    setNext(null);
    setIgnored(0);
    setReasons([]);
    setError('');
    setStage('正在查找会话');
    call
      .current<{ choices: HistoryChoice[]; unavailable: number; reasons?: string[]; next: number | null }>(
        base + 'list',
        { memberId: member, projectId: project, accountId: account },
        ctrl.signal,
      )
      .then((r) => {
        if (!ctrl.signal.aborted) {
          setChoices(r.choices);
          setNext(r.next);
          setIgnored(r.unavailable);
          setReasons(r.reasons ?? []);
        }
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setStage('');
      });
    return () => ctrl.abort();
  }, [member, project, account, revision]);
  function back() {
    active.current?.abort();
    setPreview(undefined);
    setSession('');
    reload((n) => n + 1);
    requestAnimationFrame(() => title.current?.focus());
  }
  async function more() {
    if (next === null) return;
    const ctrl = new AbortController();
    active.current = ctrl;
    setStage('正在读取更多会话');
    try {
      const r = await call.current<{
        choices: HistoryChoice[];
        unavailable: number;
        reasons?: string[];
        next: number | null;
      }>(base + 'list', { memberId: member, projectId: project, accountId: account, offset: next }, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setChoices((old) => [...old, ...r.choices.filter((c) => !old.some((o) => o.id === c.id))]);
        setIgnored((n) => n + r.unavailable);
        setReasons((previous) => [...new Set([...previous, ...(r.reasons ?? [])])]);
        setNext(r.next);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setStage('');
    }
  }
  async function pick() {
    active.current?.abort();
    const ctrl = new AbortController();
    active.current = ctrl;
    setError('');
    setStage('请在系统窗口选择项目');
    try {
      const { project: p } = await call.current<{ project: HistoryProject | null }>(
        base + 'project',
        {},
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      if (p) {
        setOptions((o) => ({ ...o, projects: [...o.projects.filter((x) => x.id !== p.id), p] }));
        setProject(p.id);
      }
      reload((n) => n + 1);
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setStage('');
    }
  }
  async function view(id: string) {
    active.current?.abort();
    const ctrl = new AbortController();
    active.current = ctrl;
    setStage('正在读取历史');
    setError('');
    setSession(id);
    try {
      const p = await call.current<HistoryPreview>(
        base + 'preview',
        { memberId: member, projectId: project, accountId: account, session: id },
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) {
        if (preview && id === session) {
          const previous = preview.lines.slice(range[0], range[1] + 1);
          const first = p.lines.findIndex((line) => line.anchor === previous[0]?.anchor);
          const same =
            first >= 0 &&
            previous.every((line, i) => {
              const current = p.lines[first + i];
              return (
                current &&
                line.anchor === current.anchor &&
                line.time === current.time &&
                line.role === current.role &&
                line.text === current.text
              );
            });
          setRange(same ? [first, first + previous.length - 1] : [0, -1]);
          setRangeNotice(same ? '已刷新来源，并保留原选段。' : '原选段已经变化，请重新选择要带入的消息。');
        } else {
          setRange([Math.max(0, p.lines.length - 200), p.lines.length - 1]);
          setRangeNotice('');
        }
        setRefreshRequired(false);
        setRetryConfirm(false);
        setPreview(p);
        requestAnimationFrame(() => title.current?.focus());
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setStage('');
    }
  }
  const committing = stage === '正在导入',
    locked = useRef(false);
  async function confirm() {
    if (!preview || locked.current || refreshRequired || range[1] < range[0]) return;
    locked.current = true;
    setStage('正在导入');
    setError('');
    try {
      const r = await call.current<{ conversationId: string }>(base + 'confirm', {
        token: preview.token,
        first: range[0],
        last: range[1],
      });
      open(r.conversationId);
    } catch (e) {
      const status = e instanceof Error && 'status' in e ? e.status : undefined;
      setRefreshRequired(status === 409);
      setRetryConfirm(!status || (typeof status === 'number' && status >= 500));
      setError(status ? (e as Error).message : '暂未收到确认结果，请重试同一次导入。');
      setStage('');
    } finally {
      locked.current = false;
    }
  }
  function chooseRange(next: number[]) {
    setRange(next);
    setRangeNotice('');
    setError('');
  }
  const lockRange = !!stage || refreshRequired || retryConfirm;
  const selected = options.members.find((m) => m.id === member);
  const results = choices.filter((c) => c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const size = range[1] - range[0] + 1;
  const oversized =
    preview && preview.lines.slice(range[0], range[1] + 1).reduce((sum, l) => sum + l.text.length, 0) > 100_000;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const sourcePath = options.projects.find((p) => p.id === project)?.path;
  const terminal =
    options.terminalRoot && sourcePath && selected && selected.accountId === account
      ? 'npm --prefix ' +
        quote(options.terminalRoot) +
        ' run history:terminal -- ' +
        quote(member) +
        ' ' +
        quote(sourcePath)
      : '';
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [terminal]);
  return (
    <dialog
      ref={dialog}
      className="cc-dialog cc-history-dialog"
      aria-labelledby="cli-import-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!committing) close();
      }}
    >
      <header>
        <h2 tabIndex={-1} ref={title} id="cli-import-title">
          {preview ? '选择带入的消息' : '导入本机会话'}
        </h2>
        <button type="button" aria-label="关闭导入" disabled={committing} onClick={close}>
          ×
        </button>
      </header>
      <div className="cc-history-body">
        {!preview ? (
          <>
            <div className="cc-history-fields">
              <label>
                导入给
                <select
                  value={member}
                  onChange={(e) => {
                    active.current?.abort();
                    setSession('');
                    setMember(e.target.value);
                    setAccount(options.members.find((m) => m.id === e.target.value)?.accountId ?? '');
                  }}
                >
                  {options.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.account}
                    </option>
                  ))}
                </select>
              </label>
              {selected &&
                (options.accounts ?? []).filter(
                  (a) => a.provider === (selected.carrier === 'claude-cli' ? 'claude' : 'codex'),
                ).length > 1 && (
                  <label>
                    来源账户
                    <select
                      value={account}
                      onChange={(e) => {
                        active.current?.abort();
                        setAccount(e.target.value);
                        setSession('');
                      }}
                    >
                      {options.accounts
                        ?.filter((a) => a.provider === (selected.carrier === 'claude-cli' ? 'claude' : 'codex'))
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              <label>
                来源项目
                <select
                  value={project}
                  onChange={(e) => {
                    if (e.target.value === 'choose') void pick();
                    else {
                      active.current?.abort();
                      setSession('');
                      setProject(e.target.value);
                    }
                  }}
                >
                  {options.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.path}
                    </option>
                  ))}
                  <option value="choose">选择其他文件夹…</option>
                </select>
              </label>
            </div>
            {choices.length > 0 && (
              <label>
                搜索会话
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="按会话标题搜索"
                />
              </label>
            )}
            {!stage &&
              !error &&
              (!selected ? (
                <p>先在「成员与运行时」启用一个 Codex 或 Claude Code 成员。</p>
              ) : results.length === 0 ? (
                <p>
                  {query ? '没有匹配的会话，请调整搜索。' : '此账户在所选项目没有可核验的历史。可切换账户或项目。'}
                </p>
              ) : null)}
            {results.length > 0 && (
              <ul aria-label="可导入的会话">
                {results.map((c) => (
                  <li key={c.id}>
                    <button type="button" disabled={!!stage} onClick={() => void view(c.id)}>
                      <strong>{c.title}</strong>
                      <small>
                        {label(c.time)} · {c.count} 条消息
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {next !== null && (
              <button disabled={!!stage} onClick={() => void more()}>
                加载更多会话
              </button>
            )}
            {ignored > 0 && <p>{reasons.join(' ') || '部分来源暂时无法核验。'}</p>}
            {!stage && !error && !query && !results.length && selected && project && (
              <button onClick={() => reload((v) => v + 1)}>重新查找会话</button>
            )}
            {!stage && !query && !results.length && selected && (
              <details>
                <summary>哪些历史可以导入？</summary>
                <p>
                  仅列出账户和项目均可核验的历史。共享 CLI 目录里的旧记录可能缺少账户信息。Codex
                  可核对原生索引中的创建账户。缺少归属信息的旧记录无法补验。
                </p>
                {terminal && (
                  <>
                    <p>
                      若要保留以后在此项目中的终端对话，可使用下方命令启动带来源回执的 CLI。回复仍由所选 CLI 生成。
                    </p>
                    <code>{terminal}</code>
                    <button
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(terminal)
                          .then(() => setCopied(true))
                          .catch(() => setError('请选中上方命令并复制。'))
                      }
                    >
                      {copied ? '已复制' : '复制终端命令'}
                    </button>
                  </>
                )}
              </details>
            )}
          </>
        ) : (
          <>
            <p>
              {preview.account} · {preview.project}
            </p>
            <p>
              将创建新会话，所选历史仅你和 <strong>{preview.member}</strong> 可见。
            </p>
            {rangeNotice && <p role="status">{rangeNotice}</p>}
            <div className="cc-history-range">
              <button
                disabled={lockRange}
                onClick={() =>
                  chooseRange([
                    Math.max(0, preview.lines.map((l) => l.role).lastIndexOf('user')),
                    preview.lines.length - 1,
                  ])
                }
              >
                最近一轮
              </button>
              {preview.lines.length <= 200 && (
                <button disabled={lockRange} onClick={() => chooseRange([0, preview.lines.length - 1])}>
                  全部消息
                </button>
              )}
            </div>
            <ol aria-label="历史消息">
              {preview.lines.map((l, i) => (
                <li className={i >= range[0] && i <= range[1] ? 'chosen' : ''} key={l.anchor}>
                  <small>
                    {i + 1} · {l.role === 'user' ? '用户' : '助手'} · {label(l.time)}
                  </small>
                  <pre>{l.text}</pre>
                  <div>
                    <button
                      disabled={lockRange}
                      aria-label={'从第 ' + (i + 1) + ' 条开始'}
                      onClick={() => chooseRange([i, Math.max(i, Math.min(range[1], i + 199))])}
                    >
                      从此条开始
                    </button>
                    <button
                      disabled={lockRange}
                      aria-label={'到第 ' + (i + 1) + ' 条结束'}
                      onClick={() => chooseRange([Math.min(i, Math.max(range[0], i - 199)), i])}
                    >
                      到此条结束
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
        {oversized && <p role="status">选段超过 10 万字，请缩小范围后导入。</p>}
        {stage && <p role="status">{stage}…</p>}
        {error && (
          <div role="alert">
            {error}{' '}
            {(!preview || refreshRequired) && (
              <button
                onClick={() => {
                  if (preview && session) void view(session);
                  else if (!member) reinit((n) => n + 1);
                  else reload((n) => n + 1);
                }}
              >
                刷新来源
              </button>
            )}
          </div>
        )}
      </div>
      <footer>
        {preview ? (
          <>
            <button onClick={back} disabled={committing}>
              返回列表
            </button>
            <button
              className="primary"
              disabled={!!stage || refreshRequired || !size || size > 200 || oversized}
              onClick={() => void confirm()}
            >
              {retryConfirm ? '重试导入' : '导入'} {size} 条消息
            </button>
          </>
        ) : (
          <button onClick={close}>取消</button>
        )}
      </footer>
    </dialog>
  );
}
