#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-cua-pre worker v1 — 电脑控制 OS 层原语（Route B 原型）。

协议：stdin/stdout 单行 UTF-8 JSONL 帧（对齐 docs/PYTHON-SIDECAR-CONTRACT.md §7 纪律）：
  入站  {"v":1,"dir":"req","requestId":"...","epoch":"...","op":"...","payload":{...}}
  出站  {"v":1,"dir":"res","requestId":"...","epoch":"...","payload":{...}}   成功
        {"v":1,"dir":"err","requestId":"...","epoch":"...","error":{"code","message"}} 失败

纪律：
  - 无 HTTP、无端口、无线程；stdin EOF 即退出。
  - epoch 门：--expect-epoch 启动参数，入站帧 epoch 不匹配一律丢弃计数（fail closed）。
  - 单行上限 256KiB：截图永不走 stdout base64，落盘后只回路径+元数据。
  - worker 无会话状态：observe 返回树内 path（子索引序列），由 JS 侧持有 state_id 并做
    新鲜度裁决；动作时按 path 重走并校验 (type,name)，漂移即 stale_tree —— 对齐 zcode-cua
    的 superseded/refresh_required 语义。
  - 依赖懒加载：uiautomation/Pillow 缺失时 health 仍可用，业务 op 回 CUA_DEP_MISSING。

DPI：启动即声明 per-monitor DPI aware（物理像素坐标系统一 UIA rect / SendInput / 截屏）。
"""

import sys
import os
import json
import time
import ctypes
import argparse

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 256 * 1024

# DPI 感知必须最先声明，否则 UIA rect 与 SendInput 坐标在缩放显示器上错位。
def _declare_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


_declare_dpi_awareness()

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# ---------------------------------------------------------------------------
# 依赖探测（懒加载）
# ---------------------------------------------------------------------------

_deps = {}

def _ensure_uia():
    if 'uia' in _deps:
        if _deps['uia'] is None:
            raise DepMissing('uiautomation')
        return _deps['uia']
    try:
        import uiautomation as auto
        _deps['uia'] = auto
        return auto
    except Exception:
        _deps['uia'] = None
        raise DepMissing('uiautomation')


def _ensure_pil():
    if 'pil' in _deps:
        if _deps['pil'] is None:
            raise DepMissing('Pillow')
        return _deps['pil']
    try:
        from PIL import ImageGrab
        _deps['pil'] = ImageGrab
        return _deps['pil']
    except Exception:
        _deps['pil'] = None
        raise DepMissing('Pillow')


class DepMissing(Exception):
    def __init__(self, package):
        super().__init__('missing python dependency: %s' % package)
        self.package = package


class StaleTree(Exception):
    def __init__(self, message):
        super().__init__(message)


class OpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# SendInput 底座（ctypes，无第三方依赖）
# ---------------------------------------------------------------------------

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', ctypes.c_long), ('dy', ctypes.c_long), ('mouseData', ctypes.c_long),
                ('dwFlags', ctypes.c_ulong), ('time', ctypes.c_ulong),
                ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', ctypes.c_ushort), ('wScan', ctypes.c_ushort), ('dwFlags', ctypes.c_ulong),
                ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [('mi', _MOUSEINPUT), ('ki', _KEYBDINPUT)]
    _anonymous_ = ('u',)
    _fields_ = [('type', ctypes.c_ulong), ('u', _U)]


def _virtual_screen():
    x = user32.GetSystemMetrics(76)
    y = user32.GetSystemMetrics(77)
    w = user32.GetSystemMetrics(78)
    h = user32.GetSystemMetrics(79)
    return x, y, w, h


def _send_inputs(inputs):
    arr = (_INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(_INPUT))
    if sent != len(inputs):
        raise OpError('sendinput_blocked',
                      'SendInput 只注入了 %d/%d 个事件（目标窗口可能以管理员权限运行，UIPI 拒绝）'
                      % (sent, len(inputs)))


def mouse_move_abs(px, py):
    sx, sy, sw, sh = _virtual_screen()
    if sw <= 0 or sh <= 0:
        raise OpError('screen_error', 'virtual screen metrics unavailable')
    nx = int(round((px - sx) * 65535.0 / max(1, sw - 1)))
    ny = int(round((py - sy) * 65535.0 / max(1, sh - 1)))
    nx = max(0, min(65535, nx))
    ny = max(0, min(65535, ny))
    inp = _INPUT()
    inp.type = INPUT_MOUSE
    inp.mi = _MOUSEINPUT(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)
    _send_inputs([inp])


_MOUSE_FLAG = {
    'left': (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    'right': (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    'middle': (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def mouse_click(px, py, button='left', double=False):
    down_f, up_f = _MOUSE_FLAG.get(button, _MOUSE_FLAG['left'])
    seq = []
    pairs = 2 if double else 1
    for _ in range(pairs):
        i_down = _INPUT(); i_down.type = INPUT_MOUSE
        i_down.mi = _MOUSEINPUT(0, 0, 0, down_f, 0, None)
        i_up = _INPUT(); i_up.type = INPUT_MOUSE
        i_up.mi = _MOUSEINPUT(0, 0, 0, up_f, 0, None)
        seq += [i_down, i_up]
    mouse_move_abs(px, py)
    _send_inputs(seq)


def mouse_scroll(px, py, direction='down', amount=3):
    delta = -120 * max(1, min(10, int(amount))) if direction == 'down' else 120 * max(1, min(10, int(amount)))
    mouse_move_abs(px, py)
    inp = _INPUT()
    inp.type = INPUT_MOUSE
    inp.mi = _MOUSEINPUT(0, 0, delta, MOUSEEVENTF_WHEEL, 0, None)
    _send_inputs([inp])


_VK_MAP = {
    'enter': 0x0D, 'return': 0x0D, 'esc': 0x1B, 'escape': 0x1B, 'tab': 0x09,
    'space': 0x20, 'backspace': 0x08, 'delete': 0x2E, 'del': 0x2E, 'insert': 0x2D,
    'home': 0x24, 'end': 0x23, 'pageup': 0x21, 'pagedown': 0x22,
    'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
    'printscreen': 0x2C, 'apps': 0x5D, 'pause': 0x13,
}
for _i in range(26):
    _VK_MAP[chr(ord('a') + _i)] = 0x41 + _i
for _i in range(10):
    _VK_MAP[str(_i)] = 0x30 + _i
for _i in range(1, 25):
    _VK_MAP['f%d' % _i] = 0x6F + _i
_PUNCT_VK = {'-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, ';': 0xBA, "'": 0xDE,
             ',': 0xBC, '.': 0xBE, '/': 0xBF, '\\': 0xDC, '`': 0xC0}
_VK_MAP.update(_PUNCT_VK)
_MOD_VK = {'ctrl': 0x11, 'control': 0x11, 'alt': 0x12, 'shift': 0x10, 'win': 0x5B, 'meta': 0x5B}


def key_chord(spec, repeat=1):
    """spec 形如 'ctrl+shift+t'；repeat 限 1..20。"""
    parts = [p.strip().lower() for p in str(spec).split('+') if p.strip()]
    if not parts:
        raise OpError('bad_keys', '空键序列')
    repeat = max(1, min(20, int(repeat)))
    vks = []
    for p in parts:
        vk = _MOD_VK.get(p) or _VK_MAP.get(p)
        if vk is None and len(p) == 1:
            vk = ord(p.upper())
        if vk is None:
            raise OpError('bad_keys', '无法识别的键: %s' % p)
        vks.append(vk)

    def one_round():
        seq = []
        for vk in vks:
            i = _INPUT(); i.type = INPUT_KEYBOARD
            i.ki = _KEYBDINPUT(vk, 0, 0, 0, None)
            seq.append(i)
        for vk in reversed(vks):
            i = _INPUT(); i.type = INPUT_KEYBOARD
            i.ki = _KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None)
            seq.append(i)
        _send_inputs(seq)

    for _ in range(repeat):
        one_round()


def type_text(text):
    """Unicode 注入：KEYEVENTF_UNICODE 按 UTF-16 码元发送（非 BMP 字符拆代理对）。
    目标需已聚焦（先 focus）。"""
    units = []
    for ch in text:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            units.append(0xD800 + (cp >> 10))
            units.append(0xDC00 + (cp & 0x3FF))
        else:
            units.append(cp)
    if not units:
        return
    chunk = []
    for u in units[:8000]:
        down = _INPUT(); down.type = INPUT_KEYBOARD
        down.ki = _KEYBDINPUT(u, u, KEYEVENTF_UNICODE, 0, None)
        up = _INPUT(); up.type = INPUT_KEYBOARD
        up.ki = _KEYBDINPUT(u, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None)
        chunk += [down, up]
    # 分批防止单次 SendInput 过大
    step = 500
    for s in range(0, len(chunk), step):
        _send_inputs(chunk[s:s + step])


# ---------------------------------------------------------------------------
# UIA 观察与元素寻址（无会话状态：path 由 JS 侧持有）
# ---------------------------------------------------------------------------

def _short_type(ctrl):
    try:
        name = ctrl.ControlTypeName or ''
    except Exception:
        name = ''
    if name.endswith('Control'):
        name = name[:-7]
    return name or 'Unknown'


def list_windows():
    auto = _ensure_uia()
    out = []
    root = auto.GetRootControl()
    for w in root.GetChildren():
        try:
            if w.ControlType != auto.ControlType.WindowControl:
                continue
            title = w.Name or ''
            rect = w.BoundingRectangle
            off = 0
            try:
                off = 1 if w.IsOffscreen else 0
            except Exception:
                pass
            out.append({
                'pid': int(w.ProcessId),
                'title': title[:120],
                'className': (w.ClassName or '')[:80],
                'rect': [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)] if rect else None,
                'offscreen': off,
            })
        except Exception:
            continue
    return {'windows': out}


def find_window(sel):
    auto = _ensure_uia()
    root = auto.GetRootControl()
    pid = sel.get('pid')
    title_sub = (sel.get('title') or '').lower()
    candidates = []
    for w in root.GetChildren():
        try:
            if w.ControlType != auto.ControlType.WindowControl:
                continue
            if pid is not None and int(w.ProcessId) != int(pid):
                continue
            if title_sub and title_sub not in (w.Name or '').lower():
                continue
            candidates.append(w)
        except Exception:
            continue
    if not candidates:
        raise OpError('window_not_found', '未找到匹配的顶层窗口（pid=%r title=%r）' % (pid, sel.get('title')))
    # 有显式选择器时取第一个；否则取 Z 序第一个可见有标题窗口
    return candidates[0]


def observe(sel, max_depth=7, max_elements=300):
    auto = _ensure_uia()
    win = find_window(sel)
    elements = []
    truncated = [False]

    def rec(ctrl, depth, path):
        if depth > max_depth or len(elements) >= max_elements:
            if len(elements) >= max_elements:
                truncated[0] = True
            return
        kids = []
        try:
            kids = ctrl.GetChildren()
        except Exception:
            return
        for i, c in enumerate(kids):
            if len(elements) >= max_elements:
                truncated[0] = True
                return
            try:
                tname = _short_type(c)
                en = 1
                try:
                    en = 1 if c.IsEnabled else 0
                except Exception:
                    pass
                caps = []
                # 可用 pattern 探测全部防御式：属性不存在不致命
                for flag, check in (
                    ('I', 'IsInvokePatternAvailable'), ('T', 'IsTogglePatternAvailable'),
                    ('E', 'IsExpandCollapsePatternAvailable'), ('S', 'IsSelectionItemPatternAvailable'),
                    ('V', 'IsValuePatternAvailable'), ('L', 'IsLegacyIAccessiblePatternAvailable'),
                ):
                    try:
                        if getattr(c, check):
                            caps.append(flag)
                    except Exception:
                        pass
                entry = {
                    'p': path + [i],
                    't': tname,
                    'e': en,
                    'a': ''.join(caps),
                }
                nm = (c.Name or '').strip()
                if nm:
                    entry['n'] = nm[:80]
                try:
                    r = c.BoundingRectangle
                    if r and r.right > r.left and r.bottom > r.top:
                        entry['r'] = [int(r.left), int(r.top), int(r.right), int(r.bottom)]
                except Exception:
                    pass
                elements.append(entry)
            except Exception:
                continue
            rec(c, depth + 1, path + [i])

    try:
        win_name = win.Name or ''
        win_class = win.ClassName or ''
        wrect = win.BoundingRectangle
        wr = [int(wrect.left), int(wrect.top), int(wrect.right), int(wrect.bottom)] if wrect else None
    except Exception:
        win_name, win_class, wr = '', '', None
    rec(win, 1, [])
    return {
        'window': {'pid': int(win.ProcessId), 'title': win_name[:120], 'className': (win_class or '')[:80], 'rect': wr},
        'elements': elements,
        'truncated': truncated[0],
        'count': len(elements),
    }


def resolve_element(sel, path, expect_t=None, expect_n=None):
    win = find_window(sel)
    cur = win
    for idx in path:
        try:
            kids = cur.GetChildren()
        except Exception as e:
            raise StaleTree('tree walk failed at child index %d: %s' % (idx, e))
        if idx < 0 or idx >= len(kids):
            raise StaleTree('child index %d out of range (children=%d)' % (idx, len(kids)))
        cur = kids[idx]
    if expect_t is not None:
        got = _short_type(cur)
        if got.lower() != str(expect_t).lower():
            raise StaleTree('type drifted: expected %s got %s' % (expect_t, got))
    if expect_n:
        got_n = (cur.Name or '').strip()[:80]
        if got_n != str(expect_n).strip()[:80]:
            raise StaleTree('name drifted: expected %r got %r' % (expect_n, got_n))
    return cur


def _center(ctrl):
    r = ctrl.BoundingRectangle
    if not r or r.right <= r.left or r.bottom <= r.top:
        raise OpError('no_rect', '元素无有效矩形（可能不可见）')
    return int((r.left + r.right) // 2), int((r.top + r.bottom) // 2), [int(r.left), int(r.top), int(r.right), int(r.bottom)]


def element_action(sel, path, action='click', value=None, expect_t=None, expect_n=None,
                   button='left', double=False):
    """语义优先：Invoke/Toggle/ExpandCollapse/Select → 失败逐级回退坐标点击。"""
    auto = _ensure_uia()
    ctrl = resolve_element(sel, path, expect_t, expect_n)
    used = []
    if action in ('click', 'invoke', 'press'):
        for name, fn in (
            ('invoke', lambda: ctrl.GetInvokePattern().Invoke()),
            ('legacy', lambda: ctrl.GetLegacyAccessiblePattern().DoDefaultAction()),
        ):
            try:
                fn()
                used.append(name)
                return {'ok': True, 'strategy': used}
            except Exception:
                continue
        cx, cy, rect = _center(ctrl)
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        mouse_click(cx, cy, button=button, double=double)
        used.append('coordinate')
        return {'ok': True, 'strategy': used, 'point': [cx, cy], 'rect': rect}
    if action == 'toggle':
        try:
            ctrl.GetTogglePattern().Toggle()
            used.append('toggle')
            return {'ok': True, 'strategy': used}
        except Exception:
            pass
        cx, cy, rect = _center(ctrl)
        mouse_click(cx, cy)
        used.append('coordinate')
        return {'ok': True, 'strategy': used, 'point': [cx, cy], 'rect': rect}
    if action in ('expand', 'collapse'):
        try:
            pat = ctrl.GetExpandCollapsePattern()
            (pat.Expand if action == 'expand' else pat.Collapse)()
            used.append(action)
            return {'ok': True, 'strategy': used}
        except Exception:
            pass
        cx, cy, rect = _center(ctrl)
        mouse_click(cx, cy)
        used.append('coordinate')
        return {'ok': True, 'strategy': used, 'point': [cx, cy], 'rect': rect}
    if action == 'select':
        try:
            ctrl.GetSelectionItemPattern().Select()
            used.append('select')
            return {'ok': True, 'strategy': used}
        except Exception:
            pass
        cx, cy, rect = _center(ctrl)
        mouse_click(cx, cy)
        used.append('coordinate')
        return {'ok': True, 'strategy': used, 'point': [cx, cy], 'rect': rect}
    if action in ('setvalue', 'set_value'):
        text = '' if value is None else str(value)
        try:
            ctrl.GetValuePattern().SetValue(text)
            used.append('valuepattern')
            return {'ok': True, 'strategy': used}
        except Exception:
            pass
        cx, cy, rect = _center(ctrl)
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        mouse_click(cx, cy)
        type_text(text)
        used.append('focus+unicode')
        return {'ok': True, 'strategy': used, 'point': [cx, cy]}
    if action == 'focus':
        try:
            ctrl.SetFocus()
            used.append('focus')
            return {'ok': True, 'strategy': used}
        except Exception as e:
            raise OpError('focus_failed', 'SetFocus 失败: %s' % e)
    if action == 'rect':
        cx, cy, rect = _center(ctrl)
        return {'ok': True, 'strategy': ['rect'], 'point': [cx, cy], 'rect': rect}
    raise OpError('bad_action', '未知 action: %s' % action)


# ---------------------------------------------------------------------------
# 截图（落盘，不走 stdio）
# ---------------------------------------------------------------------------

def screenshot(mode='screen', sel=None, save_dir=None, quality=80):
    ImageGrab = _ensure_pil()
    ts = time.strftime('%Y%m%d-%H%M%S')
    base = os.path.abspath(os.path.expanduser(save_dir or '.'))
    os.makedirs(base, exist_ok=True)
    img = ImageGrab.grab(all_screens=True)
    crop_note = None
    if mode == 'window' and sel:
        win = find_window(sel)
        r = win.BoundingRectangle
        if r and r.right > r.left and r.bottom > r.top:
            img = img.crop((max(0, int(r.left)), max(0, int(r.top)), int(r.right), int(r.bottom)))
            crop_note = 'window:%s' % (win.Name or '')[:60]
    # 宽度压到 1600 内，控制文件体积（视觉兜底用，不需要原始分辨率）
    if img.width > 1600:
        ratio = 1600.0 / img.width
        img = img.resize((1600, max(1, int(img.height * ratio))))
    path = os.path.join(base, 'cua-shot-%s.jpg' % ts)
    img.convert('RGB').save(path, 'JPEG', quality=max(40, min(90, int(quality))))
    return {'path': path, 'width': img.width, 'height': img.height,
            'bytes': os.path.getsize(path), 'crop': crop_note}


# ---------------------------------------------------------------------------
# 帧循环
# ---------------------------------------------------------------------------

_stats = {'framesIn': 0, 'staleEpoch': 0, 'badJson': 0, 'errors': 0, 'ops': {}}


def dispatch(op, payload):
    payload = payload or {}
    if op == 'health':
        deps_ok = True
        try:
            _ensure_uia()
        except Exception:
            deps_ok = False
        pil_ok = True
        try:
            _ensure_pil()
        except Exception:
            pil_ok = False
        return {'ok': True, 'platform': sys.platform, 'python': sys.version.split()[0],
                'pid': os.getpid(),
                'deps': {'uiautomation': deps_ok, 'pillow': pil_ok},
                'stats': _stats}
    if op == 'list_windows':
        return list_windows()
    if op == 'observe':
        return observe(payload.get('sel') or {},
                       max_depth=int(payload.get('maxDepth') or 7),
                       max_elements=int(payload.get('maxElements') or 300))
    if op == 'element_action':
        return element_action(payload.get('sel') or {},
                              payload.get('path') or [],
                              action=payload.get('action') or 'click',
                              value=payload.get('value'),
                              expect_t=payload.get('expectT'),
                              expect_n=payload.get('expectN'),
                              button=payload.get('button') or 'left',
                              double=bool(payload.get('double')))
    if op == 'click_xy':
        px = int(payload['x']); py = int(payload['y'])
        mouse_click(px, py, button=payload.get('button') or 'left', double=bool(payload.get('double')))
        return {'ok': True, 'strategy': ['coordinate'], 'point': [px, py]}
    if op == 'key':
        key_chord(payload.get('keys') or '', repeat=int(payload.get('repeat') or 1))
        return {'ok': True}
    if op == 'type':
        type_text(str(payload.get('text') or ''))
        return {'ok': True}
    if op == 'noop':
        return {'ok': True}
    if op == 'scroll':
        px = payload.get('x'); py = payload.get('py', payload.get('y'))
        if px is None or py is None:
            sx, sy, sw, sh = _virtual_screen()
            px = sx + sw // 2
            py = sy + sh // 2
        mouse_scroll(int(px), int(py),
                     direction=payload.get('direction') or 'down',
                     amount=int(payload.get('amount') or 3))
        return {'ok': True}
    if op == 'screenshot':
        return screenshot(mode=payload.get('mode') or 'screen',
                          sel=payload.get('sel'),
                          save_dir=payload.get('saveDir'),
                          quality=int(payload.get('quality') or 80))
    raise OpError('unknown_op', '未知 op: %s' % op)


def _write(obj):
    line = json.dumps(obj, ensure_ascii=True, separators=(',', ':'))
    if len(line.encode('utf-8')) > MAX_LINE_BYTES:
        # 理论上不会发生（截图不走 stdout）；保底截断为 err 帧
        obj = {'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': obj.get('requestId'),
               'epoch': obj.get('epoch'),
               'error': {'code': 'response_oversize', 'message': 'response exceeded frame cap'}}
        line = json.dumps(obj, ensure_ascii=True, separators=(',', ':'))
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--expect-epoch', required=True)
    args = ap.parse_args()
    epoch = args.expect_epoch
    _write({'v': PROTOCOL_VERSION, 'dir': 'evt', 'requestId': '', 'epoch': epoch,
            'payload': {'event': 'ready', 'pid': os.getpid(), 'python': sys.version.split()[0]}})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        if len(raw.encode('utf-8')) > MAX_LINE_BYTES:
            _stats['errors'] += 1
            continue
        _stats['framesIn'] += 1
        try:
            frame = json.loads(raw)
        except Exception:
            _stats['badJson'] += 1
            continue
        if not isinstance(frame, dict) or frame.get('v') != PROTOCOL_VERSION \
                or frame.get('dir') != 'req' or not frame.get('requestId'):
            _stats['errors'] += 1
            continue
        rid = frame.get('requestId')
        if frame.get('epoch') != epoch:
            _stats['staleEpoch'] += 1
            continue  # fail closed：epoch 不匹配静默丢弃，不应答（旧主进程早已死亡）
        op = frame.get('op')
        _stats['ops'][op] = _stats['ops'].get(op, 0) + 1
        try:
            result = dispatch(op, frame.get('payload'))
            _write({'v': PROTOCOL_VERSION, 'dir': 'res', 'requestId': rid,
                    'epoch': epoch, 'payload': result})
        except DepMissing as e:
            _stats['errors'] += 1
            _write({'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': rid, 'epoch': epoch,
                    'error': {'code': 'CUA_DEP_MISSING',
                              'message': '%s 未安装。请在插件目录执行: .venv/Scripts/pip install %s （或 pip install %s）'
                                         % (e.package, 'uiautomation pillow' if e.package != 'Pillow' else 'pillow', e.package)}})
        except StaleTree as e:
            _write({'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': rid, 'epoch': epoch,
                    'error': {'code': 'stale_tree', 'message': str(e)}})
        except OpError as e:
            _stats['errors'] += 1
            _write({'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': rid, 'epoch': epoch,
                    'error': {'code': e.code, 'message': str(e)}})
        except Exception as e:
            _stats['errors'] += 1
            _write({'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': rid, 'epoch': epoch,
                    'error': {'code': 'worker_exception',
                              'message': '%s: %s' % (type(e).__name__, str(e)[:300])}})
    # stdin EOF → 正常退出


if __name__ == '__main__':
    main()
