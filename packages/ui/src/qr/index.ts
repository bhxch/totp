// packages/ui/src/qr/index.ts
// qr 子路径出口（与 ./host 同模式）：解码纯函数的最小集合，供扩展 background SW 等
// 非 DOM 宿主按需引入。必须绕开根桶（src/index.ts）——桶上 Vue 组件/响应式模块初始化器
// 阻断摇树，且 background 由 WXT 以 lib mode 打单文件，图中任何 ?url 资产都会被 Vite
// 强制内联成 base64 data URL（icons-full.json/sql-wasm 曾因此把 background.js 顶到 8MB+）。
export { decodeQrToUri, type ImagePixels } from './decodeQr'
export { blobToPixels } from './imageSource'
