-- 逸剑手札 native save/load bridge. UE4SS 3.0.1-1152, game Build 21798996.
-- No arbitrary commands: only the reserved manual slot 29 is accessible.
local root = __JOURNAL_ROOT__
local revision = __JOURNAL_REVISION__
local session = tostring(os.time()) .. '-' .. tostring(math.random(100000, 999999))
local last, loading, saving, queued = '', nil, nil, false
local boundSource = nil
local function valid(o) return o and o:IsValid() end
local function read(file, limit)
    local f, err, code = io.open(file, 'rb'); if not f then return nil, code == 2 and 'missing' or 'invalid' end
    local size = f:seek('end'); f:seek('set', 0)
    if not size or size > limit then f:close(); return nil, 'invalid' end
    local b = f:read('*a'); f:close(); return b, b and 'ok' or 'invalid'
end
local function write(file, bytes)
    local f, err = io.open(file, 'wb'); if not f then error('bridge_write_failed: '..tostring(err)) end
    f:write(bytes); f:flush(); f:close()
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
local function state()
    local lib = StaticFindObject('/Script/JH.Default__ManagerFuncLib')
    if not valid(lib) then return {reason='等待游戏初始化'} end
    local gi, sm, ui, world = lib:GetGameInstance(), lib:GetSaveManager(), FindFirstOf('JHNeoUISubsystem'), lib:GetCurrentWorld()
    local pc = lib:GetPlayerController(0); local pawn = valid(pc) and pc:K2_GetPawn() or nil
    local worldName = valid(world) and world:GetFullName() or ''
    local s = {sm=sm, pawn=valid(pawn) and pawn:GetFullName() or '', world=worldName, reason=''}
    if not valid(gi) or not valid(sm) or not valid(ui) or not valid(pawn) or not valid(world) then s.reason='等待进入可游玩场景'
    elseif worldName:find('LV_NewGame', 1, true) or s.pawn:find('BP_StartMapHero', 1, true) then s.reason='主菜单中暂停保存'
    elseif lib:GetWorldType() ~= 1 or gi.bIsFighting then s.reason='战斗、过场或切换场景中暂停保存'
    elseif gi.bDisableInputMove or not ui:IsInDefaultStatus() or ui:ShouldDisableInput() or ui:ShouldDisableInputForUI() or valid(ui:QueryNeoUIFocusModule()) then s.reason='菜单或对话中暂停保存' end
    s.ready = s.reason == ''
    return s
end
local function tick()
    local config = read(root .. 'config.txt', 2048) or ''
    local token, source = config:match('^([a-f0-9]+)\n([^\r\n]+)\n$')
    local s = state()
    if not token or #token ~= 64 then s.ready=false; s.reason='等待手札连接'; token=''; source='' end
    if source ~= '' then
        if not boundSource then boundSource=normalized(source) end
        if normalized(source) ~= boundSource then s.ready=false; s.reason='存档目录已切换，请重启游戏后再保存' end
    end
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
    write(root .. 'state.json', '{"protocol":1,"revision":' .. quote(revision) .. ',"session":' .. quote(session) .. ',"token":' .. quote(token) .. ',"source":' .. quote(source or '') .. ',"at":' .. os.time() .. ',"ready":' .. tostring(s.ready == true and loading == nil and saving == nil) .. ',"reason":' .. quote(loading and '正在读档' or saving and '正在保存' or s.reason) .. ',"world":' .. quote(s.world or '') .. ',"pawn":' .. quote(s.pawn or '') .. ',"autoSaveIndex":' .. (valid(s.sm) and tostring(s.sm.AutoSaveIndex) or 'null') .. '}')
    local cmd = read(root .. 'command.txt', 512)
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
            pcall(function() write(root .. 'state.json','{"protocol":1,"session":'..quote(session)..',"at":'..os.time()..',"ready":false,"reason":'..quote('接入异常：'..tostring(err))..'}') end)
        end
    end) end)
    if not scheduled then queued=false; write(root .. 'schedule-error.txt',tostring(scheduleError)) end
    return false
end)
