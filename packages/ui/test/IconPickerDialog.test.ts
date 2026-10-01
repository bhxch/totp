import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons } from '@totp/core'
import IconPickerDialog from '../src/components/IconPickerDialog.vue'
import { createTestI18n } from './helpers/i18n'

const icons = getBuiltinIcons()

function mountPicker(issuer = '', open = true) {
  return mount(IconPickerDialog, { global: { plugins: [createTestI18n()] }, props: { open, builtin: icons, issuer } })
}

describe('IconPickerDialog', () => {
  it('open=false 时不渲染对话框', () => {
    const w = mountPicker('', false)
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('open 后全量网格渲染全部内置图标（≥200）', () => {
    const w = mountPicker()
    expect(w.findAll('.picker-grid--all button').length).toBeGreaterThanOrEqual(200)
  })

  it('推荐区：issuer 模糊命中（githb→github）置顶显示', () => {
    const w = mountPicker('githb')
    const rec = w.findAll('.picker-recommended button')
    expect(rec.length).toBeGreaterThan(0)
    expect(rec[0]!.attributes('title')).toBe('GitHub')
  })

  it('issuer 为空或纯分隔符时不显示推荐区', () => {
    expect(mountPicker('').find('.picker-recommended').exists()).toBe(false)
    expect(mountPicker(' .-_ ').find('.picker-recommended').exists()).toBe(false)
  })

  it('搜索过滤：git 命中相关项（含 digitalocean 的 digit 子串）；无结果时网格为空', async () => {
    const w = mountPicker()
    const search = () => w.find('.picker-search input')
    await search().setValue('git')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.length).toBeLessThan(50)
    expect(cells.some((c) => c.attributes('title') === 'GitLab')).toBe(true)
    await search().setValue('zzz不存在的图标')
    expect(w.findAll('.picker-grid--all button')).toHaveLength(0)
  })

  it('搜索支持中文别名（谷歌→Google）', async () => {
    const w = mountPicker()
    await w.find('.picker-search input').setValue('谷歌')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells[0]!.attributes('title')).toBe('Google')
  })

  it('打开时清空上次搜索词', async () => {
    const w = mountPicker()
    await w.find('.picker-search input').setValue('git')
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect((w.find('.picker-search input').element as HTMLInputElement).value).toBe('')
  })

  it('点选图标 emit select 携带 BuiltinIcon', async () => {
    const w = mountPicker()
    const cell = w.findAll('.picker-grid--all button').find((c) => c.attributes('title') === 'GitLab')!
    await cell.trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ id: 'gitlab', title: 'GitLab' })
  })

  it('点遮罩 emit close（MdDialog 行为）', async () => {
    const w = mountPicker()
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
