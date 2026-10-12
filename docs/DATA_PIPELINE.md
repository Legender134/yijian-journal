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
