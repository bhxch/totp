import { ref } from 'vue'

/** 卡片消息三态：成功/错误/提示 */
export type MsgKind = 'ok' | 'err' | 'hint'

/**
 * 卡片异步反馈基建（R7，范式=SecurityCard.run）：busy 与三态消息（msg/msgKind）+ fail 包装。
 * 六卡原各写一份 busy/msg/msgKind/fail；msg/msgKind 为普通 ref，卡内定制提示仍可直接赋值，
 * 不经由本组合式函数的第二套通道。
 */
export function useAsyncMessage() {
  const busy = ref(false)
  const msg = ref('')
  const msgKind = ref<MsgKind>('ok')

  /** 错误入消息通道（err）：Error 取 message，其余 String() */
  function fail(e: unknown): void {
    msg.value = e instanceof Error ? e.message : String(e)
    msgKind.value = 'err'
  }

  /** busy/消息统一包装（SecurityCard 原范式）：成功置 okMsg（ok 态）返回 true，失败经 fail 返回
   *  false；busy 恒在 finally 复位，调用方据返回值决定是否做成功侧清理（清输入等） */
  async function run(fn: () => Promise<void>, okMsg: string): Promise<boolean> {
    busy.value = true
    msg.value = ''
    try {
      await fn()
      msg.value = okMsg
      msgKind.value = 'ok'
      return true
    } catch (e) {
      fail(e)
      return false
    } finally {
      busy.value = false
    }
  }

  return { busy, msg, msgKind, fail, run }
}
