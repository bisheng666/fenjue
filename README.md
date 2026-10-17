name: 打包 macOS 版（M 芯片）

# ============================================================
#  这个文件的作用：让 GitHub 免费帮你在真实的 M 芯片 Mac 上打包
#
#  为什么需要它：PyInstaller 不能交叉编译 ——
#  想得到 macOS 的 .app，就必须在 macOS 上打包。
#  GitHub 提供免费的 Apple Silicon 机器，所以这条路不需要你有 Mac。
#
#  怎么用（一共 5 步，10 分钟）：
#    1. 注册/登录 github.com
#    2. 新建一个仓库（New repository），名字随便，选 Public
#    3. 把整个项目文件夹上传上去（网页上有 "uploading an existing file" 链接）
#       ★ 必须包含 .github/workflows/build-macos.yml 这个文件
#    4. 上传后会自动开始打包；也可以去 Actions 标签页点 "Run workflow"
#    5. 等 3~5 分钟，进 Actions → 那次运行 → 底部 Artifacts → 下载
#
#  下载下来是一个 zip，解压后：
#      焚决提示词库.app         ← 双击就能用
#      焚决数据/               ← 你的提示词（跟 .app 放同一层）
# ============================================================

on:
  # 手动触发（推荐）
  workflow_dispatch:

  # 推送到 main 分支时也自动跑
  push:
    branches: [main, master]
    paths:
      - 'fenjue_web.py'
      - 'web/**'
      - 'mac/**'
      - '.github/workflows/build-macos.yml'

jobs:
  build-macos:
    # macos-14 = Apple Silicon (M1)，原生 arm64
    # 想用更新的机器可以换 macos-15（M2/M3）
    runs-on: macos-14

    steps:
      - name: 1. 取出代码
        uses: actions/checkout@v4

      - name: 2. 装 Python 3.12
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: 3. 确认机器架构（应该是 arm64）
        run: |
          echo "系统: $(sw_vers -productVersion)"
          echo "架构: $(uname -m)"
          echo "Python: $(python3 --version)"
          test "$(uname -m)" = "arm64" && echo "✓ 是 Apple Silicon，能打原生 arm64"

      - name: 4. 装依赖
        run: |
          python3 -m pip install --upgrade pip
          # pywebview 在 macOS 上依赖 6 个 pyobjc 包（它 METADATA 里声明的）
          # 版本钉住：本地验证过 pywebview 6.2.1 + PyInstaller 6.22.3
          python3 -m pip install \
            "pywebview>=5.0,<7" \
            "pyobjc-core>=9.0" \
            "pyobjc-framework-Cocoa>=9.0" \
            "pyobjc-framework-Quartz>=9.0" \
            "pyobjc-framework-WebKit>=9.0" \
            "pyobjc-framework-security>=9.0" \
            "pyobjc-framework-UniformTypeIdentifiers>=9.0" \
            "pyinstaller>=6.0,<7"
          echo ""
          echo "装上的版本："
          python3 - <<'PYEOF'
          import importlib.metadata as md
          for n in ["pywebview","pyinstaller","pyobjc-core",
                    "pyobjc-framework-Cocoa","pyobjc-framework-WebKit",
                    "pyobjc-framework-Quartz","pyobjc-framework-security",
                    "pyobjc-framework-UniformTypeIdentifiers"]:
              try: print("  %-44s %s" % (n, md.version(n)))
              except Exception: print("  %-44s 没装上" % n)
          PYEOF

      - name: 5. 验证 pyobjc 能 import（打不出这个，.app 会启动即崩）
        run: |
          python3 - <<'PYEOF'
          import sys
          mods = ["objc","AppKit","Foundation","WebKit","Quartz","Security",
                  "UniformTypeIdentifiers","CoreFoundation"]
          bad = 0
          for m in mods:
              try:
                  __import__(m); print("  ok  %s" % m)
              except Exception as e:
                  bad += 1; print("  ERR %s -> %s" % (m, e))
          sys.exit(1 if bad else 0)
          PYEOF

      - name: 6. 打包 .app
        run: |
          # 关键参数：
          #   --add-data "web:web"    macOS 用冒号（Windows 用分号）
          #   --hidden-import pyobjc* PyInstaller 没有 pyobjc 专用 hook，
          #                           只靠自动分析可能漏掉 objc 框架
          python3 -m PyInstaller \
            --noconfirm \
            --clean \
            --windowed \
            --name "焚决提示词库" \
            --osx-bundle-identifier "com.zhuangbeidawang.fenjue" \
            --target-arch arm64 \
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
            fenjue_web.py

      - name: 7. 检查产物
        run: |
          APP="dist/焚决提示词库.app"
          if [ ! -d "$APP" ]; then echo "✗ 没生成 .app"; exit 1; fi
          echo "大小: $(du -sh "$APP" | cut -f1)"
          echo "架构: $(lipo -archs "$APP/Contents/MacOS/焚决提示词库")"

          echo ""
          echo "=== web 资源是否打进包 ==="
          find "$APP" -name "index.html" -o -name "app.js" -o -name "style.css" | head -10

          echo ""
          echo "=== pyobjc 是否打进包（最关键，缺了就启动即崩）==="
          OBJC_OK=0
          for m in objc AppKit Foundation WebKit Quartz CoreFoundation; do
            if find "$APP" -name "*${m}*" -print -quit | grep -q .; then
              echo "  ok  $m"
              OBJC_OK=$((OBJC_OK+1))
            else
              echo "  ERR $m 没打进包里！"
            fi
          done
          echo "  命中 $OBJC_OK / 6"
          if [ "$OBJC_OK" -lt 4 ]; then
            echo ""
            echo "✗ pyobjc 框架没被正确收集，这个 .app 双击会立刻退出。"
            echo "  请把本步骤的完整输出发给我。"
            exit 1
          fi

          echo ""
          echo "=== Info.plist 检查 ==="
          /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Contents/Info.plist" || true
          /usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$APP/Contents/Info.plist" 2>/dev/null || echo "  (未设置最低系统版本)"


      - name: 8. 准备数据目录和说明
        run: |
          mkdir -p dist/焚决数据
          python3 - <<'PYEOF'
          import json, re, os

          # ① prompts.json：从 web/data.js 里抽 SEED
          s = open("web/data.js", encoding="utf-8").read()
          m = re.search(r"SEED\s*=\s*(\[[\s\S]*?\]);", s)
          if m:
              seed = json.loads(m.group(1))
              out = os.path.join("dist", "焚决数据", "prompts.json")
              json.dump(seed, open(out, "w", encoding="utf-8"),
                        ensure_ascii=False, indent=2)
              print("初始提示词 %d 条 -> %s" % (len(seed), out))
          else:
              print("⚠ 没从 data.js 里抽到 SEED")

          # ② config.json：★ 上次打包漏了这个，首次启动配置是空的
          #    ★★ 注意键名风格 ★★
          #    前端 app.js 读的是【驼峰】cfg.prefixEnabled / cfg.customBg ...
          #    而 Python 的 DEFAULT_CONFIG 是【下划线】prefix_enabled ...
          #    所以不能从 Python 那边取，必须用前端那套驼峰键，
          #    否则配置写了也读不到（前端会用自己的默认值，等于白写）。
          cfg = {
              "scheme": "default",
              "wallpaper": "",
              "glassBlur": 18,
              "glassAlpha": 55,
              "wpOpacity": 100,
              "customBg": "#fbfaf8",
              "customFg": "#3a3733",
              "customAccent": "#8fa8c8",
              "locked": True,
              "lite": False,
              "prefixEnabled": False,
              "suffixEnabled": False,
              "prefixText": "",
              "suffixText": "",
          }

          # 前缀/尾缀的默认内容来自 web/data.js（和 Windows 版保持一致）
          ds = open("web/data.js", encoding="utf-8").read()
          for key, var in [("prefixText", "DEFAULT_PREFIX_TEXT"),
                           ("suffixText", "DEFAULT_SUFFIX_TEXT")]:
              mm = re.search(var + r'\s*=\s*"([\s\S]*?)";', ds)
              if mm:
                  try:
                      cfg[key] = json.loads('"' + mm.group(1) + '"')
                  except Exception:
                      cfg[key] = mm.group(1)

          out_c = os.path.join("dist", "焚决数据", "config.json")
          json.dump(cfg, open(out_c, "w", encoding="utf-8"),
                    ensure_ascii=False, indent=2)
          print("初始配置 %d 项 -> %s" % (len(cfg), out_c))
          print("  前缀 %d 字 / 尾缀 %d 字" %
                (len(cfg["prefixText"]), len(cfg["suffixText"])))
          PYEOF

          cat > "dist/怎么打开.txt" <<'TXTEOF'
          焚决 · 提示词库（macOS 版）
          ========================================

          怎么打开？

            1. 双击「焚决提示词库」这个应用
            2. 第一次会被系统拦下来（因为没做代码签名，正常现象）
               → 右键点它 → 选「打开」→ 弹窗里再点「打开」
               → 只需要做一次，以后正常双击
            3. 如果提示「已损坏，无法打开」，在终端执行：
               xattr -cr "/路径/焚决提示词库.app"
               然后再打开

          数据在哪？

            焚决数据/prompts.json    你的提示词
            焚决数据/config.json     界面设置

            ★「焚决数据」必须和「焚决提示词库.app」放在同一层。
              移动时请把两个一起移。

          界面说明？

            Mac 版用的是系统原生标题栏（左上角红黄绿），
            和 Windows 版不一样 —— 这是 macOS 的规范。
            其他功能完全一样：前缀尾缀、配色、壁纸、拖动排序。

          软件由 装杯大王 开发
          TXTEOF

      - name: 9. 打包成 zip（★ 必须设 UTF-8 标志，否则 Windows 解压中文乱码）
        run: |
          cd dist
          # ditto 是 macOS 专用，能正确保留 .app 的符号链接和权限
          ditto -c -k --sequesterRsrc --keepParent "焚决提示词库.app" "焚决提示词库-mac.zip"
          # 把数据目录和说明也放进去
          zip -r "焚决提示词库-mac.zip" "焚决数据" "怎么打开.txt"

          # ★★ 关键修复 ★★
          # macOS 的 ditto / zip 写中文文件名时【不设置 UTF-8 标志位】，
          # 于是 Windows 自带解压会全部显示成 τäÜσå│... 这种乱码。
          # macOS 自己解压没问题，但用户很可能在 Windows 上先解压看看，
          # 所以这里用 Python 重写一遍 zip，把每个条目的 flag_bits 补上 0x800。
          python3 - <<'PYEOF'
          import zipfile, os, shutil
          src = "焚决提示词库-mac.zip"
          tmp = "焚决提示词库-mac-utf8.zip"
          zi = zipfile.ZipFile(src)
          zo = zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6)
          n = 0
          for i in zi.infolist():
              # 条目名在 macOS 上本来就是正确字符串，直接复用
              z = zipfile.ZipInfo(i.filename, date_time=i.date_time)
              z.external_attr = i.external_attr          # 保留符号链接/权限位
              z.compress_type = zipfile.ZIP_DEFLATED
              z.flag_bits |= 0x800                        # ← UTF-8 标志
              zo.writestr(z, zi.read(i))
              n += 1
          zo.close(); zi.close()
          os.replace(tmp, src)

          # 验证
          chk = zipfile.ZipFile(src)
          bad = [x for x in chk.infolist() if not (x.flag_bits & 0x800)]
          print("重写完成：%d 个条目，UTF-8 标志缺失 %d 个" % (len(chk.infolist()), len(bad)))
          if bad:
              print("✗ 仍有条目缺 UTF-8 标志，Windows 解压会乱码")
              raise SystemExit(1)
          chk.close()
          PYEOF

          echo "zip 大小: $(du -sh 焚决提示词库-mac.zip | cut -f1)"
          ls -la

      - name: 10. 上传产物（去 Actions 页面底部下载）
        uses: actions/upload-artifact@v4
        with:
          name: 焚决提示词库-macOS-arm64
          path: dist/焚决提示词库-mac.zip
          retention-days: 90

      - name: 11. 显示下载指引
        run: |
          echo ""
          echo "=============================================="
          echo "  ✓ 打包完成"
          echo "=============================================="
          echo ""
          echo "  下载方法："
          echo "    1. 点这个页面右上角的「Summary」"
          echo "    2. 拉到最下面，找到 Artifacts"
          echo "    3. 点 焚决提示词库-macOS-arm64 下载"
          echo ""
          echo "  下载后解压，双击「焚决提示词库」即可。"
          echo "  第一次要右键 → 打开（绕过未签名拦截）。"
          echo ""
