import { createApp } from 'vue'
import '@totp/ui/src/theme/tokens.css'
import MiniApp from './MiniApp.vue'

// spec §2.2：模块求值/挂载期异常此前完全不可见（永久白屏主嫌疑区）——顶层兜底留痕
window.addEventListener('error', (e) => console.error('[mini] window error:', e.error ?? e.message, e.filename, e.lineno))
window.addEventListener('unhandledrejection', (e) => console.error('[mini] unhandled rejection:', e.reason))

createApp(MiniApp).mount('#app')
