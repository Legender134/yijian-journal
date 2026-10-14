'use strict';
// Explicit development-only Lua interpreter; every UE object and channel is
// synthetic. This script never loads UE4SS, starts the game, or reads saves.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const interpreter = process.env.YIJIAN_LUA_BIN;
if (!interpreter) throw Error('请显式设置 YIJIAN_LUA_BIN 为开发测试用 Lua 5.4 解释器');
const source = fs
  .readFileSync(path.join(__dirname, '../src/game-bridge/main.lua'), 'utf8')
  .replace('__JOURNAL_ROOT__', '"SYNTHETIC/"')
  .replace('__JOURNAL_REVISION__', '"' + 'a'.repeat(64) + '"');
const setup = `
local now, loop = 1000000, nil
os.time=function() return now end
local token=string.rep('b',64)
local source='C:/Synthetic/76561190000000000/SaveGames'
local files={['SYNTHETIC/config.txt']=token..'\\n'..source..'\\n',
    [source..'/29.sav']='owned', [source..'/JHSaveConfig.sav']='config-1', ['SYNTHETIC/expected.sav']='owned'}
local reads, writes, registered, registrations, aliasReads = 0, 0, false, 0, 0
local objectLookups, channelReads, channelWrites, loopCalls, gameCallbacks = 0, 0, 0, 0, 0
local questValue, goodVMClass, goodViewClass = 11004, true, true
local npcPropertyValid, npcPropertyInt, npcPropertyOffset = true, true, 0x188
local layoutChecks=0
local npcProperty={IsValid=function() return npcPropertyValid end,
    IsA=function(_,propertyType) assert(propertyType==PropertyTypes.IntProperty); return npcPropertyInt end,
    GetOffset_Internal=function() layoutChecks=layoutChecks+1; return npcPropertyOffset end}
local function obj(name, props)
    props=props or {}; props.IsValid=function() return true end
    props.GetFullName=function() return name end
    return props
end
local worldName,pawnName='World LV_Synthetic','Pawn Synthetic'
local world=obj(worldName); local pawn=obj(pawnName)
local gi=obj('GI',{bIsFighting=false,bDisableInputMove=false})
local pc=obj('PC',{K2_GetPawn=function() return pawn end})
local ready, viewVisible, optionVisible, worldType = true, false, false, 1
local optionTexts={'买把新的比较好','重新锻造一番吧'}
local countOverride, throwText, failGetter, failRegistration = nil, false, false, false
local options=setmetatable({GetArrayNum=function() return countOverride or #optionTexts end},{
    __index=function(_,index)
        assert(type(index)=='number' and index>=1 and index<=#optionTexts,'out-of-range read')
        reads=reads+1
        return {Text={ToString=function() if throwText then error('synthetic text failure') end; return optionTexts[index] end}}
    end,
    __newindex=function() writes=writes+1; error('synthetic array mutation') end,
})
local vm=obj('DialogModuleVM Synthetic',{CurrentNPCId=10038,Options=options,
    IsA=function(_,name) assert(name=='/Script/JH.DialogModuleVM'); return goodVMClass end,
    Reflection=function() return {GetProperty=function(_,name) assert(name=='CurrentNPCId'); return npcProperty end} end,
    GetOptionIsVisual=function() return optionVisible end})
setmetatable(vm,{__index=function(_,name)
    assert(name=='YijianJournalQuestId','unexpected private field')
    assert(registered,'alias read before registration'); aliasReads=aliasReads+1; return questValue
end,__newindex=function(_,name,value)
    assert(name~='YijianJournalQuestId','alias must never be written'); rawset(vm,name,value)
end})
local view=obj('DialogModuleListVE Synthetic',{IsVisible=function() return viewVisible end,
    IsA=function(_,name) assert(name=='/Script/JH.DialogModuleListVE'); return goodViewClass end})
local ui=obj('UI',{IsInDefaultStatus=function() return ready end,
    ShouldDisableInput=function() return false end, ShouldDisableInputForUI=function() return false end,
    QueryNeoUIFocusModule=function() return nil end,
    GetDialogModule=function() if failGetter then error('synthetic getter failure') end; return vm end,
    GetDialogView=function() return view end})
local saved,loaded=0,0
local sm=obj('SM',{AutoSaveIndex=7,GetSaveGameName=function() return {ToString=function() return 'previous' end} end,
    SetSaveGameName=function(_,name) assert(name=='previous') end,
    SaveSlot=function(_,slot,auto,name) assert(slot==29 and auto==true and name=='Yijian Journal Timeline'); saved=saved+1;
        files[source..'/JHSaveConfig.sav']='config-2'; return true end,
    LoadSlot=function(_,slot) assert(slot==29); loaded=loaded+1 end})
local lib=obj('ManagerFuncLib',{GetGameInstance=function() return gi end,GetSaveManager=function() return sm end,
    GetCurrentWorld=function() return world end,GetPlayerController=function() return pc end,
    GetWorldType=function() return worldType end})
local system=obj('KismetSystemLibrary',{GetProjectSavedDirectory=function() return {ToString=function() return 'C:/Synthetic' end} end})
function StaticFindObject(name)
    objectLookups=objectLookups+1
    if name=='/Script/JH.Default__ManagerFuncLib' then return lib end
    if name=='/Script/JH.DialogModuleVM' then return obj('Class /Script/JH.DialogModuleVM') end
    if name=='/Script/Engine.Default__KismetSystemLibrary' then return system end
    error('unapproved object lookup '..name)
end
function FindFirstOf(name) objectLookups=objectLookups+1; assert(name=='JHNeoUISubsystem'); return ui end
PropertyTypes={IntProperty={Name='IntProperty',Size=4}}
function RegisterCustomProperty(info)
    if failRegistration then error('synthetic registration failure') end
    assert(info.Name=='YijianJournalQuestId' and info.Type==PropertyTypes.IntProperty)
    assert(info.Type.Name=='IntProperty' and info.Type.Size==4)
    assert(info.BelongsToClass=='/Script/JH.DialogModuleVM' and info.OffsetInternal==0x184)
    local fields=0; for _ in pairs(info) do fields=fields+1 end; assert(fields==4)
    registrations=registrations+1; registered=true
end
function RegisterHook() error('dialogue observation must not require hooks') end
function YijianNativeInitialize(root,revision) assert(root=='SYNTHETIC/' and #revision==64); return 'unicode-v2' end
function YijianNativeRead(file) channelReads=channelReads+1; if files[file] then return files[file],'ok' end; return nil,'missing' end
function YijianNativeWrite(file,bytes) channelWrites=channelWrites+1; files[file]=bytes; return 'ok' end
function LoopAsync(ms,callback) loopCalls=loopCalls+1; assert(ms==1000); loop=callback end
function ExecuteInGameThread(callback) gameCallbacks=gameCallbacks+1; callback() end
local function pulse(label)
    loop(); assert(files['SYNTHETIC/state.json'],'state missing')
    io.write(label..'\\t'..files['SYNTHETIC/state.json']..'\\n')
end
local function opened(quest,npc)
    questValue=quest or 11004; vm.CurrentNPCId=npc or 10038
end
`;
{
  const name = 'native EXE rejection stops before any object, alias, field, channel or heartbeat access';
  const result = spawnSync(interpreter, ['-'], {
    input:
      setup +
      `
function YijianNativeInitialize() return nil,'unsupported_game_executable' end
local ok,err=pcall(assert(load([====[${source}]====])))
assert(ok==false and tostring(err):find('unicode_component_binding: unsupported_game_executable',1,true))
assert(objectLookups==0 and registrations==0 and aliasReads==0 and layoutChecks==0 and reads==0 and writes==0)
assert(channelReads==0 and channelWrites==0 and loopCalls==0 and gameCallbacks==0 and loop==nil)
assert(files['SYNTHETIC/state.json']==nil)
`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.error, undefined, name + ': ' + result.error?.message);
  assert.equal(result.status, 0, name + ': ' + result.stderr);
  console.log('ok · ' + name);
}
function run(name, body, expectations) {
  const program = setup + '\n' + `assert(load([====[${source}]====]))()\n` + body;
  const result = spawnSync(interpreter, ['-'], {
    input: program,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.error, undefined, name + ': ' + result.error?.message);
  assert.equal(result.status, 0, name + ': ' + result.stderr);
  const frames = new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('\t');
        return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
      }),
  );
  expectations(frames);
  console.log('ok · ' + name);
}
const absent = (frames, ...labels) => {
  for (const label of labels) assert.equal(frames.get(label)?.dialogue, null, label);
};
const observed = (frame, questId = 11004) => {
  assert.equal(frame.dialogue.questId, questId);
  assert.equal(frame.dialogue.npcId, 10038);
  assert.deepEqual(frame.dialogue.options, [
    { index: 1, text: '买把新的比较好' },
    { index: 2, text: '重新锻造一番吧' },
  ]);
};
run(
  'current typed private getter and already-filtered display order',
  `
pulse('before'); opened(); ready=false; viewVisible=true; optionVisible=true; pulse('open')
assert(reads==2 and writes==0 and registrations==1 and aliasReads==1 and layoutChecks==1)
`,
  (f) => {
    absent(f, 'before');
    observed(f.get('open'));
    assert.equal(f.get('open').ready, false);
  },
);
run(
  'stable sampling shares a sequence and a reopened window receives a new one',
  `pulse('before'); viewVisible=true; optionVisible=true; pulse('open'); pulse('same')
viewVisible=false; pulse('closed'); viewVisible=true; pulse('new'); assert(registrations==1)`,
  (f) => {
    observed(f.get('open'));
    observed(f.get('new'));
    assert.equal(f.get('open').dialogue.sequence, 1);
    assert.equal(f.get('same').dialogue.sequence, 1);
    assert.equal(f.get('new').dialogue.sequence, 2);
    absent(f, 'closed');
  },
);
run(
  'native direct-call choices are read without any UFunction hook',
  `
pulse('before'); ready=false; viewVisible=true; optionVisible=true; pulse('unobserved')
`,
  (f) => {
    absent(f, 'before');
    observed(f.get('unobserved'));
  },
);
run(
  'neither a hidden view nor dialogue before options emits a choice',
  `
pulse('before'); opened(); pulse('pending'); now=now+2; viewVisible=true; pulse('view')
now=now+10; optionVisible=true; ready=false; pulse('options')
`,
  (f) => {
    absent(f, 'pending', 'view');
    observed(f.get('options'));
  },
);
run(
  'inactive dialogue never emits remembered choices',
  `
pulse('before'); opened(); now=now+4; pulse('expired'); viewVisible=true; optionVisible=true; pulse('late')
`,
  (f) => {
    absent(f, 'expired');
    observed(f.get('late'));
  },
);
for (const [name, exit, resume] of [
  ['view closes', 'viewVisible=false', 'viewVisible=true'],
  ['options close', 'optionVisible=false', 'optionVisible=true'],
  ['battle', 'gi.bIsFighting=true', 'gi.bIsFighting=false'],
  ['cutscene', 'worldType=2', 'worldType=1'],
])
  run(
    name + ' revokes the previous observation',
    `
pulse('before'); opened(); ready=false; viewVisible=true; optionVisible=true; pulse('open')
${exit}; pulse('exit'); ${resume}; pulse('resume'); opened(); pulse('new')
`,
    (f) => {
      observed(f.get('open'));
      absent(f, 'exit');
      observed(f.get('resume'));
      assert.ok(f.get('resume').dialogue.sequence > f.get('open').dialogue.sequence);
      observed(f.get('new'));
    },
  );
run(
  'changed current option sets receive fresh window sequences',
  `
pulse('before'); opened(); viewVisible=true; optionVisible=true; pulse('open')
optionTexts={'另一组选择'}; pulse('changed'); optionTexts={'买把新的比较好','重新锻造一番吧'}; pulse('old')
`,
  (f) => {
    observed(f.get('open'));
    assert.deepEqual(f.get('changed').dialogue.options, [{ index: 1, text: '另一组选择' }]);
    observed(f.get('old'));
    assert.ok(f.get('changed').dialogue.sequence > f.get('open').dialogue.sequence);
    assert.ok(f.get('old').dialogue.sequence > f.get('changed').dialogue.sequence);
  },
);
for (const [name, mutate] of [
  ['world', "world=obj('World New Synthetic')"],
  ['pawn', "pawn=obj('Pawn New Synthetic')"],
  ['VM', "vm.GetFullName=function() return 'DialogModuleVM New Synthetic' end"],
  ['quest', 'questValue=11005'],
  ['NPC', 'vm.CurrentNPCId=10039'],
])
  run(
    name + ' identity cannot reuse an earlier window sequence',
    `pulse('before'); viewVisible=true; optionVisible=true; pulse('open'); ${mutate}; pulse('changed')`,
    (f) => {
      assert.ok(f.get('changed').dialogue.sequence > f.get('open').dialogue.sequence);
      if (name === 'quest') assert.equal(f.get('changed').dialogue.questId, 11005);
      if (name === 'NPC') assert.equal(f.get('changed').dialogue.npcId, 10039);
    },
  );
for (const [name, mutate] of [
  ['negative count', 'countOverride=-1'],
  ['fractional count', 'countOverride=1.5'],
  ['oversized count', 'countOverride=17'],
  ['empty text', "optionTexts={''}"],
  ['oversized text', "optionTexts={string.rep('a',513)}"],
  ['total text budget', "optionTexts={}; for i=1,9 do optionTexts[i]=string.rep('a',512) end"],
  ['NUL text', "optionTexts={'a'..string.char(0)..'b'}"],
  ['text exception', 'throwText=true'],
  ['getter exception', 'failGetter=true'],
  ['invalid NPC', 'vm.CurrentNPCId=-1'],
  ['invalid quest', 'questValue=0'],
  ['VM class mismatch', 'goodVMClass=false'],
  ['view class mismatch', 'goodViewClass=false'],
  ['wrong property type', "PropertyTypes.IntProperty.Name='FloatProperty'"],
  ['wrong property size', 'PropertyTypes.IntProperty.Size=8'],
  ['missing reflected NPC property', 'npcPropertyValid=false'],
  ['wrong reflected NPC type', 'npcPropertyInt=false'],
  ['moved reflected NPC offset', 'npcPropertyOffset=0x180'],
  ['missing reflection API', 'vm.Reflection=nil'],
  ['missing reflected offset API', 'npcProperty.GetOffset_Internal=nil'],
  ['missing property API', 'RegisterCustomProperty=nil'],
])
  run(
    name + ' withdraws dialogue without changing command readiness',
    `
pulse('before'); opened(); viewVisible=true; optionVisible=true; ${mutate}; pulse('invalid')
assert(writes==0)
${/class mismatch|property type|property size|property API|reflected|reflection API/.test(name) ? 'assert(aliasReads==0 and registrations==0)' : ''}
`,
    (f) => {
      absent(f, 'invalid');
      assert.equal(f.get('invalid').ready, true);
    },
  );
run(
  'a changed reflected layout blocks reads even after successful registration',
  `
viewVisible=true; optionVisible=true; pulse('open'); assert(aliasReads==1 and registrations==1)
npcPropertyOffset=0x180; pulse('moved'); assert(aliasReads==1 and registrations==1)
npcPropertyOffset=0x188; pulse('new'); assert(aliasReads==2 and registrations==1 and writes==0)
`,
  (f) => {
    observed(f.get('open'));
    absent(f, 'moved');
    assert.equal(f.get('moved').ready, true);
    observed(f.get('new'));
    assert.ok(f.get('new').dialogue.sequence > f.get('open').dialogue.sequence);
  },
);
run(
  'property registration failure is isolated and retryable',
  `
viewVisible=true; optionVisible=true; failRegistration=true; pulse('unavailable'); assert(registered==false)
failRegistration=false; pulse('open')
`,
  (f) => {
    absent(f, 'unavailable');
    observed(f.get('open'));
    assert.equal(f.get('unavailable').ready, true);
  },
);
run(
  'JSON escaping preserves necessary option text without copying full dialogue',
  `
pulse('before'); opened(); viewVisible=true; optionVisible=true; optionTexts={'引号"与\\\\斜线\\n换行'}; pulse('text')
`,
  (f) => assert.equal(f.get('text').dialogue.options[0].text, '引号"与\\斜线\n换行'),
);
for (const verb of ['save', 'load'])
  run(
    'native ' + verb + ' suppresses dialogue and preserves reserved-slot dispatch',
    `
pulse('before')
local session=files['SYNTHETIC/state.json']:match('"session":"([^"]+)"')
files['SYNTHETIC/command.txt']=token..'\\t'..session..'\\t'..'00000000-0000-0000-0000-000000000001'..'\\t${verb}\\t'..(now+10)..'\\towned\\n'
pulse('command'); opened(); viewVisible=true; optionVisible=true; ready=false; pulse('busy')
assert(${verb === 'save' ? 'saved==1 and loaded==0' : 'loaded==1 and saved==0'})
`,
    (f) => absent(f, 'busy'),
  );
console.log('Lua synthetic dialogue smoke passed; game and personal saves were never accessed.');
