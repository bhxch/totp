/**
 * 宿主装配工厂层(R4):两端宿主(desktop/extension)装配胶水下沉重构的落位。
 * 原则:返回对象/Platform 接口形状不变(宿主零改动硬约束);每工厂附「同型成员 vs 注入差异」
 * 清单(见各文件头),仅已核实差异(extension:authError 包装、badge/横幅通道;desktop:
 * dpapi/unlockNaming、目录冲突副本、存储通道)进 overrides——overrides 键数接近字面量成员数
 * 的工厂不抽,保留两端装配。
 * 消费方式:宿主经 '@totp/ui/host' 子出口(exports "./host")导入;主出口(index.ts)不
 * re-export 本目录——宿主测试对 '@totp/ui' 的 vi.mock(全量/展开式)在工厂执行期经
 * importActual 加载主出口,若含 host 会把 host 首载锁进 actual 绑定(mock 桩/捕获失效,已实测);
 * 走子出口则 host 首载晚于 mock 就绪。host 工厂内部消费 ui 基建(runner/桥/prf)一律经包名
 * 自引用 '@totp/ui'(命中宿主 mock 的同一说明符;生产经 exports "." 回到纯 re-export 的
 * index.ts,无循环)。
 */
export { createRevSeal } from './revSeal'
export { downloadBlob } from './download'
export { createSecurityOpsFromStore, type SecurityOpsOverrides } from './securityOps'
export { createStoreBackedCloudPlatform, type StoreBackedCloudPlatformOverrides } from './cloudPlatform'
export { createCloudSyncRunnerForStore, type CloudRunnerOverrides } from './cloudRunner'
export type { HostRef } from './internal'
