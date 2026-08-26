# -*- coding: utf-8 -*-
"""Host-side env auto-detection: /detect + /install-deps routes."""
import pathlib
p = pathlib.Path('E:/dsh-cua-pre/lib/index.js')
s = p.read_text(encoding='utf-8')
orig = s
n = 0

def rep(old, new, cnt=1):
    global s, n
    assert old in s, 'MISS: ' + old[:90].replace('\n', '\\n')
    s = s.replace(old, new, cnt)
    n += 1

# imports
rep("import { readFile, writeFile, stat, appendFile, mkdir } from 'node:fs/promises'",
    "import { readFile, writeFile, stat, appendFile, mkdir } from 'node:fs/promises'\n"
    "import { existsSync } from 'node:fs'\n"
    "import { execFile } from 'node:child_process'\n"
    "import { promisify } from 'node:util'\n"
    "const execFileP = promisify(execFile)")

# detection helpers before routes
rep("  const routes = [",
    """  // ---------- 环境自动检测（Python / worker / 视觉模型） ----------
  const VISION_RE = /(vl|vision|omni|multimodal|gemini|claude|gpt-4|gpt-5|qwen[\\w-]*vl|glm-4v|glm-[45][\\w-]*v\\b|pixtral|llava|internvl|doubao[\\w-]*vision|o[134])/i
  const detectCache = { pythons: null, at: 0 }
  async function probePython(pyPath, args) {
    return new Promise((resolve) => {
      let done = false
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false }) } }, 8000)
      try {
        execFile(pyPath, args, { timeout: 7500, windowsHide: true }, (err, stdout) => {
          if (done) return
          done = true; clearTimeout(t)
          resolve({ ok: !err, out: String(stdout || '').trim() })
        })
      } catch (_) { if (!done) { done = true; clearTimeout(t); resolve({ ok: false }) } }
    })
  }
  async function detectPythons() {
    const dshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) ? process.env.DSH_HOME.trim() : path.join(homedir(), '.dsh')
    const cands = [
      { path: path.join(dshHome, 'cua-pre', '.venv', 'Scripts', 'python.exe'), label: 'DSH 专用 venv（推荐）' },
      { path: path.join(path.dirname(defaultWorkerScriptPathPre()), '..', '.venv', 'Scripts', 'python.exe'), label: '插件目录 venv' },
      { path: 'python', label: '系统 PATH：python' },
      { path: 'python3', label: '系统 PATH：python3' },
    ]
    const out = []
    for (const c of cands) {
      const p2 = String(c.path)
      if (p2.includes('\\\\') || p2.includes('/')) {
        if (!existsSync(p2)) { out.push({ label: c.label, path: p2, status: 'missing' }); continue }
      }
      const base = await probePython(p2, ['-c', 'print("py-ok")'])
      if (!base.ok || base.out.indexOf('py-ok') === -1) { out.push({ label: c.label, path: p2, status: 'missing' }); continue }
      const deps = await probePython(p2, ['-c', 'import uiautomation, PIL; print("deps-ok")'])
      out.push({ label: c.label, path: p2, status: (deps.ok && deps.out.indexOf('deps-ok') !== -1) ? 'ready' : 'no-deps' })
    }
    return out
  }
  async function detectModels() {
    let llm = null
    try { llm = ctx.get('llm') } catch (_) {}
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      return { unsupported: true, providers: [] }
    }
    const providers = []
    await Promise.all(llm.listProviders().map(async (provider) => {
      const pid = provider && provider.id !== undefined ? String(provider.id) : String(provider)
      const pname = provider && provider.name ? String(provider.name) : pid
      try {
        const models = await llm.listModels(pid)
        providers.push({
          id: pid, name: pname,
          models: (models || []).map((m2) => {
            const id = m2 && m2.id !== undefined ? String(m2.id) : String(m2)
            const nm = m2 && m2.name ? String(m2.name) : undefined
            return { id, name: nm, likelyVision: VISION_RE.test(id) || VISION_RE.test(String(nm || '')) }
          }),
        })
      } catch (_) { /* 单个 provider 失败不阻塞 */ }
    }))
    return { unsupported: false, providers }
  }

  const routes = [""")

# API map additions
rep("""    describe: '/api/dsh-cua-pre/describe',
  }""",
    """    describe: '/api/dsh-cua-pre/describe',
    detect: '/api/dsh-cua-pre/detect',
    'install-deps': '/api/dsh-cua-pre/install-deps',
  }""")

# new routes before closing bracket of routes array (anchor: describe route tail)
rep("""        writeJson(res, 200, { ok: true, description: r.description, tiles: r.tiles, cached: !!r.cached, newTiles: r.newTiles || 0 })
      },
    },
  ]""",
    """        writeJson(res, 200, { ok: true, description: r.description, tiles: r.tiles, cached: !!r.cached, newTiles: r.newTiles || 0 })
      },
    },
    {
      kind: 'exact', path: API.detect, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        const now = Date.now()
        if (!detectCache.pythons || now - detectCache.at > 60000) {
          detectCache.pythons = await detectPythons().catch(() => [])
          detectCache.at = now
        }
        const bundledWorker = defaultWorkerScriptPathPre()
        const models = await detectModels().catch(() => ({ unsupported: true, providers: [] }))
        writeJson(res, 200, {
          pythons: detectCache.pythons,
          worker: { path: bundledWorker, exists: existsSync(bundledWorker) },
          models,
          current: { pythonExecutable: effConfig().pythonExecutable, workerPath: effConfig().workerPath, visionModel: effConfig().visionModel },
        })
      },
    },
    {
      kind: 'exact', path: API['install-deps'], handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req).catch(() => ({}))
        const py = String(body.python || '').trim()
        if (!py) return writeJson(res, 400, { error: 'missing python' })
        const runPip = async (extra) => {
          try {
            const r = await execFileP(py, ['-m', 'pip', 'install', '--quiet', 'uiautomation', 'pillow'].concat(extra || []),
              { timeout: 240000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
            return { ok: true, tail: String(r.stdout || '').slice(-400) }
          } catch (e) {
            return { ok: false, tail: String((e && (e.stderr || e.message)) || e).slice(-400) }
          }
        }
        let r = await runPip()
        if (!r.ok) r = await runPip(['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'])
        detectCache.pythons = null // 依赖装完失效缓存，下次 detect 重新探测
        writeJson(res, 200, r)
      },
    },
  ]""")

assert s != orig
p.write_text(s, encoding='utf-8')
print('index.js patched:', n)
