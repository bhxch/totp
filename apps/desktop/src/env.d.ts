declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>
  export default component
}

declare module '*.css'

declare module '*.wasm?url' {
  const src: string
  export default src
}

// @totp/ui 入口导出 fullIcons（2026-10-05 full-icons Task 9）后，其 icons-full.json?url
// 导入进入 desktop 的 vue-tsc 程序；声明与 packages/ui/src/env.d.ts 保持一致
declare module '*.json?url' {
  const src: string
  export default src
}
