# 监听端口阶梯（WSL 宿主访问不了 → 自动换端口/换绑定）

## 需求

operator 2026-11-15：**「paintress web 开启后 host 浏览器打不开」**，并且要求把这类失败做成闭环：

1. 默认端口改成 **6033**（60 号肉身成圣远征队 + 33 号远征队），不再用 3316。
2. 启动时判断是否在 WSL 内；在 WSL 内要设法检测 **Windows 那边能不能访问到**。
3. 访问不到 → 跳端口 `6133` → `6233`；都失败 → 改绑 `0.0.0.0` 再用同样三个端口；**最多 6 次**。
4. 每一轮除了宿主可达，还要解决 **WSL 内外的端口冲突**（本机 EADDRINUSE / 宿主占用 / 宿主保留段）——冲突同样换端口。
5. 实在不行才报错，且错误里要有可执行的出路。
6. 最终端口与绑定方式若影响人/agent 的访问方式，**启动时传给 agent**。
7. 显式 `--port` **不跳级**：端口被占直接报错。
8. operator 追加的链路优化：**先找工作端口 → 再起服务 → 最后复核**，而不是「起了再拆」。

## 现场与根因（2026-11-15 实测）

| 检查 | 结果 |
| --- | --- |
| WSL 内 `curl 127.0.0.1:3316` | 200（daemon 正常） |
| Windows 侧 3316 监听 | 无；而 17318 / 34179 / 80 都有 `wslrelay.exe` 监听 |
| Windows 侧 bind `127.0.0.1:3316` / 对照 `:4316` | 前者失败（WSAEACCES 10013），后者成功 |
| `netsh int ipv4 show excludedportrange protocol=tcp` | Hyper-V 保留 `3228–3327`，**3316 正落其中** |
| Windows 动态端口段 | 曾被改成 `1024–15000`，Hyper-V 每次开机在这段里重划保留块，位置会漂 |

结论：**WSL2 的 `localhost` 转发由宿主侧 `wslrelay.exe` 落地**——Windows 上绑不上这个端口，
转发就不存在；发行版内部永远自测通过。这一类故障在 WSL 内部无法观测，只能从宿主侧问。

## 方案

### 顺序：先定端口、再起服务、最后复核

| 阶段 | 做什么 | 成本 | 证明了什么 |
| --- | --- | --- | --- |
| 0 宿主体检 | 一次 PowerShell：`netsh` 保留段 + 三个候选端口在 `127.0.0.1` 上能否**独占绑定** | 热 ~0.3s（冷启动可达 2s） | 「宿主上到底能不能绑」——转发的前提 |
| 1 选端口 | 在阶梯上逐个 `listen` 后立刻 `close`，把 WSL 内冲突筛掉 | 每个 <1ms | 内外两侧都可用 |
| 2 起服务 | 用已确认的 `(port, host)` 真正 listen | ~0 | 只绑一次，没有拆建 |
| 3 复核 | 从宿主侧 `GET /api/ping`，正文必须含本次进程的 **nonce** | loopback 预算 1.8s（实测 wslrelay 接管 300–1060ms），all 600ms | 端到端真的通，且应答的是自己 |

第 3 步不能省的唯一理由：宿主体检只能证明「宿主绑得上」，不能证明「转发路径通」；
反过来，nonce 让「端口上蹲着别的程序 / 另一个 distro 的 paintress」不会被误判成成功。

### 阶梯（顺序即优先级）

| # | bind | port | 通过条件 |
| --- | --- | --- | --- |
| 1–3 | `127.0.0.1` | 6033 / 6133 / 6233 | WSL 可绑 && 不在宿主任保留段 && 宿主可独占绑 && 复核通过 |
| 4–6 | `0.0.0.0` | 6033 / 6133 / 6233 | WSL 可绑 && 复核通过（宿主经网卡地址） |

- 兜底 `0.0.0.0` 有效的实测依据：保留端口上 `localhost` 连不通（000），而 `WSL_IP` 返回 200。
- 整条阶梯硬上限 9s；`ensureDaemon` 等待上限从 6s 提到 15s（要给冷 interop 留余量）。
- 显式 `--port` 只产生**一个**候选（`--bind auto` 视为 loopback），失败即报错——不跳级。
- `port: 0`（测试/嵌入）整段宿主校验跳过。

### 冲突面（都被同一张表吃掉）

- WSL 内 `EADDRINUSE` / `EACCES` → 下一个候选；
- 宿主保留段（Hyper-V）→ 预检直接跳过，不浪费重启轮；
- 宿主已被别的进程占用 → 预检 `bindable=false`，跳过；
- 宿主绑得上但转发不通 → 复核失败，跳过并关掉刚起的 server。

### 传给 agent

控制面是 Unix socket，端口/绑定**不影响 agent 自己连 daemon**；影响的是「给人打开的地址」。
因此 `pong` 增加 `access`，一路带到 `ensureDaemon` → `ViewerInfo` → `paintress_viewer` / `paintress web` / `paintress status` / daemon 页面：

```ts
access: {
  url: string;          // 人该打开的完整地址（all 模式是 http://<wsl-ip>:6033/）
  host: string;         // URL 里的主机名
  bind: 'loopback' | 'all';
  windows: 'ok' | 'unavailable' | 'skipped';
  jumped: boolean;      // 实际端口偏离了期望端口
  requestedPort: number;
  attempts: { port: number; bind: 'loopback' | 'all'; result: 'ok' | 'in-use' | 'windows-reserved' | 'windows-unreachable'; detail?: string }[];
}
```

- `paintress_viewer` 额外给 `note`：`bind=all` 或 `jumped` 时明说「用返回的 url，别用 localhost」。
- CLI 的 `http` 字段保持历史形态（无结尾斜杠），值取 `access.url`；`access` 原样附带。
- 旧版 daemon 不回 `access` 时按「本机 loopback」补，不炸。
- `paintress doctor` 增加 `net` 一节（WSL 判定 / interop / 默认路由 IP / 三候选的保留段与可绑性 / 运行中 daemon 实况）。

## 验收

- `test/bind-ladder.spec.ts` 10 例：默认候选序、保留段跳过、宿主占用跳过、本机 EADDRINUSE 跳级、
  loopback 三连全失败落 `0.0.0.0`、六候选全灭报错带明细、显式端口不跳级、显式 + `--bind all`、`port 0` 不探测。
- 全仓 `pnpm check` / `pnpm test` / `pnpm build` 三条全绿。
- 手工（WSL）：`paintress web` → 宿主浏览器打开 `access.url`；把默认端口临时改到保留段内可复现跳级。

## 已知边界

- interop 不可用（`WSLInterop` 未注册 / `/mnt/c` 不在）→ 跳过宿主校验，`windows: 'unavailable'`，
  行为等价于旧版（不保证宿主可达）。
- `0.0.0.0` 会暴露到局域网；这是本地看图工具，项目既有立场是不做鉴权（见 `daemon.ts` 的 Origin 说明），
  只在输出与文档里明示。
- Windows 侧的根治仍是把动态端口段恢复默认（`netsh int ipv4/ipv6 set dynamicport tcp start=49152 num=16384`，需管理员 + 重启）；
  端口阶梯只是让工具在错误的端口布局下依然可用。
