# TOTP 工具 M1-计划3：Tauri 桌面壳 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Tauri 2 桌面程序：主窗口（全功能管理界面，复用 ui 包）+ 托盘常驻弹出小窗（迷你列表）+ 全局快捷键 Alt+Shift+T + 小窗失焦自动隐藏，数据存应用数据目录 `vault.json`。

**Architecture:** 先把 extension 的 store 逻辑泛化为 ui 包的 `createVueStore(adapter)`（可单测），再把 options 页提炼为 ui 包 `VaultManager` 组件（extension options 与桌面主窗口共用），最后搭 Tauri 壳：Rust 端负责托盘/快捷键/窗口行为，前端负责界面，数据经 `StorageAdapter`（plugin-fs 实现）落盘 AppData。

**Tech Stack:** Tauri 2（Rust 1.98 已就绪）、@tauri-apps/api v2、plugin-fs/global-shortcut/clipboard-manager、Vue 3.5 复用。前端零新增第三方依赖；Rust 依赖 tauri 2 + 三个官方插件。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 11 节桌面形态；autostart 列 backlog 本计划不做）

## Global Constraints

- 沿用全部既有约束（TS strict、core 零第三方运行时依赖、TDD、Angular commit、中文 UI）
- 桌面 StorageAdapter 的 key 与 extension 语义一致：`vault`、`settings` 两键，值均为 JSON 字符串
- Rust 端窗口行为：**仅小窗**（label `mini`）失焦即隐藏；主窗口由前端 settings 开关控制
- 全局快捷键固定 `Alt+Shift+T`（「可改」的设置 UI 属后续计划）
- 权限最小：capabilities 仅授予所需插件权限点；Windows 主平台，`tauri build` 必须成功并产出安装包
- 涉及 wxt/tauri 配置的任务，**必须核对构建产物**（计划 2 教训：manifest 缺权限静默失效）

---

### Task 1: createVueStore 泛化到 ui 包（TDD）+ extension 迁移

**Files:**
- Create: `packages/ui/src/store.ts`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/extension/src/store.ts`（改为薄封装，导出面不变）
- Test: `packages/ui/test/store.test.ts`

**Interfaces:**
- Produces: `createVueStore(adapter: StorageAdapter, opts?: { registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean }) => void) => void })`，返回单例对象：
  ```ts
  {
    vault: Vault                // reactive
    settings: AppSettings       // reactive
    initStore(): Promise<void>  // 幂等
    registerStorageSync(): void // 用 opts.registerSync 挂回调；未提供则 no-op
    commit(fn: (v: Vault) => Vault): Promise<void>        // 串行队列+直写落盘+console.error 兜底
    commitSettings(): Promise<void>                        // 同上
    addEntryOp / updateEntryOp / removeEntryOp / addGroupOp / renameGroupOp / removeGroupOp  // 同 extension 现签名
  }
  ```
- 自写抑制与跨页同步逻辑从 extension/store.ts 原样搬移（`lastSelfWrite = { vault: 0, settings: 0 }` 按 key 分离、500ms 窗口），`registerSync` 回调通知哪些 key 变更（vault/settings），store 内部据通知重读对应 key
- extension `store.ts` 改为：`const s = createVueStore(createChromeStorage(), { registerSync: (cb) => chrome.storage.onChanged.addListener((changes, area) => { if (area !== 'local') return; cb({ vault: !!changes['vault'], settings: !!changes['settings'] }) }) }); export const { vault, settings, ... } = s`——popup/options 零改动

- [ ] **Step 1: 写失败测试**

`packages/ui/test/store.test.ts`（jsdom 环境，内存 adapter + 手动触发 sync 回调）:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../src/store'
import { newEntryFromUri } from '@totp/core'

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }

describe('createVueStore', () => {
  it('initStore 后 vault/settings 从 adapter 加载；重复调用幂等', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 5 }))
    const s = createVueStore(adapter)
    await s.initStore()
    expect(s.vault.updatedAt).toBe(5)
    await s.initStore() // 幂等：不重复加载
    expect(s.vault.updatedAt).toBe(5)
  })

  it('commit 后落盘完成（await 即持久）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    const raw = await adapter.get('vault')
    expect(JSON.parse(raw!).entries).toHaveLength(1)
  })

  it('串行队列保持顺序；落盘失败不吞队列', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    const order: string[] = []
    const p1 = s.commit((v) => { order.push('a'); return { ...v, updatedAt: 1 } })
    const p2 = s.commit((v) => { order.push('b'); return { ...v, updatedAt: 2 } })
    await Promise.all([p1, p2])
    expect(order).toEqual(['a', 'b'])
    expect(s.vault.updatedAt).toBe(2)
  })

  it('registerStorageSync：非自写通知触发重读；自写窗口内跳过', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await s.initStore()
    s.registerStorageSync()
    // 对端写入
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [{ uuid: 'x' }], groups: [], updatedAt: 9 }))
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(9)
    // 自写后 500ms 内对端通知被抑制
    await s.commitSettings()
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(9) // 未被吞掉的抑制不应改变——本轮自写是 settings，vault 窗口未开
    // 自写 vault 后窗口内抑制
    await s.commit((v) => ({ ...v, updatedAt: 10 }))
    await adapter.set('vault', JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 11 }))
    notify!({ vault: true })
    await flush()
    expect(s.vault.updatedAt).toBe(10) // 500ms 内抑制了对端值
  })

  it('settings 同步：对端写入重读，未知字段丢弃', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const s = createVueStore(adapter, { registerSync: (cb) => { notify = cb } })
    await s.initStore()
    s.registerStorageSync()
    await adapter.set('settings', JSON.stringify({ urlFilterEnabled: false }))
    notify!({ settings: true })
    await flush()
    expect(s.settings.urlFilterEnabled).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败 → 实现 → 通过**

`packages/ui/src/store.ts`（从 `apps/extension/src/store.ts` 搬移改造，核心差异：adapter 参数化、chrome 依赖移除、registerSync 回调注入、同步通知→按 key 重读）:
```ts
import {
  DEFAULT_SETTINGS, addEntry, addGroup, loadSettings, loadVault, removeEntry, removeGroup,
  renameGroup, saveSettings, saveVault, updateEntry,
  type AppSettings, type OtpEntry, type StorageAdapter, type Vault,
} from '@totp/core'
import { reactive, toRaw } from 'vue'

export interface VueStore { /* 见 Interfaces 签名 */ }

export function createVueStore(
  adapter: StorageAdapter,
  opts: { registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean }) => void) => void } = {},
) {
  const vault = reactive<Vault>({ version: 1, entries: [], groups: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0 }
  let queue: Promise<void> = Promise.resolve()

  function replaceVault(v: Vault): void {
    vault.version = v.version
    vault.updatedAt = v.updatedAt
    vault.entries.splice(0, vault.entries.length, ...v.entries)
    vault.groups.splice(0, vault.groups.length, ...v.groups)
  }

  async function initStore(): Promise<void> {
    if (inited) return
    const [v, s] = await Promise.all([loadVault(adapter), loadSettings(adapter)])
    replaceVault(v)
    Object.assign(settings, s)
    inited = true
  }

  async function commit(fn: (v: Vault) => Vault): Promise<void> {
    queue = queue.then(async () => {
      replaceVault(fn(vault))
      try {
        lastSelfWrite.vault = Date.now()
        await saveVault(adapter, toRaw(vault) as Vault)
      } catch (e) {
        console.error('[store] saveVault failed:', e)
      }
    })
    return queue
  }

  async function commitSettings(): Promise<void> {
    queue = queue.then(async () => {
      try {
        lastSelfWrite.settings = Date.now()
        await saveSettings(adapter, toRaw(settings) as AppSettings)
      } catch (e) {
        console.error('[store] saveSettings failed:', e)
      }
    })
    return queue
  }

  function registerStorageSync(): void {
    opts.registerSync?.((payload) => {
      if (payload.vault && Date.now() - lastSelfWrite.vault >= 500) {
        loadVault(adapter).then(replaceVault).catch(() => {})
      }
      if (payload.settings && Date.now() - lastSelfWrite.settings >= 500) {
        loadSettings(adapter).then((s) => Object.assign(settings, s)).catch(() => {})
      }
    })
  }

  return {
    vault, settings, initStore, registerStorageSync, commit, commitSettings,
    addEntryOp: (entry: OtpEntry) => commit((v) => addEntry(v, entry)),
    updateEntryOp: (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch)),
    removeEntryOp: (uuid: string) => commit((v) => removeEntry(v, uuid)),
    addGroupOp: (name: string) => commit((v) => addGroup(v, name)),
    renameGroupOp: (id: string, name: string) => commit((v) => renameGroup(v, id, name)),
    removeGroupOp: (id: string) => commit((v) => removeGroup(v, id)),
  }
}

export type VueStore = ReturnType<typeof createVueStore>
```

`packages/ui/src/index.ts` 追加 `export * from './store'`。

`apps/extension/src/store.ts` 重写为薄封装（导出面不变：vault/settings/initStore/registerStorageSync/commit/commitSettings/六个 op）:
```ts
import { createVueStore } from '@totp/ui'
import { createChromeStorage } from './chromeStorage'

const store = createVueStore(createChromeStorage(), {
  registerSync: (cb) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      cb({ vault: !!changes['vault'], settings: !!changes['settings'] })
    }),
})

export const { vault, settings, initStore, registerStorageSync, commit, commitSettings } = store
export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addGroupOp = store.addGroupOp
export const renameGroupOp = store.renameGroupOp
export const removeGroupOp = store.removeGroupOp
```

- [ ] **Step 3: 全仓验证**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build`
Expected: 全绿（ui 新增 5 用例）

- [ ] **Step 4: Commit**

```bash
git add packages/ui/ apps/extension/ pnpm-lock.yaml
git commit -m "refactor(ui): createVueStore泛化store并配单测，extension改薄封装"
```

---

### Task 2: VaultManager 组件提炼（TDD）+ options 迁移

**Files:**
- Create: `packages/ui/src/components/VaultManager.vue`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/extension/entrypoints/options/App.vue`（改薄壳）
- Test: `packages/ui/test/VaultManager.test.ts`

**Interfaces:**
- Produces: `VaultManager.vue` props `{ store: VueStore; enableCopy?: boolean }`——内含分组管理卡、条目管理卡（搜索框/EntryForm/OtpListItem 列表/编辑删除二次确认），逻辑从 options App.vue 提炼；`enableCopy` 为 true 时点击条目复制验证码（桌面主窗口用），false 时列表项仅展示（extension options 现状）
- options App.vue 改为：
  ```vue
  <script setup lang="ts">
  import { VaultManager } from '@totp/ui'
  import { onMounted } from 'vue'
  import { initStore, registerStorageSync, store } from '../../src/store'
  onMounted(async () => { await initStore(); registerStorageSync() })
  </script>
  <template><main class="page"><h1>TOTP 验证码工具</h1><VaultManager :store="store" /></main></template>
  ```
  （extension store 薄封装需导出 `store` 本体；标题与页宽样式留在壳里）

- [ ] **Step 1: 写失败测试**

`packages/ui/test/VaultManager.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../src/store'
import VaultManager from '../src/components/VaultManager.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  return s
}

describe('VaultManager', () => {
  it('渲染条目与搜索过滤', async () => {
    const s = await readyStore()
    const w = mount(VaultManager, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('不存在')
    expect(w.text()).not.toContain('GitHub')
  })

  it('enableCopy=false 时不调用剪贴板；分组卡显示空态', async () => {
    const s = await readyStore()
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(VaultManager, { props: { store: s } })
    await (w.find('.otp-item').trigger('click'))
    expect(writeText).not.toHaveBeenCalled()
    expect(w.text()).toContain('暂无分组')
  })
})
```

- [ ] **Step 2: 实现（提炼 options App.vue 现有逻辑，行为等价）→ 通过 → 迁移 options 壳**

实现要点（从 `apps/extension/entrypoints/options/App.vue` 原样搬移组件内部逻辑）：
- useOtpCodes 参数 `computed(() => [...props.store.vault.entries])`；sorted/visible 同现状（无 URL 过滤）
- onSave/askRemove/addGroup/renaming 状态机原样；`store.` 前缀访问 ops
- `enableCopy` 默认 false；true 时 OtpListItem `@copy` → `navigator.clipboard.writeText(code)`（不关窗口——桌面语义；复制无副作用代码路径与 extension 不同，此处仅实现）
- 全部样式 scoped 随组件走；options 壳只留页面标题/布局

Run: `pnpm --filter @totp/ui test`（7 用例）→ `pnpm -r run typecheck && pnpm --filter @totp/extension build`（options 壳迁移后产物正常）

- [ ] **Step 3: Commit**

```bash
git add packages/ui/ apps/extension/ pnpm-lock.yaml
git commit -m "refactor(ui): 提炼VaultManager共享管理组件，options改薄壳"
```

---

### Task 3: apps/desktop Tauri 2 脚手架 + 主窗口 + fs adapter

**Files:**
- Create: `apps/desktop/package.json`、`apps/desktop/vite.config.ts`、`apps/desktop/tsconfig.json`、`apps/desktop/index.html`、`apps/desktop/src/main.ts`、`apps/desktop/src/App.vue`、`apps/desktop/src/tauriFs.ts`
- Create: `apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/build.rs`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/src-tauri/src/main.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src-tauri/icons/`（占位图标集）
- Modify: 根 `.gitignore`（追加 `apps/desktop/src-tauri/target/` 与 `apps/desktop/dist/`——若已有通配则确认）

**Interfaces:**
- Consumes: `createVueStore`（Task 1）、`VaultManager`（Task 2）、core `StorageAdapter`
- Produces:
  - `tauriFs.ts`: `createTauriFs(): Promise<StorageAdapter>`（`readTextFile`/`writeTextFile`/`remove` + `BaseDirectory.AppData`；首次访问 `ensureDir('', { baseDir: AppData })`；`get` 文件不存在返回 null）
  - 主窗口 App.vue：`const store = createVueStore(await createTauriFs())` → `await initStore()` → `<VaultManager :store="store" enable-copy />`（顶部标题栏含「隐藏到托盘」按钮 → `getCurrentWindow().hide()`）
  - Rust `lib.rs`（本任务最小版）：`tauri::Builder` + `plugin_fs` + `plugin_clipboard_manager` + `manage` 无自定义命令；窗口 label `main`
  - `tauri.conf.json`：productName `TOTP 验证码工具`、identifier `com.totp.desktop`、frontendDist `../dist`、devUrl `http://localhost:1420`、主窗口 760×560、bundle targets `["nsis"]`

- [ ] **Step 1: 前端文件**

`apps/desktop/package.json`:
```json
{
  "name": "@totp/desktop",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "test": "echo 'no unit tests (ui/store covered by ui pkg)' && exit 0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-clipboard-manager": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0",
    "@totp/core": "workspace:*",
    "@totp/ui": "workspace:*",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vite-plugin-vue": "npm:@vitejs/plugin-vue@^5.1.0",
    "vue-tsc": "^2.1.0"
  }
}
```

`apps/desktop/vite.config.ts`:
```ts
import vue from 'vite-plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'chrome105', outDir: 'dist' },
})
```

`apps/desktop/index.html`、`src/main.ts` 同 extension popup 模式（`createApp(App).mount('#app')`）。

`apps/desktop/src/tauriFs.ts`:
```ts
import { ensureDir, exists, readTextFile, remove, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { StorageAdapter } from '@totp/core'

const file = (key: string) => `${key}.json`

export async function createTauriFs(): Promise<StorageAdapter> {
  await ensureDir('', { baseDir: BaseDirectory.AppData, recursive: true })
  return {
    async get(key) {
      if (!(await exists(file(key), { baseDir: BaseDirectory.AppData }))) return null
      return readTextFile(file(key), { baseDir: BaseDirectory.AppData })
    },
    async set(key, value) {
      await writeTextFile(file(key), value, { baseDir: BaseDirectory.AppData })
    },
    async delete(key) {
      if (await exists(file(key), { baseDir: BaseDirectory.AppData })) await remove(file(key), { baseDir: BaseDirectory.AppData })
    },
  }
}
```

`apps/desktop/src/App.vue`:
```vue
<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { VaultManager, createVueStore, type VueStore } from '@totp/ui'
import { onMounted, ref } from 'vue'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
const loadError = ref('')

onMounted(async () => {
  try {
    const s = createVueStore(await createTauriFs())
    await s.initStore()
    store.value = s
  } catch (e) {
    loadError.value = '本地数据初始化失败：' + (e instanceof Error ? e.message : String(e))
  }
})

async function copyToClipboard(code: string) {
  await writeText(code)
}
</script>

<template>
  <main class="page">
    <header>
      <h1>TOTP 验证码工具</h1>
      <button @click="getCurrentWindow().hide()">隐藏到托盘</button>
    </header>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <VaultManager v-else-if="store" :store="store" enable-copy @copy="copyToClipboard" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.page { max-width: 720px; margin: 0 auto; padding: 16px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h1 { font-size: 20px; margin: 0; }
.error { color: #d9534f; }
</style>
```
（VaultManager 需新增 emits `copy: [code: string]`——enableCopy 时点击条目 emit 而非直接写 navigator.clipboard，剪贴板实现交给宿主：extension popup 用 navigator，desktop 用插件。Task 2 实现时即按此签名：`enableCopy` + `emit('copy', code)`，extension options 不接 copy 即零影响。本任务若 Task 2 未含 emit，在此补齐并回归 ui 测试。）

- [ ] **Step 2: Rust 壳文件**

`apps/desktop/src-tauri/Cargo.toml`:
```toml
[package]
name = "totp-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "totp_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-clipboard-manager = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`apps/desktop/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`apps/desktop/src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    totp_desktop_lib::run()
}
```

`apps/desktop/src-tauri/src/lib.rs`（Task 3 最小版，托盘/快捷键 Task 4 加）:
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`apps/desktop/src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "TOTP 验证码工具",
  "version": "0.1.0",
  "identifier": "com.totp.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      { "label": "main", "title": "TOTP 验证码工具", "width": 760, "height": 560, "visible": true }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"]
  }
}
```

`apps/desktop/src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main", "mini"],
  "permissions": [
    "core:default",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "fs:allow-appdata-read-recursive",
    "fs:allow-appdata-write-recursive",
    "fs:allow-appdata-exists-recursive",
    "fs:allow-appdata-mkdir-recursive",
    "fs:allow-appdata-remove-recursive",
    "clipboard-manager:allow-write-text"
  ]
}
```

占位图标（PowerShell System.Drawing 生成纯色 PNG 与 ICO）：
```powershell
Add-Type -AssemblyName System.Drawing
$dir = "apps/desktop/src-tauri/icons"
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($size in 32, 128) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(74, 144, 217))
  $g.Dispose()
  $bmp.Save("$dir/$($size)x$($size).png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
# icon.ico：用 32x32 png 转 ico（Tauri 接受 png 内容的 .ico 会有兼容风险——改用 Icon.FromHandle）
$bmp = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(74, 144, 217)); $g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create("$dir/icon.ico")
$icon.Save($fs); $fs.Dispose()
$bmp.Dispose()
```

- [ ] **Step 3: 构建验证（产物核对）**

Run: `pnpm install && pnpm --filter @totp/desktop typecheck && pnpm --filter @totp/desktop tauri build`
Expected: 构建成功（首次 cargo 编译耗时较长），`src-tauri/target/release/` 产出 exe 与 `bundle/nsis` 安装包；`tauri.conf.json` 的窗口/bundle 配置与产物一致

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/ .gitignore pnpm-lock.yaml
git commit -m "feat(desktop): Tauri2壳+主窗口(VaultManager)+AppData存储适配"
```

---

### Task 4: 托盘常驻 + 弹出小窗 + 全局快捷键 + 失焦自动隐藏

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（+`tauri-plugin-global-shortcut = "2"`）
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`（windows 数组追加 mini 窗口；`app.trayIcon` 由 Rust 构建无需配置）
- Modify: `apps/desktop/src-tauri/capabilities/default.json`（确认 mini 窗口已列）
- Create: `apps/desktop/src/mini.html`、`apps/desktop/src/mini.ts`、`apps/desktop/src/MiniApp.vue`（迷你列表：store 复用同一 fs adapter——每窗口独立 Vue app；小窗列表只读+点击复制，无管理功能）

**Interfaces:**
- mini 窗口（label `mini`）：320×420、`visible: false`、`skipTaskbar: true`、复用 tauri.conf `app.windows` 静态声明；MiniApp.vue：`createVueStore(await createTauriFs())` → initStore → 条目列表（OtpListItem 直排 + 倒计时）点击复制（clipboard 插件）→ 窗口自动隐藏（复制后 500ms `getCurrentWindow().hide()`）
- lib.rs：
  - `setup`：构建托盘（TrayIconBuilder，icon 用 app default icon，tooltip 产品名）——`on_tray_icon_event` 左键 click → toggle mini 窗口（visible ? hide+恢复焦点逻辑 : show+set_focus）；`on_menu_event` 无菜单（纯图标）；托盘右键菜单最小化不做（backlog）
  - `plugin(tauri_plugin_global_shortcut::init())` + `register("Alt+Shift+T")` → 同 toggle mini
  - `on_window_event`：`WindowEvent::Focused(false)` 且 `window.label() == "mini"` → `window.hide()`
- 主窗口失焦由前端控制：App.vue 中 `watch(() => settings.blurHideEnabled)`（settings 扩展字段见下）+ `getCurrentWindow().onFocusChanged`；关闭逻辑
- core `AppSettings` 扩展：`blurHideEnabled?: boolean`（默认 false，主窗口失焦隐藏开关）——`packages/core/src/storage/vaultStore.ts` 的 loadSettings 增加 `blurHideEnabled: typeof parsed.blurHideEnabled === 'boolean' ? parsed.blurHideEnabled : false`，补一条 settings 测试；`DEFAULT_SETTINGS` 不含该键则显式默认 false——**追加到 DEFAULT_SETTINGS 并同步 ui/store 测试若受影响**
- 主窗口设置区：App.vue header 加 checkbox「失焦自动隐藏」→ `settings.blurHideEnabled = checked; await commitSettings()`

- [ ] **Step 1: core settings 扩展（TDD）**

`packages/core/test/settings.test.ts` 追加:
```ts
it('blurHideEnabled 缺省 false；非法类型回退 false', async () => {
  const s = createMemoryStorage()
  expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false })
  await s.set(SETTINGS_KEY, JSON.stringify({ blurHideEnabled: 'yes' }))
  expect((await loadSettings(s)).blurHideEnabled).toBe(false)
})
```
实现 `vaultStore.ts`：`DEFAULT_SETTINGS = { urlFilterEnabled: true, blurHideEnabled: false }`（类型 `blurHideEnabled: boolean`），loadSettings 同款 typeof 收紧。Run core 测试（含既有用例快照核对——`toEqual({ urlFilterEnabled: true })` 类断言若存在需同步更新为含 blurHideEnabled: false；注意 store.test 若断言 settings 形状需一并修）。

- [ ] **Step 2: mini 窗口前端**

`apps/desktop/src/mini.html` + `mini.ts`（createApp(MiniApp).mount）+ `MiniApp.vue`：
```vue
<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { OtpListItem, createVueStore, type VueStore } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
onMounted(async () => {
  const s = createVueStore(await createTauriFs())
  await s.initStore()
  store.value = s
})
const sorted = computed(() => (store.value ? [...store.value.vault.entries].sort((a, b) => a.order - b.order) : []))
const { codes } = useOtpCodes(sorted)

async function copy(entry: { uuid: string }) {
  const code = codes.value.get(entry.uuid)?.code
  if (!code) return
  await writeText(code)
  setTimeout(() => void getCurrentWindow().hide(), 500)
}
</script>

<template>
  <main class="mini">
    <div v-if="!store || sorted.length === 0" class="empty">暂无条目</div>
    <OtpListItem v-for="e in sorted" :key="e.uuid" :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.mini { display: flex; flex-direction: column; gap: 2px; padding: 6px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; font-size: 13px; }
</style>
```
（`useOtpCodes` 从 '@totp/ui' 导入——补进 import 行；vite 多入口：`build.rollupOptions.input` 配 `{ main: 'index.html', mini: 'mini.html' }`；tauri.conf windows 数组追加 `{ "label": "mini", "title": "TOTP", "width": 320, "height": 420, "visible": false, "skipTaskbar": true, "url": "mini.html" }`）

- [ ] **Step 3: Rust 托盘/快捷键/失焦**

`apps/desktop/src-tauri/src/lib.rs`:
```rust
use tauri::{
    AppHandle, Manager, TrayIconBuilder, tray::TrayIconEvent, window::WindowEvent,
};

fn toggle_mini(app: &AppHandle) {
    if let Some(mini) = app.get_webview_window("mini") {
        if mini.is_visible().unwrap_or(false) {
            let _ = mini.hide();
        } else {
            let _ = mini.show();
            let _ = mini.set_focus();
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+shift+t"])
                .unwrap()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_mini(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TOTP 验证码工具")
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        toggle_mini(_tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(false) = event {
                if window.label() == "mini" {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
Cargo.toml 依赖追加 `tauri-plugin-global-shortcut = "2"`。

- [ ] **Step 4: 主窗口失焦开关（App.vue）**

```ts
import { watch } from 'vue'
// store 就绪后：
watch(
  () => store.value?.settings.blurHideEnabled,
  (on) => {
    const win = getCurrentWindow()
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (!focused && store.value?.settings.blurHideEnabled && win.label === 'main') void win.hide()
    })
    void unlisten
    // 简化：每次 watch 触发注册新监听会叠加——实现时用单次注册 + 条件判断（推荐：onMounted 注册一次 onFocusChanged，回调内检查 blurHideEnabled），watch 仅用于触发提示
  },
)
```
（实现要求：onFocusChanged 在 onMounted 注册**一次**，回调内实时读取 `store.value?.settings.blurHideEnabled`；勿叠加监听。checkbox 写回 `settings.blurHideEnabled = x; await commitSettings()`。）

- [ ] **Step 5: 构建验证（产物核对）**

Run: `pnpm --filter @totp/desktop typecheck && pnpm test && pnpm --filter @totp/desktop tauri build`
Expected: 全绿；产物含 exe + nsis 安装包；手工冒烟项记录到报告（托盘左键弹出小窗、Alt+Shift+T 唤出、小窗失焦隐藏、复制后小窗关闭、主窗口开关生效）——真机验证留用户

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ packages/core/ packages/ui/ pnpm-lock.yaml
git commit -m "feat(desktop): 托盘常驻+mini弹出窗+全局快捷键+失焦自动隐藏"
```

---

### Task 5: 桌面回归 + README

**Files:**
- Modify: `README.md`（补桌面版段落：开发命令 `pnpm --filter @totp/desktop tauri dev`、构建 `tauri build`、数据位置 `%APPDATA%/com.totp.desktop/`）

- [ ] **Step 1: 全仓回归**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop build`
Expected: 全绿（core 81、ui 12 前后）

- [ ] **Step 2: README + Commit**

```bash
git add README.md
git commit -m "docs: README补充桌面版开发与数据位置说明"
```
