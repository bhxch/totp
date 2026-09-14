import type { ImportScheme } from '@totp/core'
import type { VueStore } from '../store'

/**
 * 导入平台能力（由宿主注入）：desktop=系统对话框+OS 白名单读取+DPAPI；extension=动态 input file（无 DPAPI）。
 * ImportCard 只依赖此接口，platform 为 null 时整卡不渲染（popup 零影响）。
 */
export interface ImportPlatform {
  /** 选择并读取导入文件，返回文本与文件名；用户取消返回 null */
  readImportFile(): Promise<{ text: string; name: string } | null>
  /** [可选] WinAuth DPAPI 层解密（base64 密文 → UTF-8 明文），仅桌面端提供；插件端缺失时由 core 逐条 failure「请用桌面版」 */
  decryptDpapi?(b64: string): Promise<string>
  /** 共享 vault store：解析结果经 store.commit + applyImport 落库 */
  store: VueStore
}

/**
 * 导入映射方案存取能力（由宿主注入，直读写 storage adapter 的 SCHEMES_KEY 键）；缺省时映射页方案区不渲染。
 * load 宿主自容错（core normalizeSchemes 解析），save 接收去重后的全量列表整体覆写。
 */
export interface ImportSchemesApi {
  load(): Promise<ImportScheme[]>
  save(list: ImportScheme[]): Promise<void>
}
