# 发布到 DSH 插件市场

DSH 的插件市场（dshmarket）不直接收投稿，它读的是
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 这个目录仓库：
每个插件一个 YAML，合并后网站与市场自动更新（通常一天内）。

要上架，需要三样东西：

1. 一个 **GitHub 仓库**（根 `package.json` 声明 `dsh.bundle`，仓库创建满 1 天，带 `dsh-plugin` topic）。
2. 可选但推荐：**npm 包**（市场能显示下载量，安装也免去源码构建）。
3. 一个 **目录条目 PR**：`data/plugins/subeichen1__dsh-auto-effort.yml`。

本仓库已经满足代码侧要求（`dsh.bundle` + `cordis.patch.yml` + 可用的 `index.js`/`client.js`），
下面只差账号操作。

## 0. 先决条件

- GitHub 账号（仓库会放在 `subeichen1/dsh-auto-effort`）。
- npm 账号（包名 `dsh-auto-effort` 目前未被占用）。
- 仓库创建后要等 **满 24 小时** 才能通过目录 CI；可以今天先建仓库、发 npm，明天提 PR。

## 1. 建仓库并推送

在 GitHub 新建空仓库 `dsh-auto-effort`（不要初始化 README），然后：

```powershell
cd "C:\Users\18460\Desktop\项目\自动调节思考强度\dsh-auto-effort"
git remote add origin https://github.com/subeichen1/dsh-auto-effort.git
git branch -M main
git push -u origin main
```

推送前把 `package.json` 里的占位补上（npm 与目录都靠它把包和仓库关联）：

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/subeichen1/dsh-auto-effort.git" },
"homepage": "https://github.com/subeichen1/dsh-auto-effort#readme",
"bugs": { "url": "https://github.com/subeichen1/dsh-auto-effort/issues" },
```

再到仓库 **Settings → Topics** 加 `dsh-plugin`（目录 CI 会检查）。

## 2. 发布 npm

```powershell
cd "C:\Users\18460\Desktop\项目\自动调节思考强度\dsh-auto-effort"
npm login          # 浏览器/OTP 登录
npm publish        # package.json 已设 publishConfig.access=public
```

发布后确认：

```powershell
npm view dsh-auto-effort version repository.url
```

`repository.url` 必须指回第 1 步的仓库，否则市场不会把包和条目关联起来。

## 3. 提交目录条目

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建
`data/plugins/subeichen1__dsh-auto-effort.yml`，内容用本目录的
[`catalog-entry.yml`](./catalog-entry.yml)（把 `subeichen1` 换成你的 GitHub 用户名），然后提 PR。

条目字段：

```yaml
url: https://github.com/subeichen1/dsh-auto-effort
name: subeichen1/dsh-auto-effort
category: model
description:
  en: '...'
  zh: '...'
icon: https://raw.githubusercontent.com/subeichen1/dsh-auto-effort/main/assets/icon-180.png
```

- `category: model`（模型与账号接入）最贴近：它调的是模型的推理强度。
- 图标必须是 GitHub 托管的位图；本仓库的 `assets/icon-180.png` 已按 180×180 生成。
- 截图可选：在仓库根放 `screenshots.json` 列出 1–8 张图，市场详情页会展示。
- 描述必须与代码一致，不要写「支持所有模型」这类超出实现的话。

CI 会检查：条目数 ≤3、`dsh.bundle` 存在、仓库满 1 天、YAML 与生成 README 一致。

## 4. 之后发版

改代码 → 提升 `package.json` 的 `version` → `git push` → `npm publish`。
市场按 npm 版本提示更新；目录条目不用再动。

## 当前状态

- [x] 代码、`dsh.bundle`、`cordis.patch.yml`、客户端、图标、测试（21 项）
- [x] `npm pack` 内容核对（9 个文件，26 KB）
- [ ] GitHub 仓库与 `dsh-plugin` topic
- [ ] npm 发布
- [ ] 目录 PR（仓库满 1 天后）
