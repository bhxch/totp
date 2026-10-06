<script setup lang="ts">
import type { CloudCred, GDriveCred, OneDriveCred, Retention } from '@totp/core'
import { DEFAULT_OBJECT_PATH, previewObjectPath } from '@totp/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { customProxyUrlError, hasPlaintextUrl, isGistDraft, isOAuthCapableDraft, isOneDriveDraft, isS3Draft, isWebdavDraft } from './cardShared'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 单源凭据编辑副本（父级 credDrafts 的浅拷贝：嵌套字段就地编辑=编辑副本语义，草稿与已存凭据
   *  共享的嵌套对象由父级写时复制断开；draft 整体替换由父级负责，本组件不整换引用） */
  draft: CloudCred | undefined
  /** 全卡忙碌态：objectPath 等输入随 busy 禁用 */
  busy: boolean
  /** 该源保留策略（路径预览按 overwrite/keep 分支展示实际目标；缺省按 overwrite 展示） */
  retention?: Retention
  /** 宿主是否支持每源网络代理（③，CloudPlatform.proxySupport 透传）：false 不渲染代理控件并显示提示 */
  proxySupport?: boolean
}>()

const { t } = useI18n()

// ---------- 目标路径实时预览（bounded ②）：输入即算，语义与上传链同源（core previewObjectPath） ----------
const pathPreview = computed(() => {
  const d = props.draft
  if (!d) return null
  return previewObjectPath(d, { type: props.retention?.type ?? 'overwrite' })
})
const isKeep = computed(() => (props.retention?.type ?? 'overwrite') === 'keep')
/** spec §4.5：实际目标显示完整地址的 base——webdav=serverUrl 归一（http/https 才认），
 *  s3=s3://bucket；缺失/非法返回 null 回落裸路径。显示原文不预编码（URL 编码属传输细节） */
function urlBaseOf(d: CloudCred | undefined): string | null {
  if (d?.backend === 'webdav') {
    const raw = d.serverUrl.trim()
    try {
      const u = new URL(raw)
      if (u.protocol === 'http:' || u.protocol === 'https:') return raw.replace(/\/+$/, '')
    } catch { /* 回落裸路径 */ }
  }
  if (d?.backend === 's3' && 'bucket' in d && d.bucket.trim() !== '') return `s3://${d.bucket.trim()}`
  return null
}
const pathPreviewText = computed(() => {
  const p = pathPreview.value
  if (!p || p.state !== 'ok') return ''
  const base = urlBaseOf(props.draft)
  if (p.keepNamePlaceholder === undefined) {
    return t('cloudCard.pathPreviewOverwrite', { path: base ? `${base}/${p.path}` : p.path })
  }
  // keep：目录段显示 base[/dir]（URL 场景）或裸目录；空目录回落「（根目录）」占位
  const dirFull = base ? `${base}${p.path ? `/${p.path}` : ''}` : p.path
  return t('cloudCard.pathPreviewKeep', {
    dir: dirFull === '' ? t('cloudCard.pathPreviewRoot') : dirFull,
    name: p.keepNamePlaceholder,
  })
})

/** keep 文件名段忽略回显（spec §4.5）：目录意向（尾分隔符）不警示；
 *  有目录段警示文件名忽略；仅单段警示整体不参与 */
const keepIgnoreWarn = computed(() => {
  if (!isKeep.value) return null
  const raw = (props.draft?.objectPath ?? '').trim()
  if (raw === '' || /[\\/]$/.test(raw)) return null
  const segs = raw.split(/[\\/]/).filter((s) => s !== '')
  if (segs.length === 0) return null
  if (segs.length === 1) return { key: 'cloudCard.pathPreviewKeepNoDir', params: { raw } } as const
  return { key: 'cloudCard.pathPreviewKeepFileIgnored', params: { name: segs.at(-1), dir: segs.slice(0, -1).join('/') } } as const
})
const objectPathLabel = computed(() => (isKeep.value ? t('cloudCard.objectPathLabelKeep') : t('cloudCard.objectPathLabel')))

// ---------- OAuth 模式切换（spec §5⑦，仅 gdrive/onedrive）：oauth 三元组存在即 OAuth 模式 ----------
/** 凭据模式二选（MdSegmentedButton）：与后端约定一致——cred.oauth 存在=OAuth 自动刷新，缺省=手工 token */
const AUTH_MODE_OPTIONS = [
  { value: 'manual', label: t('cloudCard.oauthModeManual') },
  { value: 'oauth', label: t('cloudCard.oauthModeOAuth') },
]

/**
 * 模式切换（互斥语义在数据本身）：切到 OAuth 惰性建空三元组，切回手工删除 oauth（未保存的
 * 输入随之丢弃）。accessToken 保留不动——后端以它作初始 Bearer，失效时才走 oauth 刷新，
 * 手工 token 与 OAuth 可平滑过渡；旧手工凭据不出现 oauth 字段，行为不受影响。
 */
function onAuthMode(d: CloudCred | undefined, mode: string | number): void {
  if (!isOAuthCapableDraft(d)) return
  if (mode === 'oauth') {
    if (!d.oauth) d.oauth = { clientId: '', clientSecret: '', refreshToken: '' }
  } else if (mode === 'manual') {
    delete d.oauth
  }
}
/** OAuth 三字段写入——写时复制（审查 Important 1）：草稿为浅拷贝，d.oauth 与 credsCache/
 *  bag.creds 中已存凭据共享同一嵌套对象，原地改字段会把未保存编辑外溢到已存凭据且无法放弃；
 *  整对象替换断开共享（放弃编辑/重进页面即恢复已存值）。oauth 缺失时惰性兜底创建。 */
function setOauthField(d: GDriveCred | OneDriveCred, field: 'clientId' | 'clientSecret' | 'refreshToken', v: string): void {
  d.oauth = { ...(d.oauth ?? { clientId: '', clientSecret: '', refreshToken: '' }), [field]: v }
}

// ---------- ③ 每源网络代理（proxySupport 宿主声明驱动；proxy 随凭据整体落 secretBag，无需改保存链） ----------
/** 代理模式三选（MdSegmentedButton）：直连=显式清 proxy；系统/自定义=建 proxy 对象（url 保留供切回 custom） */
const PROXY_MODE_OPTIONS = [
  { value: 'none', label: t('cloudCard.proxyModeNone') },
  { value: 'system', label: t('cloudCard.proxyModeSystem') },
  { value: 'custom', label: t('cloudCard.proxyModeCustom') },
]
function onProxyMode(d: CloudCred, mode: string | number): void {
  // 云-I2：切 custom 且无已存 url 时暂存空串（而非 undefined）——空串是「未填写」判据，
  // customProxyUrlError 据此在保存前拦截；system 仍保留 url 供切回 custom
  d.proxy = mode === 'none'
    ? undefined
    : { mode: mode as 'system' | 'custom', url: d.proxy?.url ?? (mode === 'custom' ? '' : undefined) }
}
function onProxyUrl(d: CloudCred, v: string): void {
  if (d.proxy?.mode !== 'custom') return
  d.proxy = { mode: 'custom', url: v.trim() }
}
/** 云-I2：custom 代理地址为空/非法的就地错误行（路径预览错误同款 warn 展示；保存拦截在 CloudCard） */
const proxyUrlError = computed(() => customProxyUrlError(props.draft?.proxy))
</script>

<template>
  <!-- 草稿经单元素 v-for 提取局部变量 d，各类型字段区用 backend 守卫窄化联合（守卫在 cardShared）；
       gdrive/onedrive 两段模板逐字同构（R7）合并为 isOAuthCapableDraft 一段，token 文案按 backend 三元 -->
  <template v-for="d in [props.draft]" :key="0">
    <div v-if="isWebdavDraft(d)" class="fields">
      <MdTextField v-model="d.serverUrl" :label="t('cloudCard.serverUrlLabel')" :placeholder="t('cloudCard.serverUrlPlaceholder')" autocomplete="off" />
      <!-- F11：非本机 http 明文地址输入即警告（文案对齐 gist public 警告样式），保存另需显式勾选确认 -->
      <p v-if="hasPlaintextUrl(d)" class="warn" role="alert">{{ t('cloudCard.webdavPlaintextWarn') }}</p>
      <MdTextField v-model="d.username" :label="t('cloudCard.usernameLabel')" :placeholder="t('cloudCard.usernamePlaceholder')" autocomplete="off" />
      <MdTextField v-model="d.password" type="password" :label="t('cloudCard.appPasswordLabel')" :placeholder="t('cloudCard.appPasswordPlaceholder')" autocomplete="new-password" />
    </div>
    <div v-else-if="isS3Draft(d)" class="fields">
      <MdTextField v-model="d.region" label="Region" :placeholder="t('cloudCard.regionPlaceholder')" autocomplete="off" />
      <MdTextField v-model="d.bucket" label="Bucket" placeholder="Bucket" autocomplete="off" />
      <MdTextField v-model="d.accessKeyId" label="AccessKeyId" placeholder="AccessKeyId" autocomplete="off" />
      <MdTextField v-model="d.secretAccessKey" type="password" label="SecretAccessKey" placeholder="SecretAccessKey" autocomplete="new-password" />
      <!-- sessionToken/endpoint/prefix 为可选字段：undefined 以空串传 MdTextField（modelValue 要求 string），
           展示与空串/undefined 均显示 placeholder 一致；isBlankCred 对 '' 与 undefined 同判空白 -->
      <MdTextField :model-value="d.sessionToken ?? ''" type="password" :label="t('cloudCard.stsLabel')" :placeholder="t('cloudCard.stsLabel')" autocomplete="new-password" @update:model-value="d.sessionToken = $event" />
      <MdTextField :model-value="d.endpoint ?? ''" label="Endpoint" :placeholder="t('cloudCard.endpointPlaceholder')" autocomplete="off" @update:model-value="d.endpoint = $event" />
      <!-- F11：同 WebDAV，非本机 http endpoint 明文警告（缺省 endpoint 为 AWS https 域名，不触发） -->
      <p v-if="hasPlaintextUrl(d)" class="warn" role="alert">{{ t('cloudCard.s3PlaintextWarn') }}</p>
      <MdTextField :model-value="d.prefix ?? ''" :label="t('cloudCard.prefixLabel')" :placeholder="t('cloudCard.prefixLabel')" autocomplete="off" @update:model-value="d.prefix = $event" />
      <MdCheckbox
        :model-value="!!d.forcePathStyle" :disabled="busy" :label="t('cloudCard.forcePathStyleLabel')"
        :aria-label="t('cloudCard.forcePathStyleLabel')" @update:model-value="d.forcePathStyle = $event"
      />
    </div>
    <div v-else-if="isGistDraft(d)" class="fields">
      <MdTextField v-model="d.token" type="password" label="GitHub Token" placeholder="GitHub Token" autocomplete="new-password" />
      <MdTextField v-model="d.gistId" label="Gist ID" placeholder="Gist ID" autocomplete="off" />
      <MdCheckbox
        :model-value="!!d.public" :disabled="busy" :label="t('cloudCard.gistPublicLabel')"
        :aria-label="t('cloudCard.gistPublicLabel')" @update:model-value="d.public = $event"
      />
      <p v-if="d.public" class="warn" role="alert">{{ t('cloudCard.gistPublicWarn') }}</p>
    </div>
    <div v-else-if="isOAuthCapableDraft(d)" class="fields">
      <MdSegmentedButton
        class="auth-mode" :options="AUTH_MODE_OPTIONS"
        :model-value="d.oauth ? 'oauth' : 'manual'" :aria-label="t('cloudCard.oauthModeAria')"
        @update:model-value="onAuthMode(d, $event)"
      />
      <template v-if="d.oauth">
        <MdTextField :model-value="d.oauth.clientId" :label="t('cloudCard.oauthClientIdLabel')" :placeholder="t('cloudCard.oauthClientIdLabel')" autocomplete="off" @update:model-value="setOauthField(d, 'clientId', $event)" />
        <MdTextField :model-value="d.oauth.clientSecret" type="password" :label="t('cloudCard.oauthClientSecretLabel')" :placeholder="t('cloudCard.oauthClientSecretLabel')" autocomplete="new-password" @update:model-value="setOauthField(d, 'clientSecret', $event)" />
        <MdTextField :model-value="d.oauth.refreshToken" type="password" :label="t('cloudCard.oauthRefreshTokenLabel')" :placeholder="t('cloudCard.oauthRefreshTokenLabel')" autocomplete="new-password" @update:model-value="setOauthField(d, 'refreshToken', $event)" />
        <p class="hint">{{ t('cloudCard.oauthHint') }}</p>
      </template>
      <!-- 手工 token 的 label/placeholder 是 gdrive/onedrive 两段唯一文案差异，按 backend 三元取键 -->
      <MdTextField v-else v-model="d.accessToken" type="password"
        :label="d.backend === 'gdrive' ? t('cloudCard.gdriveTokenLabel') : t('cloudCard.onedriveTokenLabel')"
        :placeholder="d.backend === 'gdrive' ? t('cloudCard.gdriveTokenLabel') : t('cloudCard.onedriveTokenLabel')"
        autocomplete="new-password"
      />
    </div>
    <!-- v-if="d" 兼作类型窄化：v-for 单元素 d 在守卫链外无 undefined 窄化，vue-tsc 会报 TS18048 -->
    <MdTextField v-if="d" :model-value="d.objectPath ?? ''" :label="objectPathLabel" :placeholder="DEFAULT_OBJECT_PATH" :aria-label="objectPathLabel" :disabled="busy" @update:model-value="d.objectPath = $event.trim()" />
    <!-- 目标路径实时预览（bounded ②）：与上传链同语义（keep 仅目录生效、文件名自动生成） -->
    <template v-if="d && pathPreview">
      <p v-if="pathPreview.state === 'ok'" class="hint path-preview">{{ pathPreviewText }}</p>
      <p v-else class="warn path-preview" role="alert">{{ t('cloudCard.pathPreviewInvalid') }}</p>
      <p v-if="keepIgnoreWarn" class="warn" role="alert">{{ t(keepIgnoreWarn.key, keepIgnoreWarn.params) }}</p>
      <p v-if="pathPreview.state === 'ok' && (d.backend === 'gdrive' || d.backend === 'gist')" class="hint">{{ t('cloudCard.pathPreviewFlatHint') }}</p>
    </template>
    <!-- ③ 每源网络代理：桌面 reqwest 生效；扩展端不渲染控件（浏览器无法 per-request 代理），提示走浏览器/系统代理 -->
    <template v-if="d && proxySupport">
      <MdSegmentedButton
        class="proxy-mode" :options="PROXY_MODE_OPTIONS" :model-value="d.proxy?.mode ?? 'none'"
        :aria-label="t('cloudCard.proxyModeAria')" @update:model-value="onProxyMode(d, $event)"
      />
      <MdTextField
        v-if="d.proxy?.mode === 'custom'" :model-value="d.proxy.url ?? ''" :label="t('cloudCard.proxyUrlLabel')"
        :placeholder="t('cloudCard.proxyUrlPlaceholder')" :aria-label="t('cloudCard.proxyUrlLabel')" autocomplete="off"
        @update:model-value="onProxyUrl(d, $event)"
      />
      <p v-if="proxyUrlError" class="warn proxy-url-error" role="alert">
        {{ proxyUrlError === 'empty' ? t('cloudCard.proxyUrlEmpty') : t('cloudCard.proxyUrlInvalid') }}
      </p>
    </template>
    <p v-if="d && !proxySupport" class="hint">{{ t('cloudCard.proxyUnsupportedHint') }}</p>
  </template>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供；本组件只负责凭据字段区排版（样式随模板自 CloudCard 迁入） */
.fields { display: flex; flex-direction: column; gap: 6px; }
.hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.warn { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
