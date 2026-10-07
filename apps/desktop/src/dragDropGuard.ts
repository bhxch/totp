/**
 * 双窗口 HTML5 drop 默认导航兜底（R2-I1）：
 * c801b6c 在 lib.rs 对主窗禁用 drag_drop_handler 后，wry 0.55.1 既不注册替代 IDropTarget、
 * 也不调 WebView2 SetAllowExternalDrop(false)——系统默认拖放行为保留，文件拖入窗口时落在
 * 未被前端 preventDefault 的区域会触发 WebView2 默认导航（跳 file:// 替换 SPA，路由丢失、
 * 解锁会话失效）。本模块在窗口入口最早期挂全局 dragover/drop preventDefault 兜底：
 * - 元素级 drop 处理（如 BatchPastePanel 粘贴区图片投放）先于 window 冒泡触发，不受影响；
 *   preventDefault 幂等，与元素级调用叠加无害；
 * - 全局兜底只吞默认导航，不拦截事件本身，元素级监听器照常收到事件。
 * mini 窗未禁用 drag-drop handler（wry 默认 IDropTarget 在位，HTML5 DnD 事件本就被吞），
 * 挂载为 no-op 级无害，保持双窗一致以防未来对齐 lib.rs 行为时漏兜底。
 */
export function installDragDropGuard(w: Window = window): () => void {
  const dragover = (e: DragEvent): void => e.preventDefault()
  const drop = (e: DragEvent): void => e.preventDefault()
  w.addEventListener('dragover', dragover)
  w.addEventListener('drop', drop)
  return () => {
    w.removeEventListener('dragover', dragover)
    w.removeEventListener('drop', drop)
  }
}
