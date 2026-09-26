<script setup lang="ts">
import type { CloudCred, GDriveCred, OneDriveCred } from '@totp/core'
import { DEFAULT_OBJECT_PATH } from '@totp/core'
import { useI18n } from 'vue-i18n'
import { hasPlaintextUrl, isGistDraft, isOAuthCapableDraft, isOneDriveDraft, isS3Draft, isWebdavDraft } from './cardShared'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 单源凭据编辑副本（父级 credDrafts 的浅拷贝：嵌套字段就地编辑=编辑副本语义，草稿与已存凭据
   *  共享的嵌套对象由父级写时复制断开；draft 整体替换由父级负责，本组件不整换引用） */
  draft: CloudCred | undefined
  /** 全卡忙碌态：objectPath 等输入随 busy 禁用 */
  busy: boolean
}>()

const { t } = useI18n()

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
    <MdTextField v-if="d" :model-value="d.objectPath ?? ''" :label="t('cloudCard.objectPathLabel')" :placeholder="DEFAULT_OBJECT_PATH" :aria-label="t('cloudCard.objectPathLabel')" :disabled="busy" @update:model-value="d.objectPath = $event.trim()" />
  </template>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供；本组件只负责凭据字段区排版（样式随模板自 CloudCard 迁入） */
.fields { display: flex; flex-direction: column; gap: 6px; }
.hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.warn { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
