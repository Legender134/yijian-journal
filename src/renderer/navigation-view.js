export function navigationView({ route, headings, icon, goalCount = 0 }) {
  const primary = [
    ['home', 'pin'],
    ['duels', 'duel'],
    ['database', 'book'],
    ['saves', 'archive'],
  ];
  const additional = [
    ['checklist', 'scroll'],
    ['world', 'map'],
    ['materials', 'bag'],
    ['library', 'feather'],
    ['journey', 'map'],
    ['goals', 'star'],
    ['journal', 'edit'],
  ];
  const button = ([id, glyph]) =>
    `<button class="nav-btn ${route === id ? 'active' : ''}"${route === id ? ' aria-current="page"' : ''} data-action="navigate" data-id="${id}">${icon(glyph)}${headings[id]}${id === 'goals' && goalCount ? `<span class="nav-count">${goalCount}</span>` : ''}</button>`;
  return (
    primary.map(button).join('') +
    `<details class="nav-more" data-persist-detail="main-additional-pages"${additional.some(([id]) => id === route) ? ' open' : ''}><summary>更多</summary>${additional.map(button).join('')}</details><div class="nav-settings">${button(['settings', 'settings'])}</div>`
  );
}
