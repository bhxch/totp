/**
 * offscreen document：持有 CLIPBOARD reason 授权，在无用户手势/无焦点环境下操作剪贴板。
 * background 的 clipboard-clear alarm 到点后发 {type:'clear-clipboard'}，此处写入空串清空验证码。
 */
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'clear-clipboard') return
  void clearClipboard()
})
