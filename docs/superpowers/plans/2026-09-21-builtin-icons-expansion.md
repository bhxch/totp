# 内置服务 Icon 扩充 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置 icon 从 Simple Icons 精选 111 项扩至约 300+ 项，覆盖主流 2FA 发行方；协议路线（CC0 单色）不变。

**Architecture:** 仅改 `scripts/gen-builtin-icons.mjs` 的 `BRANDS` 白名单并重新生成 `packages/core/src/icons/builtin.json`；采用「候选 slug ∩ simple-icons 实际导出」策略，个别 slug 不存在不致构建失败。

**Tech Stack:** Node 脚本（simple-icons devDependency）、vitest（core 既有 registry 测试）。

**Spec:** `docs/superpowers/specs/2026-09-21-builtin-icons-expansion-design.md`

## Global Constraints

- 仅接受 `simple-icons` 包内存在 slug（脚本按 slug 索引过滤，不硬编码 path）。
- 生成必须幂等：同输入重跑 diff 为零。
- README 中「内置 icon 数量」描述同步更新；商标免责段已有、不改。

---

### Task 1: BRANDS 白名单扩充

**Files:**
- Modify: `scripts/gen-builtin-icons.mjs`（`BRANDS` 数组，约 30 行起）

**Interfaces:**
- Consumes: simple-icons 全量导出（`bySlug` Map，脚本既有）
- Produces: 更大的 `builtin.json`

- [ ] **Step 1: 追加候选 slug**

在 `BRANDS` 数组末尾（保持既有条目不动）追加以下候选（注释分组；**逐个核对**：生成脚本按 `bySlug.has(slug)` 过滤，不存在的 slug 打印警告并跳过——若脚本尚无该警告，本任务补上）：

```js
  // 扩充批（2026-09-21 验收条目5）：开发/运维/身份
  'azuredevops', 'awslambda', 'amazonwebservices', 'googledrive', 'googledrive', 'googledocs',
  'kalilinux', 'proxmox', 'truenas', 'synology', 'portainer', 'jenkins', 'circleci', 'githubcopilot',
  'neovim', 'intellijidea', 'pycharm', 'vscodium', 'octopusdeploy', 'hashicorp', 'vault', 'terraform',
  'auth0', 'okta', 'onelogin', 'duo', 'mattermost', 'zulip', 'element', 'matrix', 'signal',
  'protonmail', 'protondrive', 'protonvpn', 'tutanota', 'fastmail', 'icloud', 'onedrive', 'sharepoint',
  'godaddy', 'namecheap', 'cloudflarepages', 'v2ray', 'nginx', 'caddy', 'traefik', 'grafanaos',
  // 社交/媒体/购物
  'mastodon', 'bluesky', 'threads', 'lemmy', 'pixelfed', 'peertube', 'twitch', 'youtube', 'youtubemusic',
  'soundcloud', 'bandcamp', 'patreon', 'kofi', 'liberapay', 'opencollective', 'buymeacoffee',
  'goodreads', 'letterboxd', 'trakt', 'crunchyroll', 'disneyplus', 'hulu', 'primevideo', 'max',
  'spareroom', 'aliexpress', 'shein', 'temu', 'ebay', 'etsy', 'shopify', 'woocommerce', 'square',
  'kakaotalk', 'naver', 'line', 'viber', 'snapchat', 'pinterest', 'linkedin', 'xing', 'vk',
  // 金融/加密/游戏
  'monero', 'ethereum', 'bitcoin', 'lightning', 'kraken', 'bitfinex', 'bybit', 'gateio', 'htx',
  'ledger', 'trezor', 'metamask', 'phantom', 'revolut', 'monzo', 'starlingbank', 'wise', 'samsungpay',
  'steamworkshop', 'ubisoft', 'nintendo', 'playstation', 'rockstargames', 'itchdotio', 'curseforge',
  'modrinth', 'humblebundle', 'gogdotcom', 'ea', 'lutris',
  // 安全/密码/工具
  '1password', 'bitwarden', 'keepassxc', 'protonpass', 'dashlane', 'lastpass', 'yubico', 'snyk',
  'sonarqube', 'virustotal', 'haveibeenpwned', 'privacyguides', 'torbrowser', 'torproject', 'brave',
  'librewolf', 'waterfox', 'vivaldi', 'operagx', 'opera', 'edge', 'thunderbird', 'protoncalendar',
  'anytype', 'obsidian', 'joplin', 'logseq', 'syncthing', 'nextcloud', 'owncloud', 'filebrowser',
  'homepage', 'homarr', 'homeassistant', 'jellyfin', 'plex', 'kavita', 'audiobookshelf', 'qbittorrent',
  'transmission', 'radarr', 'sonarr', 'lidarr', 'prowlarr', 'overseerr', 'tautulli', 'netbird', 'tailscale',
```

处理不存在的 slug：脚本在索引构建后加：

```js
const missing = BRANDS.filter((slug) => !bySlug.has(slug))
if (missing.length > 0) {
  console.warn(`[gen-builtin-icons] simple-icons 无以下 slug（已跳过）: ${missing.join(', ')}`)
}
const icons = BRANDS.filter((slug) => bySlug.has(slug)).map((slug) => { /* 既有映射逻辑 */ })
```

（若脚本既有逻辑已是数组 map 无过滤，按此补过滤；保持输出 JSON 结构与字段不变。）

- [ ] **Step 2: 重新生成并检查幂等**

Run: `node scripts/gen-builtin-icons.mjs && node scripts/gen-builtin-icons.mjs`
Expected: 第二次运行 diff 为零；警告行列出实际不存在的 slug（属预期，不视为失败）

Run: `git diff --stat packages/core/src/icons/builtin.json`
Expected: 条目数增长至约 300+；文件体积 < 300KB

- [ ] **Step 3: Commit**

```bash
git add scripts/gen-builtin-icons.mjs packages/core/src/icons/builtin.json
git commit -m "feat(core): 内置icon扩充至300+主流2FA服务（验收条目5）"
```

### Task 2: registry 回归与 README 更新

**Files:**
- Modify: `packages/core/src/icons/registry.ts`（若测试需样本断言，则改测试不改实现）
- Modify: `README.md`（内置 icon 数量描述，约 230-235 行区域）

**Interfaces:**
- Consumes: `recommendBuiltinIcon` / `suggestIcons`（既有签名不动）
- Produces: 无接口变化

- [ ] **Step 1: 匹配率回归测试**

core 既有 icon 测试文件内追加（文件名以 `rg -l "recommendBuiltinIcon" packages/core` 为准）：

```ts
import builtinIcons from '../src/icons/builtin.json'

describe('builtin icons 扩充回归', () => {
  it('扩充后不少于 300 项且结构合法', () => {
    const entries = Object.entries(builtinIcons) // 若为数组则按实际结构调整
    expect(entries.length).toBeGreaterThanOrEqual(300)
    for (const [, v] of entries as Array<[string, { path: string }]>) {
      expect(typeof v.path).toBe('string')
      expect(v.path.startsWith('M')).toBe(true)
    }
  })

  it('高频 issuer 推荐命中不下降', () => {
    for (const issuer of ['GitHub', 'Google', 'Cloudflare', 'Discord', 'Bilibili', 'Steam', 'Bitwarden']) {
      expect(recommendBuiltinIcon(issuer)).not.toBeNull()
    }
  })
})
```

（`builtin.json` 导入形状以现有 loader 为准——若经 `registry.ts` 导出常量，则断言该常量而非直接 import JSON。）

- [ ] **Step 2: 运行**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 3: README 更新**

README 中 icon 数量与覆盖描述改为实际值（如「300+ 服务」）。

- [ ] **Step 4: Commit**

```bash
git add packages/core README.md
git commit -m "test(core): 内置icon扩充回归与README计数更新（验收条目5）"
```
