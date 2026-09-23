/**
 * offscreen document：持有 CLIPBOARD reason 授权，在无用户手势/无焦点环境下操作剪贴板。
 * background 的 clipboard-clear alarm 到点后发 {type:'clear-clipboard'}，此处写入空串清空验证码，
 * 完成后发 {type:'clear-clipboard-ack'} 回执——背景脚本据此判定本次清空是否真正落地（SW 重启/offscreen 未就绪时重试）。
 */
import { ext } from '../../src/extApi'

async function clearClipboard(): Promise<void> {
  try {
    await navigator.clipboard.writeText('')
  } catch {
    // offscreen document 通常无焦点，async Clipboard API 可能被拒：execCommand('copy') 兜底（Chrome 官方 offscreen 剪贴板做法）
    const el = document.createElement('textarea')
    el.value = ''
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    el.remove()
  }
}

ext!.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clear-clipboard') return
  void clearClipboard().then(() => {
    // sendResponse 回执——SW 端 ack 监听器据此判定成功
    try { sendResponse({ ok: true }) } catch { /* channel 已关：忽略 */ }
    // 同时发 fire-and-forget 消息，让 SW 在 sendResponse 不可用时也能感知
    try { ext!.runtime.sendMessage({ type: 'clear-clipboard-ack' }) } catch { /* 忽略 */ }
  })
  // 返回 true 保留 sendResponse 通道（异步回执用）
  return true
})
