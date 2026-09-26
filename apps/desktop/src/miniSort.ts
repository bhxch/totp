/** mini 列表排序：pinned 优先（truthy 检查兼容无 pinned 字段的旧 vault），组内按 order 升序。
 *  实现即 ui sortEntries 单点（R14：原与 CodesPage.vue 各持一份 comparator 靠注释同步，
 *  同一份 vault 跨宿主展示顺序稳定由单一实现保证）；本模块保留宿主旧名转出口，
 *  供 MiniApp 与既有单测零改动消费 */
export { sortEntries as sortMiniEntries } from '@totp/ui'
