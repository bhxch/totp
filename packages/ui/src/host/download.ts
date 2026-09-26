/**
 * Blob 下载通道(R4 自 extension options App.vue 收敛):downloadEnvelope/saveTextFile/
 * saveImageFile 三处同构 a[download] 装配——createObjectURL → click → 延时 revoke。
 * revokeDelayMs 缺省 10s(文本/图片导出口径);备份 envelope 原口径 1s 由调用方显式传。
 * 浏览器下载无「取消」回执,触发即视为成功(返回值契约由调用方平台接口承载)。
 */
export function downloadBlob(name: string, blob: Blob, revokeDelayMs = 10_000): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs)
}
