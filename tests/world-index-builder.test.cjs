'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('offline world projection includes public social variants without gift hobbies and excludes hidden/test rows', (t) => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'yijian-world-projection-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), temporaryRoot);
    assert(path.basename(temporary).startsWith('yijian-world-projection-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(temporary, 'scripts'));
  fs.mkdirSync(path.join(temporary, 'src/data'), { recursive: true });
  fs.mkdirSync(path.join(temporary, '.downloads/game-json'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '../scripts/build-world-index.cjs'),
    path.join(temporary, 'scripts/build-world-index.cjs'),
  );
  const write = (file, value) => fs.writeFileSync(path.join(temporary, file), JSON.stringify(value));
  write('src/data/game-index.json', {
    build: 'synthetic',
    source: 'isolated',
    maps: { lv: '合成地点' },
    entries: [{ id: 'item-100', gameId: 100, kind: '物品', typeKey: 'Plant', type: '药材' }],
    quests: { 1000: { name: '【支线】合成剧情', parentId: 0, kind: 'Branch', description: '' } },
  });
  write('.downloads/game-json/Maps-simple.json', [{ MapId: 1, MapName: 'lv' }]);
  const quest = (QuestId, OwnerQuestId, Name) => ({
    QuestId,
    OwnerQuestId,
    Name,
    RequestNPCLocation: [],
    FinishNPCLocation: [],
    RequestNPCIds: [],
    FinishNPCIds: [],
    RequestRequirements: [],
  });
  write('.downloads/game-json/Quests-simple.json', [
    quest(1000, 0, '【支线】合成剧情'),
    quest(1001, 1000, null),
    quest(1002, 0, null),
  ]);
  const npc = (Id, functions, extra = {}) => ({
    Id,
    Name: '合成人物' + Id,
    Description: '',
    SellItems: [],
    Hobbies: ['EItemSubType::Plant'],
    Functions: functions.map((f) => ({ Function: 'ENPCFunction::' + f })),
    SkillList: [],
    FriendlinessLockSettings: [
      {
        FriendlinessLock: 60,
        ReqirementsForUnlock: [{ Type: 'ERequirementType::PreQuest', Id: 1001, Num: 4 }],
      },
    ],
    JoinTeamRequirements: [],
    WalkLevelName: 'lv',
    ...extra,
  });
  write('.downloads/game-json/NPCs-simple.json', [
    npc(1, ['Compare']),
    npc(2, ['Consult']),
    npc(3, ['AddToTeam']),
    npc(4, ['Gift'], { Hobbies: [] }),
    npc(5, ['Talk']),
    npc(6, ['Compare'], { bNotShowInUI: true }),
    npc(7, ['Compare'], { Name: '测试人物' }),
    npc(8, ['Talk'], {
      SellItems: [100],
      FriendlinessLockSettings: [
        {
          FriendlinessLock: 20,
          ReqirementsForUnlock: [{ Type: 'ERequirementType::PreQuest', Id: 1002, Num: 4 }],
        },
      ],
    }),
  ]);
  execFileSync(process.execPath, [path.join(temporary, 'scripts/build-world-index.cjs')], { stdio: 'pipe' });
  const result = JSON.parse(fs.readFileSync(path.join(temporary, 'src/data/world-index.json')));
  assert.deepEqual(
    result.people.map((p) => p.gameId),
    [1, 2, 3, 4, 8],
  );
  for (const person of result.people.filter((p) => p.gameId <= 3)) {
    assert.deepEqual(person.hobbies, ['药材']);
    assert.deepEqual(person.hobbyKeys, ['Plant']);
    assert.deepEqual(person.friendshipLocks[0].requirements[0], {
      type: 'PreQuest',
      id: 1001,
      value: 4,
      name: '合成剧情相关剧情',
      relatedQuestId: 1000,
    });
  }
  assert.deepEqual(result.people.find((p) => p.gameId === 4).hobbies, []);
  const unowned = result.people.find((p) => p.gameId === 8).friendshipLocks[0].requirements[0];
  assert.equal(unowned.name, '合成人物8相关剧情');
  assert.equal(unowned.id, 1002);
  assert.equal(Object.hasOwn(unowned, 'relatedQuestId'), false);
});
