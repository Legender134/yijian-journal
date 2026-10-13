export function navigationView({ route, headings, icon, goalCount = 0 }) {
  const groups = [
    [
      '当前流程',
      [
        ['home', 'home'],
        ['checklist', 'scroll'],
        ['duels', 'duel'],
      ],
    ],
    [
      '资料图鉴',
      [
        ['database', 'book'],
        ['world', 'map'],
        ['library', 'feather'],
      ],
    ],
    ['收集备料', [['materials', 'bag']]],
    [
      '我的记录',
      [
        ['journey', 'map'],
        ['goals', 'star'],
        ['journal', 'edit'],
      ],
    ],
    ['存档管理', [['saves', 'archive']]],
  ];
  const button = ([id, glyph]) =>
    `<button class="nav-btn ${route === id ? 'active' : ''}"${route === id ? ' aria-current="page"' : ''} data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}${id === 'goals' && goalCount ? `<span class="nav-count">${goalCount}</span>` : ''}</button>`;
  return (
    groups
      .map(([label, rows]) => `<div class="nav-section">${label}</div>${rows.map(button).join('')}`)
      .join('') + `<div class="nav-settings">${button(['settings', 'settings'])}</div>`
  );
}
