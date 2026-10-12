// 首帧防闪种子：Vue 挂载前据 localStorage 主题镜像还原 <html> 的 data-mode/color/contrast，
// 避免深色/非默认主题用户首帧按默认种子渲染再跳变（镜像由 packages/ui useTheme.writeMirror
// 维护，key 'themePref' 即 THEME_PREF_KEY；本脚本不参与打包，故 key 以字面量硬编码）。
// 须保持 head 内普通 <script> 同步阻塞执行才有防闪语义；扩展端 MV3 CSP 禁止 inline
// script（Chromium/Gecko 同口径），四入口（扩展 popup/options、桌面 index/mini）均外链
// 本文件——扩展与桌面两侧 public 各存一份，内容须一致，改动请同步。
try {
  var p = JSON.parse(localStorage.getItem('themePref') || '{}')
  var d = document.documentElement.dataset
  d.mode = p.mode || 'auto'
  d.color = p.color || 'blue'
  if (p.contrast) d.contrast = p.contrast
} catch (e) {
  document.documentElement.dataset.mode = 'auto'
  document.documentElement.dataset.color = 'blue'
}
