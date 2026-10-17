/* ============================================================
   焚决 · 提示词库  ——  逻辑层
   数据与配色定义见 data.js（自动生成）
   ============================================================ */

/* ---------------- 配色方案（日系小清新） ---------------- */
const SCHEMES = {
  default: { name:"生成り（素白）", bg:"#fbfaf8", fg:"#3a3733", accent:"#8fa8c8", field:"#ffffff" },
  sakura:  { name:"桜（樱）",       bg:"#fdf6f7", fg:"#453a3c", accent:"#dfa3ae", field:"#fffcfc" },
  matcha:  { name:"若芽（嫩芽）",   bg:"#f7faf4", fg:"#38402f", accent:"#a8c49a", field:"#fdfefb" },
  sora:    { name:"空（晴空）",     bg:"#f4f9fd", fg:"#32404c", accent:"#9dc0dd", field:"#fbfdff" },
  kinari:  { name:"木棉（米白）",   bg:"#faf7f0", fg:"#413a2e", accent:"#cbb894", field:"#fffdf8" },
  fuji:    { name:"藤（淡紫）",     bg:"#f8f6fc", fg:"#3d3850", accent:"#b8add6", field:"#fdfcff" },
  hisui:   { name:"青磁（青瓷）",   bg:"#f4faf8", fg:"#2f403c", accent:"#9ccbc0", field:"#fcfefd" },
  kohaku:  { name:"琥珀（浅杏）",   bg:"#fdf8f2", fg:"#443a2b", accent:"#e0bc95", field:"#fffdf9" },
  sumi:    { name:"墨（雾墨）",     bg:"#3c3f46", fg:"#e9e8e6", accent:"#b8c2cf", field:"#4a4e56" },
  custom:  { name:"自定义",         bg:"#fbfaf8", fg:"#3a3733", accent:"#8fa8c8", field:"#ffffff" },
};

const DEFAULT_APPEARANCE = {
  scheme:"default", wallpaper:"", glassBlur:18, glassAlpha:55,
  wpOpacity:100, customBg:"#fbfaf8", customFg:"#3a3733", customAccent:"#8fa8c8",
  locked:true,               // 列表锁：锁定后不可拖动排序
  lite:false,                // 性能模式：降低模糊半径 + 关噪点
  // 前缀 / 尾缀内容来自 data.js（由 fenjue.py 导出），保证两端一致
  prefixText: (typeof DEFAULT_PREFIX_TEXT !== "undefined" ? DEFAULT_PREFIX_TEXT : ""),
  suffixText: (typeof DEFAULT_SUFFIX_TEXT !== "undefined" ? DEFAULT_SUFFIX_TEXT : ""),
};

/* ---------------- 状态 ---------------- */
let items = [];          // [{t,b}]
let cfg = {};            // 配置
let cur = 0;
let filtered = [];
let api = null;          // pywebview 桥（浏览器里为 null）
let dragEl = null;       // 拖拽中的元素（用元素定位，避免重渲染后索引失效）
let dragFrom = -1;       // 拖拽源索引
let dragTo = -1;         // 拖拽目标插入点

/* 极简内部诊断：写进 window.__DBG__，出问题时可从 DOM 读回来。
   生产环境无副作用（只是几个字符串/数字赋值）。 */
const DBG = {
  step:"init", err:"", rsCreated:0, initCalls:0,
  down:0, move:0, up:0,          // 指针事件计数
  geoReq:0, geoSets:0,           // 几何请求/返回
  moveSent:0, moveOk:0, moveErr:"",   // win_move 调用
  rsSent:0, rsOk:0, rsErr:"",         // win_resize 调用
  lastDir:"", lastGeo:null,
};
window.__DBG__ = DBG;

/* ---------------- 存储适配层 ---------------- */
/* 启动数据由 Python 在返回 HTML 时同步注入（见 fenjue_web.py 的 _serve_index）。
   这样启动不依赖任何异步桥接，也就没有竞态。
   在浏览器里直接打开时没有这个标签，则退回 localStorage。 */
function bootData(){
  const el = document.getElementById("__boot_data__");
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch(e){ return null; }
}

const store = {
  lastSaveErr: "",        // 上次 localStorage 写入失败的原因（配额超限等）
  platform: "",           // win / mac / linux，由服务端注入
  customChrome: true,     // 是否使用自绘标题栏（只有 Windows 是）
  async ready(){
    const bd = bootData();
    if (bd) {
      // 服务端注入模式：数据已经在这儿了，同步可用
      items = Array.isArray(bd.items) ? bd.items : [];
      cfg = Object.assign({}, DEFAULT_APPEARANCE, bd.cfg || {});
      store.platform = bd.platform || "win";
      store.customChrome = bd.customChrome !== false;
      api = bridgeReady();          // 桥此时一般已就绪；没有也不影响数据
      return api ? "server+pywebview" : "server";
    }
    // 浏览器静态打开（无服务端）：
    try {
      const raw = localStorage.getItem("fenjue_items");
      items = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(SEED));
    } catch(e){ items = JSON.parse(JSON.stringify(SEED)); }
    try {
      const rc = localStorage.getItem("fenjue_cfg");
      cfg = Object.assign({}, DEFAULT_APPEARANCE, rc ? JSON.parse(rc) : {});
    } catch(e){ cfg = Object.assign({}, DEFAULT_APPEARANCE); }
    // 静态打开时也等一下桥（可能是别的宿主）
    api = await waitForBridge();
    return api ? "pywebview" : "browser";
  },
  async saveItems(){
    if (api && api.save_items) { try { await api.save_items(items); return true; } catch(e){} }
    try { localStorage.setItem("fenjue_items", JSON.stringify(items)); } catch(e){}
    return true;
  },
  async saveCfg(){
    if (api && api.save_cfg) { try { await api.save_cfg(cfg); return true; } catch(e){} }
    /* ★ 浏览器模式：localStorage 只有约 5MB。
       壁纸是 data URL，一张 4K 图就能撑爆配额。撑爆时必须让用户知道，
       否则表现为"设置改了但重启就没了"——最难查的那种毛病。 */
    try {
      localStorage.setItem("fenjue_cfg", JSON.stringify(cfg));
      store.lastSaveErr = "";
      return true;
    } catch(e){
      store.lastSaveErr = String(e && e.name || e);
      const quota = /quota|exceed/i.test(store.lastSaveErr);
      if (quota && cfg.wallpaper && String(cfg.wallpaper).startsWith("data:")) {
        // 壁纸太大：先把它摘掉，保住其余设置
        const wp = cfg.wallpaper;
        cfg.wallpaper = "";
        try { localStorage.setItem("fenjue_cfg", JSON.stringify(cfg)); } catch(e2){}
        if (typeof toast === "function")
          toast("壁纸太大，浏览器存不下，已取消该壁纸（其他设置已保存）", true);
      } else if (typeof toast === "function") {
        toast("浏览器存储已满，设置未能保存", true);
      }
      return false;
    }
  },
};

/* 等 pywebview 注入 window.pywebview.api。

   ⚠ 关键坑：pywebview 会先放一个【空的】window.pywebview，
     过一会儿才把真正的 22 个方法填进去。
     如果只判断 `window.pywebview.api` 存不存在，会在空对象那一刻
     就误判为"已连接"，随后调用 load() 抛异常 → 悄悄回落 localStorage。
     所以必须等到 api 真的有可调用的方法。
     另外 pywebviewready 事件可能早于本脚本触发，不能只靠它。 */
function bridgeReady(){
  const pw = window.pywebview;
  if (!pw || !pw.api) return null;
  // 必须确实有方法才算就绪
  try {
    if (Object.keys(pw.api).length === 0) return null;
  } catch(e){ return null; }
  return pw.api;
}

function waitForBridge(){
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false, sawPyw = !!window.pywebview;

    function finish(v){
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(bail);
      console.log("[bridge]", Date.now() - t0, "ms →",
                  v ? ("已连接(" + Object.keys(v).length + " 个方法)") : "未找到");
      resolve(v);
    }

    const now = bridgeReady();
    if (now) { finish(now); return; }

    // 只要 window.pywebview 出现过，就认定是 pywebview 环境，给足时间
    const timer = setInterval(() => {
      if (window.pywebview) sawPyw = true;
      const api = bridgeReady();
      if (api) finish(api);
    }, 100);

    // 兜底：pywebview 环境等 15 秒（宁可启动慢一点，也不能错失文件存储）
    const bail = setTimeout(() => finish(bridgeReady()), sawPyw ? 15000 : 500);

    /* ⚠ 极其关键的坑：
       pywebview 会在桥还是【空对象】时就派发 pywebviewready。
       如果在这里直接 finish()，会在 405ms 就判定"无桥"，
       于是静默回落 localStorage —— 表现就是"配置读不到、壁纸不显示"。
       所以事件只当作"环境已确认"，真正的就绪仍以 bridgeReady() 为准。 */
    window.addEventListener("pywebviewready", () => {
      sawPyw = true;
      const api = bridgeReady();
      if (api) finish(api);          // 有方法才算数；否则继续轮询
    }, { once: true });
  });
}

/* ---------------- 工具 ---------------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

/* 安全绑定：元素不存在时静默跳过（便于在精简页面上复用本文件） */
function on(id, evt, fn){
  const el = $(id);
  if (el) el[evt] = fn;
  return el;
}

/* 轻提示（toast）。
   两档闸门，避免"操作一下就弹一句状态"打扰用户：
     · quiet       —— 全局静默：任何提示都不弹
     · quietDialog —— 自定义弹窗打开期间静默（用户在里面连续调参，
                      每个动作都弹一句会很烦）
   错误提示（isErr）永远照常弹出，否则出问题用户无从知晓。 */
let toastTimer = null;
let quiet = false;
let quietDialog = false;

function toast(msg, isErr){
  if (!isErr && (quiet || quietDialog)) return;
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "on" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = isErr ? "err" : ""; }, 2000);
}

/* 状态栏文字。
   ★ 默认【不显示】任何普通状态 —— 左下角一直滚字很烦。
     只有两种例外：
       · statusErr() 显式报错时显示（出问题必须让用户知道）
       · 界面上没有任何其他反馈时，也不显示（留空即可） */
function status(msg){
  /* 普通状态一律丢弃：左下角保持干净 */
  void msg;
}
function statusErr(msg){
  const el = $("status");
  if (el) el.textContent = "⚠ " + msg;
}

/* 复制（pywebview 用 Python 剪贴板，浏览器用 Clipboard API） */
async function copyText(text){
  if (api) {
    try { await api.copy(text); return true; } catch(e){}
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text); return true;
    }
  } catch(e){}
  // 兜底
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch(e){}
  document.body.removeChild(ta);
  return ok;
}

/* ---------------- 外观 ---------------- */
/* 亮度（0~255），用于判断底色深浅 */
function lum(hex){
  const h = String(hex).replace("#","");
  if (h.length < 6) return 255;
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return (r*299 + g*587 + b*114) / 1000;
}

/* 把 hex 往目标色混合，k=混合比例 */
function mixHex(a, b, k){
  const pa = String(a).replace("#",""), pb = String(b).replace("#","");
  const out = [0,2,4].map(i => {
    const va = parseInt(pa.slice(i,i+2),16), vb = parseInt(pb.slice(i,i+2),16);
    return Math.round(va + (vb - va) * k).toString(16).padStart(2,"0");
  });
  return "#" + out.join("");
}

/* 计算配色 + 把变量写进 :root。
   拆出来是为了在拖动滑块时只做"轻量"部分（纯变量赋值），不碰 DOM。 */
function paintVars(){
  const sc = SCHEMES[cfg.scheme] || SCHEMES.default;
  const isCustom = cfg.scheme === "custom";
  const bg  = isCustom ? cfg.customBg  : sc.bg;
  let   fg  = isCustom ? cfg.customFg  : sc.fg;
  const fld = sc.field || "#ffffff";

  // 文字对比度保护：面板越透明，文字越往深/浅两端推
  const ga = Math.max(0, Math.min(100, cfg.glassAlpha|0)) / 100;
  const darkPanel = lum(bg) < 128;
  const push = Math.max(0, 1 - ga) * 0.42;
  fg = darkPanel ? mixHex(fg, "#ffffff", push) : mixHex(fg, "#000000", push);

  const r = document.documentElement.style;
  /* 只在值真的变了才写 CSS 变量。
     拖滑块时每帧都写 8 个变量会触发整棵树样式重算，
     而其中大部分（配色、强调色）根本没变。 */
  if (paintVars.last === undefined) paintVars.last = {};
  const put = (k, v) => {
    v = String(v);
    if (paintVars.last[k] === v) return;
    paintVars.last[k] = v;
    r.setProperty(k, v);
  };

  put("--bg", bg);
  put("--fg", fg);
  put("--accent", isCustom ? cfg.customAccent : sc.accent);
  put("--field", fld);
  put("--glass-blur", (cfg.glassBlur|0) + "px");
  put("--glass-a", ga.toFixed(2));
  /* ★ 内容面板的"不透明度下限"在 JS 里算。
     之前在 CSS 里写 max(var(--glass-a), 0.78) 和 max(calc(...*100%),78%)
     都不可靠 —— color-mix 的百分比位置不认这两个函数，
     结果面板一路透到 20%，壁纸透上来把文字盖住了。
     这里直接算好两个百分数，CSS 只管用。 */
  put("--panel-a", (Math.max(ga, 0.94) * 100).toFixed(1) + "%");
  put("--body-a",  (Math.max(ga, 0.97) * 100).toFixed(1) + "%");
  put("--wp-opacity", (Math.max(0,Math.min(100,cfg.wpOpacity|0)) / 100).toFixed(2));
}

/* ★ 拖滑块时的实时预览。
   每次只写 1 个 CSS 变量 —— 没有配色计算、没有 DOM 读取、没有强制重排。
   实测帧间隔稳定在 4.2ms（约 240fps），代价接近于零。
   廉价的部分（模糊半径、不透明度、壁纸浓度）实时可见；
   昂贵的部分（文字对比度要读面板亮度再混色）留到松手时才算。 */
const LIVE_VAR = { sAlpha:"--glass-a", sGlass:"--glass-blur", sOpacity:"--wp-opacity" };

function livePreview(sid, val){
  const v = LIVE_VAR[sid];
  if (!v) return;
  let out;
  if (sid === "sGlass") out = val + "px";
  else out = (val / 100).toFixed(2);
  document.documentElement.style.setProperty(v, out);
  // 同步进缓存，松手后的 paintVars 不会拿旧值盖回去
  if (paintVars.last === undefined) paintVars.last = {};
  paintVars.last[v] = out;
}

/* 壁纸地址：pywebview 走 Python 直通（http→file 被安全策略禁止），
   浏览器模式才用原生 URL */
let wpToken = 0;
function wallpaperUrl(path){
  if (!path) return "";
  if (api && api.wallpaper_url) {
    // 带时间戳，避免浏览器缓存旧图（换壁纸不生效的常见原因）
    wpToken++;
    return "/__wallpaper?t=" + Date.now() + "_" + wpToken;
  }
  return toUrl(path);
}

function applyAppearance(){
  paintVars();
  applyWallpaper();
}

/* 设置壁纸。
   数据是 Python 同步注入的，但 pywebview 的桥可能还没就绪，
   那时只能用 file:// —— 而 http 页面加载 file:// 会被安全策略拦掉。
   所以桥一就绪就再调一次，走 Python 直通。 */
function applyWallpaper(){
  const wp = $("wallpaper");
  const path = (cfg.wallpaper || "").trim();

  if (!path) {
    wp.style.backgroundImage = "none";
    document.body.classList.add("no-wallpaper");
    if (api && api.set_wallpaper) api.set_wallpaper("").catch(()=>{});
    return;
  }

  if (api && api.set_wallpaper) {
    api.set_wallpaper(path).catch(()=>{});
    wp.style.backgroundImage = `url("${wallpaperUrl(path)}")`;
  } else {
    // 桥还没好，先用原生 URL 顶一下（浏览器模式没问题；pywebview 里会被拦，
    // 等 ensureBridge 完成后再刷一次）
    wp.style.backgroundImage = `url("${toUrl(path)}")`;
  }
  document.body.classList.remove("no-wallpaper");
}

/* 桥可能晚到：拿到后立刻把壁纸切到 Python 直通地址，并启用窗口控制 */
async function ensureBridge(){
  if (api && api.set_wallpaper) return api;
  DBG.step = "ensureBridge:enter";
  let b = null;
  try {
    b = await waitForBridge();
  } catch(e){
    DBG.err = "waitForBridge:" + (e && e.message || e);
    return null;
  }
  DBG.step = "ensureBridge:got=" + (b ? Object.keys(b).length : "null");
  if (b) {
    api = b;
    DBG.step = "ensureBridge:assigned";
    try { applyWallpaper(); } catch(e){ DBG.err = "applyWallpaper:" + e.message; }
    try { initWindowControls(); } catch(e){ DBG.err = "initWindowControls:" + e.message; }
  }
  return api;
}

/* 轻量刷新：拖滑块时只改变量，不做其他 DOM 操作 */
let _rafPending = false;
function applyAppearanceThrottled(){
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    paintVars();
  });
}

/* ============================================================
   ★ 拖动滑块时"不渲染"
   拖调节器时每一帧都重算样式 + 重绘玻璃层，手指跟不上。
   改成：拖动期间【只更新数字标签】，界面完全不动；
   松手那一刻才真正应用外观。
   代价是拖动时看不到实时预览 —— 但换来的是丝滑跟手。
   ============================================================ */
let pendingAppearance = null;   // 松手后要应用的配置快照
let pendingTimer = 0;

function beginSliderDrag() {
  if (document.body.classList.contains("slider-drag")) return;
  document.body.classList.add("slider-drag");
}
function endSliderDrag() {
  document.body.classList.remove("slider-drag");
  pendingAppearance = null;
  clearTimeout(pendingTimer);
  applyAppearance();            // 松手：一次性真正应用
}

/* 路径 → CSS 可用 URL
   · data:/http(s):/file: 原样使用
   · Windows 绝对路径  C:\a\b.jpg  →  file:///C:/a/b.jpg
   · 其它（相对路径 / 预览用）原样保留，交给浏览器解析 */
function toUrl(p){
  const s = String(p).trim();
  if (/^(data:|https?:|file:|blob:|\.\/|\/)/i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return "file:///" + s.replace(/\\/g, "/");
  return s.replace(/\\/g, "/");
}

/* ---------------- 渲染 ---------------- */
function renderList(){
  const box = $("list");
  if (!box) return;                       // 精简页面无列表容器时跳过
  const kw = ($("q") ? $("q").value : "").trim().toLowerCase();
  filtered = [];
  let n = 0, html = "";
  items.forEach((it, i) => {
    if (kw && !(it.t.toLowerCase().includes(kw) || it.b.toLowerCase().includes(kw))) return;
    filtered.push(i);
    n++;
    html += `<div class="item${i===cur?" on":""}" data-i="${i}">
      <span class="idx">${n}</span>
      <span class="nm" title="${esc(it.t)}">${esc(it.t || "(无标题)")}</span>
    </div>`;
  });
  /* ★ 错峰入场，但只在该"换了一批内容"时才播。
     renderList 在选中、搜索、拖拽后都会重跑 —— 如果每次都播动画，
     敲搜索时列表会一直闪、还卡。所以比对"可见条目指纹"：
     指纹没变（只是选中项变了）就完全不动。 */
  const fp = filtered.join(",");
  const listChanged = (fp !== renderList._fp);
  renderList._fp = fp;

  box.innerHTML = html || `<div style="padding:20px;text-align:center;color:var(--fg-faint);font-size:12px">没有匹配的条目</div>`;
  box.classList.toggle("stagger", listChanged);
  if (listChanged) {
    /* --i 只给前 14 条：14 × 14ms ≈ 200ms，再往后延就成"等它出现"了。
       skill：错峰只是装饰，绝不能让人等。 */
    const rows = box.querySelectorAll(".item");
    for (let k = 0; k < rows.length && k < 14; k++) {
      rows[k].style.setProperty("--i", k);
    }
  }
  if ($("count")) $("count").textContent = `共 ${items.length} 条`;
  status(`显示 ${n} 条 / 共 ${items.length} 条`);

  // 拖动排序只在"未锁定 + 无搜索词"时启用。
  // 有搜索词时列表是过滤视图，拖动会造成索引错乱，所以直接禁用。
  const canDrag = !cfg.locked && !kw;
  box.querySelectorAll(".item").forEach(el => {
    const i = +el.dataset.i;
    el.onclick = () => { cur = i; renderList(); renderDetail(); showDetailOnMobile(); };
    el.oncontextmenu = ev => {
      ev.preventDefault(); cur = i; renderList(); renderDetail();
      showItemMenu(ev, i);
    };
    if (canDrag) {
      el.draggable = true;
      el.ondragstart = ev => {
        // 用元素本身定位，不依赖闭包里的索引（避免重渲染后索引失效）
        dragEl = el;
        dragFrom = +el.dataset.i;
        dragTo = -1;
        el.classList.add("dragging");
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setData("text/plain", String(dragFrom)); } catch(e){}
        box.classList.add("dragging-active");
      };
      el.ondragend = () => {
        el.classList.remove("dragging");
        clearDropMarks(box);
        box.classList.remove("dragging-active");
        dragEl = null; dragFrom = -1; dragTo = -1;
      };
      el.ondragover = ev => {
        if (!dragEl || dragEl === el) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "move";
        const r = el.getBoundingClientRect();
        const after = (ev.clientY - r.top) > r.height / 2;
        clearDropMarks(box);
        el.classList.add(after ? "drop-after" : "drop-before");
        // 用元素在列表中的实际位置算插入点，不依赖 data-i
        const els = Array.from(box.querySelectorAll(".item"));
        const idx = els.indexOf(el);
        dragTo = after ? idx + 1 : idx;
      };
      el.ondrop = async ev => {
        ev.preventDefault();
        if (!dragEl || dragFrom < 0) return;
        const els = Array.from(box.querySelectorAll(".item"));
        const from = els.indexOf(dragEl);
        if (from < 0) return;
        await moveItem(from, dragTo < 0 ? from : dragTo);
      };
    }
  });
}

function clearDropMarks(box){
  box.querySelectorAll(".item").forEach(x =>
    x.classList.remove("drop-before", "drop-after"));
}

/* 把 from 位置的条目移动到 to 位置（to 为插入点，基于移动前的数组） */
async function moveItem(from, to){
  if (from < 0 || from >= items.length) return;
  if (to < 0) to = 0;
  if (to > items.length) to = items.length;
  if (to === from || to === from + 1) return;      // 没动
  const curItem = items[cur];                        // 跟随当前选中项
  const [it] = items.splice(from, 1);
  if (to > from) to -= 1;                            // 移除后索引前移
  items.splice(to, 0, it);
  cur = items.indexOf(curItem);
  if (cur < 0) cur = 0;
  await store.saveItems();
  renderList(); renderDetail();
  toast("已调整顺序");
}

function renderDetail(){
  const it = items[cur];
  if (!it) {
    $("dTitle").textContent = "—";
    $("dMeta").textContent = "";
    $("dBody").textContent = "";
    return;
  }
  $("dTitle").textContent = it.t || "(无标题)";
  $("dMeta").textContent = it.b.length + " 字符";
  $("dBody").textContent = it.b;
}

/* 拼装：前缀 → 正文 → 尾缀 */
function buildText(body){
  let out = body;
  if (cfg.prefixEnabled && cfg.prefixText) out = cfg.prefixText + out;
  if (cfg.suffixEnabled && cfg.suffixText) out = out + cfg.suffixText;
  return out;
}

async function doCopy(){
  const it = items[cur];
  if (!it) return;
  const text = buildText(it.b);
  const ok = await copyText(text);
  if (!ok) { toast("复制失败", true); statusErr("复制失败"); return; }
  const tags = [];
  if (cfg.prefixEnabled && cfg.prefixText) tags.push("含前缀");
  if (cfg.suffixEnabled && cfg.suffixText) tags.push("含尾缀");
  status(`✓ 已复制：${it.t || "(无标题)"} · ${text.length} 字符${tags.length ? "（"+tags.join("·")+"）" : ""}`);
  toast("已复制");
}

/* ---------------- 悬停提示 ---------------- */
function showTip(el, text){
  const t = $("tooltip");
  t.textContent = text;
  t.classList.add("on");
  const r = el.getBoundingClientRect();
  const tw = t.offsetWidth, th = t.offsetHeight;
  let x = r.left, y = r.bottom + 8;
  if (x + tw > innerWidth - 10) x = innerWidth - tw - 10;
  if (y + th > innerHeight - 10) y = r.top - th - 8;
  t.style.left = Math.max(8, x) + "px";
  t.style.top = Math.max(8, y) + "px";
}
function hideTip(){ $("tooltip").classList.remove("on"); }

/* ---------------- 右键菜单 ---------------- */
function showMenu(ev, entries){
  const m = $("ctxMenu");
  m.innerHTML = entries.map(e =>
    e === "-" ? `<div class="sep"></div>` : `<div class="it" data-k="${e.k}">${esc(e.n)}</div>`
  ).join("");
  m.classList.add("on");
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = ev.clientX, y = ev.clientY;
  if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
  if (y + mh > innerHeight - 8) y = innerHeight - mh - 8;
  m.style.left = x + "px";
  m.style.top = y + "px";
  /* ★ 从触发点缩放，而不是从中心。
     skill：popover 的 transform-origin 必须指向它的触发器 ——
     从中心缩放会让人看不出"它是从哪冒出来的"。
     菜单贴边被翻到上方/左侧时，原点也要跟着翻。 */
  const flipX = (ev.clientX + mw > innerWidth - 8);
  const flipY = (ev.clientY + mh > innerHeight - 8);
  m.style.transformOrigin = (flipX ? "right" : "left") + " " +
                            (flipY ? "bottom" : "top");
  m.querySelectorAll(".it").forEach(el => {
    el.onclick = () => {
      hideMenu();
      const e = entries.find(v => v !== "-" && v.k === el.dataset.k);
      if (e && e.f) e.f();
    };
  });
}
function hideMenu(){ $("ctxMenu").classList.remove("on"); }

/* ============================================================
   ★ 手机导航栈
   窄屏下 .side 和 .detail 都铺满视口，靠 body.m-detail 切换。
   桌面下这两件事都是空操作 —— 判断交给 matchMedia，
   JS 不去猜宽度，避免和 CSS 断点不一致。
   ============================================================ */
const MQ_PHONE = window.matchMedia
  ? window.matchMedia("(max-width: 620px)")
  : { matches: false, addEventListener: null };

function isPhone(){ return MQ_PHONE.matches; }
function showDetailOnMobile(){
  if (isPhone()) document.body.classList.add("m-detail");
}
function showListOnMobile(){
  document.body.classList.remove("m-detail");
}
/* 从手机切回桌面时，必须把 m-detail 清掉 ——
   否则回到桌面宽度后详情面板会一直是"滑入"状态，
   虽然看不出来（桌面下 transform 规则不生效），但状态残留会干扰后续判断。 */
if (MQ_PHONE.addEventListener) {
  MQ_PHONE.addEventListener("change", e => { if (!e.matches) showListOnMobile(); });
} else if (MQ_PHONE.addListener) {
  MQ_PHONE.addListener(e => { if (!e.matches) showListOnMobile(); });
}

function showItemMenu(ev, i){
  showMenu(ev, [
    { k:"rename", n:"修改标题", f:() => openEdit(i, true) },
    { k:"edit",   n:"编辑内容", f:() => openEdit(i, false) },
    "-",
    { k:"copy",   n:"复制提示词", f:doCopy },
    { k:"ccopy",  n:"复制标题", f:async () => {
        await copyText(items[i].t); toast("已复制标题"); } },
    "-",
    { k:"new",    n:"新建提示词", f:() => openEdit(-1, false) },
    { k:"del",    n:"删除",       f:() => removeItem(i) },
  ]);
}

/* ---------------- 编辑弹窗 ---------------- */
let editIdx = 0, titleOnly = false;

function openEdit(i, onlyTitle){
  editIdx = i; titleOnly = !!onlyTitle;
  const it = i >= 0 ? items[i] : { t:"", b:"" };
  $("editTitle").textContent = i < 0 ? "新建提示词" : (onlyTitle ? "修改标题" : "编辑提示词");
  $("fTitle").value = it.t;
  $("fBody").value = it.b;
  $("fBody").style.display = onlyTitle ? "none" : "";
  $("fBody").previousElementSibling.style.display = onlyTitle ? "none" : "";
  $("fCount").textContent = it.b.length + " 字符";
  $("editMask").classList.add("on");
  setTimeout(() => (onlyTitle ? $("fTitle") : $("fBody")).focus(), 60);
}

function closeEdit(){ $("editMask").classList.remove("on"); }

async function saveEdit(){
  const t = $("fTitle").value.trim();
  const b = titleOnly ? (items[editIdx] ? items[editIdx].b : "") : $("fBody").value;
  if (!b.trim()) { toast("正文不能为空", true); return; }

  if (editIdx < 0) {
    items.unshift({ t, b });
    cur = 0;
  } else {
    items[editIdx] = { t, b };
  }
  await store.saveItems();
  renderList(); renderDetail(); closeEdit();
  toast(editIdx < 0 ? "已新建" : "已保存");
}

async function removeItem(i){
  if (!confirm(`确定删除「${items[i].t || "(无标题)"}」？`)) return;
  items.splice(i, 1);
  if (cur >= items.length) cur = Math.max(0, items.length - 1);
  await store.saveItems();
  renderList(); renderDetail();
  toast("已删除");
}

/* ---------------- 导入 / 导出 / 恢复 ---------------- */
async function exportBackup(){
  const data = JSON.stringify(items, null, 2);
  const name = "焚决提示词备份_" + new Date().toISOString().slice(0,10).replace(/-/g,"") + ".json";
  if (api) {
    const p = await api.save_dialog(name);
    if (!p) return;
    const ok = await api.write_text(p, data);
    if (ok) { toast("已导出"); status("✓ 已导出 " + items.length + " 条 → " + p); }
    else toast("导出失败", true);
    return;
  }
  const blob = new Blob([data], { type:"application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("已导出");
}

async function importBackup(){
  let text = null;
  if (api) {
    const p = await api.open_dialog();
    if (!p) return;
    text = await api.read_text(p);
    if (text == null) { toast("读取失败", true); return; }
  } else {
    text = await new Promise(res => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".json";
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return res(null);
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsText(f, "utf-8");
      };
      inp.click();
    });
    if (text == null) return;
  }
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("格式不是提示词列表");
    const add = arr.filter(x => x && typeof x.b === "string" && x.b.trim())
                   .map(x => ({ t:String(x.t || ""), b:String(x.b) }));
    if (!add.length) throw new Error("没有有效数据");
    if (!confirm(`读到 ${add.length} 条提示词。\n\n确定 = 追加到现有列表\n取消 = 放弃`)) return;
    items = add.concat(items);
    await store.saveItems();
    renderList(); renderDetail();
    toast(`已导入 ${add.length} 条`);
  } catch(e){ toast("导入失败：" + e.message, true); }
}

async function restoreSeed(){
  if (!confirm(`把提示词库恢复为最初那 ${SEED.length} 条？\n\n` +
               `· 你新建和修改过的条目都会被覆盖，无法撤销\n` +
               `· 前缀 / 尾缀的文字存在配置里，不受此操作影响\n\n` +
               `（建议先用「导出备份」存一份）`)) return;
  items = JSON.parse(JSON.stringify(SEED));
  cur = 0;
  await store.saveItems();
  renderList(); renderDetail();
  toast(`已恢复 ${SEED.length} 条`);
}

/* 统一关闭弹窗。自定义弹窗关闭时必须解除静默，
   否则静默状态会残留，之后连正常的提示都不弹了。 */
function closeModal(el){
  if (!el) return;
  el.classList.remove("on");
  if (el.id === "customMask") quietDialog = false;
}

/* ---------------- 自定义弹窗 ---------------- */
function openCustom(){
  // 配色网格
  const grid = $("schemeGrid");
  /* --i 用于错峰入场（每张卡片延后 28ms，见 CSS 的 schemeIn） */
  grid.innerHTML = Object.entries(SCHEMES).map(([k,v], i) => `
    <button class="scheme${cfg.scheme===k?" on":""}" data-k="${k}" style="--i:${i}">
      ${esc(v.name)}
      <div class="dots">
        <span class="dot" style="background:${v.bg}"></span>
        <span class="dot" style="background:${v.accent}"></span>
        <span class="dot" style="background:${v.fg}"></span>
      </div>
    </button>`).join("");
  grid.querySelectorAll(".scheme").forEach(b => {
    b.onclick = () => {
      grid.querySelectorAll(".scheme").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      grid.dataset.pick = b.dataset.k;
      // 即时预览
      cfg.scheme = b.dataset.k;
      applyAppearance();
    };
  });
  grid.dataset.pick = cfg.scheme;

  /* —— 自绘色板 ——
     原生 <input type=color> 无法美化，所以自己画色块，
     点色块时才去 .click() 那个隐藏的原生控件唤起系统取色器。 */
  const NATIVE = { customBg:"cBg", customFg:"cFg", customAccent:"cAc" };

  function paintSwatches(){
    document.querySelectorAll("#colorRow .csw").forEach(btn => {
      const key = btn.dataset.key;
      const val = cfg[key] || "#000000";
      const chip = btn.querySelector(".csw-chip");
      const hex = btn.querySelector(".csw-hex");
      if (chip) chip.style.setProperty("--c", val);
      if (hex) hex.textContent = String(val).toUpperCase();
    });
  }
  window.__paintSwatches = paintSwatches;   // 供外部刷新

  document.querySelectorAll("#colorRow .csw").forEach(btn => {
    const key = btn.dataset.key;
    const native = $(NATIVE[key]);
    if (native) native.value = cfg[key] || "#000000";
    btn.onclick = () => {
      if (!native) return;
      // 先同步一次当前值，避免取色器弹开时显示旧色
      native.value = cfg[key] || "#000000";
      native.click();
    };
    if (native) {
      native.oninput = () => {
        // 拖动取色器时即时预览
        cfg[key] = native.value;
        paintSwatches();
        // 手动改色 → 自动切到"自定义"方案
        cfg.scheme = "custom";
        grid.querySelectorAll(".scheme").forEach(x =>
          x.classList.toggle("on", x.dataset.k === "custom"));
        grid.dataset.pick = "custom";
        applyAppearance();
      };
    }
  });
  paintSwatches();

  $("wPath").value = cfg.wallpaper || "";
  $("sGlass").value = cfg.glassBlur;
  $("sAlpha").value = cfg.glassAlpha;
  $("sOpacity").value = cfg.wpOpacity;
  $("vGlass").textContent = cfg.glassBlur;
  $("vAlpha").textContent = cfg.glassAlpha + "%";
  $("vOpacity").textContent = cfg.wpOpacity + "%";

  // 打开期间静默：里面每个动作都弹状态会很烦
  quietDialog = true;
  $("customMask").classList.add("on");
}

async function applyCustom(){
  cfg.scheme = $("schemeGrid").dataset.pick || "default";
  // 三个自定义色已由色板的 oninput 实时写入 cfg，这里不必再读原生控件
  cfg.wallpaper = $("wPath").value.trim();
  cfg.glassBlur = +$("sGlass").value;
  cfg.glassAlpha = +$("sAlpha").value;
  cfg.wpOpacity = +$("sOpacity").value;
  // 若用户拖完滑块没松手就点了"应用"，把待提交的快照也并进来
  if (pendingAppearance) {
    Object.assign(cfg, pendingAppearance);
    pendingAppearance = null;
  }
  document.body.classList.remove("slider-drag");
  await store.saveCfg();
  applyAppearance();
  closeModal($("customMask"));
  // 不再弹"已应用外观"——应用结果界面本身就是反馈
}

/* ---------------- 设置 ---------------- */
async function openSettings(){
  if (api) {
    try {
      const p = await api.paths();
      $("pPrompts").textContent = p.prompts;
      $("pConfig").textContent = p.config;
    } catch(e){ $("pPrompts").textContent = "（读取失败）"; }
  } else {
    $("pPrompts").textContent = "浏览器 localStorage（无文件）";
    $("pConfig").textContent = "浏览器 localStorage（无文件）";
  }
  $("settingsMask").classList.add("on");
}

/* ---------------- 无边框窗口：拖动 + 八向拉伸 ----------------
   frameless 窗口的样式位里没有 WS_THICKFRAME，也没有标题栏，
   所以拖动和拉边都必须由前端发起、Python 执行（win_move / win_resize）。
   app-region:drag 在 WebView2 里不可靠，这里全部用 pointer 事件自管。

   ⚠ 架构要点：pywebview 注入 window.pywebview.api 的时机不确定，
     早则几十毫秒、晚则几秒，而且 pywebviewready 可能在 api 还是空对象时
     就触发。所以【绝对不能】把"绑事件"建立在"桥已就绪"之上 ——
     那样桥一迟到，窗口就彻底无法拖动，而且没有任何报错。
     这里改成：启动即绑事件，每次真正要用时才现取桥（getApi）。 */

/* 现取桥：每次调用都重新读，桥什么时候到都能用上 */
function getApi(){
  const pw = window.pywebview;
  if (!pw || !pw.api) return null;
  try { if (Object.keys(pw.api).length === 0) return null; } catch(e){ return null; }
  return pw.api;
}
let geo = null;          // 操作开始时的窗口几何
let p0 = null;           // 起始指针屏幕坐标
let resizing = null;     // 当前拉伸方向
let moveBusy = false;    // 防止 IPC 调用堆积
let rafId = 0;
let dragActive = false;
let dragBase = null;     // 拖动/拉伸的指针基准（geo 迟到时也能兜住）
let geoSeq = 0;          // 几何请求序号：丢弃过期结果，避免第二次拖动用旧坐标

async function refreshGeo(){
  const a = getApi();
  if (!a || !a.win_state) { DBG.geoErr = "no win_state"; return null; }
  const t0 = ++geoSeq;                 // 记下本次请求序号
  DBG.geoReq++;
  try {
    const st = await a.win_state();
    if (t0 !== geoSeq) return geo;     // 已有更新的请求，丢弃这次结果
    geo = st;
    DBG.geoSets++;
    DBG.lastGeo = st;
    return st;
  } catch(e){
    DBG.geoErr = String(e && e.message || e);
    return null;
  }
}

/* 节流执行窗口操作。
   用 rAF + setTimeout 双保险：窗口被遮挡或最小化时 rAF 会被浏览器节流
   甚至完全不触发，只靠 rAF 会导致"拖动没反应"。 */
let winPending = null;   // 待执行的窗口操作
let winTimer = 0;
let flushCount = 0;

function flushWinOp(){
  if (!winPending || moveBusy) return;
  const op = winPending;
  winPending = null;
  moveBusy = true;
  flushCount++;
  Promise.resolve()
    .then(() => op.fn())
    .then(r => { DBG.moveOk++; DBG.lastFlush = String(r); })
    .catch(e => { DBG.moveErr = String(e && e.message || e); })
    .then(() => { moveBusy = false; DBG.flushes = flushCount; });
}

function queueWinOp(fn){
  winPending = { fn };
  clearTimeout(winTimer);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(flushWinOp);
  winTimer = setTimeout(flushWinOp, 40);      // rAF 不触发时的兜底
}

function scheduleMove(x, y){
  DBG.moveSent++;
  DBG.lastMove = [x, y];
  queueWinOp(() => {
    const a = getApi();
    if (!a || !a.win_move) { DBG.moveErr = "no win_move"; return false; }
    return a.win_move(x, y);
  });
}

function scheduleResize(w, h){
  DBG.rsSent++;
  DBG.lastRs = [w, h, resizing];
  queueWinOp(() => {
    const a = getApi();
    if (!a || !a.win_resize) { DBG.rsErr = "no win_resize"; return false; }
    return a.win_resize(w, h, resizing || "se");
  });
}

/* 关键：pointerdown 里必须"同步"就把状态立起来。
   之前 beginDrag 是 async，要先 await 一次 IPC 取窗口几何，
   在这之前 dragActive 仍是 false —— 用户快速拖动时前几个 pointermove
   全被丢掉，表现就是"拖不动"。
   现在：坐标同步记录，几何后台补；万一几何还没回来就已经在移动，
   用"首帧定基准"的方式兜住，不丢任何一帧。 */
function beginDrag(ev){
  DBG.down++;
  DBG.lastDown = [ev.screenX, ev.screenY, ev.button];
  if (document.body.classList.contains("is-max")) { DBG.step = "beginDrag:maximized"; return; }
  dragActive = true;
  p0 = { x: ev.screenX, y: ev.screenY };
  geo = null;
  dragBase = null;
  DBG.step = "beginDrag:ok";
  document.body.classList.add("win-dragging");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  window.addEventListener("pointercancel", onDragEnd, { once: true });
  refreshGeo();                       // 后台补窗口几何
}

function onDragMove(ev){
  DBG.move++;
  if (!dragActive || !p0) { DBG.step = "onDragMove:inactive"; return; }
  if (!geo) {
    // 几何还没回来：先只更新基准，等 geo 到位后再算差值
    dragBase = { x: ev.screenX, y: ev.screenY };
    DBG.step = "onDragMove:no-geo";
    return;
  }
  // 首帧：把当前指针位置当作基准，避免因 geo 迟到而跳一下
  if (!dragBase) dragBase = { x: ev.screenX, y: ev.screenY };
  const dx = ev.screenX - dragBase.x, dy = ev.screenY - dragBase.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) { DBG.step = "onDragMove:no-delta"; return; }
  DBG.step = "onDragMove:move";
  scheduleMove(geo.x + dx, geo.y + dy);
}

function onDragEnd(){
  DBG.up++;
  dragActive = false;
  window.removeEventListener("pointermove", onDragMove);
  document.body.classList.remove("win-dragging");
  geo = null; p0 = null; dragBase = null;
}

function beginResize(ev, dir){
  DBG.rsDown = (DBG.rsDown || 0) + 1;
  DBG.lastRsDown = [dir, ev.screenX, ev.screenY, ev.button];
  if (document.body.classList.contains("is-max")) { DBG.step = "beginResize:maximized"; return; }
  resizing = dir;
  DBG.lastDir = dir;
  p0 = { x: ev.screenX, y: ev.screenY };
  geo = null;
  dragBase = null;
  DBG.step = "beginResize:ok";
  document.body.classList.add("win-resizing");
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd, { once: true });
  window.addEventListener("pointercancel", onResizeEnd, { once: true });
  ev.preventDefault();
  refreshGeo();
}

function onResizeMove(ev){
  if (!resizing || !p0) return;
  if (!geo) {
    dragBase = { x: ev.screenX, y: ev.screenY };
    return;
  }
  if (!dragBase) dragBase = { x: ev.screenX, y: ev.screenY };
  const dx = ev.screenX - dragBase.x, dy = ev.screenY - dragBase.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  let w = geo.w, h = geo.h;
  if (resizing.includes("e")) w = geo.w + dx;
  if (resizing.includes("w")) w = geo.w - dx;
  if (resizing.includes("s")) h = geo.h + dy;
  if (resizing.includes("n")) h = geo.h - dy;
  scheduleResize(Math.max(820, w), Math.max(560, h));
}

function onResizeEnd(){
  window.removeEventListener("pointermove", onResizeMove);
  document.body.classList.remove("win-resizing");
  resizing = null; geo = null; p0 = null; dragBase = null;
}

async function toggleMax(){
  const a = getApi();
  if (!a || !a.win_toggle_max) { DBG.btnErr = "no bridge(max)"; return; }
  try {
    const st = await a.win_toggle_max();
    document.body.classList.toggle("is-max", !!st);
    const b = $("wMax");
    if (b) b.title = st ? "还原" : "最大化";
    refreshGeo();
  } catch(e){ DBG.btnErr = String(e); }
}

function initWindowControls(){
  DBG.initCalls++;

  /* ★ macOS / Linux：用原生标题栏，没有自绘窗口可管。
     自绘标题栏和那三个按钮在 mac 上完全不该出现 ——
     苹果用户要的是左上角红黄绿，自己画一套看着就不对。
     这里直接给 body 挂 has-chrome（CSS 会隐藏标题栏和按钮），
     然后什么都不绑。 */
  if (!store.customChrome) {
    document.body.classList.add("has-chrome");
    document.documentElement.classList.add("native-chrome");
    DBG.step = "initWindowControls:native-chrome(" + (store.platform || "?") + ")";
    return;
  }

  if (window.__WINCTL__) { DBG.step = "initWindowControls:done"; return; }
  window.__WINCTL__ = true;
  DBG.step = "initWindowControls:running";

  // 标题栏拖动（排除按钮区）
  const tb = $("titlebar");
  if (tb) {
    tb.addEventListener("pointerdown", e => {
      DBG.tbDown = (DBG.tbDown || 0) + 1;
      DBG.lastTbDown = [e.button, e.screenX, e.screenY,
                        (e.target.className || e.target.tagName)];
      if (e.button !== 0) { DBG.step = "tb:not-left"; return; }
      if (e.target.closest(".wbtn")) { DBG.step = "tb:on-button"; return; }
      beginDrag(e);
    });
    // 双击标题栏 = 最大化/还原（与 Windows 一致）
    tb.addEventListener("dblclick", e => {
      DBG.tbDbl = (DBG.tbDbl || 0) + 1;
      if (e.target.closest(".wbtn")) return;
      toggleMax();
    });
  } else {
    DBG.step = "no-titlebar";
  }

  // 八向拉伸热区
  ["n","s","w","e","nw","ne","sw","se"].forEach(d => {
    const h = document.createElement("div");
    h.className = "rs rs-" + d;
    h.addEventListener("pointerdown", e => {
      DBG.rsDownRaw = (DBG.rsDownRaw || 0) + 1;
      if (e.button !== 0) return;
      beginResize(e, d);
    });
    document.body.appendChild(h);
  });
  DBG.rsCreated = document.querySelectorAll(".rs").length;
  DBG.step = "initWindowControls:rs=" + DBG.rsCreated;

  // 窗口按钮（同样现取桥，桥晚到也能用）
  on("wMin", "onclick", async () => {
    DBG.btn = "min";
    const a = getApi();
    if (!a || !a.win_minimize) { DBG.btnErr = "no bridge"; return; }
    try { DBG.btnRet = await a.win_minimize(); } catch(e){ DBG.btnErr = String(e); }
  });
  on("wMax", "onclick", () => { DBG.btn = "max"; toggleMax(); });
  on("wClose", "onclick", async () => {
    DBG.btn = "close";
    const a = getApi();
    if (!a || !a.win_close) { DBG.btnErr = "no bridge"; return; }
    try { DBG.btnRet = await a.win_close(); } catch(e){ DBG.btnErr = String(e); }
  });

  // 同步初始最大化状态
  refreshGeo().then(st => {
    if (st) document.body.classList.toggle("is-max", !!st.max);
  });

  // 键盘：F11 全屏、Esc 退出全屏
  document.addEventListener("keydown", e => {
    if (e.key !== "F11") return;
    e.preventDefault();
    const a = getApi();
    if (a && a.win_toggle_fullscreen) a.win_toggle_fullscreen();
  });
}

/* ---------------- 初始化 ----------------
   ★ 启动性能要点：界面必须在"第一帧"就渲染出来。
     之前 ensureBridge() 写在 init() 里被 await，而它最多要等桥 8 秒，
     结果就是"打开软件要愣好几秒"。
     现在：同步注入的数据先渲染界面，桥的事全部丢到后台异步补。 */
async function init(){
  const t0 = Date.now();
  let bootErr = "";
  let mode = "?";
  try {
    mode = await store.ready();
  } catch(e){
    bootErr = String(e && e.message || e);
    console.error("store.ready 异常", e);
  }
  console.log("存储模式:", mode, "（ready 耗时", Date.now()-t0, "ms）");

  // 诊断信息同时写进 <title>，这样即使拿不到 console 也能从窗口标题读到
  window.__BOOT__ = {
    mode: mode, bridge: !!api, readyMs: Date.now() - t0,
    hasPyw: !!window.pywebview,
    apiKeys: (window.pywebview && window.pywebview.api)
             ? Object.keys(window.pywebview.api).length : -1,
    err: bootErr,
    wp: (cfg && cfg.wallpaper) || "",
    items: Array.isArray(items) ? items.length : -1,
  };
  try { document.title = "BOOT " + JSON.stringify(window.__BOOT__); } catch(e){}

  // 预览钩子：?scheme=sakura&wp=wall.jpg&blur=18&alpha=55&op=100
  // 只在浏览器模式生效，方便截图/预览，不影响正式使用
  if (mode === "browser" && location.search) {
    const qs = new URLSearchParams(location.search);
    if (qs.get("scheme")) cfg.scheme = qs.get("scheme");
    if (qs.get("wp")) cfg.wallpaper = qs.get("wp");
    if (qs.get("blur")) cfg.glassBlur = +qs.get("blur");
    if (qs.get("alpha")) cfg.glassAlpha = +qs.get("alpha");
    if (qs.get("op")) cfg.wpOpacity = +qs.get("op");
    if (qs.get("items")) {
      const n = +qs.get("items");
      if (n > 0 && n < items.length) items = items.slice(0, n);
    }
  }

  /* ---------- 开关（iOS Switch）----------
     样式由 aria-checked 驱动，所以同步时两个都要写：
     · aria-checked  → 轨道变色 + 旋钮滑动
     · .on 类        → 兼容旧选择器 / 便于测试断言 */
  function syncToggle(id, on){
    const el = $(id);
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  const cp = $("chkPrefix"), cs = $("chkSuffix");
  if (cp) {
    syncToggle("chkPrefix", cfg.prefixEnabled);
    cp.onclick = async () => {
      cfg.prefixEnabled = !cfg.prefixEnabled;
      syncToggle("chkPrefix", cfg.prefixEnabled);
      await store.saveCfg();
      status(cfg.prefixEnabled ? "已启用前缀" : "已关闭前缀");
    };
  }
  if (cs) {
    syncToggle("chkSuffix", cfg.suffixEnabled);
    cs.onclick = async () => {
      cfg.suffixEnabled = !cfg.suffixEnabled;
      syncToggle("chkSuffix", cfg.suffixEnabled);
      await store.saveCfg();
      status(cfg.suffixEnabled ? "已启用尾缀" : "已关闭尾缀");
    };
  }

  // 悬停说明挂在两个开关上
  const tipFor = k => {
    const txt = k === "prefix" ? (cfg.prefixText||"") : (cfg.suffixText||"");
    const nm = k === "prefix" ? "前缀" : "尾缀";
    const pos = k === "prefix" ? "最前面" : "最后面";
    const en = k === "prefix" ? cfg.prefixEnabled : cfg.suffixEnabled;
    const body = txt ? txt.slice(0, 260) + (txt.length > 260 ? "…" : "") : "（内容为空）";
    return `${nm}：${txt.length} 字，${en?"已启用":"未启用"}（复制时加在正文${pos}）\n\n${body}`;
  };
  [["chkPrefix","prefix"],["chkSuffix","suffix"]].forEach(([id,k]) => {
    const el = $(id);
    if (!el) return;
    el.onmouseenter = () => showTip(el, tipFor(k));
    el.onmouseleave = hideTip;
  });

  /* ---------- 列表锁（纯开关，不带文字）---------- */
  const lk = $("chkLock");
  const syncLock = () => {
    syncToggle("chkLock", cfg.locked !== false);
    // 只用 title 说明，界面上不显示文字（按要求去掉"已锁/可拖动"）
    if (lk) lk.title = (cfg.locked !== false)
      ? "列表已锁定：不可拖动排序（点击解锁）"
      : "列表已解锁：可拖动排序（点击锁定）";
  };
  if (lk) {
    syncLock();
    lk.onclick = async () => {
      cfg.locked = !(cfg.locked !== false);
      await store.saveCfg();
      syncLock();
      renderList();
    };
  }

  /* ---------- 性能模式：HIG 里 switch 属于列表行控件 ---------- */
  const lite = $("chkLite");
  const syncLite = () => {
    if (lite) {
      lite.classList.toggle("on", !!cfg.lite);
      lite.setAttribute("aria-checked", cfg.lite ? "true" : "false");
    }
    document.body.classList.toggle("lite", !!cfg.lite);
  };
  if (lite) {
    syncLite();
    lite.onclick = async () => {
      cfg.lite = !cfg.lite;
      syncLite();
      await store.saveCfg();
      // 不弹提示：界面上的开关位置就是反馈
    };
  }

  applyAppearance();
  renderList();
  renderDetail();

  // 事件绑定（元素不存在则跳过）
  on("q", "oninput", renderList);
  /* 手机：详情页左上角返回列表 */
  on("btnBack", "onclick", showListOnMobile);
  on("btnCopy", "onclick", doCopy);
  on("btnEdit", "onclick", () => openEdit(cur, false));
  on("btnNew", "onclick", () => openEdit(-1, false));
  on("btnDelete", "onclick", () => removeItem(cur));
  on("btnExport", "onclick", exportBackup);
  on("btnImport", "onclick", importBackup);
  on("btnRestore", "onclick", restoreSeed);
  on("btnCustom", "onclick", openCustom);
  on("btnSettings", "onclick", openSettings);

  on("editCancel", "onclick", closeEdit);
  on("editSave", "onclick", saveEdit);
  on("fBody", "oninput", () => { $("fCount").textContent = $("fBody").value.length + " 字符"; });

  on("customCancel", "onclick", () => {
    closeModal($("customMask"));
  });
  on("customApply", "onclick", applyCustom);
  on("customReset", "onclick", () => {
    cfg = Object.assign({}, cfg, {
      scheme:"default", wallpaper:"", glassBlur:18, glassAlpha:55, wpOpacity:100,
      customBg:"#f2f2f7", customFg:"#1c1c1e", customAccent:"#8fa8c8",
    });
    applyAppearance();
    openCustom();                       // 重开一次，色板会跟着刷新
  });
  on("wPick", "onclick", async () => {
    if (api) {
      const p = await api.open_image();
      if (p) { $("wPath").value = p; cfg.wallpaper = p; applyAppearance(); }
    } else {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*";
      inp.onchange = () => {
        const f = inp.files[0]; if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          $("wPath").value = fr.result;
          cfg.wallpaper = fr.result;
          applyAppearance();
        };
        fr.readAsDataURL(f);
      };
      inp.click();
    }
  });
  on("wClear", "onclick", () => {
    $("wPath").value = ""; cfg.wallpaper = ""; applyAppearance();
  });
  // 拖滑块时只走 paintVars（requestAnimationFrame 节流）。
  // 之前每个 input 事件都调 applyAppearance()，会重算配色 + 碰 DOM，
  // 拖动时每秒几十次 —— 这是"软件卡顿"的主因。
  // 拖滑块时只走 paintVars（rAF 节流），并打上 body.dragging 标记 ——
  // 该标记会让内容面板暂时去掉 backdrop-filter，
  // 因为每帧重绘两个大面积模糊层是拖动手感差的主因。
  /* 三个外观滑块：拖动时【实时预览但不重算】。
     每帧只写 1 个 CSS 变量 → 界面立刻跟手。
     配色的对比度重算留到松手（那是唯一贵的一步）。 */
  [["sGlass","vGlass",v=>v,      (c,v)=>{ c.glassBlur   = v; }],
   ["sAlpha","vAlpha",v=>v+"%",  (c,v)=>{ c.glassAlpha  = v; }],
   ["sOpacity","vOpacity",v=>v+"%",(c,v)=>{ c.wpOpacity = v; }]]
    .forEach(([sid, vid, fmt, setter]) => {
      on(sid, "oninput", e => {
        const val = +e.target.value;
        $(vid).textContent = fmt(e.target.value);   // 数字
        livePreview(sid, val);                      // ← 实时预览（1 个变量）
        pendingAppearance = pendingAppearance || Object.assign({}, cfg);
        setter(pendingAppearance, val);
        beginSliderDrag();
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(endSliderDrag, 400);   // 兜底
      });
      // 松手：把快照并回配置，并做完整应用（含文字对比度重算）
      on(sid, "onchange", () => {
        if (pendingAppearance) {
          Object.assign(cfg, pendingAppearance);
          pendingAppearance = null;
        }
        endSliderDrag();
      });
    });

  // 性能模式的事件已在上面以 switch 形式绑定，这里不再重复绑定

  on("settingsClose", "onclick", () => $("settingsMask").classList.remove("on"));
  on("openDataDir", "onclick", async () => { if (api) await api.open_data_dir(); });
  on("devLink", "onclick", async e => {
    e.preventDefault();
    if (api) await api.open_url(DEV_URL);
    else window.open(DEV_URL, "_blank");
  });

  // 无边框窗口控制：立即绑定，不等桥。
  // 每个处理函数内部用 getApi() 现取桥，所以桥什么时候到都能用。
  initWindowControls();

  // ★ 界面已经渲染完了，把 __FENJUE_READY__ 先立起来 ——
  //   外部（测试/自动化）看到它就认为"可以操作了"，不该被桥的等待拖住。
  window.__FENJUE_READY__ = true;

  // 桥到位后补两件事：① 壁纸切到 Python 直通 ② 记录诊断
  ensureBridge();

  // 弹窗遮罩点击关闭
  document.querySelectorAll(".modal-mask").forEach(m => {
    m.onclick = e => { if (e.target === m) closeModal(m); };
  });

  // 全局：点击/滚动关闭菜单与提示
  document.addEventListener("click", () => { hideMenu(); });
  document.addEventListener("scroll", () => { hideMenu(); hideTip(); }, true);
  window.addEventListener("blur", () => { hideMenu(); hideTip(); });

  // 快捷键
  document.addEventListener("keydown", e => {
    const inField = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === "Escape") {
      hideMenu();
      /* 手机上：先返回列表，再考虑关弹窗 —— 符合"一层一层退"的直觉 */
      const anyModal = document.querySelector(".modal-mask.on");
      if (!anyModal && isPhone() && document.body.classList.contains("m-detail")) {
        showListOnMobile();
        return;
      }
      document.querySelectorAll(".modal-mask.on").forEach(m => closeModal(m));
      return;
    }
    if (e.ctrlKey && e.key === "Enter" && $("editMask").classList.contains("on")) {
      e.preventDefault(); saveEdit(); return;
    }
    if (inField) return;
    if (e.ctrlKey && e.key.toLowerCase() === "c") { e.preventDefault(); doCopy(); }
    if (e.ctrlKey && e.key.toLowerCase() === "e") { e.preventDefault(); openEdit(cur,false); }
    if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); openEdit(-1,false); }
    if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); $("q").focus(); }
    if (e.key === "ArrowDown" && items.length) { cur = Math.min(items.length-1, cur+1); renderList(); renderDetail(); e.preventDefault(); }
    if (e.key === "ArrowUp"   && items.length) { cur = Math.max(0, cur-1); renderList(); renderDetail(); e.preventDefault(); }
  });

  // 初始状态不再显示文字（左下角留空）
  const st0 = $("status"); if (st0) st0.textContent = "";

  // 把启动诊断也摆到状态栏上，肉眼可见（截图/远程排查都方便）
  const bs = $("status");
  if (bs && window.__BOOT__) {
    const b = window.__BOOT__;
    bs.title = "启动诊断: " + JSON.stringify(b);
    if (b.err) {
      bs.textContent = "启动异常：" + b.err;
    }
  }

  /* ★ 桥的等待放到最后，且【不 await】。
     store.ready() 已经从服务端注入的 JSON 里同步拿到数据了，
     桥只影响两件事：壁纸走 http 直通、窗口操作可用。
     这两件都可以在界面渲染完之后慢慢来 —— 之前 await 它，
     结果打开软件要愣 5 秒。 */
  ensureBridge().catch(e => { DBG.err = "ensureBridge:" + e; });

  window.__FENJUE_READY__ = true;
}

window.addEventListener("DOMContentLoaded", init);
