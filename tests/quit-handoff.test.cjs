'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { QuitHandoff } = require('../src/core/quit-handoff.cjs');
function window(id, onRequest = () => {}) {
  const contents = new EventEmitter();
  contents.id = id;
  contents.isDestroyed = () => false;
  const messages = [];
  contents.send = (channel, value) => {
    messages.push({ channel, value });
    if (!value.cancelled) onRequest(value);
  };
  return { webContents: contents, isDestroyed: () => false, messages };
}
test('exit waits for every independent renderer acknowledgement', async () => {
  const handoff = new QuitHandoff();
  const a = window(1),
    b = window(2);
  let completed = false;
  const prepared = handoff.prepare([a, b]).then((result) => {
    completed = true;
    return result;
  });
  handoff.acknowledge(1, { token: a.messages[0].value.token, ready: true });
  await Promise.resolve();
  assert.equal(completed, false);
  handoff.acknowledge(2, { token: b.messages[0].value.token, ready: true });
  assert.equal(await prepared, true);
});
test('failed draft cancels exit, and a fresh explicit retry can succeed', async () => {
  const handoff = new QuitHandoff();
  const a = window(1);
  const failed = handoff.prepare([a]);
  handoff.acknowledge(1, { token: a.messages[0].value.token, ready: false });
  assert.equal(await failed, false);
  handoff.cancel();
  assert.equal(a.messages.at(-1).value.cancelled, true);
  const retry = handoff.prepare([a]);
  handoff.acknowledge(1, { token: a.messages.at(-1).value.token, ready: true });
  assert.equal(await retry, true);
});
test('an unrelated renderer, obsolete token, or nonboolean reply cannot authorize exit', async () => {
  const handoff = new QuitHandoff();
  const a = window(1);
  const prepared = handoff.prepare([a]);
  const token = a.messages.at(-1).value.token;
  for (const [sender, value] of [
    [2, { token, ready: true }],
    [1, { token: 'old', ready: true }],
    [1, { token, ready: 'true' }],
  ])
    assert.throws(() => handoff.acknowledge(sender, value), /来源无效/);
  handoff.acknowledge(1, { token, ready: true });
  assert.equal(await prepared, true);
  assert.throws(() => handoff.acknowledge(1, { token, ready: true }), /过期/);
});
test('an unresponsive renderer keeps the application running and releases its request', async () => {
  const handoff = new QuitHandoff({ timeoutMs: 15 });
  const a = window(1);
  await assert.rejects(handoff.prepare([a]), /手札保持运行/);
  assert.equal(handoff.pending.size, 0);
  assert.equal(a.webContents.listenerCount('destroyed'), 0);
  handoff.cancel();
  assert.equal(a.messages.at(-1).value.cancelled, true);
});
test('a gone renderer or a cancelled attempt does not grant exit', async () => {
  const handoff = new QuitHandoff();
  const a = window(1);
  const prepared = handoff.prepare([a]);
  a.webContents.emit('destroyed');
  assert.equal(await prepared, false);
  const retry = handoff.prepare([a]);
  handoff.cancel();
  assert.equal(await retry, false);
  assert.equal(handoff.pending.size, 0);
});
test('send failure rejects without leaking a pending timer or listener', async () => {
  const handoff = new QuitHandoff();
  const a = window(1);
  a.webContents.send = () => {
    throw Error('synthetic renderer failure');
  };
  await assert.rejects(handoff.prepare([a]), /synthetic renderer failure/);
  assert.equal(handoff.pending.size, 0);
  assert.equal(a.webContents.listenerCount('destroyed'), 0);
  handoff.cancel();
});
