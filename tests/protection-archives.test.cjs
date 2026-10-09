'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { ProtectionArchives } = require('../src/core/protection-archives.cjs');
test('all imported archive summaries remain discoverable beyond two hundred; cached counts never claim verification', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-archive-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archives = new ProtectionArchives(root, () => '');
  const ids = [];
  for (let i = 0; i < 205; i++) {
    const id = crypto.randomUUID(),
      dir = path.join(archives.root(), id);
    ids.push(id);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'archive-summary.json'),
      JSON.stringify({
        label: '历史 ' + i,
        createdAt: new Date(1700000000000 + i * 1000).toISOString(),
        profiles: 1,
        backups: 1,
        nodes: 1,
      }),
    );
  }
  const broken = crypto.randomUUID();
  fs.mkdirSync(path.join(archives.root(), broken));
  const list = archives.list();
  assert.equal(list.length, 206);
  assert.equal(new Set(list.map((a) => a.id)).size, 206);
  assert(ids.every((id) => list.some((a) => a.id === id)));
  assert(list.every((a) => a.verified === false));
  assert.equal(list[0].label, '历史 204');
  assert.match(list.find((a) => a.id === broken).label, /需核对/);
});
