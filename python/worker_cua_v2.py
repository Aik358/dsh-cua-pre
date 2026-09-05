#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-cua-pre worker v2 — 电脑控制 OS 层原语（对齐 zcode-cua Helper 能力面）。

在 v1（observe/element_action/click_xy/key/type/scroll/screenshot）之上新增：
  EnumWindows 窗口枚举(window_id=hwnd) / 进程名解析 / hit_test 语义优先点击 /
  drag / mouse down-up 分离 / hold_key / 三键与修饰键 / 左右横滚 /
  显示器枚举与按屏截图 / 剪贴板读写 / open_app(ShellExecute) / crop(zoom 底座) /
  select_text(键盘光标法) / cursor_pos。

协议不变：stdin/stdout 单行 UTF-8 JSONL；epoch 门 fail-closed；单行 256KiB 上限；
截图/裁剪只落盘回路径。worker 无会话状态：path 由 JS 持有，动作重走+校验漂移。
DPI per-monitor aware 最先声明。
"""

import sys
import os
import json
import time
import ctypes
import argparse
import ctypes.wintypes as wt

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 256 * 1024


def _declare_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
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
gdi32 = ctypes.windll.gdi32

# ---------------------------------------------------------------------------
# Win32 原型声明：64 位下句柄默认按 32 位截断会溢出，必须显式声明
# ---------------------------------------------------------------------------
user32.OpenClipboard.argtypes = [wt.HWND]
user32.IsClipboardFormatAvailable.argtypes = [wt.UINT]
user32.GetClipboardData.argtypes = [wt.UINT]
user32.GetClipboardData.restype = wt.HANDLE
user32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
user32.EmptyClipboard.argtypes = []
kernel32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wt.HGLOBAL
kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
kernel32.GlobalFree.argtypes = [wt.HGLOBAL]
kernel32.OpenProcess.restype = wt.HANDLE
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetForegroundWindow.restype = wt.HWND
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
# GDI：PrintWindow 真窗口截图链路（Create/Select/Delete DC·Bitmap 系在 gdi32；PrintWindow 在 user32）
user32.GetWindowDC.restype = wt.HDC
user32.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
user32.PrintWindow.argtypes = [wt.HWND, wt.HDC, wt.UINT]
user32.PrintWindow.restype = wt.BOOL
gdi32.CreateCompatibleDC.argtypes = [wt.HDC]
gdi32.CreateCompatibleDC.restype = wt.HDC
gdi32.CreateCompatibleBitmap.argtypes = [wt.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wt.HBITMAP
gdi32.SelectObject.argtypes = [wt.HDC, wt.HGDIOBJ]
gdi32.SelectObject.restype = wt.HGDIOBJ
gdi32.DeleteObject.argtypes = [wt.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wt.HDC]
gdi32.GetDIBits.argtypes = [wt.HDC, wt.HBITMAP, wt.UINT, wt.UINT, ctypes.c_void_p, ctypes.c_void_p, wt.UINT]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wt.DWORD), ('biWidth', wt.LONG), ('biHeight', wt.LONG),
                ('biPlanes', wt.WORD), ('biBitCount', wt.WORD), ('biCompression', wt.DWORD),
                ('biSizeImage', wt.DWORD), ('biXPelsPerMeter', wt.LONG),
                ('biYPelsPerMeter', wt.LONG), ('biClrUsed', wt.DWORD), ('biClrImportant', wt.DWORD)]


class _RGBQUAD(ctypes.Structure):
    _fields_ = [('rgbBlue', ctypes.c_ubyte), ('rgbGreen', ctypes.c_ubyte),
                ('rgbRed', ctypes.c_ubyte), ('rgbReserved', ctypes.c_ubyte)]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [('bmiHeader', _BITMAPINFOHEADER), ('bmiColors', _RGBQUAD * 1)]


def print_window_image(hwnd):
    """PrintWindow(PW_RENDERFULLCONTENT) 真窗口内容抓取：被遮挡也能拍全。
    返回 PIL.Image 或 None（不支持/失败）。最小化窗口直接报错。"""
    Image = _ensure_pil()[0]
    if user32.IsIconic(hwnd):
        raise OpError('window_minimized', '目标窗口已最小化，请先还原窗口再截窗')
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = int(rect.right - rect.left), int(rect.bottom - rect.top)
    if w <= 0 or h <= 0:
        return None
    hwnd_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
    old = gdi32.SelectObject(mem_dc, bmp)
    try:
        PW_RENDERFULLCONTENT = 0x02
        if not user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT):
            return None
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = 0  # BI_RGB
        buf = ctypes.create_string_buffer(w * h * 4)
        if gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(bmi), 0) == 0:
            return None
        return Image.frombuffer('RGB', (w, h), buf.raw, 'raw', 'BGRX', 0, 1)
    finally:
        gdi32.SelectObject(mem_dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, hwnd_dc)

# ---------------------------------------------------------------------------
# 依赖探测（懒加载）
# ---------------------------------------------------------------------------

_deps = {}


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
        from PIL import Image, ImageGrab
        _deps['pil'] = (Image, ImageGrab)
        return _deps['pil']
    except Exception as e:
        _deps['pil'] = None
        # 带上原始异常：cp314 wheel 装到 cp313 解释器这类错装会在这里暴露
        raise DepMissing('Pillow [' + type(e).__name__ + ': ' + str(e)[:160] + ']')


# ---------------------------------------------------------------------------
# SendInput 底座
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
MOUSEEVENTF_HWHEEL = 0x1000
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
    return user32.GetSystemMetrics(76), user32.GetSystemMetrics(77), \
        user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)


def _send_inputs(inputs):
    arr = (_INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(_INPUT))
    if sent != len(inputs):
        raise OpError('sendinput_blocked',
                      'SendInput 只注入了 %d/%d 个事件（目标窗口可能以管理员权限运行，UIPI 拒绝）'
                      % (sent, len(inputs)))


def _abs_norm(px, py):
    sx, sy, sw, sh = _virtual_screen()
    nx = max(0, min(65535, int(round((px - sx) * 65535.0 / max(1, sw - 1)))))
    ny = max(0, min(65535, int(round((py - sy) * 65535.0 / max(1, sh - 1)))))
    return nx, ny


def _mi_move(px, py):
    nx, ny = _abs_norm(px, py)
    m = _MOUSEINPUT(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None)
    i = _INPUT(); i.type = INPUT_MOUSE; i.mi = m
    return i


def _mi_btn(flags, data=0):
    m = _MOUSEINPUT(0, 0, data, flags, 0, None)
    i = _INPUT(); i.type = INPUT_MOUSE; i.mi = m
    return i


def _ki(vk, flags=0):
    k = _KEYBDINPUT(vk, 0, flags, 0, None)
    i = _INPUT(); i.type = INPUT_KEYBOARD; i.ki = k
    return i


def mouse_move_abs(px, py):
    _send_inputs([_mi_move(px, py)])


def cursor_pos():
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return {'x': int(pt.x), 'y': int(pt.y)}


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
_VK_MAP.update({'-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, ';': 0xBA, "'": 0xDE,
                ',': 0xBC, '.': 0xBE, '/': 0xBF, '\\': 0xDC, '`': 0xC0})
_MOD_VK = {'ctrl': 0x11, 'control': 0x11, 'alt': 0x12, 'shift': 0x10, 'win': 0x5B, 'meta': 0x5B}


def parse_chord(spec):
    parts = [p.strip().lower() for p in str(spec).split('+') if p.strip()]
    if not parts:
        raise OpError('bad_keys', '空键序列')
    vks = []
    for p in parts:
        vk = _MOD_VK.get(p) or _VK_MAP.get(p)
        if vk is None and len(p) == 1:
            vk = ord(p.upper())
        if vk is None:
            raise OpError('bad_keys', '无法识别的键: %s' % p)
        vks.append(vk)
    return vks


def key_down_up(vks, up=False):
    seq = []
    order = reversed(vks) if up else vks
    for vk in order:
        seq.append(_ki(vk, KEYEVENTF_KEYUP if up else 0))
    _send_inputs(seq)


def key_chord(spec, repeat=1):
    repeat = max(1, min(100, int(repeat)))
    vks = parse_chord(spec)
    for _ in range(repeat):
        key_down_up(vks)
        key_down_up(vks, up=True)


def hold_keys(spec, duration_ms):
    duration_ms = max(50, min(30000, int(duration_ms)))
    vks = parse_chord(spec)
    key_down_up(vks)
    try:
        time.sleep(duration_ms / 1000.0)
    finally:
        key_down_up(vks, up=True)


def type_text(text, cap=20000):
    units = []
    for ch in str(text)[:cap]:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            units += [0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)]
        else:
            units.append(cp)
    chunk = []
    for u in units:
        chunk += [_ki(u, KEYEVENTF_UNICODE), _ki(u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
    step = 500
    for s in range(0, len(chunk), step):
        _send_inputs(chunk[s:s + step])


_MOUSE_FLAG = {
    'left': (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    'right': (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    'middle': (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def mouse_click(px, py, button='left', double=False, triple=False, modifiers=None):
    mods = [parse_chord(m)[0] if isinstance(m, str) else m for m in (modifiers or [])]
    down_f, up_f = _MOUSE_FLAG.get(button, _MOUSE_FLAG['left'])
    pairs = 3 if triple else (2 if double else 1)
    seq = [_ki(vk) for vk in mods]
    seq.append(_mi_move(px, py))
    for idx in range(pairs):
        seq.append(_mi_btn(down_f))
        seq.append(_mi_btn(up_f))
        if double and idx == 0:
            time.sleep(0.01)
    seq += [_ki(vk, KEYEVENTF_KEYUP) for vk in reversed(mods)]
    _send_inputs(seq)


def mouse_button_event(action, px=None, py=None, button='left'):
    down_f, up_f = _MOUSE_FLAG.get(button, _MOUSE_FLAG['left'])
    seq = []
    if px is not None and py is not None:
        seq.append(_mi_move(px, py))
    seq.append(_mi_btn(down_f if action == 'down' else up_f))
    _send_inputs(seq)


def mouse_scroll(px, py, direction='down', amount=3, modifiers=None):
    notches = max(1, min(100, int(amount)))  # zcode scroll_amount 钳制 0..100
    if direction in ('down', 'right'):
        sign = -1
    elif direction in ('up', 'left'):
        sign = 1
    else:
        raise OpError('bad_direction', '方向必须是 up/down/left/right')
    flag = MOUSEEVENTF_WHEEL if direction in ('up', 'down') else MOUSEEVENTF_HWHEEL
    mods = []
    for m in (modifiers or []):
        mods += parse_chord(m)
    seq = [_ki(vk) for vk in mods]
    seq.append(_mi_move(px, py))
    # 大 amount 分批注入（每次 ≤10 格），避免部分应用对超大 delta 钳制
    while notches > 0:
        step = min(10, notches)
        seq.append(_mi_btn(flag, sign * 120 * step))
        notches -= step
    seq += [_ki(vk, KEYEVENTF_KEYUP) for vk in reversed(mods)]
    _send_inputs(seq)


def mouse_drag(fx, fy, tx, ty, modifiers=None, steps=20):
    mods = []
    for m in (modifiers or []):
        mods += parse_chord(m)
    seq = [_ki(vk) for vk in mods]
    seq.append(_mi_move(fx, fy))
    seq.append(_mi_btn(MOUSEEVENTF_LEFTDOWN))
    for s in range(1, steps + 1):
        ix = fx + (tx - fx) * s // steps
        iy = fy + (ty - fy) * s // steps
        seq.append(_mi_move(ix, iy))
    seq.append(_mi_btn(MOUSEEVENTF_LEFTUP))
    seq += [_ki(vk, KEYEVENTF_KEYUP) for vk in reversed(mods)]
    _send_inputs(seq)


# ---------------------------------------------------------------------------
# Win32 窗口/进程/显示器/剪贴板
# ---------------------------------------------------------------------------

def _pid_from_hwnd(hwnd):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _process_name(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        psapi = ctypes.WinDLL('psapi')
        if psapi.GetModuleFileNameExW(h, None, buf, 1024):
            return buf.value.replace('/', '\\').rsplit('\\', 1)[-1]
        return ''
    finally:
        kernel32.CloseHandle(h)


def _is_real_window(hwnd):
    if not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd):
        return False
    if user32.GetWindow(hwnd, 4):  # GW_OWNER
        return False
    # 跳过 cloaked(UWP 挂起)窗口
    DWMWA_CLOAKED = 14
    cloaked = wt.DWORD(0)
    try:
        ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED,
                                                   ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if cloaked.value:
            return False
    except Exception:
        pass
    return True


def _window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def enum_windows():
    out = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def cb(hwnd, lparam):
        if _is_real_window(hwnd):
            title = _window_title(hwnd)
            rect = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            fg = user32.GetForegroundWindow()
            out.append({
                'hwnd': int(hwnd),
                'title': title[:120],
                'pid': _pid_from_hwnd(hwnd),
                'bounds': [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)],
                'focused': hwnd == fg,
                'minimized': bool(user32.IsIconic(hwnd)),
            })
        return True

    proc = WNDENUMPROC(cb)
    user32.EnumWindows(proc, 0)
    return out


def list_apps():
    apps = {}
    fg_pid = _pid_from_hwnd(user32.GetForegroundWindow())
    for w in enum_windows():
        a = apps.setdefault(w['pid'], {'pid': w['pid'], 'titles': [], 'windows': []})
        a['titles'].append(w['title'])
        a['windows'].append(w)
    result = []
    for pid, a in sorted(apps.items()):
        wins = a['windows']
        main = next((w for w in wins if not w['minimized']), wins[0])
        result.append({
            'pid': pid,
            'name': _process_name(pid) or '(unknown)',
            'title': main['title'],
            'active': any(w['focused'] for w in wins) or pid == fg_pid,
            'main_window_id': main['hwnd'],
            'window_count': len(wins),
        })
    return {'apps': result}


def list_windows(sel=None):
    sel = sel or {}
    wins = enum_windows()
    if sel.get('pid') is not None:
        wins = [w for w in wins if w['pid'] == int(sel['pid'])]
    if sel.get('name'):
        want = str(sel['name']).lower().removesuffix('.exe')
        wins = [w for w in wins if _process_name(w['pid']).lower().startswith(want)]
    fg = user32.GetForegroundWindow()
    # main ≈ 该 pid 的 z 序第一个可见窗口；focused = 前台窗口
    seen_main = set()
    out = []
    for w in wins:
        main = w['pid'] not in seen_main
        if main:
            seen_main.add(w['pid'])
        w2 = dict(w)
        w2['main'] = main
        w2['focused'] = w['hwnd'] == fg
        out.append(w2)
    return {'windows': out}


def resolve_hwnd(sel):
    """hwnd > (pid+title) > pid > title 的窗口解析；返回 hwnd 或抛错。"""
    wins = enum_windows()
    if sel.get('hwnd'):
        for w in wins:
            if w['hwnd'] == int(sel['hwnd']):
                return w['hwnd']
        # 可能刚最小化/不可见：退回 EnumWindows 全量（含不可见）再找
        if user32.IsWindow(int(sel['hwnd'])):
            return int(sel['hwnd'])
        raise OpError('window_not_found', 'hwnd=%r 已不存在' % sel['hwnd'])
    cands = wins
    if sel.get('pid') is not None:
        cands = [w for w in cands if w['pid'] == int(sel['pid'])]
    t = (sel.get('title') or '').lower()
    if t:
        cands = [w for w in cands if t in w['title'].lower()]
    if not cands:
        raise OpError('window_not_found',
                      '未找到匹配的顶层窗口（pid=%r title=%r）' % (sel.get('pid'), sel.get('title')))
    return cands[0]['hwnd']


MONITOR_DEFAULTTONEAREST = 2


def list_displays():
    monitors = []
    MONITORENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HMONITOR, wt.HDC, ctypes.POINTER(wt.RECT), wt.LPARAM)

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [('cbSize', wt.DWORD), ('rcMonitor', wt.RECT), ('rcWork', wt.RECT),
                    ('dwFlags', wt.DWORD), ('szDevice', wt.WCHAR * 32)]

    def cb(hmon, hdc, lprect, lparam):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            monitors.append({
                'handle': int(hmon) & 0xFFFFFFFF,
                'bounds': [int(r.left), int(r.top), int(r.right), int(r.bottom)],
                'primary': bool(info.dwFlags & 1),
            })
        return True

    proc = MONITORENUMPROC(cb)
    user32.EnumDisplayMonitors(None, None, proc, 0)
    monitors.sort(key=lambda m: (not m['primary'], m['bounds'][0]))
    for i, m in enumerate(monitors):
        m['index'] = i + 1
    return {'displays': monitors}


CLIPBOARD_CF_UNICODETEXT = 13


def clipboard_read(retries=5):
    for attempt in range(retries):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05 * (attempt + 1))
    else:
        raise OpError('clipboard_busy', '无法打开剪贴板（被其他进程占用）')
    try:
        if not user32.IsClipboardFormatAvailable(CLIPBOARD_CF_UNICODETEXT):
            return {'text': None, 'format': 'non-text'}
        h = user32.GetClipboardData(CLIPBOARD_CF_UNICODETEXT)
        if not h:
            return {'text': None, 'format': 'empty'}
        ptr = kernel32.GlobalLock(h)
        if not ptr:
            raise OpError('clipboard_error', 'GlobalLock 失败')
        try:
            text = ctypes.cast(ctypes.c_void_p(ptr), ctypes.c_wchar_p).value or ''
        finally:
            kernel32.GlobalUnlock(h)
        return {'text': text[:100000], 'length': len(text)}
    finally:
        user32.CloseClipboard()


def clipboard_write(text):
    GMEM_MOVEABLE = 0x0002
    data = str(text).encode('utf-16-le') + b'\x00\x00'
    for attempt in range(5):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05 * (attempt + 1))
    else:
        raise OpError('clipboard_busy', '无法打开剪贴板')
    try:
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            raise OpError('clipboard_error', 'GlobalAlloc 失败')
        ptr = kernel32.GlobalLock(h)
        if not ptr:
            raise OpError('clipboard_error', 'GlobalLock 失败')
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CLIPBOARD_CF_UNICODETEXT, h):
            kernel32.GlobalFree(h)
            raise OpError('clipboard_error', 'SetClipboardData 失败')
        return {'ok': True, 'length': len(str(text))}
    finally:
        user32.CloseClipboard()


def open_app(target, activate=False, confirm_focus_steal=False, new_instance=False):
    target = str(target or '').strip()
    if not target:
        raise OpError('bad_target', 'open_app 需要可执行名/路径/URL')
    before = {w['hwnd'] for w in enum_windows()}
    try:
        os.startfile(target)  # ShellExecuteW：解析 PATH/协议/已注册应用
    except Exception as e:
        raise OpError('launch_failed', 'ShellExecute 无法启动 %r: %s' % (target, e))
    activated = False
    new_hwnd = None
    deadline = time.time() + 3.0
    while time.time() < deadline:
        time.sleep(0.2)
        for w in enum_windows():
            if w['hwnd'] not in before and w['title']:
                new_hwnd = w['hwnd']
                break
        if new_hwnd:
            break
    if activate and confirm_focus_steal and new_hwnd:
        user32.ShowWindow(new_hwnd, 9)  # SW_RESTORE
        activated = bool(user32.SetForegroundWindow(new_hwnd))
    return {'launched': True, 'target': target, 'new_window_id': new_hwnd,
            'activated': activated, 'activate_requested': bool(activate),
            'note': '' if confirm_focus_steal or not activate else 'activate=true 需要 confirm_focus_steal=true 双确认（防抢焦点）'}


# ---------------------------------------------------------------------------
# UIA 观察与元素寻址
# ---------------------------------------------------------------------------

def _short_type(ctrl):
    try:
        name = ctrl.ControlTypeName or ''
    except Exception:
        name = ''
    if name.endswith('Control'):
        name = name[:-7]
    return name or 'Unknown'


def _rid(ctrl):
    """UIA RuntimeId（特性探测：库不支持时返回 None，静默降级到路径寻址）。"""
    try:
        r = ctrl.GetRuntimeId()
        return [int(x) for x in r][:32]
    except Exception:
        return None


def _find_by_rid(win, want_rid, budget=300):
    """在窗口子树内有限 BFS 按 RuntimeId 找回漂移后的元素。"""
    if not want_rid:
        return None
    seen = 0
    queue = [win]
    while queue and seen < budget:
        cur = queue.pop(0)
        seen += 1
        try:
            kids = cur.GetChildren()
        except Exception:
            continue
        for k in kids:
            if _rid(k) == want_rid:
                return k
            queue.append(k)
    return None


KIND_MAP_CAPS = (
    ('I', 'IsInvokePatternAvailable'), ('T', 'IsTogglePatternAvailable'),
    ('E', 'IsExpandCollapsePatternAvailable'), ('S', 'IsSelectionItemPatternAvailable'),
    ('V', 'IsValuePatternAvailable'), ('L', 'IsLegacyIAccessiblePatternAvailable'),
)


def find_window_ctrl(sel):
    auto = _ensure_uia()
    hwnd = resolve_hwnd(sel)
    ctrl = auto.ControlFromHandle(hwnd)
    if ctrl is None:
        raise OpError('window_not_found', 'ControlFromHandle(%r) 返回空' % hwnd)
    return ctrl, hwnd


def observe_tree(sel, max_depth=7, max_elements=300):
    auto = _ensure_uia()
    win, hwnd = find_window_ctrl(sel)
    elements = []
    truncated = [False]

    def rec(ctrl, depth, path):
        if depth > max_depth or len(elements) >= max_elements:
            if len(elements) >= max_elements:
                truncated[0] = True
            return
        try:
            kids = ctrl.GetChildren()
        except Exception:
            return
        for i, c in enumerate(kids):
            if len(elements) >= max_elements:
                truncated[0] = True
                return
            try:
                caps = []
                for flag, check in KIND_MAP_CAPS:
                    try:
                        if getattr(c, check):
                            caps.append(flag)
                    except Exception:
                        pass
                en = 1
                try:
                    en = 1 if c.IsEnabled else 0
                except Exception:
                    pass
                entry = {'p': path + [i], 'k': _short_type(c), 'e': en, 'a': ''.join(caps)}
                nm = (c.Name or '').strip()
                if nm:
                    entry['n'] = nm[:80]
                rid = _rid(c)
                if rid:
                    entry['rid'] = rid
                try:
                    focused = 1 if getattr(c, 'HasKeyboardFocus', False) else 0
                    if focused:
                        entry['f'] = 1
                except Exception:
                    pass
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

    win_name = win.Name or ''
    win_class = win.ClassName or ''
    wr = None
    try:
        wrect = win.BoundingRectangle
        wr = [int(wrect.left), int(wrect.top), int(wrect.right), int(wrect.bottom)] if wrect else None
    except Exception:
        pass
    rec(win, 1, [])
    fg = user32.GetForegroundWindow()
    return {
        'window': {'pid': int(win.ProcessId), 'window_id': hwnd, 'title': win_name[:120],
                   'className': (win_class or '')[:80], 'rect': wr,
                   'focused': hwnd == fg},
        'elements': elements,
        'truncated': truncated[0],
        'count': len(elements),
    }


def resolve_element(sel, path, expect_t=None, expect_n=None, expect_rid=None, expect_rect=None):
    """路径重走 + 三层校验：RuntimeId（漂移可 BFS 找回）→ (type,name) → 矩形中心漂移。
    任何一层失败都 fail-closed 抛 stale_tree，绝不点错元素。"""
    auto = _ensure_uia()
    win, _hwnd = find_window_ctrl(sel)
    cur = win
    for idx in path:
        try:
            kids = cur.GetChildren()
        except Exception as e:
            raise StaleTree('tree walk failed at child index %d: %s' % (idx, e))
        if idx < 0 or idx >= len(kids):
            raise StaleTree('child index %d out of range (children=%d)' % (idx, len(kids)))
        cur = kids[idx]
    # RuntimeId 校验 + 漂移找回（库支持时才有 rid）
    rid_recovered = False
    if expect_rid and _rid(cur) != expect_rid:
        found = _find_by_rid(win, expect_rid)
        if found is None:
            raise StaleTree('runtime-id drifted: element no longer resolvable')
        cur = found
        rid_recovered = True
    if expect_t is not None and _short_type(cur).lower() != str(expect_t).lower():
        raise StaleTree('type drifted: expected %s got %s' % (expect_t, _short_type(cur)))
    if expect_n and (cur.Name or '').strip()[:80] != str(expect_n).strip()[:80]:
        raise StaleTree('name drifted: expected %r got %r' % (expect_n, (cur.Name or '')))
    # 矩形中心漂移校验（动态 UI 错位检测；无记录或无当前矩形则跳过）
    try:
        r = cur.BoundingRectangle
        cx, cy = (int(r.left) + int(r.right)) // 2, (int(r.top) + int(r.bottom)) // 2
        ex_l, ex_t, ex_r2, ex_b = [int(v) for v in expect_rect]
        ecx, ecy = (ex_l + ex_r2) // 2, (ex_t + ex_b) // 2
        tol = max(24, int((ex_r2 - ex_l) * 0.25), int((ex_b - ex_t) * 0.25))
        if abs(cx - ecx) > tol or abs(cy - ecy) > tol:
            raise StaleTree('rect drifted: expected center (%d,%d) got (%d,%d)' % (ecx, ecy, cx, cy))
    except StaleTree:
        raise
    except Exception:
        pass
    return cur, rid_recovered


def element_center(ctrl):
    r = ctrl.BoundingRectangle
    if not r or r.right <= r.left or r.bottom <= r.top:
        raise OpError('no_rect', '元素无有效矩形（可能不可见）')
    l, t, rr, b = int(r.left), int(r.top), int(r.right), int(r.bottom)
    return (l + rr) // 2, (t + b) // 2, [l, t, rr, b]


def semantic_invoke(ctrl, action):
    """语义动作尝试链；全部失败返回 None（调用方回退坐标）。"""
    attempts = []
    if action in ('click', 'invoke', 'press'):
        attempts = [
            ('invoke', lambda: ctrl.GetInvokePattern().Invoke()),
            ('legacy', lambda: ctrl.GetLegacyAccessiblePattern().DoDefaultAction()),
        ]
    elif action == 'toggle':
        attempts = [('toggle', lambda: ctrl.GetTogglePattern().Toggle())]
    elif action == 'expand':
        attempts = [('expand', lambda: ctrl.GetExpandCollapsePattern().Expand())]
    elif action == 'collapse':
        attempts = [('collapse', lambda: ctrl.GetExpandCollapsePattern().Collapse())]
    elif action == 'select':
        attempts = [
            ('select', lambda: ctrl.GetSelectionItemPattern().Select()),
            ('legacy_select', lambda: ctrl.GetLegacyAccessiblePattern().Select()),
        ]
    for name, fn in attempts:
        try:
            fn()
            return name
        except Exception:
            continue
    return None


def _window_is_foreground(ctrl):
    try:
        fg = user32.GetForegroundWindow()
        return fg and _pid_from_hwnd(fg) == int(ctrl.ProcessId)
    except Exception:
        return False


def element_action(sel, path, action='click', value=None, expect_t=None, expect_n=None,
                   button='left', double=False, modifiers=None, expect_rid=None, expect_rect=None,
                   allow_focus=True):
    auto = _ensure_uia()
    ctrl, rid_recovered = resolve_element(sel, path, expect_t, expect_n, expect_rid, expect_rect)
    used = []
    if rid_recovered:
        used.append('rid-recovered')
    if action in ('click', 'invoke', 'press', 'toggle', 'expand', 'collapse', 'select'):
        strat = semantic_invoke(ctrl, 'toggle' if action == 'toggle' else action)
        if strat:
            return {'ok': True, 'strategy': ['semantic:' + strat]}
        cx, cy, rect = element_center(ctrl)
        if not allow_focus and not _window_is_foreground(ctrl):
            # 后台优先：语义 Invoke 不可用且窗口不在前台 → 拒绝物理点击（会点到错误窗口/抢焦点）
            raise OpError('needs_foreground',
                          '语义动作不可用且目标窗口不在前台；物理点击需要前台。'
                          '重试时传 allowFocus=true（会置前窗口），或改用键盘/Value 语义。')
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        mouse_click(cx, cy, button=button, double=double, modifiers=modifiers)
        used.append('coordinate-fallback')
        return {'ok': True, 'strategy': used, 'point': [cx, cy], 'rect': rect}
    if action in ('setvalue', 'set_value'):
        text = '' if value is None else str(value)
        # Document（多行文档）控件禁用 ValuePattern：SetValue 会整体替换全部内容，
        # 且超长文档曾致 provider 崩溃——一律走插入语义。
        if _short_type(ctrl).lower() != 'document':
            try:
                ctrl.GetValuePattern().SetValue(text)
                return {'ok': True, 'strategy': ['semantic:valuepattern']}
            except Exception:
                pass
        cx, cy, rect = element_center(ctrl)
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        mouse_click(cx, cy)
        type_text(text)
        return {'ok': True, 'strategy': ['focus+unicode'], 'point': [cx, cy]}
    if action == 'typetext':
        text = '' if value is None else str(value)
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        cx, cy, rect = element_center(ctrl)
        mouse_click(cx, cy)  # 光标落点=插入点
        type_text(text)
        return {'ok': True, 'strategy': ['focus+click+unicode'], 'point': [cx, cy]}
    if action == 'scroll':
        direction = 'down' if (value or 'down') == 'down' else 'up'
        amount = 3
        try:
            pat = ctrl.GetScrollPattern()
            vert = pat.VerticalScrollPercent
            if direction == 'down':
                pat.Scroll(0, max(1, min(10, amount)))
            else:
                pat.Scroll(0, -max(1, min(10, amount)))
            used.append('scrollpattern')
            return {'ok': True, 'strategy': used, 'vertBefore': vert}
        except Exception:
            used.append('scrollpattern-unavailable')
            raise OpError('needs_foreground', '该控件不支持 ScrollPattern 后台滚动；请用坐标滚轮（需前台）。')
    if action == 'focus':
        try:
            ctrl.SetFocus()
            return {'ok': True, 'strategy': ['focus']}
        except Exception as e:
            raise OpError('focus_failed', 'SetFocus 失败: %s' % e)
    if action == 'rect':
        cx, cy, rect = element_center(ctrl)
        return {'ok': True, 'strategy': ['rect'], 'point': [cx, cy], 'rect': rect}
    raise OpError('bad_action', '未知 action: %s' % action)


def _select_text_textpattern(ctrl, start, length):
    """TextPattern 精确选区（特性探测）：成功返回 True；不支持/失败返回 False 走键盘回退。"""
    TEXT_UNIT_CHARACTER = 0
    ENDPOINT_START, ENDPOINT_END = 0, 1
    try:
        pat = ctrl.GetTextPattern()
        rng = pat.DocumentRange
        sel_range = rng.Clone()
        # 光标折叠到文档起点，再按字符前进 start、扩展 length
        sel_range.MoveEndpointByRange(ENDPOINT_START, rng, ENDPOINT_START)
        if start > 0:
            moved = sel_range.Move(TEXT_UNIT_CHARACTER, int(start))
            if moved <= 0 and start > 0:
                return False
        if length > 0:
            sel_range.MoveEndpointByUnit(ENDPOINT_END, TEXT_UNIT_CHARACTER, int(length))
        sel_range.Select()
        return True
    except Exception:
        return False


def select_text_kb(sel, path, text_range=None, expect_t=None, expect_n=None,
                   expect_rid=None, expect_rect=None):
    """TextPattern 精确选区优先；失败回退键盘光标法（聚焦→点入→Home→右移）。"""
    ctrl, _rec = resolve_element(sel, path, expect_t, expect_n, expect_rid, expect_rect)
    strategy = []
    if text_range:
        start, length = max(0, int(text_range[0])), max(0, int(text_range[1]))
        if start > 200000 or length > 100000:
            raise OpError('range_too_large', 'text_range 过大')
        if _select_text_textpattern(ctrl, start, length):
            return {'ok': True, 'strategy': ['textpattern:%d+%d' % (start, length)]}
        cx, cy, rect = element_center(ctrl)
        if not allow_focus and not _window_is_foreground(ctrl):
            raise OpError('needs_foreground',
                          '文本插入需要键盘焦点；目标窗口不在前台。重试传 allowFocus=true，'
                          '或对表单控件改用 setvalue（ValuePattern 可后台）。')
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        mouse_click(cx, cy)
        strategy = ['focus+click']
        if start > 5000 or length > 2000:
            raise OpError('range_too_large', '键盘回退模式 text_range 过大（start≤5000, length≤2000）')
        key_chord('home' if start > 0 else 'ctrl+home')
        if start > 0:
            key_chord('right', repeat=start)
        if length > 0:
            key_chord('shift+right', repeat=length)
        strategy.append('caret+%d+%d' % (start, length))
        return {'ok': True, 'strategy': strategy, 'rect': rect}
    # 无 range：仅放置光标
    cx, cy, rect = element_center(ctrl)
    try:
        ctrl.SetFocus()
    except Exception:
        pass
    mouse_click(cx, cy)
    return {'ok': True, 'strategy': ['focus+click'], 'rect': rect}


def hit_test_click(x, y, button='left', double=False, triple=False, modifiers=None,
                   mode='auto'):
    """zcode-cua coordinate 策略路由：mode=auto 命中测试失败回退裸点击；
    mode=semantic_only 只做语义命中（找不到不点击，供 a11y fail-closed）；
    mode=raw 跳过命中直接裸点击（event 策略）。"""
    auto = _ensure_uia()
    if mode != 'raw':
        try:
            c = auto.ControlFromPoint(int(x), int(y))
        except Exception:
            c = None
        hop = 0
        while c is not None and hop < 6:
            strat = semantic_invoke(c, 'click')
            if strat:
                name = (c.Name or '')[:60]
                return {'ok': True, 'strategy': ['hit-test:semantic:' + strat],
                        'hit': {'type': _short_type(c), 'name': name}}
            try:
                parent = c.GetParentControl()
            except Exception:
                parent = None
            if parent is None:
                break
            c = parent
            hop += 1
        if mode == 'semantic_only':
            return {'ok': True, 'clicked': False,
                    'strategy': ['hit-test:no-actionable'],
                    'note': '无可按压元素；semantic_only 模式未注入任何输入'}
    mouse_click(x, y, button=button, double=double, triple=triple, modifiers=modifiers)
    return {'ok': True, 'strategy': ['raw-coordinate'], 'point': [int(x), int(y)]}


# ---------------------------------------------------------------------------
# 截图 / 裁剪
# ---------------------------------------------------------------------------

def screenshot(mode='screen', sel=None, save_dir=None, quality=80, display_index=None):
    Image = _ensure_pil()[0]
    ImageGrab = _ensure_pil()[1]
    ts = time.strftime('%Y%m%d-%H%M%S')
    base = os.path.abspath(os.path.expanduser(save_dir or '.'))
    os.makedirs(base, exist_ok=True)
    img = None
    crop_note = None
    if mode == 'window' and sel:
        hwnd = resolve_hwnd(sel)
        # 优先 PrintWindow 真窗口内容（被遮挡也拍全）；失败回退全屏裁剪
        img = print_window_image(hwnd)
        if img is not None:
            crop_note = 'printwindow:hwnd=%s' % hwnd
        else:
            wins = enum_windows()
            rect = next((w2['bounds'] for w2 in wins if w2['hwnd'] == hwnd), None)
            full = ImageGrab.grab(all_screens=True)
            if rect and rect[2] > rect[0] and rect[3] > rect[1]:
                img = full.crop((max(0, rect[0]), max(0, rect[1]), rect[2], rect[3]))
                crop_note = 'window-crop:hwnd=%s' % hwnd
            else:
                img = full
                crop_note = 'full-fallback'
    elif mode == 'display' and display_index:
        img = ImageGrab.grab(all_screens=True)
        displays = list_displays()['displays']
        d = next((m for m in displays if m['index'] == int(display_index)), None)
        if d:
            b = d['bounds']
            img = img.crop((max(0, b[0]), max(0, b[1]), b[2], b[3]))
            crop_note = 'display:%d' % int(display_index)
    else:
        img = ImageGrab.grab(all_screens=True)
    if img.width > 1600:
        ratio = 1600.0 / img.width
        img = img.resize((1600, max(1, int(img.height * ratio))))
    path = os.path.join(base, 'cua-frame-%s.jpg' % ts)
    img.convert('RGB').save(path, 'JPEG', quality=max(40, min(90, int(quality))))
    return {'path': path, 'width': img.width, 'height': img.height,
            'bytes': os.path.getsize(path), 'crop': crop_note}


def crop(src_path, region, save_dir=None, quality=85):
    """zoom 底座：从已有帧文件裁剪出子帧（不重新截屏）。region=[l,t,r,b]。"""
    Image = _ensure_pil()[0]
    src = os.path.abspath(os.path.expanduser(str(src_path)))
    if not os.path.isfile(src):
        raise OpError('frame_missing', '源帧不存在: %s' % src)
    l, t, r, b = [int(v) for v in region]
    if r <= l or b <= t:
        raise OpError('bad_region', 'region 必须是 [l,t,r,b] 且 r>l, b>t')
    img = Image.open(src)
    l = max(0, min(img.width - 1, l)); t = max(0, min(img.height - 1, t))
    r = max(l + 1, min(img.width, r)); b = max(t + 1, min(img.height, b))
    child = img.crop((l, t, r, b))
    base = os.path.abspath(os.path.expanduser(save_dir or os.path.dirname(src)))
    os.makedirs(base, exist_ok=True)
    path = os.path.join(base, 'cua-zoom-%d.jpg' % int(time.time() * 1000 % 1e12))
    child.convert('RGB').save(path, 'JPEG', quality=max(40, min(95, int(quality))))
    return {'path': path, 'width': child.width, 'height': child.height,
            'bytes': os.path.getsize(path), 'src_region': [l, t, r, b]}


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

_stats = {'framesIn': 0, 'staleEpoch': 0, 'badJson': 0, 'errors': 0, 'ops': {}}


def dispatch(op, payload):
    payload = payload or {}
    if op == 'health':
        deps_ok = pil_ok = True
        try:
            _ensure_uia()
        except Exception:
            deps_ok = False
        try:
            _ensure_pil()
        except Exception:
            pil_ok = False
        return {'ok': True, 'platform': sys.platform, 'python': sys.version.split()[0],
                'pid': os.getpid(), 'workerVersion': 2,
                'deps': {'uiautomation': deps_ok, 'pillow': pil_ok}, 'stats': _stats}
    if op == 'noop':
        return {'ok': True}
    if op == 'list_apps':
        return list_apps()
    if op == 'list_windows':
        return list_windows(payload.get('sel'))
    if op == 'open_app':
        return open_app(payload.get('target'),
                        activate=bool(payload.get('activate')),
                        confirm_focus_steal=bool(payload.get('confirmFocusSteal')),
                        new_instance=bool(payload.get('newInstance')))
    if op == 'observe':
        return observe_tree(payload.get('sel') or {},
                            max_depth=int(payload.get('maxDepth') or 7),
                            max_elements=int(payload.get('maxElements') or 300))
    if op == 'element_action':
        return element_action(payload.get('sel') or {}, payload.get('path') or [],
                              action=payload.get('action') or 'click',
                              value=payload.get('value'),
                              expect_t=payload.get('expectT'), expect_n=payload.get('expectN'),
                              button=payload.get('button') or 'left',
                              double=bool(payload.get('double')),
                              modifiers=payload.get('modifiers'),
                              expect_rid=payload.get('expectRid'),
                              expect_rect=payload.get('expectRect'),
                              allow_focus=bool(payload.get('allowFocus', True)))
    if op == 'select_text':
        return select_text_kb(payload.get('sel') or {}, payload.get('path') or [],
                              text_range=payload.get('textRange'),
                              expect_t=payload.get('expectT'), expect_n=payload.get('expectN'),
                              expect_rid=payload.get('expectRid'),
                              expect_rect=payload.get('expectRect'),
                              allow_focus=bool(payload.get('allowFocus', True)))
    if op == 'hit_click':
        return hit_test_click(int(payload['x']), int(payload['y']),
                              button=payload.get('button') or 'left',
                              double=bool(payload.get('double')),
                              triple=bool(payload.get('triple')),
                              modifiers=payload.get('modifiers'),
                              mode=payload.get('mode') or 'auto')
    if op == 'click_xy':
        px, py = int(payload['x']), int(payload['y'])
        mouse_click(px, py, button=payload.get('button') or 'left',
                    double=bool(payload.get('double')), triple=bool(payload.get('triple')),
                    modifiers=payload.get('modifiers'))
        return {'ok': True, 'strategy': ['raw-coordinate'], 'point': [px, py]}
    if op == 'drag':
        f, t = payload['from'], payload['to']
        mouse_drag(int(f['x']), int(f['y']), int(t['x']), int(t['y']),
                   modifiers=payload.get('modifiers'),
                   steps=max(5, min(60, int(payload.get('steps') or 20))))
        return {'ok': True, 'strategy': ['drag']}
    if op == 'mouse_move':
        mouse_move_abs(int(payload['x']), int(payload['y']))
        return {'ok': True, 'point': [int(payload['x']), int(payload['y'])]}
    if op == 'mouse_button_event':
        px, py = payload.get('x'), payload.get('y')
        mouse_button_event(payload.get('action') or 'down',
                           int(px) if px is not None else None,
                           int(py) if py is not None else None,
                           button=payload.get('button') or 'left')
        return {'ok': True}
    if op == 'cursor_pos':
        r = dict(cursor_pos())
        r['ok'] = True
        return r
    if op == 'key':
        key_chord(payload.get('keys') or '', repeat=int(payload.get('repeat') or 1))
        return {'ok': True}
    if op == 'hold':
        hold_keys(payload.get('keys') or '', duration_ms=int(payload.get('durationMs') or 1000))
        return {'ok': True}
    if op == 'type':
        type_text(payload.get('text') or '')
        return {'ok': True}
    if op == 'scroll':
        px, py = payload.get('x'), payload.get('y')
        if px is None or py is None:
            sx, sy, sw, sh = _virtual_screen()
            px, py = sx + sw // 2, sy + sh // 2
        mouse_scroll(int(px), int(py), direction=payload.get('direction') or 'down',
                     amount=int(payload.get('amount') or 3), modifiers=payload.get('modifiers'))
        return {'ok': True, 'point': [int(px), int(py)]}
    if op == 'clipboard_read':
        return clipboard_read()
    if op == 'clipboard_write':
        return clipboard_write(payload.get('text') or '')
    if op == 'list_displays':
        return list_displays()
    if op == 'screenshot':
        return screenshot(mode=payload.get('mode') or 'screen', sel=payload.get('sel'),
                          save_dir=payload.get('saveDir'), quality=int(payload.get('quality') or 80),
                          display_index=payload.get('displayIndex'))
    if op == 'crop':
        return crop(payload.get('srcPath'), payload.get('region') or [0, 0, 1, 1],
                    save_dir=payload.get('saveDir'), quality=int(payload.get('quality') or 85))
    raise OpError('unknown_op', '未知 op: %s' % op)


def _write(obj):
    line = json.dumps(obj, ensure_ascii=True, separators=(',', ':'))
    if len(line.encode('utf-8')) > MAX_LINE_BYTES:
        obj = {'v': PROTOCOL_VERSION, 'dir': 'err', 'requestId': obj.get('requestId'),
               'epoch': obj.get('epoch'),
               'error': {'code': 'response_oversize', 'message': 'response exceeded frame cap'}}
        line = json.dumps(obj, ensure_ascii=True, separators=(',', ':'))
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def main():
    # [patch 2026-08-26] 中文 Windows 下 sys.stdin 默认 GBK，宿主发来的 UTF-8 JSON 帧
    # 里的中文元素名会被解码成乱码，导致 name drifted 误报。强制 UTF-8。
    try:
        sys.stdin.reconfigure(encoding='utf-8', errors='replace')
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--expect-epoch', required=True)
    args = ap.parse_args()
    epoch = args.expect_epoch
    _write({'v': PROTOCOL_VERSION, 'dir': 'evt', 'requestId': '', 'epoch': epoch,
            'payload': {'event': 'ready', 'pid': os.getpid(), 'workerVersion': 2,
                        'python': sys.version.split()[0]}})
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
            continue
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
                              'message': '%s 未安装。修复: .venv/Scripts/pip install -r python/requirements.txt'
                                         % e.package}})
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


if __name__ == '__main__':
    main()
