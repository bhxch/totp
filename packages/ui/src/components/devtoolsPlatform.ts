/** devtools 配置 DTO（与 Rust devtools_get_config 返回契约对齐；缺省 false/9222） */
export interface DevtoolsConfigDto {
  enabled: boolean
  port: number
}

/** 开发者平台能力（桌面宿主桥接 devtools_get_config / devtools_set_config 命令；扩展/Web 宿主不提供，开发者卡片不渲染） */
export interface DevtoolsPlatform {
  getConfig: () => Promise<DevtoolsConfigDto>
  setConfig: (enabled: boolean, port: number) => Promise<void>
}
