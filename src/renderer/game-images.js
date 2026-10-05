// Decorative images retain adjacent text as the accessible name.
export function createGameImages({ index, icon, esc }) {
  const glyph = (id) =>
    id.startsWith('npc-')
      ? 'person'
      : id.startsWith('skill-')
        ? 'sword'
        : /^(fusion|alchemy|cooking)-/.test(id)
          ? 'scroll'
          : 'bag';
  function picture(id, size = 'tiny') {
    const data = index();
    const file = data?.images?.[id];
    const safe = typeof file === 'string' && /^[a-f0-9]{20}\.png$/.test(file);
    const entry = data?.entries.find((e) => e.id === id);
    const person = id.startsWith('npc-');
    return `<span class="game-picture game-picture-${size}${person ? ' game-picture-person' : ''}${safe ? '' : ' image-unavailable'}" data-quality="${esc(entry?.quality || '')}" aria-hidden="true">${safe ? `<img class="game-image" src="../assets/game/${file}" alt="" width="68" height="68" loading="lazy" decoding="async">` : ''}<span class="image-fallback">${icon(glyph(id))}</span></span>`;
  }
  function person(name, size = 'card') {
    const entries = index()?.entries.filter((e) => e.kind === '人物' && e.name === name) || [];
    const files = new Set(entries.map((e) => index().images?.[e.id]).filter(Boolean));
    // Same names at different stages can use different artwork; don't guess.
    return files.size === 1 ? picture(entries.find((e) => index().images?.[e.id]).id, size) : '';
  }
  return { picture, person };
}
