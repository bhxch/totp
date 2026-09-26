import { base32Decode } from '../encoding/base32'
import { hotp, type HashAlgorithm } from './hotp'
import { totp } from './totp'
import { steamCode } from './steam'
import { yandexCode } from './yandex'
import type { EntryType, OtpDigits, OtpEntry } from '../model'

/**
 * R3：OTP 类型注册表——四类型（totp/hotp/steam/yandex）特化知识的单一事实源。
 * 此前散落 uri.ts（host 白名单/算法强制/digits 强制/pin/生成默认）、entryCode.ts（取码分发）、
 * import/normalize.ts（type 归一/digits 收口）十余处平行分支，新增类型需同步 ≥4 文件；
 * 注册表化后新增类型 = 加一个 descriptor。uri/entryCode/normalize 均查本表。
 * 取码行为由 entryCode.test.ts 向量锁定，描述符值由 test/typeProfiles.test.ts 锁定。
 */

/** 取码入参：OtpEntry 的取码相关投影（computeEntryCode 与各 descriptor.compute 共用） */
export type CodeComputeInput = Pick<
  OtpEntry,
  'type' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter' | 'pin'
>

/** descriptor.compute 结果：code 必返；counter 仅 hotp（窥视当前计数、不推进的展示语义） */
export interface CodeComputeResult {
  code: string
  counter?: number
}

export interface TypeProfile {
  /** otpauth host 别名（小写）；hostAliases[0] 为 buildOtpUri 输出的规范 host（'yandex' 规范为 'yaotp'） */
  readonly hostAliases: readonly string[]
  /** URI/导入未提供合法 algorithm 时的默认算法；同时是 buildOtpUri 的省略默认（buildUriDefaults.algorithm） */
  readonly defaultAlgorithm: HashAlgorithm
  /** algorithm 白名单：URI query 白名单内覆盖、白名单外回落 defaultAlgorithm；单元素即强制（steam 仅 SHA1） */
  readonly supportedAlgorithms: readonly HashAlgorithm[]
  /** 强制 digits：URI 解析/导入收口忽略输入恒取此值（steam=5、yandex=8）；null=允许 6/7/8 由输入决定 */
  readonly forcedDigits: OtpDigits | null
  /** 默认 digits：URI 无 digits 参数与导入非法值回落；亦是表单层默认（defaultDigitsFor） */
  readonly defaultDigits: OtpDigits
  /** buildOtpUri 是否可能写出 digits 参数（steam 强制 5 恒省略——写出无意义；其余非默认时写出） */
  readonly digitsMutable: boolean
  /** 是否读取/写出 pin 参数（仅 yandex；其余 host 不读不写，避免 totp 条目 pin 污染，M6） */
  readonly supportsPin: boolean
  /** URI 恒写 counter 参数（I35：hotp 跨工具对缺省 counter 处理不一致，仅 hotp） */
  readonly alwaysWriteCounter: boolean
  /** normalizeType 的小写包含匹配词；表定义序=归一优先级（先匹配先赢），空数组=不参与匹配（totp 作归一兜底） */
  readonly nameHints: readonly string[]
  /** 取码（四类型算法/参数各异：hotp 吃 counter、yandex 吃 pin+period+digits；secret 解码方式亦随类型） */
  readonly compute: (e: CodeComputeInput, nowMs: number, period: number) => Promise<CodeComputeResult>
  /** buildOtpUri 的省略默认值（派生自 defaultAlgorithm/defaultDigits，见 TYPE_PROFILES 组装，防双写漂移） */
  readonly buildUriDefaults: { readonly algorithm: HashAlgorithm; readonly digits: OtpDigits }
}

/** RFC 6238 三算法全集（URI query 白名单；steam 特化为单元素子集） */
const RFC_ALGORITHMS: readonly HashAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

type TypeProfileSpec = Omit<TypeProfile, 'buildUriDefaults'>

// 表定义顺序 = normalizeType 归一优先级（沿用原 if 链：yandex 先于 steam，'SteamYandex' 归 yandex）；
// totp 无 nameHints 置于末位作归一兜底。host 解析与取码分发与顺序无关。
const SPECS: Record<EntryType, TypeProfileSpec> = {
  yandex: {
    hostAliases: ['yaotp'],
    defaultAlgorithm: 'SHA256', // YAOTP 规范
    supportedAlgorithms: RFC_ALGORITHMS, // query 显式白名单值仍覆盖、白名单外回落默认
    forcedDigits: 8,
    defaultDigits: 8,
    digitsMutable: true,
    supportsPin: true,
    alwaysWriteCounter: false,
    nameHints: ['yandex'],
    // yandex 的 secret 直传（yandexCode 内部按自洽校验形态处理，不做 base32 解码）
    compute: async (e, nowMs, period) => ({ code: await yandexCode(e.secret, e.pin ?? '', nowMs, period, e.digits) }),
  },
  steam: {
    hostAliases: ['steam'],
    defaultAlgorithm: 'SHA1', // Steam 官方规范只支持 SHA-1
    supportedAlgorithms: ['SHA1'], // 单元素=强制：query 写其他值忽略
    forcedDigits: 5,
    defaultDigits: 5,
    digitsMutable: false,
    supportsPin: false,
    alwaysWriteCounter: false,
    nameHints: ['steam'],
    compute: async (e, nowMs) => ({ code: await steamCode(base32Decode(e.secret), nowMs) }),
  },
  hotp: {
    hostAliases: ['hotp'],
    defaultAlgorithm: 'SHA1',
    supportedAlgorithms: RFC_ALGORITHMS,
    forcedDigits: null,
    defaultDigits: 6,
    digitsMutable: true,
    supportsPin: false,
    alwaysWriteCounter: true, // I35：始终输出 counter（默认 0），跨工具导入时对方默认处理不一致
    nameHints: ['hotp'],
    compute: async (e) => {
      const counter = e.counter ?? 0
      return {
        code: await hotp(base32Decode(e.secret), counter, { algorithm: e.algorithm, digits: e.digits }),
        counter, // 窥视语义：返回当前 counter 供展示（推进由复制后调用方负责）
      }
    },
  },
  totp: {
    hostAliases: ['totp'],
    defaultAlgorithm: 'SHA1',
    supportedAlgorithms: RFC_ALGORITHMS,
    forcedDigits: null,
    defaultDigits: 6,
    digitsMutable: true,
    supportsPin: false,
    alwaysWriteCounter: false,
    nameHints: [], // 不参与包含匹配：归一兜底类型
    compute: async (e, nowMs, period) => ({
      code: await totp(base32Decode(e.secret), nowMs, { algorithm: e.algorithm, digits: e.digits, period }),
    }),
  },
}

/** 类型注册表：buildUriDefaults 由 default 字段派生组装，保证单一事实源 */
export const TYPE_PROFILES: Record<EntryType, TypeProfile> = Object.fromEntries(
  (Object.entries(SPECS) as [EntryType, TypeProfileSpec][]).map(([type, spec]) => [
    type,
    { ...spec, buildUriDefaults: { algorithm: spec.defaultAlgorithm, digits: spec.defaultDigits } },
  ]),
) as Record<EntryType, TypeProfile>

/** otpauth host → 内部 type（host 大小写不敏感归一；未知 host 返回 null，由 parseOtpUri 拒绝） */
export function otpTypeForHost(host: string): EntryType | null {
  const h = host.toLowerCase()
  for (const [type, profile] of Object.entries(TYPE_PROFILES) as [EntryType, TypeProfile][]) {
    if (profile.hostAliases.includes(h)) return type
  }
  return null
}

/**
 * digits 收口到 OtpDigits（I36 类型收紧的运行时边界；原 import/normalize 实现，R3 上移为查
 * descriptor.forcedDigits）：steam 强制 5、yandex 强制 8，其余仅接受 6/7/8、非法回落 6。
 * 幂等；vault.addEntry 入库边界与此处统一兜底。经 index.ts 由 './import/normalize' re-export 出口。
 */
export function toOtpDigits(raw: number, type: EntryType): OtpDigits {
  const forced = TYPE_PROFILES[type]?.forcedDigits
  if (forced != null) return forced
  return raw === 6 || raw === 7 || raw === 8 ? raw : (TYPE_PROFILES[type]?.defaultDigits ?? 6)
}

/** 表单层「type 默认 digits」查询（编辑态切换 type 重算表单默认值用）：强制类型=强制值，其余=6 */
export function defaultDigitsFor(type: EntryType): OtpDigits {
  const profile = TYPE_PROFILES[type]
  return profile ? (profile.forcedDigits ?? profile.defaultDigits) : 6
}
