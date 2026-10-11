'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/task-mentions.js'), 'utf8');
const loaded = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const { encyclopedia } = require('../src/core/game-data.cjs');
test('literal task mentions open known people and places while retaining ambiguous location choices', async () => {
  const { taskMentions } = await loaded,
    index = encyclopedia();
  const task = index.world.quests.find((q) => q.id === 'quest-5201');
  const result = taskMentions(index, task);
  assert(result.people.some((p) => p.id === 'npc-5003'));
  assert(result.people.some((p) => p.id === 'npc-10101'));
  assert(result.places.some((p) => p.name === '洛村'));
  assert(result.aliases.some((p) => p.mention === '武当山' && p.choices.length > 1));
  const root = taskMentions(
    index,
    index.world.quests.find((q) => q.id === 'quest-5200'),
  );
  assert(root.aliases.some((p) => p.mention === '武当' && p.name === '武当派' && p.choices.length > 1));
  assert.equal(
    result.people.some((p) => p.currentLocation),
    false,
  );
  const unknown = taskMentions(index, { description: '尚未证实的新地区与人物' });
  assert.equal(unknown.people.length, 0);
  assert.equal(unknown.places.length, 0);
});

test('a task naming the back mountain cave does not link its nested name to a foreign cave', async () => {
  const { taskMentions } = await loaded,
    index = encyclopedia();
  const result = taskMentions(
    index,
    index.world.quests.find((q) => q.id === 'quest-11010'),
  );
  const cave = result.places.find((p) => p.name === '后山山洞');
  assert.deepEqual(new Set(cave.choices.map((p) => p.id)), new Set(['place-11', 'place-12']));
  assert.equal(
    result.places.some((p) => p.name === '山洞'),
    false,
  );
});

test('place mentions retain separate short occurrences, repeated long names and curated aliases', async () => {
  const { taskMentions } = await loaded,
    index = encyclopedia();
  for (const [description, expected] of [
    ['后山山洞，再到后山山洞。', ['后山山洞']],
    ['后山山洞，然后到山洞。', ['后山山洞', '山洞']],
    ['山洞，然后到后山山洞。', ['后山山洞', '山洞']],
    ['山洞。', ['山洞']],
  ]) {
    const result = taskMentions(index, { description });
    assert.deepEqual(result.places.map((p) => p.name).sort(), expected.sort(), description);
  }
  const aliased = taskMentions(index, { description: '到武当山，再去后山山洞。' });
  assert.deepEqual(
    aliased.places.map((p) => p.name),
    ['后山山洞'],
  );
  assert.equal(aliased.aliases.find((p) => p.name === '武当派').mention, '武当山');
});
