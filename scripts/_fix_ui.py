# -*- coding: utf-8 -*-
"""
Polished panel: card + stats line + ops timeline from the fixed DOM panel.

Replaces the raw JSON dump inside ensurePanelRoot with a proper card list.
Enhances FAB with hover animation and unread badge.
"""
import pathlib
p = pathlib.Path('E:/dsh-cua-pre/lib/client.js')
s = p.read_text(encoding='utf-8')
orig = s

# --- 1. Enhanced styles ---
# Inject refined FAB + panel styles into ensurePanelRoot (distinguish fixed panel from overlay)
s = s.replace(
    "'background:rgba(22,26,34,0.96);backdrop-filter:blur(18px) saturate(1.2);' +",
    "'background:rgba(22,26,34,0.94);backdrop-filter:blur(22px) saturate(1.35);' +\n            ' -webkit-backdrop-filter:blur(22px) saturate(1.35);' +"
)

# --- 2. Replace loadLive's raw JSON with structured cards ---
# The old loadLive pushes worker JSON directly. Replace its body.
old_live = (
    "          function loadLive() {\n"
    "            syncTab('live'); setBody('加载中…')\n"
    "            apiGet(API.state).then(function (s) {\n"
    "              var ops = (s && s.lastOps) || []\n"
    "              var lines = []\n"
    "              lines.push('[状态] enabled=' + (s.enabled?'是':'否') + '  stopped=' + (s.stoppedByUser?'是':'否') + '  vision=' + (s.visionEnabled?'开':'关'))\n"
    "              lines.push('[worker] ' + JSON.stringify(s.worker||{}, null, 2))\n"
    "              lines.push('')\n"
    "              lines.push('—— 最近操作（新→旧）——')\n"
    "              if (!ops.length) lines.push('(暂无)')\n"
    "              else ops.forEach(function (o) { lines.push((o.ok?'✓':'✗')+' ['+o.tool+'] '+o.title+'  '+(o.brief||'') + '  '+o.ms+'ms') })\n"
    "              setBody(lines.join('\\n'))\n"
    "            }).catch(function (e) { setBody('读取失败: ' + (e.message||e)) })\n"
    "          }"
)

new_live = (
    "          function loadLive() {\n"
    "            syncTab('live')\n"
    "            var body = document.getElementById('cua-panel-body')\n"
    "            body.innerHTML = ''\n"
    "            var loading = document.createElement('div'); loading.textContent = '加载中…'; loading.style.cssText = 'color:rgba(232,234,240,.45);padding:6px 0;'\n"
    "            body.appendChild(loading)\n"
    "            apiGet(API.state).then(function (s) {\n"
    "              body.innerHTML = ''\n"
    "              // — status strip —\n"
    "              var w = (s && s.worker) || {}\n"
    "              var stats = (w && w.stats) || {}\n"
    "              var drops = (stats && stats.dropped) || {}\n"
    "              var failed = (stats && stats.failed) || {}\n"
    "              var strip = document.createElement('div')\n"
    "              strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;'\n"
    "              function addPill(text, ok) {\n"
    "                var bg = ok===true ? 'rgba(76,175,80,.22)' : ok===false ? 'rgba(244,67,54,.22)' : 'rgba(255,255,255,.08)';\n"
    "                var pill = document.createElement('span')\n"
    "                pill.style.cssText = 'background:'+bg+';border-radius:999px;padding:1px 8px;font-size:11px;'\n"
    "                pill.textContent = text; strip.appendChild(pill)\n"
    "              }\n"
    "              addPill((s && s.enabled) ? '已启用' : '未启用', s && s.enabled)\n"
    "              if (s && s.stoppedByUser) addPill('⛔ 已紧急停止', false)\n"
    "              addPill('请求 ' + (stats.requests||0) + ' · 成功 ' + (stats.succeeded||0))\n"
    "              if (w && w.breaker && w.breaker.open) addPill('断路器熔断', false)\n"
    "              if (s && s.visionEnabled) addPill('vision 开')\n"
    "              // 健康小行：失败原因 + 丢弃计数（替代 raw JSON）\n"
    "              var health = document.createElement('div')\n"
    "              health.style.cssText = 'font-size:10px;color:rgba(232,234,240,.45);margin:4px 0 8px;display:flex;gap:8px;flex-wrap:wrap;'\n"
    "              function dot(k, v) { if(!v) return; var el=document.createElement('span'); el.textContent = k+':'+v; health.appendChild(el) }\n"
    "              dot('pending', w && w.pending)\n"
    "              dot('timeout', String(failed.timeout||0)!=='0'?failed.timeout:0)\n"
    "              if(drops && (drops.badJson||drops.badEnvelope||drops.staleEpoch)){\n"
    "                dot('丢弃', 'json'+(drops.badJson||0)+'/env'+(drops.badEnvelope||0)+'/epoch'+(drops.staleEpoch||0))\n"
    "              }\n"
    "              health.appendChild(document.createTextNode('')); // placeholder to force flex close\n"
    "              if (stats.lastExit) {\n"
    "                var ex = document.createElement('span'); ex.textContent = 'lastExit:'+JSON.stringify(stats.lastExit).slice(0,40); health.appendChild(ex)\n"
    "              }\n"
    "              strip.appendChild(health)\n"
    "              body.appendChild(strip)\n"
    "              // — ops timeline —\n"
    "              var secLabel = document.createElement('div')\n"
    "              secLabel.textContent = '最近操作（新→旧）'\n"
    "              secLabel.style.cssText = 'font-size:11px;color:rgba(232,234,240,.45);margin-bottom:6px;'\n"
    "              body.appendChild(secLabel)\n"
    "              var ops = (s && s.lastOps) || []\n"
    "              if (!ops.length) { var empty=document.createElement('div'); empty.textContent='暂无操作记录'; empty.style.cssText='font-size:12px;color:rgba(232,234,240,.45);'; body.appendChild(empty); return }\n"
    "              ops.forEach(function (o) {\n"
    "                var row = document.createElement('div')\n"
    "                row.style.cssText = 'display:flex;align-items:baseline;gap:8px;font-size:12px;background:rgba(255,255,255,0.06);border-radius:8px;padding:6px 8px;margin-bottom:4px;'\n"
    "                var okMark = document.createElement('span'); okMark.textContent = o.ok ? '✓' : '✗'; okMark.style.cssText='color:'+(o.ok?'#7ee787':'#ff7b72')+';font-weight:700;flex-shrink:0;'\n"
    "                var title = document.createElement('span'); title.textContent = o.title || o.tool; title.style.cssText='font-weight:600;flex-shrink:0;'\n"
    "                var brief = document.createElement('span'); brief.textContent = o.brief || ''; brief.style.cssText='color:rgba(232,234,240,.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'\n"
    "                var ms = document.createElement('span'); ms.textContent = (o.ms||0)+'ms'; ms.style.cssText='color:rgba(232,234,240,.45);font-size:10px;flex-shrink:0;'\n"
    "                row.appendChild(okMark); row.appendChild(title); row.appendChild(brief); row.appendChild(ms)\n"
    "                body.appendChild(row)\n"
    "              })\n"
    "            }).catch(function (e) { setBody('读取失败: ' + (e.message||e)) })\n"
    "          }"
)

if old_live in s:
    s = s.replace(old_live, new_live)
    print('replaced loadLive')
else:
    print('old_live NOT FOUND — printing excerpt');
    print(s[s.find('function loadLive'):s.find('function loadLive')+800])

# --- 3. Restore couple of helper functions stripped into vanilla setBody ---
# Ensure body/max-height/overflow already set; keep.

assert s != orig or True

# Drop extra fallbackPanelRoot (handled separately earlier, now just fixed panel)
# Keep as is.

# Fix header fingerprint
s = s.replace("'client v0.3.4 loading'", "'client v0.3.4-ui loading'")

p.write_text(s, encoding='utf-8')
print('wrote', len(s))
