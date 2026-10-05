# 继续开发逸剑手札

仓库包含应用源码、图标原稿、运行所需资料索引、游戏接入 Lua 脚本、依赖锁定文件、合成存档测试及构建工具。普通功能开发无需安装游戏，也无需获取作者的存档或电脑环境。

## 第一次运行

使用 Windows x64、Node.js 24 和 pnpm 11.25.0。在 GitHub Fork 本仓库后，克隆自己的 Fork；只想本地修改也可以直接克隆本仓库。

```powershell
git clone https://github.com/Legender134/yijian-journal.git
cd yijian-journal
pnpm install --frozen-lockfile --ignore-scripts
pnpm electron:install
pnpm test
pnpm smoke
```

`pnpm smoke` 用合成存档打开应用并测试界面，个人数据写入仓库的 `.test-data/`，不读取玩家的实际进度，也不会接入真实游戏。检查报告和演示截图写入 `test-results/`。这些目录均被 Git 忽略。

`pnpm start` 启动正常应用，会寻找本机游戏和存档，使用 `%APPDATA%\YijianJournal`。开发界面时可以改用独立目录，避免影响自己的正式手札：

```powershell
$env:YIJIAN_TEST_DATA = Join-Path $PWD '.test-data/manual-dev'
pnpm start
Remove-Item Env:YIJIAN_TEST_DATA
```

这个测试模式拒绝启动游戏、安装组件和实际游戏存读档。开发上述原生能力时须另行用自己同意操作的游戏与测试存档验证；单元测试通过不能证明新游戏版本兼容。

`package.json` 的 `private: true` 只防止误发布到 npm，不影响 GitHub 克隆、Fork 或修改源码。

## 从哪里改起

| 位置 | 职责 |
| --- | --- |
| `src/main.cjs` | Electron 主进程、窗口和托盘、IPC 参数检查、存读档调度。 |
| `src/preload.cjs` | 沙箱界面可调用的有限 API，新增操作需与主进程一起维护。 |
| `src/renderer/` | 页面、交互、样式、图标、品质色、任务和备料展示。 |
| `src/core/store.cjs` / `activity.cjs` | 周目与设置持久化、上一次记录、操作结果与草稿。 |
| `src/core/save-reader.cjs` | 有边界检查的只读 GVAS 解析。 |
| `src/core/saves.cjs` / `auto-backup.cjs` | 完整备份、校验、保护副本、恢复与自动备份。 |
| `src/core/timeline*.cjs` | 历史节点、保留策略、恢复事务与时间偏差。 |
| `src/core/game-bridge.cjs` | 原生组件兼容性、账户与槽位归属检查、请求和回执。 |
| `src/game-bridge/main.lua` | 游戏中的 UE4SS 接入实现；官方二进制和来源校验另列在同目录。 |
| `src/core/game-data.cjs` / `material-plan.cjs` / `reservations.cjs` | 图鉴、配方、共享库存分配与预留物品。 |
| `src/data/` | 版本化的图鉴、任务和图片索引，及注明来源的精选线索。 |
| `tests/` | 核心测试与合成存档生成器，不含真实玩家存档。 |
| `scripts/` | 界面回归、打包、发布校验、图标和资料生成工具。 |

界面通过 `window.journal` 调用 preload，再由主进程检查请求并调用 core。保持 `contextIsolation`、renderer 沙箱和关闭 Node integration；不要让页面直接访问文件系统或游戏进程。

## 验证修改

```powershell
pnpm test
pnpm smoke
```

界面功能的补充检查包括 `node scripts/features-smoke.cjs`、`node scripts/icons-smoke.cjs`、`node scripts/comparison-smoke.cjs`。先执行 `pnpm smoke`，创建它们共用的隔离输出目录。涉及存档解析、恢复、时间线、库存分配时，应添加能复现问题的合成测试，验证失败场景和原始文件不变。

格式化只限自己修改的文件，例如 `pnpm exec prettier --write src/renderer/game-views.js`，避免无关的整库格式改动。Python 图片工具使用标准 Python 风格。

## 构建可下载版本

```powershell
pnpm package
pnpm test:package
pnpm release:zip
```

输出位于 `dist/v<package.json中的version>/`。`package` 会检查包内文件与源码一致，`test:package` 测试该目录中的 exe，`release:zip` 生成 ZIP 和 `SHA256SUMS.txt`。既有目录与 ZIP 不会覆盖；正式新版本应先更新版本号和说明，不要删除玩家数据来重打包。

`main` 是持续开发分支。下载包以对应 release tag 为准，`v1.10.10` 保留首次公开版本的源码；后续开发文档和工具补充不改写该下载包。

## 资料、图标和游戏版本维护

普通页面或逻辑开发直接使用已提交的索引即可。需要更新数据时，参见 [资料与图片生成](docs/DATA_PIPELINE.md)。原创应用图标来自 `src/assets/icon.svg`，可运行 `node scripts/assets.cjs` 重建 PNG 和 ICO；生成后要检查实际外观。

游戏更新适配涉及存档格式、UE4SS 接口、保存槽位和回执协议。不能只修改 `provenance.json` 的 Build 或可执行文件哈希来宣称支持新版本。需独立核对接口、暂停条件、写盘稳定性、账户归属、读档前保护和中断恢复；将实际验证版本、限制和证据写入提交说明，个人存档与诊断原始文件留在本机。

## 提交与讨论

在自己的 Fork 建立主题分支，提交聚焦的修改后向本仓库 `main` 提交 Pull Request。说明具体问题、修改后的行为、验证命令和结果；UI 变化可附不含私人数据的截图。报告问题可直接使用仓库的 [Issues](https://github.com/Legender134/yijian-journal/issues)。

不提交 `node_modules/`、`dist/`、`.downloads/`、`.test-data/`、`test-results/`、玩家存档、笔记、账户密钥或本机路径。原创代码按 MIT 许可贡献；游戏资料和第三方组件遵循 [第三方说明](THIRD_PARTY_NOTICES.md)，不要将它们标成自己的原创内容。
