// 从 simple-icons 包提取内置图标精选集，生成 packages/core/src/icons/builtin.json。
// 用法: node scripts/gen-builtin-icons.mjs
// 注意: simple-icons 是 @totp/core 的 devDependency，通过 createRequire 从 core 包目录解析。
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromCore = createRequire(resolve(root, 'packages/core/package.json'))
// eslint-disable-next-line @typescript-eslint/no-require-imports -- simple-icons 的 CJS 入口（exports.require）
const si = requireFromCore('simple-icons')

/** 按 slug 索引 simple-icons 全量导出（si<PascalCase> 对象，含 title/slug/path） */
const bySlug = new Map()
for (const icon of Object.values(si)) {
  if (icon && typeof icon === 'object' && typeof icon.slug === 'string' && typeof icon.path === 'string') {
    bySlug.set(icon.slug, icon)
  }
}

/** 内置精选名单（slug），覆盖常见 2FA 发行方：开发/云/社区/国内服务/支付/游戏/安全 */
const BRANDS = [
  // 开发与云
  'github', 'githubactions', 'gitlab', 'git', 'gitea', 'gitee', 'gitbook', 'gitkraken', 'gitpod',
  'bitbucket', 'atlassian', 'jira', 'confluence', 'trello', 'asana', 'linear', 'jetbrains',
  'notion', 'figma', 'vercel', 'netlify', 'docker', 'kubernetes', 'npm', 'cloudflare',
  'digitalocean', 'supabase', 'firebase', 'mongodb', 'redis', 'postgresql', 'sentry', 'datadog', 'grafana',
  // 平台与消费者应用
  'google', 'googlecloud', 'googlegemini', 'googlechrome', 'googleauthenticator', 'gmail',
  'apple', 'applepay', 'discord', 'telegram', 'whatsapp', 'x', 'instagram', 'facebook', 'reddit',
  'tiktok', 'dropbox', 'zoom',
  // 国内服务
  'xiaohongshu', 'kuaishou', 'meituan', 'baidu', 'zhihu', 'sinaweibo', 'bilibili',
  'neteasecloudmusic', 'qq', 'wechat', 'alipay', 'alibabacloud', 'aliexpress', 'huawei',
  'harmonyos', 'xiaomi',
  // 支付与交易所
  'binance', 'coinbase', 'okx', 'kucoin', 'stripe', 'paypal',
  // 游戏与媒体
  'steam', 'steamdb', 'steamdeck', 'steamworks', 'battledotnet', 'epicgames', 'riotgames',
  'ubisoft', 'ea', 'roblox', 'unity', 'unrealengine', 'humblebundle', 'gogdotcom',
  'twitch', 'youtube', 'netflix', 'spotify', 'playstation5', 'claude', 'huggingface',
  // 安全与密码管理
  'firefox', 'brave', '1password', 'bitwarden', 'lastpass', 'dashlane', 'keepassxc',
  'proton', 'protonmail', 'protonvpn', 'protondrive', 'mullvad', 'tailscale',
  'aegisauthenticator', 'authentik', 'yubico',
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
]

/** 别名表：normalizeIssuer 后的键 → 内置图标 id（键不得含空白/点/连字符/下划线，值必须存在于 BRANDS） */
const ALIASES = {
  // 英文习惯写法
  githubcom: 'github',
  gitlabcom: 'gitlab',
  bitbucketorg: 'bitbucket',
  steamchat: 'steam',
  twitter: 'x',
  xcom: 'x',
  gcp: 'googlecloud',
  googlecloudplatform: 'googlecloud',
  gemini: 'googlegemini',
  claudeai: 'claude',
  battlenet: 'battledotnet',
  battle: 'battledotnet',
  psn: 'playstation5',
  ps5: 'playstation5',
  gog: 'gogdotcom',
  humble: 'humblebundle',
  riot: 'riotgames',
  epic: 'epicgames',
  eagames: 'ea',
  // 中文别名
  谷歌: 'google',
  推特: 'x',
  苹果: 'apple',
  脸书: 'facebook',
  照片墙: 'instagram',
  油管: 'youtube',
  电报: 'telegram',
  网飞: 'netflix',
  声破天: 'spotify',
  贝宝: 'paypal',
  币安: 'binance',
  欧易: 'okx',
  库币: 'kucoin',
  支付宝: 'alipay',
  微信: 'wechat',
  腾讯: 'qq',
  微博: 'sinaweibo',
  新浪微博: 'sinaweibo',
  哔哩哔哩: 'bilibili',
  b站: 'bilibili',
  网易云: 'neteasecloudmusic',
  网易云音乐: 'neteasecloudmusic',
  小红书: 'xiaohongshu',
  快手: 'kuaishou',
  美团: 'meituan',
  百度: 'baidu',
  知乎: 'zhihu',
  抖音: 'tiktok',
  华为: 'huawei',
  鸿蒙: 'harmonyos',
  小米: 'xiaomi',
  阿里云: 'alibabacloud',
  阿里巴巴: 'alibabacloud',
  速卖通: 'aliexpress',
  战网: 'battledotnet',
  育碧: 'ubisoft',
  拳头: 'riotgames',
  拳头游戏: 'riotgames',
  红迪: 'reddit',
}

const normalizeKey = (s) => s.toLowerCase().replace(/[\s._-]+/g, '')

function main() {
  // 扩充批候选与既有条目可能重叠、且清单可能含录入重复，按出现顺序去重
  const slugs = Array.from(new Set(BRANDS))
  // 上游 simple-icons 会应商标方要求不定期移除品牌，候选中已不存在的 slug 警告并跳过（属预期）
  const missing = slugs.filter((slug) => !bySlug.has(slug))
  if (missing.length > 0) {
    console.warn(`[gen-builtin-icons] simple-icons 无以下 slug（已跳过）: ${missing.join(', ')}`)
  }
  if (slugs.length < 64) throw new Error(`BRANDS 需至少 64 项，当前 ${slugs.length}`)

  const icons = {}
  for (const slug of slugs) {
    if (!bySlug.has(slug)) continue
    const { title, path } = bySlug.get(slug)
    icons[slug] = { id: slug, title, path }
  }

  // 别名校验以实际生成结果为准：候选 slug 若因上游下架被跳过，别名不得悬空指向
  for (const [alias, id] of Object.entries(ALIASES)) {
    if (normalizeKey(alias) !== alias) throw new Error(`别名键未规范化: ${alias}`)
    if (!(id in icons)) throw new Error(`别名 ${alias} 指向未收录的 id: ${id}`)
  }
  if (Object.keys(ALIASES).length < 30) throw new Error('别名表需至少 30 条')

  const outPath = resolve(root, 'packages/core/src/icons/builtin.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify({ icons, aliases: ALIASES }, null, 2) + '\n')
  console.log(`builtin.json 已生成: ${Object.keys(icons).length} 个图标, ${Object.keys(ALIASES).length} 条别名`)
}

main()
