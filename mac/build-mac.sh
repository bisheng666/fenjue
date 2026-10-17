#!/bin/bash
# ============================================================
#  焚决 · 提示词库 —— macOS 打包脚本
#
#  在【任意一台 Mac】上运行这个脚本，就能得到 焚决提示词库.app
#
#  用法（在终端里）：
#      cd 这个文件夹的上一级
#      bash mac/build-mac.sh
#
#  支持的芯片：
#      M1 / M2 / M3 / M4  → 自动打 arm64（原生，最快）
#      Intel Mac          → 自动打 x86_64
#
#  前提：装了 Xcode Command Line Tools
#      终端执行一次：  xcode-select --install
# ============================================================

set -e          # 任何一步失败就停下，不要静默出错

# ---------- 0. 定位 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"          # 上一层 = 项目根目录
cd "$ROOT"

APP_NAME="焚决提示词库-Web"
BUNDLE_NAME="焚决提示词库"
ENTRY="fenjue_web.py"

echo "=============================================="
echo "  焚决 · 提示词库  macOS 打包"
echo "=============================================="
echo "  项目目录: $ROOT"
echo "  系统版本: $(sw_vers -productVersion)"
echo "  芯片架构: $(uname -m)"
echo ""

# ---------- 1. 检查架构 ----------
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  echo "✓ Apple Silicon (M 系列) —— 将打包 arm64 原生应用"
  PY_TARGET_ARCH="arm64"
else
  echo "✓ Intel Mac —— 将打包 x86_64 应用"
  PY_TARGET_ARCH="x86_64"
fi
echo ""

# ---------- 2. 找 Python ----------
# 优先用 python3.12 / 3.11，其次任意 python3
PYTHON=""
for cand in python3.12 python3.11 python3.13 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    PYTHON="$cand"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "✗ 找不到 Python 3"
  echo ""
  echo "  请先装 Python："
  echo "    方式一（推荐）：去 https://www.python.org/downloads/ 下 pkg 安装"
  echo "    方式二：装 Homebrew 后  brew install python@3.12"
  echo ""
  exit 1
fi

PY_VER="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "✓ Python: $PYTHON  (版本 $PY_VER)"
echo ""

# ---------- 3. 建虚拟环境 ----------
VENV="$ROOT/.venv-mac"
if [ -d "$VENV" ]; then
  echo "→ 复用已有的虚拟环境"
else
  echo "→ 创建虚拟环境（隔离依赖，不污染系统 Python）"
  "$PYTHON" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

# ---------- 4. 装依赖 ----------
echo ""
echo "→ 安装依赖（首次会比较慢，需要联网）"
python -m pip install --upgrade pip --quiet

# ★ pywebview 在 macOS 上依赖 6 个 pyobjc 包
#   （这是它 METADATA 里 sys_platform == "darwin" 明确声明的）。
#   pip install pywebview 本来也会自动拉，但这里全写出来 ——
#   万一将来 pywebview 改了依赖，我们这套仍能跑。
#   版本钉住：本地验证过 pywebview 6.2.1 + PyInstaller 6.22.3 的组合。
python -m pip install --quiet \
  "pywebview>=5.0,<7" \
  "pyobjc-core>=9.0" \
  "pyobjc-framework-Cocoa>=9.0" \
  "pyobjc-framework-Quartz>=9.0" \
  "pyobjc-framework-WebKit>=9.0" \
  "pyobjc-framework-security>=9.0" \
  "pyobjc-framework-UniformTypeIdentifiers>=9.0" \
  "pyinstaller>=6.0,<7"

echo "✓ 装上的版本："
python - <<'PYEOF'
import importlib.metadata as md
for name in ["pywebview", "pyinstaller", "pyobjc-core",
             "pyobjc-framework-Cocoa", "pyobjc-framework-WebKit",
             "pyobjc-framework-Quartz", "pyobjc-framework-security",
             "pyobjc-framework-UniformTypeIdentifiers"]:
    try:
        print("    %-44s %s" % (name, md.version(name)))
    except Exception:
        print("    %-44s ✗ 没装上" % name)
PYEOF
echo ""

# ★ 关键一步：确认 pyobjc 真的能 import
#   PyInstaller 是靠分析 import 语句来决定收集哪些模块的。
#   如果 import 不成功，打出来的 .app 会在启动时崩：
#     ModuleNotFoundError: No module named 'objc'
echo "→ 验证 pyobjc 能 import"
PYOBJC_FAIL=0
python - <<'PYEOF' || PYOBJC_FAIL=1
import sys
mods = ["objc", "AppKit", "Foundation", "WebKit", "Quartz", "Security",
        "UniformTypeIdentifiers", "CoreFoundation"]
bad = 0
for m in mods:
    try:
        __import__(m)
        print("    ✓ %s" % m)
    except Exception as e:
        bad += 1
        print("    ✗ %s -> %s" % (m, e))
sys.exit(1 if bad else 0)
PYEOF
if [ "$PYOBJC_FAIL" != "0" ]; then
  echo ""
  echo "✗ pyobjc 模块 import 失败 —— 继续打包只会得到一个启动即崩的 .app"
  echo "  常见原因："
  echo "    · Python 版本太新/太旧（建议 3.10 ~ 3.12）"
  echo "    · 之前装过旧版 pyobjc 冲突（删掉 .venv-mac 重新跑）"
  echo ""
  exit 1
fi
echo ""

# ---------- 5. 清理旧产物 ----------
echo "→ 清理上次的打包产物"
rm -rf build dist "$APP_NAME.spec"
echo ""

# ---------- 6. 打包 ----------
echo "→ 开始打包（可能要 1~3 分钟）"
echo ""

# 关键参数说明：
#   --windowed      → 生成 .app（不是命令行程序）
#   --osx-bundle-identifier → 唯一标识，macOS 认这个
#   --target-arch   → 明确架构，M 芯片必须是 arm64
#   --exclude-module tkinter 等 → 省体积（我们用 ctypes/subprocess 做剪贴板）
#   --add-data "web:web"       → ★ macOS 用冒号分隔（Windows 用分号）
#   --collect-all webview      → pywebview 的 cocoa 后端有数据文件，要一起收
#   --hidden-import objc 等    → ★ 重要：PyInstaller 没有 pyobjc 专用 hook，
#                                 只靠自动分析可能漏掉 objc 框架，
#                                 打出来的 .app 会在启动时崩。双重保险。
python -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "$BUNDLE_NAME" \
  --osx-bundle-identifier "com.zhuangbeidawang.fenjue" \
  --target-arch "$PY_TARGET_ARCH" \
  --add-data "web:web" \
  --hidden-import webview.platforms.cocoa \
  --collect-all webview \
  --hidden-import objc \
  --hidden-import AppKit \
  --hidden-import Foundation \
  --hidden-import WebKit \
  --hidden-import Quartz \
  --hidden-import CoreFoundation \
  --hidden-import Security \
  --hidden-import UniformTypeIdentifiers \
  --exclude-module tkinter \
  --exclude-module _tkinter \
  --exclude-module turtle \
  --exclude-module turtledemo \
  --exclude-module idlelib \
  --exclude-module lib2to3 \
  --exclude-module pydoc_data \
  --exclude-module test \
  "$ENTRY" 2>&1 | tail -20

echo ""

# ---------- 7. 检查产物 ----------
APP_PATH="dist/$BUNDLE_NAME.app"
if [ ! -d "$APP_PATH" ]; then
  echo "✗ 打包失败：没生成 $APP_PATH"
  echo "  请把上面的完整输出发给我排查"
  exit 1
fi

echo "=============================================="
echo "  ✓ 打包成功"
echo "=============================================="
echo ""
SIZE="$(du -sh "$APP_PATH" | cut -f1)"
echo "  产物: $APP_PATH"
echo "  大小: $SIZE"
echo "  架构: $(lipo -archs "$APP_PATH/Contents/MacOS/$BUNDLE_NAME" 2>/dev/null || echo "$PY_TARGET_ARCH")"
echo ""

# ---------- 8. 准备数据目录 ----------
# ★ 重要：数据目录必须和 .app 放在同一层，
#   程序会自动去 .app 的上一级找「焚决数据」
DIST_DIR="dist"
if [ ! -d "$DIST_DIR/焚决数据" ]; then
  echo "→ 创建数据目录（首次运行需要）"
  mkdir -p "$DIST_DIR/焚决数据"
  if [ -f "web/data.js" ]; then
    # 从 data.js 里抽出内置的 31 条，写一份初始 prompts.json
    python - <<'PYEOF'
import json, re, os
p = "web/data.js"
if os.path.isfile(p):
    s = open(p, encoding="utf-8").read()
    m = re.search(r"SEED\s*=\s*(\[[\s\S]*?\]);", s)
    if m:
        try:
            seed = json.loads(m.group(1))
            out = os.path.join("dist", "焚决数据", "prompts.json")
            json.dump(seed, open(out, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=2)
            print("    写入初始数据 %d 条 -> %s" % (len(seed), out))
        except Exception as e:
            print("    解析 SEED 失败:", e)
PYEOF
  fi
fi

echo ""
echo "=============================================="
echo "  怎么用"
echo "=============================================="
echo ""
echo "  1. 打开文件夹: $ROOT/dist"
echo "  2. 双击「$BUNDLE_NAME」"
echo ""
echo "  ★ 首次打开会被 macOS 拦下来（因为没做代码签名）："
echo "      右键点图标 → 选「打开」→ 弹出的框里再点「打开」"
echo "      只需要做一次，之后就正常双击了"
echo ""
echo "  ★ 如果提示「已损坏，无法打开」："
echo "      在终端执行："
echo "        xattr -cr \"$ROOT/$APP_PATH\""
echo "      然后再打开"
echo ""
echo "  ★ 数据目录「焚决数据」必须和 .app 放在同一层，"
echo "     也就是都在 dist/ 下面。移动时请一起移。"
echo ""
