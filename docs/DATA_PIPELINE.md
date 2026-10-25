# 资料与图片生成

运行和构建应用使用仓库已提交的 `src/data/*.json` 与 `src/assets/game/*.png`，不需要本节的原始输入或外部工具。这里用于维护版本化图鉴与图片，生成脚本仅操作本地导出文件，不修改游戏安装。

## 输入来自哪里

当前索引以 Steam Build **21798996** 为参考。原始表及纹理由维护者从自己拥有的游戏副本取得，外部工具遵循各自许可：

- [repak](https://github.com/trumank/repak)：读取或解包 Unreal `.pak`。初始资料使用 0.2.3。
- [UAssetGUI](https://github.com/atenfyr/UAssetGUI)：将 Unreal DataTable 导出为 UAssetAPI JSON。初始资料使用 1.1.0，目标游戏 UE4.26。

这些工具不随仓库分发。按其官方文档选择与游戏匹配的引擎版本，将导出中间文件放在 `.downloads/`。这里不包含自动解包或一键适配新游戏版本的工具。

## 资料表

将 UAssetAPI JSON 命名并放到 `.downloads/game-json/`：`Maps.json`、`NPCs.json`、`Quests.json`、`Items.json`、`Skills.json`、`Aggregation.json`、`Fusions.json`、`Alchemy.json`、`Cooking.json`。字段来自当前游戏表结构，生成器不保证未来版本仍使用相同字段。

```powershell
node scripts/inspect-tables.cjs Maps NPCs Quests Items Skills Aggregation Fusions Alchemy Cooking
node scripts/build-game-index.cjs
node scripts/build-world-index.cjs
```

`inspect-tables.cjs` 把 UAssetAPI 的属性结构转为同目录 `*-simple.json`。非常大的表可使用流式工具，例如：

```powershell
node scripts/reduce-large-table.cjs NPCResources
```

`build-game-index.cjs` 输出 `src/data/game-index.json`，包含物品、武学、赠礼偏好、配方、商人以及初始任务资料；`build-world-index.cjs` 读取前者和简化表，输出任务步骤、地点与人物的关联索引。

目前 `build-game-index.cjs` 的 Build 标记固定为 **21798996**。生成其他版本资料时，需同时核对字段与筛选规则并修改该标记；这只是资料版本，不会更改或证明原生存读档兼容性。不要混用不同 Build 的表和索引。

武学默认按 `bOpenForPlayer` 筛选；480「青云扇法」另有主角限定物品10438的显式 `ASkill(480,1)`，以及28003「查看青云扇法」、28041「修炼青云扇法」的正常剧情证据，因此仅为此项保留额外入口，不批量收录所有关闭标志的武学。其请教契约仍保留 `openForPlayer: false`，图鉴不列常规教师、好感或武学点费用；秘籍、各级拳掌精通 +1.1 与1/8/9级突破按原表展示。

生成时间会变化。核对生成结果时应比较实际条目与关联内容，而不是仅比较 JSON 文件时间或条目总数。通过 `pnpm test` 核对索引与逻辑；规则变更后相应修订数据断言。

## 当前任务选项的只读观察

游戏接入的可选 `state.json.dialogue` 字段仅包含 `schema`、窗口 `sequence`、`questId`、`npcId` 与当前选项的 `{index,text}`；不传送完整对白、动作、原始UObject或内存地址。`index` 是显示次序，不是游戏OptionID。与原协议2共存，未识别或退出窗口时为null，保存与读档权限不变。

此读取只适用于已pin的Build21798996及程序SHA-256 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。该构建的DialogModuleVM实例大小为0x260，任务编号是0x184的int32，紧邻0x188的反射CurrentNPCId。Lua以唯一私有别名只读该字段；注册依赖UE4SS精确commit的[IntProperty别名API](https://github.com/UE4SS-RE/RE-UE4SS/blob/e3ba1016562d6c0868c410d0a71e88bfcdbf691b/docs/lua-api/global-functions/registercustomproperty.md)。这不是可跨构建猜用的偏移，pcall不能替代布局及程序哈希核对。

只采集类身份正确且当前可见的DialogModuleVM与DialogModuleListVE。每次私有读取前，反射CurrentNPCId必须仍是0x188处的有效IntProperty，且类型大小为4；此布局见证确保读取范围位于已知字段之前，不能替代QuestId语义所需的程序哈希。Options已由原生实现过滤前置条件。先核对数组长度再访问1..Num，最多16项、每项512 UTF-8字节、总量4096字节；越界读取在已pin UE4SS中可能扩展数组，所以不能以读取到nil的方式遍历。战斗、过场、存读档、窗口关闭或身份异常均撤回上下文。

原生组件初始化先从Windows取得当前进程EXE路径，以只读、有界流式SHA-256匹配固定程序pin；不接受Lua传入路径、摘要或绕过开关。不匹配时初始化失败，Lua不会查询游戏对象、注册私有别名或写心跳。应用接收前再核对组件、程序和脚本哈希、会话、token、当前存档目录及三秒内心跳。只有最新进度模式参与；任务编号必须绑定已核验的具体选择步骤，完整选项组须逐项精确对应；当前已核验窗口的NPC编号仅作上下文，因为事件人物不一定是对白说话者，不以猜测人物约束替代任务与选项契约，格式差异可规范化，不能用子串或模糊匹配。推荐不会把旧存档材料升级为实时持有；已结束的现场窗口在同会话失联、战斗或切场时保留退场记忆，恢复后不会被旧保存记录重新提示。未知分支保留离线查询，不自动选择、推进或保存。

已识别的现场选择在主窗和展开随行中只显示一张，位于页面阅读滚动区域之外；保留原页面滚动位置，关键推荐仍可见，理由与完整分支按需展开。此功能只覆盖任务编号及完整原生选项组均匹配的已核验窗口，规则数量不能当作实际现场覆盖率。

补充开发验收：显式设置 `YIJIAN_LUA_BIN` 为Lua5.4开发解释器后运行 `node scripts/live-dialogue-lua-smoke.cjs`。该脚本使用真实Lua与合成UE对象、内存通道，不启动游戏、不接触个人存档；游戏程序与反汇编研究材料不分发。静态核对和合成验收不能替代新构建的真实兼容性验证。

原生前置校验验收：在Windows显式配置provenance所pin的MSVC/SDK环境与 `YIJIAN_CL`、`YIJIAN_TOOLCHAIN_ID`，运行 `node scripts/native-executable-gate-smoke.cjs --out-dir <仓库.test-data内全新的绝对目录>`。只编译和运行合成EXE，核对当前进程摘要与Node/PowerShell一致、有效旧授权仍被固定游戏pin拒绝、拒绝后零Lua参数和Channel绑定、重定向路径拒绝及合成文件不变。无工具链时直接报错，不以跳过冒充通过。

已发布Unicode组件仅允许按provenance的明确旧摘要清单升级。旧安装记录必须归属本手札、协议与mod一致，记录摘要须匹配实际旧DLL；游戏停止并核验应用数据中的组件保护副本后才原子替换，再更新本手札mod的脚本、配置与安装记录。保护副本位于应用数据的 `component-backups/YijianJournalUnicode/<旧摘要>.dll`，不写入游戏存档；旧运行目录位于游戏内时也不能用它充当保护目录。未知或改动的DLL、归属不符、保护失败、运行状态变化均保留原件并拒绝更新；这里的旧DLL保护不代表额外备份mod脚本或配置。

## 物品数值索引

`scripts/build-item-stats.cjs` 另外生成 `src/data/item-stats.json`，按 `game-index.json` 的物品 ID 选择同版本静态数据。它不读取玩家存档，也不启动游戏；只输出展示所需的基础动作、使用条件、装备原始 Rank 值、共享随机候选池、引用到的增益文本及数值参数。原始全表、程序和工具不随产品分发。

除上述 `Items-simple.json`，输入目录还需包含 `RandActionPools-simple.json`、`Buffs-simple.json`、`AffixDisplay-simple.json`、`AttributeTypes-simple.json` 和 `source-manifest.json`。前三张新增表同样来自 `JH/Tables/`，使用同版本工具导出和简化。`AttributeTypes-simple.json` 是由匹配版本静态程序中 `EAttributeType` 的名称指针 / 整数注册值对导出的 `{ "Id": 9, "Key": "AttackPower" }` 数组，不是根据名称排列猜出的编号，也不是玩家属性。

来源清单须包含 `schema: 1`、`build: "21798996"`、`source.kind: "owned-installed-game-static-tables"`、`attributeEnumSource.sha256`（匹配版本静态程序的 SHA-256）、公开工具版本与哈希，以及 `tables` 对象中上述五个 `*-simple.json` 文件名对应的 SHA-256。来源清单及生成数据不得写入账号、存档或本机绝对路径。构建器验证全部输入文件哈希、Build 和现有物品的 ID / 名称 / 类型；禁止通过修改 Build 标签混用不同版本的表。

```powershell
node scripts/build-item-stats.cjs
# 也可以明确指定保留的导出输入目录：
node scripts/build-item-stats.cjs --input-dir <同版本简化表目录>
node --test tests/item-stats.test.cjs
```

`cantSell: true` 来自同Build Items原表的严格布尔 `bCantSell === true`，或原生另行拒绝的 `EItemSubType::QuestItem` 类别。SellItem入口调用静态谓词 `0x141246800`，先拒绝 `+0x40 == 0x3c`，再拒绝 `+0x83` 禁售标志；其setter为 `0x14128cbd0`。同构建原生枚举注册对 `0x1442daa10` 确认 `EItemSubType::QuestItem=60`，不能与 `EItemType::QuestItem=7` 混用。当前1629个公开物品中270个带标志，另17个任务物品无标志但同样被类型检查拒绝，合计287个显示“不可出售”。五毒玉佩8065、感悟心得247及麦子10041等仍保留原SellPrice用于资料追溯；未标记不补造“可以出售”，不扩展为全部脚本或商店可售性。

输出不带生成时间，因此同一输入得到相同字节。固定 `effects` 与 `random` 候选分开；随机池的 `weight` 是原始池内权重，不是掉率。`RandRange` / `NormalRandRange` 仅保留原字段区间，不据此宣称实际词条条数、抽取次数或独立概率。原表引用缺失的池会保留 `unresolved: true`，不补造候选。

`attributes` 中的 ID 与英文键来自静态枚举，中文名称结合相同版本程序的中文属性文字与物品描述核对；百分数格式依据 `AffixDisplay`。`Percent_*` 使用原值，`Percent100_*` 展示时乘 100。没有确定单位的移动速度及倍率参数保留原数值，不擅自换算。显示最多两位小数的静态参考值，不能声称是游戏实际取整或随机词条结算后的面板。`EquipmentRank` 保留原值，未核定其用途，不直接称为装备等级或品级。

`CAttr`、`CAllAttr`、百分比恢复等动作类型分别保留，不能把所有动作都解释为永久增加属性。`CAllAttr` 的作用范围，以及 `CHealthAttrPercent` / `CBlueAttrPercent` 的百分比基准尚未核定，不能宣称全队恢复或按上限、当前值、缺失值计算。`ABuff` 等动作的 `value` 保留原参数；`ABattleCountBuff` / `RealTimeBuff` 的参数单位尚未核定，不能直接写成战斗场数或秒。增益描述中的 `{0}` 等占位符，以及 `modifiers` / `durations` 原始参数数组，在未验证等级代入规则前不自动替换。`ARandItem` 的 Id 是物品模板编号，按 Fusion 模式生成随机词条；`ANormalRandItem` 按 Normal 模式生成。两者均不能将 Id 链接为 DropPools 或 RandActionPools 编号，具体词条候选应从该物品模板继续追踪。普通材料确实没有数值效果时保留空 `effects`。

使用条件中的 `Item` 逐项显示物品与数量，不把多项条件吞成泛化提示；这表示模板要求，不代表已经核对玩家库存。`WeaponRequirement` 的类型名称依据同构建静态程序的 `EWeaponType` 枚举（0 Default、1 Sword、2 Sabre、3 Spear、4 Fist、5 HiddenWeapon、6 OtherWeapons），程序 SHA-256 为 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。枚举只能确认兵器类型，未核定具体判定对象，不宣称必须装备对应武器。已知的 `PreQuest` 显示原生0至4对应状态，`NoQuest` 表示尚未触发，不由Num推导；`JumpStep` 使用独立的 `EJumpQuestStepType` 分派事件，0至4分别为发起接取、确认接取、拒绝接取、触发推进、触发结算，不得复用存档 `EQuestStep` 状态。已pin程序动作99在 `0x140f75c80` 分派至对应 HandleRequesting / HandleAcceptRequested / HandleRefuseRequested / HandleProcessing / HandleFinishing；4只证明触发结算，不据此保证整个处理器或后续剧情无条件完成。物品与任务图鉴共用同一动作解释，未知动作值不推测展示。`CheckNeiGong`、`CurrentSkillLv` 等比较逻辑未核定时，保留已知对象、参数和待核定说明，不把原始参数擅自解释为最低等级。

比武阶段线索另由 `duel-guide.cjs` 维护。智度上人（16022）的静态等级60、私物三转洗髓丹（141）与没药（10315）各1，核对自同Build的 `NPCs.uexp`（SHA-256 `0c3dcfdb36901efc70d65446064c5a97d44c1629d1e2cf418eb586ff3c131ec3`）；不分发原表。宴前及天水赴一线天途中的收集顺序来自标明版本的社区路线，与静态模板证据分开。原文的天水守卫尚未唯一绑定NPC实例，保留名称线索，不用同名候选的等级冒充。模板私物数量、装备池权重都不代表切磋掉率或首胜保证；静态等级不代表当前胜率。

中期比武线索交叉核对星1辰2之3羽、YYFShiki、mapking及力拔山兮气盖世呐正文；来源、日期与版本边界随资料保留。欧阳衡17100→100018阮师刀图纸，清霄5006→100008泰阿剑图纸，左江龙7500→100087犀皮兽纹甲图纸，刘雄17102→100007承影剑图纸；品剑大会5424完成后提示，5444客房休息完成后退出本次山庄收集窗口。同构建5444完成配置将左江龙移至丐帮、刘雄移离山庄，不能由此推论私物永久失去。少林圆悟5501→100038七杀拳套图纸、圆难5502→100028方天画戟图纸、圆苦5503→100037七星拳套图纸，整理为品剑大会完成后、峋谷将军府献书5509开始前的可选绕路，不误标在名剑山庄，也不宣称献书后永久漏失。

黄宗政19103→100076三清铃图纸在5532面见黄将军完成后提示；萧古里19510→100027八宝亮银铲图纸在峋谷事终后的重回辽城阶段提示，地点临昌与辽城分开。乌天瘤16017→100075清心护符图纸采用12609总舵商议完成后的调查窗口。以上等级与私物均核对同Build表，旧攻略简称成品、新旧丹药品级或地名差异明确保留；请教、剧情/BOSS掉落、模板私物互不替代。不采用作者估算概率、继承配装或静态等级承诺胜率。涤罪僧有多个剧情实例与赠礼限制，未把未核定的同名实例直接加为当前可切磋人物。

流程选择的可见步骤和隐藏分支，另核对同Build的 `Quests.uexp`（SHA-256 `2d84daae1fc93fc6f098fd5897091704960581d305adffd2f42a26315a881a86`），不分发原表。5076赴后山后的授武分支5079/5080/5081，5821复命后的程钰去留5827/5828，以及21123勘验后的凶案分支21133/21134、21142/21143，均有明确任务动作。`decisionAfterAllComplete` 只为这些已核定的对话窗口保留建议，要求根任务进行中且可见前置完成；分支或后续步骤一旦有保存记录就关闭，不把其他已完成步骤都当成当前选择。收益、结局关联和推荐目标仍分别标注社区来源及版本，不由静态动作推断全部结局条件。

塞外风光另核对12033→12035的军情步骤：12037结算会记录12038「血染峋谷」并给13560霹雳雷火弹，12040结算会记录12041「危机解除」并给13512天罗地网钉。临昌救人的地点和路线先后交叉核对不同作者正文；好感75/80的版本冲突不用于自动判可接。无瘢刀22125休息后的夜谈22132，选「矢志于此／不负己心」分别记录22133/22134；建议在选答或誓师记录出现后退场。攻略对隐藏结局的关联与Steam玩家的未触发反例并列，不用静态分支或单个选项承诺完整结局。

甘泉出发前的13001、莫问询问步骤12404及询问总步骤12401，分别用于牢房救人与礼物选择提醒。`requireDecisionWindow` 要求具体选择窗口成立，根记录单独进行中不提示重选；`untilAnyFailed` 处理已确认失败的独立支线退场。夜猫子相关提醒在出笼之鸟12685阶段出现，脱身12688/12689或隐藏标记12693出现后退场；战前对白12686/12687完成本身不解释为人物身亡。11886对12693的排除条件只证明接取窗口，不推出已接任务必定失败。其他任务关闭影响和礼物好感分别保留社区作者、日期及版本。孙老10001和秦烈10023的等级5/35、私物100329/100312与同Build人物表核对；模板私物不等于切磋保证获得。

人物和任务图鉴的关联在渲染层由现有精确ID生成：接取、完成、人物条件、交互场景、事件布置、文字提及分别标注；同名提及保持歧义，不推断身份、阵营或实时位置。根任务只汇总实际子步骤，不将不同分支材料相加。悬停预览读取现有图片与数值索引；流程参照通过原有只读saveDetails接口按槽名和内容哈希核对，不新增游戏读取权限。任务没有精确图片时使用分类图标。

## 武学修炼上限与门派免费请教

`codex-details.json.skills` 保留同构建 `Skills.LevelUnLockReqs` 为 `levelUnlockRequirements`，分别记录未满足条件时的等级上限及原始条件。原表的 `Level=4` 表示未满足时可修炼至4级，继续突破才需要条件；不应写成升至4级需要条件。此语义由已pin程序 `0x14124ffe0` 及批量升级路径 `0x141267490` 交叉核对；不把该静态分析扩大为所有升级入口的实测结论。物品条件显示为持有要求，不解释为消耗。未确认名称的隐藏剧情条件保留原始编号供数据核对，界面不捏造任务名。

`npc-interactions.json` 的人物 `guildId` 从同构建NPC原表按精确ID投影，武学 `grade` 从原技能品质枚举保留。`martialCost.guildFree` 按目标NPC门派1、连续完成的 `[5218,5317,5323,5748,5858]` 前缀解锁免费品质2至6，遇首个缺失或非状态4即停止；规则对应已pin程序 `0x14124c630`。该判断不依据玩家门派、人物名称或单个较晚晋升记录。确认免费时费用条件为0，其他请教门槛仍独立核对；未证明的天赋和难度减免继续保持条件判断。

## 游戏 UI 图片

额外导出 `NPCResources.json` 并简化为 `NPCResources-simple.json`。将需要的纹理 `.uasset` 和 `.uexp` 放到 `.downloads/game-icons-raw/`，保留 `Wandering_Sword/Content/...` 的原目录结构。

```powershell
node scripts/prepare-game-icons.cjs
py -m venv .downloads/python-assets
.\.downloads\python-assets\Scripts\python.exe -m pip install -r scripts/requirements-assets.txt
.\.downloads\python-assets\Scripts\python.exe scripts/decode-game-icons.py
```

第一步根据表中的精确引用和已有图鉴条目生成 `.downloads/game-icon-plan.json`，不根据同名人物猜测头像。Python 工具只接受已观察到的单层内联 UE4.26 纹理布局，并检查尺寸、格式、负载长度和偏移；支持 DXT1、DXT5、BGRA，不能解码的条目使用应用分类图标。

青云扇法图标使用原表精确引用 `/Game/JH/UI/Icon/T_Skill480`。原纹理uasset／uexp的SHA-256为 `b4f94ebf80195c54e221752b9a359140e83292a84b3cecaae70faa14f1347ce9`／`2d67784e703623dce369e942af2d8a7c9eeb178ad94a9665107a0ad960c28ad9`，按同一解码器从200像素缩至192像素，不拿同名秘籍图标替代。

输出为 `src/assets/game/<引用哈希>.png` 和 `src/data/game-images.json`，图片最长边 192 像素。构建报告写入 `test-results/game-images-build.json`；计划和报告含本机路径，不提交到 GitHub。

```powershell
pnpm smoke
node scripts/icons-smoke.cjs
```

检查图片能否加载、名称与条目是否对应、品质颜色、人物同名歧义及缺图回退。PNG 的具体压缩字节可能随图像库变化，不能仅凭体积判定图片正确。

## 原创应用图标

修改 `src/assets/icon.svg` 后运行：

```powershell
node scripts/assets.cjs
```

使用依赖锁定文件中的 `sharp` 重建 `icon.png` 和 `icon.ico`。它只用于开发，不作为应用运行时依赖。

只提交需要的生成索引和展示图片，不上传原始游戏包、全量表、提取工具或玩家数据。游戏资源保留原权利人的权利，许可说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 原生背包读取

`native-save-details.cjs` 的只读背包段按同构建原生序列化顺序读取：GUID、物品 ID、数量、32 位布尔标志、两组动作数组，随后一个32位整数和两个分别在版本9/10加入的32位布尔标志，再核对后续人物集合数量。此前把最后12字节中的前8字节解释为取得时间并不正确；版本6只新增一个32位整数，其含义未核定，不作时间校验。前一布尔标志也不是第三组动作数量。布局核对来自 Build21798996 的静态程序（SHA-256 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`），没有在自动化测试中启动游戏或读取个人存档。未知标志、非有限动作值、越界数量或截断数据仍省略背包结果，基本元数据与字节原样备份独立保留。测试使用独立字节样本和合成存档；原始程序及反汇编材料不提交。

## 已保存的角色准备

只有外层压缩头明确标记格式14，且整个原生人物集合按已核定顺序读取到文件尾，才提供角色准备记录。单独GVAS没有原生版本证据，不猜格式。`UJHSaveGame::Serialize`（VA `140feda40`）、物品（`1412249f0`）、NPCInfo（`141224f90`）、AttributeSet（`140f67f80`）和 SkillSpec（`1411fc790`）分别用于核对集合顺序与字段；属性名称来自同构建 EAttributeType，NPCInfo/SkillSpec反射字段用于确认NPCId、GuildId、SkillExp与武学Id/Level。GuildId不是玩家等级。

宇文逸使用同构建人物表ID0，等级来自属性5。气血／内力在原生保存时按基础上限归一化，故仅显示已保存比例；攻击9、防御11为基础值，不作含装备、经脉、增益的实战面板，也不换算胜率。NPC背包与EquipmentSpecs分开；只将后者用于已装备核对。武学只使用已学ID和修炼等级，不把Checked/bApplied擅自解释为当前选装。

NPC头像资源名、地图名与解锁头像数组均经 `FObjectAndNameAsStringProxyArchive` 的FString编码读取，支持带NUL的ANSI／UTF16，不把内存中的8字节FName误当作保存格式。各集合有数量、剩余字节与总记录预算限制；重复人物／属性、非有限值、截断和未知尾部只撤回角色准备，已有效的背包和基本元数据继续可用。

好感从目标NPCInfo的Friendliness键0读取，而不是玩家的反向关系表。原生 `GetFriendliness`（`14120d980`→`14120d9e0`）还会施加独立剧情上限，因此仅标记原始值；值达到20不自动宣称交互已开放，赠礼境界与剧情锁仍须观察游戏按钮。准备清单区分已记录、需准备与待核对，修炼等级目标是带理由的可选成长建议；不把它写成必胜要求。所有自动化验证使用临时合成存档，原始反汇编不分发。

游戏接入 grant 的原槽位字段允许签名值 `observe`，表示仅观察现场。安装已核验组件并绑定当前 Steam 账户后可建立此 grant，不修改 Timeline 的 nativeProtocol、enabled 或槽位所有权。原生 Channel 在此模式仅允许读取 config，并禁止命令、expected、29.sav、索引文件以及保存回执的访问；Lua 发出只读心跳后返回，不读取或执行存读档命令。明确开启时间线后才沿用原签名 `29` 权限，旧授权不会自动提升。

## 人物进度与现场一致性

格式14完整人物段另保留实际私物、已学武学、基础属性和人物位置标志。私物不同于装备和初始掉落池；空袋才表示已清空，缺人物记录保持未知。`npc-interactions.json` 从相同构建的表和原生／蓝图路径投影：比武读原始好感20，请教读第一个未满足剧情锁限制后的有效好感。现代请教的六档功法好感为40至90，生活技艺为教师等级整十倍；生活技艺按原生整数等级比较，教师同级也可请教经验，不能只保留比玩家高的教师。精力、武学点减免天赋尚未采集时保持条件分支，不把基础消耗当作唯一门槛。

同级生活请教由已pin程序 `0x141034db0` 的整型 `teacherLevel >= playerLevel` 比较确认，现代入口 `0x141060ab0` 仍传教师等级整十倍好感；`0x14103c168–0x14103c19d` 对对应技艺经验加100，相关天赋为200。六种 `JiYiLevelExpConfigs` 的最高配置等级均为10，待请教清单仅推荐主角未达此等级的练习，不据此宣称满级互动入口被锁。配置导出 SHA-256 为 `28aec0bc63d087a5c58bdf6fdc57e5cb164015f36a75a9a87c372276202be46d`，来源资产摘要沿用 `npc-power.json`；未证明满级经验处理，不推荐无确定收益的满级练习。双方等级分别展示，不将经验增长写成一次升级承诺。

待比武／待请教优先排列已满足对应条件的人物，再考虑同场景与未持有重点私物。就绪、同场景、未持有重点三个筛选可求交，并与搜索共同作用；随行打开“完整手札”时转交筛选与阅读位置，主窗“打开随行”恢复小窗原阅读，详情返回和刷新保留条件，切换分类重置筛选。保存数据在列表、人物详情标题和筛选中明确为“保存时”，现场撤回后同步降级措辞。未持有只判断同次背包中数量为零的重点私物，不代表从未获得；背包未读取时不筛入未知物品，人物私物仍按实际剩余袋保留，筛选后的预览优先展示缺少的物品。主角背包的同物品多堆数量相加。卡片折叠态只显示实际导致受限的主要条件，完整限制、剧情链接及剩余私物保留在详情；战力仅使用同批现场属性，不预测胜率。

现场采集只枚举既有 SaveManager/NPCManager/QuestManager，要求当前 GameInstance 归属。TeamInfo 的合法 Outer 是同一 GI 或已接受的 NPCManager。反射字段、类型、偏移与结构体映射均校验；数组先核 Num，再读1..Num。NPCInfos 与 QuestProcesses/FinishQuests 在同一次游戏线程回调复制，前图优先。GameSaveConfig(+38)、LastLoadSaveData(+50) 是载入布局锚点；固定程序下的 Int8只读别名读取忙碌字节+9c。采集前后要求非载入、同一世界／玩家／管理器和当前人物0。轮询不能证明捕捉每次短暂的人工读档事件；整份线程内复制用于保证当前样本一致，不能把 pending 指针当永久读档编号。

不调用会写入初始化或缓存的 GetNPCInfo、GetFriendliness、GetNPCManager、GetQuestManager、GetFightingCapacity 等便利查询。七项战力属性直接读 JHAttributeSet.CurrentValue；助手依原配置次序逐乘、逐加float32，境界阈值达到即进入该档。赠礼比较目标减主角境界是否≥2，不用人物等级差代替。此复现只覆盖原配置、ASC=null／bBeforeCreate=false 的已核定路径，不模拟战斗胜率，也不宣称修改配置的 MOD 兼容。

完整现场内容只在变化时原子写到手札自己的 npc-observation.json。原生 HMAC 同时绑定内容与独立采样帧（来源、会话、脚本版本、世界、玩家、观察epoch、内容版本、采样序号和时间）。每次完整重读后才能推进序号，即使内容相同；单改心跳时间不能续用旧样本。Node校验两层MAC、单调序号、绑定与新鲜度，失败整份撤回。历史／固定存档不混用现场状态，现场持有数量未核定时不借用旧存档背包。人物图鉴、条件链接、预览和手札接续使用同一现场任务集合，手札消息只传已校验的读取模式，不传现场内容；接收窗口重新核对当前集合，暂时不可用时读取最新保存记录。内存缓存和内容键避免仅刷新时间就重排整个界面。

载入忙碌与 pending 检查先于状态 ready 和读档完成回执。发起读档后即使玩家对象已切换，原生忙碌或 pending 尚未清除也不能回报完成。赠礼的满好感分支单独阻止继续送礼；境界限制是对方高出玩家两阶，不能用绝对差值代替方向判断。

`live-choice-contracts.json` 记录19个真实选项窗口与16条流程规则的映射，验证完整原生按钮组；不从攻略标签反推选项。陈麟熙的对话实际是好言相劝(+10)／义正辞严(-10)，后续共饮节点12094才按当时有效好感≥70分支；高好感取胜分支让人物离场并使进行中的11272线索失败。动态提醒核对同次人物与任务状态，后续赠礼仍可能改变判断。原始资源和研究缓存不提交。新增 Lua、帧校验、流程与GUI验证全部使用合成对象、通道和存档，不运行或附加实际游戏。

执法晋升前另核对13801「震山龙授首」：接取需5748完成且5858尚无记录，接取人为元启5008。5857的各难度完成动作触发5858的HandleFinishing；其Quest_5851 Blueprint播放LS_CG-5851，正常OnFinished回调才调用QuestInfo.FinishQuest，以真正EQuestStep4写入QuestProcesses。OnStop不走此完成分支。NoQuest查询QuestProcesses与FinishQuests，不能拿临时资源缓存对象或JumpStep参数4当作记录已写入。继续核对OnFinished后续：两条5831分支均跳回15，再遍历默认Quest数组，对状态1的根调用QuestManager.FailQuest；原生141249080写根状态2并将已有、非完成的子记录写2。12个原始ID完整保留，其中10个有公开名称，30380与30692是无名隐藏根，不伪造名称。提醒放在挑战道通之前：未接震山龙授首先接并完成；进行中的惩奸除恶、绝响难求、绮罗筵等，只展示玩家当前状态1的任务及晋升失败后果。已完成任务不列入，不把调用事件4本身当失败证明。原始Blueprint使用已pin API按UE4.26核对，六个原始成员摘要列在flow-window-contracts.json；原包和反汇编不分发。

## 图鉴奖励、选择与武学详情

`scripts/build-codex-details.cjs` 从 Build 21798996 的 Quests 与 Skills 静态表生成 `src/data/codex-details.json`。任务输入现为完整的 6437 行 `Table.Data` UAssetAPI 属性数组，不能再使用按已发布任务 ID 选择的旧输入。脚本逐行读取并核对完整输入的 SHA-256，命名任务继续按 ID、名称、任务父级匹配现有索引。任务表有一个 ID 同时用于未命名内部行，不能仅按 ID 取最后一行。生成结果不含本机路径、玩家状态或原始全表。

用相同版本 UAssetAPI 的 `SerializeJson` 导出完整 `Quests.json` 后，可在 Windows PowerShell 中提取完整数组。使用 Newtonsoft 保留 `4.0` 等原始浮点类型的 JSON 形式；UTF-8 无 BOM、CRLF 换行、末尾无换行是当前固定输入的字节格式。不同序列化器产生的字节不能沿用该摘要。

```powershell
[Reflection.Assembly]::LoadFrom('<Newtonsoft.Json.dll>') | Out-Null
$questExport = [Newtonsoft.Json.Linq.JObject]::Parse([IO.File]::ReadAllText('<Quests.json>'))
$questTable = $questExport['Exports'] | Where-Object { $null -ne $_['Table'] } | Select-Object -First 1
$questArray = $questTable['Table']['Data'].ToString([Newtonsoft.Json.Formatting]::Indented)
$questArray = $questArray.Replace("`r`n", "`n").Replace("`n", "`r`n")
[IO.File]::WriteAllText('<Quests.Table.Data.json>', $questArray, [Text.UTF8Encoding]::new($false))
Get-FileHash -Algorithm SHA256 -LiteralPath '<Quests.Table.Data.json>'
```

```text
node scripts/build-codex-details.cjs <Quests.Table.Data.json> <Skills.json>
```

完整任务数组 SHA-256 为 `f1ddf79d01d5d143512ce55b1007b19cd8dc5c57c48ff00cb3ee396f5ef5fecf`，独立记录在 `source.inputs.questsFullTableData`；旧选择输入摘要 `45303fedd1778387ecfc26ff842251ba83e2057f9dbe90c3803a074a44c131d1` 不再作为当前输入接受。Skills JSON 仍为 `1ef5e9f6debaaab410d11b331ea3869ba09f6f90926ee079200df34523e29313`。原 Quests.uasset / .uexp 分别为 `ca4fb2762930e4473fa10301678874e9ebbe4d0ee97b4a193b6ae71badcf3e41` / `2d84daae1fc93fc6f098fd5897091704960581d305adffd2f42a26315a881a86`；Skills.uasset / .uexp 分别为 `fc7018b0b3644f5ffbbae6aea40bfefc3b7990abdcbba9d2ea4fa254936d0d81` / `a2fd448cc404f316f3013611b94b131e7489a7fad3d363153dbc670be2bd6c88`。来源许可沿用游戏数据说明，不当作项目原创代码授权。

当前投影保留 546 个命名任务结果、622 个内部奖励或选择步骤，以及 277 项武学的各级属性动作。`hiddenSteps` 保留实际编号、`ownerId`、经唯一原表 Owner 链得到的 `ownerPath` / `relatedQuestId`、接取与完成条件；缺失、重复或成环的 Owner 链不关联公开任务。内部步骤不获得伪造的正式名称，界面用公开关联任务及结算语境导航，原始编号只放在资料来源折叠与内部属性中。

任务 `CAttr` 复用同一份属性枚举与数值格式，保留正负号和各难度的独立动作。11453 的「吃九盆」、11455 的「再吃三盆」、11456 的「拼了」分别记录气血上限 -5、-2、-5；6256 炼丹经验 +800、11110 钓鱼经验 +300、5054 采集经验 +10 均按原值显示，不由经验奖励推算会升到几级。采集经验 68 由既有的同构建完整属性枚举加入共享数值目录，物品效果和武学成长不变。

隐藏 11743 的 `ItemMax(165,1)` 表示九炼熊蛇丸数量小于 1。已pin程序的要求枚举 15 先减一取分发表项 14，落在 `0x140f7d645`；与 `Item` 一样调用 `0x14120f2d0` 按物品编号合计背包各堆栈，再于 `0x140f7d82f` 比较 `count < Num`，成立才返回真，不是 `<=`。缺少完整背包读取时条件仍为未知；单个条件成立不等于整个任务已完成。

普通、困难、极难的完成动作分开保存；只有三组展示结果完全相同时才合并显示一次。选项要求及动作保留在各自选项下，失败结算和各个剧情处理事件分别列出，不把互斥结果相加，也不把根任务完成视为全部内部奖励均已获得。相同公开任务、相同触发语境和相同数量的重复内部物品来源可合并展示一行，但保留全部原始步骤编号，不合计数量。未识别动作的原始三元组仍保留；界面只展示已核对的动作及精确关联实体，不把未知或复合动作展开成推测奖励。

`CGuildHonor` 展示为门派贡献变化。`ARandItem` / `ANormalRandItem` 的物品目标和数量由已pin程序的 `ApplyAction` 分发核对：31号动作在 `0x140f75bc5` 设置 Fusion 模式2，32号设置 Normal 模式1，均与 CItem 的模式0汇入 `0x1411ff790`；`0x14121cc70` 按原始 Id 经 `0x14124f380` 查询 ItemResManager 的 ItemDataTable（偏移0x30、行类型 ItemInfoSetting），不是 DropPoolDataTable（偏移0x40）。随机词条来自所选物品模板，界面不承诺最终词条数量、组合、属性或掉率。当前命名与隐藏任务的35个唯一随机物品Id均在Items表中有对应行，同构建DropPools表549行不含这些Id；DropPools.uexp 摘要为 `e43eb18bba381dfb574c96fdde6afefd868951935838c7f2bb3216297602e76a`，程序摘要为 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。

请教消耗与好感复用 `npc-interactions.json`；静态教师或秘籍关系是学习线索，只有现有人物状态明确满足时才显示“可请教”。材料采集与掉落复用既有 `material-guide.cjs`，保留可展开的来源与版本，不新增掉率或效率假设。

### 晋升任务失败提醒

Build 21798996 的 Quest_5317、Quest_5323、Quest_5982、挑战入口 Quest_5314／Quest_5320 及离队实现 FL_JieKou 共十二个原始成员新增 hash pin。资深5317、精英5323的完整默认数组分别有6、8个根；首座运行任务6261使用 Quest_5982，默认数组32根，另以12110状态1分支执行四大武家失败及吕仙儿17012离队。30380、30692无公开名称，仅保留 metadata。未证明吕仙儿永久无法招募。

失败提醒按根任务状态1筛选，不把未记录、0、2、3、4列为当前风险。只在对应贡献／首座准备、已核定贡献交付／回复后的过渡与真实重试窗口提示；资深5316、精英5322和首座6263均覆盖。6266虽Owner5850，唯一请求前置6263==1，立刻挑战跳6261/4；已有6261记录不使失败提醒退场，6261真正完成（状态4）才撤下。首座回复6260建立6261/0先关闭指定步骤的接取窗口，与胜利后正常结算时的失败分支分开说明。

精英／首座接取卡片保留具体conditionQuestId及步骤链接，明确已接完成前风险；仅在明确提供 acceptedEffect 时覆盖默认接取证据守卫，其他规则继续保留原先证据边界。下一轮未接时保留该轮接取说明，已完成轮次不重新带出effect；当前根失败风险由独立active提醒承载。主视图、紧凑视图与摘要直接显示当前受影响任务名及四大武家进行中时的吕仙儿离队后果，详细名单和来源使用既有展开区域。离线资料保留条件性完整名单，不生成当前风险。读取和展示不修改任务状态。原始资产、反汇编、私有审计与合成验证证据不分发。

### 晋升剧情的精力上限收益

四处晋升剧情另有任务表之外的 `CAttr(45,10)`：原始步骤5317 / Quest_5317关联5242，5323 / Quest_5323关联5304，5858 / Quest_5851关联5850，6261 / Quest_5982关联5980。`scripts/codex-blueprint-outcomes.json` 仅记录这四处已核定的固定投影；构建器须先匹配同Build、唯一原始行、OwnerQuestId及完整Blueprint类路径，源行缺失或身份不符时不补造。`blueprintOutcomes` 独立于 `finish`、选项和剧情事件，不能把属性动作复制到三组难度完成奖励。生成后仍为546个命名任务结果，内部步骤由622增至623，新增的是原有但此前无可展示表奖励的5858；它没有公共隐藏标题。移除四条新 `blueprintOutcomes` 及5858后，完整数据与补充前深等。

5317、5323在晋升剧情正常结束后到达属性调用；5858须正常结束晋升剧情并走过后续结算跳转；首座6261须比武胜利且结束结算对话，`OnFinished` 本身只进入比武，不能据此给出属性收益。序列中止、首座败北和选择选项的回调本身都不到属性动作。四入口各展示一次“晋升收益”，复用共享 `attributes[45]` / `itemEffectText` 输出“精力上限 +10 点”，不当作当前精力恢复、已获得的状态或当前存档已写盘的证明，也不按难度或任务清理循环累计。

来源元数据分开标记 `owned-installed-game-blueprint`：Build 21798996，UE4.26静态解码，包含各原始uasset/uexp成员、解码JSON、表达式长度和解码API摘要，以及程序SHA-256 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。解码API为UAssetAPI `d7b9fd4341ac22dd9ab8d9f49455ea5ebcf571abced64313ab15eb1944de07d9`、Newtonsoft.Json `22c649f75fce5be7c7ccda8880473b634ef69ecf33f5d1ab8ad892caf47d5a07`、ZstdSharp `5d597fb07c93f99bcbbcf1265bfc60de1f1f8fc070a3acc36f0371a86c326b16`。原生枚举和ApplyAction分派确认4=CAttr、45=MaxJingLi；`GetNPCInfoById(0)` 传入主角Hero对象，原生modifier操作为Additive(0)。该结论限定于已pin构建的静态动作与回调控制流，不扩展为所有外部回调重入时序、属性间接联动、存档持久化时机或全局仅结算一次机制的实机验证。原包、程序和反汇编不分发，来源许可沿用游戏数据说明。

### 孙老思乡与南疆交花

孙老思乡11061、两路结算11062／11063、取蜜11686／11687及交花11689复用已有world-index.json与codex-details.json中的前置、选项及奖励数据，不新增重复机器契约。核对使用Build 21798996完整6437行Quests输入，SHA-256为 f1ddf79d01d5d143512ce55b1007b19cd8dc5c57c48ff00cb3ee396f5ef5fecf；名称另与同构建Items／NPCs交叉核对。原始全表和私有审计不分发。

入口不再凭早期主线章节提前提醒，保留5059已完成的锚点及已激活任务家族，允许后期回村补做。两条后续保留作图鉴攻略和接取地点线索，不新增decisionSteps或重复advice卡；当前行动由flow.active与结构化材料行呈现，完成／失败后退场，历史guide仍可查。通用“未接任务线索”可保留异地委托，接取提示补明南疆石屏村，地点补充参照[木林风2023-10-17原站](https://www.3dmgame.com/gl/3908832_70.html)。

蜂蜜10332仅补百药谷place-903“击败蜜蜂”的共享drop路线，复用于物品图鉴、缺料与采集目的地。11686／11687仅加instruction/evidenceQuestIds，沿用materialGate：持有0／4份时采集，5份时交付龙桑加并撤下采集目的地。百药谷名称及村西关系来自任务原文；Items另提桃花林／落英林，本次不扩展刷怪地点、等级或刷新机制。

原表两路取蜜都列CItem(10273,2)，同构建1713行Items及公共物品索引却无该引用，本节仅记录缺引用，不编造名称／物品入口或实际到账保证。NPCs蜂群45265、蜜蜂45266／45322／45323的DropItems引用蜂蜜，原始Value60／100不解释成数量或掉率，也不由这些行推断地图分布。未穷举其他Blueprint和秋海棠来源，不据单条结算推断任一答法永久失去所有后续。

### 物品赠礼限制与旧安排兼容

Build 21798996 的原生 `UGiftSystem::GiftItem` 注册路径经 exec `0x14128b250` 到实现 `0x140fdee60`，读取物品定义后调用 `0x141246710`：只有 `ItemType != EItemSubType::QuestItem` 且 `bCantGift == false` 才允许赠送。反射字段与枚举将 ItemType 偏移0x40及 QuestItem 值0x3c对应起来；此规则独立于使用偏移0x83的出售判定，也不以品质、人物偏好或任务预留为依据。程序SHA-256沿用 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。

`Items-simple.json` 的1713行输入摘要为 `f3caff2955923af778efba7774261ea2a9884117eada4b7baabfc1828e64b475`。其中16／17／18／10501为 `bCantGift=false` 的 QuestItem，前三项被既有 Id>=100 规则排除；本次1629项公开物品中仅10501硫磺的 giftable 从true改为false。无人物的 hobbyKeys 包含 QuestItem，正常偏好推荐未受此问题影响。投影核验逐项比较公开身份和 giftable 字段，保留原生成时间及其他数据；该核验不代表完整构建CLI重放。

已保存的已知物品赠礼安排、草稿、上一份副本与导入记录继续保留；旧硫磺选择按精确物品显示不可赠送并禁选，旧行程保留玩家原选标题与备注，统一预算不为其占用任务材料。提交新赠礼或把旧编号改为另一个不可赠送组合时拒绝，原记录仍可编辑、删除或改为可赠送物品；未知物品记录仍不接受。暂存草稿本身允许未完成或不可提交的编辑值，实际提交继续经过赠礼命令边界。

旧安排的行动卡显示不可赠送，保留查看、编辑与个人处理状态；不显示备礼数量、完成赠送或新增行程操作，也不作为主窗口或随行小窗的新行动建议。赠礼编辑器对这类旧项不显示库存缺口或参与分配的提示，仍可保存同一人物与物品的备注，或改选可赠送物品后继续正常规划。

Blueprint 的正常赠礼分支仍调用上述原生判定，物品列表中出现不等于可执行赠送。本次未穷举 native VM、全部UMG／鼠标／手柄选择分支，也未作实机赠礼验证。来源许可沿用游戏数据说明；原始Items、Blueprint、程序、反汇编及本地审计材料不分发。

### 人物好感锁的空项展示

Build 21798996 的原始 NPC 表保留公开 19 人的 39 条好感锁及数组顺序。原生 `GetLockedFriendliness` 按原序返回第一条解锁条件未满足的上限；空条件数组直接满足。冷无情11509的两项依次为50／PreQuest(12583,4)及0／空条件，12583是“诛杀覆海蛟”；尾部空项不会限制好感。

人物图鉴仅在展示时略去“上限0且条件数组为空”的项，并以可显示项决定是否显示好感条件区域；原始数据与进度投影不变。卫霍、白锦、陈麟熙、孔亮的0上限均有实际前置条件，继续保留。通用空条件渲染仍表示“未收录条件”，不为本处例外改写。核对程序SHA-256沿用 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`；来源许可沿用游戏数据说明，原始资产、反汇编及私有审计不分发。

### 常规切磋与赠礼的条件说明

Build 21798996 的 Compare 蓝图调用 TeamInfo.GetFriendliness(0) 并比较20；TeamInfo 的类注册表将该方法绑定到 exec0x141380ba0，再调用0x14120d9e0读取 Friendliness 原始关系值。NPCManager 的同名方法使用另一 exec0x14136aa20，经0x14120d980返回原始值与剧情上限的较小值。Compare 父检查与额外条件列表也已分别静态核对，不将赠礼境界当作常规切磋门槛。

本次仅修正比武攻略和准备清单文案：切磋按比武好感、精力及其他剧情条件核对；好感不足且需要赠礼时，再核对赠礼境界与上限。已正确的运行时 raw 判定、状态分类和赠礼/请教规则保持不变。小蝶、司马相、秦烈无好感锁，程钰首上限60不改变20阈值；未声称这些人物因零上限被错误阻挡，也未把合成 raw20/cap0 案例当成正常剧情可达证明。

核对程序SHA-256沿用946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c；原始蓝图、NPC/Quest选择与反汇编仅作私有证据，不分发。


### 初期比武私物的精确实体

Build 21798996 的原始 NPC ItemList 与 Items 同表交叉核对后，8条既有线索补齐物品编号：江小彤10017的金钱镖5001（绿品）；雷万钧10034的虬龙拳套精良图纸100032；岳九10048的下品凝元丹丹方100316；道微5007的灵宝刀精良图纸100016；道通5011的癸水丹115、寂灭爪精良图纸100036；道妙5013的鱼肠剑精良图纸100005；白锦10131的破甲锥精良图纸100041。上述均为初始固定私物1份，并非当前背包或首胜必得；原误写“葵水丹”同步更正。图纸品阶取原始物品 Description，物品链接使用具体实体，避免同名金钱镖混用白/绿/蓝模板。

Compare 胜利主图在卫霍10047且5068状态1时跳专用剧情结算，扣其高粱酒并进入5070/4，结束时不调用普通 RollItemAndDlgs。后续任务表5091完成动作列高粱酒、金石散、武学笔记；本次只据完整胜利主图补充“买酒首战不抽普通私物”，不将附挂任务蓝图的未解码内容推为额外固定结算规则，也不把整个当前私物列表当作该战掉落。

来源SHA-256：原始NPC解码7a0d829f069714e43e94f476bcac67784a26be0d7eb07daff6b7c7a485b429b5；Items解码f3caff2955923af778efba7774261ea2a9884117eada4b7baabfc1828e64b475；Compare双文件1f6dea0b4df60e33f14a4ceee116163bd9aa41fdcf22256d2a6b2bb8907c37da与8e8dbc8706e0a981f539fc3a1791092a372ae42d742b424d28151cf2920e6bbf。原始成员、反汇编与核对中间产物不分发，来源许可沿用游戏数据说明。


### 初始招式与装备词条基础描述

原始3164行NPC与449公开人物逐项对表，公开武学关联预期1179项，原为1178项；唯一遗漏是步微月19830的青云扇法480／10级。仅补回原序关联，其他448人的武学、等级与顺序均不变。480原始bOpenForPlayer=false，请教过滤继续保留；初始招式不回填现场或保存记录中的当前技能。NPC原始SHA-256沿用7a0d829f069714e43e94f476bcac67784a26be0d7eb07daff6b7c7a485b429b5，Skills双文件fc7018b0b3644f5ffbbae6aea40bfefc3b7990abdcbba9d2ea4fa254936d0d81／a2fd448cc404f316f3013611b94b131e7489a7fad3d363153dbc670be2bd6c88。

同构建程序0x140f832b0的ABuff动作描述分支将基础Num传入0x1412500e0；对整数1..10取ModifierValue至ModifierValue9，对数值取绝对值后以单一{0}代入Description。随机装备池中22类／198个含占位候选全部符合此子集，涉及152件物品；复用现有共享modifiers，保留真实零值，单位仅取描述原文，不增加字段、概率或实际强化面板推断。两个吸血条目的Decimal_2仅格式差异、无倍率，项目沿用最多两位小数去尾零。固定动作、分数或超界等级、其他占位和不受此证据覆盖的参数继续原处理。通用Buff提示的多参数格式、额外调整开关及实际装备实例不据此扩展。

### 开局剧情中的赠物与传授

`scripts/codex-sequence-outcomes.json` 补充同构建任务表没有直接列出的三个过场事件：5021 的 LS_CG-5021 引用 LS_CG-5021B，赠玉佩事件调用 `AddItemsAndOpenResultWin([8065],0,0)`；5039 的 LS_CG-5039 分别在两个事件中调用该函数发放秘籍13850、以 `ASkill(850,1)` 传授基础心法。原生0x140f73d30逐个物品ID以数量1调用0x1411ff790；两个0是铜钱和随机池类型，不是数量。ASkill的1表示请求初始等级，已会该武学时跳过，不是额外升一级；SceneHero不属于所要求的TeamInfo时，原生分支回退到主角NPC0。成员摘要、时间轴入口及原生调用定位保留在投影来源中；原始资源不分发。

构建器仅对同Build、唯一原始QuestId、OwnerQuestId、原始Name、Blueprint及完整FinishSequence均匹配的行添加 `sequenceOutcomes`。5021和5039没有自定义Blueprint（值为None），不能伪造类路径；三事件各自保留，不复制进三组难度完成奖励。补充后新增两个内部步骤，移除它们后其余图鉴数据与补充前深等。穿戴玉佩5024和升级心法5046是后续教学，不能作为取得来源；5046的原生类别检查也不等于单独传入850验收。界面按事件触发描述，物品与武学反查至公开主线5020，不给无名步骤生成标题或独立导航，不以主线完成记录宣称当前已到账、已学会或已写盘。未证明跳过过场、重复触发和其他构建的行为。

核对程序SHA-256为946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c；Buffs-simple为920b723733e5a2cdf8f6971a92f41cc2b5eb4ee717591cbec7571f5762c99c2b；RandActionPools-simple为b7b1dc446cdc8b2dc523b01a0681ef6b9980d92872c3df80e16e87183bc772fa；AffixDisplay-simple为b32b77289a09ea05b672a5b7d4b3f9f27b3df9be5e4da4899d83dee51f966663。原始资产、反汇编和审计过程仅留本地，来源许可不变。
