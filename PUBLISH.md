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

## 2. 发布 npm（可选）

> 当前状态：npm 账号 `ssccss` 的 2FA 已开启，但密钥没有留存（见文末「事故记录」）。
> 这不影响上架：目录条目已改用 GitHub Release 的 tarball。

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

不发 npm 也可以：`npm pack` 生成 tarball，传到 GitHub Release，条目里用 `tarball:` 指向它。
本仓库已经这样做：

```
https://github.com/subeichen1/dsh-auto-effort/releases/latest/download/dsh-auto-effort.tgz
```

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
- [x] GitHub 仓库：https://github.com/subeichen1/dsh-auto-effort（已推 `main`，已加 `dsh-plugin` topic）
- [x] Release tarball：https://github.com/subeichen1/dsh-auto-effort/releases/tag/v1.0.0
- [x] 目录 PR：[awesome-dsh-plugin#13567](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13567)（条目已带 `tarball:`）
- [ ] 目录 PR 合并（仓库创建满 1 天后 gate 自动放行）
- [ ] npm 发布（账号 2FA 待恢复，见下）

## 事故记录：npm 2FA 密钥未留存

2026-11-09 为了通过 npm 的「发布必须 2FA」限制，用 `npm profile enable-2fa auth-and-writes`
在账号 `ssccss` 上开启了 2FA。脚本在提交 TOTP 后挂住，被终止时**还没有把 base32 密钥和
recovery codes 写入备份文件**，因此现在这个账号的 2FA 密钥无人持有。

影响范围：只影响 `ssccss` 这个当天新建、没有发布过任何包的 npm 账号；GitHub 仓库、Release
与市场条目都不受影响。

恢复选项：

1. 用 npm 官方支持重置：https://www.npmjs.com/support （说明账号新建、2FA 刚开启、密钥未保存、无 recovery codes、无已发布包）。
2. 放弃该 npm 账号，用另一个邮箱注册新账号；`dsh-auto-effort` 这个包名仍然空闲。
3. 如果当时浏览器里生成过 recovery codes，用其中一条关闭 2FA。

以后再用 CLI 开 2FA 时，必须先把 `secret` 与 recovery codes 落盘，再提交 OTP。
