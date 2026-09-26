import type { Seal } from '@totp/core'
import type { VueStore } from '../store'

/**
 * rev 基线 seal 工厂(spec §1.2 静态保护,T9 装配约定 5;R4 自两端装配收敛)。
 * overrides 纪律清单:同型成员 2(seal/unseal)vs 注入差异 0 → 无 overrides,纯下沉
 * (原两端逐字副本:extension cloudRunnerFactory.revSeal / desktop cloudPlatforms.revSeal)。
 * 两态语义:未启用加密(sealWithDek 返回 null)→ 明文回落(明文库语义);加密启用但窗口锁定
 * (DEK 已清)→ sealWithDek 抛 'vault locked' 不吞错——在途锁定不得明文回落,落盘整体失败
 * 按下轮重做,绝不把 baseSnapshot/冲突记录明文回落落盘;unseal 不可解(换 DEK/明文记录)回落
 * 原文——core 解析层自然判废(明文可解析=兼容读取,密文垃圾解析失败=回落空态重建)。
 * 手动通道(cloudPlatform.loadSourceState/saveSourceState)与 runner 通道共用同一 seal 实例
 * 形态:共享 cloudSyncState 键互不互踩,缺 seal 侧会把密文当明文 bag 互踩并泄漏 baseSnapshot。
 */
export function createRevSeal(store: VueStore): Seal {
  return {
    seal: async (plain) => (await store.sealWithDek(plain)) ?? plain,
    unseal: async (sealed) => (await store.unsealWithDek(sealed)) ?? sealed,
  }
}
