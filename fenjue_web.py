# -*- coding: utf-8 -*-
"""焚决 · 提示词库（Web 版）

Python 负责：数据读写、文件对话框、剪贴板、打开链接/文件夹
HTML/CSS/JS 负责：全部界面（毛玻璃、圆角、动画）

数据文件与 tkinter 版共用，可直接迁移。
"""
import json
import os
import sys
import threading
import time
import webbrowser

try:
    import webview
except ImportError:
    print("缺少 pywebview，请先运行： python -m pip install pywebview")
    sys.exit(1)

APP_NAME = "焚决 · 提示词库"
APP_VER = "2.0"
DEV_NAME = "装杯大王"
DEV_URL = ("https://www.douyin.com/user/"
           "MS4wLjABAAAACh8iYCv6BE5kmCOB4oMgTg87d9hKrikGSmOO2wrvpTY"
           "?from_tab_name=main")

# ---------------------------------------------------------------
# 路径：优先放程序同级，方便绿色版携带
# ---------------------------------------------------------------
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"


def base_dir():
    """程序所在目录（用户能看到、能写的那一层）。

    macOS 打包成 .app 后，结构是：
        焚决.app/Contents/MacOS/焚决      ← sys.executable
    如果把数据放在 exe 旁边，就等于塞进 .app 里面 ——
    用户根本找不到，而且签名之后可能只读。
    所以 mac 上要往上退两层，回到 .app 所在的目录。
    """
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        if IS_MAC and ".app/Contents/MacOS" in sys.executable.replace("\\", "/"):
            # .../焚决.app/Contents/MacOS/焚决 → .../（.app 所在目录）
            p = exe_dir
            for _ in range(3):          # MacOS → Contents → 焚决.app → 上层
                p = os.path.dirname(p)
            return p
        return exe_dir
    return os.path.dirname(os.path.abspath(__file__))


def web_dir():
    """网页资源目录。
    Windows 目录版：exe 同级的 _internal\\web
    macOS .app     ：.app/Contents/Resources/web（或 Frameworks/web）
    单文件版       ：解包目录 _MEIPASS/web
    """
    if getattr(sys, "frozen", False):
        mei = getattr(sys, "_MEIPASS", None)
        cands = []
        if mei:
            cands.append(os.path.join(mei, "web"))
        # mac .app 里 PyInstaller 可能放 Resources 或 Frameworks
        if IS_MAC:
            exe_dir = os.path.dirname(sys.executable)
            contents = os.path.dirname(exe_dir)          # .../Contents
            cands.append(os.path.join(contents, "Resources", "web"))
            cands.append(os.path.join(contents, "Frameworks", "web"))
        # Windows 目录版
        cands.append(os.path.join(base_dir(), "_internal", "web"))
        cands.append(os.path.join(base_dir(), "web"))
        for c in cands:
            if os.path.isdir(c):
                return c
        return cands[0]
    return os.path.join(base_dir(), "web")


def _pick_data_dir():
    """决定「焚决数据」放哪。

    ★ 关键：不能无脑用 exe 同级目录。
      单文件版 exe 在 E:\\ZM\\ 下，数据在 E:\\ZM\\焚决数据\\；
      换成目录版后 exe 变成 E:\\ZM\\焚决提示词库-Web\\焚决提示词库-Web.exe，
      数据就会跑到 E:\\ZM\\焚决提示词库-Web\\焚决数据\\ —— 用户的 31 条
      提示词就"不见了"。

    查找顺序（先看有没有现成数据，再决定新建在哪）：
      1. 环境变量 FENJUE_DATA 指定
      2. exe 同级的 焚决数据
      3. exe 所在目录的【上一级】的 焚决数据   ← 目录版会命中这里
      4. 都没找到：建在 exe 同级
    """
    env = os.environ.get("FENJUE_DATA")
    if env:
        return env

    here = base_dir()
    cands = [
        os.path.join(here, "焚决数据"),
        os.path.join(os.path.dirname(here), "焚决数据"),
    ]
    for c in cands:
        if os.path.isfile(os.path.join(c, "prompts.json")):
            return c
    # 已有目录但没文件，也算"用户选的位置"
    for c in cands:
        if os.path.isdir(c):
            return c
    return cands[0]


DATA_DIR = _pick_data_dir()
DATA_FILE = os.path.join(DATA_DIR, "prompts.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

DEBUG = bool(os.environ.get("FENJUE_DEBUG"))
_LOGF = None

# 当前壁纸路径（由前端通过 set_wallpaper 告知，供 /__wallpaper 直通）
WALLPAPER = {"path": ""}

MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".bmp": "image/bmp", ".webp": "image/webp", ".gif": "image/gif",
    ".avif": "image/avif",
}


def _dbg(msg):
    """写日志文件（--windowed 打包后没有控制台，只能落盘）"""
    global _LOGF
    if not DEBUG:
        return
    try:
        if _LOGF is None:
            _LOGF = open(os.path.join(base_dir(), "fenjue-debug.log"),
                         "a", encoding="utf-8", buffering=1)
        _LOGF.write(str(msg) + "\n")
    except Exception:
        pass

DEFAULT_CONFIG = {
    "prefix_enabled": False,
    "prefix_text": "",
    "suffix_enabled": False,
    "suffix_text": "",
    "scheme": "default",
    "wallpaper": "",
    "glassBlur": 18,
    "glassAlpha": 55,
    "wpOpacity": 100,
    "lens": 100,          # 折射透镜带强度 %
    "locked": True,       # 列表锁：锁定后不可拖动排序
    "customBg": "#fbfaf8",
    "customFg": "#3a3733",
    "customAccent": "#8fa8c8",
}


def ensure_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def read_json(path, fallback):
    """读 JSON。
    ⚠ 必须用 utf-8-sig：记事本 / PowerShell 写的文件常带 BOM，
      用严格 utf-8 会解析失败 → 配置被静默忽略（壁纸、配色全部丢失）。
      这个坑很难查，所以两种编码都试。"""
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            with open(path, "r", encoding=enc) as f:
                return json.load(f)
        except FileNotFoundError:
            return fallback
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        except Exception:
            return fallback
    _dbg("read_json 无法解析 %s" % path)
    return fallback


def write_json(path, obj):
    """写 JSON。用 utf-8-sig 之外的无 BOM 编码，
    这样记事本打开也正常，且不会被自己的 read_json 误判。"""
    ensure_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ---------------------------------------------------------------
# 剪贴板（跨平台，不依赖 tkinter）
# ---------------------------------------------------------------
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def _clipboard_write_win(text):
    """Windows：ctypes 直连 user32/kernel32。

    以前用 tkinter 做这事，代价是打包时必须带上整个 Tcl/Tk
    （69 个 .tcl 文件 + tk86t.dll + tcl86t.dll，约 1.5MB），
    只为调一个 OpenClipboard。
    """
    import ctypes
    from ctypes import wintypes

    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32

    u32.OpenClipboard.argtypes = [wintypes.HWND]
    u32.OpenClipboard.restype = wintypes.BOOL
    u32.EmptyClipboard.argtypes = []
    u32.EmptyClipboard.restype = wintypes.BOOL
    u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    u32.SetClipboardData.restype = wintypes.HANDLE
    u32.CloseClipboard.argtypes = []
    u32.CloseClipboard.restype = wintypes.BOOL

    k32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k32.GlobalAlloc.restype = wintypes.HGLOBAL
    # ★ HGLOBAL 是指针，restype 必须显式声明为 c_void_p。
    #   不声明的话 ctypes 默认按 C int 返回，64 位下会被截断成 32 位，
    #   再 memmove 过去就是写坏内存 —— 表现为"写入返回成功但读回来是脏数据"。
    k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    k32.GlobalUnlock.restype = wintypes.BOOL
    k32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    k32.GlobalFree.restype = wintypes.HGLOBAL

    data = str(text).encode("utf-16-le") + b"\x00\x00"
    n = len(data)

    opened = False
    for _ in range(10):
        if u32.OpenClipboard(None):
            opened = True
            break
        time.sleep(0.03)
    if not opened:
        raise RuntimeError("OpenClipboard 失败（剪贴板被占用）")

    try:
        u32.EmptyClipboard()
        h = k32.GlobalAlloc(GMEM_MOVEABLE, n)
        if not h:
            raise RuntimeError("GlobalAlloc 失败")
        p = k32.GlobalLock(h)
        if not p:
            raise RuntimeError("GlobalLock 失败")
        ctypes.memmove(p, data, n)
        k32.GlobalUnlock(h)
        if not u32.SetClipboardData(CF_UNICODETEXT, h):
            raise RuntimeError("SetClipboardData 失败")
        # ★ 成功后内存所有权归系统，不能再 GlobalFree
    finally:
        u32.CloseClipboard()

    return True


def _clipboard_write_mac(text):
    """macOS：用系统自带的 pbcopy。

    pbcopy 是每台 mac 都有的标准命令，不需要任何依赖。
    还能天然处理中文和 emoji —— 它按 UTF-8 收。
    """
    import subprocess
    p = subprocess.run(["pbcopy"], input=str(text).encode("utf-8"),
                       timeout=5, check=False)
    if p.returncode != 0:
        raise RuntimeError("pbcopy 返回码 %d" % p.returncode)


def _clipboard_write_linux(text):
    """Linux：依次尝试 xclip / xsel / wl-copy（Wayland）。"""
    import subprocess
    payload = str(text).encode("utf-8")
    for cmd in (["wl-copy"], ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"]):
        try:
            p = subprocess.run(cmd, input=payload, timeout=5, check=False)
            if p.returncode == 0:
                return
        except FileNotFoundError:
            continue
    raise RuntimeError("找不到可用的剪贴板工具（xclip / xsel / wl-copy）")


def _clipboard_write(text):
    """按平台分发。改这一处就能支持新系统。"""
    if IS_WIN:
        return _clipboard_write_win(text)
    if IS_MAC:
        return _clipboard_write_mac(text)
    return _clipboard_write_linux(text)


# ---------------------------------------------------------------
# 暴露给 JS 的接口
# ---------------------------------------------------------------
class Api:
    def __init__(self):
        self.window = None

    # ---- 数据 ----
    def load(self):
        _dbg("load() 被调用  DATA_FILE=%s" % DATA_FILE)
        try:
            items = read_json(DATA_FILE, None)
            if items is None:
                items = []
            cfg = read_json(CONFIG_FILE, {})
            merged = dict(DEFAULT_CONFIG)
            merged.update(cfg or {})
            _dbg("  items=%d  cfg.wallpaper=%r  cfg.scheme=%r"
                 % (len(items), merged.get("wallpaper"), merged.get("scheme")))
            return {"items": items, "cfg": merged}
        except Exception as e:
            _dbg("  !! load 异常: %r" % (e,))
            raise

    def save_items(self, items):
        try:
            write_json(DATA_FILE, items)
            return True
        except Exception as e:
            print("保存提示词失败:", e)
            return False

    def save_cfg(self, cfg):
        try:
            cur = read_json(CONFIG_FILE, {}) or {}
            cur.update(cfg or {})
            write_json(CONFIG_FILE, cur)
            return True
        except Exception as e:
            print("保存配置失败:", e)
            return False

    # ---- 剪贴板 ----
    def copy(self, text):
        """用 Win32 API 写剪贴板。

        以前是 import tkinter + tk.Tk() 来做这件事 —— 只为写个剪贴板
        就要拉起整个 Tcl/Tk 运行时，打包时被牵连进 69 个 .tcl 文件和
        1.47MB 的 tk86t.dll/tcl86t.dll。改用 ctypes 直连 user32，
        既快又省，还能把 Tcl/Tk 从包里整个剔掉。
        """
        try:
            _clipboard_write(str(text))
            return True
        except Exception as e:
            _dbg("剪贴板失败: %r" % (e,))
            return False

    # ---- 文件对话框 ----
    def open_dialog(self):
        try:
            res = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("JSON 备份 (*.json)", "所有文件 (*.*)"))
            if res:
                return res[0] if isinstance(res, (list, tuple)) else res
        except Exception as e:
            print("打开对话框失败:", e)
        return None

    def save_dialog(self, default_name):
        try:
            res = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=default_name,
                file_types=("JSON 备份 (*.json)", "所有文件 (*.*)"))
            if res:
                return res if isinstance(res, str) else res[0]
        except Exception as e:
            print("保存对话框失败:", e)
        return None

    def open_image(self):
        try:
            res = self.window.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("图片 (*.png;*.jpg;*.jpeg;*.bmp;*.webp;*.gif)",
                            "所有文件 (*.*)"))
            if res:
                return res[0] if isinstance(res, (list, tuple)) else res
        except Exception as e:
            print("选择图片失败:", e)
        return None

    def read_text(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            print("读取失败:", e)
            return None

    def write_text(self, path, text):
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            return True
        except Exception as e:
            print("写入失败:", e)
            return False

    # ---- 链接 / 文件夹 ----
    def open_url(self, url):
        try:
            webbrowser.open(url, new=2)
            return True
        except Exception:
            return False

    def open_data_dir(self):
        """在系统文件管理器里打开数据目录（跨平台）。"""
        try:
            ensure_dir()
            if IS_WIN:
                os.startfile(DATA_DIR)                       # noqa: S606
            elif IS_MAC:
                import subprocess
                subprocess.run(["open", DATA_DIR], check=False)
            else:
                import subprocess
                subprocess.run(["xdg-open", DATA_DIR], check=False)
            return True
        except Exception as e:
            _dbg("打开文件夹失败: %r" % (e,))
            return False

    def paths(self):
        ensure_dir()
        return {"prompts": DATA_FILE, "config": CONFIG_FILE,
                "dir": DATA_DIR, "app": APP_NAME, "ver": APP_VER}

    # ---- 壁纸直通（绕开 http→file 的安全限制）----
    def set_wallpaper(self, path):
        """前端告知当前壁纸路径，之后 /__wallpaper 会把它作为图片输出"""
        try:
            WALLPAPER["path"] = (path or "").strip()
            _dbg("set_wallpaper -> %r" % WALLPAPER["path"])
            return True
        except Exception as e:
            _dbg("set_wallpaper 失败: %r" % (e,))
            return False

    def wallpaper_url(self):
        """返回可直接放进 CSS background-image 的地址"""
        return "/__wallpaper?t=%d" % int(time.time() * 1000)

    # ---- 无边框窗口操作 ----
    # 注意：frameless 窗口的样式里没有 WS_THICKFRAME，也没有标题栏，
    # 所以"拖动窗口"和"拉伸边缘"都必须由前端发起、Python 执行。
    def win_state(self):
        """返回窗口位置/尺寸/是否最大化，供前端计算拖动与拉伸"""
        try:
            w = self.window
            return {"x": int(w.x), "y": int(w.y),
                    "w": int(w.width), "h": int(w.height),
                    "max": bool(getattr(self, "_maxed", False))}
        except Exception as e:
            _dbg("win_state 失败: %r" % (e,))
            return None

    def win_move(self, x, y):
        """把窗口移动到屏幕坐标 (x, y)"""
        try:
            if getattr(self, "_maxed", False):
                return False          # 最大化状态下不允许拖
            self.window.move(int(x), int(y))
            return True
        except Exception as e:
            _dbg("win_move 失败: %r" % (e,))
            return False

    def win_resize(self, w, h, anchor):
        """按锚点方向拉伸窗口。
        anchor 取值：nw / n / ne / w / e / sw / s / se（与 CSS 的光标方向一致）。
        锚点决定哪条边固定不动 —— 例如拖右边(e)时左边固定，所以锚点在西(WEST)。

        注意 FixPoint 是位标志：NORTH=1 WEST=2 EAST=4 SOUTH=8。
        默认值是 NORTH|WEST（左上固定），所以"按方向传"会解析错，
        必须把每一档都算清楚再传。
        """
        try:
            if getattr(self, "_maxed", False):
                return False
            from webview.window import FixPoint
            w = int(max(820, min(6000, w)))      # 与 min_size 保持一致
            h = int(max(560, min(4000, h)))
            a = (anchor or "se").strip().lower()

            # 固定边 = 与拖动方向相反的那一侧
            fix_left   = "e" in a       # 往右拉 → 左边固定
            fix_right  = "w" in a       # 往左拉 → 右边固定
            fix_top    = "s" in a       # 往下拉 → 上边固定
            fix_bottom = "n" in a       # 往上拉 → 下边固定

            # 只拉一边时，另一轴默认固定左侧/顶部
            if not fix_left and not fix_right:
                fix_left = True
            if not fix_top and not fix_bottom:
                fix_top = True

            fp = FixPoint(0)
            if fix_left:
                fp |= FixPoint.WEST
            if fix_right:
                fp |= FixPoint.EAST
            if fix_top:
                fp |= FixPoint.NORTH
            if fix_bottom:
                fp |= FixPoint.SOUTH

            self.window.resize(w, h, fp)
            return True
        except Exception as e:
            _dbg("win_resize 失败: %r" % (e,))
            return False

    def win_minimize(self):
        try:
            self.window.minimize()
            return True
        except Exception as e:
            _dbg("win_minimize 失败: %r" % (e,))
            return False

    def win_toggle_max(self):
        """最大化 / 还原，返回切换后的状态（True = 已最大化）"""
        try:
            if getattr(self, "_maxed", False):
                self.window.restore()
                self._maxed = False
            else:
                self.window.maximize()
                self._maxed = True
            return self._maxed
        except Exception as e:
            _dbg("win_toggle_max 失败: %r" % (e,))
            return getattr(self, "_maxed", False)

    def win_toggle_fullscreen(self):
        try:
            self.window.toggle_fullscreen()
            return True
        except Exception as e:
            _dbg("win_toggle_fullscreen 失败: %r" % (e,))
            return False

    def win_close(self):
        try:
            _dbg("win_close: 准备 destroy")
            self.window.destroy()
            _dbg("win_close: destroy 已调用")
            return True
        except Exception as e:
            _dbg("win_close 失败: %r" % (e,))
            return False


# ---------------------------------------------------------------
# 本地 HTTP 服务
# 直接 file:// 打开会有两个坑：
#   1) 相对路径的图片/脚本在部分内核下被拒
#   2) localStorage 在 file:// 下受限、fetch 不可用
# 所以内部起一个只绑 127.0.0.1 的静态服务，端口随机，仅本机可访问。
# ---------------------------------------------------------------
import http.server
import socketserver
import threading
import functools


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if DEBUG:
            _dbg("HTTP " + (fmt % args))

    def log_error(self, fmt, *args):
        # 404 之类一定要记下来，否则打包后黑屏无从排查
        _dbg("HTTP-ERR " + (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ★ 首页注入初始数据。
    #   之前靠前端异步等 pywebview 桥就绪再调 load()，但 pywebview 会在
    #   桥还是【空对象】时就派发 pywebviewready，前端容易误判而静默回落
    #   localStorage —— 表现就是"配置读不到、壁纸不显示"。
    #   改成由 Python 在返回 HTML 时把数据以同步脚本注入，彻底消除竞态。
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/__wallpaper"):
            return self._serve_wallpaper()
        if path in ("/", "/index.html"):
            return self._serve_index()
        return super().do_GET()

    def do_HEAD(self):
        path = self.path.split("?")[0]
        if path.startswith("/__wallpaper"):
            return self._serve_wallpaper(head_only=True)
        return super().do_HEAD()

    def _serve_index(self):
        try:
            with open(os.path.join(self.directory, "index.html"),
                      "r", encoding="utf-8") as f:
                html = f.read()
            items = read_json(DATA_FILE, [])
            if not isinstance(items, list):
                items = []
            cfg = dict(DEFAULT_CONFIG)
            cfg.update(read_json(CONFIG_FILE, {}) or {})
            boot = json.dumps(
                {
                    "items": items, "cfg": cfg, "api": True,
                    # ★ 前端要知道自己在哪个系统上：
                    #   Windows → 无边框 + 自绘标题栏 + 自绘窗口按钮
                    #   macOS   → 原生标题栏（红绿灯），隐藏自绘那些
                    "platform": "win" if IS_WIN else ("mac" if IS_MAC else "linux"),
                    "customChrome": bool(IS_WIN),   # 只有 Windows 用自绘窗口
                },
                ensure_ascii=False)
            # 放在所有脚本之前，app.js 一执行就能同步拿到
            tag = ('<script id="__boot_data__" type="application/json">'
                   + boot.replace("</", "<\\/") + "</script>")
            if "</head>" in html:
                html = html.replace("</head>", tag + "\n</head>", 1)
            else:
                html = tag + html
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            _dbg("首页已注入初始数据: items=%d wallpaper=%r"
                 % (len(items), cfg.get("wallpaper")))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            _dbg("注入首页失败: %r" % (e,))
            return super().do_GET()

    def _serve_wallpaper(self, head_only=False):
        path = WALLPAPER["path"]
        try:
            if not path or not os.path.isfile(path):
                self.send_error(404, "no wallpaper")
                return
            ext = os.path.splitext(path)[1].lower()
            ctype = MIME.get(ext, "application/octet-stream")
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            _dbg("壁纸直通 %s (%d 字节, %s)" % (path, size, ctype))
            if head_only:
                return
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            _dbg("壁纸直通失败: %r" % (e,))
            try:
                self.send_error(500, "wallpaper error")
            except Exception:
                pass


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(directory):
    handler = functools.partial(_QuietHandler, directory=directory)
    httpd = _Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, port


# ---------------------------------------------------------------
def main():
    ensure_dir()
    root = web_dir()
    index = os.path.join(root, "index.html")
    _dbg("=== 启动 ===")
    _dbg("frozen     = %s" % getattr(sys, "frozen", False))
    _dbg("base_dir   = %s" % base_dir())
    _dbg("web_dir    = %s" % root)
    _dbg("web 存在   = %s" % os.path.isdir(root))
    if os.path.isdir(root):
        for n in sorted(os.listdir(root)):
            _dbg("   %-16s %8d" % (n, os.path.getsize(os.path.join(root, n))
                                   if os.path.isfile(os.path.join(root, n)) else -1))
    _dbg("index 存在 = %s" % os.path.isfile(index))

    if not os.path.isfile(index):
        _dbg("!! 找不到 index.html，退出")
        print("找不到网页资源:", index)
        sys.exit(1)

    httpd, port = start_server(root)
    url = "http://127.0.0.1:%d/index.html" % port
    _dbg("服务地址 = %s" % url)
    print("界面地址:", url)
    print("数据目录:", DATA_DIR)

    api = Api()
    # ★ 窗口风格按平台分：
    #   Windows —— 无边框 + 自绘标题栏和窗口按钮（很 Windows 风格的定制）
    #   macOS   —— 用【原生标题栏】。Mac 用户习惯左上角红黄绿三个按钮，
    #              自己画一套反而别扭；而且 .app 拖拽/全屏交给系统更稳。
    #   Linux   —— 同样用原生标题栏。
    use_custom_chrome = IS_WIN and not bool(os.environ.get("FENJUE_CHROME"))
    window = webview.create_window(
        "%s v%s" % (APP_NAME, APP_VER),
        url=url,
        js_api=api,
        width=1060, height=740,
        min_size=(820, 560),
        background_color="#fbfaf8",
        text_select=True,
        frameless=use_custom_chrome,
        easy_drag=False,
    )
    _dbg("窗口风格: %s" % ("自绘(无边框)" if use_custom_chrome else "原生标题栏"))
    api.window = window
    _dbg("窗口已创建，进入 start()")

    # WebView2 的用户数据目录默认写 %APPDATA%\pywebview，时间久了会攒到几百 MB。
    # 固定到程序自己的目录（便携 + 换机器能一起带走）。
    try:
        storage = os.path.join(base_dir(), "缓存")
        os.makedirs(storage, exist_ok=True)
    except Exception:
        storage = None
    _dbg("storage_path = %r" % (storage,))

    try:
        webview.start(debug=DEBUG, storage_path=storage)
    except TypeError:
        # 老版本 pywebview 不认 storage_path，退回默认
        _dbg("storage_path 不被支持，改用默认")
        webview.start(debug=DEBUG)
    except Exception as e:
        _dbg("webview.start 异常: %r" % (e,))
    finally:
        _dbg("=== 退出 ===")
        try:
            httpd.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
