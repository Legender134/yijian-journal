-- 逸剑手札 native save/load bridge. UE4SS 3.0.1-1152, game Build 21798996.
-- No arbitrary commands: only the reserved manual slot 29 is accessible.
local root = __JOURNAL_ROOT__
local revision = __JOURNAL_REVISION__
-- These functions are registered by the hash-pinned YijianJournalUnicode C++ mod.
-- Never fall back to narrow CRT disk I/O or inherit a protocol-1 source grant.
if type(YijianNativeInitialize) ~= 'function' then error('unicode_component_missing') end
local bound, bindError = YijianNativeInitialize(root, revision)
if bound ~= 'unicode-v2' then error('unicode_component_binding: '..tostring(bindError)) end
local session = tostring(os.time()) .. '-' .. tostring(math.random(100000, 999999))
local last, loading, saving, queued = '', nil, nil, false
local boundSource = nil
local function valid(o) return o and o:IsValid() end
local function read(file, limit)
    return YijianNativeRead(file, limit)
end
local function write(file, bytes)
    local ok, err = YijianNativeWrite(file, bytes)
    if ok ~= 'ok' then error('bridge_write_failed: '..tostring(err)) end
end
local function quote(s)
    return '"' .. tostring(s):gsub('[%z\1-\31\\"]', function(c)
        if c == '\\' then return '\\\\' end
        if c == '"' then return '\\"' end
        return string.format('\\u%04x', string.byte(c))
    end) .. '"'
end
local function normalized(s) return s:gsub('\\', '/'):gsub('/+$', ''):lower() end
local function respond(id, token, status, reason)
    write(root .. 'response.json', '{"id":' .. quote(id) .. ',"token":' .. quote(token) .. ',"session":' .. quote(session) .. ',"status":' .. quote(status) .. ',"reason":' .. quote(reason or '') .. ',"at":' .. os.time() .. '}')
end
-- Fixed-build read-only alias: StartShowDialog writes an int32 QuestId at
-- 0x184 in DialogModuleVM (size 0x260), immediately before CurrentNPCId at
-- 0x188. NativeInitialize pins the actual process EXE before this script can
-- look up game objects; GameBridge independently checks component/script hashes.
-- pcall is only failure isolation, never a substitute for the pinned layout.
local dialogueOpen, dialogueSequence, dialoguePropertyReady = nil, 0, false
local function integer(n, low, high)
    return type(n) == 'number' and n == math.floor(n) and n >= low and n <= high
end
-- Existing objects and reflected fields only. Native convenience getters can
-- create missing NPCs, initialize subsystems or write caches on a query.
local function address(o)
    if not valid(o) then error('invalid_object') end
    return tostring(o:GetAddress())
end
local function manager(name, gi)
    local candidates, found = FindAllOf(name) or {}, nil
    if #candidates > 512 then error('manager_count') end
    for _, o in ipairs(candidates) do
        if valid(o) and o:IsA('/Script/JH.'..name) == true and
            not o:GetFullName():find('Default__',1,true) and address(o:GetOuter()) == address(gi) then
            if found then error('ambiguous_manager') end
            found=o
        end
    end
    return found
end
local observationEpoch, observationVersion, observationSequence = 0, 0, 0
local observationIdentity, observationContent, observationRef, loadAliasReady = nil, nil, nil, false
-- This guard precedes command readiness and the loaded receipt as well as
-- observation. A new pawn alone is not evidence that native loading ended.
local function loadPending(sm)
    local objectType=type(PropertyTypes)=='table' and PropertyTypes.ObjectProperty or nil
    local byte=type(PropertyTypes)=='table' and PropertyTypes.Int8Property or nil
    if type(objectType)~='table' or objectType.Name~='ObjectProperty' or
        type(byte)~='table' or byte.Name~='Int8Property' or byte.Size~=1 then error('load_property_type') end
    for _,anchor in ipairs({{'GameSaveConfig',0x38,'/Script/JH.JHSaveGameConfig'},
        {'LastLoadSaveData',0x50,'/Script/JH.JHSaveGame'}}) do
        local p=sm:Reflection():GetProperty(anchor[1])
        if not valid(p) or p:IsA(objectType)~=true or p:GetOffset_Internal()~=anchor[2] then error('load_layout') end
        local class=p:GetPropertyClass()
        if not valid(class) or class:GetFullName():match('(/Script/[^ ]+)$')~=anchor[3] then error('load_target') end
    end
    if not loadAliasReady then
        RegisterCustomProperty({Name='YijianJournalLoadBusy',Type=byte,BelongsToClass='/Script/JH.SaveManager',OffsetInternal=0x9c})
        loadAliasReady=true
    end
    local busy=sm.YijianJournalLoadBusy
    if busy~=0 and busy~=1 then error('load_busy_value') end
    return busy==1 or valid(sm.LastLoadSaveData)
end
local function npcObservation(s, source, token)
    local function withdraw()
        observationIdentity=nil; observationContent=nil; observationRef=nil
        return 'null'
    end
    if token == '' or source == '' or not s.dialogueAllowed or loading or saving then return withdraw() end
    local ok, result = pcall(function()
        local checked = {}
        local function field(o, name, kind, offset, target)
            local class=o:GetClass()
            local key=(class:GetFullName():find('ScriptStruct',1,true) and o:GetFullName() or address(class))..':'..name
            if checked[key] then return end
            local t=PropertyTypes[kind]
            if type(t) ~= 'table' or t.Name ~= kind then error('field_type') end
            local p=o:Reflection():GetProperty(name)
            if not valid(p) or p:IsA(t) ~= true or p:GetOffset_Internal() ~= offset then error('field_layout') end
            if target then
                local innerKind,innerTarget=target:match('^(%w+):(/Script/.+)$')
                if kind == 'ArrayProperty' then
                    p=p:GetInner()
                    if not valid(p) or p:IsA(PropertyTypes[innerKind]) ~= true then error('array_inner') end
                    target=innerTarget; kind=innerKind
                end
                local c=kind == 'ObjectProperty' and p:GetPropertyClass() or kind == 'StructProperty' and p:GetStruct() or nil
                if not valid(c) or c:GetFullName():match('(/Script/[^ ]+)$') ~= target then error('field_target') end
            end
            checked[key]=true
        end
        local function structure(value, path, fields)
            if not valid(value) or value:IsMappedToObject() ~= true or value:GetFullName():match('(/Script/[^ ]+)$') ~= path then error('struct_type') end
            for _, f in ipairs(fields) do field(value,f[1],f[2],f[3]) end
        end
        local gi, sm = s.gi, s.sm
        if address(s.worldObject.OwningGameInstance) ~= address(gi) then error('world_owner') end
        if loadPending(sm) then error('load_busy') end
        local nm, qm=manager('NPCManager',gi), manager('QuestManager',gi)
        if not valid(nm) or not valid(qm) then error('missing_manager') end
        local function stable()
            if loadPending(sm) or gi.bIsFighting then error('load_busy') end
            if address(sm:GetOuter()) ~= address(gi) or address(nm:GetOuter()) ~= address(gi) or
                address(qm:GetOuter()) ~= address(gi) or address(s.worldObject.OwningGameInstance) ~= address(gi) or
                address(s.lib:GetCurrentWorld()) ~= address(s.worldObject) or address(s.pc:K2_GetPawn()) ~= address(s.pawnObject) then error('owner_changed') end
        end
        stable()
        field(nm,'NPCInfos','MapProperty',0x80)
        field(qm,'QuestProcesses','MapProperty',0x38)
        field(qm,'FinishQuests','MapProperty',0x88)
        local ids, rows, playerIdentity, budget = {}, {}, nil, 100000
        local attributes={
            {'Level',0x90,5},{'JingLi',0x70,44},{'DaZaoLevel',0x330,27},{'ZhiYiLevel',0x3f0,48},
            {'FishingLevel',0x410,61},{'CookingLevel',0x430,63},{'AlchemyLevel',0x450,65},{'GatheringLevel',0x470,67},
            {'AttackPower',0xe0,9},{'Crit',0xf0,10},{'TurnRate',0x150,14},{'Defense',0x110,11},
            {'Dodge',0x120,12},{'MaxHealth',0x40,2},{'MaxMana',0x60,4}}
        local function array(a, maximum, copy)
            local count=a:GetArrayNum()
            if not integer(count,0,maximum) then error('array_count') end
            local out={}
            for i=1,count do
                budget=budget-1; if budget < 0 then error('collection_budget') end
                out[#out+1]=copy(a[i])
            end
            table.sort(out)
            return '['..table.concat(out,',')..']'
        end
        nm.NPCInfos:ForEach(function(k,v)
            local id, o=k:get(),v:get()
            if not integer(id,0,10000000) or ids[id] or #rows >= 5000 or not valid(o) or
                o:IsA('/Script/JH.TeamInfo') ~= true then error('npc_entry') end
            local owner=address(o:GetOuter())
            if owner ~= address(gi) and owner ~= address(nm) then error('npc_owner') end
            ids[id]=true
            field(o,'NPCId','IntProperty',0x38); field(o,'GuildId','IntProperty',0x3c)
            field(o,'AttributeSet','ObjectProperty',0x60,'/Script/JH.JHAttributeSet')
            field(o,'ItemSpecs','ArrayProperty',0x78,'ObjectProperty:/Script/JH.ItemInfoSpec')
            field(o,'SkillSpecs','ArrayProperty',0xa0,'StructProperty:/Script/JH.SkillSpec')
            field(o,'Friendliness','MapProperty',0x110); field(o,'SkillExp','IntProperty',0x200)
            field(o,'NPCLocation','StructProperty',0x208,'/Script/JH.NPCLocation')
            if o.NPCId ~= id or not integer(o.GuildId,0,1000000) or not integer(o.SkillExp,0,2147483647) then error('npc_identity') end
            if id == 0 then playerIdentity=address(o) end
            local set, vals=o.AttributeSet,{}
            if not valid(set) or set:IsA('/Script/JH.JHAttributeSet') ~= true then error('attribute_set') end
            for _,a in ipairs(attributes) do
                field(set,a[1],'StructProperty',a[2],'/Script/GameplayAbilities.GameplayAttributeData')
                local data=set[a[1]]
                structure(data,'/Script/GameplayAbilities.GameplayAttributeData',{{'CurrentValue','FloatProperty',0xc}})
                local value=data.CurrentValue
                if type(value) ~= 'number' or value ~= value or value < 0 or value > 10000000 then error('attribute_value') end
                vals[#vals+1]=quote(a[3])..':'..string.format('%.9g',value)
            end
            local friendliness, friendKeys,friendCount=0,{},0
            o.Friendliness:ForEach(function(fk,fv)
                local key,value=fk:get(),fv:get(); friendCount=friendCount+1
                budget=budget-1; if budget < 0 then error('collection_budget') end
                if not integer(key,0,10000000) or not integer(value,-100,100) or friendKeys[key] or friendCount > 5000 then error('friendliness') end
                friendKeys[key]=true; if key == 0 then friendliness=value end
            end)
            local items=array(o.ItemSpecs,10000,function(item)
                if not valid(item) or item:IsA('/Script/JH.ItemInfoSpec') ~= true then error('item_type') end
                field(item,'ItemDefId','IntProperty',0x3c); field(item,'Num','IntProperty',0x40)
                if not integer(item.ItemDefId,1,10000000) or not integer(item.Num,0,100000000) then error('item_value') end
                return '{"id":'..item.ItemDefId..',"count":'..item.Num..'}'
            end)
            local skills=array(o.SkillSpecs,1024,function(skill)
                structure(skill,'/Script/JH.SkillSpec',{{'Id','IntProperty',0},{'Level','IntProperty',4}})
                if not integer(skill.Id,1,10000000) or not integer(skill.Level,0,1000) then error('skill_value') end
                return '{"id":'..skill.Id..',"level":'..skill.Level..'}'
            end)
            local location=o.NPCLocation
            structure(location,'/Script/JH.NPCLocation',{{'MapName','NameProperty',0xc},{'IsVisible','BoolProperty',0x14}})
            local map=location.MapName:ToString()
            if type(map) ~= 'string' or #map > 128 or map:find('[%z\1-\31\127]') or type(location.IsVisible) ~= 'boolean' then error('location') end
            rows[#rows+1]='{"id":'..id..',"guildId":'..o.GuildId..',"skillPoints":'..o.SkillExp..',"rawFriendliness":'..friendliness..',"visible":'..tostring(location.IsVisible)..',"mapKey":'..quote(map)..',"attributes":{'..table.concat(vals,',')..'},"skills":'..skills..',"inventory":'..items..'}'
        end)
        if not playerIdentity then error('missing_player') end
        local quests, seen, questCount={},{},0
        local function questMap(map, primary)
            local localSeen={}
            map:ForEach(function(k,v)
                local id,q=k:get(),v:get(); questCount=questCount+1
                budget=budget-1; if budget < 0 then error('collection_budget') end
                if not integer(id,1,10000000) or localSeen[id] or questCount > 20000 then error('quest_key') end
                localSeen[id]=true
                structure(q,'/Script/JH.QuestSpec',{{'QuestId','IntProperty',0},{'Step','EnumProperty',4}})
                if q.QuestId ~= id or not integer(q.Step,0,4) then error('quest_value') end
                -- Same-build reflected RequirementSetting: enum byte at 0,
                -- int32 Id at 4 and float Num at 8. Read existing elements only;
                -- these counters belong to this QuestSpec, never to an NPC bag.
                field(q,'QuestProgracessData','ArrayProperty',8,'StructProperty:/Script/JH.RequirementSetting')
                local progressKeys={}
                local progress=array(q.QuestProgracessData,1000,function(r)
                    structure(r,'/Script/JH.RequirementSetting',{{'Type','EnumProperty',0},{'Id','IntProperty',4},{'Num','FloatProperty',8}})
                    if not integer(r.Type,0,67) or not integer(r.Id,0,10000000) or
                        type(r.Num)~='number' or r.Num~=r.Num or r.Num<0 or r.Num>100000000 then error('quest_progress_value') end
                    local key=r.Type..':'..r.Id
                    if progressKeys[key] then error('quest_progress_duplicate') end
                    progressKeys[key]=true
                    return '{"type":'..r.Type..',"id":'..r.Id..',"value":'..string.format('%.9g',r.Num)..'}'
                end)
                if primary or not seen[id] then quests[id]='{"id":'..id..',"step":'..q.Step..',"progress":'..progress..'}'; seen[id]=true end
            end)
        end
        questMap(qm.QuestProcesses,true); questMap(qm.FinishQuests,false)
        local questRows={}; for _,v in pairs(quests) do questRows[#questRows+1]=v end
        table.sort(questRows); table.sort(rows)
        stable()
        local playerAfter=nil
        nm.NPCInfos:ForEach(function(k,v) if k:get() == 0 then playerAfter=address(v:get()); return true end end)
        if playerAfter ~= playerIdentity then error('player_changed') end
        local identity={address(gi),address(sm),address(nm),address(qm),playerIdentity}
        local identityJson='['; for i,v in ipairs(identity) do identityJson=identityJson..(i>1 and ',' or '')..quote(v) end; identityJson=identityJson..']'
        local binding=source..'\n'..s.world..'\n'..s.pawn..'\n'..identityJson
        if observationIdentity ~= binding then
            observationEpoch=observationEpoch+1; observationIdentity=binding; observationContent=nil
        end
        local content='"quests":['..table.concat(questRows,',')..'],"npcs":['..table.concat(rows,',')..']'
        if #content > 4000000 then error('observation_size') end
        if content ~= observationContent then
            observationVersion=observationVersion+1
            local body='{"schema":1,"source":'..quote(source)..',"session":'..quote(session)..',"revision":'..quote(revision)..',"epoch":'..observationEpoch..',"version":'..observationVersion..',"world":'..quote(s.world)..',"pawn":'..quote(s.pawn)..',"identity":'..identityJson..','..content..'}'
            local mac=YijianNativeObservationMac(body)
            if type(mac) ~= 'string' or not mac:match('^[a-f0-9]+$') or #mac ~= 64 then error('observation_mac') end
            write(root..'npc-observation.json',body)
            observationContent=content; observationRef={mac=mac,version=observationVersion}
        end
        observationSequence=observationSequence+1
        local at=os.time()
        local frame=table.concat({'npc-sample-v1',source,session,revision,s.world,s.pawn,observationEpoch,observationRef.version,observationSequence,at,observationRef.mac},'\n')
        local sampleMac=YijianNativeObservationMac(frame)
        if type(sampleMac) ~= 'string' or #sampleMac ~= 64 then error('sample_mac') end
        return '{"epoch":'..observationEpoch..',"version":'..observationRef.version..',"sequence":'..observationSequence..',"at":'..at..',"mac":'..quote(observationRef.mac)..',"sampleMac":'..quote(sampleMac)..'}'
    end)
    if not ok then
        if tostring(result):find('load_busy',1,true) then
            s.dialogueAllowed=false; s.ready=false; s.reason='正在读档'
        end
        return withdraw()
    end
    return result
end
local function dialogue(s)
    if not s.dialogueAllowed or loading or saving then dialogueOpen=nil; return 'null' end
    local ok, result = pcall(function()
        local vm, view = s.ui:GetDialogModule(), s.ui:GetDialogView()
        if not valid(vm) or not valid(view) or vm:IsA('/Script/JH.DialogModuleVM') ~= true or
            view:IsA('/Script/JH.DialogModuleListVE') ~= true or view:IsVisible() ~= true or vm:GetOptionIsVisual() ~= true then
            dialogueOpen=nil; return 'null'
        end
        local intType = type(PropertyTypes) == 'table' and PropertyTypes.IntProperty or nil
        if type(intType) ~= 'table' or intType.Name ~= 'IntProperty' or intType.Size ~= 4 then error('dialogue_property_type') end
        -- The real reflected NPC field is a layout witness beyond the private
        -- read. Check each sample, including after registration: a legal int32
        -- at 0x188 occupies bytes through 0x18b. This is not a QuestId semantic
        -- check; the fixed EXE hash remains required for that interpretation.
        local npcProperty = vm:Reflection():GetProperty('CurrentNPCId')
        if not valid(npcProperty) or npcProperty:IsA(intType) ~= true or npcProperty:GetOffset_Internal() ~= 0x188 then
            error('dialogue_layout_mismatch')
        end
        if not dialoguePropertyReady then
            if type(RegisterCustomProperty) ~= 'function' then error('dialogue_property_unavailable') end
            if not valid(StaticFindObject('/Script/JH.DialogModuleVM')) then error('dialogue_class_unavailable') end
            -- UE4SS stores this private alias in its own metadata list. Never
            -- assign the alias or call a dialogue/option mutation function.
            RegisterCustomProperty({Name='YijianJournalQuestId',Type=intType,
                BelongsToClass='/Script/JH.DialogModuleVM',OffsetInternal=0x184})
            dialoguePropertyReady=true
        end
        local quest, npc = vm.YijianJournalQuestId, vm.CurrentNPCId
        if not integer(quest, 1, 1000000) or not integer(npc, 0, 1000000) then error('dialogue_identity') end
        -- Pinned UE4SS grows an array on an out-of-range __index, even on reads.
        -- Validate Num first and only access the existing 1..Num elements.
        local options, rows, total = vm.Options, {}, 0
        local count = options:GetArrayNum()
        if not integer(count, 1, 16) then error('dialogue_option_count') end
        for index=1,count do
            local text = options[index].Text:ToString()
            if type(text) ~= 'string' or #text == 0 or #text > 512 or text:find('%z') then error('dialogue_option_text') end
            total=total+#text
            if total > 4096 then error('dialogue_text_budget') end
            -- index is the current displayed order, never the game's OptionID.
            rows[#rows+1]='{"index":'..index..',"text":'..quote(text)..'}'
        end
        local fingerprint=table.concat(rows, ',')
        local identity=vm:GetFullName()..'\n'..s.world..'\n'..s.pawn..'\n'..quest..'\n'..npc..'\n'..fingerprint
        if not dialogueOpen or dialogueOpen.identity ~= identity then
            dialogueSequence=dialogueSequence+1
            dialogueOpen={identity=identity,sequence=dialogueSequence}
        end
        return '{"schema":1,"sequence":'..dialogueOpen.sequence..',"questId":'..quest..',"npcId":'..npc..',"options":['..fingerprint..']}'
    end)
    if not ok then dialogueOpen=nil; return 'null' end
    return result
end
local function state()
    local lib = StaticFindObject('/Script/JH.Default__ManagerFuncLib')
    if not valid(lib) then return {reason='等待游戏初始化'} end
    local gi, ui, world = lib:GetGameInstance(), FindFirstOf('JHNeoUISubsystem'), lib:GetCurrentWorld()
    local sm = valid(gi) and manager('SaveManager',gi) or nil
    local pc = lib:GetPlayerController(0); local pawn = valid(pc) and pc:K2_GetPawn() or nil
    local worldName = valid(world) and world:GetFullName() or ''
    local s = {lib=lib,pc=pc,gi=gi,sm=sm,ui=ui,worldObject=world,pawnObject=pawn,pawn=valid(pawn) and pawn:GetFullName() or '', world=worldName, reason=''}
    local loadKnown, pending = false, nil
    if valid(sm) then loadKnown,pending=pcall(loadPending,sm) end
    if not valid(gi) or not valid(sm) or not valid(ui) or not valid(pawn) or not valid(world) then s.reason='等待进入可游玩场景'
    elseif not loadKnown then s.reason='游戏载入状态待确认'
    elseif pending then s.reason='正在读档'
    elseif worldName:find('LV_NewGame', 1, true) or s.pawn:find('BP_StartMapHero', 1, true) then s.reason='主菜单中暂停保存'
    elseif lib:GetWorldType() ~= 1 or gi.bIsFighting then s.reason='战斗、过场或切换场景中暂停保存'
    else
        s.dialogueAllowed=true
        if gi.bDisableInputMove or not ui:IsInDefaultStatus() or ui:ShouldDisableInput() or ui:ShouldDisableInputForUI() or valid(ui:QueryNeoUIFocusModule()) then s.reason='菜单或对话中暂停保存' end
    end
    s.ready = s.reason == ''
    return s
end
local function tick()
    local config = read(root .. 'config.txt', 131072) or ''
    local token, source, access = config:match('^([a-f0-9]+)\n([^\r\n]+)\n(observe)\n$')
    if not token then token, source = config:match('^([a-f0-9]+)\n([^\r\n]+)\n$') end
    local s = state()
    if not token or #token ~= 64 then s.ready=false; s.dialogueAllowed=false; s.reason='等待手札连接'; token=''; source='' end
    if source ~= '' then
        if not boundSource then boundSource=normalized(source) end
        if normalized(source) ~= boundSource then s.ready=false; s.dialogueAllowed=false; s.reason='存档目录已切换，请重启游戏后再保存' end
    end
    if access == 'observe' then loading=nil; saving=nil end
    if loading then
        if s.ready and s.pawn ~= loading.pawn then respond(loading.id, loading.token, 'loaded'); loading=nil
        elseif os.time() > loading.untilTime then respond(loading.id, loading.token, 'uncertain', '已请求读档，但未能确认完成；请检查游戏'); loading=nil end
    end
    if saving then
        local bytes = read(saving.source .. '/29.sav',33554432)
        local cfg = read(saving.source .. '/JHSaveConfig.sav',33554432)
        if bytes and cfg and cfg ~= saving.beforeConfig and bytes == saving.lastBytes then
            write(root .. 'receipts/' .. saving.id .. '.sav',bytes)
            respond(saving.id,saving.token,'saved'); saving=nil
        elseif os.time() > saving.untilTime then
            respond(saving.id,saving.token,'uncertain','游戏保存尚未写入稳定文件，已停止后续操作'); saving=nil
        else saving.lastBytes=bytes end
    end
    local observation = npcObservation(s,source or '',token)
    write(root .. 'state.json', '{"protocol":2,"revision":' .. quote(revision) .. ',"session":' .. quote(session) .. ',"token":' .. quote(token) .. ',"source":' .. quote(source or '') .. ',"at":' .. os.time() .. ',"ready":' .. tostring(s.ready == true and loading == nil and saving == nil) .. ',"reason":' .. quote(loading and '正在读档' or saving and '正在保存' or s.reason) .. ',"world":' .. quote(s.world or '') .. ',"pawn":' .. quote(s.pawn or '') .. ',"autoSaveIndex":' .. (valid(s.sm) and tostring(s.sm.AutoSaveIndex) or 'null') .. ',"dialogue":' .. dialogue(s) .. ',"npcObservation":'..observation..'}')
    if access == 'observe' then return end
    local cmd = read(root .. 'command.txt', 1024)
    if not cmd or not token or loading or saving then return end
    local ct, cs, id, verb, expiry, mode = cmd:match('^([a-f0-9]+)\t([%d-]+)\t([a-f0-9-]+)\t([a-z]+)\t(%d+)\t([a-z]+)\n$')
    if not id or id == last or id == read(root .. 'last-command.txt',64) or #id ~= 36 or ct ~= token or cs ~= session then return end
    last = id
    write(root .. 'last-command.txt',id)
    if tonumber(expiry) < os.time() or tonumber(expiry) > os.time()+30 or not s.ready then respond(id,token,'skipped',s.reason ~= '' and s.reason or '请求已过期'); return end
    if not source:match('^[A-Za-z]:/') or not source:match('/%d+/SaveGames$') then respond(id,token,'rejected','存档目录不匹配'); return end
    local system = StaticFindObject('/Script/Engine.Default__KismetSystemLibrary')
    if not valid(system) then respond(id,token,'rejected','无法确认游戏保存目录'); return end
    local saved = normalized(system:GetProjectSavedDirectory():ToString())
    local account=source:match('/(%d+)/SaveGames$')
    if normalized(source) ~= saved..'/'..account..'/savegames' then respond(id,token,'rejected','游戏保存目录与手札不一致'); return end
    local actual, actualState = read(source .. '/29.sav', 33554432)
    local expected = read(root .. 'expected.sav', 33554432)
    if (mode == 'empty' and actualState ~= 'missing') or (mode ~= 'empty' and (mode ~= 'owned' or actual == nil or actual ~= expected)) then respond(id,token,'rejected','29 号槽被手动修改，已停止覆盖'); return end
    if verb == 'save' then
        local beforeConfig = read(source .. '/JHSaveConfig.sav',33554432)
        if not beforeConfig then respond(id,token,'rejected','无法读取游戏存档索引'); return end
        local previous = s.sm:GetSaveGameName():ToString()
        -- On the verified build, bAuto only skips the success toast inside SaveSlot.
        -- The explicit SlotIndex still selects 29; AutoSave() and its index are not used.
        local ok, result = pcall(function() return s.sm:SaveSlot(29, true, 'Yijian Journal Timeline') end)
        s.sm:SetSaveGameName(previous)
        if not ok or not result then respond(id,token,'rejected','游戏没有完成保存'); return end
        saving={id=id,token=token,source=source,beforeConfig=beforeConfig,untilTime=os.time()+12,lastBytes=nil}
    elseif verb == 'load' and mode == 'owned' then
        loading={id=id,token=token,pawn=s.pawn,untilTime=os.time()+25}
        s.sm:LoadSlot(29)
    else respond(id,token,'rejected','不支持的操作') end
end
write(root .. 'started.txt',tostring(os.time()))
LoopAsync(1000,function()
    if queued then return false end
    queued=true
    local scheduled, scheduleError = pcall(function() ExecuteInGameThread(function()
        local ok, err=pcall(tick); queued=false
        if not ok then
            pcall(function() write(root .. 'state.json','{"protocol":2,"session":'..quote(session)..',"at":'..os.time()..',"ready":false,"reason":'..quote('接入异常：'..tostring(err))..'}') end)
        end
    end) end)
    if not scheduled then queued=false; write(root .. 'schedule-error.txt',tostring(scheduleError)) end
    return false
end)
