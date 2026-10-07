import { createApp } from 'vue'
import '@totp/ui/src/theme/tokens.css'
import MiniApp from './MiniApp.vue'
import { installDragDropGuard } from './dragDropGuard'

// R2-I1：mini 未禁用 drag-drop handler（挂载为无害 no-op），与主窗保持兜底一致
installDragDropGuard()

// spec §2.2：mount 后运行期异常兜底留痕（永久白屏主嫌疑区）。静态 import 先于本模块体
// 求值执行，import 链上模块求值期异常发生时这些监听尚未注册，由 devtools console 另行可见；
// 本处监听实际仅覆盖 mount 起的运行期
window.addEventListener('error', (e) => console.error('[mini] window error:', e.error ?? e.message, e.filename, e.lineno))
window.addEventListener('unhandledrejection', (e) => console.error('[mini] unhandled rejection:', e.reason))

createApp(MiniApp).mount('#app')
