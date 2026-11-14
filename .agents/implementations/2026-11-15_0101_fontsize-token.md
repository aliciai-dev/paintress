# 2026-11-15T01:01+08:00 — Give font size its own token type (D0)

`font` 一个类型兼做「字体族」和「字号」：落盘一律 string，渲染时 `resolveNum` 只接受 number，
于是 `fontSize: "$font-16"` 会告警「数字变量解析失败」并丢掉字号。`paintress establish` 恰好会
把重复的 `fontSize` 提成这种 token（实测复现：两个 `fontSize:16` → `--apply` → 渲染无 font-size），
`audit` 也把 `fontSize` 归到 `font` 类并给出同样会坏的 `$font-16` 建议。

## 改了什么

- token 类型收敛为 `color | radius | spacing | fontSize | font`；`fontSize` 落盘 number，`font` 只管字体族。
- **读取归一**：老的 `font` + 数字值（string）在合并副本里按 `{type:'number', value:Number}` 呈现，
  面板与审计报 `fontSize`，文件本身一个字不改，第一次编辑才落新类型。
- 新增唯一映射表 `PROP_TOKEN_KIND`（`src/doc/presets.ts`），audit / establish / validate / 写入校验共用；
  `fontSize` 从 `font` 改为 `fontSize`，`fontFamily` 按字符串精确匹配。
- `validate` 增加引用类型校验（warning，不阻断）：`fill: $radius-8`、`fontSize: $font-sans`
  这类错配在写入前点出来，而不是渲染出一个错值；preset 组属性同样检查。
- 面板按 kind 分组多出「字号」，输入控件是数字；MCP / CLI 的 type 枚举与文案同步。

## 证据

- `test/project-presets.spec.ts`：fontSize 落盘 number、老 `font-16` 读取归一后渲染 16px 且文件不变、
  两类引用错配各一条 warning、同类引用不报。
- `test/album.spec.ts`：重复 fontSize → establish → `$fontSize-16` → 渲染 `font-size:16px`、0 警告。
- `test/audit.spec.ts`：`fontSize` 建议 `$fontSize-16`、`fontFamily` 建议 `$font-ui`。
- 双端 `tsc` 0 错误；`pnpm test` 28 文件 376 用例全绿（+5）；`pnpm build` 通过。
- 端到端复现（`/tmp` 临时工程）：`establish --apply` 写入 `fontSize-16: {type:'number', value:16}`，
  节点变成 `$fontSize-16`，`render` 输出 `font-size:16px` 且 warnings 为空。

## 说明

- `lineHeight` / `fontWeight` 刻意不进映射表（语义不合任何数字/字符串种类），留 FUTURE。
- 旧稿里 `fontSize` 引用了 `spacing` token 的写法会在 validate 出新 warning；这是有意的（原来渲染也不对）。
