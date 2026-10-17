/**
 * 整组许可的本机廉价查询。公钥随 started 固定，私钥仅经包装器到原生宿主的私有 stdin 传递，
 * 不进环境、磁盘或日志。每次新挑战签名绑定 OS 管道客户端 PID；冒用环境、假管道及旧回复均无效。
 * 宿主仍逐跳核对出生身份并额外核对作业对象成员关系；消费者从不拿作业句柄。
 */
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { isUtf8 } from 'node:buffer'
import type { PermitVerifier, AttemptController } from './sched-contract'
import type { PermitProcess } from './sched-permit-ancestry'

export interface PermitAuthority {
  verifier: PermitVerifier; privateKey: string; owner: { pid: number; creationFileTime: string }
}
const PERMIT_MODULUS_BITS = 2048
/** RSA 私钥 JWK 里本函数要读的八个分量（base64url）；只描述用到的字段，不依赖 @types/node 是否导出 JsonWebKey。 */
export type RsaPrivateJwk = { n?: string; e?: string; p?: string; q?: string; dp?: string; dq?: string; qi?: string; d?: string }

/**
 * JWK 私钥 → .NET `RSA.FromXmlString` 认的 `<RSAKeyValue>`（卡 SCHED-PERMIT-AUTHORITY-RSA-XML-LENGTH）。
 * JWK 分量按 RFC 7518 §6.3 是「无前导零字节」的大端整数，而 .NET `RSACryptoServiceProvider.ImportParameters`
 * 要求定长：Modulus / D 恰好 modulusBytes，P / Q / DP / DQ / InverseQ 恰好 modulusBytes/2（Exponent 可变长）。
 * 某分量最高字节恰为 0x00 时（每把密钥约 2%）就少一个字节，原生宿主起不来（Bad Data），验收整组退回裸跑被
 * T5 拦下假红——这里按期望长度左补零；剥掉前导零后仍超长或分量缺失一律抛错，不静默截断。
 */
export function rsaKeyValueXml(key: RsaPrivateJwk, modulusBytes: number): string {
  const half = modulusBytes / 2
  const fields: [name: string, value: string | undefined, length: number | null][] = [
    ['Modulus', key.n, modulusBytes], ['Exponent', key.e, null], ['P', key.p, half], ['Q', key.q, half],
    ['DP', key.dp, half], ['DQ', key.dq, half], ['InverseQ', key.qi, half], ['D', key.d, modulusBytes]]
  return '<RSAKeyValue>' + fields.map(([name, value, length]) => {
    if (value === undefined) throw new Error(`[sched] 许可密钥分量缺失:${name}`)
    const raw = Buffer.from(value, 'base64url')
    let start = 0
    while (start < raw.length - 1 && raw[start] === 0) start++
    const bytes = raw.subarray(start)
    if (length !== null && bytes.length > length) throw new Error(`[sched] 许可密钥分量长度非法:${name}`)
    const fixed = length === null ? bytes : Buffer.concat([Buffer.alloc(length - bytes.length), bytes])
    return `<${name}>${fixed.toString('base64')}</${name}>`
  }).join('') + '</RSAKeyValue>'
}

/** 密钥/挑战随机数只在 OS 认证边界产生，不进入调度业务时钟或游戏 seed。 */
export function createPermitAuthority(owner: PermitAuthority['owner']): PermitAuthority {
  const keys = generateKeyPairSync('rsa', { modulusLength: PERMIT_MODULUS_BITS })
  return { owner, verifier: { pipe: `sched-permit-${randomBytes(24).toString('hex')}`,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  privateKey: rsaKeyValueXml(keys.privateKey.export({ format: 'jwk' }), PERMIT_MODULUS_BITS / 8) }
}

// 兼容 T5 的同步 validatePermit：仅 I/O worker 等本机管道，2500ms 内明确拒绝，早于 T5 外层 3500ms。
// 不起 PowerShell/CIM/任何子进程。线程 unref 且每次 finally 终止，不遗留消费者看护线程。
const pipeWorker = `
const { workerData } = require('node:worker_threads');
const { connect } = require('node:net');
const signal = new Int32Array(workerData.memory, 0, 2), bytes = new Uint8Array(workerData.memory, 8);
let settled = false, pending = '';
const socket = connect(workerData.pipe);
function finish(value) {
  if (settled) return; settled = true;
  const output = Buffer.from(JSON.stringify(value));
  if (output.length <= bytes.length) { bytes.set(output); Atomics.store(signal, 1, output.length); }
  Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); socket.destroy();
}
socket.setEncoding('utf8'); socket.setTimeout(2000, () => finish({ error: 'pipe timeout' }));
socket.once('connect', () => socket.write(workerData.request + '\\n'));
socket.on('data', chunk => {
  pending += chunk;
  if (pending.length > bytes.length) return finish({ error: 'oversized proof' });
  const end = pending.indexOf('\\n');
  if (end >= 0) finish({ line: pending.slice(0, end) });
});
socket.once('error', error => finish({ error: error.message }));
socket.once('end', () => finish({ error: 'incomplete proof' }));
`

export function queryPermitAuthority(verifier: PermitVerifier, nonce: string, pid: number): string {
  if (!/^sched-permit-[0-9a-f]{48}$/.test(verifier.pipe)) throw new Error('[sched] 归属管道标识非法')
  const memory = new SharedArrayBuffer(128 * 1024 + 8), signal = new Int32Array(memory, 0, 2)
  const worker = new Worker(pipeWorker, { eval: true, execArgv: [], workerData: {
    memory, pipe: `\\\\.\\pipe\\${verifier.pipe}`, request: `${nonce} ${pid}`,
  } })
  worker.on('error', () => { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0) }); worker.unref()
  try {
    if (Atomics.wait(signal, 0, 0, 2500) === 'timed-out') throw new Error('[sched] 归属管道超时')
    const length = Atomics.load(signal, 1)
    if (length <= 0 || length > memory.byteLength - 8) throw new Error('[sched] 归属管道无有效回复')
    const reply = JSON.parse(Buffer.from(memory, 8, length).toString('utf8')) as { line?: string; error?: string }
    if (reply.error || !reply.line) throw new Error(`[sched] 归属管道拒绝:${reply.error ?? '空回复'}`)
    return reply.line
  } finally { void worker.terminate() }
}

/** 验签之后才解释行格式；最终出生时间/祖先顺序仍交原来的 verifyPermitAncestry 判据核对。 */
export function decodePermitProof(line: string, verifier: PermitVerifier, nonce: string, pid: number): PermitProcess[] {
  const parts = line.split('.')
  if (parts.length !== 2 || parts.some(value => !/^[A-Za-z0-9+/=]+$/.test(value))) throw new Error('[sched] 归属签名格式非法')
  const payload = Buffer.from(parts[0]!, 'base64'), signature = Buffer.from(parts[1]!, 'base64')
  if (!verify('sha256', payload, verifier.publicKey, signature) || !isUtf8(payload)) throw new Error('[sched] 归属签名不符')
  const [version, challenge, caller, encoded, extra] = payload.toString('utf8').split('|')
  if (version !== '1' || challenge !== nonce || caller !== String(pid) || !encoded || extra !== undefined) throw new Error('[sched] 归属回复过期或不属于当前消费者')
  const rows = encoded.split(';').map(value => {
    const [member, parent, creationFileTime, command, overflow] = value.split(',')
    if (overflow !== undefined || !/^\d+$/.test(member ?? '') || !/^\d+$/.test(parent ?? '')
      || !/^[1-9]\d*$/.test(creationFileTime ?? '') || command === undefined) throw new Error('[sched] 归属成员字段非法')
    const bytes = Buffer.from(command, 'base64')
    if (!isUtf8(bytes)) throw new Error('[sched] 归属命令行编码非法')
    return { pid: Number(member), ppid: Number(parent), creationFileTime: creationFileTime!, command: bytes.toString('utf8') }
  })
  if (rows.length > 129 || new Set(rows.map(row => row.pid)).size !== rows.length) throw new Error('[sched] 归属成员越界或重复')
  return rows
}

export function authorityPermitProcesses(controller: Pick<AttemptController, 'verifier'>): PermitProcess[] {
  if (!controller.verifier) throw new Error('[sched] 缺少本次执行的归属核验端')
  const nonce = randomBytes(32).toString('hex')
  return decodePermitProof(queryPermitAuthority(controller.verifier, nonce, process.pid), controller.verifier, nonce, process.pid)
}
