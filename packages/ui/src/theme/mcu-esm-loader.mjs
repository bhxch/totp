// mcu-esm-loader.mjs — @material/material-color-utilities@0.4.0 直跑兼容 loader
// 背景:0.4.0 ESM barrel 内部相对 import 缺 .js 扩展名(上游 issue #195,仍 open),
// 纯 Node 直跑报 ERR_MODULE_NOT_FOUND。本文件是 module.register 的 resolve hook:
// 对 mcu 包内部相对导入的解析失败,依次尝试追加 .js / /index.js 再解析。
// 作用域:仅挂载于 generate.mjs 的 Node 直跑进程(register 只影响本进程);
// vitest 进程不经过本 hook,靠 packages/ui/vitest.config.ts 的 server.deps.inline
// (esbuild 预打包容忍缺扩展名),两者互不替代。
const MCU_DIR = '/@material/material-color-utilities/'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // 只兜底 mcu 包内部相对导入(./xxx、../xxx)的解析失败,不掩盖其他真实错误
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    const inMcu = context.parentURL?.includes(MCU_DIR)
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !isRelative || !inMcu) throw err
    for (const candidate of [`${specifier}.js`, `${specifier}/index.js`]) {
      try {
        return await nextResolve(candidate, context)
      } catch {
        // 尝试下一个候选
      }
    }
    throw err
  }
}
