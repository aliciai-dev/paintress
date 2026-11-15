# 2026-11-15T15:28+08:00 — Stop a dead stderr pipe from killing the viewer daemon

在查看器侧栏点「解绑」后，整个 `paintress web` 进程消失，控制面 socket 变成僵尸文件（ECONNREFUSED），且没有任何日志可查。

## 根因（已复现）

后台 daemon 由 CLI 用 `spawn(..., stdio: ['ignore','ignore','pipe'])` 拉起，stderr 管道的读端就是那个 CLI 进程；CLI 在 daemon 就绪后**立刻退出**（`paintress web` 默认形态），于是 daemon 的 `process.stderr` 成了一个没有读者的管道。之后任何一次 `process.stderr.write()` 都会得到 EPIPE，而未处理的 stream `error` 事件会直接结束进程。

触发点全是日常操作：解绑项目的日志（daemon.ts:402）、建项目脚手架的日志（502）、绑定降级日志（1284）、关停日志（1371）。

复现：后台起 daemon → 让拉起的 CLI 退出 → `paintress watch` 一个新项目（会写日志）→ daemon 当场死亡，socket 残留。修复后再跑同一场景：daemon 存活，日志落进 `web.log`。

## 修复

- `src/web/daemon.ts`：新增 `daemonLog(line)`，所有 daemon 日志改走它——写 stderr 失败吞掉，同时 append 到 `<runtimeDir>/web.log`（超过 512 KB 从头写）。五个 stderr 写入点全部替换。
- `startDaemon()` 入口加 `process.stderr.on('error', () => {})` 兜底：管道断开只该丢一行日志，不该结束常驻进程（异步报错，光 try/catch 盖不住）。
- 之前完全没有日志文件，这次事故无从取证，所以顺带补上 `web.log`。

## 验证

- 新增 `test/daemon-log.spec.ts`：`stderr` 的 error 事件不抛出；外加一条端到端回归——后台拉起 daemon、等拉起器退出、让 daemon 写一行日志，断言**同一个 pid 仍然在、且 web.log 有内容**。
- 反向验证：把修复临时退回（不装 error 兜底 + 直写 stderr），该用例 2/2 失败（「daemon 在写日志后没了」）；恢复修复后 2/2 通过——确认这是真回归测试，不是摆设。
- `pnpm check` 干净；`pnpm test` 34 文件 / **440 用例全绿**。

## 附带

- README 演示图换成崔总自己的截图（`demo/demo-calculator.webp`，1600×900，未做任何处理，md5 与源文件一致），两份 README 的 `src`/`href` 指向它。PNG 中间版本只存在于未推送的临时提交，已从历史中移除，不会随 push 进入仓库。
- 另记录（不在本次改动内）：工作区的 `tsdown.config.ts` 被改成 `dts: true`，与该文件自己的注释冲突（dts 因 TS7056 暂关），会让 `pnpm build` 直接失败；本次未触碰，验证期间用 `git stash` 临时绕过。
