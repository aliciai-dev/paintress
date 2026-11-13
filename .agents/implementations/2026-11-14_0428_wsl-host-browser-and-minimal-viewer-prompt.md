# 2026-11-14T04:28+08:00 — 弹窗改落宿主浏览器；提示词收敛成「作画前跑 paintress web」

operator 让 AI 看 design 里的设计稿：viewer 起来了，但弹窗落在 **WSL 内的 Linux 浏览器**（WSLg 设了 `DISPLAY`/`WAYLAND_DISPLAY`，`xdg-open` 就走本地浏览器），不是 Windows 宿主浏览器。而且提示词里还写着让 agent 自己开浏览器 / 把 URL 交给用户——那类指令在 WSL 里必错。

## 改动

### 1. 窗口落在哪台机器：`src/web/open-browser.ts`

- 新增 WSL 判定（`WSL_DISTRO_NAME` / `WSL_INTEROP` / `/proc/sys/kernel/osrelease` 含 `microsoft`），**WSL 下绝不回退 `xdg-open`**。
- WSL 里按可靠度选启动器：`wslview` → `powershell.exe -NoProfile -Command "Start-Process '<url>'"` → `cmd.exe /c start "" <url>` → `explorer.exe <url>`；一个都没有就返回 `null`（宁可不弹，也不弹错的浏览器）。
- 纯函数 `browserLauncher(url, ctx)` / `isWsl(ctx)` 可注入 platform/env/osrelease/存在性判定，便于单测；原生 Linux 仍用 `xdg-open`，无图形环境仍跳过。

### 2. 提示词：只说一条命令

- `src/mcp/server.ts` 的 MCP `instructions`：VIEWER 段改成「作画前跑 `paintress web`，它确保查看器在跑并立刻返回」+ 一句「窗口是命令的事，你不要开浏览器 / 不要起进程」；删掉「把 URL 交给用户」和 `paintress web --daemon` 的说法。
- `src/mcp/tools.ts`：`paintress_viewer` 描述去掉「返回人可以打开的 URL」，返回值删掉 `openedBrowser` 与 `hint`。
- `skills/paintress/SKILL.md`（仓库版 + 已安装副本 `~/.pi/agent/skills/paintress/SKILL.md`）：`paintress web` 一句话说明，删掉「Ask the user to open the URL」「Starting the viewer … opens the browser」「Never run plain paintress web — the foreground form blocks」等段落。
- `registerSelf` 的 stderr 文案改为中性的「已注册项目 …（url）」。

### 3. CLI：裸 `paintress web` = 打开查看器

- `paintress web` 默认形态：`reuseDaemon` → 否则 `ensureDaemon`，打印 `pid/port/http` 立刻返回（窗口由子进程自己开）。
- `--foreground`：占住终端跑（原前台行为，日志可见）。`--daemon` 保留为兼容别名。`ping` 的 hint 同步改成 `paintress web`。
- `src/web/spawn.ts`：拉起的子进程命令改为 `web --foreground`（否则裸 `web` 会递归）。
- `src/web/autoregister.ts`：`ensureDaemon({ noOpen: true })` + 由 ensureViewer 用项目深链弹**一个**窗口（原来子进程弹 `/`、ensure 再弹项目页 = 两个标签页）。

## 验证

- `pnpm check` 0 错误；`pnpm test` **22 文件 297 用例全绿**；`pnpm build` 通过。
- 新增/更新用例：`test/web.spec.ts` 加「WSL 里即使有 xdg-open 也不用它」「wslview→powershell→cmd→explorer 顺序」「PowerShell 命令把 URL 当单引号字面量」「WSL 判定三判据」「非 WSL 分支」5 个；`test/mcp.spec.ts` 断言 instructions 不出现 `--daemon` 且含「never launch a browser」；`test/viewer-ensure.spec.ts` 加 `--foreground` 复用用例。
- **真机实测（WSL2 + WSLg）**：`PAINTRESS_HOME=/tmp/... node dist/cli.js web --port 3398` → 立即返回 JSON；Windows 侧 `Get-Process | Where MainWindowTitle -match '3398'` 看到 **firefox** 窗口带 paintress 标题（修前会是 WSLg 里的 Linux 浏览器）；再跑一次 reused、`ping`/`stop` 正常，临时目录已清理。

## 未做

- 没有在「宿主浏览器」这条路径上加自动化断言（跨 OS 弹窗无法在 CI 里验）；用单测锁启动器选择 + 人工确认窗口。
- 全局安装的 `paintress` 仍是旧版（按分工由 operator 重新安装后才生效）；仓库内 `dist/` 已用新代码构建。
