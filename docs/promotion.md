# 宣传素材制作

目前保留两种影片：约三分钟的功能演示用于仔细了解操作；94 秒的宣传短片《江湖，由你走》用粒子、路线与关联线索介绍流程、图鉴、比武请教和存档。两者均为 1920 × 1080、30 fps，穿插真实软件录制；详细演示有中文合成旁白，宣传短片以字幕和音乐叙事。

## 宣传短片：江湖，由你走

分镜与字幕见 [trailer-script.json](trailer-script.json)。原创 Canvas 动画让剑、路线、图鉴和时间线发生变化，再接入实际随行界面。概念动画与示例进度用于介绍功能，不表示游戏已经触发某个任务，也不承诺覆盖所有剧情。

先按下文采集一份完整操作记录，再使用已有的 Playwright 开发依赖、Windows Edge 和 FFmpeg 渲染。过程仅访问本机临时素材服务，既不启动游戏，也不读取个人存档。输出目录必须是新目录。

```powershell
node scripts/render-trailer.cjs --capture .test-data/promo-take --game <已获许可的游戏片段.mp4> --out .test-data/trailer-frames --preview
node scripts/render-trailer.cjs --capture .test-data/promo-take --game <已获许可的游戏片段.mp4> --out .test-data/trailer-final --music <用于本片的本地音频.mp3>
```

第一条命令生成关键帧，第二条同时生成无配乐画面母版 `picture.mp4` 和成片 `trailer.mp4`。`--music-offset <起始秒数>` 可选择音频起点；省略 `--music` 则仅输出画面。程序按录制分段标记定位实录，并记录讲稿、画面源码、录制及音源哈希，避免混用不同版本的素材。字体使用系统微软雅黑与楷体，不随项目分发。

风格研究参考[汤姆 CC 的 GitHub 成片](https://www.bilibili.com/video/BV1NxpR6WEZx/)与其[制作教程](https://www.bilibili.com/video/BV1uBpg6qEYM/)，并研究了 [vibe-knowledge-film](https://github.com/HeyChengC/vibe-knowledge-film) 的画面组织方法。实际镜头、文案和渲染代码独立制作，未复用参考片画面或参考项目代码。

本片配乐为 **和乐府《千年之后（氛围版）》**，使用制作者提供的本地音频，正式曲目见 [QQ 音乐](https://y.qq.com/n/ryqq/songDetail/001GdVX40CBpdy)。没有从参考视频提取配乐。原始音源不加入代码仓库、安装包或更新服务器，音乐权利归原权利人，不属于本项目的 MIT 授权。

## 重建界面截图

```powershell
node scripts/capture-showcase.cjs .test-data/showcase
```

脚本启动实际应用，使用独立的示例进度，通过正常界面操作采集截图；不读取个人存档、不启动或附加游戏。输出目录必须是新目录。PNG 用于图片素材，WebP 用于 README。截图中的演示状态不代表作者的实际游戏进度。

## 录制连续操作

```powershell
node scripts/capture-promo.cjs .test-data/promo-take
```

录制脚本在独立示例进度中操作实际 Electron 窗口，保存界面变化的高分辨率帧、鼠标位置、点击时间及分段标记。流程段展示当前行动、推进影响、下一阶段与未接任务线索；图鉴段串起任务奖励、材料、地图、装备数值、配方与选择取舍。随后查看同一人物的私物和请教内容、创建并校验完整备份、打开备料与显示设置，最后收起随行。未接任务的图鉴查询仅为选择参考，不冒充现场触发。

记录通过后才标记完成；中途错误会保留已采集的本地记录。视频渲染器不接受未完成的录制。既不替换界面文字，也不使用截图切换伪造操作结果。

## 用代码生成详细演示

需要 Python 3.12+、Pillow、NumPy 和 FFmpeg。旁白制作另用 `edge-tts==7.3.1` 调用 Microsoft Edge 在线语音服务；该工具仅用于宣传素材制作，不进入应用依赖或安装包。公开讲稿见 [promo-script.json](promo-script.json)，每段音频附带句子时间戳。字体默认使用 Windows 自带的微软雅黑与楷体，也可用参数指定其他有权使用的字体文件。

```powershell
python scripts/narrate-promo.py --out .test-data/promo-narration
python scripts/create-promo.py --capture .test-data/promo-take --narration .test-data/promo-narration --game <获授权采集的游戏片段.mp4> --out .test-data/promo-preview --preview-only
python scripts/create-promo.py --capture .test-data/promo-take --narration .test-data/promo-narration --game <获授权采集的游戏片段.mp4> --out .test-data/promo-final
```

代码按分段标记剪去录制等待，保持点击与结果的先后关系；镜头推进、阅读停顿和鼠标轨迹都围绕当前操作。字幕跟随旁白句子时间戳，片头注明 AI 合成旁白。配乐为原创程序合成，点击音与实际输入对齐，不采样游戏音乐；讲解时降低音乐音量，停顿时平缓恢复。渲染过程只读取已生成的本地音频，并检查讲稿及音频哈希。

先检查分镜预览，再检查连续片段：鼠标是否点中目标、结果是否接着出现、地图与人物是否前后关联、放大时文字是否清楚、字幕是否遮挡结果、旁白是否与操作相符。声音还应核对人声清晰度、背景音乐和字幕时序。联系图仅用于构图检查，不能代替动态验收。输出包含 MP4、封面、联系图、混音、SRT 字幕与制作记录，不覆盖已有输出目录。游戏原片需包含长于片尾旁白的连续收尾画面。

游戏片段应在获得玩家许可后单独采集，检查完整画面，避开账户、聊天和其他程序。自动测试不得以录制宣传片为由启动或接入游戏。当前宣传素材中的游戏场景为实际采集，手札界面为示例进度，合成展示不作为原生存读档能力的验证证据。

## 发布范围

README 只提交精选 WebP 截图。成片与封面随 GitHub Release 提供，不放入应用安装包；原始录像、测试状态、工作文件和制作记录保留在本机。共享更新服务器只保存最新版安装包与必要更新清单，不上传宣传素材。

游戏画面、地图、角色和物品素材权利归原权利人，不属于项目 MIT 授权；字体仅用于渲染，不分发字体文件。详细功能演示中的程序配乐由本项目代码生成，宣传短片的配乐署名见上文。
