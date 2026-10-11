'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const load = () => import('../src/renderer/note-diff.js');
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

test('near-identical long notes identify the changed line and quantity in restore direction', async () => {
  const { noteDifferences, renderNoteDifferences } = await load();
  const old = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 件：铁矿石预留 ${i === 17 ? 2 : 1} 件`).join(
    '\n',
  );
  const current = old.replace('预留 2 件', '预留 8 件');
  const diff = noteDifferences(current, old);
  assert.deepEqual(diff.blocks, [
    {
      currentStart: 18,
      restoredStart: 18,
      currentLines: ['第 18 件：铁矿石预留 8 件'],
      restoredLines: ['第 18 件：铁矿石预留 2 件'],
    },
  ]);
  assert.equal(diff.unchangedLines, 23);
  const html = renderNoteDifferences(current, old, escape);
  assert.match(html, /当前第 18 行/);
  assert.match(html, /恢复后第 18 行/);
  assert.match(html, /<mark>8<\/mark>/);
  assert.match(html, /<mark>2<\/mark>/);
  assert(!html.includes('第 17 件'));
});

test('insertions, deletions and repeated lines keep exact text and independent line numbers', async () => {
  const { noteDifferences } = await load();
  assert.deepEqual(noteDifferences('甲\n同\n乙\n同\n丙', '甲\n同\n新增\n乙\n同').blocks, [
    { currentStart: 3, restoredStart: 3, currentLines: [], restoredLines: ['新增'] },
    { currentStart: 5, restoredStart: 6, currentLines: ['丙'], restoredLines: [] },
  ]);
  for (const [current, restored] of [
    ['', '\n  '],
    ['\n', ''],
    ['a\r\nb\n', 'a\nb\n'],
    ['一\n\n二', '一\n二'],
    ['😀 甲', '😁 甲'],
  ]) {
    const diff = noteDifferences(current, restored);
    const lines = current === '' ? [] : current.split('\n');
    for (const block of [...diff.blocks].reverse())
      lines.splice(block.currentStart - 1, block.currentLines.length, ...block.restoredLines);
    assert.equal(lines.join('\n'), restored);
  }
});

test('preview escapes literal markup, retains whitespace and uses complete Unicode characters', async () => {
  const { renderNoteDifferences } = await load();
  const html = renderNoteDifferences('😀 <img src=x>  ', '😁 <script>literal</script> ', escape);
  assert(!html.includes('<img') && !html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert(html.includes('😀') && html.includes('😁'));
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(html));
  assert.match(renderNoteDifferences('same\n', 'same\n', escape), /与当前随手记相同/);
});

test('maximum line count uses a bounded comparison and retains every changed line', async () => {
  const { noteDifferences } = await load();
  const current = 'a\n'.repeat(10000),
    restored = 'b\n'.repeat(10000);
  const diff = noteDifferences(current, restored);
  assert.equal(diff.groupedRange, true);
  assert.equal(diff.blocks.length, 1);
  assert.equal(diff.blocks[0].currentLines.join('\n') + '\n', current);
  assert.equal(diff.blocks[0].restoredLines.join('\n') + '\n', restored);
  assert.equal(diff.unchangedLines, 1);
});
