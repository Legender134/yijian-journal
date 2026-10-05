# 第三方内容与许可

## 《逸剑风云决》/ Wandering Sword

游戏名称、角色、游戏图片、物品与任务文字等属于各自权利人。`src/assets/game/`、`src/data/game-images.json`、`src/data/game-index.json` 与 `src/data/world-index.json` 是以游戏 Build 21798996 为参考的辅助展示资料，不包含完整游戏、玩家存档、音频或视频，不纳入原创代码的 MIT 授权。本项目不授予这些内容的再分发许可，也不声称拥有其权利。

游戏商店与权利人信息：[Steam 官方商店页](https://store.steampowered.com/app/1876890/)。图鉴初始资料不一定反映当前周目状态；实际内容以玩家拥有的游戏为准。

## UE4SS

原生游戏接入包含官方 [UE4SS-RE/RE-UE4SS](https://github.com/UE4SS-RE/RE-UE4SS) 的组件，版本 `3.0.1-1152-ge3ba1016`，MIT License，Copyright (c) 2022 Narknon。

- 随包保留的完整许可：[src/game-bridge/runtime/ue4ss/LICENSE](src/game-bridge/runtime/ue4ss/LICENSE)。
- 官方发布来源、归档 SHA-256 与二进制文件 SHA-256：[src/game-bridge/provenance.json](src/game-bridge/provenance.json)。
- 应用只在玩家确认并通过兼容性与文件归属检查后安装组件。官方 `experimental-latest` 标签会变化，本项目以已记录版本和文件哈希为准，不自动替换为最新版本。

## Electron 与 Chromium

Windows 下载包包含 Electron 44.5.1 运行环境及其依赖。Electron 为 MIT 许可，Chromium 与其他依赖使用各自许可。下载包保留 Electron 的 `LICENSE`、`LICENSES.chromium.html` 和其他运行时文件。根目录的 `LICENSE` 为本项目原创代码许可；Electron 的许可位于 `LICENSE.electron`。

源码依赖清单见 `package.json` 和 `pnpm-lock.yaml`，构建时保留依赖原始许可。

## 社区攻略线索

`src/data/catalog.cjs` 的线索卡片由项目独立整理；引用来源以该文件及应用内「来源」为准，包含原作者、链接、发布日期和参考版本。来源文章本身不纳入本项目许可。没有收录来源站点的全文、视频或评论区。
