/**
 * cua-session-pre — 会话状态机（zcode-cua AccessibilitySession 的移植子集）。
 *
 * 移植的语义：
 *   - state_id `s-N` 单调递增 + LRU（容量淘汰最旧）
 *   - superseded：变更动作进入原生调用后，同 scope 旧观察全部失去执行权
 *   - refreshRequired：post-observe 前该 pid 拒绝一切元素写入
 *   - FrameRegistry：截图帧 frame-xxxxxxxx，带 session/generation/transform_version/TTL，
 *     zoom 从已有帧裁剪而非重新截屏；坐标软绑定最近帧
 *   - repeat observation：连续相同观察计数（供响应携带 repeat_observation 标志）
 *   - inputState：left_mouse_down/up 配对守卫
 */

import { randomUUID } from 'node:crypto'

const DEFAULTS = { maxStates: 16, maxFrames: 12, frameTtlMs: 60000 }
const FRAME_PIXEL_TRANSFORM_VERSION = 'win-dpi-v1'

export function createCuaSessionPre(opts = {}) {
  const opt = (k, dflt) => {
    const v = typeof opts[k] === 'function' ? opts[k]() : opts[k]
    return v === undefined ? dflt : v
  }
  const maxStates = Number(opt('maxStates', DEFAULTS.maxStates))
  const maxFrames = Number(opt('maxFrames', DEFAULTS.maxFrames))
  const frameTtlMs = Number(opt('frameTtlMs', DEFAULTS.frameTtlMs))

  const sessionId = 'session-' + randomUUID()
  const entries = new Map() // state_id -> {sel, elements, issuedAt}
  const superseded = new Set()
  const refreshLocks = new Set() // pid
  const frames = new Map() // frame_id -> descriptor
  let counter = 0
  let frameGeneration = 0
  let selectedDisplayIndex = null
  let lastObservationKey = null
  let observationRepeatCount = 0

  const session = {
    kind: 'cua-session-pre',
    sessionId,

    // ---------- 状态 ----------
    nextStateId() {
      counter += 1
      return 's-' + counter
    },

    remember(sel, elements) {
      const stateId = session.nextStateId()
      const rec = { sel, elements, stateId, issuedAt: Date.now() }
      if (entries.has(stateId)) entries.delete(stateId)
      entries.set(stateId, rec)
      superseded.delete(stateId)
      while (entries.size > maxStates) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
        superseded.delete(oldest)
      }
      refreshLocks.delete(sel.pid)
      return rec
    },

    /** 取可用状态；被 supersede 的视为不存在（fail closed）。 */
    get(stateId) {
      const sid = String(stateId || '')
      if (!superseded.has(sid) && entries.has(sid)) return entries.get(sid)
      return null
    },

    isSuperseded(stateId) { return superseded.has(String(stateId || '')) },

    /** 主动丢弃某个 state（如 pid 白名单拒绝后的观察缓存）。 */
    forgetState(stateId) {
      entries.delete(String(stateId || ''))
      superseded.delete(String(stateId || ''))
    },

    /** 变更已派发：同 scope 旧观察作废 + 写锁。动作可能已发生，与原生返回值无关。 */
    markMutationDispatched(pid) {
      for (const [sid, st] of [...entries]) {
        if (st.sel.pid === pid || pid === -1) superseded.add(sid)
      }
      if (pid !== -1) refreshLocks.add(pid)
    },

    requiresRefresh(pid) { return refreshLocks.has(pid) },
    stateCount() { return entries.size },
    refreshLockCount() { return refreshLocks.size },
    listFrameIds() { return [...frames.keys()] },
    clearAll() {
      entries.clear(); superseded.clear(); refreshLocks.clear()
      frames.clear()
      lastObservationKey = null; observationRepeatCount = 0
    },

    // ---------- 帧 ----------
    issueFrame({ path, width, height, actionable, crop, srcRegion }) {
      frameGeneration += 1
      let frameId
      do {
        frameId = 'frame-' + randomUUID().replaceAll('-', '').slice(0, 8)
      } while (frames.has(frameId))
      const now = Date.now()
      const d = {
        frame_id: frameId,
        session_id: sessionId,
        generation: frameGeneration,
        transform_version: FRAME_PIXEL_TRANSFORM_VERSION,
        created_at_ms: now,
        expires_at_ms: now + frameTtlMs,
        path, width, height,
        actionable: actionable !== false,
        crop: crop ?? null,
        src_region: srcRegion ?? null,
        image_ref: { frame_id: frameId, width, height, actionable: actionable !== false },
      }
      frames.set(frameId, d)
      while (frames.size > maxFrames) {
        const oldest = frames.keys().next().value
        frames.delete(oldest)
      }
      return d
    },

    getFrame(frameId) {
      const d = frames.get(String(frameId || ''))
      if (!d) return null
      if (Date.now() > d.expires_at_ms) return { ...d, expired: true }
      return d
    },

    /** 给帧补元数据（vision 描述/附件 id 等）；TTL 过期后自然消失。 */
    annotateFrame(frameId, patch) {
      const d = frames.get(String(frameId || ''))
      if (!d) return false
      Object.assign(d, patch)
      return true
    },

    latestFrame() {
      let latest = null
      for (const d of frames.values()) if (!latest || d.generation > latest.generation) latest = d
      return latest ? (Date.now() > latest.expires_at_ms ? { ...latest, expired: true } : latest) : null
    },

    // ---------- 显示器 / 观察 / 输入 ----------
    getSelectedDisplay() { return selectedDisplayIndex },
    setSelectedDisplay(i) { selectedDisplayIndex = i },

    noteObservation(key) {
      if (lastObservationKey === key) {
        observationRepeatCount += 1
      } else {
        lastObservationKey = key
        observationRepeatCount = 0
      }
      return observationRepeatCount
    },

    inputState: { leftMouseDown: false },
  }

  void opts.sessionIdForTest
  return session
}
