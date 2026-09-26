/**
 * 极简 XML 解析（R12 自 import/winauth.ts 纯移动分层；WinAuth 导出为良构 XML，无需完整 XML
 * 解析器）。实体反转义复用 miscApps 的 xmlUnescape（同一函数，R12 收敛单点）。
 * 消费方：import/winauth.ts（<WinAuth> 配置容器读取）。
 */
import { xmlUnescape } from './miscApps'

export interface MiniXmlNode {
  name: string
  attrs: Record<string, string>
  text: string
  children: MiniXmlNode[]
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) attrs[m[1]!] = xmlUnescape(m[2] ?? m[3] ?? '')
  return attrs
}

export function parseXml(input: string): MiniXmlNode {
  let s = input.replace(/^\uFEFF/, '')
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '')
  const doc: MiniXmlNode = { name: '#doc', attrs: {}, text: '', children: [] }
  const stack: MiniXmlNode[] = [doc]
  const tokenRe = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\/([A-Za-z_][\w.:-]*)\s*>|<!\[CDATA\[([\s\S]*?)\]\]>/g
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(s)) !== null) {
    const top = stack[stack.length - 1]!
    top.text += xmlUnescape(s.slice(pos, m.index))
    pos = m.index + m[0].length
    if (m[1] !== undefined) {
      // 开始标签
      const node: MiniXmlNode = { name: m[1], attrs: parseAttrs(m[2] ?? ''), text: '', children: [] }
      top.children.push(node)
      if (m[3] !== '/') stack.push(node)
    } else if (m[4] !== undefined) {
      // 结束标签
      if (stack.length <= 1 || stack.pop()!.name !== m[4]) throw new Error('XML 标签不匹配')
    } else if (m[5] !== undefined) {
      top.text += m[5] // CDATA 原文
    }
  }
  if (stack.length !== 1) throw new Error('XML 未闭合')
  doc.text += xmlUnescape(s.slice(pos))
  if (doc.children.length !== 1) throw new Error('XML 必须有唯一根元素')
  return doc.children[0]!
}

export function child(node: MiniXmlNode, name: string): MiniXmlNode | undefined {
  return node.children.find((c) => c.name === name)
}
