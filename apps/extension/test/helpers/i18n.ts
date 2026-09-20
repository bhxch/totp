/** popup 组件测试用 i18n 工厂：D2 抽串后 popup App 与 ui 组件（SearchBar 等）均依赖 i18n 插件。
 *  单行复用 ui 包既有工厂（monorepo 相对路径单源，zh/en 资源清单不两处维护） */
export { createTestI18n } from '../../../../packages/ui/test/helpers/i18n'
