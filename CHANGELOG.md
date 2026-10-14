# 更新日志

本文件记录面向用户的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本；正式发布（push `v*` tag）时 release 流水线自动截取对应版本小节作为
GitHub Release 说明的开头（其后附自动生成的提交列表）。

## [未发布]

### 新增

- **桌面版：mini 快速窗打开/聚焦时自动解锁**。此前主窗口经 OS 自动解锁（Windows DPAPI / macOS 钥匙串 / Linux 密钥环 / ABE 服务）锁定页静默解锁，mini 快速窗只能等主窗口解锁后跟随；现 mini 打开或聚焦时同样静默解锁，两端行为一致。未启用 OS 自动解锁时 mini 仍显示「主窗口解锁后此窗口可用」
- **扩展（Chrome/Firefox）：popup 弹出框新增 Passkey 解锁入口**。popup 因认证器弹窗夺焦即销毁窗口、无法就地完成 WebAuthn 验证，现点击「使用 Passkey 解锁」会打开独立解锁窗口自动发起验证，成功后窗口自动关闭，重新打开 popup 即已解锁；口令解锁入口保持不变，验证取消/失败时可在解锁窗重试或改用口令
- **扩展（Chrome/Firefox）：popup 站点过滤无匹配时的提示移入过滤行**。「当前站点无匹配，显示全部」等回退提示不再单独占一行，与「匹配 N 条」同位显示，验证码列表纵向空间更大（无匹配时仍回退显示全部条目，行为不变）；过滤行复选框按密度 -2 档收紧（行高/触达 48→40px，不缩字号），与整体紧凑基线一致

## [1.0.2] - 2026-10-13

### 修复

- **扩展（Chrome/Firefox）：background 体积从 8.33 MB 瘦身至 390 KB**。此前解码纯函数经共享包根模块引入，连带整棵界面组件树与两份资产被以 base64 形式内嵌进后台脚本（WXT 以单文件模式打包 background，其中 `?url` 资产会被构建器强制内联），超出 Firefox 扩展商店 AMO 单文件 5 MB 解析上限导致无法提交；改为经 `@totp/ui/qr` 子路径直接引入解码纯函数，双浏览器产物同步受益
- **扩展（Firefox）：manifest 补充数据收集声明**（`data_collection_permissions: required: ['none']`，本项目为纯前端离线工具、不收集任何数据）。该声明为 AMO 对新版本扩展的必填项；同时 Firefox for Android 需 142 才支持该声明，Android 端最低版本单独抬升至 142（桌面 Firefox 维持 140 ESR 基线不变）
- **扩展（Firefox）：AMO 静态检查清零**。对 Vue 运行时中静态内容解析的唯一一处 `innerHTML` 直接赋值打补丁改为等价的 DOMParser 解析（本应用编译产物不含调用该路径的代码，行为无变化），消除商店检查报告的 UNSAFE_VAR_ASSIGNMENT 警告
- **扩展（Chrome/Firefox）：商店名与后台文案本地化**。manifest 名称/描述与右键菜单、系统通知文案此前硬编码中文，改经 `_locales`（zh_CN/en）按浏览器语言展示；英文商店审核员不再见到中文商店名与中文右键菜单

## [1.0.1] - 2026-10-12

### 修复

- **扩展/桌面：修复主题防闪种子脚本被 MV3 CSP 拦截**。popup/options 四入口 HTML 里的内联主题预置脚本自引入起即被默认 `script-src 'self'` 策略静默拦截（扩展控制台累计报错、深色主题首帧闪白），抽离为外链 `theme-seed.js` 后恢复防闪语义；扩展与桌面两份镜像一致并有测试守护

## [1.0.0] - 2026-10-12

首个正式版。纯前端 TOTP 验证码管理：浏览器插件（Chrome/Edge/Firefox，均 Manifest V3）+ Tauri 2 桌面程序，无自建服务端，数据完全留在本机与自备网盘。

### 新增

- **界面**：Material Design 3 设计系统，五页导航（验证码/导入/同步/安全/设置），10 种主题色 × 明暗模式（暗色可叠加 AMOLED 纯黑对比度档），主题 CSS 按需懒加载
- **验证码**：HOTP/TOTP/Steam（SHA1/256/512，位数 5/6/7/8）、实时倒计时、搜索、按当前站点 URL 过滤（五种匹配策略）、置顶、标签管理、HOTP 复制后自动递增
- **安全**：两把口令（库口令 + 备份口令）、vault 落盘加密（envelope v2：Argon2id 派生 KEK → AES-256-GCM 包裹 DEK，三档强度可选）、Passkey（PRF）解锁、桌面原生自动解锁（DPAPI/钥匙串/Secret Service）与 Windows 应用绑定解锁（提权服务）、锁定策略（重启后/系统锁屏/空闲 N 分钟）、剪贴板 30 秒自动清空与密钥遮蔽
- **备份与云同步**：桌面本地多目录备份源（每源保留策略、变更后/定时自动备份、内容无变化跳过写入）；五后端云同步（WebDAV / S3 兼容 / Google Drive / OneDrive / GitHub Gist，同类型可多源、逐源独立基线与保留策略、冲突副本救济）；扩展端浏览器间同步（`chrome.storage.sync` 分片）；备份/云对象统一 envelope v2 加密
- **导入**：17+ 格式（Aegis/WinAuth/2FAS/Bitwarden/Authy 等，字段口径对齐 Aegis 官方导入器）、通用 JSON 点路径映射（方案可保存复用）、四档去重判定树、otpauth 链接/图片二维码/剪贴板多入口录入
- **图标**：Simple Icons 精选 218 项内置 + issuer 关键词推荐、图标包（zip）导入、上传与 URL 引用
- **桌面专属**：托盘常驻 + 只读 mini 弹窗（全局快捷键 `Alt+Shift+T`）、窗口资源释放三段式（隐藏→暂停→销毁）、内置 MCP 服务器（本机 AI 客户端只读取码，Bearer Token + 四档客户端授权，默认关闭）
- **发布物**：GitHub Release 提供 Windows（NSIS）/ macOS（dmg）/ Linux（deb/AppImage）桌面安装包与 Chromium/Firefox 扩展 zip，附 sha256sums.txt

[未发布]: https://github.com/bhxch/totp/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/bhxch/totp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/bhxch/totp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bhxch/totp/commits/v1.0.0
