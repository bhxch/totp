# 2026-10-01 PRF 绑定 create 期结果优先 真机验证清单

背景：PRF 绑定修复 69dd5e8（create 期 results 优先作为绑定输出，get 静默兜底）。修复动机来自
Windows 11 25H2 + WebView2 154 真机复现的 get 期 "Something went wrong" 缺陷（create 成功后
get 必然失败、绑定必然失败且残留孤儿凭据），详见该 commit message。
执行记录按 `docs/e2e-test.md` §6 指南登记（本文件为清单，逐项补「结果/证据」后归档）。

| # | 场景 | 预期 | 结果/证据 |
|---|---|---|---|
| 1 | create 期返回 results 的 PRF 认证器，解锁期同盐可复现（验证跳过 get 后绑定/解锁闭环） | 绑定仅一次 UV 确认（create 期直采，无第二次 get 弹窗）即成功落 credentialId + prfOutput；重启后同认证器同盐解锁成功 | 待人工 |
| 2 | create 期不返回 results 的认证器（Windows Hello + WebView2，get 期报 "Something went wrong" 的环境） | 绑定仍成功：get 静默兜底完成求值，全程无中间失败提示暴露给用户 | 待人工 |
| 3 | 绑定成功后执行口令锁定 → PRF 解锁 | 同盐 get 求值解锁成功（同认证器 + 同盐 → 同输出，与绑定输出一致） | 待人工 |
| 4 | 绑定中途取消 / 两阶段均无 PRF 输出 | 返回 null 并提示绑定未完成，不抛未捕获错误、不残留孤儿凭据可重试 | 待人工 |
