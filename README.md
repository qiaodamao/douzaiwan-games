# 小游戏 🐾

H5 小游戏聚合站，收录 **70 款**免费网页小游戏，打开即玩，手机 / 电脑均支持。

## 目录结构

```
├── index.html   # 聚合首页（搜索 / 分类筛选 / 随机玩）
├── play.html    # 游戏播放页模板（iframe 加载 + 全屏 / 刷新）
├── g/           # 每款游戏的静态落地页 g/<id>.html（构建自动生成，勿手改）
├── data.js      # 游戏数据（构建自动生成，勿手改）
├── thumbs/      # 封面缩略图（构建自动生成）
├── build.mjs    # 构建脚本
└── list/        # 游戏目录，每个子目录一款游戏
    └── <id>/    # 目录名即游戏 id（小写字母或数字开头的 slug）
        ├── …    # 游戏本体文件
        ├── game.json  # 元数据：title / cat / emoji / entry / hot
        └── cover.png  # 封面（png / jpg / jpeg / webp / gif）
```

## 新增 / 删除游戏

新增游戏：

1. 在 `list/` 下新建目录，目录名为小写字母或数字开头的 slug（仅 `[a-z0-9-]`，如 `list/space-huggers/`、`list/2048-game/`），放入游戏文件；
2. 目录内添加 `game.json`（`entry` 为入口文件，默认 `index.html`；`hot` 为是否推荐）和封面 `cover.png`（或 .jpg 等）；
3. 首次运行 `npm install`，之后执行 `npm run build`；
4. 提交游戏目录与自动生成的 `data.js` / `thumbs/` / `g/<slug>.html`。

删除游戏：删掉 `list/<对应目录>/` 后重新 `npm run build`，会自动清理对应的缩略图、落地页与数据条目。

> 旧数据迁移：`node build.mjs migrate`（从手写版 data.js 生成各游戏 game.json 与封面，已执行过，幂等可重跑）。

## 本地预览

直接用任意静态服务器打开即可，例如：

```bash
npx serve .
# 或
python -m http.server 8000
```

> 直接双击 index.html 也能用，但部分游戏在 file:// 协议下可能受限，建议用静态服务器。

## 部署到腾讯 EdgeOne Pages

1. 把本仓库推送到 GitHub（建议公开仓库）：

   ```bash
   git init
   git add .
   git commit -m "feat: 都在玩聚合站"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

2. 打开 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages)，点击 **创建项目** → **导入 Git 仓库**，选择刚推送的 GitHub 仓库并授权。

3. 构建配置：
   - 框架预设：**无 / 纯静态（None）**
   - 输出目录：`/`（根目录）
   - 构建命令：留空

4. 点击 **部署**，完成后会获得一个 `*.edgeone.app` 的免费域名，绑定自定义域名也在同一控制台操作。

之后每次 `git push`，EdgeOne Pages 会自动重新部署。

## 说明

游戏素材均来源于网络，仅供学习交流使用。
