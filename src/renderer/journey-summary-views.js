import { entityCatalog } from './entity-catalog.js';
import { placeChoiceLabel } from './place-picker.js';

// Action identities already come from the planner. Personal prose and detached
// itinerary selections must never acquire identities merely by sharing a name.
export function createJourneySummaryViews({ esc, act, index = () => null }) {
  const data = () => (typeof index === 'function' ? index() : index);
  const entity = (id) => {
    const value = data();
    const rows = value && id ? entityCatalog(value).resolve(id) : [];
    return rows.length === 1 ? rows[0] : null;
  };
  function entityLink(id, label) {
    const row = entity(id);
    if (!row) return esc(label || '资料待核对');
    const action =
      row.kind === '任务' ? 'world-quest' : row.kind === '地点' ? 'world-place' : 'database-detail';
    return act(action, esc(label || row.name), 'text-btn entity-inline', id);
  }
  function actionTitle(action, title = action?.title || '') {
    if (!action || ['todo', 'goal', 'review'].includes(action.kind)) return esc(title);
    if (action.kind === 'quest') return entityLink(action.questId, title);
    const spans = [];
    const bind = (id, label = entity(id)?.name, last = false) => {
      if (!entity(id) || !label) return;
      const start = last ? title.lastIndexOf(label) : title.indexOf(label);
      const end = start + label.length;
      if (start < 0 || spans.some((span) => start < span.end && end > span.start)) return;
      spans.push({ start, end, html: entityLink(id, label) });
    };
    let alternatives = '';
    if (action.kind === 'gift') {
      bind(action.gift?.npcId);
      bind(action.gift?.itemId, undefined, true);
    } else if (action.kind === 'craft') {
      const recipe = entity(action.recipeId);
      if (title.startsWith('核对并制作：') && recipe) {
        const outputs = [...new Set((recipe.results || []).map((row) => row.id))];
        if (outputs.length === 1) bind(`item-${outputs[0]}`);
        bind(action.recipeId, '配方', true);
      } else bind(action.recipeId);
    } else if (['collection', 'material'].includes(action.kind)) {
      const ids = [...new Set(action.material?.ids || [])];
      if (ids.length === 1) bind(`item-${ids[0]}`, undefined, true);
      else if (ids.length > 1) {
        const links = ids.filter((id) => entity(`item-${id}`)).map((id) => entityLink(`item-${id}`));
        if (links.length) alternatives = `（可替代：${links.join('、')}）`;
      }
    } else if (action.kind === 'place') {
      const ids = [...new Set((action.places || []).flatMap((place) => place.mapIds || []))];
      if (ids.length === 1) bind(ids[0]);
    }
    let html = '',
      at = 0;
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      html += esc(title.slice(at, span.start)) + span.html;
      at = span.end;
    }
    return html + esc(title.slice(at)) + alternatives;
  }
  function places(action) {
    const seen = new Set();
    return (action?.places || [])
      .flatMap((place) => {
        if (typeof place === 'string') return [esc(place)];
        const ids = [...new Set(place.mapIds || [])];
        const known = ids.map((id) => entity(id)).filter((row) => row?.kind === '地点');
        const key = place.name + ':' + ids.join(',');
        if (seen.has(key)) return [];
        seen.add(key);
        if (known.length !== ids.length || !known.length) return [esc(place.name)];
        return known.flatMap((row) => {
          if (seen.has(row.id)) return [];
          seen.add(row.id);
          return [entityLink(row.id, placeChoiceLabel(row, data()?.world?.maps || []))];
        });
      })
      .join('、');
  }
  const itineraryTitle = (step) =>
    step?.action ? actionTitle(step.action, step.title) : esc(step?.title || '');
  function itineraryPlace(step) {
    const label = step?.placeLabel || step?.selectedPlace?.name || '未分组事项';
    if (!step?.action) return esc(label);
    if (step.placePending) {
      const hints = places(step.action);
      return hints ? `${hints} · 场景待核定` : esc(label);
    }
    const selected = step.selectedPlace;
    const row = entity(selected?.id);
    return row?.kind === '地点' &&
      selected.key === row.key &&
      (step.action.places || []).some((place) => place.mapIds?.includes(selected.id))
      ? entityLink(selected.id, label)
      : esc(label);
  }
  return { actionTitle, itineraryTitle, places, itineraryPlace, entityLink };
}
