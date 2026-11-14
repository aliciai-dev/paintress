# 远期与延期

> 每条必须写清：**是什么 / 为什么等 / 什么条件会把它拉回来（触发条件）**。
> 分两半：**Features** 是用户能看见的新能力；**Improvements** 是已有能力做得更对、更稳、更省。
> 已排进当前批次的见 `specs/PLAN.md`；已完成的见 `FINISHED.md`，这里不留正文。
> 判断归类的尺子：**要不要改「这东西能做什么」？** 要 → Features；只是「做得更好的」→ Improvements。

## Features（能力缺口）

### 渲染器

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| shader 填充与效果 | 用 GLSL 着色器画填充 / 背景效果 | 需要 WebGL 渲染后端，成本远超其余项；HTML/CSS 输出是地基（D-002） | 真实稿里出现且降级成纯色之后不可读 |
| 图标库扩展 | lucide / feather 之外的图标集 | 每套图标数据数百 KB～MB，包体与首屏都受影响；现在非 lucide 库先做别名映射 | 真实稿大量使用某套图标，别名映射糊不上 |
| 离线文字度量 | 不启动浏览器也能算文字排版 | 浏览器测量已覆盖渲染与截图；离线要自带字形度量与缓存 | 需要在不启动 Chromium 的环境出像素级结果 |
| imports 跨文件引用 | 按 `document.imports` 解析外部组件 | 格式语法自身是 TBD（`format/spec.yaml §known_gaps`）；先定语法再实现 | 规格补齐 + 出现跨文件复用的真实稿 |

### 单帧导出

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| SVG 出口 | 导出矢量而不是 PNG | 矢量要另一套渲染（文本转路径 / 字体嵌入），当前 PNG 已够发文档 | 需要把某一帧贴进矢量文档或做二次编辑 |

### 画谱（Album）后续层

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| 变体 / 参数化插槽 | 同一组件按 `variant=primary` 或参数化槽位出不同形态 | 组件量还小，先看真实复用形态再定语法（命名变体 vs 参数） | 同一组件出现 3 个以上真实变体 |
| 跨文档 / 跨项目继承 | 一个项目组的 tokens/preset 共享一份 | 依赖 `imports`（TBD）与项目根规则；单项目已够用 | 第二个真实项目要复用同一套颜色/组件 |

## Improvements（正确性 / 健壮性 / 成本）

### 渲染保真

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| SVG 形状的描边对齐与线帽 | 弧形 / 圆环 / 圆角多边形目前只用 SVG 原生居中描边，`inner`/`outer` 只给警告，`strokeLinecap`/`strokeLinejoin` 未映射（`src/render/html.ts#svgShapeHtml`） | 要正确表达内外侧描边得用 clip/mask 双层路径，属于渲染器结构性改动 | 真实稿里出现非默认对齐/线帽的弧形或圆角多边形 |
| 逐边描边宽度 + outer/center | 四边不同线宽且 `strokeAlignment` 非 inner（`src/render/style.ts#strokeToCss`） | CSS outline 不支持逐边；现在退回 border + 警告 | 真实稿出现该组合 |
| 网格渐变精度 | 多层径向渐变只是近似，不是严格双线性 mesh；`points` 控制点仍按均匀网格处理（`src/render/style.ts#meshLayers`） | 精确 mesh 需要独立渲染后端；当前近似在大色块上够用 | 设计稿依赖网格控制点，或渐变色带明显穿帮 |

### 写入安全

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| establish / adjust 的跨文件事务 | 设计稿与 `__preset.ptr` 是两份文件，写一半崩溃会留下半套状态（`src/doc/album.ts#applyEstablish`） | 已加写前 mtime + 同名冲突预检，覆盖了绝大多数情况；真正事务要临时文件 staging + 失败回滚 | 出现一次真实的半写事故，或有两个进程同时改同一项目 |
| adjust 的全项目影响面与本地组写回 | dry-run 只统计传入的这一份设计稿；文档内定义的 preset 组能预览但 apply 只写项目级 `__preset.ptr`（`src/doc/album.ts#planAdjust`） | 枚举项目全部稿件会放大每次 dry-run 的 I/O；本地组的写回位置（文档还是项目文件）需要先定规则 | 项目里出现多份稿件共用同一套 token，或有人要求在文档内改组 |

### 资源与性能

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| 导出的流式与并发控制 | `GET /api/export` 把 PNG 整个读进内存再返回，并发请求各自启动一个 Chromium（`src/web/daemon.ts#/api/export`） | 8192 单边上限已控制单图尺寸；单机单人使用很难撞上并发 | 出现批量导出需求，或导出把内存 / CPU 打满 |

### 质量

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| 拖拽平移等交互的浏览器回归 | 平移 / 修饰键 / 快捷键 / 视口持久化 / 层级切换没有端到端用例（只有纯数学单测） | 复用 daemon + fixture 约半天；写完能省掉每次手测 | 下次改 `ui/src/frame-viewport.ts` 或 `App.tsx` 的交互逻辑时一并补；或出现一次漏到发布版的交互回归 |
| 变更高亮强保证 | `notifyChanges` 非阻塞 + 2s 超时，极端情况丢一次高亮 | 高亮是尽力而为、不影响写入；改 `await` 会拖慢写路径 | 出现「改完没高亮」导致误判的真实事故 |

### 平台接入

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| VS Code `mcp.json` 的 JSONC | `install` 用严格 JSON 解析，带注释的配置判 invalid 后跳过 | 正确做法是 jsonc-parser 定点插入（重新序列化会丢注释），属行为变更 | 有因注释配置接入失败的反馈；或新增第 6 家客户端 |
| Windows `.cmd` 垫片判定 | win32 上 PATH 里有 `paintress.cmd` 就当作自己，不校验它指向哪个包 | 仓库 CI 只有 Linux，Windows 未实测 | 宣布支持 Windows；或出现「写到配置里的裸命令指向别的包」的报告 |
| Codex 陈旧路径 | 已有 `[mcp_servers.paintress]` 一律 noop，命令过期也不修 | 改 TOML 要引解析器并重写 section，风险高于 JSON 合并 | 用户报告 Codex 走旧路径；或 install 需要「更新已有条目」语义 |

### 发布与工具链

| 条目 | 是什么 | 为什么等 | 触发条件 |
| --- | --- | --- | --- |
| `dts` 生成 | 发类型产物 | `NodeSchema` 的 zod 推断超 TS7056；硬注解后 `index.d.ts` 1548 KB（包体 164 KB → 1.67 MB） | 要么全量显式注解瘦身，要么按需导出 + api-extractor；出现「要写 TS 消费方」的需求 |
| Vitest → `node:test` | 换测试运行时 | 项目只用 `describe`/`it`/`expect`，迁移约半天；纯偏好 | operator 认为依赖体积/供应链复杂度是问题时 |

## 已否决

- **检测 agent 存活用 PID 轮询**：PID 会被内核复用，必然误判；已改为连接存活（socket 断开即事件）。
- **用 `pen` CLI 或官方 MCP 作为运行依赖**：见 `ARCHITECTURE.md#D-001`。
- **发明新格式后缀 `.penx`**：与活跃项目 PenX 撞名且带 `pen` 前缀；已选 `.ptr`。
- **用 SolidStart**：peerDeps 要求 solid-js ^1.9.15，不支持 2.0；SSR 对本地工具无价值。已选纯 Solid + Vite。
- **前端叠加第二套变更过期阈值**：过期判定统一由 daemon TTL 负责。
- **重建「必须手动关标签页」的静态关闭页**：改为倒计时自动关窗（`ARCHITECTURE.md#D-009`）。
