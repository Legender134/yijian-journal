export function noteDifferences(current, restored) {
  const before = current === '' ? [] : current.split('\n');
  const after = restored === '' ? [] : restored.split('\n');
  let start = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const blocks = [];
  let unchangedLines = start + before.length - endBefore;
  const rows = endBefore - start,
    columns = endAfter - start;
  // Bound both memory and work for the 20,000-character note, including mostly empty lines.
  const groupedRange = rows * columns > 250000;
  if (groupedRange) {
    blocks.push({
      currentStart: start + 1,
      restoredStart: start + 1,
      currentLines: before.slice(start, endBefore),
      restoredLines: after.slice(start, endAfter),
    });
  } else {
    const width = columns + 1;
    const lengths = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = columns - 1; j >= 0; j--) {
        lengths[i * width + j] =
          before[start + i] === after[start + j]
            ? 1 + lengths[(i + 1) * width + j + 1]
            : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      }
    let i = 0,
      j = 0,
      block = null;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && before[start + i] === after[start + j]) {
        unchangedLines++;
        i++;
        j++;
        block = null;
      } else {
        if (!block) {
          block = {
            currentStart: start + i + 1,
            restoredStart: start + j + 1,
            currentLines: [],
            restoredLines: [],
          };
          blocks.push(block);
        }
        if (j === columns || (i < rows && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]))
          block.currentLines.push(before[start + i++]);
        else block.restoredLines.push(after[start + j++]);
      }
    }
  }
  return { blocks, unchangedLines, groupedRange };
}

function highlightPair(before, after, esc) {
  const a = [...before],
    b = [...after];
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  return [a, b].map((line) => {
    const end = line.length - suffix;
    return (
      esc(line.slice(0, prefix).join('')) +
      '<mark>' +
      esc(line.slice(prefix, end).join('')) +
      '</mark>' +
      esc(line.slice(end).join(''))
    );
  });
}

export function renderNoteDifferences(current, restored, esc) {
  const diff = noteDifferences(current, restored);
  if (!diff.blocks.length)
    return '<section data-note-differences><h3>恢复前后变化</h3><p>这份旧内容与当前随手记相同。</p></section>';
  const range = (start, lines) => (lines.length > 1 ? `${start}–${start + lines.length - 1}` : String(start));
  const rows = diff.blocks
    .map((block) => {
      const paired =
        block.currentLines.length === 1 && block.restoredLines.length === 1
          ? highlightPair(block.currentLines[0], block.restoredLines[0], esc)
          : null;
      return (
        '<div class="note-diff-block">' +
        [
          ['当前', block.currentStart, block.currentLines, 'current', paired?.[0]],
          ['恢复后', block.restoredStart, block.restoredLines, 'restored', paired?.[1]],
        ]
          .map(
            ([label, start, lines, kind, highlighted]) =>
              `<div class="note-diff-${kind}"><strong>${label}${lines.length ? `第 ${range(start, lines)} 行` : '无对应内容'}</strong>${lines.length ? `<pre>${highlighted ?? '<mark>' + esc(lines.join('\n')) + '</mark>'}</pre>` : '<p class="save-note">（无内容）</p>'}</div>`,
          )
          .join('') +
        '</div>'
      );
    })
    .join('');
  return `<section data-note-differences><h3>恢复前后变化 · ${diff.blocks.length} 处</h3><p class="save-note">上方为当前文字，下方为恢复后的文字；高亮标出变化。${diff.unchangedLines ? `省略 ${diff.unchangedLines} 行相同内容。` : ''}${diff.groupedRange ? '变化范围较大，已合并展示完整变化区间。' : ''}下方仍可核对两版完整文字。</p>${rows}</section>`;
}
