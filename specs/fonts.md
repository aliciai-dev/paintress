# 字体（v2）：责任边界、注册表、默认字体与缺口提示

- 状态：**全部实现**（2026-11-15，F1–F5）；记录见 `.agents/implementations/2026-11-15_0132_font-registry.md`、`2026-11-15_0145_font-review-fixes.md`。v1 的五问已由 operator 定案，见 §0。
- 基线：`master` 干净，双端 `tsc` 0 错误、28 文件 371 用例全绿（2026-11-15）。
- 取代：本文件 v1 中「字体文件放哪 / git 多大 / 授权判定」的全部建议（已删）。

## 0. operator 决策（2026-11-15）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 注册表位置 | **统一放 preset**：`__preset.ptr` 的 `x-paintress.fonts`（与 token 同一文件、同一把 mtime 锁） |
| 2 | `preview` 是否必填 | **按本报告推荐**（§2.2 的规则表）：只有「paintress 无法在本地验证的来源」才强制 |
| 3 | 默认字体 | **加 `defaultFont`**；凡是用上它才渲染的节点，必须在 MCP 被调用时**提示给 agent**，由 agent 决定怎么补全文件 |
| 4 | 字体文件进 git / 体积 / 子集 | **paintress 自己不存字体**（自用一律网络字体）；**客户项目怎么存是它的工程选择，paintress 不规定、不建议** |
| 5 | 许可判定 | **同 4**：不做 license 判定，不因为授权拒绝任何登记 |
| 6 | seed 默认字体 | **jsDelivr 的 fontsource CSS**（跨 OS 一致，URL 写在 `__preset.ptr` 里可随时改） |

## 1. 责任边界（本轮的尺子）

| paintress 负责 | paintress 不负责 |
| --- | --- |
| 记录「这张稿要用什么字体、从哪加载、加载不到时用什么」 | 字体文件放在客户项目的哪个目录 |
| 按登记把字体加载进查看器与截图 | 客户项目是否把字体提交进 git、体积多大 |
| 报告「谁加载成功、谁用了替代、谁退到了默认」 | 客户项目的字体授权是否允许再分发 |
| 缺字体信息时把缺口**交给 agent**，让 agent 去补 | 替客户决定用分片 / 全量 / 设计期子集 |
| 提供一条始终能渲染的栈尾（system-ui，不需项目提供字体文件） | 要求客户项目必须有网络 |

一句话：**paintress 只做「声明 → 加载 → 报告」三段，不做资产管理，也不做合规判断。**

## 2. 数据模型

### 2.1 位置与形状（`__preset.ptr`）

```json
"x-paintress": {
  "fonts": {
    "default": "font-ui",
    "families": {
      "Inter Variable": {
        "source": { "kind": "web", "css": "https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/wght.css" },
        "preview": "system-ui"
      },
      "Raybend Display": {
        "source": { "kind": "bundle" },
        "preview": "Inter",
        "metrics": { "sizeAdjust": "96%", "ascentOverride": "92%" }
      },
      "Microsoft YaHei": { "source": { "kind": "system" }, "preview": "Noto Sans SC" }
    }
  }
}
```

- **键是 family 原名**（CSS 里那个名字）。`fontFamily` 里出现几个 family，就登记几个；stack 按位置逐个查表。
- `default`：**一个 font token 的 key**（推荐，如 `font-ui`），也接受直接写 family。渲染时解析成栈；
  节点没写 `fontFamily` 就用它。
- `source.kind`：`web` / `css` / `file` / `system` / `bundle`。
- `preview`：设计期替代，写 family 或 stack。
- `metrics`：可选，CSS font metrics overrides；以别名 `@font-face` 应用（见 §3.2）。
- **不给每条登记加 license / size / subset 字段**——那是客户项目自己的事，paintress 不记也不判。

### 2.2 `preview` 规则表（这就是 v1 没说清楚的地方）

先把「来源」按 **paintress 能不能在本地验证它** 分两类：

| `source.kind` | 字节在哪 | 查看器 | 截图 | 能否本地验证 | `preview` |
| --- | --- | --- | --- | --- | --- |
| `web` | 网上 CSS | 能（联网） | 能（联网） | URL 合法即可 | **可选**（CDN 不可达时才轮到） |
| `css` | 项目内 CSS + 分片 | 能（`/files`） | 能（`file://`） | 登记时校验文件存在 | **可选**（文件被删时才用） |
| `file` | 项目内单文件 | 能（`/files`） | 能（`file://`） | 登记时校验文件存在 | **可选**（同上） |
| `system` | 浏览器所在 OS | 看 Windows 有没有 | 看 Linux 有没有 | **不能**（跨 OS 结论可相反） | **必填** |
| `bundle` | 只在安装包 / 构建产物里 | 通常拿不到 | 通常拿不到 | **不能** | **必填** |

规则一句话：**paintress 能自己拿到并验证的来源，`preview` 可选；拿不到或验不了的，必须给。**

为什么这样定：
- `web`/`css`/`file` 已经能让两个渲染器**确定地**用上真字体，再加一个替代值只是噪音；
- `system`/`bundle` 天生不确定（§4.6 的 Windows/Linux 差异就是证据），没有替代值就会出现
  「画布上是宋体，但文件里写着 Raybend Display」这种没人知道的错。
- 「可选」不等于「不建议」：给了 preview 就等于给降级一个明确落点（例如 `preview: "system-ui"`）；
  不给则落到栈尾的 `sans-serif`。不是为离线做特判，只是让栈里的每一层都有名字。

### 2.3 一个完整的走查（raybend）

| 文件里的写法 | 登记 | 渲染结果 |
| --- | --- | --- |
| `fontFamily: "$font-ui"`（token 值 `"'Inter Variable', 'Noto Sans SC Variable'"`） | 两个 family 各登记 `source.kind:"css"`（指向项目暴露的 CSS）+ `preview: "system-ui"` | 真字体加载成功 → 用真的；CSS 路径失效 → preview → 徽章报「用了替代」 |
| `fontFamily: "Raybend Display"` | `kind:"bundle"` + `preview:"Inter"` + `metrics` | 恒用 Inter（带度量覆盖），徽章常驻「替代」；agent 汇报时必须说 |
| `fontFamily: "Inter"`（1168 个 text，和 app 实际用的 `Inter Variable` 不是同一个 family） | `Inter` 未登记 → validate warning | 用 `defaultFont` 或 preview；agent 收到「字体未登记：Inter」的提示去补 |

## 3. 渲染与运行时

### 3.1 栈怎么拼

```text
节点的 fontFamily（或其 token 解析值）
  ├─ 未写 → defaultFont（token/family）→ 未配置 → 内置兜底栈
  └─ 每个 family 查登记表 → 有 preview 就紧跟其后
最后接 sans-serif
```

例：`"Inter Variable", "Noto Sans SC Variable", "system-ui", sans-serif`。
浏览器天然按序取第一个可用字体——**不需要 JS 做选择**，但必须报告最终用的是谁（§5）。

### 3.2 度量覆盖（`metrics`）怎么落地

替代字体用**别名 family** 声明，避免与真 family 撞名：

```css
@font-face {
  font-family: "Preview: Raybend Display";
  src: local("Inter");          /* 或 web/css 来源 */
  size-adjust: 96%;
  ascent-override: 92%;
}
/* 栈： "Raybend Display", "Preview: Raybend Display", sans-serif */
```

这样替代字体不只是「长得像」，**行高与断行也接近**。metrics 在 v2 里保留为可选字段，
落地排在 F5（不阻塞前四步）。

### 3.3 渲染器仍是纯函数

`renderDocument(doc, { fonts })` 只产 CSS 片段（`@font-face` / `<link>` / 栈），**URL 由调用方给**：

- 查看器 / 组件画廊：`/files/<project>/<path>`（相对 `url()` 由浏览器按 CSS 自身解析）。
- 截图：`file:///<abs>/<path>` + `<base href="file:///<abs dir>/">`（实测可加载）。
  网络字体用**持久化的浏览器 profile 目录**（`PAINTRESS_HOME` 下）跑 Chromium，字体只下载一次；
  否则每次截图都重建上下文、重拉 `unicode-range` 分片，观感一致但慢得没必要。
- `paintress render` 静态导出：默认同查看器绝对路径；`--embed-fonts` 时内联 data URI（F5）。

### 3.4 查看器探针（宽度法，不是 `check()`）

- `/render` 与 `/render-component` 注入一段小脚本：把文档用到的 family 逐个用 canvas 宽度探针
  与「肯定不存在」的基线对比（serif 与 monospace 各一次），`postMessage` 给父页面。
- 父页面显示徽章：「字体 2/3 已加载 · 1 个用替代」；属性面板里 `fontFamily` 的解析值后标 `(替代: Inter)`。
- daemon 按 `project+file` 缓存最近一次报告，供 `paintress_font check` 读取。
- `paintress render` 的静态产物**不注入脚本**（保持纯静态）。

### 3.5 截图必须等字体

- `page.goto()` 后：`document.fonts.ready`（3s 超时）→ 图片 `complete` → 保留 120ms settle。
- 结果新增 `fonts: { ready, loaded: string[], missing: string[], substituted: {family→preview}[] }`；
  超时或缺失写进 `warnings`，不判失败。
- 现状是固定 120ms（`src/shot/screenshot.ts`），引入网络字体后必然抖，这是 F4 的硬理由。

### 3.6 `/files` 的运行时保护（不是项目政策）

- 字体加长缓存（`cache-control: public, max-age=31536000, immutable`），理由是 105 个分片每次重取太贵。
- 单文件读取上限（建议 32 MB）与扩展名白名单：**只为防内存被打爆，不评判客户项目该怎么放字体**。

## 4. MCP：缺字体信息必须冒到 agent 面前

这是决策 3 的落点。**每一条 MCP 返回都要能让 agent 看出「这里用了默认字体，文件信息不全」。**

| 调用 | 返回 |
| --- | --- |
| `paintress_doc_info` | `fonts: { default: "font-ui" \| null, families: [...], gaps: { textNodes: 12, sampleIds: [...] } }`；`gaps.textNodes > 0` 时附 `next`：**这批文本没有 fontFamily，正用 defaultFont 渲染；补全用 update/batch 写 `$font-*`** |
| `paintress_validate` | warning：`text 节点 t1/t2… 没有 fontFamily（共 12 个），当前用 defaultFont "Inter Variable"`；`字体未登记：Inter（paintress_font add）`；`系统字体 Microsoft YaHei 没有 preview，截图侧可能不可用` |
| `paintress_get` | 单个 text 节点缺 family 时返回 `hint`（同上，单条） |
| `paintress_query` | 结果计数旁给 `fontless: N`（不展开 id，避免刷屏） |
| `insert` / `update` / `batch` | 写进去的 text 节点缺 family → 进 `hints`（与 D1 的漂移提示同一个数组，最多 3 条） |
| `paintress_audit` | 新增 `font` 类：缺 fontFamily、未登记 family、`system` 无 preview；计入 `counts` |
| `paintress_font list` | 每个 family 的来源种类 + 最近一次 `loaded/missing`（查看器与截图分开标）+ 是否被文档引用 |

刻意**不做 error**：草稿与一次性设计允许先不写字体（与 `allowLiteral` 同一哲学），
但 agent 每次都会被提醒，且提示语直接给出下一步动作。

典型对话：

```text
agent: doc_info → gaps.textNodes = 12
agent: 「这 12 个文本节点没有指定字体，现在用的是项目默认字体 Inter Variable。
        它们是正文还是标题？我按 $font-ui / $font-title 补上。」
```

## 5. 三种来源的最终处置

| 来源 | paintress 怎么做 | 明确不做 |
| --- | --- | --- |
| **网络字体** | 登记 `kind:"web"` + CSS URL；渲染注入 `<link>`；CDN 不可达时沿栈尾降级并报告 | 不判断该用哪家 CDN；不代做子集 |
| **系统字体** | 登记 `kind:"system"` + **必填 preview**；两个渲染器各自报告有没有 | 不复制系统字体文件，不假设两边一致 |
| **项目内置** | 项目把字体放在哪由它自己定，paintress 只按登记的路径加载（`css`/`file`）；拿不到字节时用 `bundle` + preview + 可选 metrics | 不建议目录、不建议是否进 git、不做子集、不做授权判断 |

## 6. 默认字体（决策 3 的完整口径）

1. **项目默认**：`fonts.default` 指向 font token（推荐 `font-ui`）或 family；seed 会写一个。
2. **内置默认（paintress 的字体观）**：项目没配 default、或 default 解析不出时，用
   `"Inter Variable", "Noto Sans SC Variable", system-ui, -apple-system, "Segoe UI", sans-serif`。
   前两段来自 jsDelivr 的 fontsource CSS（与 seed 同一套），**系统字体只是栈尾兵底**，不是默认选择。
   → 一个裸 `.pen` 打开就有像样的中英混排，而不是 Times/宋体。
3. **行为变化**：历史上没有 `fontFamily` 的文本现在渲染成 Times/宋体（实测 `demo/hello.ptr`），
   以后会变成 Inter + Noto Sans SC——**这是有意的观感修正**，旧稿会变样，实现记录里要写明。
4. **一律提示**：无论走项目默认还是内置兜底，用上它们的节点都会进 §4 的 `gaps`，
   agent 必须能看见并决定是否补全。
5. **paintress 自己不带字体文件**。seed 的 `font-sans` / `font-mono` 指向 **jsDelivr 的 fontsource CSS**
   （2026-11-15 决策）；URL 写在 `__preset.ptr` 里，想换镜像或自托管就改一处：

   | token | 值（生产栈） | 登记 |
   | --- | --- | --- |
   | `font-sans` | `"Inter Variable", "Noto Sans SC Variable"` | 两个 family 各一条 `kind:"web"`：`https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/wght.css` / `…/noto-sans-sc@5.3.1/wght.css`，`preview: "system-ui"` |
   | `font-mono` | `"ui-monospace", "SFMono-Regular", monospace` | `kind:"system"` + `preview: "system-ui"` |

   版本号钉死（有一个 bug 修复就改一处），不写 `@5` 浮动版；CSS 内部是 `unicode-range` 分片，中文只拉用到的块。

## 7. 不做 / 延后

| 条目 | 理由 |
| --- | --- |
| `license` 判定、git 体积策略、子集化工具 | 客户项目的工程与合规选择（决策 4/5） |
| 系统字体全量枚举 | 跨 Windows/Linux 不稳定；只检查「已声明的」 |
| 可变字体轴（opsz / slnt） | CSS 已能用 `fontWeight` 驱动 `wght`；其余轴需要额外字段 |
| 图标字体（`icon_font` / `iconFontFamily`） | 与文本字体两条链路 |
| 跨 OS 像素级一致 | 靠「服务真字体」绕开；真要一致得让截图也跑 Windows 浏览器 |
| 自动揣测替代字体 | 替代由人或 agent 显式指定；猜测会让观感与生产更难对齐 |

## 8. 分期与与 Stage D 的合流顺序

F 与 D 有耦合：D0 的 `fontSize` token、D4 的 seed 字体、D5 的提示词都碰字体，
所以不建议「D 做完再做 F」，按下面合流：

| 序 | 单元 | 出口 |
| --- | --- | --- |
| 1 | **D0** 字号 token + 引用类型校验 | `establish` 不再毁字号 |
| 2 | **F1** 注册表 + `validate` 字体验证 + `paintress_font list/add/remove` | family 未登记/系统字体无 preview 出 warning；登记校验路径与文件存在 |
| 3 | **F2** 渲染注入 + `defaultFont` + **缺口提示进 MCP** | 项目字体在 `/render` 生效；无 family 的文本用 default，且 `doc_info`/`validate`/`get`/写路径都能看见 `gaps` |
| 4 | **D4** preset seed（带字体登记） | seed 的 `font-sans`/`font-mono` 带 source 与 preview，`fonts.default` 指向 `font-ui` |
| 5 | **D1 / D2 / D3** 漂移提示、设计系统状态、组件上收 | D2 的 `designSystem` 块带 `fonts` 概要 |
| 6 | **F3** 查看器探针 + 徽章 + 面板解析值 | 缺字体可见、用了替代可见 |
| 7 | **F4** 截图等字体 + `fonts` 报告 | 截图前 `fonts.ready`；结果含 loaded/missing/substituted |
| 8 | **D5 / D6** 提示词落位、README 双语 | SKILL 写入字体决策树；README 记 `paintress_font` |
| 9 | **F5** metrics + `--embed-fonts` | 替代字体行高接近真字体；导出脱离项目也能显示 |

## 9. 定案后无其它待定项

- seed 与内置默认字体：**jsDelivr fontsource CSS**，版本钉死（`inter@5.3.0`、`noto-sans-sc@5.3.1`），
  实测 `wght.css` 均 200（Inter 2.4 KB、Noto Sans SC 101 KB 的 `@font-face` 清单，内部按 `unicode-range` 分片）。
- **不为「CDN 不可达 / 离线 / 老系统」做特判**：栈尾有系统字体，CSS 自己会降级；
  真想知道降没降，看徽章与截图报告（§4）。
- v1 的五个问题 + seed 选择均已定案，可以开工。
