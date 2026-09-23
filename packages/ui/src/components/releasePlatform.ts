/** 释放策略 DTO（与 Rust release_policy_get/set 契约对齐；缺省 5/30/false/true） */
export interface ReleasePolicyDto {
  pauseMinutes: number
  destroyMinutes: number
  lockOnPause: boolean
  lockOnDestroy: boolean
}

/** 释放平台能力（桌面宿主桥接 release_policy_* 命令；扩展/Web 宿主不提供，设置卡不渲染） */
export interface ReleasePlatform {
  getConfig: () => Promise<ReleasePolicyDto>
  setConfig: (cfg: ReleasePolicyDto) => Promise<void>
}

/** 分钟数校验：0-1440 整数（0=禁用该档）；返回 null 合法，否则为错误 i18n key 参数 */
export function validateReleaseMinutes(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 1440
}
