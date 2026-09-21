# 设计：内置服务 Icon 扩充（验收条目 5）

## 背景与目标

对标 Aegis/foxauth 的"预置服务 icon"体验。目标：在现有协议干净的路线上扩大覆盖面，
不引入协议风险。

## 现状与调研结论

- 本项目**已有**内置 icon 方案：`packages/core/src/icons/builtin.json` 收录
  Simple Icons 精选 **111 项**（CC0、单色 SVG path），由 `scripts/gen-builtin-icons.mjs`
  白名单生成；`registry.ts` 提供 `IconRef`（builtin/stored/url）、`recommendBuiltinIcon`、
  `suggestIcons`；`README.md` 已写明商标免责与补足方式。
- 协议调研结论：
  - Aegis 本体（GPL-3.0）**不内置**品牌 icon，社区 `aegis-icons/aegis-icons` 仓库是
    **混合协议**（CC0 仅覆盖模板/部分图标，其余 MIT/CC BY 4.0/OFL/各品牌商标，需逐项署名），
    整包引入的合规成本高于收益。
  - FoxAuth（GPL-3.0）未走预置 icon 路线。
  - Simple Icons 为 CC0：无署名义务；商标义务通过"单色使用、接受上游下架、不暗示官方背书"
    满足——现状已符合，README 免责已具备。

## 设计

1. 修改 `scripts/gen-builtin-icons.mjs` 白名单：以 2FA 常见服务为准（对齐
   2fa.directory 热门服务清单 + 现有用户导入格式中的高频 issuer），从 111 项扩至
   **约 300+ 项**（Simple Icons 全集 slug 内选取，仍单色 path）。
2. 重新生成 `builtin.json`，更新 README 中的数量描述。
3. `recommendBuiltinIcon`/`suggestIcons` 无需改动（匹配逻辑与数量无关），
   但补匹配率回归：用现有测试 entry issuer 样本断言推荐命中不下降。

## 验收

- `gen-builtin-icons.mjs` 幂等重跑 diff 为零；`builtin.json` 体积增长在合理范围（<300KB）。
- 单测：icon registry 全量 slug 可解析、推荐匹配率不降。
- 手动：新建 GitHub/Google/Reddit 条目自动带 icon。

## 非目标

- 引入 aegis-icons（协议混合，需逐项署名）。
- 彩色官方 logo、运行时网络拉取（`url` IconRef 已支持，由用户自选）。
- 图标包导入格式变更。
