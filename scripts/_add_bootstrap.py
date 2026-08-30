# -*- coding: utf-8 -*-
"""Add first-run onboarding: /state.firstRun flag + /bootstrap one-click enable route."""
import pathlib
p = pathlib.Path('E:/dsh-cua-pre/lib/index.js')
s = p.read_text(encoding='utf-8')
orig = s
n = 0
def rep(old, new):
    global s, n
    assert old in s, 'MISS: ' + old[:80].replace('\n', '\\n')
    s = s.replace(old, new, 1)
    n += 1

# 1) state route: add firstRun
rep("""        writeJson(res, 200, {
          plugin: 'dsh-cua-pre', version: 3,
          enabled: !!effConfig().enabled,""",
"""        const everEnabled = !!(effConfig().enabled)
        writeJson(res, 200, {
          plugin: 'dsh-cua-pre', version: 3,
          enabled: everEnabled,
          firstRun: !everEnabled && !stoppedByUserPersisted,""")

# 2) API map
rep("""    'install-deps': '/api/dsh-cua-pre/install-deps',
  }""",
"""    'install-deps': '/api/dsh-cua-pre/install-deps',
    bootstrap: '/api/dsh-cua-pre/bootstrap',
  }""")

# 3) bootstrap route (before closing ] of routes)
rep("""        writeJson(res, 200, r)
      },
    },
  ]""",
"""        writeJson(res, 200, r)
      },
    },
    {
      kind: 'exact', path: API.bootstrap, handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: 'loopback-only' })
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req).catch(() => ({}))
        // 探测可用 Python：优先显式指定的；否则取第一个 ready 的候选
        let py = String(body.python || '').trim()
        if (!py) {
          const pythons = await detectPythons().catch(() => [])
          const ready = pythons.find((x) => x.status === 'ready') || pythons.find((x) => x.status === 'no-deps')
          if (ready) py = ready.path
        }
        if (!py) return writeJson(res, 400, { error: '未检测到可用 Python。请先在系统安装 Python 3.9+，或手动填写 pythonExecutable。' })
        // 若该 Python 缺依赖，自动尝试安装（默认源失败切清华镜像）
        const probe = await probePython(py, ['-c', 'import uiautomation, PIL; print("deps-ok")'])
        let installedDeps = false
        if (!probe.ok || probe.out.indexOf('deps-ok') === -1) {
          const runPip = async (extra) => {
            try {
              const r = await execFileP(py, ['-m', 'pip', 'install', '--quiet', 'uiautomation', 'pillow'].concat(extra || []),
                { timeout: 240000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
              return { ok: true, tail: String(r.stdout || '').slice(-300) }
            } catch (e) { return { ok: false, tail: String((e && (e.stderr || e.message)) || e).slice(-300) } }
          }
          let r = await runPip()
          if (!r.ok) r = await runPip(['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'])
          if (!r.ok) return writeJson(res, 500, { error: '依赖安装失败: ' + (r.tail || ''), tail: r.tail })
          installedDeps = true
        }
        // 写配置：enabled + pythonExecutable（+ 保留现有其他字段）
        try {
          const raw = await readFile(config._file, 'utf8').catch(() => '{}')
          const obj = JSON.parse(raw)
          obj.enabled = true
          obj.pythonExecutable = py
          await writeFile(config._file, JSON.stringify(obj, null, 2), 'utf8')
        } catch (e) {
          return writeJson(res, 500, { error: '配置写入失败: ' + (e.message || e) })
        }
        // 即时生效（overrides + 状态机重置）
        overrides.enabled = true
        overrides.pythonExecutable = py
        detectCache.pythons = null
        sidecar.restart('bootstrap')
        session.clearAll()
        recordOp({ ts: Date.now(), tool: '(bootstrap)', title: '一键启用', ok: true, brief: 'python=' + py + (installedDeps ? ' +deps' : ''), ms: 0 })
        writeJson(res, 200, { ok: true, python: py, depsInstalled: installedDeps, note: '已启用并即时生效。' })
      },
    },
  ]""")

assert s != orig
p.write_text(s, encoding='utf-8')
print('index.js patched:', n)
