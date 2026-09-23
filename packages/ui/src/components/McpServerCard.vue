<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { McpConfigWithStatusDto, McpPlatform } from './mcpCard'
import { connectionSnippet, DEFAULT_EXPOSED_TOOLS, MCP_MODE_OPTIONS, MCP_TOOLS, randomDynamicPort, sanitizeExposedTools, serverStatus } from './mcpCard'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdIconButton from './md/MdIconButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

const props = defineProps<{
  /** MCP 平台实现（桌面宿主桥接 mcp_* 命令）；挂载即拉取当前配置与运行态 */
  platform: McpPlatform
}>()

const cfg = ref<McpConfigWithStatusDto | null>(null)
const busy = ref(false)
const error = ref('')
// ---------- 端口：update:model-value 逐键只改显示，change（失焦/回车）校验 1024–65535 后提交 ----------
const portText = ref('')
const portError = ref('')

/** 档位选项（label= i18n 文案）：computed 保持 locale 切换后文案联动（同 SettingsPage MODE_OPTIONS） */
const MODE_OPTIONS = computed(() => MCP_MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) })))

function fail(e: unknown): void {
  error.value = `${t('mcpServer.error')}：${e instanceof Error ? e.message : String(e)}`
}

// ---------- 运行态：以服务端返回为准对账（enabled=true 但没起来=错误色启动失败文案） ----------
const status = computed(() =>
  cfg.value ? serverStatus(cfg.value, cfg.value.running, cfg.value.lastError) : null,
)

/** 重查配置+运行态（加载、开关切换/重生成 token 等写操作后调用，刷新状态行）。
 * exposedTools 兜底初始化（Task 8 审查）：桥接载荷缺字段时补默认只读档——否则整体回写丢字段，
 * Rust serde default 会把用户勾选静默重置；sanitize 顺带滤净存储中的未知名并按已知顺序去重 */
async function refresh(): Promise<void> {
  const next = await props.platform.getConfig()
  cfg.value = {
    ...next,
    exposedTools: sanitizeExposedTools(Array.isArray(next.exposedTools) ? next.exposedTools : [...DEFAULT_EXPOSED_TOOLS]),
  }
  portText.value = String(cfg.value.port)
}

onMounted(async () => {
  try {
    await refresh()
  } catch (e) {
    fail(e)
  }
})

/** 统一写通道：busy 防重入；先乐观前进，成败都重查——成功刷新运行态，
 * 失败时 Rust 侧可能已保存配置/已停服（如重启撞端口占用），以服务端返回为准对账；
 * 仅重查也失败才回滚到 prev 并置错误横幅。
 * next/prev 均为含运行态的完整 DTO：调用方由 cur 整体展开，乐观赋值不留残缺对象 */
async function persist(next: McpConfigWithStatusDto, prev: McpConfigWithStatusDto): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  cfg.value = next
  try {
    await props.platform.setConfig({ ...next })
  } catch (e) {
    fail(e)
  }
  try {
    await refresh()
  } catch (e) {
    cfg.value = prev
    portText.value = String(prev.port)
    if (!error.value) fail(e)
  }
  busy.value = false
}

function onEnabled(v: boolean): void {
  const cur = cfg.value
  if (!cur) return
  void persist({ ...cur, enabled: v }, cur)
}

function onModeChange(v: string | number): void {
  const cur = cfg.value
  if (!cur) return
  void persist({ ...cur, mode: v as McpConfigWithStatusDto['mode'] }, cur)
}

// ---------- 暴露工具（spec §6.3）：勾选变更即整体回写，与 mode/whitelist 同语义（Rust 每请求重读配置，即时生效） ----------
function onToggleTool(name: string, on: boolean): void {
  const cur = cfg.value
  if (!cur) return
  const set = new Set(cur.exposedTools)
  if (on) set.add(name)
  else set.delete(name)
  void persist({ ...cur, exposedTools: sanitizeExposedTools([...set]) }, cur)
}

// ---------- 白名单：添加（trim 非空、卡内去重，大小写不敏感与 Rust eq_ignore_ascii_case 同口径）与逐条删除，均整体回写 ----------
const newPattern = ref('')
function onAddPattern(): void {
  const cur = cfg.value
  const p = newPattern.value.trim()
  if (!cur || p === '' || cur.whitelist.some((w) => w.toLowerCase() === p.toLowerCase())) return
  newPattern.value = ''
  void persist({ ...cur, whitelist: [...cur.whitelist, p] }, cur)
}
function onRemovePattern(pattern: string): void {
  const cur = cfg.value
  if (!cur) return
  void persist({ ...cur, whitelist: cur.whitelist.filter((x) => x !== pattern) }, cur)
}

// ---------- 端口提交（显示态 portText/portError 声明在文件头状态区） ----------
function onPortInput(v: string): void {
  portText.value = v
  portError.value = ''
}
function onPortCommit(): void {
  const cur = cfg.value
  if (!cur) return
  const n = Number(portText.value)
  if (portText.value.trim() === '' || !Number.isInteger(n) || n < 1024 || n > 65535) {
    portError.value = t('mcpServer.portInvalid')
    portText.value = String(cur.port) // 非法回显当前端口，不提交
    return
  }
  if (n === cur.port) return
  void persist({ ...cur, port: n }, cur)
}

/** 验收条目1：随机到 IANA 动态端口段 49152-65535（纯函数 randomDynamicPort），走 onPortCommit 同路径校验+持久化 */
function onRandomPort(): void {
  portText.value = String(randomDynamicPort())
  void onPortCommit()
}

// ---------- Token：掩码显示 + 复制 + 重新生成（行内两步确认，沿 BackupCard removeConfirm 模式） ----------
const tokenVisible = ref(false)
/** 空 token 防护：未启用时 Rust 侧未生成 token（空串），复制只能得到空值——置灰复制按钮 */
const hasToken = computed(() => !!cfg.value?.token)
const copied = ref<'none' | 'token' | 'snippet' | 'revoke'>('none')
let copiedTimer: ReturnType<typeof setTimeout> | null = null
function flashCopied(kind: 'token' | 'snippet' | 'revoke'): void {
  copied.value = kind
  if (copiedTimer !== null) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = 'none' }, 2000)
}
async function copyToken(): Promise<void> {
  const cur = cfg.value
  if (!cur || !cur.token) return
  try {
    // Task 9 审查：复制走宿主 copyText（桌面=暂存通道 + 自动清空），卡片不直接碰 navigator.clipboard
    await props.platform.copyText(cur.token)
    flashCopied('token')
  } catch (e) {
    fail(e)
  }
}
async function copySnippet(): Promise<void> {
  const cur = cfg.value
  if (!cur) return
  try {
    await props.platform.copyText(connectionSnippet(cur))
    flashCopied('snippet')
  } catch (e) {
    fail(e)
  }
}
const pendingRegen = ref(false)
async function onRegenerate(): Promise<void> {
  if (busy.value) return
  pendingRegen.value = false
  busy.value = true
  error.value = ''
  try {
    await props.platform.regenerateToken()
    await refresh() // token 变更已触发服务重启：重查刷新 token 掩码与运行态
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

// ---------- 一次性授权吊销（once 批准 + deny 冷却一并清；行内两步确认沿 pendingRegen 模式） ----------
const pendingRevoke = ref(false)
const revokedN = ref(0)
async function onRevoke(): Promise<void> {
  if (busy.value) return
  pendingRevoke.value = false
  busy.value = true
  error.value = ''
  try {
    revokedN.value = await props.platform.revokeApprovals()
    flashCopied('revoke')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

const snippet = computed(() => (cfg.value ? connectionSnippet(cfg.value) : ''))

onBeforeUnmount(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer)
})
</script>

<template>
  <section class="card mcp">
    <h2>{{ t('mcpServer.title') }}</h2>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <template v-if="cfg">
      <div class="opt">
        <MdSwitch
          class="mcp-enable" :model-value="cfg.enabled" :disabled="busy" :aria-label="t('mcpServer.enable')"
          @update:model-value="onEnabled"
        />
        <span class="opt-label">{{ t('mcpServer.enable') }}</span>
        <span class="opt-hint">{{ t('mcpServer.enableHint') }}</span>
      </div>
      <p v-if="status" class="status" :class="`status-${status.tone}`" role="status">
        {{ t(status.key, status.params ?? {}) }}
      </p>
      <div class="cfg-row">
        <MdSelect
          class="mode-select" :model-value="cfg.mode" :options="MODE_OPTIONS" :disabled="busy"
          :label="t('mcpServer.mode')" :aria-label="t('mcpServer.mode')" @update:model-value="onModeChange"
        />
        <MdTextField
          class="port-field" type="number" :label="t('mcpServer.port')" :aria-label="t('mcpServer.port')"
          :model-value="portText" :error="portError" :disabled="busy" min="1024" max="65535"
          @update:model-value="onPortInput" @change="onPortCommit"
        />
        <MdIconButton class="random-port" :title="t('mcpServer.randomPort')" :aria-label="t('mcpServer.randomPort')" :disabled="busy" @click="onRandomPort">⟳</MdIconButton>
      </div>
      <div class="exposed-tools">
        <span class="opt-label">{{ t('mcpServer.exposedTitle') }}</span>
        <span class="opt-hint">{{ t('mcpServer.exposedHint') }}</span>
        <div v-for="tool in MCP_TOOLS" :key="tool.name" class="tool-row">
          <MdCheckbox
            class="tool-check" :model-value="cfg.exposedTools.includes(tool.name)" :label="t(tool.key)"
            :aria-label="t(tool.key)" :disabled="busy" @update:model-value="onToggleTool(tool.name, $event)"
          />
          <span v-if="tool.kind === 'action'" class="tool-hint">{{ t('mcpServer.exposedActionHint') }}</span>
        </div>
      </div>
      <div class="whitelist">
        <span class="opt-label">{{ t('mcpServer.whitelist') }}</span>
        <span class="opt-hint">{{ t('mcpServer.whitelistHint') }}</span>
        <div v-for="p in cfg.whitelist" :key="p" class="pattern-row">
          <code class="pattern">{{ p }}</code>
          <MdButton variant="text" danger :disabled="busy" @click="onRemovePattern(p)">{{ t('mcpServer.remove') }}</MdButton>
        </div>
        <div class="pattern-add">
          <MdTextField
            class="pattern-input" :model-value="newPattern" :label="t('mcpServer.patternPlaceholder')" :aria-label="t('mcpServer.patternPlaceholder')"
            :disabled="busy" autocomplete="off" @update:model-value="newPattern = $event" @keydown.enter="onAddPattern"
          />
          <MdButton variant="tonal" :disabled="busy || newPattern.trim() === ''" @click="onAddPattern">{{ t('mcpServer.add') }}</MdButton>
        </div>
      </div>
      <div class="revoke-block">
        <div class="token-row">
          <span class="opt-label">{{ t('mcpServer.revokeApprovals') }}</span>
          <MdButton variant="text" danger :disabled="busy" @click="pendingRevoke = true">{{ t('mcpServer.revoke') }}</MdButton>
          <span v-if="copied === 'revoke'" class="copied">{{ t('mcpServer.revoked', { n: revokedN }) }}</span>
        </div>
        <div v-if="pendingRevoke" class="confirm-row">
          <span>{{ t('mcpServer.revokeConfirm') }}</span>
          <MdButton danger :disabled="busy" @click="onRevoke">{{ t('mcpServer.confirmRevoke') }}</MdButton>
          <MdButton variant="text" :disabled="busy" @click="pendingRevoke = false">{{ t('mcpServer.cancel') }}</MdButton>
        </div>
      </div>
      <div class="token-block">
        <div class="token-row">
          <span class="opt-label">{{ t('mcpServer.token') }}</span>
          <code class="token-value">{{ cfg.token ? (tokenVisible ? cfg.token : '••••') : t('mcpServer.tokenEmptyHint') }}</code>
          <MdButton variant="text" :disabled="busy" @click="tokenVisible = !tokenVisible">
            {{ tokenVisible ? t('mcpServer.tokenHide') : t('mcpServer.tokenShow') }}
          </MdButton>
          <MdButton variant="text" :disabled="busy || !hasToken" @click="copyToken">{{ t('mcpServer.tokenCopy') }}</MdButton>
          <span v-if="copied === 'token'" class="copied">{{ t('mcpServer.copied') }}</span>
          <MdButton variant="text" danger :disabled="busy" @click="pendingRegen = true">{{ t('mcpServer.regenerate') }}</MdButton>
        </div>
        <div v-if="pendingRegen" class="confirm-row">
          <span>{{ t('mcpServer.regenConfirm') }}</span>
          <MdButton danger :disabled="busy" @click="onRegenerate">{{ t('mcpServer.confirmRegen') }}</MdButton>
          <MdButton variant="text" :disabled="busy" @click="pendingRegen = false">{{ t('mcpServer.cancel') }}</MdButton>
        </div>
      </div>
      <div class="snippet-block">
        <span class="opt-label">{{ t('mcpServer.snippet') }}</span>
        <pre class="snippet">{{ snippet }}</pre>
        <div class="snippet-actions">
          <MdButton variant="tonal" :disabled="busy" @click="copySnippet">{{ t('mcpServer.snippetCopy') }}</MdButton>
          <span v-if="copied === 'snippet'" class="copied">{{ t('mcpServer.copied') }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供（同 BackupCard/SecurityCard）；本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
.opt { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--md-sys-typescale-body-medium); }
.opt-label { font-size: var(--md-sys-typescale-body-medium); }
.opt-hint { opacity: .65; font-size: var(--md-sys-typescale-body-small); flex-basis: 100%; }
/* 运行态状态行：muted/pending 用默认弱化，ok/error 提色（enabled 但没起来必须能注意到） */
.status { margin: 0; font-size: var(--md-sys-typescale-body-small); opacity: .75; }
.status-ok { color: var(--md-sys-color-primary); opacity: 1; }
.status-error { color: var(--md-sys-color-error); opacity: 1; }
.cfg-row { display: flex; gap: 12px; flex-wrap: wrap; }
.mode-select { width: 280px; max-width: 100%; }
.port-field { width: 140px; }
/* 随机端口按钮：与端口输入框垂直居中对齐 */
.random-port { align-self: center; flex: none; }
/* 暴露工具勾选组：行序随 MCP_TOOLS，action 行尾随写操作警示 */
.exposed-tools { display: flex; flex-direction: column; gap: 6px; }
.tool-row { display: flex; align-items: center; gap: 8px; }
.tool-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.whitelist { display: flex; flex-direction: column; gap: 6px; }
.pattern-row { display: flex; align-items: center; gap: 8px; }
.pattern { font-size: var(--md-sys-typescale-body-small); opacity: .8; }
.pattern-add { display: flex; gap: 8px; align-items: center; }
.pattern-input { width: 240px; }
.token-block { display: flex; flex-direction: column; gap: 6px; }
.revoke-block { display: flex; flex-direction: column; gap: 6px; }
.token-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.token-value { font-size: var(--md-sys-typescale-body-small); opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
.copied { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-primary); }
.snippet-block { display: flex; flex-direction: column; gap: 6px; }
.snippet { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--md-sys-color-surface-container-high);
  font-size: var(--md-sys-typescale-body-small); overflow: auto; max-height: 200px; }
.snippet-actions { display: flex; align-items: center; gap: 8px; }
</style>
