// BP_JHTextureManager.SpellQualityColor, installed game Build 21798996.
// Unreal's linear color values are converted to sRGB for browser display.
export const qualityColors = Object.freeze({
  白: '#ffffff',
  绿: '#85e46a',
  蓝: '#6da6d8',
  金: '#ffed00',
  暗金: '#dc9a00',
  红: '#ef5a5a',
});
export function createQualityText({ index, esc }) {
  const quality = (id) => {
    const e = typeof id === 'object' ? id : index()?.entries.find((entry) => entry.id === id);
    if (e?.quality) return e.quality;
    if (e?.kind !== '配方') return '';
    const outputs = new Set(
      (e.results || [])
        .map((r) => index()?.entries.find((item) => item.id === `item-${r.id}`)?.quality)
        .filter(Boolean),
    );
    return outputs.size === 1 ? [...outputs][0] : '';
  };
  const wrap = (html, q, extra = '') =>
    qualityColors[q] ? `<span class="quality-text ${extra}" data-quality="${q}">${html}</span>` : html;
  return {
    quality,
    name: (id, name) => wrap(esc(name), quality(id)),
    html: (id, html) => wrap(html, quality(id)),
    label: (id) => {
      const q = quality(id);
      return qualityColors[q] ? wrap(esc(`${q}色品质`), q, 'quality-label') : '';
    },
  };
}
