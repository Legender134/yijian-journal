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
