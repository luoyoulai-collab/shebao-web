/* review-geometry.js — 对抗性审查用：白框几何 / captureFrame 反算 / cardRect 一致性
 *
 * 不是重写一遍公式，而是把真的 app.js 跑起来，录下 drawFrameOverlay() 真正画出来的
 * 矩形和 captureFrame() 真正传给 drawImage 的参数，再和 js/ocr.js 的 cardRect() 对。
 *
 * 运行：<node> test/review-geometry.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
var ocrSrc = fs.readFileSync(path.join(ROOT, 'js', 'ocr.js'), 'utf8');

var pass = 0, fail = 0, out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  [PASS] ' + name); }
  else { fail++; out.push('  [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}
function near(name, a, b, tol) {
  tol = tol === undefined ? 1 : tol;
  ok(name, Math.abs(a - b) <= tol, 'got ' + a + ', want ' + b + ' (tol ' + tol + ')');
}
function log(s) { out.push('  ' + s); }

/* ================= 画布录制垫片 ================= */

function makeCtx(el) {
  var ctx = {
    _calls: [],
    canvas: el,
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    clearRect: function () { ctx._calls.push(['clearRect', [].slice.call(arguments)]); },
    save: function () {}, restore: function () {},
    beginPath: function () {},
    closePath: function () {},
    moveTo: function (x, y) { ctx._calls.push(['moveTo', [x, y]]); },
    lineTo: function (x, y) { ctx._calls.push(['lineTo', [x, y]]); },
    arcTo: function (x1, y1, x2, y2, r) { ctx._calls.push(['arcTo', [x1, y1, x2, y2, r]]); },
    rect: function (x, y, w, h) { ctx._calls.push(['rect', [x, y, w, h]]); },
    fill: function (r) { ctx._calls.push(['fill', [r]]); },
    stroke: function () {},
    drawImage: function () { ctx._calls.push(['drawImage', [].slice.call(arguments)]); },
    getImageData: function (x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h };
    },
    putImageData: function () {},
    imageSmoothingEnabled: true
  };
  return ctx;
}

function buildSandbox(opts) {
  opts = opts || {};
  var ids = [];
  var idRe = /\sid\s*=\s*"([^"]+)"/g, m;
  while ((m = idRe.exec(html))) ids.push(m[1]);

  var els = {};
  var created = [];
  function el(tag) {
    var e = {
      tagName: (tag || 'div').toUpperCase(),
      id: '', hidden: false, textContent: '', value: '', checked: false,
      className: '', style: {}, children: [], offsetWidth: 0,
      width: 0, height: 0, clientWidth: 0, clientHeight: 0,
      _listeners: {}, _ctx: null,
      classList: {
        add: function (c) { if ((' ' + e.className + ' ').indexOf(' ' + c + ' ') < 0) e.className = (e.className + ' ' + c).trim(); },
        remove: function (c) { e.className = (' ' + e.className + ' ').split(' ' + c + ' ').join(' ').trim(); },
        contains: function (c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }
      },
      setAttribute: function (k, v) { e['_' + k] = v; },
      appendChild: function (c) { e.children.push(c); return c; },
      removeChild: function (c) { var i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); return c; },
      focus: function () {}, scrollIntoView: function () {},
      querySelector: function () { return el('p'); },
      parentElement: { clientWidth: 0, clientHeight: 0 },
      addEventListener: function (t, fn) { (e._listeners[t] = e._listeners[t] || []).push(fn); },
      removeEventListener: function () {},
      getContext: function () { if (!e._ctx) e._ctx = makeCtx(e); return e._ctx; },
      play: function () { return Promise.resolve(); },
      fire: function (t) { (e._listeners[t] || []).forEach(function (fn) { fn.call(e, { target: e }); }); }
    };
    var inner = '';
    Object.defineProperty(e, 'innerHTML', {
      get: function () { return inner; },
      set: function (v) { inner = v; if (v === '') e.children.length = 0; }
    });
    return e;
  }
  ids.forEach(function (id) { var e = el(id === 'video' || id === 'frameOverlay' ? 'canvas' : 'div'); e.id = id; els[id] = e; });
  els.video.tagName = 'VIDEO';
  els.frameOverlay.tagName = 'CANVAS';

  var doc = {
    baseURI: 'http://localhost/',
    hidden: false, visibilityState: 'visible',
    body: el('body'),
    _listeners: {},
    getElementById: function (id) { return els[id] || null; },
    createElement: function (tag) {
      var e = el(tag);
      if (String(tag).toLowerCase() === 'canvas') created.push(e);
      return e;
    },
    addEventListener: function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    fire: function (t) { (doc._listeners[t] || []).forEach(function (fn) { fn({}); }); }
  };

  var spoken = [];
  var sandbox = {
    console: console, document: doc, location: { href: 'http://localhost/' },
    scrollTo: function () {},
    _winListeners: {},
    addEventListener: function (t, fn) { (sandbox._winListeners[t] = sandbox._winListeners[t] || []).push(fn); },
    removeEventListener: function () {},
    navigator: {
      userAgent: 'review-geometry',
      mediaDevices: {
        getUserMedia: function () {
          return Promise.resolve({
            getVideoTracks: function () {
              return [{ getCapabilities: function () { return {}; }, applyConstraints: function () { return Promise.resolve(); }, stop: function () {} }];
            },
            getTracks: function () { return [{ stop: function () {} }]; }
          });
        }
      }
    },
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    speechSynthesis: {
      speaking: false, pending: false,
      getVoices: function () { return [{ lang: 'zh-CN' }]; },
      speak: function (u) { spoken.push(u && u.text); }, cancel: function () {}
    },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    requestAnimationFrame: function (fn) { fn(); return 1; },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    URL: URL, Image: function () {}, createImageBitmap: function () { return Promise.resolve({}); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ocrSrc, sandbox, { filename: 'js/ocr.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'js/app.js' });
  return { sb: sandbox, els: els, created: created, spoken: spoken };
}

/* 从录到的 ctx 调用里把 roundRect 的第一个矩形还原出来 */
function overlayRect(cv) {
  var calls = cv._ctx ? cv._ctx._calls : [];
  var moveTo = null, arcTo1 = null, arcTo2 = null;
  for (var i = 0; i < calls.length; i++) {
    if (calls[i][0] === 'moveTo' && !moveTo) moveTo = calls[i][1];
    if (calls[i][0] === 'arcTo') {
      if (!arcTo1) arcTo1 = calls[i][1];
      else if (!arcTo2) arcTo2 = calls[i][1];
    }
  }
  if (!moveTo || !arcTo1 || !arcTo2) return null;
  var r = arcTo1[4];
  var x = moveTo[0] - r, y = moveTo[1];
  var w = arcTo1[0] - x, h = arcTo2[3] - y;
  return { x: x, y: y, w: w, h: h, r: r };
}

/* 只跑 openCamera()（会同步调用 drawFrameOverlay） */
function drawAt(env, w, h) {
  if (env.els.frameOverlay._ctx) env.els.frameOverlay._ctx._calls.length = 0;   // 只看这一次画的
  env.els.frameOverlay.clientWidth = w;
  env.els.frameOverlay.clientHeight = h;
  env.els.video.clientWidth = w;
  env.els.video.clientHeight = h;
  env.els.btnShoot.onclick();          // 首页大按钮 → openCamera → drawFrameOverlay
  return overlayRect(env.els.frameOverlay);
}

/* 让 shutter() 真的走一遍，录下 captureFrame 传给 drawImage 的 4 个源参数 */
async function captureAt(env, vw, vh, ew, eh) {
  env.els.video.clientWidth = ew;
  env.els.video.clientHeight = eh;
  env.els.video.videoWidth = vw;
  env.els.video.videoHeight = vh;
  env.created.length = 0;
  env.els.btnShoot.onclick();          // 打开相机（拿到假 stream）
  await new Promise(function (r) { setTimeout(r, 5); });
  env.els.btnShutter.onclick();        // → captureFrame() → drawImage
  var cap = null;
  for (var i = 0; i < env.created.length; i++) {
    var c = env.created[i];
    if (c._ctx) {
      var d = c._ctx._calls.filter(function (x) { return x[0] === 'drawImage'; });
      if (d.length && d[0][1][0] === env.els.video) { cap = { canvas: c, args: d[0][1] }; break; }
    }
  }
  return cap;
}

(async function main() {
  var IdOcr = null;

  /* ============ 1. 白框公式 vs cardRect ============ */
  out.push('--- 1. drawFrameOverlay 画出来的框 vs IdOcr.cardRect（margin=0）---');
  var env = buildSandbox();
  IdOcr = env.sb.IdOcr;
  var sizes = [[360, 378], [412, 420], [640, 534], [390, 700], [360, 300], [320, 240], [640, 300], [1029, 1080]];
  sizes.forEach(function (s) {
    var w = s[0], h = s[1];
    var drawn = drawAt(env, w, h);
    var cr = IdOcr.cardRect(w, h, 0);
    var line = 'w=' + w + ' h=' + h + ' 画: x=' + drawn.x.toFixed(1) + ' y=' + drawn.y.toFixed(1) +
      ' w=' + drawn.w.toFixed(1) + ' h=' + drawn.h.toFixed(1) +
      ' | cardRect: ' + JSON.stringify(cr);
    var clamps = (drawn.h > h) || (drawn.y + drawn.h > h);
    log(line + (clamps ? '   <== cardRect 会夹紧，白框被画布裁掉' : ''));
    if (!clamps) {
      near('1.' + w + 'x' + h + ' 框与 cardRect 一致', Math.round(drawn.x), cr.x, 1);
      near('1.' + w + 'x' + h + ' 框与 cardRect 一致(y)', Math.round(drawn.y), cr.y, 1);
      near('1.' + w + 'x' + h + ' 框与 cardRect 一致(w)', Math.round(drawn.w), cr.w, 1);
      near('1.' + w + 'x' + h + ' 框与 cardRect 一致(h)', Math.round(drawn.h), cr.h, 1);
    }
  });

  /* 单独把「会夹紧」的那个尺寸算清楚 */
  (function () {
    var w = 640, h = 300;
    var drawn = drawAt(env, w, h);
    var cr = IdOcr.cardRect(w, h, 0);
    log('');
    log('夹紧场景 w=' + w + ' h=' + h + '：');
    log('  画出来的框 x=' + drawn.x.toFixed(1) + ' y=' + drawn.y.toFixed(1) + ' w=' + drawn.w.toFixed(1) + ' h=' + drawn.h.toFixed(1) +
      ' → 底边 y+h=' + (drawn.y + drawn.h).toFixed(1) + ' 超出画布 ' + (drawn.y + drawn.h - h).toFixed(1) + 'px（画布外看不见）');
    log('  cardRect 返回 ' + JSON.stringify(cr) + '（y 被夹到 ' + cr.y + '，h 被夹到 ' + cr.h + '）');
    var drawnName = { y: drawn.y + drawn.h * 0.20, h: drawn.h * 0.40 };
    var crName = IdOcr.subRect(cr, 0, 0.20, 0.58, 0.60);
    log('  真正贴姓名的那一条（按画出来的框算）: y=' + drawnName.y.toFixed(1) + '..' + (drawnName.y + drawnName.h).toFixed(1));
    log('  ocr.js 实际裁的姓名区            : y=' + crName.y + '..' + (crName.y + crName.h));
    // 这里原来断言"白框与 cardRect 不一致（记录缺陷）"。
    // 已修复：drawFrameOverlay 现在直接向 IdOcr.cardRect 要矩形，只有一个真相源，
    // 所以这条改成断言"任何尺寸下都一致"。
    ok('1.clamp 白框与 cardRect 在任何尺寸下都一致（缺陷已修复）',
      Math.round(drawn.x) === cr.x && Math.round(drawn.y) === cr.y &&
      Math.round(drawn.w) === cr.w && Math.round(drawn.h) === cr.h,
      'drawn=' + JSON.stringify({ x: Math.round(drawn.x), y: Math.round(drawn.y), w: Math.round(drawn.w), h: Math.round(drawn.h) }) +
      ' cardRect=' + JSON.stringify(cr));
  })();

  /* ============ 2. captureFrame 的 object-fit:cover 反算 ============ */
  out.push('');
  out.push('--- 2. captureFrame() 的 cover 反算（两个分支都要对）---');
  var cases = [
    { n: '横视频/竖屏（1920x1080 → 360x378，视频更宽）', vw: 1920, vh: 1080, ew: 360, eh: 378 },
    { n: '竖视频（1080x1920 → 360x378，视频更高）', vw: 1080, vh: 1920, ew: 360, eh: 378 },
    { n: '竖屏视频裁竖屏（720x1280 → 390x700，视频更高）', vw: 720, vh: 1280, ew: 390, eh: 700 },
    { n: '横框（1080x1920 → 640x300，元素更宽）', vw: 1080, vh: 1920, ew: 640, eh: 300 },
    { n: '正方形元素（1920x1080 → 400x400）', vw: 1920, vh: 1080, ew: 400, eh: 400 }
  ];
  for (var ci = 0; ci < cases.length; ci++) {
    var c = cases[ci];
    var env2 = buildSandbox();
    var cap = await captureAt(env2, c.vw, c.vh, c.ew, c.eh);
    ok('2.' + ci + ' captureFrame 返回了画面 (' + c.n + ')', !!cap);
    if (!cap) continue;
    var a = cap.args;                      // drawImage(v, sx, sy, sw, sh, 0,0,sw,sh)
    var sx = a[1], sy = a[2], sw = a[3], sh = a[4];
    var scale = Math.max(c.ew / c.vw, c.eh / c.vh);
    var expW = Math.min(c.vw, Math.round(c.ew / scale));
    var expH = Math.min(c.vh, Math.round(c.eh / scale));
    var expX = Math.max(0, Math.round((c.vw - expW) / 2));
    var expY = Math.max(0, Math.round((c.vh - expH) / 2));
    log(c.n + '：drawImage(v,' + sx + ',' + sy + ',' + sw + ',' + sh + ',0,0,' + sw + ',' + sh + ') 画布=' + cap.canvas.width + 'x' + cap.canvas.height +
      ' | cover 期望 sx=' + expX + ' sy=' + expY + ' sw=' + expW + ' sh=' + expH + ' scale=' + scale.toFixed(4));
    ok('2.' + ci + 'a sx 正确', sx === expX, sx + ' vs ' + expX);
    ok('2.' + ci + 'b sy 正确', sy === expY, sy + ' vs ' + expY);
    ok('2.' + ci + 'c sw 正确', sw === expW, sw + ' vs ' + expW);
    ok('2.' + ci + 'd sh 正确', sh === expH, sh + ' vs ' + expH);
    // 画布宽高比必须等于元素宽高比（这样 cardRect 的比例才和屏幕上的白框对齐）
    var wantAspect = c.ew / c.eh, gotAspect = cap.canvas.width / cap.canvas.height;
    ok('2.' + ci + 'e 画布宽高比≈元素宽高比', Math.abs(wantAspect - gotAspect) < 0.01,
      wantAspect.toFixed(4) + ' vs ' + gotAspect.toFixed(4));
    // 白框在元素坐标 (xe,ye) ↔ 画布坐标 = (xe/scale, ye/scale) + 源偏移
    var drawn2 = drawAt(env2, c.ew, c.eh);
    var inCanvas_x = drawn2.x / scale, inCanvas_y = drawn2.y / scale;
    var cr2 = IdOcr.cardRect(cap.canvas.width, cap.canvas.height, 0);
    log('    白框在画布里的位置（换算）: x=' + inCanvas_x.toFixed(1) + ' y=' + inCanvas_y.toFixed(1) +
      ' w=' + (drawn2.w / scale).toFixed(1) + ' h=' + (drawn2.h / scale).toFixed(1) +
      ' | cardRect(canvas)=' + JSON.stringify(cr2));
    if (drawn2.y + drawn2.h <= c.eh) {
      near('2.' + ci + 'f 画布坐标下的框与 cardRect 一致(x)', Math.round(inCanvas_x), cr2.x, 1);
      near('2.' + ci + 'g 画布坐标下的框与 cardRect 一致(y)', Math.round(inCanvas_y), cr2.y, 1);
      near('2.' + ci + 'h 画布坐标下的框与 cardRect 一致(w)', Math.round(drawn2.w / scale), cr2.w, 1);
      near('2.' + ci + 'i 画布坐标下的框与 cardRect 一致(h)', Math.round(drawn2.h / scale), cr2.h, 1);
    } else {
      log('    （此尺寸白框超出画布，见第 1 节的夹紧缺陷；这里只记录，不断言一致）');
    }
  }

  /* ============ 3. subRect / 越界 ============ */
  out.push('');
  out.push('--- 3. subRect 越界与退化输入 ---');
  var card = IdOcr.cardRect(1000, 1200, 0.08);
  var r1 = IdOcr.subRect(card, 0, 0.20, 0.58, 0.60);
  var r2 = IdOcr.subRect(card, 0, 0.58, 1, 1);
  ok('3.1 姓名区在框内', r1.x >= card.x && r1.y >= card.y && r1.x + r1.w <= card.x + card.w && r1.y + r1.h <= card.y + card.h, JSON.stringify(r1));
  ok('3.2 号码区在框内', r2.x >= card.x && r2.y >= card.y && r2.x + r2.w <= card.x + card.w && r2.y + r2.h <= card.y + card.h, JSON.stringify(r2));
  ok('3.3 号码区与姓名区只允许少量刻意重叠（≤5% 框高）',
    (r1.y + r1.h) - r2.y <= card.h * 0.05, '重叠 ' + ((r1.y + r1.h) - r2.y) + 'px / 框高 ' + card.h + 'px');
  var rzero = IdOcr.subRect({ x: 0, y: 0, w: 0, h: 0 }, 0, 0, 1, 1);
  ok('3.4 零尺寸不返回 0 宽高', rzero.w >= 1 && rzero.h >= 1, JSON.stringify(rzero));
  var rneg = IdOcr.subRect({ x: 0, y: 0, w: 100, h: 100 }, 0.5, 0.5, 0.2, 0.2);
  ok('3.5 反向 fx 不崩（宽高至少 1）', rneg.w >= 1 && rneg.h >= 1, JSON.stringify(rneg));
  var rbig = IdOcr.subRect({ x: 0, y: 0, w: 100, h: 100 }, -1, -1, 3, 3);
  ok('3.6 超出 0~1 的比例不崩', rbig.w > 100, JSON.stringify(rbig));
  var c0 = IdOcr.cardRect(0, 0, 0);
  ok('3.7 cardRect(0,0) 不返回负值', c0.x >= 0 && c0.y >= 0 && c0.w >= 0 && c0.h >= 0, JSON.stringify(c0));
  var csmall = IdOcr.cardRect(10, 10, 0.08);
  ok('3.8 极小图不越界', csmall.x >= 0 && csmall.y >= 0 && csmall.x + csmall.w <= 10 && csmall.y + csmall.h <= 10, JSON.stringify(csmall));

  /* ============ 4. 结论数字 ============ */
  out.push('');
  out.push('--- 4. 关键算术（给报告引用）---');
  (function () {
    var w = 360, h = 378;
    log('360x378 取景框：cw=360*0.88=' + (w * 0.88).toFixed(1) + '  ch=cw*54/85.6=' + (w * 0.88 * 54 / 85.6).toFixed(1) +
      '  x=' + ((w - w * 0.88) / 2).toFixed(1) + '  y=378*0.18=' + (h * 0.18).toFixed(1) +
      '  底边=' + (h * 0.18 + w * 0.88 * 54 / 85.6).toFixed(1) + ' ≤ ' + h);
    var barH = 12 + 104 + 12 + 88 + 14;
    log('底部固定条高度 = 12(padTop) + 104(打开微信) + 12(gap) + 88(按钮行) + 14(padBottom) = ' + barH +
      'px；#scr-coach padding-bottom=250px → 富余 ' + (250 - barH) + 'px（inset=0 时）');
    log('iPhone 刘海屏 env(safe-area-inset-bottom)=34px 时：底部条=' + (barH + 34) + 'px > 250px → 重叠 ' + (barH + 34 - 250) + 'px');
    var toastH = 26 * 1.2 + 18 * 2;
    log('toast：bottom:60px，高度≈' + toastH.toFixed(0) + 'px → 占据离底 60..' + (60 + toastH).toFixed(0) + 'px；' +
      '按钮行占据离底 14..102px，重叠区 60..102px（点这块会点到 toast 而不是按钮）');
  })();

  console.log('=== review-geometry.js ===');
  console.log(out.join('\n'));
  console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
  console.log(fail ? '\n结果：FAILED' : '\n结果：ALL PASSED');
  process.exit(fail ? 1 : 0);
})();
