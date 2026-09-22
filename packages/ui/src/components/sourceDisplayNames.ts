/**
 * 源名显示回落：旧迁移（desktop legacyMigrate / extension cloudCredStore）把默认源名以中文字面量
 * 写入用户数据（「本地备份」「本地目录」），源名随数据落盘不走 i18n，英文界面会显示汉字。
 * 这里把这些默认名当哨兵值按当前语言显示；用户自定义名原样。编辑框仍绑落盘原值，改动即自定义。
 */

/** 旧迁移默认源名 → i18n key（backupCard 段；与 locales zh/en 保持同步） */
const DEFAULT_SOURCE_NAME_KEYS: Record<string, string> = {
  本地备份: 'backupCard.localBackup',
  本地目录: 'backupCard.localDir',
}

/** 默认源名按当前语言显示，其余原样返回 */
export function displaySourceName(name: string, t: (key: string) => string): string {
  const key = DEFAULT_SOURCE_NAME_KEYS[name]
  return key !== undefined ? t(key) : name
}
