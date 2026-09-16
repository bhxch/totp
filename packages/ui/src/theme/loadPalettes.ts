// palettes chunk 加载器:独立小模块承载动态导入,构建期按此边界把 tokens-palettes.css
// 拆为懒载 chunk;独立成文件亦便于测试以静态依赖链 mock 动态导入。
export function loadPalettes(): Promise<unknown> {
  return import('./tokens-palettes.css')
}
