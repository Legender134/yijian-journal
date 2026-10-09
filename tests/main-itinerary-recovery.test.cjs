'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const start = source.indexOf("    handle('mutate', (_event, command) => {"),
  end = source.indexOf("    handle('refresh',", start);
assert(start >= 0 && end > start);
function setup() {
  const writes = [],
    events = [],
    state = {
      activeProfileId: 'current-profile',
      profiles: [{ id: 'current-profile' }, { id: 'old-profile' }],
      settings: { autoBackup: false },
    };
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    handle: (name, callback) => {
      assert.equal(name, 'mutate');
      handler = callback;
    },
    store: {
      get: () => structuredClone(state),
      mutate: (command) => {
        writes.push(JSON.parse(JSON.stringify(command)));
        return structuredClone(state);
      },
    },
    broadcast: (...args) => events.push(args),
    companion: null,
    autoBackup: null,
  });
  return { handler, writes, events };
}
const commands = [
  {
    type: 'journey-itinerary-remove',
    id: 'journey:todo:' + 'a'.repeat(32),
    expectedItinerary: { name: '完整预览', status: 'draft', steps: [] },
  },
  { type: 'journey-itinerary-clear', expectedItinerary: { name: '完整预览', status: 'draft', steps: [] } },
  {
    type: 'journey-trash-restore',
    id: 'chosen',
    expectedTrash: { kind: 'itinerary' },
    expectedItinerary: null,
  },
  { type: 'journal-revision-restore', id: 'chosen', expectedRevision: {} },
  { type: 'journal-revision-purge', id: 'chosen', expectedRevision: {} },
];
for (const command of commands) {
  test(`${command.type}: Main requires the explicit current profile before any persistence or event`, () => {
    const { handler, writes, events } = setup();
    for (const profileId of [undefined, '', null, 'old-profile', 'missing-profile'])
      assert.throws(
        () => handler({}, { ...command, ...(profileId === undefined ? {} : { profileId }) }),
        /周目已变化/,
      );
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
    const complete = { ...command, profileId: 'current-profile' };
    handler({}, complete);
    assert.deepEqual(writes, [complete]);
    assert.equal(events.length, 1);
  });
}
test('Main rejects actionIds on the new itinerary/trash recovery commands instead of silently stripping authority', () => {
  for (const command of commands.filter((row) => row.type.startsWith('journey-'))) {
    const { handler, writes, events } = setup();
    assert.throws(() => handler({}, { ...command, profileId: 'current-profile', actionIds: [] }), /未知字段/);
    assert.deepEqual(writes, []);
    assert.deepEqual(events, []);
  }
});
