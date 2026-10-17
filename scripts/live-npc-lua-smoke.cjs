'use strict';
// All UE objects and channel files below are synthetic. No UE4SS or game starts.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const interpreter = process.env.YIJIAN_LUA_BIN;
if (!interpreter) throw Error('Set YIJIAN_LUA_BIN to the development Lua interpreter');
const source = fs
  .readFileSync(path.join(__dirname, '../src/game-bridge/main.lua'), 'utf8')
  .replace('__JOURNAL_ROOT__', '"SYNTHETIC/"')
  .replace('__JOURNAL_REVISION__', '"' + 'a'.repeat(64) + '"');
const setup = String.raw`
local now,loop,serial=1800000000,nil,100
os.time=function() return now end
local files={},dummy
local token=string.rep('b',64)
local saveSource='C:/Synthetic/76561190000000000/SaveGames'
files['SYNTHETIC/config.txt']=token..'\n'..saveSource..'\nobserve\n'
local objectWrites,arrayReads,blobWrites,macCalls,aliases=0,0,0,0,0
local classes,metadata,properties={},{},{}
local function readonly(data)
    return setmetatable({}, {__index=data,__newindex=function() objectWrites=objectWrites+1; error('object mutation') end})
end
local function object(class,name,values,fields)
    serial=serial+1; local id=serial
    values=values or {}; fields=fields or {}
    values.IsValid=function() return true end
    values.GetAddress=function() return id end
    values.GetFullName=function() return name or 'Object '..class end
    values.GetClass=function() return classes[class] end
    values.IsA=function(_,wanted) return class==wanted end
    values.GetOuter=function() return values.outer end
    values.Reflection=function() return {GetProperty=function(_,key) return fields[key] end} end
    local o=readonly(values)
    return o,values,fields
end
for _,kind in ipairs({'IntProperty','Int8Property','FloatProperty','MapProperty','ObjectProperty','ArrayProperty','StructProperty','NameProperty','BoolProperty','EnumProperty'}) do
    PropertyTypes=PropertyTypes or {}; PropertyTypes[kind]={Name=kind,Size=kind=='Int8Property' and 1 or 4}
end
local classPaths={'/Script/JH.TeamInfo','/Script/JH.NPCManager','/Script/JH.QuestManager','/Script/JH.SaveManager',
    '/Script/JH.JHAttributeSet','/Script/JH.ItemInfoSpec','/Script/CoreUObject.ScriptStruct','/Script/JH.JHSaveGameConfig','/Script/JH.JHSaveGame'}
for _,c in ipairs(classPaths) do classes[c]=object('/Script/CoreUObject.Class','Class '..c) end
local function property(kind,offset,target,inner)
    local p,d=object('Property',kind,{})
    d.IsA=function(_,t) return t==PropertyTypes[kind] end
    d.GetOffset_Internal=function() return offset end
    d.GetStruct=function() return metadata[target] end
    d.GetPropertyClass=function() return classes[target] end
    d.GetInner=function() return inner end
    return p,d
end
local function fields(spec)
    local out={}; for _,r in ipairs(spec) do out[r[1]]=property(r[2],r[3],r[4],r[5]) end; return out
end
local function structure(class,values,spec)
    local m=metadata[class]
    if not m then m=object('/Script/CoreUObject.ScriptStruct','ScriptStruct '..class,{},fields(spec)); metadata[class]=m end
    local v,d,p=object('/Script/CoreUObject.ScriptStruct','ScriptStruct '..class,values,fields(spec))
    d.IsMappedToObject=function() return true end
    return v,d,p
end
structure('/Script/GameplayAbilities.GameplayAttributeData',{},{{'CurrentValue','FloatProperty',0xc}})
structure('/Script/JH.SkillSpec',{},{{'Id','IntProperty',0},{'Level','IntProperty',4}})
structure('/Script/JH.NPCLocation',{},{{'MapName','NameProperty',0xc},{'IsVisible','BoolProperty',0x14}})
structure('/Script/JH.RequirementSetting',{},{{'Type','EnumProperty',0},{'Id','IntProperty',4},{'Num','FloatProperty',8}})
local function array(rows)
    local d={GetArrayNum=function() return #rows end}
    return setmetatable({}, {__index=function(_,k)
        if type(k)=='number' then assert(k>=1 and k<=#rows,'out of range array read'); arrayReads=arrayReads+1; return rows[k] end
        return d[k]
    end,__newindex=function() error('array mutation') end})
end
local function map(rows,after)
    return {ForEach=function(_,fn)
        for _,r in ipairs(rows) do
            local stop=fn({get=function() return r[1] end,set=function() error('map key mutation') end},
                {get=function() return r[2] end,set=function() error('map value mutation') end})
            if stop==true then break end
        end
        if after then after() end
    end,Find=function() error('unneeded map getter') end}
end
local gi,giData=object('GI','GI Synthetic',{bIsFighting=false,bDisableInputMove=false})
local world,worldData=object('World','World /Synthetic.LV_25_P',{OwningGameInstance=gi})
local pawn=object('Pawn','Pawn Synthetic')
local pc=object('PC','PC Synthetic',{K2_GetPawn=function() return pawn end})
local ui=object('UI','UI Synthetic',{IsInDefaultStatus=function() return true end,ShouldDisableInput=function() return false end,
    ShouldDisableInputForUI=function() return false end,QueryNeoUIFocusModule=function() return nil end,GetDialogModule=function() return nil end})
local sm,smData,smFields=object('/Script/JH.SaveManager','SaveManager Synthetic',{outer=gi,AutoSaveIndex=7,YijianJournalLoadBusy=0},fields({
    {'GameSaveConfig','ObjectProperty',0x38,'/Script/JH.JHSaveGameConfig'},{'LastLoadSaveData','ObjectProperty',0x50,'/Script/JH.JHSaveGame'}}))
local nm,nmData=object('/Script/JH.NPCManager','NPCManager Synthetic',{outer=gi},fields({{'NPCInfos','MapProperty',0x80}}))
local qm,qmData=object('/Script/JH.QuestManager','QuestManager Synthetic',{outer=gi},fields({{'QuestProcesses','MapProperty',0x38},{'FinishQuests','MapProperty',0x88}}))
local attributeRows={{'Level',0x90},{'JingLi',0x70},{'DaZaoLevel',0x330},{'ZhiYiLevel',0x3f0},
    {'FishingLevel',0x410},{'CookingLevel',0x430},{'AlchemyLevel',0x450},{'GatheringLevel',0x470},
    {'AttackPower',0xe0},{'Crit',0xf0},{'TurnRate',0x150},{'Defense',0x110},{'Dodge',0x120},{'MaxHealth',0x40},{'MaxMana',0x60}}
local function npc(id,owner)
    local vals,props={},{}
    for _,a in ipairs(attributeRows) do
        vals[a[1]]=structure('/Script/GameplayAbilities.GameplayAttributeData',{CurrentValue=10,BaseValue=9999},{{'CurrentValue','FloatProperty',0xc}})
        props[a[1]]=property('StructProperty',a[2],'/Script/GameplayAbilities.GameplayAttributeData')
    end
    local attr=object('/Script/JH.JHAttributeSet',nil,vals,props)
    local item=object('/Script/JH.ItemInfoSpec',nil,{ItemDefId=100034,Num=2},fields({{'ItemDefId','IntProperty',0x3c},{'Num','IntProperty',0x40}}))
    local skill=structure('/Script/JH.SkillSpec',{Id=850,Level=3},{{'Id','IntProperty',0},{'Level','IntProperty',4}})
    local loc=structure('/Script/JH.NPCLocation',{MapName={ToString=function() return 'LV_25_P' end},IsVisible=true},
        {{'MapName','NameProperty',0xc},{'IsVisible','BoolProperty',0x14}})
    return object('/Script/JH.TeamInfo','TeamInfo '..id,{outer=owner,NPCId=id,GuildId=1,SkillExp=500,
        AttributeSet=attr,ItemSpecs=array({item}),SkillSpecs=array({skill}),Friendliness=map({{0,70}}),NPCLocation=loc},
        fields({{'NPCId','IntProperty',0x38},{'GuildId','IntProperty',0x3c},{'AttributeSet','ObjectProperty',0x60,'/Script/JH.JHAttributeSet'},
        {'ItemSpecs','ArrayProperty',0x78,nil,property('ObjectProperty',0,'/Script/JH.ItemInfoSpec')},
        {'SkillSpecs','ArrayProperty',0xa0,nil,property('StructProperty',0,'/Script/JH.SkillSpec')},
        {'Friendliness','MapProperty',0x110},{'SkillExp','IntProperty',0x200},{'NPCLocation','StructProperty',0x208,'/Script/JH.NPCLocation'}}))
end
local player,playerData,playerFields=npc(0,gi)
local teacher,teacherData,teacherFields=npc(10038,nm)
local npcRows={{0,player},{10038,teacher}}
nmData.NPCInfos=map(npcRows)
local function counter(kind,id,value) return structure('/Script/JH.RequirementSetting',{Type=kind,Id=id,Num=value},
    {{'Type','EnumProperty',0},{'Id','IntProperty',4},{'Num','FloatProperty',8}}) end
local function quest(id,step,progress) return structure('/Script/JH.QuestSpec',{QuestId=id,Step=step,QuestProgracessData=array(progress or {})},
    {{'QuestId','IntProperty',0},{'Step','EnumProperty',4},
    {'QuestProgracessData','ArrayProperty',8,nil,property('StructProperty',0,'/Script/JH.RequirementSetting')}}) end
local activeRows={{12071,quest(12071,1)},{12094,quest(12094,1)}}
qmData.QuestProcesses=map(activeRows)
qmData.FinishQuests=map({{12071,quest(12071,4)}})
local lib=object('Lib','Lib',{GetGameInstance=function() return gi end,GetCurrentWorld=function() return world end,
    GetPlayerController=function() return pc end,GetWorldType=function() return 1 end,
    GetSaveManager=function() error('mutating subsystem getter') end,GetNPCManager=function() error('mutating getter') end})
function StaticFindObject(name) if name=='/Script/JH.Default__ManagerFuncLib' then return lib end; error('unexpected lookup') end
function FindFirstOf(name) assert(name=='JHNeoUISubsystem'); return ui end
local extraManager=nil
function FindAllOf(name)
    if name=='SaveManager' then return {sm} end
    if name=='NPCManager' then return extraManager and {nm,extraManager} or {nm} end
    if name=='QuestManager' then return {qm} end
    error('unexpected enumeration')
end
function RegisterCustomProperty(info)
    assert(info.Name=='YijianJournalLoadBusy' and info.Type.Name=='Int8Property' and info.Type.Size==1 and info.OffsetInternal==0x9c)
    assert(info.BelongsToClass=='/Script/JH.SaveManager'); aliases=aliases+1
end
function YijianNativeInitialize() return 'unicode-v2' end
function YijianNativeRead(file) return files[file],files[file] and 'ok' or 'missing' end
function YijianNativeWrite(file,bytes)
    assert(file:sub(1,10)=='SYNTHETIC/','game-path write')
    if file=='SYNTHETIC/npc-observation.json' then blobWrites=blobWrites+1 end
    files[file]=bytes; return 'ok'
end
function YijianNativeObservationMac(bytes) assert(#bytes<=4194304); macCalls=macCalls+1; return string.rep('c',64) end
function LoopAsync(_,fn) loop=fn end
function ExecuteInGameThread(fn) fn() end
local function pulse(name)
    loop(); assert(objectWrites==0,'game mutated')
    io.write(name..'\t'..files['SYNTHETIC/state.json']..'\n')
    if files['SYNTHETIC/npc-observation.json'] then io.write(name..'-blob\t'..files['SYNTHETIC/npc-observation.json']..'\n') end
end
`;
const run = (name, body, check) => {
  const r = spawnSync(interpreter, ['-'], {
    input: setup + '\n' + source + '\n' + body,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(r.error, undefined, name + ': ' + r.error?.message);
  assert.equal(r.status, 0, name + ': ' + r.stderr);
  const output = new Map(
    r.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const p = line.indexOf('\t');
        return [line.slice(0, p), JSON.parse(line.slice(p + 1))];
      }),
  );
  check(output);
  console.log('ok · ' + name);
};
run(
  'complete same-thread copy, current floats, loaded NPC owner and dual quest-map priority',
  'pulse("first"); assert(aliases==1 and blobWrites==1 and arrayReads==4 and macCalls==2)',
  (f) => {
    assert(f.get('first').npcObservation);
    const b = f.get('first-blob');
    assert.equal(b.npcs.length, 2);
    assert.equal(b.npcs[1].inventory[0].count, 2);
    assert.equal(b.npcs[0].attributes[44], 10);
    assert.equal(b.quests.find((q) => q.id === 12071).step, 1);
  },
);
run(
  'unchanged fresh full re-copy advances sequence without rewriting blob',
  'pulse("first"); now=now+1; pulse("again"); assert(blobWrites==1 and arrayReads==8 and macCalls==3)',
  (f) => {
    assert.equal(f.get('again').npcObservation.version, f.get('first').npcObservation.version);
    assert(f.get('again').npcObservation.sequence > f.get('first').npcObservation.sequence);
  },
);
run(
  'empty private bag is published as a changed full observation',
  'pulse("first"); teacherData.ItemSpecs=array({}); now=now+1; pulse("empty"); assert(blobWrites==2)',
  (f) => {
    assert.deepEqual(f.get('empty-blob').npcs[1].inventory, []);
  },
);
run(
  'quest-local float counters refresh the signed blob and keep current-map priority',
  'local p,pData=counter(25,3,2); activeRows[1][2]=quest(12071,1,{p}); qmData.FinishQuests=map({{12071,quest(12071,4,{(counter(25,3,99))})}}); pulse("first"); pData.Num=3; now=now+1; pulse("changed"); assert(blobWrites==2)',
  (f) => {
    assert.deepEqual(f.get('first-blob').quests.find((q) => q.id === 12071).progress, [
      { type: 25, id: 3, value: 2 },
    ]);
    assert.deepEqual(f.get('changed-blob').quests.find((q) => q.id === 12071).progress, [
      { type: 25, id: 3, value: 3 },
    ]);
    assert(f.get('changed').npcObservation.version > f.get('first').npcObservation.version);
  },
);
for (const [name, change] of [
  ['load byte', 'smData.YijianJournalLoadBusy=1'],
  ['pending save object', 'smData.LastLoadSaveData=object("/Script/JH.JHSaveGame")'],
  ['wrong owner', 'teacherData.outer=object("OtherGI")'],
  ['NPC key mismatch', 'teacherData.NPCId=77'],
  ['malformed private bag', 'teacherData.ItemSpecs=array({nil})'],
  ['wrong field layout', 'playerFields.NPCId=property("IntProperty",0x39)'],
  ['duplicate manager', 'extraManager=object("/Script/JH.NPCManager","Other NPCManager",{outer=gi})'],
  ['wrong map owner', 'worldData.OwningGameInstance=object("OtherGI")'],
  ['missing player', 'nmData.NPCInfos=map({{10038,teacher}})'],
  ['duplicate NPC key', 'nmData.NPCInfos=map({{0,player},{10038,teacher},{10038,teacher}})'],
  ['quest map malformed', 'qmData.QuestProcesses=map({{12071,quest(12072,1)}})'],
  [
    'before/after load transition',
    'qmData.FinishQuests=map({},function() smData.YijianJournalLoadBusy=1 end)',
  ],
  ['array count overflow', 'teacherData.ItemSpecs={GetArrayNum=function() return 10001 end}'],
  ['fractional NPC ID', 'nmData.NPCInfos=map({{0,player},{10038.5,teacher}})'],
  ['progress NaN', 'activeRows[1][2]=quest(12071,1,{(counter(22,45045,0/0))})'],
  ['progress infinity', 'activeRows[1][2]=quest(12071,1,{(counter(22,45045,math.huge))})'],
  ['progress negative', 'activeRows[1][2]=quest(12071,1,{(counter(22,45045,-1))})'],
  ['progress duplicate', 'activeRows[1][2]=quest(12071,1,{(counter(22,45045,1)),(counter(22,45045,5))})'],
  [
    'progress wrong layout',
    'local p,d,props=counter(22,45045,2); props.Num=property("IntProperty",8); activeRows[1][2]=quest(12071,1,{p})',
  ],
  [
    'progress wrong inner',
    'local q,d,props=quest(12071,1); props.QuestProgracessData=property("ArrayProperty",8,nil,property("StructProperty",0,"/Script/JH.SkillSpec")); activeRows[1][2]=q',
  ],
  [
    'progress count overflow',
    'local q,d=quest(12071,1); d.QuestProgracessData={GetArrayNum=function() return 1001 end}; activeRows[1][2]=q',
  ],
]) {
  const actual =
    name === 'malformed private bag' ? 'teacherData.ItemSpecs=array({object("WrongItem")})' : change;
  run('withdraw incomplete sample: ' + name, `pulse("first"); ${actual}; now=now+1; pulse("bad")`, (f) => {
    assert(f.get('first').npcObservation);
    assert.equal(f.get('bad').npcObservation, null);
  });
}
run(
  'load withdrawal cannot revive an old sample and new cohort gets a new epoch',
  'pulse("first"); smData.YijianJournalLoadBusy=1; pulse("busy"); smData.YijianJournalLoadBusy=0; now=now+1; pulse("new")',
  (f) => {
    assert.equal(f.get('busy').npcObservation, null);
    assert.equal(f.get('busy').ready, false, 'manual loading suppresses every native hint');
    assert.equal(f.get('busy').reason, '正在读档');
    assert.equal(f.get('busy').dialogue, null);
    assert(f.get('new').npcObservation.epoch > f.get('first').npcObservation.epoch);
  },
);
console.log('Lua synthetic NPC smoke passed; no game or personal save access.');
