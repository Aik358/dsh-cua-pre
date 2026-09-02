# -*- coding: utf-8 -*-
"""Theme tokens: replace hardcoded dark palette with DSH --dsw-alias-* vars (both themes readable)."""
import pathlib
p = pathlib.Path('E:/dsh-cua-pre/lib/client.js')
s = p.read_text(encoding='utf-8')
orig = s
n = 0
def rep(old, new, all=True):
    global s, n
    if old not in s:
        print('MISS:', old[:70]); return
    s = s.replace(old, new) if all else s.replace(old, new, 1)
    n += 1

# 1) token helpers after MUTED
rep("    var MUTED = 'rgba(232,234,240,0.55)'",
"""    var MUTED = 'var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))'
    var C_TEXT = 'var(--dsw-alias-label-primary, #e8eaf0)'
    var C_BG = 'color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,26,34,0.9)) 90%, transparent)'
    var C_LAYER = 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))'
    var C_BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.35))'
    var C_BRAND = 'var(--dsw-alias-brand-primary, #4f7cff)'
    var C_OK = '#3fb950'   /* 双主题可读（GitHub 中间调） */
    var C_ERR = '#f85149'""")

# 2) text/muted literals -> tokens
rep("rgba(232,234,240,0.55)", "var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))")
rep("rgba(232,234,240,.55)", "var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))")
rep("rgba(232,234,240,.45)", "var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))")
rep("rgba(232,234,240,.4)", "var(--dsw-alias-label-secondary, rgba(160,170,185,0.95))")
rep("#e8eaf0", "var(--dsw-alias-label-primary, #e8eaf0)")
rep("#c9d1d9", "var(--dsw-alias-label-primary, #c9d1d9)")

# 3) panel/borders/cards: white-alpha -> tokens
rep("rgba(255,255,255,0.05)", "var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.05))")
rep("rgba(255,255,255,0.06)", "var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06))")
rep("rgba(255,255,255,0.08)", "var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))")
rep("rgba(255,255,255,0.1)", "var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.1))")
rep("rgba(255,255,255,.08)", "var(--dsw-alias-bg-layer-1, rgba(255,255,255,.08))")
rep("rgba(255,255,255,0.12)", "var(--dsw-alias-border-l1, rgba(255,255,255,0.12))")
rep("rgba(255,255,255,0.14)", "var(--dsw-alias-border-l1, rgba(255,255,255,0.14))")
rep("rgba(255,255,255,0.16)", "var(--dsw-alias-border-l1, rgba(255,255,255,0.16))")
rep("rgba(255,255,255,0.18)", "var(--dsw-alias-border-l1, rgba(255,255,255,0.18))")
rep("rgba(255,255,255,0.15)", "var(--dsw-alias-border-l1, rgba(255,255,255,0.15))")
rep("1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))", "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))")  # noop anchor

# 4) panel backgrounds -> overlay token (light theme gets light panel)
rep("rgba(22,24,30,0.72)", "color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,24,30,0.9)) 88%, transparent)")
rep("rgba(22,26,34,0.94)", "color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,26,34,0.9)) 90%, transparent)")
rep("rgba(20,24,32,0.92)", "var(--dsw-alias-bg-overlay, rgba(20,24,32,0.92))")

# 5) status colors both-theme readable
rep("#7ee787", "#3fb950")
rep("#ff9a8b", "var(--dsw-alias-state-warn-primary, #d29922)")
rep("#79c0ff", "var(--dsw-alias-brand-primary, #4f7cff)")
rep("#7fb0ff", "var(--dsw-alias-brand-primary, #4f7cff)")

# 6) hardcoded text #fff (on translucent accent) -> label token (except toggle knob & FAB open)
rep("}, saving ? t('saving') : t('save'))", "}, saving ? t('saving') : t('save'))")  # anchor noop
rep("color: 'inherit', borderRadius: 8, padding: '6px 18px', cursor: 'pointer', fontSize: 13 },\n          saving", "color: 'inherit', borderRadius: 8, padding: '6px 18px', cursor: 'pointer', fontSize: 13 },\n          saving")  # noop
rep("background: bootstrapping ? 'rgba(121,192,255,0.92)'", "background: bootstrapping ? 'rgba(121,192,255,0.92)'")  # noop
rep("color: open ? '#0b1220' : 'var(--dsw-alias-label-primary, #e8eaf0)'", "color: open ? '#0b1220' : 'var(--dsw-alias-label-primary, #e8eaf0)'")  # noop
rep("borderRadius: 9, padding: '7px 16px', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer'",
    "borderRadius: 9, padding: '7px 16px', color: 'var(--dsw-alias-label-primary, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer'")

# 7) GLASS token text color (React) — handled by #e8eaf0 global; ensure bg uses token
rep("background: 'rgba(22,24,30,0.72)'", "background: 'color-mix(in srgb, var(--dsw-alias-bg-overlay, rgba(22,24,30,0.9)) 88%, transparent)'")  # in case quoted form

# 8) toggle knob keep white; track uses border token already via 0.15/0.16 replace
rep("background: props.value ? 'rgba(76,175,80,0.6)' : 'rgba(255,255,255,0.15)'",
    "background: props.value ? 'rgba(76,175,80,0.6)' : 'var(--dsw-alias-border-l1, rgba(255,255,255,0.15))'")

# 9) onboarding banner body color (was rgba .55 via MUTED) — auto via MUTED

# 10) FAB: keep dark glass; border -> border token
rep("border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.18));box-shadow:0 8px 32px rgba(0,0,0,0.35);' +",
    "border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.18));box-shadow:0 8px 32px rgba(0,0,0,0.35);' +")

# 11) bootstrap button border 0.6/0.5 accents keep; banner border 0.4 keep (blue translucent both-theme ok)

assert s != orig
p.write_text(s, encoding='utf-8')
print('theme patch:', n)
if miss: print('MISSES:', len(miss))
