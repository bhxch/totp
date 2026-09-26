/**
 * settings.json Rust 外来键共享 fixture（P4：消除 tauriFs.test.ts 与 tauriFsSettings.test.ts
 * 的重复样本，P3b 遗留项）：Rust 侧（lib.rs/mcp_server.rs）与前端 AppSettings 同写
 * AppData/settings.json，adapter.set('settings') 的合并写必须保留以下四组外来键。
 */

/** Rust 侧写入的外来配置（四组键的代表性样本） */
export const rustKeys = {
  shortcutToggleMini: 'alt+shift+t',
  devtools: { enabled: true, port: 9222 },
  releasePolicy: { pauseMinutes: 10, destroyMinutes: 30, lockOnPause: true, lockOnDestroy: false },
  mcp: { enabled: true, mode: 'wildcard', port: 47215, token: 'x', whitelist: [], exposedTools: [] },
} as const

/** 模拟前端 saveSettings 的 JSON.stringify(AppSettings) 新值 */
export const appSettingsJson = JSON.stringify({ theme: 'dark', locale: 'zh', lockOnSystemLock: true })
