import test from 'node:test';
import assert from 'node:assert/strict';
import { routes } from './load-message-target.mjs';
const { createMessageNavigation, targetFromURL } = routes.navigation;
class HistoryFixture {
  constructor() { this.entries = [{ state: { existingRouterKey: 7 }, url: 'https://studio.example.invalid/?keep=value#anchor' }]; this.index = 0; this.listeners = new Set(); }
  port = {
    state: () => this.entries[this.index].state,
    url: () => this.entries[this.index].url,
    push: (state, url) => { this.entries.splice(++this.index); this.entries.push({ state, url }); },
    replace: (state, url) => { this.entries[this.index] = { state, url }; },
    subscribe: callback => { this.listeners.add(callback); return () => this.listeners.delete(callback); },
  };
  go(delta) { this.index += delta; for (const callback of this.listeners) callback(); }
}
const target = name => ({ messageId: `message_${name}`, channelId: 'room_a', rootId: 'root_a' });
const response = name => ({ message: { id: `message_${name}`, channelId: 'room_a' }, root: { id: 'root_a', channelId: 'room_a' } });
function fixture(t) {
  const history = new HistoryFixture(), pending = [], applied = [], errors = [];
  let snapshot = { view: 'work', channelId: 'room_b', workFilter: 'room_b', showCancelled: true };
  const nav = createMessageNavigation({ port: history.port,
    snapshot: () => snapshot,
    restore: value => { snapshot = value; },
    resolved: value => { applied.push(value.message.id); snapshot = { ...snapshot, view: 'room', channelId: value.root.channelId }; },
    failed: error => errors.push(error),
    resolve: (value, signal) => new Promise((resolve, reject) => pending.push({ value, signal, resolve, reject })),
  });
  t.after(() => nav.dispose());
  return { history, nav, pending, applied, errors, snapshot: () => snapshot };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('duplicate in-flight and resolved target navigation neither duplicates history nor fetch', async t => {
  const f = fixture(t), first = f.nav.navigate(target('one'));
  await f.nav.navigate(target('one'));
  assert.equal(f.history.entries.length, 2); assert.equal(f.pending.length, 1);
  f.pending[0].resolve(response('one')); await first;
  await f.nav.navigate(target('one'));
  assert.equal(f.history.entries.length, 2); assert.equal(f.pending.length, 1);
  assert.equal(f.history.port.state().existingRouterKey, 7);
  assert.equal(new URL(f.history.port.url()).searchParams.get('keep'), 'value');
  assert.equal(new URL(f.history.port.url()).hash, '#anchor');
});
test('back and forward restore message targets and complete non-message snapshots', async t => {
  const f = fixture(t), before = { ...f.snapshot() }, first = f.nav.navigate(target('one'));
  f.pending[0].resolve(response('one')); await first;
  f.nav.leave({ view: 'agents', channelId: 'room_c', workFilter: '', showCancelled: false });
  assert.equal(targetFromURL(f.history.port.url()), undefined);
  f.history.go(-1); assert.equal(f.pending.length, 2);
  assert.deepEqual(f.pending[1].value, target('one'));
  f.pending[1].resolve(response('one')); await tick();
  f.history.go(-1); assert.deepEqual(f.snapshot(), before);
  f.history.go(1); f.pending[2].resolve(response('one')); await tick();
  f.history.go(1); assert.deepEqual(f.snapshot(), { view: 'agents', channelId: 'room_c', workFilter: '', showCancelled: false });
});
test('late success and late error cannot replace a newer message or non-message destination', async t => {
  const f = fixture(t), one = f.nav.navigate(target('one')), two = f.nav.navigate(target('two'));
  assert.ok(f.pending[0].signal.aborted);
  f.pending[1].resolve(response('two')); await two;
  f.pending[0].resolve(response('one')); await one;
  assert.deepEqual(f.applied, ['message_two']);
  const third = f.nav.navigate(target('three'));
  f.nav.leave({ view: 'team', channelId: 'room_a' });
  f.pending[2].reject(new Error('late failure')); await third;
  assert.deepEqual(f.errors, []); assert.equal(f.snapshot().view, 'team');
});
test('popstate fences an outstanding target and disposal ignores late work', async t => {
  const f = fixture(t), one = f.nav.navigate(target('one'));
  f.history.go(-1); f.pending[0].resolve(response('one')); await one;
  assert.deepEqual(f.applied, []); assert.equal(f.snapshot().view, 'work');
  const two = f.nav.navigate(target('two')); f.nav.dispose();
  f.pending[1].resolve(response('two')); await two; assert.deepEqual(f.applied, []);
});
test('current errors are visible and invalid URL targets never reach resolver', async t => {
  const f = fixture(t), one = f.nav.navigate(target('one'));
  const missing = new Error('Message unavailable'); f.pending[0].reject(missing); await one;
  assert.deepEqual(f.errors, [missing]);
  const retry = f.nav.navigate(target('one'));
  assert.equal(f.history.entries.length, 2); assert.equal(f.pending.length, 2);
  f.pending[1].resolve(response('one')); await retry;
  assert.deepEqual(f.applied, ['message_one']);
  assert.equal(targetFromURL('https://example.invalid/?messageId=../bad'), undefined);
  assert.equal(targetFromURL('https://example.invalid/?messageId=ok&messageRoot='), undefined);
});
test('initial deep target is resolved using the same controller lifecycle', async () => {
  const history = new HistoryFixture(); history.entries[0].url += '&ignored';
  history.entries[0].url = 'https://studio.example.invalid/?messageId=message_old&messageChannel=room_a&messageRoot=root_a';
  const seen = [];
  const nav = createMessageNavigation({ port: history.port, snapshot: () => ({ view: 'room', channelId: '' }), restore: () => {},
    resolve: async t => { seen.push(t); return response('old'); }, resolved: () => {}, failed: error => { throw error; } });
  await nav.start(); nav.dispose(); assert.deepEqual(seen, [target('old')]);
});

test('React-style deferred render setters do not save the previous room when wiring uses synchronous snapshot ref', async () => {
  const history = new HistoryFixture();
  let rendered = { view: 'work', channelId: 'room_old' };
  const snapshotRef = { current: rendered }, renderCommits = [];
  const stageRender = next => renderCommits.push(() => { rendered = next; });
  const nav = createMessageNavigation({ port: history.port, snapshot: () => snapshotRef.current,
    restore: next => { snapshotRef.current = next; stageRender(next); },
    resolve: async () => response('one'),
    resolved: result => {
      // Same ordering as the standalone Studio patch: ref first, React setter later.
      snapshotRef.current = { ...snapshotRef.current, view: 'room', channelId: result.root.channelId };
      stageRender(snapshotRef.current);
    }, failed: error => { throw error; },
  });
  await nav.navigate(target('one'));
  assert.equal(rendered.channelId, 'room_old', 'Render setters have not committed');
  assert.equal(history.port.state().vibzMessageNavigation.snapshot.channelId, 'room_a');
  renderCommits.forEach(commit => commit());
  assert.equal(rendered.channelId, 'room_a'); nav.dispose();
});

test('new task-modal destination and explicit work-filter transition fence pending message navigation', async t => {
  const f = fixture(t), pending = f.nav.navigate(target('one'));
  f.nav.leave({ ...f.snapshot(), panel: null, taskId: 'task_fixture', connectId: null });
  f.pending[0].resolve(response('one')); await pending;
  assert.deepEqual(f.applied, []); assert.equal(f.snapshot().taskId, 'task_fixture');
  f.nav.leave({ ...f.snapshot(), view: 'work', workFilter: 'room_clicked', taskId: null });
  assert.equal(f.snapshot().workFilter, 'room_clicked');
  assert.equal(f.history.port.state().vibzMessageNavigation.snapshot.workFilter, 'room_clicked');
});

test('older-page completion cannot overwrite pagination after another or same-room navigation', async t => {
  const f = fixture(t);
  let cursor = 'room_b_cursor', pageError = '', loading = true;
  const current = f.nav.checkpoint();
  let release;
  const older = new Promise(resolve => { release = resolve; }).then(page => {
    if (current()) cursor = page.cursor;
  }).catch(error => { if (current()) pageError = error.message; }).finally(() => { if (current()) loading = false; });
  f.nav.leave({ view: 'room', channelId: 'room_b' }); // Same-room reset is a new navigation epoch.
  cursor = 'fresh_page_cursor'; loading = true;
  release({ cursor: 'obsolete_older_cursor' }); await older;
  assert.equal(cursor, 'fresh_page_cursor'); assert.equal(loading, true); assert.equal(pageError, '');
  const other = f.nav.checkpoint(); f.nav.leave({ view: 'room', channelId: 'room_c' });
  assert.equal(other(), false);
});

test('resolving a pending target invalidates a page started in the restored old room', async t => {
  const f = fixture(t), targetWork = f.nav.navigate(target('one'));
  assert.equal(f.snapshot().channelId, 'room_b');
  const oldRoomPage = f.nav.checkpoint(), oldRoomLatestPage = f.nav.checkpoint();
  let pageCursor = 'old_room_cursor';
  f.pending[0].resolve(response('one')); await targetWork;
  assert.equal(f.snapshot().channelId, 'room_a');
  pageCursor = 'new_room_cursor';
  if (oldRoomPage()) pageCursor = 'late_old_room_cursor';
  if (oldRoomLatestPage()) pageCursor = 'late_latest_page_cursor';
  assert.equal(pageCursor, 'new_room_cursor');
});
