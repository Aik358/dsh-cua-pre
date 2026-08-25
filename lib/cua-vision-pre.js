/**
 * cua-vision-pre — 识图（vision）链路 v2：帧 → 分块裁切 → 附件化 → 子代理 VLM 描述
 * 加 **两级缓存与增量描述**：
 *   - 全帧 hash 命中 → 直接复用上次描述（0 次 VLM 调用）
 *   - 分块 hash 命中 → 只把"变化的块"发给 VLM，与缓存行合并（N 变 1 次小调用）
 *   - 缓存为会话内内存态（进程生命周期），容量有界（全帧 50 / 分块 200）
 *
 * 图片经 ctx.attachments.saveImage 持久化为 ImageAttachmentRef，以
 * {type:'image',attachment:ref} 块进子代理 prompt——绝不把 base64/路径塞进文本。
 * 全程可失败：任何一环缺失返回 null + 原因，不抛出。
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const DEFAULTS = { tileMaxPx: 768, overlapPx: 64, maxTiles: 4 }
const FULL_CACHE_CAP = 50
const TILE_CACHE_CAP = 200

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

class LruMap extends Map {
  set(k, v) {
    if (this.has(k)) this.delete(k)
    super.set(k, v)
    while (this.size > this.cap) this.delete(this.keys().next().value)
    return this
  }
  constructor(cap) { super(); this.cap = cap }
}

/**
 * 网格分块规划。返回覆盖全图的矩形列表 [l,t,r,b]（原图像素坐标）。
 */
export function planTiles(width, height, opts = {}) {
  const tileMax = Math.max(256, Number(opts.tileMaxPx) || DEFAULTS.tileMaxPx)
  const overlap = Math.max(0, Math.min(200, Number(opts.overlapPx) || 0))
  const maxTiles = Math.max(1, Math.min(12, Number(opts.maxTiles) || DEFAULTS.maxTiles))
  const W = Math.max(1, Math.round(Number(width) || 1))
  const H = Math.max(1, Math.round(Number(height) || 1))
  if (W <= tileMax && H <= tileMax) return [{ l: 0, t: 0, r: W, b: H, col: 0, row: 0 }]

  function gridFits(cols, rows) {
    const cellW = Math.ceil((W + overlap * (cols - 1)) / cols)
    const cellH = Math.ceil((H + overlap * (rows - 1)) / rows)
    return cellW <= tileMax && cellH <= tileMax && cols * rows <= maxTiles
  }

  let best = null
  outer:
  for (let total = 2; total <= maxTiles; total++) {
    for (let rows = 1; rows <= total; rows++) {
      const cols = Math.ceil(total / rows)
      if (cols * rows !== total) continue
      if (gridFits(cols, rows)) { best = [cols, rows]; break outer }
    }
  }
  if (!best) best = [maxTiles, 1]
  const [cols, rows] = best
  const tiles = []
  const baseW = (W - overlap * (cols - 1)) / cols
  const baseH = (H - overlap * (rows - 1)) / rows
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const l = Math.round(col * (baseW - overlap))
      const t = Math.round(row * (baseH - overlap))
      tiles.push({
        l,
        t,
        r: Math.min(W, l + Math.ceil(baseW)),
        b: Math.min(H, t + Math.ceil(baseH)),
        col,
        row,
      })
    }
  }
  return tiles
}

function pickProvider(subagents) {
  try {
    const list = subagents.list ? subagents.list() : []
    if (Array.isArray(list) && list.length) return list.includes('spawn') ? 'spawn' : list[0]
  } catch (_) {}
  return null
}

export function createCuaVisionPre(opts) {
  const deps = opts // {sidecar, getConfig, getAttachments, getSubagents, getLastAgent}
  let running = 0
  const fullCache = new LruMap(FULL_CACHE_CAP) // frameSha -> description
  const tileCache = new LruMap(TILE_CACHE_CAP) // tileSha -> '[块r-c] ...' 行数组

  /**
   * 描述一帧。成功返回 {description, tiles, refs, cached}；失败返回 {error}。
   */
  async function describeFrame(frame, why = 'auto') {
    const cfg = deps.getConfig() || {}
    if (!cfg.visionEnabled) return { error: 'vision 未启用' }
    if (running >= 2) return { error: 'vision 忙碌（已有描述在进行）' }
    const attachments = deps.getAttachments()
    const subagents = deps.getSubagents()
    if (!attachments || typeof attachments.saveImage !== 'function') return { error: 'attachments 服务未挂载' }
    if (!subagents || typeof subagents.start !== 'function') return { error: 'subagents 服务未挂载' }
    const parent = deps.getLastAgent()
    if (!parent || !parent.session || !parent.ctx || typeof parent.ctx.get !== 'function') {
      return { error: '暂无活跃会话上下文（先发一条消息）' }
    }
    const providerName = pickProvider(subagents)
    if (!providerName) return { error: '无可用 subagent provider' }

    running++
    const controller = new AbortController()
    const timeoutMs = Math.max(15000, Number(cfg.visionTimeoutMs) || 90000)
    const timer = setTimeout(() => controller.abort('vision timeout'), timeoutMs)
    try {
      // 0) 读原帧字节：全帧 hash 快路径
      const frameBytes = await readFile(frame.path)
      const frameSha = sha256hex(frameBytes)
      if (fullCache.has(frameSha)) {
        running--
        return { description: fullCache.get(frameSha), tiles: 0, refs: [], cached: true }
      }

      // 1) 分块裁切
      const tiles = planTiles(frame.width, frame.height, {
        tileMaxPx: cfg.tileMaxPx, overlapPx: cfg.tileOverlapPx, maxTiles: cfg.visionMaxTiles,
      })
      const cropped = []
      if (tiles.length === 1) {
        cropped.push({ bytes: frameBytes, region: [0, 0, frame.width, frame.height], col: 0, row: 0 })
      } else {
        for (const t of tiles) {
          const r = await deps.sidecar.request('crop', {
            srcPath: frame.path, region: [t.l, t.t, t.r, t.b], saveDir: cfg._artifactsDir, quality: 82,
          }, {})
          if (!r.ok) return { error: '分块裁切失败: ' + (r.reasonText || r.code) }
          cropped.push({
            bytes: await readFile(r.payload.path),
            region: [t.l, t.t, t.r, t.b], col: t.col, row: t.row,
          })
        }
      }

      // 2) 分块 hash：区分命中缓存 vs 需要新描述的块
      const entries = []
      for (const c of cropped) {
        const sha = sha256hex(c.bytes)
        entries.push({ ...c, sha, cachedLines: tileCache.get(sha) || null })
      }
      const newOnes = entries.filter((e) => !e.cachedLines)

      // 3) 附件化（只附件化需要 VLM 的新块）
      const newRefs = []
      for (const e of newOnes) {
        const ref = await attachments.saveImage({
          data: new Uint8Array(e.bytes),
          mediaType: 'image/jpeg',
          name: 'cua-' + (frame.frame_id || 'frame') + '-r' + e.row + 'c' + e.col,
        })
        newRefs.push({ ref, e })
      }

      // 4) 有新块才调 VLM；否则纯合并
      let mergedLines = []
      if (newRefs.length > 0) {
        const header = [
          '你是桌面自动化的识图助手。下面按顺序给出 ' + newRefs.length + ' 个屏幕截图区块，',
          '每个区块前有 `--- 区块 N/M ---` 分隔行。请对每个区块输出关键可见元素清单',
          '(按钮/输入框/链接的文字标签)，每行一条、严格以 `[块N]` 开头(N=区块序号)；',
          '最后加一行以 `概述:` 开头的一句话总结(这是什么界面；弹窗/错误/加载指示必须写明)。',
          '不要输出任何多余寒暄。',
        ].join('\n')
        const model = String(cfg.visionModel || '').trim()
        const content = [{ type: 'text', text: header }]
        newRefs.forEach((x, i) => {
          content.push({ type: 'text', text: '--- 区块 ' + (i + 1) + '/' + newRefs.length + ' ---' })
          content.push({ type: 'image', attachment: x.ref })
        })
        const run = await subagents.start(providerName, {
          label: 'cua-vision:' + why + ':' + newRefs.length + 'new',
          prompt: content,
          signal: controller.signal,
          parent,
          ...(model ? { agentOptions: { model } } : {}),
        })
        const result = await run.result
        const text = ((result && result.output) || [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text).join('').trim()
        if (!text) return { error: 'VLM 返回空描述' }
        // 解析逐块行：[块N] 归属到第 N 个新块
        const linesByBlock = new Map()
        let overview = ''
        for (const rawLine of text.split('\n')) {
          const line = rawLine.trim()
          if (!line) continue
          const m = line.match(/^\[块(\d+)\]/)
          if (m) {
            const idx = Number(m[1]) - 1
            if (!linesByBlock.has(idx)) linesByBlock.set(idx, [])
            linesByBlock.get(idx).push(line)
          } else if (line.startsWith('概述')) {
            overview = line
          }
        }
        newRefs.forEach((x, i) => {
          let lines = linesByBlock.get(i)
          if (!lines && linesByBlock.size === 0) {
            // VLM 完全不守格式：整段归属第一个块，其余块标未解析
            lines = i === 0 ? text.split('\n').map((l2) => l2.trim()).filter(Boolean).slice(0, 30)
              : ['[块' + (i + 1) + '] (未解析到结构化行)']
          }
          if (!lines) lines = ['[块' + (i + 1) + '] (未解析到结构化行)']
          tileCache.set(x.e.sha, lines)
        })
        mergedLines.push(overview || '概述: (未提供)')
        for (const e of entries) {
          mergedLines.push(...(tileCache.get(e.sha) || []))
        }
      } else {
        mergedLines.push('概述: (全部区块命中增量缓存)')
        for (const e of entries) mergedLines.push(...(tileCache.get(e.sha) || []))
      }

      const description = mergedLines.join('\n').slice(0, 4000)
      fullCache.set(frameSha, description)
      running--
      return {
        description,
        tiles: entries.length,
        refs: newRefs.map((x) => x.ref),
        cached: newRefs.length === 0,
        newTiles: newRefs.length,
      }
    } catch (e) {
      const em = e && e.message ? e.message : String(e)
      return { error: em.slice(0, 200) }
    } finally {
      clearTimeout(timer)
      running = Math.max(0, running - 1)
    }
  }

  return { kind: 'cua-vision-pre', describeFrame, planTiles, busy: () => running, cacheStats: () => ({ full: fullCache.size, tiles: tileCache.size }) }
}
