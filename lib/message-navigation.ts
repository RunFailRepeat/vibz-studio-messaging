import type { MessageTarget, ResolvedMessageTarget } from './message-target';

export type NavigationSnapshot = { view: string; channelId: string; [key: string]: unknown };
type Entry = { snapshot: NavigationSnapshot; target?: MessageTarget };
type HistoryState = Record<string, unknown> & { vibzMessageNavigation?: Entry };
export type NavigationPort = {
  state(): unknown;
  url(): string;
  push(state: HistoryState, url: string): void;
  replace(state: HistoryState, url: string): void;
  subscribe(callback: () => void): () => void;
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/.test(value);
export function targetFromURL(url: string): MessageTarget | undefined {
  const p = new URL(url).searchParams;
  if (!p.has('messageId')) return undefined;
  const messageId = p.get('messageId'), channelId = p.get('messageChannel'), rootId = p.get('messageRoot');
  if (!id(messageId) || (channelId !== null && !id(channelId)) || (rootId !== null && !id(rootId))) return undefined;
  return { messageId, ...(channelId === null ? {} : { channelId }), ...(rootId === null ? {} : { rootId }) };
}
function targetURL(url: string, target?: MessageTarget) {
  const next = new URL(url);
  for (const key of ['messageId', 'messageChannel', 'messageRoot']) next.searchParams.delete(key);
  if (target) {
    next.searchParams.set('messageId', target.messageId);
    if (target.channelId) next.searchParams.set('messageChannel', target.channelId);
    if (target.rootId) next.searchParams.set('messageRoot', target.rootId);
  }
  return next.href;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function entry(state: unknown): Entry | undefined {
  const e = object(object(state).vibzMessageNavigation), s = object(e.snapshot);
  if (typeof s.view !== 'string' || typeof s.channelId !== 'string') return undefined;
  const t = object(e.target);
  if (e.target !== undefined && (!id(t.messageId) || (t.channelId !== undefined && !id(t.channelId)) || (t.rootId !== undefined && !id(t.rootId)))) return undefined;
  return { snapshot: s as NavigationSnapshot, ...(e.target === undefined ? {} : { target: t as MessageTarget }) };
}
const sameTarget = (a?: MessageTarget, b?: MessageTarget) => !!a && !!b && a.messageId === b.messageId && a.channelId === b.channelId && a.rootId === b.rootId;

// The controller owns only a namespaced history entry. Network completion is
// fenced for every transition, including non-message navigation and popstate.
export function createMessageNavigation(options: {
  port: NavigationPort;
  snapshot(): NavigationSnapshot;
  resolve(target: MessageTarget, signal: AbortSignal): Promise<ResolvedMessageTarget>;
  restore(snapshot: NavigationSnapshot): void;
  resolved(result: ResolvedMessageTarget): void;
  failed(error: unknown): void;
}) {
  const { port } = options;
  let failedTarget = false, checkpointEpoch = 0;
  let generation = 0, disposed = false, active: AbortController | undefined;
  let current = entry(port.state()) ?? { snapshot: options.snapshot(), target: targetFromURL(port.url()) };
  function write(next: Entry, push: boolean) {
    const state = { ...object(port.state()), vibzMessageNavigation: next };
    (push ? port.push : port.replace)(state, targetURL(port.url(), next.target));
    current = next;
  }
  function save() { write({ ...current, snapshot: options.snapshot() }, false); }
  async function apply(next: Entry) {
    const ticket = ++generation;
    ++checkpointEpoch;
    failedTarget = false;
    active?.abort(); active = undefined;
    options.restore(next.snapshot);
    if (!next.target) return;
    const controller = new AbortController(); active = controller;
    try {
      const result = await options.resolve(next.target, controller.signal);
      if (!disposed && ticket === generation) {
        ++checkpointEpoch; // Committing a target can change rooms without another user transition.
        options.resolved(result);
        // Snapshot now records the resolved UI, not the previous room.
        save();
      }
    } catch (error) { if (!disposed && ticket === generation) { failedTarget = true; options.failed(error); } }
  }
  const unsubscribe = port.subscribe(() => {
    const next = entry(port.state()) ?? { snapshot: { view: 'room', channelId: '' }, target: targetFromURL(port.url()) };
    current = next;
    void apply(next);
  });
  write(current, false);
  return {
    start: () => apply(current),
    checkpoint: () => { const ticket = checkpointEpoch; return () => !disposed && ticket === checkpointEpoch; },
    navigate: async (target: MessageTarget) => {
      // Same in-flight or already-resolved target does not add history or fetch.
      if (sameTarget(current.target, target)) {
        if (failedTarget) await apply(current);
        return;
      }
      save();
      const next = { snapshot: options.snapshot(), target };
      write(next, true);
      await apply(next);
    },
    leave: (snapshot: NavigationSnapshot) => {
      save();
      const next = { snapshot };
      write(next, true);
      void apply(next);
    },
    dispose: () => { disposed = true; ++generation; active?.abort(); unsubscribe(); },
  };
}

export function browserNavigationPort(browser: Window): NavigationPort {
  return {
    state: () => browser.history.state,
    url: () => browser.location.href,
    push: (state, url) => browser.history.pushState(state, '', url),
    replace: (state, url) => browser.history.replaceState(state, '', url),
    subscribe: callback => { browser.addEventListener('popstate', callback); return () => browser.removeEventListener('popstate', callback); },
  };
}
