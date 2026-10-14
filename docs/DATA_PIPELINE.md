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

生成时间会变化。核对生成结果时应比较实际条目与关联内容，而不是仅比较 JSON 文件时间或条目总数。通过 `pnpm test` 核对索引与逻辑；规则变更后相应修订数据断言。

## 当前任务选项的只读观察

游戏接入的可选 `state.json.dialogue` 字段仅包含 `schema`、窗口 `sequence`、`questId`、`npcId` 与当前选项的 `{index,text}`；不传送完整对白、动作、原始UObject或内存地址。`index` 是显示次序，不是游戏OptionID。与原协议2共存，未识别或退出窗口时为null，保存与读档权限不变。

此读取只适用于已pin的Build21798996及程序SHA-256 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。该构建的DialogModuleVM实例大小为0x260，任务编号是0x184的int32，紧邻0x188的反射CurrentNPCId。Lua以唯一私有别名只读该字段；注册依赖UE4SS精确commit的[IntProperty别名API](https://github.com/UE4SS-RE/RE-UE4SS/blob/e3ba1016562d6c0868c410d0a71e88bfcdbf691b/docs/lua-api/global-functions/registercustomproperty.md)。这不是可跨构建猜用的偏移，pcall不能替代布局及程序哈希核对。

只采集类身份正确且当前可见的DialogModuleVM与DialogModuleListVE。每次私有读取前，反射CurrentNPCId必须仍是0x188处的有效IntProperty，且类型大小为4；此布局见证确保读取范围位于已知字段之前，不能替代QuestId语义所需的程序哈希。Options已由原生实现过滤前置条件。先核对数组长度再访问1..Num，最多16项、每项512 UTF-8字节、总量4096字节；越界读取在已pin UE4SS中可能扩展数组，所以不能以读取到nil的方式遍历。战斗、过场、存读档、窗口关闭或身份异常均撤回上下文。

原生组件初始化先从Windows取得当前进程EXE路径，以只读、有界流式SHA-256匹配固定程序pin；不接受Lua传入路径、摘要或绕过开关。不匹配时初始化失败，Lua不会查询游戏对象、注册私有别名或写心跳。应用接收前再核对组件、程序和脚本哈希、会话、token、当前存档目录及三秒内心跳。只有最新进度模式参与；任务编号必须绑定现有攻略的具体选择步骤，已知人物须一致，完整选项组须逐项精确对应，格式差异可规范化，不能用子串或模糊匹配。推荐不会把旧存档材料升级为实时持有；已结束的现场窗口在同会话失联、战斗或切场时保留退场记忆，恢复后不会被旧保存记录重新提示。未知分支保留离线查询，不自动选择、推进或保存。

已识别的现场选择在主窗和展开随行中只显示一张，位于页面阅读滚动区域之外；保留原页面滚动位置，关键推荐仍可见，理由与完整分支按需展开。此功能只覆盖任务编号、人物及完整原生选项组均匹配的已整理窗口，规则数量不能当作实际现场覆盖率。

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

输出不带生成时间，因此同一输入得到相同字节。固定 `effects` 与 `random` 候选分开；随机池的 `weight` 是原始池内权重，不是掉率。`RandRange` / `NormalRandRange` 仅保留原字段区间，不据此宣称实际词条条数、抽取次数或独立概率。原表引用缺失的池会保留 `unresolved: true`，不补造候选。

`attributes` 中的 ID 与英文键来自静态枚举，中文名称结合相同版本程序的中文属性文字与物品描述核对；百分数格式依据 `AffixDisplay`。`Percent_*` 使用原值，`Percent100_*` 展示时乘 100。没有确定单位的移动速度及倍率参数保留原数值，不擅自换算。显示最多两位小数的静态参考值，不能声称是游戏实际取整或随机词条结算后的面板。`EquipmentRank` 保留原值，未核定其用途，不直接称为装备等级或品级。

`CAttr`、`CAllAttr`、百分比恢复等动作类型分别保留，不能把所有动作都解释为永久增加属性。`CAllAttr` 的作用范围，以及 `CHealthAttrPercent` / `CBlueAttrPercent` 的百分比基准尚未核定，不能宣称全队恢复或按上限、当前值、缺失值计算。`ABuff` 等动作的 `value` 保留原参数；`ABattleCountBuff` / `RealTimeBuff` 的参数单位尚未核定，不能直接写成战斗场数或秒。增益描述中的 `{0}` 等占位符，以及 `modifiers` / `durations` 原始参数数组，在未验证等级代入规则前不自动替换。`ARandItem` 引用的是掉落池，不能链接为随机词缀池。普通材料确实没有数值效果时保留空 `effects`。

使用条件中的 `Item` 逐项显示物品与数量，不把多项条件吞成泛化提示；这表示模板要求，不代表已经核对玩家库存。`WeaponRequirement` 的类型名称依据同构建静态程序的 `EWeaponType` 枚举（0 Default、1 Sword、2 Sabre、3 Spear、4 Fist、5 HiddenWeapon、6 OtherWeapons），程序 SHA-256 为 `946bba89314d1f614a43485856f6e00beb265fbbbdf9d256a7e96c80e745c76c`。枚举只能确认兵器类型，未核定具体判定对象，不宣称必须装备对应武器。`CheckNeiGong`、`CurrentSkillLv` 等比较逻辑未核定时，保留已知对象、参数和待核定说明，不把原始参数擅自解释为最低等级。

比武阶段线索另由 `duel-guide.cjs` 维护。智度上人（16022）的静态等级60、私物三转洗髓丹（141）与没药（10315）各1，核对自同Build的 `NPCs.uexp`（SHA-256 `0c3dcfdb36901efc70d65446064c5a97d44c1629d1e2cf418eb586ff3c131ec3`）；不分发原表。宴前及天水赴一线天途中的收集顺序来自标明版本的社区路线，与静态模板证据分开。原文的天水守卫尚未唯一绑定NPC实例，保留名称线索，不用同名候选的等级冒充。模板私物数量、装备池权重都不代表切磋掉率或首胜保证；静态等级不代表当前胜率。

中期比武线索交叉核对星1辰2之3羽、YYFShiki、mapking及力拔山兮气盖世呐正文；来源、日期与版本边界随资料保留。欧阳衡17100→100018阮师刀图纸，清霄5006→100008泰阿剑图纸，左江龙7500→100087犀皮兽纹甲图纸，刘雄17102→100007承影剑图纸；品剑大会5424完成后提示，5444客房休息完成后退出本次山庄收集窗口。同构建5444完成配置将左江龙移至丐帮、刘雄移离山庄，不能由此推论私物永久失去。少林圆悟5501→100038七杀拳套图纸、圆难5502→100028方天画戟图纸、圆苦5503→100037七星拳套图纸，整理为品剑大会完成后、峋谷将军府献书5509开始前的可选绕路，不误标在名剑山庄，也不宣称献书后永久漏失。

黄宗政19103→100076三清铃图纸在5532面见黄将军完成后提示；萧古里19510→100027八宝亮银铲图纸在峋谷事终后的重回辽城阶段提示，地点临昌与辽城分开。乌天瘤16017→100075清心护符图纸采用12609总舵商议完成后的调查窗口。以上等级与私物均核对同Build表，旧攻略简称成品、新旧丹药品级或地名差异明确保留；请教、剧情/BOSS掉落、模板私物互不替代。不采用作者估算概率、继承配装或静态等级承诺胜率。涤罪僧有多个剧情实例与赠礼限制，未把未核定的同名实例直接加为当前可切磋人物。

流程选择的可见步骤和隐藏分支，另核对同Build的 `Quests.uexp`（SHA-256 `2d84daae1fc93fc6f098fd5897091704960581d305adffd2f42a26315a881a86`），不分发原表。5076赴后山后的授武分支5079/5080/5081，5821复命后的程钰去留5827/5828，以及21123勘验后的凶案分支21133/21134、21142/21143，均有明确任务动作。`decisionAfterAllComplete` 只为这些已核定的对话窗口保留建议，要求根任务进行中且可见前置完成；分支或后续步骤一旦有保存记录就关闭，不把其他已完成步骤都当成当前选择。收益、结局关联和推荐目标仍分别标注社区来源及版本，不由静态动作推断全部结局条件。

塞外风光另核对12033→12035的军情步骤：12037结算会记录12038「血染峋谷」并给13560霹雳雷火弹，12040结算会记录12041「危机解除」并给13512天罗地网钉。临昌救人的地点和路线先后交叉核对不同作者正文；好感75/80的版本冲突不用于自动判可接。无瘢刀22125休息后的夜谈22132，选「矢志于此／不负己心」分别记录22133/22134；建议在选答或誓师记录出现后退场。攻略对隐藏结局的关联与Steam玩家的未触发反例并列，不用静态分支或单个选项承诺完整结局。

甘泉出发前的13001、莫问询问步骤12404及询问总步骤12401，分别用于牢房救人与礼物选择提醒。`requireDecisionWindow` 要求具体选择窗口成立，根记录单独进行中不提示重选；`untilAnyFailed` 处理已确认失败的独立支线退场。夜猫子相关提醒在出笼之鸟12685阶段出现，脱身12688/12689或隐藏标记12693出现后退场；战前对白12686/12687完成本身不解释为人物身亡。11886对12693的排除条件只证明接取窗口，不推出已接任务必定失败。其他任务关闭影响和礼物好感分别保留社区作者、日期及版本。孙老10001和秦烈10023的等级5/35、私物100329/100312与同Build人物表核对；模板私物不等于切磋保证获得。

人物和任务图鉴的关联在渲染层由现有精确ID生成：接取、完成、人物条件、交互场景、事件布置、文字提及分别标注；同名提及保持歧义，不推断身份、阵营或实时位置。根任务只汇总实际子步骤，不将不同分支材料相加。悬停预览读取现有图片与数值索引；流程参照通过原有只读saveDetails接口按槽名和内容哈希核对，不新增游戏读取权限。任务没有精确图片时使用分类图标。

## 游戏 UI 图片

额外导出 `NPCResources.json` 并简化为 `NPCResources-simple.json`。将需要的纹理 `.uasset` 和 `.uexp` 放到 `.downloads/game-icons-raw/`，保留 `Wandering_Sword/Content/...` 的原目录结构。

```powershell
node scripts/prepare-game-icons.cjs
py -m venv .downloads/python-assets
.\.downloads\python-assets\Scripts\python.exe -m pip install -r scripts/requirements-assets.txt
.\.downloads\python-assets\Scripts\python.exe scripts/decode-game-icons.py
```

第一步根据表中的精确引用和已有图鉴条目生成 `.downloads/game-icon-plan.json`，不根据同名人物猜测头像。Python 工具只接受已观察到的单层内联 UE4.26 纹理布局，并检查尺寸、格式、负载长度和偏移；支持 DXT1、DXT5、BGRA，不能解码的条目使用应用分类图标。

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
