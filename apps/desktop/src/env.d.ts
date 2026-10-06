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

// fullIcons.ts 的 icons-full.json?url 导入（Task 7，经 IconPickerDialog 静态引用）早已在
// desktop 编译程序内（App.vue → NavigationShell → routes → CodesPage → EntryFormDialog →
// EntryForm → IconPickerDialog），BASE 上 vue-tsc 即报 TS2307——存量问题；此处镜像
// packages/ui/src/env.d.ts 的声明修复（与 wasm?url 先例同款）
declare module '*.json?url' {
  const src: string
  export default src
}
