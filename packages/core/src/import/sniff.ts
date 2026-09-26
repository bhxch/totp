// 统一入口：re-export 同目录实现，供外部从 sniff 单点导入。
// R5 起格式知识（特征谓词/解析/粘贴白名单/口令内容谓词）全部迁入 registry.ts 单一注册表：
// sniffFormat/sniffAegis/sniffFoxauthEncrypted 的实现均在 registry.ts，此处保留单点出包
// （index.ts 经本文件 export * 链出包），既有导入路径不变。
export * from './registry'
export * from './types'
export * from './generic'
export * from './uriBatch'
