/**
 * cua-sidecar-client-pre — CUA Python worker 的传输客户端（原型）。
 *
 * 与 dsh-auto-memory 的 python-sidecar-client-pre.js 同一套纪律，协议自持：
 *   - no-shell spawn + stdin/stdout 单行 JSONL；worker 以 --expect-epoch 启动，
 *     入站帧 epoch 不匹配即丢弃（fail closed）；stdin EOF 即 worker 自然退出。
 *   - request() 永不 reject：结构化结果 {ok:true,payload} | {ok:false,code,...}。
 *   - 帧纪律：partial/multiple 行重组、单行 256KiB 上限（超限 fatal 重启）、
 *     坏 JSON / 坏 envelope / 错 epoch / 未知 requestId 全部计账丢弃。
 *   - 断路器：连续失败达阈值后熔断冷却，期间直接 circuit-open 不再 spawn。
 * 无 shell；无 HTTP；stdout 只进协议解析器；stderr 有界留尾诊断。UTF-8。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULTS = {
  requestTimeoutMs: 20000,
  maxLineBytes: 256 * 1024,
  breakerFailureThreshold: 3,
  breakerCooldownMs: 30000,
  maxPendingRequests: 4,
}

/** 捆绑 worker 的默认绝对路径（python/worker_cua_v2.py）。 */
export function defaultWorkerScriptPathPre() {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'python', 'worker_cua_v2.py')
  } catch (_) { return '' }
}

const FAILURE_CODES = new Set(['timeout', 'crashed', 'unavailable', 'protocol', 'line-oversize'])

export function createCuaSidecarClientPre(opts = {}) {
  const opt = (k) => {
    const v = opts[k]
    return typeof v === 'function' ? v() : (v === undefined ? undefined : v)
  }

  let disposed = false
  let child = null
  let epoch = null
  let buffer = Buffer.alloc(0)
  let stderrTail = ''
  let reqCounter = 0
  let exitHookInstalled = false
  const pending = new Map()
  const writeChain = Promise.resolve()
  void writeChain // 保留串行写语义占位（当前每请求一写，天然串行）
  const breaker = { consecutiveFailures: 0, openUntil: 0 }
  const stats = {
    starts: 0, exits: 0, framesIn: 0, requests: 0, succeeded: 0,
    dropped: { badJson: 0, badEnvelope: 0, staleEpoch: 0, unknownRequest: 0 },
    failed: { timeout: 0, crashed: 0, unavailable: 0, protocol: 0, lineoversize: 0, circuitopen: 0, disposed: 0, backpressure: 0 },
    lastExit: null, lastError: null,
  }

  function noteFailure(code) {
    if (!FAILURE_CODES.has(code)) return
    breaker.consecutiveFailures++
    if (breaker.consecutiveFailures >= Number(opt('breakerFailureThreshold') ?? DEFAULTS.breakerFailureThreshold)) {
      breaker.openUntil = Date.now() + Number(opt('breakerCooldownMs') ?? DEFAULTS.breakerCooldownMs)
    }
  }
  function breakerOpen() { return Date.now() < breaker.openUntil }

  function ensureStarted() {
    if (disposed) return { ok: false, code: 'disposed' }
    if (child && (child.killed || (child.stdin && child.stdin.destroyed))) {
      try { child.kill() } catch (_) {}
      child = null
      epoch = null
    }
    if (child) return { ok: true }
    const scriptPath = String(opt('scriptPath') || '')
    const command = String(opt('command') || 'python')
    if (!scriptPath) return { ok: false, code: 'unavailable' }
    epoch = 'cua_pre_' + randomBytes(16).toString('hex')
    let proc
    try {
      proc = spawn(command, [scriptPath, '--expect-epoch', epoch], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (_) {
      epoch = null
      noteFailure('unavailable')
      return { ok: false, code: 'unavailable' }
    }
    child = proc
    stats.starts++
    if (!exitHookInstalled) {
      // 兜底保险：宿主进程退出而 dispose 未被调用时（如崩溃/遗漏），同步杀树防孤儿。
      exitHookInstalled = true
      process.on('exit', () => {
        if (!child) return
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 3000 }) } catch (_) {}
      })
    }
    proc.stdout.on('data', (chunk) => { try { feed(chunk) } catch (_) { fatal() } })
    proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096) })
    proc.on('error', () => {
      child = null
      epoch = null
      rejectAll('unavailable')
      noteFailure('unavailable')
    })
    proc.on('exit', (code, signalName) => {
      if (child !== proc) return
      child = null
      epoch = null
      buffer = Buffer.alloc(0)
      stats.exits++
      stats.lastExit = { code, signal: signalName }
      rejectAll('crashed')
    })
    return { ok: true }
  }

  function rejectAll(code) {
    for (const [, entry] of pending) settle(entry, { ok: false, code })
    noteFailure(code)
  }

  function fatal() {
    buffer = Buffer.alloc(0)
    if (child) { try { child.stdin.destroy() } catch (_) {} try { child.kill() } catch (_) {} }
    rejectAll('protocol')
  }

  function feed(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    const cap = Number(opt('maxLineBytes') ?? DEFAULTS.maxLineBytes)
    for (;;) {
      const idx = buffer.indexOf(10)
      if (idx === -1) {
        if (buffer.length > cap) { stats.failed.lineoversize++; fatal() }
        return
      }
      const line = buffer.subarray(0, idx)
      buffer = buffer.subarray(idx + 1)
      if (line.length > cap) { stats.failed.lineoversize++; fatal(); return }
      handleLine(line)
    }
  }

  function handleLine(line) {
    stats.framesIn++
    let obj
    try { obj = JSON.parse(line.toString('utf8')) } catch (_) { stats.dropped.badJson++; return }
    if (!obj || typeof obj !== 'object') { stats.dropped.badEnvelope++; return }
    if (obj.v !== 1 || !['res', 'err', 'evt'].includes(obj.dir)) { stats.dropped.badEnvelope++; return }
    if (epoch !== null && obj.epoch !== epoch) { stats.dropped.staleEpoch++; return }
    if (obj.dir === 'evt') return // worker ready 等事件帧：仅计账
    const entry = pending.get(String(obj.requestId))
    if (!entry) { stats.dropped.unknownRequest++; return }
    if (obj.dir === 'err') {
      const err = obj.error || {}
      settle(entry, { ok: false, code: 'worker-error', reason: String(err.code || 'error'), reasonText: String(err.message || '') })
      return
    }
    settle(entry, { ok: true, payload: obj.payload ?? {} })
  }

  function settle(entry, result) {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(entry.requestId)
    if (result.ok) { stats.succeeded++; breaker.consecutiveFailures = 0 }
    else if (result.code !== 'worker-error') {
      // 业务错误(worker-error)是健康的协议往返，不计入断路器；传输层失败才计。
      if (stats.failed[result.code] === undefined) stats.failed.protocol++
      else stats.failed[result.code]++
      noteFailure(result.code)
    }
    entry.resolve(result)
  }

  function writeFrame(frame) {
    if (!child || !child.stdin || child.stdin.destroyed) return false
    const line = Buffer.from(JSON.stringify(frame) + '\n', 'utf8')
    child.stdin.write(line)
    return true
  }

  /**
   * 结构化请求：resolve({ok:true,payload}) 或 resolve({ok:false,code,...})；永不 reject。
   * worker-error 时附带 code='worker-error', reason=业务错误码, reasonText=可读信息。
   */
  function request(op, payload, rOpts = {}) {
    if (disposed) return Promise.resolve({ ok: false, code: 'disposed' })
    if (breakerOpen()) {
      stats.failed.circuitopen++
      return Promise.resolve({ ok: false, code: 'circuit-open', retryInMs: breaker.openUntil - Date.now() })
    }
    const started = ensureStarted()
    if (!started.ok) {
      stats.failed[started.code] = (stats.failed[started.code] || 0) + 1
      return Promise.resolve({ ok: false, code: started.code })
    }
    if (pending.size >= Number(opt('maxPendingRequests') ?? DEFAULTS.maxPendingRequests)) {
      stats.failed.backpressure++
      return Promise.resolve({ ok: false, code: 'backpressure' })
    }
    const requestId = 'cq_' + randomBytes(9).toString('hex') + (++reqCounter).toString(36)
    const frame = { v: 1, dir: 'req', requestId, epoch, op, payload: payload ?? {} }
    return new Promise((resolve) => {
      const entry = { requestId, expectedOp: op, resolve, settled: false, timer: null }
      pending.set(requestId, entry)
      stats.requests++
      const written = writeFrame(frame)
      if (!written) { settle(entry, { ok: false, code: 'unavailable' }); return }
      const timeoutMs = Math.max(1, Number(rOpts.timeoutMs) || Number(opt('requestTimeoutMs') ?? DEFAULTS.requestTimeoutMs))
      entry.timer = setTimeout(() => {
        settle(entry, { ok: false, code: 'timeout', timeoutMs })
        // cancel 通知：同 requestId 的 no-op 请求让 worker 跳过慢操作的结果写入
        writeFrame({ v: 1, dir: 'req', requestId: 'cx_' + randomBytes(8).toString('hex'), epoch, op: 'noop', payload: {} })
      }, timeoutMs)
    })
  }

  function health(rOpts = {}) { return request('health', {}, rOpts) }

  /** Windows 下 child.kill() 只打直接子进程，杀不死 venv 转发器下的真实解释器；
   * 用 taskkill /T /F 清整棵树，stdin 先 end() 给 worker 一个优雅 EOF 机会。 */
  function killTree(proc) {
    if (!proc) return
    try { proc.stdin.end() } catch (_) {}
    try {
      const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false, windowsHide: true })
      tk.on('error', () => { try { proc.kill() } catch (_) {} })
    } catch (_) {
      try { proc.kill() } catch (_) {}
    }
  }

  /** 刻意重启：旧 epoch 作废、in-flight 全部 rejected；下次请求以新 epoch 重生（状态机同时清空）。 */
  function restart(reason) {
    if (child) killTree(child)
    child = null
    epoch = null
    stats.restarts = (stats.restarts || 0) + 1
    void reason
  }

  function dispose(reason) {
    if (disposed) return
    disposed = true
    killTree(child)
    child = null
    epoch = null
    for (const [, entry] of [...pending]) settle(entry, { ok: false, code: 'disposed' })
    void reason
  }

  function debugView() {
    return {
      started: !!child,
      epoch: epoch ? epoch.slice(0, 12) + '…' : null,
      pending: pending.size,
      breaker: { open: breakerOpen(), consecutiveFailures: breaker.consecutiveFailures, openUntil: breaker.openUntil },
      stderrTailBytes: stderrTail.length,
      stats: JSON.parse(JSON.stringify(stats)),
    }
  }

  return {
    kind: 'cua-sidecar-pre',
    request, health, restart, dispose, debugView, isStarted: () => !!child,
    processForTest: () => child,
  }
}
