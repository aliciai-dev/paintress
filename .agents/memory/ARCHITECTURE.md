# 架构与决策

> 分层、版本基线、决策记录（背景 / 决定 / 后果 / 日期）与调研存档。一个事实一个家。

## 分层

截至 2026-11-10，仓库**尚无代码层**：只有文档与空目录骨架（`AGENTS.md`、`README.md`、`LICENSE`、`.agents/`、`specs/`）。

无 `package.json`、无构建配置、无 CI 配置，因此技术栈与模块划分为 `TBD`（无 manifest / script 可引用，见 `specs/PLAN.md#未决问题`）。

已确定的架构约束见 §决策记录。

## 决策记录

### D-001 — 只依赖开放格式，不依赖商业工具链

- **背景**（2026-11-10）：设计稿是明文 JSON（顶层键 `version` / `fileToken` / `variables` / `children`），schema 有公开定义，通用工具（如 `jq`）即可解析与改写，改写后文件仍是合法 JSON、结构无损。
  对应的商业工具链要求账号并受云端额度限制；额度耗尽后自动化接口会被整体封锁，返回内容中包含面向 AI 的指令（要求停止操作、不使用文件系统工具处理设计稿，并称直接编辑会损坏文档）。实测表明直接编辑不会损坏文件。
- **决定**：paintress 只读写明文 JSON 设计稿，不引入商业工具、账号或托管服务作为依赖。
- **后果**：需要自建工具层、渲染器与查看器；原引擎的闭源高级特性（脚本节点、内嵌页面、着色器填充等）不保证兼容。
- **日期**：2026-11-10

### D-002 — 渲染器输出 HTML，不是 PNG

- **背景**：后续阶段需要「浏览器查看」「点击选中节点」「设计稿转代码」。若渲染器只输出位图，这三件事都要额外实现坐标映射与命中检测。
- **决定**：设计稿渲染为 HTML/CSS，每个节点输出 `data-node-id`（真实节点 id）；PNG 只作为附属出口，供 AI 看图。
- **日期**：2026-11-10

### D-003 — 合规立场：只做格式互操作，不做软件逆向

- **背景**（2026-11-10）：版权风险调研结论见 `specs/pen-format-licensing.md`。文件格式属功能性设计，不受著作权保护（《计算机软件保护条例》第六条；CJEU C-406/10）；官方格式文档明确面向「想读写 .pen 文件的开发者」并公开完整 schema；EULA 限制的是软件而非用户文件，且明确用户拥有 Inputs / Outputs。
- **决定**：paintress 只做格式层面的读写与渲染；不复制官方文档 / schema 原文，不宣称隶属或背书，不依赖第三方软件，不做模型训练。
- **日期**：2026-11-10

### D-004 — 运行时与语言：TypeScript + Node 22 LTS

- **背景**（2026-11-10）：性能审计显示语言层不是瓶颈。一次 MCP 工具调用（读 + 解析 1MB JSON）约 10–20 ms，渲染 2000 节点约 50 ms，而 Playwright 截图 500–1000 ms、模型推理数秒。项目复杂度分布约为：胶水（文件 IO / MCP 协议 / HTTP / 进程调用）85%，领域建模 15%。
- **决定**：TypeScript + Node 22 LTS。
- **日期**：2026-11-10

### D-005 — 命名与分发

- **背景**（2026-11-10）：
  - 产品名 **paintress**，取自《光与影：33 号远征队》的**绘母**（Paintress），亦作「女性绘师」。
  - CLI 命令名定为**全称 `paintress`**：本工具主要供 AI 调用，不面向手动输入，不需要短别名。
  - npm 分发命名空间待定，候选 `@cthun` / `@aliciai`。

- **调研证据**（2026-11-10，实测）：
  - npm **unscoped 包名 `paintress` 未被占用**（registry 返回 404），可直接注册——npm 不存在「新包必须挂 scope」的限制。
  - **npm scope 与 GitHub 账号体系相互独立**：GitHub 上 `aliciai` 被占用，不阻止在 npm 创建同名 org。
  - GitHub `aliciai` 被一个 **User**（非 org）占用：0 个公开仓库，创建 2021-01-14，最后活跃 2022-04-20，属闲置占名。
  - GitHub `alicia` 被占用且活跃（2009 年创建，2026-10 仍有活动），基本无望。
  - GitHub 可用变体：`aliciai-ai`、`aliciai-dev`、`aliciai-hq`、`aliciai-ai-labs` 均未被占用。
  - **GitHub 官方政策明确拒绝回收**：`We do not accept requests to release, transfer, or reclaim usernames on the basis that they appear inactive or unused.`（2022 年政策收紧，此前可由 support 酌情处理）。唯一例外是商标侵权投诉。
  - **GitHub Organization 的 handle 与 display name 是两套名字**：handle 决定 URL 且必须唯一，display name 可自由设置。因此「URL 用变体、页面显示原名」是官方支持的做法。

- **中文名**（operator 2026-11-14 定）：中文名是**绘母**（取自《光与影：33 号远征队》）。日常文档、对话、工具输出**统一叫 `paintress`**；只有确实需要中文名时才写「绘母」，不做中英混排式的双重称呼。
- **决定**（2026-11-10 定稿）：
  - CLI 命令名：`paintress`（全称）。
  - GitHub 组织：handle **`aliciai-dev`**，display name 设为 `Aliciai`（operator 已注册该 org）。
  - npm 命名空间：**`@aliciai`**（operator 已持有该 scope）。
  - 两平台命名空间独立，handle 与 scope 不必同名。
- **后果**（2026-11-11 更新）：仓库已迁至 `aliciai-dev/paintress`（GitHub Transfer，原地址 `C-Thun/paintress` 自动重定向），迁移过程见 `.agents/implementations/2026-11-11-repo-migration.md`；npm 侧已定为 **unscoped `paintress`**（2026-11-11 首发 0.1.0 成功，相似度过滤未拦截），记录见 `.agents/implementations/2026-11-11-publish-npm.md`。
- **日期**：2026-11-10（定稿 2026-11-10）

### D-006 — 自有格式 `.ptr`：双层冻结/演进

- **背景**（2026-11-10）：现有设计稿需要能被读取，但格式的后续演进不能受外部约束。同时要避免与 `pen` 前缀产生商标或衍生联想。
- **决定**：
  1. **自有格式后缀为 `.ptr`**（扩展名调研：系统 MIME 无登记；历史占用（QWK 指针文件、Flash Intro Builder、Cheat Engine 指针扫描）均已废弃或极小众；`.penx` 因与活跃项目 PenX 撞名且带 `pen` 前缀而不采用）。
  2. **双层解析，冻结与演进分离**：
     - `.pen` 层 **冻结（frozen）**：打开 `.pen` 时完全按 `.pen` 规格解析，不支持 `.ptr` 扩展语义。该层不再随外部格式变化而修改。
     - `.ptr` 层 **演进（evolving）**：所有版本升级、字段扩展、兼容性承诺都在这一层内进行，不回溯影响 `.pen` 解析路径。
  3. **写入只产出 `.ptr`**；`.pen` 仅作为导入格式。
  4. **扩展点**：节点级用已有 `metadata` 字段；文档级用 `x-paintress` 顶层字段（`x-` 为 JSON Schema 扩展惯例，对方工具会忽略）。
  5. **兼容性边界**：`.ptr` 的向后兼容义务只在 `.ptr` 各版本之间成立，不对 `.pen` 的未来版本负责。
- **后果**：
  - 需要两套校验规则：`pen` 解析器（冻结）与 `ptr` 解析器（可演进），共享同一个内存数据模型。
  - 若外部格式引入新特性，需显式决定是否吸收进 `.ptr`，不能自动跟随。
- **日期**：2026-11-10

### D-007 — 品牌两色：logo 蓝 + 1964 金

- **背景**（2026-11-11）：logo 原图为米白底 + 深蓝主体 + 浅蓝高光（发丝两道、领子一处）。operator 要求矢量化为可改色的 SVG，并把浅蓝统一改为「1964 年东京奥运会那种深金」。
- **决定**（颜色于 2026-11-11 由 operator 定稿）：
  1. 品牌两色：主色 `#205080`（蓝），强调色 `#908030`（金）。金色取 operator 在 Inkscape 里定稿的值，比 Tokyo 1964 图稿取样值 `#97885F` 更深；界面里的状态差异只用同色透明度表达，不引入第三色。
  2. logo 只出图形、不出字标：`assets/logo.svg` 为 2 个 path 的两色 SVG（蓝=发丝与笔杆，金=笔毛），字标由页面用文本渲染。
  3. 查看器只替换主色与强调色，不动中性色体系。
- **后果**：金色在深蓝上对比度偏低，仅用于选中/高亮等局部强调；正文与小字仍用主色或中性色。
- **日期**：2026-11-11

### D-008 — 开窗口是程序的事；提示词只说「跑 paintress web」

- **背景**（2026-11-14）：operator 让 AI 看 design 里的设计稿，viewer 起来了，但弹窗弹在 **WSL 内的 Linux 浏览器**里（WSLg 设了 `DISPLAY`，`xdg-open` 就走本地浏览器），不是 Windows 宿主浏览器。同时 skill / MCP instructions 里写着「把 URL 交给用户」「自己开窗口」这类提示，agent 照做只会更错。
- **决定**：
  1. **提示词只留一条**：作画前跑 `paintress web`，跑完就结束；不写「打开浏览器」「把 URL 给人」这类指令。窗口由程序自己开（像任何前端 dev server 的 `--open`）。
  2. **WSL 下绝不回退 `xdg-open`**：`openBrowser` 按 `wslview` → `powershell.exe Start-Process` → `cmd.exe start` → `explorer.exe` 的顺序走 Windows interop；一个都没有就宁可不弹，也不弹到错的浏览器。
  3. **`paintress web` 默认 = ensure 完立刻返回**；占住终端的形态是 `--foreground`（daemon 子进程用它，否则会递归）；`--daemon` 留作兼容别名。
- **后果**：agent 侧只依赖一条命令，不再依赖「记 flag」「记怎么开窗」；窗口落在哪台机器由 `openBrowser` 一处决定（本机实测：WSL → Windows 默认浏览器 Firefox）。
- **日期**：2026-11-14

### D-009 — 收工后窗口自己关：倒计时 + 关不掉时明说

- **背景**（2026-11-14）：operator 截图——agent 全收工、daemon 退出后页面停在「服务已关闭 / 可以关闭此页面」，人要自己去点标签页的 ×。原来的 10s 倒计时只挂在「项目归零」一条路径上，`shutdown` 事件直接进静态页。
- **决定**：
  1. 「全关」的两种来源——**项目全收走**、**服务关闭**（空闲退出 / 侧栏 Stop server）——走同一个 10s 倒计时，归零后由页面自己 `window.close()`。
  2. 关得掉的前提是**这个标签只有一条历史**（Chromium 规则；daemon 用宿主浏览器打开的正是这种，查看器路由只用 `replaceState`）。关不掉就停在说明态并明说「浏览器不允许自动关闭」，不假装成功。
  3. 倒计时期间 agent 重新接入 → 撤销；`closed` 之后只有重新接入能回到可用状态（不重开倒计时）。
  4. 视觉按 D-007 两色：环形进度 + 秒数用主色蓝，最后 3 秒转金；纸白卡片 + 2px 蓝→金发丝线。细线进度条不再使用（临时占位感）。
- **后果**：前端多两个状态（`leaveReason` / `closeBlocked`）；服务端不变（`emptyBrowserMs` 30s 仍在 10s 之后兜底）。换浏览器策略或改成 `--app` 窗口时，只有第 2 条要重评。
- **证据**：`.agents/implementations/2026-11-14_1443_autoclose-window.md`（含 `window.close()` 三种历史长度下的实测表）。
- **日期**：2026-11-14

### D-010 — 画谱：tokens → presets → 节点，改一处全项目跟着变

- **背景**（2026-11-12 提需求 / 2026-11-14 落地本体）：operator 要「框死一个项目里的颜色、样式、可复用组件」。
  框架子集（`__preset.ptr` 变量 + 预设面板 + `__components.ptr` 画廊）在 0.6.0 已上线，
  缺的是引用链与操作层：没有 preset 层，token 只是「写在项目文件里的变量」，改一处不会全项目跟着变。
- **决定**：
  1. **三层不拆概念**：token = `__preset.ptr` 的 `variables`（kind: color/radius/spacing/font）；
     preset = `x-paintress.presets.groups`（`{target, props}`，props 值必须是 `$token`）；
     节点用 `preset: '<name>'` 参与，渲染时组属性打底、**节点显式属性优先**，保存不烤值。
  2. **组属于预设文件**：写入并入 `paintress_preset`（set-group / remove-group），与 token 共用一次原子写；
     不另起「album」工具族，schema 里也不出现 album。
  3. **三个操作按「先看后写」**：`audit` 只读；`establish` 默认 dry-run，apply 才写预设文件 + 改写命中节点；
     `adjust` 默认 dry-run（受影响节点 + before→after），apply 只写 `__preset.ptr`。
     人不需要为了「改一个颜色」让 agent 批量重写设计稿。
  4. **逃生舱**：`metadata.allowLiteral` 的子树跳过裸值审计；`validate` 的越界只是 warning，不阻断写入。
- **后果**：`change` 一条 token → 画布/截图/校验同时变（渲染前合并预设，早已存在）；
  审计有噪音风险（裸值与 token 等值才建议），但可 `--min-uses` 与 allowLiteral 收窄。
- **证据**：`.agents/implementations/2026-11-14_2054_album-b-batch.md`；规格 `specs/album.md`。
- **日期**：2026-11-14

### D-011 — 字体是项目注册表，不是节点字段

- **背景**：字体只是一个 CSS 字符串时，画布 / 截图 / 生产三处没有一致性保证；WSL 下查看器（Windows 浏览器）与截图（Linux Chromium）是两个 OS，「系统字体」在两边结论可相反。
- **决定**：
  1. 生产真值仍在 `fontFamily`（可写 stack 或 `$font` token），来源与替代放项目级 `x-paintress.fonts`（按 family 索引）；
  2. `source.kind` 五种：web / css / file / system / bundle；`preview` 只在「本地无法验证」的来源（system / bundle）强制；
  3. URL 由调用方给（查看器 `/files`、截图 `file://`），渲染器保持纯函数；字体 CSS 异步加载，探针用 canvas 宽度法（`document.fonts.check` 对缺失系统字体误报）；
  4. 文本没写字体时用 `default`（未配置用内置 Inter + Noto Sans SC），并在所有读取入口报缺口；不做 error；
  5. paintress 不带字体文件、不判授权与体积——客户项目自己的工程选择。
- **后果**：截图与徽章能说清「谁加载了、谁用了替代」；旧稿会从 Times/宋体变成 Inter/Noto（有意的观感修正）；测试通过 `PAINTRESS_NO_WEB_FONTS=1` 与外网解耦。
- **证据**：`specs/fonts.md`、`specs/design-system.md`、`.agents/implementations/2026-11-15_0132_font-registry.md`。
- **日期**：2026-11-15

### D-012 — 监听端口不是常量：启动时选端口，并把人该用的地址报回来

- **背景**（2026-11-15 实测）：`paintress web` 起得来、WSL 内 `curl` 200，但宿主（Windows）浏览器「连接失败」。原因是 WSL2 的 `localhost` 转发由宿主侧 `wslrelay.exe` 落地：Windows 上这个端口被 Hyper-V 保留段占着（`3228–3327`），绑不上就不建转发；而保留段每次开机在动态端口范围内重划、位置会漂。这类失败在发行版内部完全不可观测（自测永远通过）。
- **决定**：
  1. 默认端口 **6033**（60 号肉身成圣远征队 + 33 号远征队），不再用 3316；
  2. 顺序固定为「宿主体检 → 选端口 → 起服务 → 端到端复核」，不采用「先起再拆」；复核只认本次进程的 nonce，不认 200；
  3. 候选：`127.0.0.1 × [6033,6133,6233]` → `0.0.0.0 × [6033,6133,6233]`，最多 6 次，冲突（本机占用 / 宿主保留段 / 宿主占用 / 转发不通）一律换下一个；
  4. 显式 `--port` 不跳级（被占直接报错），`--bind loopback|all` 钉死绑定面；`port: 0` 跳过宿主校验；
  5. 最终 `access{url,host,bind,windows,jumped,requestedPort,attempts}` 随 `pong` 上报，CLI / MCP / 页面一律用它，**不许自己拼 localhost**。
- **后果**：默认 URL 从 3316 变 6033；跳级或 `bind=all` 时给人打开的地址可能是 `http://<wsl-ip>:6033/`；`0.0.0.0` 会暴露到局域网（沿用「本地工具、不做鉴权」的既有立场，只在输出与文档明示）；`ensureDaemon` 等待上限 6s → 15s。
- **证据**：`specs/web-bind-ladder.md`、`test/bind-ladder.spec.ts`、`.agents/implementations/`（本轮变更记录）。
- **日期**：2026-11-15
