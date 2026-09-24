[简体中文](README.md) | [English](README_en.md)

# TOTP 验证码工具

纯前端 TOTP 验证码管理：浏览器插件（Chrome/Edge/Firefox，双端均 Manifest V3）+ Tauri 桌面程序。无自建服务端，数据完全留在本机与自备网盘。

## 特性

- **界面**：Material Design 3 设计系统，五页导航（验证码 / 导入 / 同步 / 安全 / 设置），10 种主题色 × 明暗模式（暗色可叠加 AMOLED 纯黑对比度档），主题 CSS 按需懒加载
- **安全**：两把口令（库口令 + 备份口令）、vault 落盘加密（envelope v2，三档 Argon2id 强度）、DEK 保管区、Passkey（PRF）/ 原生自动解锁、锁定策略（重启后 / 系统锁屏 / 空闲 N 分钟）、剪贴板自动清空与密钥遮蔽
- **数据**：本地备份（多目录源、每源保留策略）、五后端云同步（同类型多目标、每源独立基线与保留策略）、浏览器间同步、17+ 格式导入（四档去重判定树）、otpauth 链接 / 图片二维码 / 剪贴板多入口录入
- **桌面**：托盘常驻 + 只读 mini 弹窗（全局快捷键 `Alt+Shift+T`）、窗口资源释放（隐藏 → 暂停 → 销毁三段式）、内置 MCP 服务器（本机 AI 客户端可读取验证码）

设计文档见 [docs/plans/2026-09-13-totp-tool-design.md](docs/plans/2026-09-13-totp-tool-design.md)；实施计划按里程碑分计划存于 [docs/plans/](docs/plans/)；审查与端到端验证报告见 [docs/review/](docs/review/)。

## 安装

### 浏览器扩展（Chrome/Edge/Firefox，均 MV3）

- 从 [GitHub Releases](https://github.com/bhxch/totp/releases) 下载扩展 zip：`totp-extension-chromium-<版本>.zip` / `totp-extension-firefox-<版本>.zip`（Release 附 `sha256sums.txt` 校验）
  - Chrome/Edge：解压后进入 `chrome://extensions` 开启「开发者模式」→「加载已解压的扩展程序」选中解压目录
  - Firefox：要求 Firefox 140+（`strict_min_version: 140.0`）；未签名 zip 可经 `about:debugging` →「此 Firefox」→「临时载入附加组件」加载，商店（AMO）上架包以 zip 人工上传
- 自建：Chrome 目标 `pnpm --filter @totp/extension build` 产出 `.output/chrome-mv3`；Firefox 目标另跑 `pnpm --filter @totp/extension exec wxt build -b firefox` 产出 `.output/firefox-mv3`（CI 对双目标分别构建并断言 manifest 均为 MV3，见 [Assert MV3 artifacts 步](.github/workflows/build.yml)）

### 桌面（Tauri 2）

- 从 [GitHub Releases](https://github.com/bhxch/totp/releases) 下载对应平台安装包：Windows（NSIS `.exe`）/ macOS（Universal `.dmg`）/ Linux（`.deb`、`.AppImage`）
- 源码构建与开发命令见下文[桌面版（Tauri）](#桌面版tauri)与[开发与构建](#开发与构建)

## 快速上手

### 添加条目

四个入口，均把内容解析后**预填进录入表单**（批量导入除外），确认后才落库：

- **手动录入**：账户名 + base32 密钥（带校验），支持 TOTP/HOTP/Steam（SHA1/256/512，位数 5/6/7/8）
- **otpauth 链接**：支持 `otpauth://totp|hotp|steam|yaotp`（Yandex），三个入口：
  - 粘贴导入（全端）：popup 表单区上方「粘贴 otpauth 链接导入」折叠入口，粘贴 URI 后点「导入」
  - Firefox 协议注册（`ext+otpauth`）：安装后首次触发询问处理器，选择「TOTP 验证码工具」后，地址栏输入或点击 `ext+otpauth:...` 链接即打开 popup 并预填。平台限制：Firefox 扩展无法注册原生 `otpauth://` scheme（manifest 协议白名单仅接受 `web+`/`ext+` 前缀），故网页中的真实 `otpauth://` 链接无法接管
  - 右键菜单导入：网页中选中一段 `otpauth://` 文本 → 右键「将选中的 otpauth 链接添加为条目」→ 校验通过后暂存并尝试自动打开扩展弹窗（Chrome 127+ 支持；不可用时手动点扩展图标即见预填表单）；选中文本非法时发系统通知提示
- **从图片识别**：录入表单选本地图片，解码其中的 otpauth 二维码后预填
- **从剪贴板导入**：录入表单「从剪贴板导入」按钮——剪贴板是图片时走二维码识别预填；是文本时单条（otpauth URI / 单条目 JSON）预填、多条批量入库（批量落库在验证码页的表单对话框中，popup 表单仅支持单条预填）。读取剪贴板需扩展 `clipboardRead` 权限（桌面端按系统授权），且需用户手势触发；无可用内容或授权失败均有明确提示
- 更多批量格式（17+）走[导入](#导入)页向导

### 锁定

在「安全」页启用 vault 加密并设置口令后，锁定页即生效；解锁方式（口令 / Passkey / 原生自动解锁）与锁定策略（重启后 / 系统锁屏 / 空闲 N 分钟）见[安全](#安全)。

### 日常使用（扩展端）

- 列表：实时验证码 + 倒计时、关键字搜索（可选搜 secret）、按当前站点 URL 过滤（五种匹配策略，条目编辑中配置）、置顶、右键菜单（编辑 / 复制 URI / 置顶）、双击条目显示明文 8 秒后自动打回（默认打码）
- 管理：编辑/删除（二次确认）、标签管理（验证码页）、HOTP 复制后自动递增
- options 页：浏览器扩展详情 → 扩展选项，与主窗口同构五页导航；popup 右上「打开设置」深链直达 `options.html#/settings`
- 主题：设置页「外观」区切换主题模式（自动/浅色/深色）与 10 种主题色，四入口（popup/options/桌面主窗/mini）一致生效

## 桌面版（Tauri）

```bash
pnpm --filter @totp/desktop tauri dev    # 开发（先起 vite，再编译 Rust）
pnpm --filter @totp/desktop tauri build  # 构建，产物为 exe + NSIS 安装包
```

- 数据位置：`%APPDATA%/com.totp.desktop/vault.json`
- 主窗口：完整五页管理（与插件 options 同构）。「失焦自动隐藏」在设置页开启；「隐藏到托盘」按钮在导航栏；主窗口点 X 收起到托盘；托盘中键点击直达主窗口（等价右键菜单「显示主窗口」）；彻底退出请用托盘右键菜单 → 退出
- mini 弹窗：只读验证码列表，复制后自动隐藏；以下三种方式均可弹出/隐藏
  - 托盘图标左键点击
  - 全局快捷键 `Alt+Shift+T`
  - mini 窗失焦自动隐藏（mini 窗固定启用）

### 窗口资源释放（设置页专属卡，扩展宿主不渲染）

关闭窗口后不必让 WebView 常驻吃资源，三段式策略（设置页「窗口资源释放」卡配置）：

1. **关窗隐藏**：主窗口点 X / 失焦隐藏后收到托盘
2. **暂停**：隐藏 N 分钟后挂起 WebView 渲染（Windows 走 WebView2 `TrySuspend`，要求窗口不可见；失败或非 Windows 静默降级为维持隐藏）
3. **销毁**：再经 M 分钟销毁窗口，仅留托盘进程；点托盘或按全局快捷键自动重建窗口

- 默认 N=5 分钟、M=30 分钟；两档均为 0–1440 整数，**0 = 禁用该档**
- 「暂停时锁定」默认关；「销毁时锁定」默认开
- 「销毁时锁定」关闭时，销毁重建后自动恢复解锁态（密钥仅暂存本机进程内存，锁库/退出即清除，不落盘）
- 边界：暂停期间空闲锁定暂不生效；Windows 下挂起态无法暂存密钥，故**开启「隐藏后暂停」时销毁后重建仍需解锁**——将「隐藏后暂停」设为 0 才能保证免解锁恢复

## MCP 服务器（桌面版）

设置页「MCP 服务器」卡开启后，本机 AI 客户端（MCP 协议，Streamable HTTP）可列出账户并读取当前验证码。设计见 [docs/plans/2026-09-21-mcp-server-design.md](docs/plans/2026-09-21-mcp-server-design.md)，真机验证见 [docs/review/2026-09-21-desktop-mcp-real-machine-test.md](docs/review/2026-09-21-desktop-mcp-real-machine-test.md)。

- **默认关闭**；仅绑定 `127.0.0.1`（不出局域网），默认端口 `47215`（可改 1024–65535）
- **Bearer 连接 Token** 认证：卡片内可显示/复制/重新生成（重新生成使旧 token 立即失效）；token 未启用时显示「（启用后自动生成）」占位且复制置灰
- **金库锁定时一律报错不可用**；任何工具绝不返回 secret/pin 原文
- **四档客户端授权**（连接即校验）：仅 Token（任何持令牌客户端可用）/ 白名单通配符（推荐，如 `Claude*`）/ 白名单精确匹配 / 每次连接人工确认（应用内弹审批：允许 / 拒绝 / 仅本次 / 加入白名单；「仅本次」15 分钟内免重弹且重启即清）
- **工具面**（勾选暴露，变更即时生效，未暴露的调用被拒绝）：
  - `list_accounts`、`get_code`：只读，默认暴露
  - `trigger_backup`、`trigger_sync`：触发写操作，可选暴露、逐次确认（不记忆授权），仅「仅 Token」档免确认

客户端接入：设置页 MCP 卡的「客户端连接配置（JSON）」已含真实 token，复制即用；或在项目 `.mcp.json`（以 ZCode/Claude Code 等为例）按如下格式接入：

```json
{
  "mcpServers": {
    "totp": {
      "type": "http",
      "url": "http://127.0.0.1:47215/mcp",
      "headers": { "Authorization": "Bearer <在应用「设置 → MCP 服务器」卡复制连接 Token>" }
    }
  }
}
```

## 安全

### vault 落盘加密

- 默认关闭；在「安全」页启用并设置口令，之后 vault 以密文落盘（桌面与插件各自独立存储、分别启用）
- 算法与备份 envelope 同级（envelope v2）：Argon2id 由口令派生 KEK → KEK 以 AES-256-GCM 包裹随机 32 字节 DEK → DEK 以 AES-256-GCM 加密 vault 明文（wrap/data 两段 nonce 各自独立随机）
- **加密强度三档可选**（「安全」页「加密强度」）：更快（低端机友好）/ 平衡（默认）/ 更慢更耐暴力破解。调整需输入当前口令确认，确认后立即以新档位重封装 DEK，数据本身无需重加密
- 更换口令会**轮换 DEK** 并以新口令重封装（数据无需重加密，即时完成）；已绑定的 Passkey/原生自动解锁旧绑定随轮换失效，需解锁后重新绑定（界面会动态提示）。「安全」页显示「本地主口令已 N 天未更换」便于轮换
- 口令不存储、不上传；口令丢失则已加密数据无法解锁（无后门、无找回手段）

### 解锁方式

vault 加密支持多种解锁来源（KEK 来源）并存，在「安全」页「解锁方式」区管理；任意一种成功即可解锁：

- **口令（默认）**：启用加密时的唯一方式，也是其他方式的兜底，不可移除
- **Passkey 解锁（PRF 扩展）**：
  - 在「安全」页绑定 Passkey 后，锁定页出现「使用 Passkey 解锁」按钮：本地验证（指纹/PIN 弹窗）通过后由 passkey PRF 扩展输出直接派生密钥解出 DEK，自动完成解锁，全程无需口令
  - PRF 输出仅在本机求值，不外传；绑定信息（凭据 id + 盐 + 包裹后的 DEK）存本地
  - 浏览器支持面：Chrome/Edge 与桌面版（WebView2）可用；Firefox 扩展页面的 PRF 支持有限，探测不支持时「添加 Passkey 解锁」入口自动隐藏并提示
  - 绑定过程会连续弹出两次认证器窗口（注册 + 求值确认），属预期行为
  - 可绑定多个 Passkey（列表逐个管理）
- **原生自动解锁（仅桌面版）**：
  - 统一 osAutoUnlock 通道：Windows = DPAPI（当前用户）、macOS = 钥匙串（Keychain）、Linux = 密钥环（Secret Service，GNOME Keyring/KWallet）；启用后 DEK 由操作系统安全存储保护，桌面版锁定页打开时静默尝试自动解锁
  - 换系统账户或换机器后解不开属预期：静默失败并回落到口令/Passkey 手动解锁，不报错不打断；Linux 无 keyring 服务 / macOS WKWebView 的 PRF 受限时，对应选项不渲染
  - Windows DPAPI 路径经 roundtrip 单测验证；macOS/Linux keyring 运行时行为待真机验证
  - 插件端不提供此方式
- **按端命名**：「安全」页与锁定页的解锁方式名称按运行平台注入——Windows 显示「Windows Hello (Passkey)」/「Windows 自动解锁」，macOS 显示「Touch ID (Passkey)」/「钥匙串自动解锁」，Linux 与浏览器扩展显示「Passkey」（桌面另加「密钥环自动解锁」）
- **换设备**：绑定数据（密文）随浏览器同步整体走；云备份/云同步（envelope）不含。Passkey 凭据在本机（平台认证器）时他机无法求值 PRF，需在新设备重新绑定；可漫游凭据（如 YubiKey）可直接解锁；原生自动解锁在他机静默失败。新设备通用路径：先用口令解锁，再重新绑定其他解锁方式

### DEK 会话共享与锁定策略

- **插件端**：解锁后 DEK 写入 `chrome.storage.session`（浏览器会话级存储，浏览器退出即清），popup 与 options 共享解锁态，任一端解锁另一端免输口令；锁定即清除
- **锁定触发器**（「安全」页「锁定策略」区，偏好持久化）：
  - 「重启后保持锁定」（默认开）：桌面端无会话级 DEK 存储，重启后必为锁定态；插件端因 DEK 会话存储在浏览器退出时必然清空，两种取值行为一致
  - 「系统锁屏时锁定」（默认开）：桌面端 Windows 订阅系统锁屏事件（WTS）执行；mac/Linux 该触发器暂不可用（挂账）。插件端经 `chrome.idle` 的 locked 态触发
  - 「空闲 N 分钟后锁定」（默认 0=禁用）：插件端在 options 页存活期每 30 秒轮询 `chrome.idle`（阈值即配置分钟数）；桌面端由空闲执行器判定。Firefox 支持 idle API（含 `locked` 锁屏态），MV3 迁移（min_version 140）后可用；若运行时仍探测不可用，启动时提示降级

### 剪贴板自动清空与密钥遮蔽

- 复制验证码后 30 秒自动清空剪贴板，可在「安全」页关闭；插件端在 Chrome/Edge 上经 background（alarms + offscreen）执行，popup 提前关闭也能清空；Firefox 无 offscreen API，不支持自动清空，开关保留但无效果
- 录入/编辑表单中 secret 输入框默认以密码形态遮蔽，点右侧按钮可临时明文查看；列表条目双击显示明文 8 秒后自动打回

## 备份与云同步

备份相关功能集中在「同步」页（桌面主窗口 / 插件 options 页）：「备份口令」「备份」「云同步」「浏览器同步」四卡；popup 不含备份功能。

### 加密格式（envelope v2）

- 备份文件为 JSON 文本，扩展名 `.totpbackup`，结构：`v`、`kdf`（`alg`/`profile`/`m`/`t`/`p`/`salt`）、`wrapNonce`、`wrappedDek`、`aead`、`dataNonce`、`ciphertext`
- 加密流程：Argon2id（按所选档位，默认平衡档 m=65536, t=3, p=1，随机 16 字节 salt）由口令派生 KEK → KEK 以 AES-256-GCM 包裹随机 32 字节 DEK → DEK 以 AES-256-GCM 加密 vault 明文
- 备份加密档位在「备份」卡选择（与库口令加密强度相互独立）；口令错误或文件损坏时解密失败并明确报错，不会输出错误数据
- **不兼容说明**：2026-09-17 之前生成的 v1 备份文件与当前版本不兼容（v2 起不再读取 v1），如需找回请使用生成该文件的旧版本构建

### 备份口令（两把口令）

- 工具区分两把相互独立的口令：**库口令**（「安全」页设置，加密本机 vault 与解锁）与**备份口令**（加密本地备份文件与云端同步对象，两者共用）
- 备份口令在「备份口令」卡设置：口令 + 确认输入后点「启用会话」，未记住时仅存会话内存、不落盘，锁定或关闭页面即清
- 「记住（存入保管区）」开关：开启后备份口令以密文存入独立保管区（DEK 加密的 `secretBag`，需已启用 vault 加密），解锁库即自动装载，备份与云同步（含自动触发）免输口令，原生自动解锁同样生效；关闭 vault 加密时清除保管区
- 口令丢失则备份无法恢复（无后门、无找回手段），请自行妥善保管

### 桌面本地备份（多目录源）

- 「备份」卡以**源列表**管理本地备份：默认目录（`%APPDATA%/com.totp.desktop/backups/`）之外可添加任意多个自选目录源，每源独立启用、命名与保留策略
- 每源保留策略（偏好持久化）：
  - **保留最近 N 份**：按 `vault-日期-时间.totpbackup` 命名，每次备份后滚动删除超出 N 的最旧备份
  - **覆盖**：固定写入 `vault-backup.totpbackup`
- 写入为临时文件 + 重命名的原子写；恢复：卡内备份列表（新在前）选择一份，输入口令解密，两步确认后整体替换当前 vault；云同步产生的冲突副本（`conflict-{源id}-{日期}-{时间}.totpbackup`）也在列表中可恢复，且不参与滚动删除

### 自动备份（桌面）

- 「备份」相关自动触发持久化在桌面本地：「变更后自动备份」（数据变更提交后防抖 10 秒合并连续操作）与「定时自动备份」（15 分钟 / 1 小时 / 6 小时 / 每天）
- 执行前计算 vault 内容 SHA-256 与上次备份基线比对，无变化则跳过写入；手动备份不受变更检测限制，始终写入
- 自动执行仅在解锁会话且备份口令就绪时运行，结果不打扰，状态行显示「上次自动备份：时间 + 成功/失败」；未设置备份口令/库锁定时显示中文跳过原因

### 导出 / 导入文件

- 桌面：系统对话框选择保存/打开路径（`.totpbackup` 过滤器）
- 插件：浏览器下载保存 / 文件选择器导入

### 云同步（Cloud）

通过自备的网盘/对象存储在多设备间同步数据。入口在「云同步」卡；云端对象为加密备份 envelope。

#### 源模型（多目标）

- 云同步以**源列表**管理：点「添加源」从五后端菜单添加，**同类型后端可添加多份**（如两个 WebDAV 账号），每源独立配置：
  - 名称（同类型多份时区分）、启用开关
  - 凭据与目标文件路径（各后端默认 `totp-backup.totpbackup`）
  - **保留策略**：覆盖（固定单对象）或保留最近 N 份（keep 源每次同步写时间戳文件 `vault-日期-时间.totpbackup`，并滚动删除超出 N 的最旧云端备份）
  - 自动同步偏好（变更后 / 定时，逐源独立）
- 凭据**加密存入保管区**（DEK 加密的 `secretBag`，随库解锁装载），不落明文；token 过期需自行重新获取粘贴
- 每源持有独立同步基线，多源收敛由统一编排保证（见「同步语义」）

#### 支持后端

| 后端 | 凭据（均为手动粘贴，自备） |
| --- | --- |
| WebDAV | 服务器地址 + 用户名 + 应用密码（坚果云等） |
| S3 兼容 | Region + Bucket + AccessKeyId + SecretAccessKey；Endpoint 可选（如 MinIO `http://localhost:9000`），填了走 path-style；Key 前缀可选 |
| Google Drive | OAuth Access Token（文件 id 首次推送自动创建并回存凭据） |
| OneDrive | Microsoft Graph Access Token（写入云盘根目录下同名文件） |
| GitHub Gist | GitHub Token + Gist ID（建议使用 secret gist，避免备份内容暴露在公开页） |

- S3 上传为纯 fetch 实现的 AWS Signature V4 签名（无 SDK 依赖），兼容 MinIO 等自托管服务
- 自建 WebDAV/S3（MinIO）服务需允许跨域（CORS），否则插件端请求会被浏览器拦截

#### 加密与口令

- 云端对象与本地备份同一加密形态（envelope v2，档位取「备份」卡的备份加密强度），服务器上永远只有密文
- 云同步口令即「备份口令」，与本地备份共用：在「备份口令」卡输入，或「记住（存入保管区）」后解锁库即免输；所有源共用同一口令；口令丢失则云端备份无法解开（无后门、无找回手段）

#### 同步语义

- 多源按顺序逐源执行（不并发），每源独立基线：先回读该源云端对象与基线比对，再按口令解密远端；单源失败不阻断其余源（上传流量/请求数随源数线性增长）
- 收敛规则：任一源采纳到较新的云端版本后，终局把该版本回推到其余基线不一致的源，防多源互相打架
- 冲突（云端与本地基线不同）：以云端为准覆盖本地（LWW，远端胜），覆盖前先把本地数据保存为冲突副本——桌面写入备份目录 `conflict-{源id}-{日期}-{时间}.totpbackup`（不参与滚动删除，可从备份列表恢复）；插件端保存为下载文件
- 远端内容用当前口令解不开（口令不一致/结构损坏）时直接报错，不做任何写入，本地数据不受影响；「失败：口令不匹配」时可用「用当前口令重置云端」救济（三步确认，以本地为准覆盖云端）
- 采用云端数据前有明确提示与两步确认；确认后云端数据整体替换当前 vault

#### 自动云同步

- 每源提供两种自动触发：「变更后自动同步」（防抖 10 秒合并连续操作）与「定时自动同步」（15 分钟 / 1 小时 / 6 小时 / 每天）
- 桌面版全功能；**插件端自动同步仅在 options 页打开期间运行**（Service Worker 后台不持有会话口令/DEK，无法加密，故不做后台 alarm），页面关闭即停
- 自动执行仅在解锁会话且备份口令就绪时运行；自动采纳云端版本不弹确认（区别于手动同步的两步确认），结果不打扰，状态行显示「上次自动同步：时间 + 成功/失败/跳过 + 逐源明细」；未设置备份口令/库锁定/无启用源时显示中文跳过原因

## 浏览器同步（扩展端）

仅插件端支持：借 Chrome 账号经 `chrome.storage.sync` 在登录同一账号的浏览器之间同步数据（桌面版无此功能）。开关在「浏览器同步」卡，**默认关闭**，需显式开启；卡内状态条显示上次同步时间/状态。

- 同步内容：vault 全量 + 应用设置。vault 落盘加密已启用时，同步的是 AES-256-GCM 密文（与「安全」页加密同一形态）；未启用时同步明文 JSON（与本地一致的信任模型，建议先启用加密）
- 分片机制：vault 按 UTF-8 字节切成每片 5500 字节原始数据的分片（键名 `sync:v1:序号/总数`，每片独立 base64），编码后约 7.4KB，低于同步区单键 8KB 上限；设置明文整份同步（仅偏好项，不含 secret）
- 冲突策略：简单 LWW——每次推送 revision 单调 +1，仅当远端 revision 更新时拉取应用；本地每次数据变更即推送，同步区有变化即拉取；开关位按设备独立，不会被其他设备改写
- 超限行为：同步区总配额约 100KB，占用超 90% 时状态条提示「同步空间已满——建议配置云备份后关闭浏览器同步」
- 加密态换设备：新设备同步到的是密文，需输入**同一口令**解锁后才能查看/使用；口令不存储在同步通道中，丢失则无法解锁
- 浏览器支持：以 Chrome/Edge 为主验证；Firefox 的 storage.sync 配额与行为不同，未全面验证

## 导入

导入入口在「导入」页。选择文件后自动嗅探格式，按向导完成解析 → **去重预览** → 确认 → 报告；识别失败或误判时可在格式下拉中手动指定。各格式字段口径对齐 Aegis 官方导入器实现（beemdevelopment/Aegis）。

### 支持格式

**文本格式（桌面与插件均可导入）**

- **Aegis**（JSON vault）：明文与口令加密均支持；加密 vault 需输入 Aegis 导出时设置的口令（scrypt + AES-GCM，算法对齐 Aegis 官方实现）
- **WinAuth**（XML 配置文件）：明文、口令保护（条目级/整包，PBKDF2 + Blowfish，对齐官方算法）均支持；使用 Windows DPAPI 加密（用户/机器层）的文件**仅桌面版可导入**（依赖系统凭据解密），插件端遇到会逐条提示「请用桌面版导入」；YubiKey 加密暂不支持
- **2FAS**（JSON 导出）：明文支持（TOTP/HOTP/Steam）；加密导出（servicesEncrypted）不支持，会提示改用不加密导出
- **Bitwarden**（JSON 导出）：明文支持，`login.totp` 接受 otpauth URI / `steam://` / 裸 base32 secret 三种形态（裸 base32 secret 也支持，与 Aegis `BitwardenImporter` 差异，本工具扩展）；密码保护导出（encrypted）不支持，会提示改用明文导出
- **Ente Auth**：明文导出即 otpauth URI 行文本，与「URI 文本」同一入口；加密导出不支持，请在应用内改用明文导出
- **Proton Authenticator**（JSON 导出）：明文支持（条目 uri 为 otpauth:// 或 steam://）；加密导出不支持，会提示改用明文导出
- **Stratum / Authenticator Pro**（JSON 导出）：明文支持（大写键 schema，HOTP/TOTP/Steam）；二进制加密导出不支持
- **FreeOTP+**（JSON 导出）与**旧版 FreeOTP**（shared_prefs tokens.xml）：均支持；secret 按字节数组还原，HOTP counter 沿用存储值（对齐 Aegis 口径）
- **TOTP Authenticator**：明文 JSON 数组与外部分享文件（Base64 密文）均支持；分享文件默认口令 `TotpAuthenticator`，改过口令的在口令页输入
- **andOTP**（JSON 导出）：明文支持；加密备份（二进制）暂不支持，请用明文导出
- **FoxAuth**（JSON 备份）：明文与口令加密均支持；加密备份需输入导出口令（口令以 Base64 存于 `passwordInfo.encryptPassword`，HKDF-SHA-256 + AES-GCM，算法对齐 FoxAuth 官方实现）
- **Authy**（shared_prefs XML）：明文与口令加密条目均支持；含加密条目时需输入 Authy 备份口令（PBKDF2 + AES-CBC）
- **Battle.net**（shared_prefs XML）：XOR 掩码还原，单文件单条目（8 位 TOTP）
- **Duo**（files/duokit/accounts.json）：JSON 数组，含 counter 的条目按 HOTP 导入
- **Microsoft Authenticator**（SQLite db）：`accounts` 表，普通条目 6 位、Microsoft 型 8 位 TOTP
- **Google Authenticator / otpauth URI 文本**：每行一条 `otpauth://totp/...|hotp/...|steam/...|yaotp/...` URI（多数应用的 URI/迁移文本导出均走此入口，含 Ente Auth 明文导出）
- **Authenticator Plus**：口令加密 ZIP 备份支持导入，需输入备份口令（AES 加密 ZIP，对齐官方加密布局）
- **通用 JSON / JSON array / JSONL**：逐字段配置点路径映射（如 `otp.params.secret`）将行对象映射为条目，secret 字段必填；单个 JSON 对象会自动探测其嵌套的行数组。secret 自动去空白并大写，非法 algorithm/digits/period 回落默认值（SHA1/6/30），Steam 条目固定 5 位。映射方案可命名保存、复用与删除：再次导入同结构文件时按列名匹配自动推荐，也可手动套用

**SQLite 数据库（桌面与插件均可导入，需联网）**

- 来源设备数据库文件（应用私有目录的 db，经系统备份/adb 等方式取出）：先按 SQLite 文件头校验，再在 sqlite_master 中按已知表名探测并解析（当前识别 Microsoft Authenticator 的 `accounts` 表）
- 解析经 sql.js 完成，其 wasm 二进制固定从 jsdelivr CDN 加载，**首次使用需联网**；离线时明确报错，SQLite 类导入不可用

**暂不支持**

- **Google Authenticator 旧版 SQLite 数据库**（≤5000100 版本）：需 root 提取应用私有目录数据库，暂不支持
- **Steam Android 客户端**：Steamguard-*.json 暂不支持；Steam 令牌可经 WinAuth 导入

### 去重与冲突处理（四档判定树）

解析后预览阶段逐条标注（互斥完备，secret 维度优先于 issuer+label 维度）：

- **完全相同**（全部关键字段一致）：自动跳过，不重复落库
- **疑似同账户**（secret + 算法相同，其余字段不同）：逐条三选——跳过（默认）/ 新增 / 覆盖现有条目
- **冲突**（issuer + label 相同但 secret 不同，忽略大小写与首尾空白）：按冲突策略处理——跳过冲突条目（默认）/ 覆盖现有条目（保留其标签与排序位置）/ 保留两者（并存）
- **新增**：其余条目直接落库

文件内完全重复的行自动合并（保留首条），避免预览计数虚高。确认导入后报告逐类计数与逐条失败原因（含行号/条目号）；单条解析失败不阻断整体导入，整体解密类失败（如 Aegis 口令错误）明确报错且不写入部分数据。

## 图标

条目可配置品牌图标，列表头像与录入表单展示；四种来源，均在录入/编辑表单的「图标」区设置。

### 内置图标集

- Simple Icons 精选 **218 项**（CC0、单色 SVG），覆盖开发/云/运维/身份认证/社交/媒体/购物/金融/加密/游戏/自托管/密码工具等常见 2FA 发行方；由 [scripts/gen-builtin-icons.mjs](scripts/gen-builtin-icons.mjs) 从 simple-icons 包提取生成（[packages/core/src/icons/builtin.json](packages/core/src/icons/builtin.json)，另含 58 条 issuer 别名）
- 商标下架说明：上游 Simple Icons 会应商标方要求不定期移除部分品牌图标，内置集只能收录当期包内仍在收录的图标；已下架或未收录的品牌，请用图标包导入/上传/URL 引用补足
- issuer 关键词推荐：录入时输入发行方名称自动匹配（归一化忽略大小写与空白、`.`、`-`、`_`，含中文别名如「微信」「B站」「战网」）；命中且未手动选图标时显示推荐气泡，点击即用

### 图标包导入

- 支持 aegis-icons 社区包及同构 zip 包：任意目录层级下的 `.png` 均会导入，**文件名（去扩展名）即服务名**，与条目 issuer 归一化后匹配
- 限制：单个文件超过 50KB 跳过；最多导入 500 个；同名（归一化后）图标后者覆盖前者
- 入口：录入/编辑表单的「图标」区点「导入图标包（zip）」选择 zip 文件；导入后需在条目编辑中手动选择对应图标（包导入只入库，不自动绑定到条目）

### 用户上传

- 任意图片自动等比缩放至长边 ≤128px（不放大），转 PNG 存储

### URL 引用

- 填入图片 URL 后立即拉取并缓存为本地副本（缓存键 `urlcache:<id>`）
- URL 拉取上限 200KB，超限视为失败；拉取失败（网络不通、非 2xx、站点不允许跨域 CORS）会明确报错，修正 URL 后可重试；缓存丢失（如清空存储、换设备）时列表回退首字母占位，可在编辑表单重新拉取

### 存储位置

- 图标统一以 dataUrl 存于 `'icons'` 键（id→dataUrl 映射），与 vault 各自独立
- 浏览器插件：`chrome.storage.local`，已声明 `unlimitedStorage` 权限，不受 10MB 默认配额限制；popup 与 options 共享同一份数据
- 桌面：与 vault 同目录 `%APPDATA%/com.totp.desktop/`

## 开发与构建

```bash
pnpm install
pnpm test          # 全部前端单测（core / ui / extension / desktop 四包 vitest，各包实跑数见输出）
cargo test         # Rust 侧单测（apps/desktop/src-tauri，CI 门禁运行；cargo clippy -- -D warnings 同）
# 注意：extension 的类型检查依赖 WXT 生成的 .wxt/ 目录（已被 git ignore），
# 需先 pnpm --filter @totp/extension exec wxt prepare 生成类型，再执行 pnpm typecheck。
pnpm --filter @totp/extension build                        # Chrome 目标产物 .output/chrome-mv3
pnpm --filter @totp/extension exec wxt build -b firefox    # Firefox 目标产物 .output/firefox-mv3
pnpm typecheck     # 类型检查：core 为纯 tsc；ui/extension/desktop 为 vue-tsc（含 .vue 单文件组件）
```

- 扩展双目标均为 **Manifest V3**：Firefox 端 `strict_min_version: 140.0`、gecko id `totp@bhxch.github.io`（AMO 一经发布不可改），manifest 配置见 [apps/extension/wxt.config.ts](apps/extension/wxt.config.ts)；CI 在「Assert MV3 artifacts」步断言双目标产物（[.github/workflows/build.yml](.github/workflows/build.yml)）
- 端到端验证基建（测试专用，不影响运行时）：[scripts/inject-test-shim.mjs](scripts/inject-test-shim.mjs) 向构建产物注入 chrome shim 与 fetch/clipboard mock，配合 `?seedVault=` / `?seedKeys=` / `?tabUrl=` 驱动测试态；历轮验证报告见 [docs/review/](docs/review/)

## 架构与文档索引

- [packages/core](packages/core/) — 纯 TS 核心：OTP 引擎（HOTP/TOTP/Steam/URI）、匹配策略、加密与 envelope、备份源模型、云同步编排（多目标/调度器/滚动删除）、导入器（17+ 格式与去重判定树）、存储抽象
- [packages/ui](packages/ui/) — Vue 3 共享层：MD3 组件库（[packages/ui/src/components/md/](packages/ui/src/components/md/)）、主题系统（[packages/ui/src/theme/](packages/ui/src/theme/)：10 种子色 × 明暗 35 角色 tokens + AMOLED 对比度覆盖层，按需懒加载）、五页导航与页面、store（DEK 保管区/口令轮换/解锁状态机）、双端共享 runner（云同步/备份）
- [apps/extension](apps/extension/) — WXT 浏览器插件（Chrome/Edge/Firefox，均 MV3）：popup、options（同构五页）、background、DEK 会话持久化、云凭据迁移
- [apps/desktop](apps/desktop/) — Tauri 2 桌面程序（复用 [packages/ui](packages/ui/)）：主窗口五页、mini 弹窗、自动备份/自动云同步 runner、窗口资源释放、内置 MCP 服务器、Rust 端（备份目录命令 / DPAPI / osAutoUnlock / Windows 锁屏事件 / 释放策略 / MCP server）

文档索引：

- 总体设计与前端重设计：[docs/plans/2026-09-13-totp-tool-design.md](docs/plans/2026-09-13-totp-tool-design.md)、[docs/plans/2026-09-15-frontend-redesign-design.md](docs/plans/2026-09-15-frontend-redesign-design.md)
- 备份源与加密设计：[docs/plans/2026-09-17-backup-sources-and-crypto-design.md](docs/plans/2026-09-17-backup-sources-and-crypto-design.md)
- MCP 服务器设计：[docs/plans/2026-09-21-mcp-server-design.md](docs/plans/2026-09-21-mcp-server-design.md)
- 实施计划（按里程碑）：[docs/plans/](docs/plans/)
- 审查与端到端验证报告（含 MCP 真机测试）：[docs/review/](docs/review/)

## 已知限制

详见 [plan13-16 全量代码审查](docs/review/2026-09-18-plan13-16-full-code-review.md)与[批⑧六规格审查与验证](docs/review/2026-09-22-six-specs-review-and-verification.md)。

- **手动云同步不设内容门**：manual 轮始终完整推拉（内容无变化也会重写云端）；自动轮经持久内容门降级 pull-only，内容无变化时零上传，两端均闲置不再互踢
- **Google Drive 源的「保留最近 N 份」当前等价「覆盖」**（时间戳文件名对 gdrive 不生效，远端始终只有一份对象）
- **桌面自动备份部分失败仍会推进基线**：任一目录写入失败时基线照常前进且状态行记「成功」，后续不再自动重试，需手动备份补写
- **桌面「重启后保持锁定」开关当前无效果**（桌面无会话级 DEK 存储，重启后必为锁定态）；mac/Linux 的「系统锁屏时锁定」触发器不可用（挂账）
- **Firefox（MV3）**：剪贴板自动清空不可用（无 offscreen API，清空降级为仅前台不调度）；空闲/锁屏自动锁定按 MDN 兼容性 idle API 已支持（含 `locked` 态，min_version 140），真机如有异常以运行时降级提示为准；Passkey（PRF）解锁支持有限，探测不支持时入口自动隐藏
- **云端列表无分页**：单目录/前缀下对象数超过云接口单页上限时（如 S3 1000 条），滚动删除可能漏删最旧份

## License

[MIT](LICENSE)
