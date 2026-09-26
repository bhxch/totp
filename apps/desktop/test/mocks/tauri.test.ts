/**
 * Tauri mock 工厂自测（P0 验收）：invoke 分发 / 事件 emit / fs 操作 / window / reset 周期。
 * 工厂是后续 desktop 批次（tauriFs 直测、App.vue 拆工厂、挂载测试）的地基，此处守护其契约：
 * - 已知命令默认 null、注册 handler/返回值生效、清单外命令抛错（笔误防护）
 * - emit 派发 Tauri 事件形状 { event, id, payload }，unlisten 后不再收到
 * - fs 默认行为与 backupService.test.ts 先例一致（readTextFile ''、readDir []、exists false）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BaseDirectory, EVENTS, INVOKE_COMMANDS, eventModule, fsModule, invokeModule,
  tauriMock, windowModule,
} from './tauri'

beforeEach(() => {
  tauriMock.reset()
})

describe('invoke 分发', () => {
  it('未注册的已知命令返回 null（Rust Option 语义）', async () => {
    await expect(tauriMock.invoke('take_stashed_dek')).resolves.toBeNull()
    await expect(tauriMock.invoke('pick_dir_os')).resolves.toBeNull()
  })

  it('on 注册 handler：收到 args、返回值透传（可抛错）', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    tauriMock.on('stage_clipboard_write', (args) => {
      seen.push(args)
      throw new Error('clipboard busy')
    })
    tauriMock.on('take_stashed_dek', (args) => ({ dek: args?.['want'] }))

    await expect(tauriMock.invoke('stage_clipboard_write', { value: '123456' })).rejects.toThrow('clipboard busy')
    expect(seen).toEqual([{ value: '123456' }])
    await expect(tauriMock.invoke('take_stashed_dek', { want: 'b64' })).resolves.toEqual({ dek: 'b64' })
  })

  it('onReturn 注册静态返回值', async () => {
    tauriMock.onReturn('release_policy_get', { mode: 'pause', lockOnPause: true })
    await expect(tauriMock.invoke('release_policy_get')).resolves.toEqual({ mode: 'pause', lockOnPause: true })
  })

  it('on/onReturn 注册清单外命令名即抛错（笔误防护与 invoke 侧对齐，不留下打不到的 handler）', async () => {
    expect(() => tauriMock.on('stgae_clipboard_write', () => null)).toThrow(/未知命令/)
    expect(() => tauriMock.onReturn('take_stash_dek', 'x')).toThrow(/未知命令/)
    // 抛错路径未污染注册表：正确命令名注册照常生效
    tauriMock.onReturn('take_stashed_dek', 'ok')
    await expect(tauriMock.invoke('take_stashed_dek')).resolves.toBe('ok')
  })

  it('清单外命令抛错（视为笔误，不给静默 null）', async () => {
    await expect(tauriMock.invoke('stgae_clipboard_write')).rejects.toThrow(/未知 invoke 命令/)
  })

  it('calls 记录并支持按命令名过滤', async () => {
    await tauriMock.invoke('stage_clipboard_write', { value: '654321' })
    await tauriMock.invoke('clipboard_clear_if_staged')
    await tauriMock.invoke('stage_clipboard_write', { value: '111111' })

    expect(tauriMock.calls()).toHaveLength(3)
    expect(tauriMock.calls('stage_clipboard_write')).toEqual([
      { command: 'stage_clipboard_write', args: { value: '654321' } },
      { command: 'stage_clipboard_write', args: { value: '111111' } },
    ])
    expect(tauriMock.invoke).toHaveBeenCalledWith('clipboard_clear_if_staged') // vi.fn 断言面同样可用
  })

  it('命令清单覆盖盘点面（25 命令 + mcp_revoke_approvals 等，共 31 个）', () => {
    expect(INVOKE_COMMANDS).toHaveLength(31)
    for (const cmd of [
      'stage_clipboard_write', 'clipboard_clear_if_staged', 'take_stashed_dek', 'stash_dek', 'clear_stashed_dek',
      'os_auto_protect', 'os_auto_unprotect', 'os_auto_forget', 'decrypt_dpapi',
      'pick_dir_os', 'pick_save_file_os', 'pick_open_file_os', 'dir_token_os',
      'read_text_file_os', 'write_text_file_os', 'write_bytes_file_os',
      'list_backup_files_os', 'remove_backup_file', 'remove_backup_file_os',
      'read_import_file_os', 'read_import_file_bytes_os',
      'mcp_get_config', 'mcp_set_config', 'mcp_regenerate_token', 'mcp_revoke_approvals',
      'mcp_approval_response', 'mcp_respond',
      'devtools_get_config', 'devtools_set_config', 'release_policy_get', 'release_policy_set',
    ]) {
      expect(INVOKE_COMMANDS).toContain(cmd)
    }
  })
})

describe('事件 listen/emit', () => {
  it('emit 派发 Tauri 事件形状；unlisten 后不再收到', async () => {
    const got: unknown[] = []
    const unlisten = await tauriMock.listen('force-lock', (e) => got.push(e))
    expect(tauriMock.listenerCount('force-lock')).toBe(1)

    tauriMock.emit('force-lock', { reason: 'release' })
    expect(got).toEqual([{ event: 'force-lock', id: 1, payload: { reason: 'release' } }])

    unlisten()
    tauriMock.emit('force-lock', 'again')
    expect(got).toHaveLength(1)
    expect(tauriMock.listenerCount('force-lock')).toBe(0)
  })

  it('多监听者全量派发；未监听事件 emit 为无操作', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    void tauriMock.listen('mcp://req', (e) => a.push(e))
    void tauriMock.listen('mcp://req', (e) => b.push(e))
    tauriMock.emit('mcp://approval', { ident: 'x' }) // 无监听：不抛
    tauriMock.emit('mcp://req', { id: 1 })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('事件清单覆盖 6 类（onFocusChanged 走 window）', () => {
    expect(EVENTS).toHaveLength(6)
    for (const ev of ['system-lock', 'force-lock', 'stash-dek-request', 'mcp://approval', 'mcp://tool-approval', 'mcp://req']) {
      expect(EVENTS).toContain(ev)
    }
  })

  it('listen 注册清单外事件名即抛错（emit 侧保持宽松不抛）', async () => {
    await expect(tauriMock.listen('force_llock', () => {})).rejects.toThrow(/未知事件/)
    expect(tauriMock.listenerCount('force_llock')).toBe(0)
    tauriMock.emit('force_llock', 'x') // 宽松：无监听派发为无操作
  })
})

describe('window（getCurrentWindow）', () => {
  it('label 默认 main；hide 记录调用；onFocusChanged 收 emitFocusChanged 派发', async () => {
    const { getCurrentWindow } = windowModule()
    const win = getCurrentWindow()
    expect(win.label).toBe('main')

    const got: boolean[] = []
    const unlisten = await win.onFocusChanged((e) => got.push(e.payload))
    tauriMock.emitFocusChanged(false) // 失焦隐藏链路
    expect(got).toEqual([false])
    unlisten()
    tauriMock.emitFocusChanged(true)
    expect(got).toHaveLength(1)

    await win.hide()
    expect(tauriMock.window.hide).toHaveBeenCalledOnce()

    win.label = 'mini'
    expect(tauriMock.window.label).toBe('mini')
  })
})

describe('plugin-fs', () => {
  it("默认行为：exists false / readTextFile 空串 / readDir [] / 写操作成功并记录", async () => {
    const mod = fsModule()
    expect(await mod.exists('vault.json', { baseDir: BaseDirectory.AppData })).toBe(false)
    expect(await mod.readTextFile('vault.json', { baseDir: BaseDirectory.AppData })).toBe('')
    expect(await mod.readDir('backups', { baseDir: BaseDirectory.AppData })).toEqual([])
    await mod.writeTextFile('a.tmp', 'x', { baseDir: BaseDirectory.AppData })
    await mod.rename('a.tmp', 'a', { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' })
    await mod.mkdir('', { baseDir: BaseDirectory.AppData, recursive: true })
    expect(mod.writeTextFile).toHaveBeenCalledWith('a.tmp', 'x', { baseDir: 'AppData' })
    expect(mod.rename).toHaveBeenCalledOnce()
    expect(BaseDirectory.AppData).toBe('AppData')
  })

  it('行为可按需覆盖（mockResolvedValue 数据驱动）', async () => {
    const mod = fsModule()
    mod.exists.mockResolvedValue(true)
    mod.readTextFile.mockResolvedValue('{"vault":1,"shortcutToggleMini":{}}')
    mod.readDir.mockResolvedValue([{ name: 'vault-1.totpbackup' }])
    expect(await mod.exists('settings.json')).toBe(true)
    expect(JSON.parse(await mod.readTextFile('settings.json'))).toHaveProperty('shortcutToggleMini')
    expect(await mod.readDir('')).toEqual([{ name: 'vault-1.totpbackup' }])
  })
})

describe('reset 周期与 vi.mock 工厂入口', () => {
  it('reset 清空 handler/调用记录/监听并还原 fs 默认值', async () => {
    tauriMock.onReturn('mcp_get_config', { enabled: true })
    await tauriMock.invoke('mcp_get_config')
    await tauriMock.listen('system-lock', () => {})
    await tauriMock.fs.writeTextFile('x', 'y')
    tauriMock.fs.readTextFile.mockResolvedValue('dirty')

    tauriMock.reset()

    expect(tauriMock.calls()).toHaveLength(0)
    await expect(tauriMock.invoke('mcp_get_config')).resolves.toBeNull() // handler 已清：回落默认 null
    expect(tauriMock.calls('mcp_get_config')).toEqual([{ command: 'mcp_get_config', args: undefined }])
    expect(tauriMock.listenerCount('system-lock')).toBe(0)
    expect(await tauriMock.fs.readTextFile('x')).toBe('')
    expect(tauriMock.fs.writeTextFile).not.toHaveBeenCalled()
  })

  it('四个模块入口形状对齐真实模块的使用面', () => {
    expect(invokeModule()).toEqual({ invoke: tauriMock.invoke })
    expect(eventModule()).toEqual({ listen: tauriMock.listen })
    expect(windowModule().getCurrentWindow()).toBe(tauriMock.window)
    expect(fsModule().BaseDirectory).toEqual(BaseDirectory)
    expect(fsModule()).toHaveProperty('writeTextFile')
  })
})
