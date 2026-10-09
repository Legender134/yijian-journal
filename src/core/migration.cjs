'use strict';

// Historical archives deliberately have no dependency on Store, Saves, Timeline or the bridge.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const {
  validBackupId,
  backupDirectories,
  backupDirectory,
  parseBackupManifest,
  backupMetadataError,
} = require('./backup-anomalies.cjs');
const { validateEntries, validateDrafts } = require('./event-journal.cjs');
const { validateTrash } = require('./event-journal-trash.cjs');
const { validateRevisions } = require('./journal-revisions.cjs');
const { validateIntentDrafts } = require('./intent-drafts.cjs');
const { validateJourneyTrash } = require('./journey-trash.cjs');
const { validateNoteRevisions } = require('./note-revisions.cjs');
const catalog = require('../data/catalog.cjs');
const game = require('../data/game-index.json'),
  world = require('../data/world-index.json');
const portableLinkIds = {
  database: new Set([...game.entries, ...world.people].map((e) => e.id)),
  quest: new Set(world.quests.map((q) => q.id)),
  place: new Set(world.maps.map((p) => p.id)),
  guide: new Set(catalog.entries.map((e) => e.id)),
};
const MAGIC = Buffer.from('YIJIANPKG00000001');
const CHUNK = 64 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  manifestBytes: 8 * 1024 * 1024,
  journalBytes: 32 * 1024 * 1024,
  metadataBytes: 32 * 1024 * 1024,
  backupManifestBytes: 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  backupBytes: 256 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  entries: 20000,
  backups: 1000,
  nodes: 100000,
});
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashOK = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const idOK = (s) => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const backupIdOK = validBackupId;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const textOK = (v, max) => typeof v === 'string' && v.length <= max;
const dateOK = (v) => textOK(v, 80) && Number.isFinite(Date.parse(v));
function fail(message, code) {
  throw Object.assign(Error(message), code ? { code } : {});
}
function checked(ok, message, code) {
  if (!ok) fail(message, code);
}
function keys(value, allowed) {
  checked(
    object(value) && Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown archive fields',
  );
}
function limitsOf(overrides = {}) {
  keys(overrides, Object.keys(DEFAULT_LIMITS));
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits))
    checked(integer(value, DEFAULT_LIMITS[key]) && value > 0, 'Limits may only be lowered');
  return limits;
}
function nameOK(name) {
  return (
    textOK(name, 255) &&
    name.length > 0 &&
    name.normalize('NFC') === name &&
    !/[\\/<>:"|?*\x00-\x1f\x7f]/.test(name) &&
    !/[. ]$/.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
function logicalPathOK(value) {
  if (!textOK(value, 600)) return false;
  const parts = value.split('/');
  if (!parts.every(nameOK)) return false;
  if (value === 'originals/journal.json' || value === 'originals/game-timeline/timeline.json') return true;
  if (
    parts.length === 4 &&
    parts[0] === 'originals' &&
    parts[1] === 'save-backups' &&
    backupIdOK(parts[2]) &&
    parts[3] === 'manifest.json'
  )
    return true;
  if (parts.length === 4 && parts[0] === 'save-backups' && backupIdOK(parts[1]) && parts[2] === 'files')
    return true;
  return (
    parts.length === 3 &&
    parts[0] === 'game-timeline' &&
    parts[1] === 'blobs' &&
    /^[a-f0-9]{64}\.sav$/.test(parts[2])
  );
}
function noGameDirectory(value) {
  checked(typeof value === 'string' && value.length > 0, 'Directory is required');
  const resolved = path.resolve(value);
  checked(
    !resolved.split(/[\\/]/).some((part) => /^savegames$/i.test(part)),
    'SaveGames is never a migration target',
  );
  return resolved;
}
async function realDirectory(value) {
  const resolved = noGameDirectory(value);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current);
    checked(stat.isDirectory() && !stat.isSymbolicLink(), 'Directory links are not supported');
  }
  return fsp.realpath(resolved);
}
function stamp(stat) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => stat[key].toString()).join(':');
}
async function openStable(file, maxBytes) {
  await realDirectory(path.dirname(file));
  const before = await fsp.lstat(file, { bigint: true });
  checked(
    before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes),
    'File type or size is invalid',
  );
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    checked(stamp(await handle.stat({ bigint: true })) === stamp(before), 'File changed while opening');
    return { handle, file, before, size: Number(before.size) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function assertStable(opened) {
  checked(
    stamp(await opened.handle.stat({ bigint: true })) === stamp(opened.before) &&
      stamp(await fsp.lstat(opened.file, { bigint: true })) === stamp(opened.before),
    'Source changed during migration',
  );
  await realDirectory(path.dirname(opened.file));
}
async function exactRead(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    checked(result.bytesRead > 0, 'Truncated protection package', 'PROTECTION_PACKAGE_TRUNCATED');
    offset += result.bytesRead;
  }
  return bytes;
}
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    checked(result.bytesWritten > 0, 'Unable to write protection package');
    offset += result.bytesWritten;
  }
}
async function visitBytes(opened, size, visit, offset = 0) {
  for (let consumed = 0; consumed < size; ) {
    const bytes = await exactRead(opened.handle, Math.min(CHUNK, size - consumed), offset + consumed);
    await visit(bytes);
    consumed += bytes.length;
  }
}
async function stableBytes(file, maxBytes) {
  const opened = await openStable(file, maxBytes);
  try {
    const bytes = await exactRead(opened.handle, opened.size, 0);
    await assertStable(opened);
    return bytes;
  } finally {
    await opened.handle.close();
  }
}
function parseJSON(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    fail('Invalid UTF-8 JSON metadata', 'PROTECTION_METADATA_INVALID');
  }
}
function portableCraftList(list) {
  checked(Array.isArray(list) && list.length <= 40, 'Invalid craft list');
  const seen = new Set();
  return list.map((line) => {
    keys(line, ['id', 'quantity']);
    checked(
      textOK(line.id, 200) && !seen.has(line.id) && integer(line.quantity, 999) && line.quantity > 0,
      'Invalid craft line',
    );
    seen.add(line.id);
    return { ...line };
  });
}
function portableChoices(value) {
  checked(object(value) && Object.keys(value).length <= 100, 'Invalid processing choices');
  const output = {};
  for (const [id, recipe] of Object.entries(value)) {
    checked(/^\d{1,9}$/.test(id) && textOK(recipe, 200), 'Invalid processing choice');
    output[id] = recipe;
  }
  return output;
}
function portableJourney(value) {
  keys(value, ['schema', 'places', 'todos', 'gifts', 'handledActionIds', 'itinerary']);
  checked(value.schema === 1, 'Invalid journey version');
  const maxima = { places: 244, todos: 300, gifts: 100, handledActionIds: 2000 };
  for (const [name, limit] of Object.entries(maxima))
    checked(Array.isArray(value[name]) && value[name].length <= limit, 'Invalid journey list');
  const id = (v) => textOK(v, 80) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v);
  const place = (v) => /^place-\d{1,9}$/.test(v);
  const result = { schema: 1, places: [], todos: [], gifts: [], handledActionIds: [] };
  for (const row of value.places) {
    keys(row, ['placeId', 'note', 'favorite', 'done']);
    checked(
      place(row.placeId) &&
        textOK(row.note, 1000) &&
        typeof row.favorite === 'boolean' &&
        typeof row.done === 'boolean',
      'Invalid journey place',
    );
    result.places.push({ ...row });
  }
  for (const row of value.todos) {
    keys(row, ['id', 'title', 'detail', 'placeId', 'done']);
    checked(
      id(row.id) &&
        textOK(row.title, 120) &&
        row.title.trim() &&
        textOK(row.detail, 2000) &&
        (row.placeId === undefined || place(row.placeId)) &&
        typeof row.done === 'boolean',
      'Invalid journey todo',
    );
    result.todos.push({ ...row });
  }
  for (const row of value.gifts) {
    keys(row, ['id', 'npcId', 'itemId', 'quantity', 'placeId', 'note', 'done']);
    checked(
      id(row.id) &&
        /^npc-\d{1,9}$/.test(row.npcId) &&
        /^item-\d{1,9}$/.test(row.itemId) &&
        integer(row.quantity, 999) &&
        row.quantity > 0 &&
        textOK(row.note, 1000) &&
        (row.placeId === undefined || place(row.placeId)) &&
        typeof row.done === 'boolean',
      'Invalid journey gift',
    );
    result.gifts.push({ ...row });
  }
  checked(
    value.handledActionIds.every((v) => typeof v === 'string' && /^journey:[a-z-]+:[a-f0-9]{32}$/.test(v)),
    'Invalid journey action',
  );
  result.handledActionIds = [...value.handledActionIds];
  if (value.itinerary !== undefined) {
    const { validateItinerary } = require('./journey-state.cjs');
    try {
      validateItinerary(value.itinerary);
    } catch {
      fail('Invalid selected itinerary', 'PROTECTION_METADATA_INVALID');
    }
    result.itinerary = JSON.parse(JSON.stringify(value.itinerary));
  }
  for (const key of Object.keys(maxima)) {
    const identifiers = result[key].map((r) =>
      key === 'handledActionIds' ? r : key === 'places' ? r.placeId : r.id,
    );
    checked(new Set(identifiers).size === identifiers.length, 'Duplicate journey intent');
  }
  return result;
}
function portablePersonalFields(input, profile) {
  if (input.journeyTrash !== undefined) {
    validateJourneyTrash(input.journeyTrash);
    profile.journeyTrash = JSON.parse(JSON.stringify(input.journeyTrash));
  }
  if (input.intentDrafts !== undefined) {
    validateIntentDrafts(input.intentDrafts);
    profile.intentDrafts = JSON.parse(JSON.stringify(input.intentDrafts));
  }
  if (input.resourcePriority !== undefined) {
    const { validateResourcePriority } = require('./resource-priority.cjs');
    try {
      validateResourcePriority(input.resourcePriority);
    } catch {
      fail('Invalid resource priority', 'PROTECTION_METADATA_INVALID');
    }
    profile.resourcePriority = [...input.resourcePriority];
  }
  if (input.journey !== undefined) profile.journey = portableJourney(input.journey);
  if (input.previousCraftList !== undefined)
    profile.previousCraftList = portableCraftList(input.previousCraftList);
  for (const key of ['craftChoices', 'previousCraftChoices'])
    if (input[key] !== undefined) profile[key] = portableChoices(input[key]);
  if (input.craftPlans !== undefined) {
    checked(Array.isArray(input.craftPlans) && input.craftPlans.length <= 40, 'Invalid saved plans');
    const seen = new Set();
    profile.craftPlans = input.craftPlans.map((p) => {
      keys(p, ['id', 'name', 'list', 'choices', 'reserved', 'done', 'createdAt', 'updatedAt']);
      checked(
        textOK(p.id, 80) &&
          /^[a-zA-Z0-9-]+$/.test(p.id) &&
          p.id !== 'current' &&
          !seen.has(p.id) &&
          textOK(p.name, 80) &&
          p.name.trim() &&
          dateOK(p.createdAt) &&
          dateOK(p.updatedAt) &&
          (p.reserved === undefined || typeof p.reserved === 'boolean') &&
          (p.done === undefined || typeof p.done === 'boolean'),
        'Invalid saved plan',
      );
      seen.add(p.id);
      return {
        id: p.id,
        name: p.name,
        list: portableCraftList(p.list),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        ...(p.reserved === undefined ? {} : { reserved: p.reserved }),
        ...(p.done === undefined ? {} : { done: p.done }),
        ...(p.choices === undefined ? {} : { choices: portableChoices(p.choices) }),
      };
    });
  }
  if (input.activeCraftPlanId !== undefined) {
    checked(
      profile.craftPlans?.some((p) => p.id === input.activeCraftPlanId),
      'Invalid active plan',
    );
    profile.activeCraftPlanId = input.activeCraftPlanId;
  }
  if (input.reserveCraftDraft !== undefined) {
    checked(typeof input.reserveCraftDraft === 'boolean', 'Invalid draft reservation');
    profile.reserveCraftDraft = input.reserveCraftDraft;
  }
  if (input.previousCraftContext !== undefined) {
    const value = input.previousCraftContext;
    keys(value, ['reserveCraftDraft', 'activeCraftPlanId']);
    checked(
      typeof value.reserveCraftDraft === 'boolean' &&
        (value.activeCraftPlanId === undefined ||
          profile.craftPlans?.some((p) => p.id === value.activeCraftPlanId)),
      'Invalid previous draft context',
    );
    profile.previousCraftContext = { ...value };
  }
  if (input.allocations !== undefined) {
    checked(Array.isArray(input.allocations) && input.allocations.length <= 100, 'Invalid task allocations');
    const seen = new Set();
    profile.allocations = input.allocations.map((a) => {
      keys(a, ['questId', 'items']);
      checked(
        /^quest-\d{1,9}$/.test(a.questId) &&
          !seen.has(a.questId) &&
          object(a.items) &&
          Object.keys(a.items).length <= 300,
        'Invalid task allocation',
      );
      seen.add(a.questId);
      const items = {};
      for (const [id, count] of Object.entries(a.items)) {
        checked(/^\d{1,9}$/.test(id) && integer(count, 999999) && count > 0, 'Invalid allocated item');
        items[id] = count;
      }
      return { questId: a.questId, items };
    });
  }
  for (const key of ['recentSearches', 'savedSearches'])
    if (input[key] !== undefined) {
      checked(
        Array.isArray(input[key]) &&
          input[key].length <= 20 &&
          new Set(input[key]).size === input[key].length &&
          input[key].every((q) => textOK(q, 200) && q.trim()),
        'Invalid saved searches',
      );
      profile[key] = [...input[key]];
    }
  if (input.journalEntries !== undefined) {
    // The original journal is retained byte-for-byte. The read-only projection
    // can retain references to old data as labelled detached associations.
    const entries = JSON.parse(JSON.stringify(input.journalEntries));
    for (const entry of entries) {
      if (!Array.isArray(entry.links)) continue;
      for (const link of entry.links) {
        if (portableLinkIds[link.type] && !portableLinkIds[link.type].has(link.id)) link.detached = true;
      }
    }
    validateEntries(entries, { profile, catalog, guideIds: new Set(catalog.entries.map((e) => e.id)) });
    profile.journalEntries = entries;
  }
  if (input.journalDrafts !== undefined) {
    const drafts = JSON.parse(JSON.stringify(input.journalDrafts));
    for (const draft of drafts) {
      if (!Array.isArray(draft.links)) continue;
      for (const link of draft.links)
        if (portableLinkIds[link.type] && !portableLinkIds[link.type].has(link.id)) link.detached = true;
      for (const link of draft.entrySnapshot?.links || [])
        if (portableLinkIds[link.type] && !portableLinkIds[link.type].has(link.id)) link.detached = true;
    }
    validateDrafts(drafts, { profile, catalog, guideIds: new Set(catalog.entries.map((e) => e.id)) });
    profile.journalDrafts = drafts;
  }
  if (input.journalTrash !== undefined) {
    const trash = JSON.parse(JSON.stringify(input.journalTrash));
    for (const row of Array.isArray(trash) ? trash : []) {
      if (!Array.isArray(row?.entry?.links)) continue;
      for (const link of row.entry.links)
        if (portableLinkIds[link.type] && !portableLinkIds[link.type].has(link.id)) link.detached = true;
    }
    validateTrash(
      trash,
      { profile, catalog, guideIds: new Set(catalog.entries.map((entry) => entry.id)) },
      profile.journalEntries || [],
    );
    profile.journalTrash = trash;
  }
  if (input.journalRevisions !== undefined) {
    const rows = JSON.parse(JSON.stringify(input.journalRevisions));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row?.entry?.links)) continue;
      for (const link of row.entry.links)
        if (portableLinkIds[link.type] && !portableLinkIds[link.type].has(link.id)) link.detached = true;
    }
    validateRevisions(rows, {
      profile,
      catalog,
      guideIds: new Set(catalog.entries.map((entry) => entry.id)),
    });
    profile.journalRevisions = rows;
  }
  if (input.noteRevisions !== undefined) {
    const rows = JSON.parse(JSON.stringify(input.noteRevisions));
    validateNoteRevisions(rows);
    profile.noteRevisions = rows;
  }
}
function portableJournal(input) {
  checked(
    object(input) &&
      input.schema === 1 &&
      Array.isArray(input.profiles) &&
      input.profiles.length > 0 &&
      input.profiles.length <= 30 &&
      object(input.settings),
    'Invalid journal schema',
  );
  const ids = new Set();
  const profiles = input.profiles.map((p) => {
    checked(
      object(p) && textOK(p.id, 80) && /^[a-zA-Z0-9-]+$/.test(p.id) && !ids.has(p.id),
      'Invalid or duplicate profile',
    );
    ids.add(p.id);
    checked(
      textOK(p.name, 40) &&
        p.name.trim() &&
        integer(p.stage, 6) &&
        object(p.checks) &&
        Object.keys(p.checks).length <= 1000 &&
        Array.isArray(p.favorites) &&
        p.favorites.length <= 1000 &&
        p.favorites.every((id) => textOK(id, 200)) &&
        textOK(p.notes, 20000) &&
        Array.isArray(p.goals) &&
        p.goals.length <= 300,
      'Invalid journal contents',
    );
    const checks = {};
    for (const [id, value] of Object.entries(p.checks)) {
      checked(
        textOK(id, 200) &&
          !['__proto__', 'prototype', 'constructor'].includes(id) &&
          ['done', 'skip'].includes(value),
        'Invalid journal check',
      );
      checks[id] = value;
    }
    const goalIds = new Set();
    const goals = p.goals.map((g) => {
      checked(
        object(g) &&
          textOK(g.id, 80) &&
          /^[a-zA-Z0-9-]+$/.test(g.id) &&
          !goalIds.has(g.id) &&
          textOK(g.title, 200) &&
          g.title.trim() &&
          textOK(g.detail, 2000) &&
          typeof g.done === 'boolean' &&
          (g.pinned === undefined || typeof g.pinned === 'boolean'),
        'Invalid journal goal',
      );
      goalIds.add(g.id);
      const goal = { id: g.id, title: g.title, detail: g.detail, done: g.done };
      if (g.pinned !== undefined) goal.pinned = g.pinned;
      if (g.placeId !== undefined) {
        checked(typeof g.placeId === 'string' && /^place-\d{1,9}$/.test(g.placeId), 'Invalid goal place');
        goal.placeId = g.placeId;
      }
      if (g.progressMode !== undefined) {
        checked(
          ['auto', 'manual'].includes(g.progressMode) && g.source?.type === 'quest',
          'Invalid goal tracking',
        );
        goal.progressMode = g.progressMode;
      }
      if (g.createdAt !== undefined) {
        checked(dateOK(g.createdAt), 'Invalid goal timestamp');
        goal.createdAt = g.createdAt;
      }
      if (g.source !== undefined) {
        keys(g.source, ['type', 'id', 'quantity']);
        checked(
          ['guide', 'database', 'quest', 'planner'].includes(g.source.type) && textOK(g.source.id, 200),
          'Invalid goal reference',
        );
        if (g.source.quantity !== undefined)
          checked(
            integer(g.source.quantity, 999) && g.source.quantity > 0 && g.source.type === 'database',
            'Invalid goal quantity',
          );
        goal.source = { ...g.source };
      }
      return goal;
    });
    checked(
      p.stageConfirmed === undefined || typeof p.stageConfirmed === 'boolean',
      'Invalid stage confirmation',
    );
    checked(
      p.referenceMode === undefined || ['latest', 'slot', 'none'].includes(p.referenceMode),
      'Invalid save reference',
    );
    checked(
      p.saveSlot === undefined || p.saveSlot === '' || /^\d{1,12}\.sav$/i.test(p.saveSlot),
      'Invalid save slot',
    );
    const profile = {
      id: p.id,
      name: p.name,
      stage: p.stage,
      checks,
      favorites: [...p.favorites],
      notes: p.notes,
      goals,
      saveSlot: '',
      referenceMode: 'none',
      stageConfirmed: p.stageConfirmed === true,
    };
    for (const key of ['createdAt', 'updatedAt'])
      if (p[key] !== undefined) {
        checked(dateOK(p[key]), 'Invalid profile timestamp');
        profile[key] = p[key];
      }
    if (p.craftList !== undefined) {
      checked(Array.isArray(p.craftList) && p.craftList.length <= 40, 'Invalid craft list');
      const seen = new Set();
      profile.craftList = p.craftList.map((line) => {
        keys(line, ['id', 'quantity']);
        checked(
          textOK(line.id, 200) && !seen.has(line.id) && integer(line.quantity, 999) && line.quantity > 0,
          'Invalid craft line',
        );
        seen.add(line.id);
        return { ...line };
      });
    }
    if (p.reservations !== undefined) {
      checked(object(p.reservations) && Object.keys(p.reservations).length <= 300, 'Invalid reservations');
      profile.reservations = {};
      for (const [id, count] of Object.entries(p.reservations)) {
        checked(/^\d{1,9}$/.test(id) && integer(count, 999999) && count > 0, 'Invalid reservation');
        profile.reservations[id] = count;
      }
    }
    portablePersonalFields(p, profile);
    return profile;
  });
  checked(ids.has(input.activeProfileId), 'Invalid active profile');
  checked(
    ['hints', 'details'].includes(input.settings.spoiler) &&
      typeof input.settings.autoBackup === 'boolean' &&
      textOK(input.settings.savePath, 1000) &&
      textOK(input.settings.steamPath, 1000),
    'Invalid journal settings',
  );
  checked(input.updatedAt === undefined || dateOK(input.updatedAt), 'Invalid journal timestamp');
  return {
    schema: 1,
    activeProfileId: input.activeProfileId,
    profiles,
    settings: {
      spoiler: input.settings.spoiler,
      autoBackup: false,
      savePath: '',
      steamPath: '',
      offerAutoSaveOnStart: false,
      companionEnabled: false,
    },
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  };
}
function backupDescriptor(raw, id, limits) {
  checked(
    object(raw) &&
      raw.schema === 1 &&
      raw.id === id &&
      backupIdOK(id) &&
      textOK(raw.label, 100) &&
      textOK(raw.kind, 80) &&
      dateOK(raw.createdAt) &&
      typeof raw.source === 'string' &&
      Array.isArray(raw.files) &&
      raw.files.length > 0 &&
      raw.files.length <= 1000,
    'Invalid full backup manifest',
  );
  const seen = new Set();
  let total = 0;
  const files = raw.files.map((file) => {
    checked(
      object(file) &&
        nameOK(file.name) &&
        !seen.has(file.name.toLowerCase()) &&
        integer(file.bytes, limits.fileBytes) &&
        hashOK(file.sha256) &&
        dateOK(file.modifiedAt),
      'Invalid backup file entry',
    );
    seen.add(file.name.toLowerCase());
    total += file.bytes;
    checked(total <= limits.backupBytes, 'Full backup exceeds size limit');
    return { name: file.name, bytes: file.bytes, sha256: file.sha256, modifiedAt: file.modifiedAt };
  });
  checked(
    files.some((f) => /\.sav$/i.test(f.name)),
    'Full backup contains no saves',
  );
  return {
    schema: 1,
    id,
    label: raw.label,
    kind: raw.kind,
    createdAt: raw.createdAt,
    source: '',
    files,
    readOnly: true,
    bound: false,
    provenanceEntry: `originals/save-backups/${id}/manifest.json`,
  };
}
function timelineDescriptor(raw, limits) {
  checked(
    object(raw) &&
      raw.schema === 1 &&
      typeof raw.enabled === 'boolean' &&
      [10, 20, 30, 60, 120, 300].includes(raw.interval) &&
      typeof raw.source === 'string' &&
      (raw.ownerHash === '' || hashOK(raw.ownerHash)) &&
      Array.isArray(raw.records) &&
      raw.records.length <= limits.nodes,
    'Invalid timeline schema',
  );
  const ids = new Set(),
    groups = new Map();
  const groupFor = (source) => {
    const key = source.toLowerCase();
    if (!groups.has(key)) groups.set(key, `origin-${groups.size + 1}`);
    return groups.get(key);
  };
  const referenced = new Set();
  const records = raw.records.map((r) => {
    checked(
      object(r) &&
        idOK(r.id) &&
        !ids.has(r.id) &&
        hashOK(r.hash) &&
        integer(r.at) &&
        typeof r.source === 'string' &&
        ['auto', 'manual', 'before-load'].includes(r.kind) &&
        textOK(r.map, 1000) &&
        integer(r.playSeconds) &&
        (r.bookmarked === undefined || typeof r.bookmarked === 'boolean') &&
        (r.label === undefined || textOK(r.label, 80)) &&
        (r.note === undefined || textOK(r.note, 500)),
      'Invalid or duplicate timeline node',
    );
    ids.add(r.id);
    referenced.add(r.hash);
    return {
      id: r.id,
      hash: r.hash,
      at: r.at,
      kind: r.kind,
      map: r.map,
      playSeconds: r.playSeconds,
      originGroup: groupFor(r.source),
      source: '',
      bookmarked: r.bookmarked === true || (r.kind === 'manual' && r.bookmarked !== false),
      ...(r.label === undefined ? {} : { label: r.label }),
      ...(r.note === undefined ? {} : { note: r.note }),
    };
  });
  if (raw.ownerHash) referenced.add(raw.ownerHash);
  if (raw.pending !== undefined && raw.pending !== null) {
    const p = raw.pending;
    checked(
      object(p) &&
        ['save', 'stage', 'load'].includes(p.type) &&
        idOK(p.id) &&
        integer(p.at) &&
        (p.beforeHash === '' || hashOK(p.beforeHash)) &&
        (p.type === 'save' ? ['auto', 'manual', 'before-load'].includes(p.kind) : hashOK(p.targetHash)) &&
        (p.targetHash === undefined || hashOK(p.targetHash)) &&
        (p.beforeStamp === undefined || (typeof p.beforeStamp === 'string' && /^\d*$/.test(p.beforeStamp))),
      'Invalid pending timeline record',
    );
    if (p.beforeHash) referenced.add(p.beforeHash);
    if (p.targetHash) referenced.add(p.targetHash);
  }
  checked(
    raw.retired === undefined ||
      (Array.isArray(raw.retired) && raw.retired.length <= limits.nodes && raw.retired.every(hashOK)),
    'Invalid retired timeline hashes',
  );
  return {
    view: {
      schema: 1,
      enabled: false,
      interval: 10,
      source: '',
      ownerHash: '',
      pending: null,
      retired: [],
      readOnly: true,
      bound: false,
      records,
    },
    referenced,
  };
}
function metadataLimit(logical, limits) {
  return logical === 'originals/journal.json'
    ? limits.journalBytes
    : logical.startsWith('originals/save-backups/')
      ? limits.backupManifestBytes
      : limits.metadataBytes;
}
function compactMetadata(logical, bytes, limits) {
  const backup = /^originals\/save-backups\/([^/]+)\/manifest\.json$/.exec(logical);
  const raw = backup ? parseBackupManifest(bytes, backup[1]) : parseJSON(bytes);
  // Drop unknown fields immediately rather than retaining arbitrary JSON from every original file.
  if (logical === 'originals/journal.json') return portableJournal(raw);
  if (backup) return backupDescriptor(raw, backup[1], limits);
  const descriptor = timelineDescriptor(raw, limits);
  return {
    schema: 1,
    enabled: false,
    interval: 10,
    source: '',
    ownerHash: raw.ownerHash,
    pending: raw.pending
      ? Object.fromEntries(
          ['type', 'id', 'kind', 'beforeHash', 'beforeStamp', 'targetHash', 'at']
            .filter((key) => raw.pending[key] !== undefined)
            .map((key) => [key, raw.pending[key]]),
        )
      : null,
    retired: [],
    records: descriptor.view.records.map((record) => ({ ...record, source: record.originGroup })),
  };
}
function validateManifest(manifest, limits) {
  keys(manifest, ['schema', 'kind', 'createdAt', 'entries']);
  checked(
    manifest.schema === 1 &&
      manifest.kind === 'yijian-offline-protection' &&
      dateOK(manifest.createdAt) &&
      Array.isArray(manifest.entries) &&
      manifest.entries.length > 0 &&
      manifest.entries.length <= limits.entries,
    'Invalid package manifest',
  );
  const seen = new Set();
  let total = 0;
  for (const e of manifest.entries) {
    keys(e, ['path', 'bytes', 'sha256']);
    const limit = e.path?.startsWith('originals/') ? metadataLimit(e.path, limits) : limits.fileBytes;
    checked(
      logicalPathOK(e.path) && !seen.has(e.path.toLowerCase()) && integer(e.bytes, limit) && hashOK(e.sha256),
      'Illegal, duplicate or oversized package entry',
    );
    seen.add(e.path.toLowerCase());
    total += e.bytes;
    checked(total <= limits.totalBytes, 'Package exceeds total size limit');
  }
  checked(seen.has('originals/journal.json'), 'Package contains no journal');
  return total;
}
function buildView(manifest, metadata, limits) {
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const expected = new Set(['originals/journal.json']);
  const journal = portableJournal(metadata.get('originals/journal.json'));
  const backups = [];
  for (const name of entries.keys()) {
    const match = /^originals\/save-backups\/([^/]+)\/manifest\.json$/.exec(name);
    if (!match) continue;
    checked(backups.length < limits.backups, 'Too many full backups');
    const backup = backupDescriptor(metadata.get(name), match[1], limits);
    expected.add(name);
    for (const file of backup.files) {
      const key = `save-backups/${backup.id}/files/${file.name}`,
        entry = entries.get(key);
      checked(
        entry && entry.bytes === file.bytes && entry.sha256 === file.sha256,
        'Full backup is incomplete or has mismatched hashes',
      );
      expected.add(key);
    }
    backups.push(backup);
  }
  let timeline = {
    schema: 1,
    readOnly: true,
    bound: false,
    enabled: false,
    source: '',
    ownerHash: '',
    pending: null,
    records: [],
  };
  if (entries.has('originals/game-timeline/timeline.json')) {
    expected.add('originals/game-timeline/timeline.json');
    const descriptor = timelineDescriptor(metadata.get('originals/game-timeline/timeline.json'), limits);
    timeline = descriptor.view;
    for (const hash of descriptor.referenced) {
      const key = `game-timeline/blobs/${hash}.sav`,
        entry = entries.get(key);
      checked(entry && entry.sha256 === hash, 'Timeline is missing a verified protection blob');
      expected.add(key);
    }
  }
  checked(
    expected.size === entries.size && [...expected].every((key) => entries.has(key)),
    'Unreferenced or incomplete package entries',
  );
  return {
    schema: 1,
    kind: 'yijian-imported-history',
    readOnly: true,
    bound: false,
    catalogValidated: false,
    createdAt: manifest.createdAt,
    journal,
    backups,
    timeline,
  };
}
async function describeFile(file, logical, limits) {
  const max = logical.startsWith('originals/') ? metadataLimit(logical, limits) : limits.fileBytes;
  const opened = await openStable(file, max),
    hash = crypto.createHash('sha256');
  try {
    await visitBytes(opened, opened.size, (bytes) => {
      hash.update(bytes);
    });
    await assertStable(opened);
    return { path: logical, bytes: opened.size, sha256: hash.digest('hex') };
  } finally {
    await opened.handle.close();
  }
}
async function collectSource(
  dataRoot,
  limits,
  { backupIds, includeTimeline = true, expectedJournalHash } = {},
) {
  const root = await realDirectory(dataRoot),
    entries = [],
    files = new Map(),
    metadata = new Map();
  const add = async (file, logical) => {
    checked(entries.length < limits.entries, 'Too many package entries');
    const entry = await describeFile(file, logical, limits);
    entries.push(entry);
    files.set(logical, file);
    if (logical.startsWith('originals/')) {
      const bytes = await stableBytes(file, metadataLimit(logical, limits));
      checked(sha(bytes) === entry.sha256, 'Metadata changed during collection');
      metadata.set(logical, compactMetadata(logical, bytes, limits));
    }
  };
  await add(path.join(root, 'journal.json'), 'originals/journal.json');
  checked(
    !expectedJournalHash || entries[0].sha256 === expectedJournalHash,
    '手札在分批导出期间发生变化，请重新导出',
  );
  const backupRoot = path.join(root, 'save-backups');
  if (backupIds !== undefined)
    checked(
      Array.isArray(backupIds) &&
        backupIds.length <= limits.backups &&
        new Set(backupIds).size === backupIds.length &&
        backupIds.every(backupIdOK),
      '选择的完整备份不存在或数量超限',
    );
  if (await exists(backupRoot)) {
    await realDirectory(backupRoot);
    const names = backupDirectories(backupRoot);
    if (backupIds !== undefined) {
      checked(
        Array.isArray(backupIds) &&
          backupIds.length <= limits.backups &&
          new Set(backupIds).size === backupIds.length &&
          backupIds.every((id) => backupIdOK(id) && names.includes(id)),
        '选择的完整备份不存在或数量超限',
      );
    }
    let count = 0;
    for (const id of (backupIds === undefined ? names : backupIds).slice().sort()) {
      if (!backupIdOK(id)) continue;
      checked(count++ < limits.backups, '这一批超过 1000 份完整备份，请缩小选择范围');
      let backup;
      try {
        backupDirectory(backupRoot, id);
        await add(path.join(backupRoot, id, 'manifest.json'), `originals/save-backups/${id}/manifest.json`);
        backup = backupDescriptor(metadata.get(`originals/save-backups/${id}/manifest.json`), id, limits);
      } catch (error) {
        throw backupMetadataError(backupRoot, id, error);
      }
      for (const file of backup.files) {
        try {
          await add(path.join(backupRoot, id, 'files', file.name), `save-backups/${id}/files/${file.name}`);
          const entry = entries.at(-1);
          checked(entry.bytes === file.bytes && entry.sha256 === file.sha256, '文件与原始校验值不一致');
        } catch (e) {
          throw Object.assign(
            Error(
              `完整备份「${backup.label}」（${id}）的「${file.name}」无法通过校验：${e.message}。原件保留；可在完整备份列表选择可靠副本分批导出。`,
            ),
            {
              code: 'BACKUP_PAYLOAD_INVALID',
              backupId: id,
              directory: path.join(backupRoot, id),
              reasonCode: typeof e.code === 'string' ? e.code : 'BACKUP_FILE_CHECK_FAILED',
              reason: e.message,
              diagnostic: e.message,
            },
          );
        }
      }
    }
  } else checked(!backupIds?.length, '选择的完整备份不存在');
  const timelineFile = path.join(root, 'game-timeline', 'timeline.json');
  if (includeTimeline && (await exists(timelineFile))) {
    await add(timelineFile, 'originals/game-timeline/timeline.json');
    const descriptor = timelineDescriptor(metadata.get('originals/game-timeline/timeline.json'), limits);
    for (const hash of [...descriptor.referenced].sort())
      await add(path.join(root, 'game-timeline', 'blobs', hash + '.sav'), `game-timeline/blobs/${hash}.sav`);
  }
  const manifest = {
    schema: 1,
    kind: 'yijian-offline-protection',
    createdAt: new Date().toISOString(),
    entries,
  };
  validateManifest(manifest, limits);
  return { manifest, files, view: buildView(manifest, metadata, limits) };
}
async function exists(file) {
  try {
    await fsp.lstat(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function durableFile(file, bytes) {
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2));
}
function summary(view, manifest, digest) {
  return {
    packageHash: digest,
    createdAt: manifest.createdAt,
    bytes: manifest.entries.reduce((n, e) => n + e.bytes, 0),
    entries: manifest.entries.length,
    profiles: view.journal.profiles.map((p) => ({ id: p.id, name: p.name })),
    backups: view.backups.map((b) => ({
      id: b.id,
      label: b.label,
      createdAt: b.createdAt,
      count: b.files.length,
      bytes: b.files.reduce((n, f) => n + f.bytes, 0),
    })),
    nodes: view.timeline.records.length,
    bookmarks: view.timeline.records.filter((r) => r.bookmarked).length,
    readOnly: true,
    bound: false,
  };
}
async function scanPackage(file, limits, onEntry) {
  const opened = await openStable(file, limits.totalBytes + limits.manifestBytes + MAGIC.length + 36);
  const hash = crypto.createHash('sha256'),
    metadata = new Map();
  try {
    const header = await exactRead(opened.handle, MAGIC.length + 4, 0);
    checked(
      header.subarray(0, MAGIC.length).equals(MAGIC),
      'Unsupported protection package',
      'PROTECTION_FORMAT_UNSUPPORTED',
    );
    const manifestLength = header.readUInt32BE(MAGIC.length);
    checked(manifestLength > 0 && manifestLength <= limits.manifestBytes, 'Manifest exceeds size limit');
    const manifestBytes = await exactRead(opened.handle, manifestLength, header.length),
      manifest = parseJSON(manifestBytes);
    const total = validateManifest(manifest, limits);
    checked(
      opened.size === header.length + manifestLength + total + 32,
      'Truncated package or trailing data',
      'PROTECTION_PACKAGE_TRUNCATED',
    );
    hash.update(header);
    hash.update(manifestBytes);
    let position = header.length + manifestLength;
    for (const entry of manifest.entries) {
      const entryHash = crypto.createHash('sha256'),
        chunks = [];
      const output = onEntry ? await onEntry(entry) : null;
      try {
        await visitBytes(
          opened,
          entry.bytes,
          async (bytes) => {
            entryHash.update(bytes);
            hash.update(bytes);
            if (entry.path.startsWith('originals/')) chunks.push(bytes);
            if (output) await writeAll(output, bytes);
          },
          position,
        );
        checked(
          entryHash.digest('hex') === entry.sha256,
          `Entry hash mismatch: ${entry.path}`,
          'PROTECTION_CHECKSUM_MISMATCH',
        );
        if (output) await output.sync();
      } finally {
        if (output) await output.close();
      }
      if (entry.path.startsWith('originals/'))
        metadata.set(entry.path, compactMetadata(entry.path, Buffer.concat(chunks), limits));
      position += entry.bytes;
    }
    const digest = hash.digest(),
      footer = await exactRead(opened.handle, 32, position);
    checked(
      crypto.timingSafeEqual(digest, footer),
      'Package checksum mismatch',
      'PROTECTION_CHECKSUM_MISMATCH',
    );
    await assertStable(opened);
    return {
      manifest,
      manifestBytes,
      view: buildView(manifest, metadata, limits),
      digest: digest.toString('hex'),
    };
  } finally {
    await opened.handle.close();
  }
}
async function exportProtection({
  dataRoot,
  file,
  limits: overrides,
  backupIds,
  includeTimeline = true,
  expectedJournalHash,
}) {
  const limits = limitsOf(overrides),
    collected = await collectSource(dataRoot, limits, { backupIds, includeTimeline, expectedJournalHash });
  return writeProtection(collected, file, limits);
}
async function writeProtection(collected, file, limits) {
  const output = path.resolve(file);
  await realDirectory(path.dirname(output));
  checked(nameOK(path.basename(output)), 'Invalid output filename');
  if (await exists(output))
    throw Object.assign(Error('Protection file already exists; choose a new filename'), {
      code: 'EEXIST',
      protectionOutput: output,
    });
  const manifestBytes = collected.manifestBytes || jsonBytes(collected.manifest);
  checked(manifestBytes.length <= limits.manifestBytes, 'Manifest exceeds size limit');
  const temporary = path.join(path.dirname(output), `.migration-export-${crypto.randomUUID()}.tmp`);
  const handle = await fsp.open(temporary, 'wx', 0o600),
    hash = crypto.createHash('sha256');
  try {
    const header = Buffer.alloc(MAGIC.length + 4);
    MAGIC.copy(header);
    header.writeUInt32BE(manifestBytes.length, MAGIC.length);
    await writeAll(handle, header);
    await writeAll(handle, manifestBytes);
    hash.update(header);
    hash.update(manifestBytes);
    for (const entry of collected.manifest.entries) {
      const opened = await openStable(
        collected.files.get(entry.path),
        Math.max(limits.fileBytes, limits.metadataBytes, limits.journalBytes),
      );
      try {
        checked(opened.size === entry.bytes, 'Source size changed during export');
        const entryHash = crypto.createHash('sha256');
        await visitBytes(opened, entry.bytes, async (bytes) => {
          hash.update(bytes);
          entryHash.update(bytes);
          await writeAll(handle, bytes);
        });
        checked(entryHash.digest('hex') === entry.sha256, 'Source hash changed during export');
        await assertStable(opened);
      } finally {
        await opened.handle.close();
      }
    }
    await writeAll(handle, hash.digest());
    await handle.sync();
    await handle.close();
    const result = await scanPackage(temporary, limits);
    // Exclusive hard-link publication is atomic and cannot replace a racing existing destination.
    try {
      await fsp.link(temporary, output);
    } catch (error) {
      if (error.code === 'EEXIST') error.protectionOutput = output;
      throw error;
    }
    return { file: output, ...summary(result.view, result.manifest, result.digest) };
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}
async function previewProtection({ file, targetDirectory, limits: overrides }) {
  const limits = limitsOf(overrides),
    result = await scanPackage(file, limits);
  let destination = { provided: false, conflict: false };
  if (targetDirectory !== undefined) {
    const target = noGameDirectory(targetDirectory);
    await realDirectory(path.dirname(target));
    destination = {
      provided: true,
      directory: target,
      conflict: await exists(target),
      mode: 'new-directory-only',
    };
  }
  return { ...summary(result.view, result.manifest, result.digest), destination };
}
async function atomicNewDirectory(targetDirectory, populate) {
  const target = noGameDirectory(targetDirectory),
    parent = await realDirectory(path.dirname(target));
  checked(nameOK(path.basename(target)), 'Invalid destination directory name');
  checked(!(await exists(target)), 'Destination already exists; current data is preserved');
  const stage = await fsp.mkdtemp(path.join(parent, '.migration-stage-'));
  let reserved = false,
    committed = false;
  const marker = path.join(target, '.migration-reservation');
  try {
    const result = await populate(stage);
    await fsp.mkdir(target, { mode: 0o700 });
    reserved = true;
    await durableFile(marker, Buffer.from('Incomplete until payload exists.\n'));
    // Publish a fully verified tree at once, inside an exclusively reserved fresh container.
    await fsp.rename(stage, path.join(target, 'payload'));
    committed = true;
    await fsp.unlink(marker);
    return { ...result, directory: target, payloadDirectory: path.join(target, 'payload') };
  } finally {
    if (!committed) await fsp.rm(stage, { recursive: true, force: true });
    if (reserved && !committed) {
      await fsp.unlink(marker).catch(() => {});
      await fsp.rmdir(target).catch(() => {}); // Only removes our empty reservation; never someone else's files.
    }
  }
}
async function importProtection({ file, targetDirectory, expectedPackageHash, limits: overrides }) {
  const limits = limitsOf(overrides);
  checked(expectedPackageHash === undefined || hashOK(expectedPackageHash), 'Invalid preview package hash');
  return atomicNewDirectory(targetDirectory, async (stage) => {
    const result = await scanPackage(file, limits, async (entry) => {
      const output = path.join(stage, ...entry.path.split('/'));
      await fsp.mkdir(path.dirname(output), { recursive: true });
      return fsp.open(output, 'wx', 0o600);
    });
    checked(
      expectedPackageHash === undefined || result.digest === expectedPackageHash,
      'Package changed since preview',
    );
    await durableFile(path.join(stage, 'package-index.json'), result.manifestBytes);
    await durableFile(path.join(stage, 'history.json'), jsonBytes(result.view));
    await durableFile(
      path.join(stage, 'receipt.json'),
      jsonBytes({ schema: 1, packageHash: result.digest, readOnly: true, bound: false }),
    );
    // Read-back verification catches incomplete disk copies before publication.
    const verified = await verifyPayload(stage, limits);
    return summary(verified.view, verified.manifest, result.digest);
  });
}
async function verifyPayload(payload, limits) {
  await realDirectory(payload);
  const manifestBytes = await stableBytes(path.join(payload, 'package-index.json'), limits.manifestBytes);
  const manifest = parseJSON(manifestBytes);
  validateManifest(manifest, limits);
  const header = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(header);
  header.writeUInt32BE(manifestBytes.length, MAGIC.length);
  const packageHash = crypto.createHash('sha256');
  packageHash.update(header);
  packageHash.update(manifestBytes);
  const metadata = new Map();
  for (const entry of manifest.entries) {
    const file = path.join(payload, ...entry.path.split('/'));
    const opened = await openStable(
      file,
      entry.path.startsWith('originals/') ? metadataLimit(entry.path, limits) : limits.fileBytes,
    );
    const entryHash = crypto.createHash('sha256'),
      chunks = [];
    try {
      checked(opened.size === entry.bytes, 'Imported history size mismatch');
      await visitBytes(opened, entry.bytes, (bytes) => {
        packageHash.update(bytes);
        entryHash.update(bytes);
        if (entry.path.startsWith('originals/')) chunks.push(bytes);
      });
      checked(entryHash.digest('hex') === entry.sha256, 'Imported history hash mismatch');
      await assertStable(opened);
    } finally {
      await opened.handle.close();
    }
    if (entry.path.startsWith('originals/'))
      metadata.set(entry.path, compactMetadata(entry.path, Buffer.concat(chunks), limits));
  }
  const receipt = parseJSON(await stableBytes(path.join(payload, 'receipt.json'), 1024));
  keys(receipt, ['schema', 'packageHash', 'readOnly', 'bound']);
  checked(
    receipt.schema === 1 &&
      receipt.readOnly === true &&
      receipt.bound === false &&
      receipt.packageHash === packageHash.digest('hex'),
    'Imported history package checksum mismatch',
  );
  return { manifest, manifestBytes, view: buildView(manifest, metadata, limits) };
}
async function exportHistoricalProtection({ directory, file, limits: overrides }) {
  const limits = limitsOf(overrides),
    payload = path.join(await realDirectory(directory), 'payload');
  const verified = await verifyPayload(payload, limits);
  const files = new Map(
    verified.manifest.entries.map((entry) => [entry.path, path.join(payload, ...entry.path.split('/'))]),
  );
  return writeProtection({ ...verified, files }, file, limits);
}
async function readHistory({ directory, limits: overrides }) {
  const limits = limitsOf(overrides),
    payload = path.join(await realDirectory(directory), 'payload');
  const result = await verifyPayload(payload, limits);
  return { ...result.view, payloadDirectory: payload };
}
async function readBackupFile({ directory, id, name, limits: overrides }) {
  checked(backupIdOK(id) && nameOK(name), 'Invalid historical backup selection');
  const limits = limitsOf(overrides),
    history = await readHistory({ directory, limits });
  const backup = history.backups.find((item) => item.id === id),
    entry = backup?.files.find((item) => item.name === name);
  checked(entry, 'Historical backup file does not exist');
  const bytes = await stableBytes(
    path.join(history.payloadDirectory, 'save-backups', id, 'files', name),
    limits.fileBytes,
  );
  checked(
    bytes.length === entry.bytes && sha(bytes) === entry.sha256,
    'Historical backup changed while reading',
  );
  return { bytes, file: entry, backup };
}
async function readTimelineNode({ directory, id, limits: overrides }) {
  checked(idOK(id), 'Invalid historical timeline selection');
  const limits = limitsOf(overrides),
    history = await readHistory({ directory, limits });
  const record = history.timeline.records.find((item) => item.id === id);
  checked(record, 'Historical node does not exist');
  const bytes = await stableBytes(
    path.join(history.payloadDirectory, 'game-timeline', 'blobs', record.hash + '.sav'),
    limits.fileBytes,
  );
  checked(sha(bytes) === record.hash, 'Historical node changed while reading');
  return { bytes, record, readOnly: true, bound: false };
}
async function materializeBackup({ directory, id, targetDirectory, limits: overrides }) {
  checked(backupIdOK(id), 'Invalid historical backup selection');
  const limits = limitsOf(overrides),
    history = await readHistory({ directory, limits });
  const index = parseJSON(
    await stableBytes(path.join(history.payloadDirectory, 'package-index.json'), limits.manifestBytes),
  );
  validateManifest(index, limits);
  const backup = history.backups.find((item) => item.id === id);
  checked(backup, 'Historical full backup does not exist');
  return atomicNewDirectory(targetDirectory, async (stage) => {
    await fsp.mkdir(path.join(stage, 'files'));
    for (const entry of backup.files) {
      const source = path.join(history.payloadDirectory, 'save-backups', id, 'files', entry.name);
      const opened = await openStable(source, limits.fileBytes),
        output = await fsp.open(path.join(stage, 'files', entry.name), 'wx', 0o600);
      const hash = crypto.createHash('sha256');
      try {
        checked(opened.size === entry.bytes, 'Historical backup size changed');
        await visitBytes(opened, entry.bytes, async (bytes) => {
          hash.update(bytes);
          await writeAll(output, bytes);
        });
        checked(hash.digest('hex') === entry.sha256, 'Historical backup hash changed');
        await assertStable(opened);
        await output.sync();
      } finally {
        await opened.handle.close();
        await output.close();
      }
      const copied = await describeFile(
        path.join(stage, 'files', entry.name),
        `save-backups/${id}/files/${entry.name}`,
        limits,
      );
      checked(
        copied.bytes === entry.bytes && copied.sha256 === entry.sha256,
        'Materialized backup read-back failed',
      );
    }
    const provenance = await stableBytes(
      path.join(history.payloadDirectory, ...backup.provenanceEntry.split('/')),
      limits.metadataBytes,
    );
    const provenanceEntry = index.entries.find((entry) => entry.path === backup.provenanceEntry);
    checked(
      provenanceEntry &&
        provenance.length === provenanceEntry.bytes &&
        sha(provenance) === provenanceEntry.sha256,
      'Historical provenance changed during materialization',
    );
    await durableFile(path.join(stage, 'provenance-manifest.json'), provenance);
    await durableFile(path.join(stage, 'manifest.json'), jsonBytes(backup));
    return { id, count: backup.files.length, readOnly: true, bound: false, source: '' };
  });
}

async function planProtectionExports({ dataRoot, limits: overrides }) {
  const limits = limitsOf(overrides),
    root = await realDirectory(dataRoot);
  const journal = await describeFile(path.join(root, 'journal.json'), 'originals/journal.json', limits);
  const payloadLimit = Math.min(
    limits.totalBytes,
    DEFAULT_LIMITS.totalBytes - DEFAULT_LIMITS.manifestBytes - 52,
  );
  const timelineFile = path.join(root, 'game-timeline', 'timeline.json');
  let timelineBytes = 0,
    timelineEntries = 0;
  if (await exists(timelineFile)) {
    const bytes = await stableBytes(timelineFile, limits.metadataBytes),
      descriptor = timelineDescriptor(parseJSON(bytes), limits);
    timelineBytes = bytes.length;
    timelineEntries = 1;
    for (const hash of descriptor.referenced) {
      const entry = await describeFile(
        path.join(root, 'game-timeline', 'blobs', hash + '.sav'),
        'game-timeline/blobs/' + hash + '.sav',
        limits,
      );
      checked(entry.sha256 === hash, '时间线原始文件校验失败');
      timelineBytes += entry.bytes;
      timelineEntries++;
    }
  }
  checked(
    journal.bytes + timelineBytes <= payloadLimit && 1 + timelineEntries <= limits.entries,
    '时间线超过单包容量。原始记录全部保留，可先在完整备份列表分批导出副本，并保留本机数据目录',
  );
  const parts = [],
    backupRoot = path.join(root, 'save-backups');
  let part = {
    backupIds: [],
    includeTimeline: true,
    bytes: journal.bytes + timelineBytes,
    entries: 1 + timelineEntries,
  };
  const names = (await exists(backupRoot)) ? backupDirectories(await realDirectory(backupRoot)) : [];
  for (const id of names) {
    let bytes, backup;
    try {
      backupDirectory(backupRoot, id);
      bytes = await stableBytes(path.join(backupRoot, id, 'manifest.json'), limits.backupManifestBytes);
      backup = backupDescriptor(parseBackupManifest(bytes, id), id, limits);
    } catch (error) {
      throw backupMetadataError(backupRoot, id, error);
    }
    const size = bytes.length + backup.files.reduce((sum, file) => sum + file.bytes, 0),
      entries = 1 + backup.files.length;
    checked(
      journal.bytes + size <= payloadLimit && 1 + entries <= limits.entries,
      '完整备份「' + backup.label + '」超过单包容量，原件已保留',
    );
    if (
      part.backupIds.length >= limits.backups ||
      part.bytes + size > payloadLimit ||
      part.entries + entries > limits.entries
    ) {
      parts.push(part);
      part = { backupIds: [], includeTimeline: false, bytes: journal.bytes, entries: 1 };
    }
    part.backupIds.push(id);
    part.bytes += size;
    part.entries += entries;
  }
  parts.push(part);
  return { parts, journalHash: journal.sha256, backups: names.length };
}

async function readProtectionIndex({ file }) {
  const result = await scanPackage(file, limitsOf());
  return { manifest: result.manifest, packageHash: result.digest };
}

module.exports = {
  exportProtection,
  exportHistoricalProtection,
  previewProtection,
  importProtection,
  readHistory,
  readBackupFile,
  readTimelineNode,
  materializeBackup,
  planProtectionExports,
  readProtectionIndex,
  DEFAULT_LIMITS,
};
