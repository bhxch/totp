// WinAuth（github.com/winauth/winauth）配置文件导入。
// 口径全部对齐官方 C# 源码（master 分支），引用以「文件名 + 方法/属性名」标注：
//
// WinAuthConfig.cs / ReadXmlInternal + WriteXmlString —— XML 结构：
//   根元素 <WinAuth version="3.x.y.z">；未加密时根下直接放多个 <WinAuthAuthenticator>；
//   v3.2+ 整包加密时为 <data encrypted="y|u|m" sha1="...">HEX</data>，解出内容为
//   hex→字节→UTF-8 的内层 XML（<config> 包多个 <WinAuthAuthenticator>）；
//   旧布局（v3.0）把密文放在 <WinAuth> 根元素自身的文本中。
// WinAuthAuthenticator.cs / ReadXml + WriteXmlString —— 单条结构：
//   <WinAuthAuthenticator id type="WinAuth.GoogleAuthenticator|WinAuth.SteamAuthenticator|...">
//     <name>、<created>、<autorefresh>…<authenticatordata>（可带 encrypted 属性，
//     内容为整段加密 hex，解出后是 hex→字节→UTF-8 的 <authenticatordata> 内层 XML）。
// Authenticator.cs —— 加密负载（DecryptSequence / EncryptSequence / Decrypt / Encrypt）：
//   全程 hex 编码（非 base64）。格式 = hex("WINAUTH3") + hex(salt 8B) + hex(SHA256(salt||明文hex)) + payload；
//   SHA256 校验失败即口令错（BadPasswordException）。层解密顺序按 Machine(m)→User(u)→
//   Explicit(y)→YubiKey(a/b) 逆序（DecryptSequenceNoHash）：
//   - DPAPI 层：ProtectedData.Unprotect(hex→bytes, null, CurrentUser/LocalMachine)（无附加熵），
//     且明文恒为下一层 payload 的 hex ASCII（decode=false 路径）；
//   - 口令层 Decrypt(data, password, PBKDF2=true)：salt=payload 前 8B，
//     key=Rfc2898DeriveBytes(UTF8(password), salt, PBKDF2_ITERATIONS=2000).GetBytes(PBKDF2_KEYSIZE=256bit)
//     （.NET Rfc2898DeriveBytes 默认 HMAC-SHA1），Blowfish-ECB 解密 + ISO10126d2 去填充。
// Authenticator.cs / SecretData 属性 —— secret 存储：
//   hex(SecretKey) + "\t" + codeDigits + "\t" + SHA1|SHA256|SHA512 + "\t" + period；
//   HOTPAuthenticator.cs / SecretData 再追加 "|counter"。
// 本实现额外内置：Blowfish 初始 P-array/S-box（= pi 小数部分十六进制位，官方 Blowfish 规格表）。

import { createSHA1, pbkdf2 } from 'hash-wasm'
import { base32Encode } from '../encoding/base32'
import { bytesToBase64 } from '../crypto/aesgcm'
import type { ImportResult, ParsedEntry } from './types'

// ---------- 错误分类（对应简报的逐条 failure 口径） ----------

/** 解密失败分类：password→「需要口令或口令错误」；dpapi→「请用桌面版」；yubi→「暂不支持」 */
type DecryptErrorKind = 'password' | 'dpapi' | 'yubi'

class WinauthDecryptError extends Error {
  constructor(public kind: DecryptErrorKind) {
    super(kind)
  }
}

const MSG_PASSWORD = '需要口令或口令错误'
const MSG_DPAPI = '该 WinAuth 备份使用 Windows 加密，请用桌面版导入'
const MSG_YUBI = '该 WinAuth 条目使用 YubiKey 加密，暂不支持'

// ---------- hex / utf8 工具 ----------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('非法 hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------- Blowfish（规格参考官方 Blowfish 参考 实现 + BouncyCastle BlowfishEngine/ISO10126d2Padding） ----------

// 标准初始表：18 个 P 子密钥 + 4×256 S-box（pi 十六进制小数位）
const BLOWFISH_INIT_HEX =
  '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89452821E638D01377BE5466CF34E90C6C' +
  'C0AC29B7C97C50DD3F84D5B5B5470917' +
  '9216D5D98979FB1BD1310BA698DFB5AC2FFD72DBD01ADFB7B8E1AFED6A267E96BA7C9045F12C7F9924A19947B3916CF70801F2E2858EFC16636920D871574E69' +
  'A458FEA3F4933D7E0D95748F728EB658718BCD5882154AEE7B54A41DC25A59B59C30D5392AF26013C5D1B023286085F0CA417918B8DB38EF8E79DCB0603A180E' +
  '6C9E0E8BB01E8A3ED71577C1BD314B2778AF2FDA55605C60E65525F3AA55AB945748986263E8144055CA396A2AAB10B6B4CC5C341141E8CEA15486AF7C72E993' +
  'B3EE1411636FBC2A2BA9C55D741831F6CE5C3E169B87931EAFD6BA336C24CF5C7A325381289586773B8F48986B4BB9AFC4BFE81B6628219361D809CCFB21A991' +
  '487CAC605DEC8032EF845D5DE98575B1DC262302EB651B8823893E81D396ACC50F6D6FF383F442392E0B4482A484200469C8F04A9E1F9B5E21C66842F6E96C9A' +
  '670C9C61ABD388F06A51A0D2D8542F68960FA728AB5133A36EEF0B6C137A3BE4BA3BF0507EFB2A98A1F1651D39AF017666CA593E82430E888CEE8619456F9FB4' +
  '7D84A5C33B8B5EBEE06F75D885C12073401A449F56C16AA64ED3AA62363F77061BFEDF72429B023D37D0D724D00A1248DB0FEAD349F1C09B075372C980991B7B' +
  '25D479D8F6E8DEF7E3FE501AB6794C3B976CE0BD04C006BAC1A94FB6409F60C45E5C9EC2196A246368FB6FAF3E6C53B51339B2EB3B52EC6F6DFC511F9B30952C' +
  'CC814544AF5EBD09BEE3D004DE334AFD660F2807192E4BB3C0CBA85745C8740FD20B5F39B9D3FBDB5579C0BD1A60320AD6A100C6402C7279679F25FEFB1FA3CC' +
  '8EA5E9F8DB3222F83C7516DFFD616B152F501EC8AD0552AB323DB5FAFD23876053317B483E00DF829E5C57BBCA6F8CA01A87562EDF1769DBD542A8F6287EFFC3' +
  'AC6732C68C4F5573695B27B0BBCA58C8E1FFA35DB8F011A010FA3D98FD2183B84AFCB56C2DD1D35B9A53E479B6F84565D28E49BC4BFB9790E1DDF2DAA4CB7E33' +
  '62FB1341CEE4C6E8EF20CADA36774C01D07E9EFE2BF11FB495DBDA4DAE909198EAAD8E716B93D5A0D08ED1D0AFC725E08E3C5B2F8E7594B78FF6E2FBF2122B64' +
  '8888B812900DF01C4FAD5EA0688FC31CD1CFF191B3A8C1AD2F2F2218BE0E1777EA752DFE8B021FA1E5A0CC0FB56F74E818ACF3D6CE89E299B4A84FE0FD13E0B7' +
  '7CC43B81D2ADA8D9165FA2668095770593CC7314211A1477E6AD206577B5FA86C75442F5FB9D35CFEBCDAF0C7B3E89A0D6411BD3AE1E7E4900250E2D2071B35E' +
  '226800BB57B8E0AF2464369BF009B91E5563911D59DFA6AA78C14389D95A537F207D5BA202E5B9C5832603766295CFA911C819684E734A41B3472DCA7B14A94A' +
  '1B5100529A532915D60F573FBC9BC6E42B60A47681E6740008BA6FB5571BE91FF296EC6B2A0DD915B6636521E7B9F9B6FF34052EC585566453B02D5DA99F8FA1' +
  '08BA47996E85076A4B7A70E9B5B32944DB75092EC4192623AD6EA6B049A7DF7D9CEE60B88FEDB266ECAA8C71699A17FF5664526CC2B19EE1193602A575094C29' +
  'A0591340E4183A3E3F54989A5B429D656B8FE4D699F73FD6A1D29C07EFE830F54D2D38E6F0255DC14CDD20868470EB266382E9C6021ECC5E09686B3F3EBAEFC9' +
  '3C9718146B6A70A1687F358452A0E286B79C5305AA5007373E07841C7FDEAE5C8E7D44EC5716F2B8B03ADA37F0500C0DF01C1F040200B3FFAE0CF51A3CB574B2' +
  '25837A58DC0921BDD19113F97CA92FF69432477322F547013AE5E58137C2DADCC8B576349AF3DDA7A94461460FD0030EECC8C73EA4751E41E238CD993BEA0E2F' +
  '3280BBA1183EB3314E548B384F6DB9086F420D03F60A04BF2CB8129024977C795679B072BCAF89AFDE9A771FD9930810B38BAE12DCCF3F2E5512721F2E6B7124' +
  '501ADDE69F84CD877A5847187408DA17BC9F9ABCE94B7D8CEC7AEC3ADB851DFA63094366C464C3D2EF1C18473215D908DD433B3724C2BA1612A14D432A65C451' +
  '50940002133AE4DD71DFF89E10314E5581AC77D65F11199B043556F1D7A3C76B3C11183B5924A509F28FE6ED97F1FBFA9EBABF2C1E153C6E86E34570EAE96FB1' +
  '860E5E0A5A3E2AB3771FE71C4E3D06FA2965DCB999E71D0F803E89D65266C8252E4CC9789C10B36AC6150EBA94E2EA78A5FC3C531E0A2DF4F2F74EA7361D2B3D' +
  '1939260F19C279605223A708F71312B6EBADFE6EEAC31F66E3BC4595A67BC883B17F37D1018CFF28C332DDEFBE6C5AA56558218568AB9802EECEA50FDB2F953B' +
  '2AEF7DAD5B6E2F841521B62829076170ECDD4775619F151013CCA830EB61BD960334FE1EAA0363CFB5735C904C70A239D59E9E0BCBAADE14EECC86BC60622CA7' +
  '9CAB5CABB2F3846E648B1EAF19BDF0CAA02369B9655ABB5040685A323C2AB4B3319EE9D5C021B8F79B540B19875FA09995F7997E623D7DA8F837889A97E32D77' +
  '11ED935F166812810E358829C7E61FD696DEDFA17858BA9957F584A51B2272639B83C3FF1AC24696CDB30AEB532E30548FD948E46DBC312858EBF2EF34C6FFEA' +
  'FE28ED61EE7C3C735D4A14D9E864B7E342105D14203E13E045EEE2B6A3AAABEADB6C4F15FACB4FD0C742F442EF6ABBB5654F3B1D41CD2105D81E799E86854DC7' +
  'E44B476A3D816250CF62A1F25B8D2646FC8883A0C1C7B6A37F1524C369CB749247848A0B5692B285095BBF00AD19489D1462B17423820E0058428D2A0C55F5EA' +
  '1DADF43E233F70613372F0928D937E41D65FECF16C223BDB7CDE3759CBEE74604085F2A7CE77326EA607808419F8509EE8EFD85561D99735A969A7AAC50C06C2' +
  '5A04ABFC800BCADC9E447A2EC3453484FDD567050E1E9EC9DB73DBD3105588CD675FDA79E3674340C5C43465713E38D83D28F89EF16DFF20153E21E78FB03D4A' +
  'E6E39F2BDB83ADF7E93D5A68948140F7F64C261C94692934411520F77602D4F7BCF46B2ED4A20068D40824713320F46A43B7D4B7500061AF1E39F62E97244546' +
  '14214F74BF8B88404D95FC1D96B591AF70F4DDD366A02F45BFBC09EC03BD97857FAC6DD031CB850496EB27B355FD3941DA2547E6ABCA0A9A28507825530429F4' +
  '0A2C86DAE9B66DFB68DC1462D7486900680EC0A427A18DEE4F3FFEA2E887AD8CB58CE0067AF4D6B6AACE1E7CD3375FECCE78A399406B2A4220FE9E35D9F385B9' +
  'EE39D7AB3B124E8B1DC9FAF74B6D185626A36631EAE397B23A6EFA74DD5B43326841E7F7CA7820FBFB0AF54ED8FEB397454056ACBA48952755533A3A20838D87' +
  'FE6BA9B7D096954B55A867BCA1159A58CCA9296399E1DB33A62A4A563F3125F95EF47E1C9029317CFDF8E80204272F7080BB155C05282CE395C11548E4C66D22' +
  '48C1133FC70F86DC07F9C9EE41041F0F404779A45D886E17325F51EBD59BC0D1F2BCC18F41113564257B7834602A9C60DFF8E8A31F636C1B0E12B4C202E1329E' +
  'AF664FD1CAD181156B2395E0333E92E13B240B62EEBEB92285B2A20EE6BA0D99DE720C8C2DA2F728D012784595B794FD647D0862E7CCF5F05449A36F877D48FA' +
  'C39DFD27F33E8D1E0A476341992EFF743A6F6EABF4F8FD37A812DC60A1EBDDF8991BE14CDB6E6B0DC67B55106D672C372765D43BDCD0E804F1290DC7CC00FFA3' +
  'B5390F92690FED0B667B9FFBCEDB7D9CA091CF0BD9155EA3BB132F88515BAD247B9479BF763BD6EB37392EB3CC1159798026E297F42E312D6842ADA7C66A2B3B' +
  '12754CCC782EF11C6A124237B79251E706A1BBE64BFB63501A6B101811CAEDFA3D25BDD8E2E1C3C9444216590A121386D90CEC6ED5ABEA2A64AF674EDA86A85F' +
  'BEBFE98864E4C3FE9DBC8057F0F7C08660787BF86003604DD1FD8346F6381FB07745AE04D736FCCC83426B33F01EAB71B08041873C005E5F77A057BEBDE8AE24' +
  '55464299BF582E614E58F48FF2DDFDA2F474EF388789BDC25366F9C3C8B38E74B475F25546FCD9B97AEB26618B1DDF84846A0E79915F95E2466E598E20B45770' +
  '8CD55591C902DE4CB90BACE1BB8205D011A862487574A99EB77F19B6E0A9DC09662D09A1C4324633E85A1F0209F0BE8C4A99A0251D6EFE101AB93D1D0BA5A4DF' +
  'A186F20F2868F169DCB7DA83573906FEA1E2CE9B4FCD7F5250115E01A70683FAA002B5C40DE6D0279AF88C27773F8641C3604C0661A806B5F0177A28C0F586E0' +
  '006058AA30DC7D6211E69ED72338EA6353C2DD94C2C21634BBCBEE5690BCB6DEEBFC7DA1CE591D766F05E4094B7C018839720A3D7C927C2486E3725F724D9DB9' +
  '1AC15BB4D39EB8FCED54557808FCA5B5D83D7CD34DAD0FC41E50EF5EB161E6F8A28514D96C51133C6FD5C7E756E14EC4362ABFCEDDC6C837D79A323492638212' +
  '670EFA8E406000E03A39CE37D3FAF5CFABC277375AC52D1B5CB0679E4FA33742D382274099BC9BBED5118E9DBF0F7315D62D1C7EC700C47BB78C1B6B21A19045' +
  'B26EB1BE6A366EB45748AB2FBC946E79C6A376D26549C2C8530FF8EE468DDE7DD5730A1D4CD04DC62939BBDBA9BA4650AC9526E8BE5EE304A1FAD5F06A2D519A' +
  '63EF8CE29A86EE22C089C2B843242EF6A51E03AA9CF2D0A483C061BA9BE96A4D8FE51550BA645BD62826A2F9A73A3AE14BA99586EF5562E9C72FEFD3F752F7DA' +
  '3F046F6977FA0A5980E4A91587B086019B09E6AD3B3EE593E990FD5A9E34D7972CF0B7D9022B8B5196D5AC3A017DA67DD1CF3ED67C7D2D281F9F25CFADF2B89B' +
  '5AD6B4725A88F54CE029AC71E019A5E647B0ACFDED93FA9BE8D3C48D283B57CCF8D5662979132E28785F0191ED756055F7960E44E3D35E8C15056DD488F46DBA' +
  '03A161250564F0BDC3EB9E153C9057A297271AECA93A072A1B3F6D9B1E6321F5F59C66FB26DCF3197533D928B155FDF5035634828ABA3CBB28517711C20AD9F8' +
  'ABCC5167CCAD925F4DE817513830DC8E379D58629320F991EA7A90C2FB3E7BCE5121CE64774FBE32A8B6E37EC3293D4648DE53696413E680A2AE0810DD6DB224' +
  '69852DFD09072166B39A460A6445C0DD586CDECF1C20C8AE5BBEF7DD1B588D40CCD2017F6BB4E3BBDDA26A7E3A59FF453E350A44BCB4CDD572EACEA8FA6484BB' +
  '8D6612AEBF3C6F47D29BE463542F5D9EAEC2771BF64E6370740E0D8DE75B1357F8721671AF537D5D4040CB084EB4E2CC34D2466A0115AF84E1B0042895983A1D' +
  '06B89FB4CE6EA0486F3F3B823520AB82011A1D4B277227F8611560B1E7933FDCBB3A792B344525BDA08839E151CE794B2F32C9B7A01FBAC9E01CC87EBCC7D1F6' +
  'CF0111C3A1E8AAC71A908749D44FBD9AD0DADECBD50ADA380339C32AC69136678DF9317CE0B12B4FF79E59B743F5BB3AF2D519FF27D9459CBF97222C15E6FC2A' +
  '0F91FC719B941525FAE59361CEB69CEBC2A8645912BAA8D1B6C1075EE3056A0C10D25065CB03A442E0EC6E0E1698DB3B4C98A0BE3278E9649F1F9532E0D392DF' +
  'D3A0342B8971F21E1B0A74414BA3348CC5BE7120C37632D8DF359F8D9B992F2EE60B6F470FE3F11DE54CDA541EDAD891CE6279CFCD3E7E6F1618B166FD2C1D05' +
  '848FD2C5F6FB2299F523F357A632762393A8353156CCCD02ACF081625A75EBB56E16369788D273CCDE96629281B949D04C50901B71C65614E6C6C7BD327A140A' +
  '45E1D006C3F27B9AC9AA53FD62A80F00BB25BFE235BDD2F671126905B2040222B6CBCF7CCD769C2B53113EC01640E3D338ABBD602547ADF0BA38209CF746CE76' +
  '77AFA1C52075606085CBFE4E8AE88DD87AAAF9B04CF9AA7E1948C25C02FB8A8C01C36AE4D6EBE1F990D4F869A65CDEA03F09252DC208E69FB74E6132CE77E25B' +
  '578FDFE33AC372E6'

interface BlowfishContext {
  p: Uint32Array // 18
  s: Uint32Array // 1024
}

function blowfishKeySchedule(key: Uint8Array): BlowfishContext {
  const init = new Uint32Array(1042)
  for (let i = 0; i < 1042; i++) init[i] = parseInt(BLOWFISH_INIT_HEX.slice(i * 8, i * 8 + 8), 16)
  const ctx: BlowfishContext = { p: init.slice(0, 18), s: init.slice(18) }
  // P 数组与密钥循环异或（大端 4 字节一组）
  let j = 0
  for (let i = 0; i < 18; i++) {
    let data = 0
    for (let k = 0; k < 4; k++) {
      data = (((data << 8) >>> 0) | key[j % key.length]!) >>> 0
      j++
    }
    ctx.p[i] = (ctx.p[i]! ^ data) >>> 0
  }
  // 标准 521 次迭代：用变换后的分组连续重加密 P 与 S
  let l = 0
  let r = 0
  for (let i = 0; i < 18; i += 2) {
    ;[l, r] = blowfishEncipherBlock(ctx, l, r)
    ctx.p[i] = l
    ctx.p[i + 1] = r
  }
  for (let box = 0; box < 4; box++) {
    for (let i = 0; i < 256; i += 2) {
      ;[l, r] = blowfishEncipherBlock(ctx, l, r)
      ctx.s[box * 256 + i] = l
      ctx.s[box * 256 + i + 1] = r
    }
  }
  return ctx
}

function bfF(ctx: BlowfishContext, x: number): number {
  const a = (x >>> 24) & 0xff
  const b = (x >>> 16) & 0xff
  const c = (x >>> 8) & 0xff
  const d = x & 0xff
  return ((((ctx.s[a]! + ctx.s[256 + b]!) >>> 0) ^ ctx.s[512 + c]!) + ctx.s[768 + d]!) >>> 0
}

// 返回 [L, R]。加密：16 轮 { l^=P[i]; r^=F(l); 交换 }，成对展开去交换：
//   l^=P[i]; r^=F(l); r^=P[i+1]; l^=F(r) ≡ 两轮（含交换）。
// 末尾按规格「撤销最后一次交换」：输出 = (xR16^P[16], xL16^P[15])→(r^P[17], l^P[16])（0 基下标）
function blowfishEncipherBlock(ctx: BlowfishContext, l: number, r: number): [number, number] {
  for (let i = 0; i < 16; i += 2) {
    l = (l ^ ctx.p[i]!) >>> 0
    r = (r ^ bfF(ctx, l)) >>> 0
    r = (r ^ ctx.p[i + 1]!) >>> 0
    l = (l ^ bfF(ctx, r)) >>> 0
  }
  const l16 = l
  l = (r ^ ctx.p[17]!) >>> 0
  r = (l16 ^ ctx.p[16]!) >>> 0
  return [l, r]
}

// 返回 [L, R]。解密 = P 数组逆序使用（j=17..3 成对展开），末尾撤销交换后异或 P[0]/P[1]
function blowfishDecipherBlock(ctx: BlowfishContext, l: number, r: number): [number, number] {
  for (let j = 17; j >= 3; j -= 2) {
    l = (l ^ ctx.p[j]!) >>> 0
    r = (r ^ bfF(ctx, l)) >>> 0
    r = (r ^ ctx.p[j - 1]!) >>> 0
    l = (l ^ bfF(ctx, r)) >>> 0
  }
  const l16 = l
  l = (r ^ ctx.p[0]!) >>> 0
  r = (l16 ^ ctx.p[1]!) >>> 0
  return [l, r]
}

function readU32be(b: Uint8Array, off: number): number {
  return (((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0)
}

function writeU32be(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff
  b[off + 1] = (v >>> 16) & 0xff
  b[off + 2] = (v >>> 8) & 0xff
  b[off + 3] = v & 0xff
}

/** Blowfish-ECB 加密单个 8 字节块（测试锚点用：官方 Blowfish 测试向量） */
export function blowfishEcbEncrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 8) throw new Error('Blowfish 块必须为 8 字节')
  const ctx = blowfishKeySchedule(key)
  const [l, r] = blowfishEncipherBlock(ctx, readU32be(block, 0), readU32be(block, 4))
  const out = new Uint8Array(8)
  writeU32be(out, 0, l)
  writeU32be(out, 4, r)
  return out
}

/** Blowfish-ECB 解密单个 8 字节块（测试锚点用：官方 Blowfish 测试向量） */
export function blowfishEcbDecrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== 8) throw new Error('Blowfish 块必须为 8 字节')
  const ctx = blowfishKeySchedule(key)
  const [l, r] = blowfishDecipherBlock(ctx, readU32be(block, 0), readU32be(block, 4))
  const out = new Uint8Array(8)
  writeU32be(out, 0, l)
  writeU32be(out, 4, r)
  return out
}

// ---------- 口令层原语（Authenticator.cs Decrypt(data, password, PBKDF2=true)） ----------

export const PBKDF2_ITERATIONS = 2000 // Authenticator.cs: private const int PBKDF2_ITERATIONS = 2000
// Authenticator.cs L70: private const int PBKDF2_KEYSIZE = 256 —— 配合 L1266/L1208 的
// kg.GetBytes(PBKDF2_KEYSIZE)：.NET DeriveBytes.GetBytes(int cb) 参数是「字节数」，
// 故实际派生 256 字节 Blowfish 密钥（BC 1.7.0 BlowfishEngine 无 56 字节上限，全 key 循环异或）。
export const PBKDF2_KEY_BYTES = 256

/**
 * 口令层密钥派生：Rfc2898DeriveBytes（默认 HMAC-SHA1）。
 * length/iterations 参数化仅为对齐 RFC 6070 测试向量；WinAuth 固定 2000 次 × 256 字节。
 */
export async function deriveExplicitKey(
  password: string,
  salt: Uint8Array,
  length: number,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  return (await pbkdf2({
    password: textEncoder.encode(password),
    salt,
    iterations,
    hashLength: length,
    hashFunction: createSHA1(), // hash-wasm 4.x 要求 IHasher 实例；SHA1 对齐 .NET Rfc2898DeriveBytes 默认
    outputType: 'binary',
  })) as Uint8Array
}

/** Blowfish-ECB 解密 + ISO10126d2 去填充；填充非法（口令错）抛 'password' 类错误 */
function blowfishDecryptIso10126(key: Uint8Array, cipher: Uint8Array): Uint8Array {
  if (cipher.length === 0 || cipher.length % 8 !== 0) throw new WinauthDecryptError('password')
  const ctx = blowfishKeySchedule(key)
  const out = new Uint8Array(cipher.length)
  for (let off = 0; off < cipher.length; off += 8) {
    const [l, r] = blowfishDecipherBlock(ctx, readU32be(cipher, off), readU32be(cipher, off + 4))
    writeU32be(out, off, l)
    writeU32be(out, off + 4, r)
  }
  // ISO10126d2：末字节 = 填充长度；BC 1.7.0 ISO10126d2Padding.PadCount 仅在
  // count > 可用长度时抛「pad block corrupted」（pad=0 合法=不去填充，官方 Decrypt
  // 的口令错最终由 DecryptSequence 的 SHA256 校验兜底）
  const pad = out[out.length - 1]!
  if (pad > out.length) throw new WinauthDecryptError('password')
  return out.slice(0, out.length - pad)
}

// ---------- DecryptSequence 移植（Authenticator.cs） ----------

const ENCRYPTION_HEADER = bytesToHex(textEncoder.encode('WINAUTH3')).toUpperCase()
// Authenticator.cs L75：ENCRYPTION_HEADER = ByteArrayToString(UTF8("WINAUTH3"))，
// ByteArrayToString（L934-937）经 BitConverter.ToString 输出大写 hex——真实 .wauth 密文整串全大写
const SALT_HEX_LEN = 8 * 2 // Authenticator.cs SALT_LENGTH = 8
const SHA256_HEX_LEN = 32 * 2 // SafeHasher("SHA256").HashSize/8*2

/** encrypted 属性串（Authenticator.cs DecodePasswordTypes）：y=Explicit、u=User(DPAPI)、m=Machine(DPAPI)、a/b=YubiKey */
interface PasswordTypes {
  explicit: boolean
  user: boolean
  machine: boolean
  yubi: boolean
}

function decodePasswordTypes(encrypted: string | undefined): PasswordTypes {
  const s = encrypted ?? ''
  return {
    explicit: s.includes('y'),
    user: s.includes('u'),
    machine: s.includes('m'),
    yubi: s.includes('a') || s.includes('b'),
  }
}

interface DecryptOptions {
  password?: string
  decryptDpapi?: (b64: string) => Promise<string>
}

/** DPAPI 层：hex 载荷 → base64 交桌面 CryptUnprotectData → 明文（恒为 hex ASCII）转回 hex */
async function dpapiLayer(dataHex: string, opts: DecryptOptions): Promise<string> {
  if (!opts.decryptDpapi) throw new WinauthDecryptError('dpapi')
  const plainText = await opts.decryptDpapi(bytesToBase64(hexToBytes(dataHex)))
  return bytesToHex(textEncoder.encode(plainText))
}

/** 口令层（Authenticator.cs Decrypt(data, password, PBKDF2=true)，L1250-1309） */
async function explicitLayer(dataHex: string, opts: DecryptOptions): Promise<string> {
  if (!opts.password) throw new WinauthDecryptError('password')
  const salt = hexToBytes(dataHex.slice(0, SALT_HEX_LEN))
  // L1264-1266：GetBytes(PBKDF2_KEYSIZE=256) → 256 字节密钥（非 256 bit）
  const key = await deriveExplicitKey(opts.password, salt, PBKDF2_KEY_BYTES)
  const plain = blowfishDecryptIso10126(key, hexToBytes(dataHex.slice(SALT_HEX_LEN)))
  return bytesToHex(plain)
}

/** Authenticator.cs DecryptSequenceNoHash：按 Machine→User→Explicit→Yubi 逆序解层 */
async function decryptSequenceNoHash(dataHex: string, types: PasswordTypes, opts: DecryptOptions): Promise<string> {
  let data = dataHex.trim()
  if (types.machine) data = await dpapiLayer(data, opts)
  if (types.user) data = await dpapiLayer(data, opts)
  if (types.explicit) data = await explicitLayer(data, opts)
  if (types.yubi) throw new WinauthDecryptError('yubi')
  return data
}

/** Authenticator.cs DecryptSequence（L948-980）：剥 WINAUTH3 头 + salt + SHA256，解层后校验哈希（口令错判定点） */
async function decryptSequence(dataHex: string, encrypted: string | undefined, opts: DecryptOptions): Promise<string> {
  const types = decodePasswordTypes(encrypted)
  const data = dataHex.trim()
  // 大小写不敏感剥头：真实文件密文整串大写（BitConverter），小写输入（历史 fixture/手构造）同样接受；
  // 不匹配走 v2 无头路径（ReadXmlv2 的旧 secretdata）
  if (data.slice(0, ENCRYPTION_HEADER.length).toUpperCase() !== ENCRYPTION_HEADER) {
    return decryptSequenceNoHash(data, types, opts)
  }
  const salt = data.slice(ENCRYPTION_HEADER.length, ENCRYPTION_HEADER.length + SALT_HEX_LEN)
  const hashStart = ENCRYPTION_HEADER.length + SALT_HEX_LEN
  const hash = data.slice(hashStart, hashStart + SHA256_HEX_LEN)
  const payload = data.slice(hashStart + SHA256_HEX_LEN)
  const decrypted = await decryptSequenceNoHash(payload, types, opts)
  // 哈希 = SHA256(hex_decode(salt + 解密结果 hex))；不匹配即口令错（BadPasswordException）
  const compare = await sha256Hex(hexToBytes(salt + decrypted))
  if (compare.toUpperCase() !== hash.toUpperCase()) throw new WinauthDecryptError('password')
  return decrypted
}

/**
 * 按 EncryptSequence 布局构造密文序列（无 DPAPI/YubiKey 层，测试构造 fixture 用）：
 * HEADER + hex(salt 8B) + hex(SHA256(salt||payload)) + payload，payload 按 encrypted 串做口令层
 * （Authenticator.cs Encrypt(plain, password)：hex(salt) + hex(Blowfish(ISO10126 填充))；
 * 随机盐与随机填充位取 0，保证 fixture 确定性）。
 */
/**
 * 按 EncryptSequence（Authenticator.cs L1114-1184）布局构造密文序列（无 DPAPI/YubiKey 层，测试构造 fixture 用）：
 * HEADER + hex(salt 8B) + hex(SHA256(salt‖明文hex)) + payload，payload 按 encrypted 串做口令层
 * （L1192-1211 Encrypt(plain, password)：hex(salt)+hex(Blowfish(ISO10126 填充))；
 * 密钥 = L1266 GetBytes(PBKDF2_KEYSIZE=256) → 256 字节）。
 * 盐/填充随机位取 0；序列整体大写（对齐真实文件 ByteArrayToString 输出），保证测试走大写剥头路径。
 */
export async function buildWinauthSequence(payloadHex: string, encrypted: string, password?: string): Promise<string> {
  const types = decodePasswordTypes(encrypted)
  // 官方 EncryptSequence 顺序：先对 (salt + 明文 hex) 计算 SHA256，再对各层加密
  const salt = new Uint8Array(8) // fixture 专用零盐
  const saltHex = bytesToHex(salt)
  const hash = await sha256Hex(hexToBytes(saltHex + payloadHex))
  let payload = payloadHex
  if (types.explicit) {
    if (!password) throw new Error('buildWinauthSequence: explicit 层需要口令')
    const innerSalt = new Uint8Array(8)
    const key = await deriveExplicitKey(password, innerSalt, PBKDF2_KEY_BYTES)
    const plain = hexToBytes(payload)
    const padLen = 8 - (plain.length % 8)
    const padded = new Uint8Array(plain.length + padLen)
    padded.set(plain)
    padded[plain.length + padLen - 1] = padLen
    const out = new Uint8Array(padded.length)
    const ctx = blowfishKeySchedule(key)
    for (let off = 0; off < padded.length; off += 8) {
      const [l, r] = blowfishEncipherBlock(ctx, readU32be(padded, off), readU32be(padded, off + 4))
      writeU32be(out, off, l)
      writeU32be(out, off + 4, r)
    }
    payload = bytesToHex(innerSalt) + bytesToHex(out)
  }
  return (ENCRYPTION_HEADER + saltHex + hash + payload).toUpperCase()
}

// ---------- 极简 XML 解析（WinAuth 导出为良构 XML，无需完整 XML 解析器） ----------

interface MiniXmlNode {
  name: string
  attrs: Record<string, string>
  text: string
  children: MiniXmlNode[]
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, (m, e: string) => {
    switch (e) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
    }
  })
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(raw)) !== null) attrs[m[1]!] = decodeXmlEntities(m[2] ?? m[3] ?? '')
  return attrs
}

function parseXml(input: string): MiniXmlNode {
  let s = input.replace(/^\uFEFF/, '')
  s = s.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '')
  const doc: MiniXmlNode = { name: '#doc', attrs: {}, text: '', children: [] }
  const stack: MiniXmlNode[] = [doc]
  const tokenRe = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\/([A-Za-z_][\w.:-]*)\s*>|<!\[CDATA\[([\s\S]*?)\]\]>/g
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(s)) !== null) {
    const top = stack[stack.length - 1]!
    top.text += decodeXmlEntities(s.slice(pos, m.index))
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
  doc.text += decodeXmlEntities(s.slice(pos))
  if (doc.children.length !== 1) throw new Error('XML 必须有唯一根元素')
  return doc.children[0]!
}

function child(node: MiniXmlNode, name: string): MiniXmlNode | undefined {
  return node.children.find((c) => c.name === name)
}

// ---------- 条目映射（WinAuth JSON/secretdata → ParsedEntry） ----------

/** 简报约定的单条输入形状：raw=authenticatordata 原始内容，encrypted 标记保护层 */
export interface WinauthEntryInput {
  raw: string
  encrypted?: 'dpapi' | 'password' | null
  password?: string
}

function normalizeTypeAttr(typeAttr: string | undefined): ParsedEntry['type'] {
  const t = typeAttr ?? ''
  if (t.includes('SteamAuthenticator')) return 'steam'
  if (t.includes('HOTPAuthenticator')) return 'hotp'
  return 'totp'
}

/**
 * SecretData → ParsedEntry（Authenticator.cs SecretData / HOTPAuthenticator.cs SecretData）。
 * 返回 ParsedEntry 或错误消息。
 */
function mapSecretData(secretDataText: string, name: string, typeAttr: string | undefined): ParsedEntry | { error: string } {
  const text = secretDataText.trim()
  const pipeParts = text.split('|')
  const fields = pipeParts[0]!.split('\t')
  let secretBytes: Uint8Array
  try {
    secretBytes = hexToBytes(fields[0] ?? '')
  } catch {
    return { error: 'secretdata 非法' }
  }
  if (secretBytes.length === 0) return { error: '缺少 secret' }

  const type = normalizeTypeAttr(typeAttr)
  const parsed: ParsedEntry = {
    type,
    // name 拆 issuer:label（与 Aegis/URI 导入口径一致：首个冒号）
    issuer: name.includes(':') ? name.slice(0, name.indexOf(':')) : '',
    label: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
    // 统一存储口径：secret 还原为字节后 base32（RFC4648 大写）——见简报与 base32Encode
    secret: base32Encode(secretBytes),
    algorithm: fields[2] === 'SHA256' || fields[2] === 'SHA512' ? fields[2] : 'SHA1',
    digits: type === 'steam' ? 5 : Number.parseInt(fields[1] ?? '', 10) > 0 ? Number.parseInt(fields[1]!, 10) : 6,
    period: Number.parseInt(fields[3] ?? '', 10) > 0 ? Number.parseInt(fields[3]!, 10) : 30,
  }
  if (pipeParts.length > 1) {
    const counter = Number.parseInt(pipeParts[1]!, 10)
    if (Number.isFinite(counter) && counter >= 0) parsed.counter = counter
  }
  return parsed
}

function failureMessage(e: unknown): string {
  if (e instanceof WinauthDecryptError) {
    if (e.kind === 'dpapi') return MSG_DPAPI
    if (e.kind === 'yubi') return MSG_YUBI
    return MSG_PASSWORD
  }
  if (e instanceof Error && e.message === '非法 hex') return MSG_PASSWORD // hex 损坏多因口令错/文件损坏
  return '条目解析失败'
}

// ---------- 主流程 ----------

interface ImportContext extends DecryptOptions {
  result: ImportResult
  ordinal: number
}

/** authenticatordata 节点（可能已解密）→ 条目或失败 */
function parseAuthenticatorData(data: MiniXmlNode, name: string, typeAttr: string | undefined, ctx: ImportContext): void {
  const index = ctx.ordinal++
  const secretNode = child(data, 'secretdata')
  if (!secretNode) {
    ctx.result.failures.push({ index, message: '缺少 secret' })
    return
  }
  const mapped = mapSecretData(secretNode.text, name, typeAttr)
  if ('error' in mapped) ctx.result.failures.push({ index, message: mapped.error })
  else ctx.result.entries.push(mapped)
}

/** WinAuthAuthenticator 节点 → 条目或失败；authenticatordata 加密时按层解密 */
async function readWinauthAuthenticator(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  const index = ctx.ordinal++
  const name = child(el, 'name')?.text ?? ''
  const typeAttr = el.attrs.type
  const authData = child(el, 'authenticatordata')
  if (!authData) {
    ctx.result.failures.push({ index, message: '缺少 authenticatordata' })
    return
  }
  const encrypted = authData.attrs.encrypted
  if (!encrypted) {
    ctx.ordinal-- // 未消耗失败位：交由 parseAuthenticatorData 统一编号
    parseAuthenticatorData(authData, name, typeAttr, ctx)
    return
  }
  try {
    const innerHex = await decryptSequence(authData.text, encrypted, ctx)
    const inner = parseXml(textDecoder.decode(hexToBytes(innerHex)))
    ctx.ordinal--
    parseAuthenticatorData(inner, name, typeAttr, ctx)
  } catch (e) {
    ctx.result.failures.push({ index, message: failureMessage(e) })
  }
}

/**
 * 配置容器（<WinAuth> 根 / 解密出的 <config> / 解密出的 <WinAuth>）：
 * WinAuthConfig.cs ReadXmlInternal 的读取分派。
 */
async function readConfigContainer(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  // 旧布局：密文直接是 <WinAuth> 根元素文本（WinAuthConfig.cs ReadXmlInternal 根节点 encrypted 分支）
  if (el.attrs.encrypted && el.text.trim() !== '') {
    const dataEl: MiniXmlNode = { name: 'data', attrs: { encrypted: el.attrs.encrypted }, text: el.text, children: [] }
    await readDataElement(dataEl, ctx)
  }
  for (const c of el.children) {
    switch (c.name) {
      case 'config':
      case 'WinAuth':
        await readConfigContainer(c, ctx)
        break
      case 'data':
        await readDataElement(c, ctx)
        break
      case 'WinAuthAuthenticator':
        await readWinauthAuthenticator(c, ctx)
        break
      default:
        break // alwaysontop/usetrayicon/settings 等应用设置忽略
    }
  }
}

/** <data encrypted="..."> 整包加密（v3.2+）：解出内层 XML 后按容器继续读 */
async function readDataElement(el: MiniXmlNode, ctx: ImportContext): Promise<void> {
  if (!el.attrs.encrypted) return // 官方读取端对无 encrypted 的 data 节点不做处理
  try {
    const innerHex = await decryptSequence(el.text, el.attrs.encrypted, ctx)
    const inner = parseXml(textDecoder.decode(hexToBytes(innerHex)))
    await readConfigContainer(inner, ctx)
  } catch (e) {
    // 整包失败无法逐条拆分：记一条 failure（index 0），消息按分类
    ctx.result.failures.push({ index: 0, message: failureMessage(e) })
  }
}

/**
 * WinAuth 配置导入：解析 <WinAuth> XML，支持明文条目、条目级 authenticatordata 加密
 * 与整包 <data> 加密；口令层用官方算法（PBKDF2-HMAC-SHA1×2000 + Blowfish/ISO10126），
 * DPAPI 层通过 opts.decryptDpapi 回调（桌面端 Rust CryptUnprotectData），插件端不提供
 * 则逐条 failure「请用桌面版导入」。
 */
export async function importWinauth(text: string, opts: { password?: string; decryptDpapi?: (b64: string) => Promise<string> } = {}): Promise<ImportResult> {
  let root: MiniXmlNode
  try {
    root = parseXml(text)
  } catch {
    throw new Error('WinAuth 文件结构非法：不是合法 XML')
  }
  const ctx: ImportContext = { ...opts, result: { entries: [], failures: [] }, ordinal: 0 }
  await readConfigContainer(root, ctx)
  return ctx.result
}
