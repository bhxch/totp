; TOTP Tools NSIS 安装器钩子
; 接线：tauri.conf.json bundle.windows.nsis.installerHooks（相对 src-tauri 解析）。
; tauri-bundler 模板以 `!ifmacrodef` 守卫插入（installer.nsi 的 Section Install /
; Section Uninstall），只定义用到的宏即可，未定义的钩子点静默跳过。
;
; ABE 提权服务（TotpToolsElevationService）的安装/绑定由应用内「安装服务」按钮经
; 一次 UAC 完成（--elevation-install，见 elevation_install.rs），安装器不做任何
; 提权动作——POSTINSTALL 留空占位。卸载侧兜底清理见 PREUNINSTALL。
;
; 容错约束（与 elevation_install::run_uninstall 的 1060/1072/NotFound 容忍语义对齐）：
; 服务未安装（sc 返回 1060）、目录不存在（RMDir 静默成功）、键不存在（DeleteRegKey
; 静默成功）均不得报错或阻断卸载。
; 权限注记：本应用为 currentUser 安装模式（RequestExecutionLevel user），常规卸载
; 流程卸载器非提权，sc/delete HKLM 可能因权限不足失败——主清理通道是安全页「移除」
;/「卸载清理」触发的 --elevation-uninstall（UAC 提权），此处失败静默继续（nsExec
; 退出码仅 Pop 丢弃，不 Abort）。

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "TOTP Tools: 清理 ABE 提权服务与绑定记录"
  ; $R0 仅作 nsExec 退出码暂存（Push/Pop 保护现场，退出码不关心）
  Push $R0
  ; 停止服务（未安装/未运行不报错）
  nsExec::ExecToLog 'sc stop "TotpToolsElevationService"'
  Pop $R0
  ; 删除服务（1060 未安装 / 1072 已标记待删均容忍）
  nsExec::ExecToLog 'sc delete "TotpToolsElevationService"'
  Pop $R0
  Pop $R0
  ; ProgramData 服务副本目录（%ProgramData%\TotpTools\service，不存在静默成功）
  RMDir /r "$COMMONPROGRAMDATA\TotpTools\service"
  ; HKLM 绑定记录键（BoundPath/BoundSha256/WrappedDek/ServiceVersion，不存在静默成功）
  DeleteRegKey HKLM "SOFTWARE\TotpTools\Elevation"
!macroend

; 安装钩子占位：装器不装服务（安装由应用内按钮 UAC 完成，见文件头注释）
!macro NSIS_HOOK_POSTINSTALL
!macroend
