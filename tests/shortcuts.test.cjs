'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Shortcuts, validate } = require('../src/core/shortcuts.cjs');
function setup() {
  const registered = new Map(),
    taken = new Set(['Control+Alt+X']);
  const registry = {
    register(key, fn) {
      if (taken.has(key) || registered.has(key)) return false;
      registered.set(key, fn);
      return true;
    },
    unregister(key) {
      assert.ok(key, 'Only registered nonempty accelerators may be removed');
      registered.delete(key);
    },
  };
  const manager = new Shortcuts(registry, { save: () => {}, history: () => {} });
  manager.start();
  return { manager, registered };
}
test('shortcut validation requires modifiers and rejects duplicates and the companion key', () => {
  assert.deepEqual(validate({ save: 'Ctrl+Alt+s', history: 'Alt+Control+Shift+f12' }), {
    save: 'Control+Alt+S',
    history: 'Control+Alt+Shift+F12',
  });
  for (const value of [
    { save: 'S', history: '' },
    { save: 'Ctrl+Alt+J', history: '' },
    { save: 'Ctrl+Alt+H', history: 'Control+Alt+H' },
    { save: 'Ctrl+Alt+F13', history: '' },
  ])
    assert.throws(() => validate(value));
});
test('conflicting replacement or failed persistence rolls back new keys and preserves working keys', () => {
  const { manager, registered } = setup();
  let persisted = false;
  assert.throws(
    () =>
      manager.configure({ save: 'Ctrl+Alt+Q', history: 'Ctrl+Alt+X' }, () => {
        persisted = true;
      }),
    /占用/,
  );
  assert.equal(persisted, false);
  assert.deepEqual([...registered.keys()].sort(), ['Control+Alt+H', 'Control+Alt+S']);
  assert.throws(
    () =>
      manager.configure({ save: 'Ctrl+Alt+Q', history: '' }, () => {
        throw Error('disk full');
      }),
    /disk full/,
  );
  assert.deepEqual([...registered.keys()].sort(), ['Control+Alt+H', 'Control+Alt+S']);
  manager.configure({ save: 'Ctrl+Alt+Q', history: '' }, () => {});
  assert.deepEqual([...registered.keys()], ['Control+Alt+Q']);
});
test('an occupied key is visible on startup and can be retried', () => {
  const { manager } = setup();
  const disabled = new Shortcuts(manager.registry, manager.callbacks);
  disabled.start({ save: 'Control+Alt+X', history: '' });
  assert.match(disabled.summary().errors.save, /占用/);
});
test('a disabled shortcut can be re-enabled without unregistering an empty accelerator', () => {
  const { manager, registered } = setup();
  manager.configure({ save: 'Ctrl+Alt+Q', history: '' }, () => {});
  manager.configure({ save: 'Ctrl+Alt+Q', history: 'Ctrl+Alt+R' }, () => {});
  assert.deepEqual([...registered.keys()].sort(), ['Control+Alt+Q', 'Control+Alt+R']);
});
