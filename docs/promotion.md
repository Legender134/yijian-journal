# 宣传素材制作

宣传片以“在游戏旁边，知道下一步”为主题，展示流程、比武请教、关联图鉴、地点地图和存档。70 秒，1920 × 1080，24 fps；墨绿与纸色延续应用风格。

## 重建界面截图

```powershell
node scripts/capture-showcase.cjs .test-data/showcase
```

脚本启动实际应用，使用独立的示例进度，通过正常界面操作采集截图；不读取个人存档、不启动或附加游戏。输出目录必须是新目录。PNG 用于视频，WebP 用于 README。截图中的演示状态不代表作者的实际游戏进度。

## 用代码生成视频

需要 Python 3.12+、Pillow、NumPy 和 FFmpeg。字体默认使用 Windows 自带的微软雅黑与楷体，也可用参数指定其他有权使用的字体文件。

```powershell
python scripts/create-promo.py --screens .test-data/showcase --game <获授权采集的游戏片段.mp4> --out .test-data/promo-preview --preview-only
python scripts/create-promo.py --screens .test-data/showcase --game <获授权采集的游戏片段.mp4> --out .test-data/promo-final
```

先检查分镜预览和文字，再渲染成片。代码负责画面排版、入场、转场、片尾与原创程序配乐；不依赖在线生成服务，不采样游戏音乐。输出包含 MP4、封面、分镜联系图和制作记录，不覆盖已存在的输出目录。

游戏片段应在获得玩家许可后单独采集，检查完整画面，避开账户、聊天和其他程序。自动测试不得以录制宣传片为由启动或接入游戏。当前宣传素材中的游戏场景为实际采集，手札界面为示例进度，合成展示不作为原生存读档能力的验证证据。

## 发布范围

README 只提交精选 WebP 截图。成片与封面随 GitHub Release 提供，不放入应用安装包；原始录像、测试状态、工作文件和制作记录保留在本机。共享更新服务器只保存最新版安装包与必要更新清单，不上传宣传素材。

游戏画面、地图、角色和物品素材权利归原权利人，不属于项目 MIT 授权；字体仅用于渲染，不分发字体文件。影片中的程序配乐由本项目代码生成。
