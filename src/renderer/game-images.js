// Decorative images retain adjacent text as the accessible name.
const safeImage = (file) => typeof file === 'string' && /^[a-f0-9]{20}\.png$/.test(file);

// A group can share a known portrait without merging its entity identities.
// Missing exports are not a second portrait; differing actual images remain ambiguous.
export function sharedEntityArtwork(data, choices) {
  const pictured = choices.filter((entry) => safeImage(data?.images?.[entry.id]));
  const files = new Set(pictured.map((entry) => data.images[entry.id]));
  return files.size === 1 ? pictured[0]?.id || null : null;
}

export function createGameImages({ index, icon, esc }) {
  const glyph = (id) =>
    id.startsWith('npc-')
      ? 'person'
      : id.startsWith('quest-')
        ? 'scroll'
        : id.startsWith('place-')
          ? 'pin'
          : id.startsWith('skill-')
            ? 'sword'
            : /^(fusion|alchemy|cooking)-/.test(id)
              ? 'scroll'
              : 'bag';
  function picture(id, size = 'tiny') {
    const data = index();
    const file = data?.images?.[id];
    const safe = safeImage(file);
    const entry = data?.entries.find((e) => e.id === id);
    const person = id.startsWith('npc-');
    return `<span class="game-picture game-picture-${size}${person ? ' game-picture-person' : ''}${safe ? '' : ' image-unavailable'}" data-quality="${esc(entry?.quality || '')}" aria-hidden="true">${safe ? `<img class="game-image" src="../assets/game/${file}" alt="" width="68" height="68" loading="lazy" decoding="async">` : ''}<span class="image-fallback">${icon(glyph(id))}</span></span>`;
  }
  function person(name, size = 'card') {
    const entries = index()?.entries.filter((e) => e.kind === '人物' && e.name === name) || [];
    const id = sharedEntityArtwork(index(), entries);
    // Same names at different stages can use different artwork; don't guess.
    return id ? picture(id, size) : '';
  }
  return { picture, person };
}
