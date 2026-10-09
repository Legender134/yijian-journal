'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { atomicWrite } = require('../src/core/store.cjs');
const { Activity } = require('../src/core/activity.cjs');
function platform(value, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yijian-atomic-'));
  const activity = new Activity(dir);
  activity.draft('checkpoint-1', { label: '原记录', note: '已保存的原文' });
  return { dir, activity, before: fs.readFileSync(activity.file) };
}
for (const code of ['EPERM', 'EBUSY']) {
  test(`a short Windows ${code} replacement lock saves the draft once and keeps the exact previous bytes`, () => {
    const { dir, activity, before } = fixture();
    const rename = fs.renameSync,
      sources = [],
      failure = Object.assign(Error('synthetic short file lock'), { code });
    fs.renameSync = (source, target) => {
      if (target === activity.file) {
        sources.push(source);
        if (sources.length <= 2) {
          assert.deepEqual(fs.readFileSync(target), before);
          assert.equal(activity.get().drafts['checkpoint-1'].note, '已保存的原文');
          throw failure;
        }
      }
      return rename(source, target);
    };
    try {
      platform('win32', () => activity.draft('checkpoint-1', { label: '更新', note: '完整的新原文' }));
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(new Set(sources).size, 1);
    assert.equal(sources.length, 3);
    assert.equal(activity.get().drafts['checkpoint-1'].note, '完整的新原文');
    assert.equal(new Activity(dir).get().drafts['checkpoint-1'].note, '完整的新原文');
    assert.deepEqual(fs.readFileSync(activity.file + '.previous'), before);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  });
}
test('a persistent Windows replacement refusal stays bounded and retains disk, memory, previous copy and unpublished bytes', () => {
  const { dir, activity, before } = fixture();
  const rename = fs.renameSync,
    sources = [],
    failure = Object.assign(Error('synthetic persistent refusal'), { code: 'EPERM' });
  fs.renameSync = (source, target) => {
    if (target === activity.file) {
      sources.push(source);
      throw failure;
    }
    return rename(source, target);
  };
  const start = Date.now();
  try {
    assert.throws(
      () =>
        platform('win32', () => activity.draft('checkpoint-1', { label: '未保存', note: '不可假报成功' })),
      (error) => error === failure,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert(sources.length > 1 && sources.length < 20);
  assert(Date.now() - start < 1500, 'replacement lock blocked the application for too long');
  assert.equal(new Set(sources).size, 1);
  assert.deepEqual(fs.readFileSync(activity.file), before);
  assert.deepEqual(fs.readFileSync(activity.file + '.previous'), before);
  assert.equal(activity.get().drafts['checkpoint-1'].note, '已保存的原文');
  assert.equal(new Activity(dir).get().drafts['checkpoint-1'].note, '已保存的原文');
  assert.equal(JSON.parse(fs.readFileSync(sources[0])).drafts['checkpoint-1'].note, '不可假报成功');
});
for (const [targetPlatform, code] of [
  ['win32', 'EACCES'],
  ['win32', 'EIO'],
  ['linux', 'EPERM'],
]) {
  test(`${targetPlatform} ${code} is reported immediately without replacement fallback`, () => {
    const { activity, before } = fixture();
    const rename = fs.renameSync,
      failure = Object.assign(Error('synthetic non-retryable error'), { code });
    let attempts = 0;
    fs.renameSync = (source, target) => {
      if (target === activity.file) {
        attempts++;
        throw failure;
      }
      return rename(source, target);
    };
    try {
      assert.throws(
        () => platform(targetPlatform, () => atomicWrite(activity.file, { unpublished: true })),
        (error) => error === failure,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(attempts, 1);
    assert.deepEqual(fs.readFileSync(activity.file), before);
    assert.deepEqual(fs.readFileSync(activity.file + '.previous'), before);
  });
}
