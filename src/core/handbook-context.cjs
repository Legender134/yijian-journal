'use strict';
const { validBackupId } = require('./backup-anomalies.cjs');
const presentationLimit = 512;

// This message only selects an existing read-only view. It carries no paths,
// commands, save contents or mutations between the two sandboxed renderers.
const routes = new Set([
  'home',
  'checklist',
  'duels',
  'library',
  'database',
  'world',
  'materials',
  'journey',
  'goals',
  'journal',
  'saves',
  'settings',
  'recipe-discovery',
]);
function handbookContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('手札阅读位置无效');
  const text = (field, max = 200) => (typeof field === 'string' && field.length <= max ? field : '');
  const page = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0);
  const result = {
    route: routes.has(value.route) ? value.route : 'home',
    profileId: text(value.profileId, 100),
    query: text(value.query),
  };
  if (!result.profileId) throw Error('手札周目无效');
  if (value.reference && typeof value.reference === 'object') {
    const { name, hash, follow } = value.reference;
    if (name && !/^\d{1,12}\.sav$/i.test(name)) throw Error('参照存档名无效');
    if (hash && !/^[a-f0-9]{64}$/i.test(hash)) throw Error('参照存档标识无效');
    result.reference = { name: name || '', hash: hash || '', follow: follow === true };
  }
  const detail = value.detail;
  if (detail) {
    const patterns = {
      database: /^(item|npc|skill|alchemy|cooking|fusion)-\d+$/,
      'world-quest': /^quest-\d+$/,
      'world-place': /^place-\d+(?::[A-Za-z0-9_]{1,70})?$/,
      guide: /^[a-z0-9-]+$/,
      search: /^$/,
      timeline: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
      save: /^\d{1,12}\.sav$/i,
      comparison: /^$/,
      'entity-choice':
        /^(?:name:[^/\\\u0000-\u001f]{1,90}|place-\d+|map-point:\d{1,4}(?:\.\d{1,2})?:\d{1,4}(?:\.\d{1,2})?)$/,
    };
    const valid =
      detail.type === 'backup'
        ? validBackupId(detail.id)
        : Object.hasOwn(patterns, detail.type) && patterns[detail.type].test(text(detail.id, 100));
    if (!valid) throw Error('手札资料位置无效');
    result.detail = {
      type: detail.type,
      id: text(detail.id, 100),
      query: text(detail.query),
      quantity:
        Number.isSafeInteger(detail.quantity) && detail.quantity > 0 && detail.quantity <= 999
          ? detail.quantity
          : 1,
    };
    if (detail.type === 'save' && detail.hash) {
      if (!/^[a-f0-9]{64}$/i.test(detail.hash)) throw Error('存档标识无效');
      result.detail.hash = detail.hash;
    }
    if (detail.type === 'guide') result.detail.revealed = detail.revealed === true;
    if (detail.type === 'search') {
      result.detail.personalAll = detail.personalAll === true;
      result.detail.showSaved = detail.showSaved === true;
    }
    if (detail.type === 'database') result.detail.giftPage = page(detail.giftPage);
    if (detail.type === 'world-place')
      result.detail.mapScope = detail.mapScope === 'world' ? 'world' : 'region';
    if (detail.type === 'entity-choice') result.detail.flowBound = detail.flowBound === true;
    if (detail.type === 'comparison') {
      for (const key of ['left', 'right']) {
        if (typeof detail[key] !== 'string' || !/^\d{1,12}\.sav$/i.test(detail[key]))
          throw Error('对比存档名无效');
        result.detail[key] = detail[key];
      }
      result.detail.questQuery = text(detail.questQuery);
      result.detail.filter = ['all', 'more', 'less'].includes(detail.filter) ? detail.filter : 'all';
    }
  }
  for (const key of ['databaseKind', 'databaseType', 'worldKind', 'worldQuery'])
    if (typeof value[key] === 'string') result[key] = text(value[key]);
  result.databasePage = page(value.databasePage);
  result.worldPage = page(value.worldPage);
  result.worldStatus = ['all', 'active', 'completed', 'recorded', 'unrecorded'].includes(value.worldStatus)
    ? value.worldStatus
    : 'all';
  result.worldRoots = value.worldRoots !== false;
  for (const key of ['presentation', 'pagePresentation']) {
    const presentation = value[key];
    if (!presentation || typeof presentation !== 'object') continue;
    const position = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(1000000, value)) : 0);
    result[key] = {
      scroll: position(presentation.scroll),
      details: Array.isArray(presentation.details)
        ? presentation.details.slice(0, presentationLimit).map((row) => ({
            summary: text(row?.summary, 1000),
            key: text(row?.key, 200),
            ...(Number.isSafeInteger(row?.occurrence) &&
            row.occurrence >= 0 &&
            row.occurrence < presentationLimit
              ? { occurrence: row.occurrence }
              : {}),
            open: row?.open === true,
          }))
        : [],
    };
    const anchor = presentation.anchor;
    if (
      anchor &&
      typeof anchor.label === 'string' &&
      Number.isSafeInteger(anchor.occurrence) &&
      anchor.occurrence >= 0 &&
      anchor.occurrence < presentationLimit &&
      Number.isFinite(anchor.offset) &&
      Math.abs(anchor.offset) <= 1000000
    )
      result[key].anchor = {
        label: text(anchor.label),
        occurrence: anchor.occurrence,
        offset: anchor.offset,
        ...(['data-duel', 'data-flow-quest', 'data-flow-rule', 'data-flow-decision'].includes(
          anchor.sectionKey,
        )
          ? { sectionKey: anchor.sectionKey, sectionId: text(anchor.sectionId) }
          : {}),
      };
  }
  if (Array.isArray(value.history))
    result.history = value.history
      .slice(-30)
      .map((row) =>
        handbookContext({
          profileId: result.profileId,
          detail: row?.detail,
          reference: row?.reference,
          presentation: row?.presentation,
        }),
      )
      .filter((row) => row.detail);
  return result;
}
module.exports = { handbookContext };
