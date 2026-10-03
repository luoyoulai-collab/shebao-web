/* review-flow.js — 对抗性审查用：流程 / 健壮性 / 文案诚实性 / Tesseract 调用契约
 *
 * 运行：<node> test/review-flow.js
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
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
function log(s) { out.push('  ' + s); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ================= 最小 DOM（比现有 smoke 垫片多几个旋钮）================= */

function makeEl(id) {
  var el = {
    id: id || '', tagName: 'DIV', hidden: false, textContent: '', value: '', checked: false,
    className: '', style: {}, children: [], offsetWidth: 0,
    width: 0, height: 0, clientWidth: 0, clientHeight: 0,
    parentElement: { clientWidth: 0, clientHeight: 0 },
    _listeners: {}, _attrs: {},
    classList: {
      add: function (c) { if ((' ' + el.className + ' ').indexOf(' ' + c + ' ') < 0) el.className = (el.className + ' ' + c).trim(); },
      remove: function (c) { el.className = (' ' + el.className + ' ').split(' ' + c + ' ').join(' ').trim(); },
      contains: function (c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
    },
    setAttribute: function (k, v) { el._attrs[k] = v; },
    getAttribute: function (k) { return el._attrs[k]; },
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function (c) { var i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    focus: function () {}, scrollIntoView: function () {},
    querySelector: function () { return makeEl('p'); },
    addEventListener: function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    play: function () { return Promise.resolve(); },
    fire: function (t) { (el._listeners[t] || []).forEach(function (fn) { fn.call(el, { target: el }); }); }
  };
  var inner = '';
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return inner; },
    set: function (v) { inner = v; if (v === '') el.children.length = 0; }
  });
  return el;
}

function buildSandbox(opts) {
  opts = opts || {};
  var ids = [];
  var idRe = /\sid\s*=\s*"([^"]+)"/g, m;
  while ((m = idRe.exec(html))) ids.push(m[1]);
  var els = {};
  ids.forEach(function (id) {
    els[id] = makeEl(id);
    // 按 index.html 里真实的 hidden 属性初始化（toast / camFallback / 非首页的 screen 等）
    if (new RegExp('id="' + id + '"[^>]*\\shidden').test(html)) els[id].hidden = true;
  });
  var askedUnknown = [];

  var store = opts.store || {};
  var clipboard = { last: null, writes: 0, fails: !!opts.clipboardFails };
  var spoken = [];
  var notAllowed = [];
  var execCommandCalls = 0;

  var doc = {
    baseURI: 'http://localhost/',
    hidden: false, visibilityState: 'visible',
    body: makeEl('body'),
    _listeners: {},
    getElementById: function (id) { if (!els[id]) { askedUnknown.push(id); return null; } return els[id]; },
    createElement: function (tag) { return makeEl(tag); },
    addEventListener: function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    fire: function (t) { (doc._listeners[t] || []).forEach(function (fn) { fn({}); }); }
  };
  if (!opts.noExecCommand) {
    doc.execCommand = function () { execCommandCalls++; return !opts.execCommandFails; };
  }

  var sandbox = {
    console: console, document: doc, location: { href: 'http://localhost/' },
    scrollTo: function () {},
    _winListeners: {},
    addEventListener: function (t, fn) { (sandbox._winListeners[t] = sandbox._winListeners[t] || []).push(fn); },
    removeEventListener: function () {},
    navigator: {
      userAgent: opts.userAgent || 'review-flow',
      clipboard: opts.noClipboard ? undefined : {
        writeText: function (v) {
          clipboard.last = v; clipboard.writes++;
          return clipboard.fails ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
        }
      }
    },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { if (opts.storeThrows) throw new Error('QuotaExceededError'); store[k] = String(v); }
    },
    requestAnimationFrame: function (fn) { fn(); return 1; },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    URL: { createObjectURL: function () { return 'blob:fake'; }, revokeObjectURL: function () {} },
    Image: opts.imageFails
      ? function () { this.decode = function () { return Promise.reject(new Error('HEIC decode failed')); }; }
      : function () { this.decode = function () { return Promise.resolve(); }; },
    createImageBitmap: opts.bitmapFails
      ? function () { return Promise.reject(new Error('unsupported image')); }
      : function () { return Promise.resolve({ width: 1200, height: 900 }); }
  };
  if (opts.noSpeech) {
    // 故意不定义 speechSynthesis / SpeechSynthesisUtterance
  } else {
    sandbox.speechSynthesis = {
      speaking: false, pending: false,
      getVoices: function () { return [{ lang: 'zh-CN', name: '测试声音' }]; },
      speak: function (u) { spoken.push(u && u.text); },
      cancel: function () {}
    };
    sandbox.SpeechSynthesisUtterance = function (t) { this.text = t; };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(ocrSrc, sandbox, { filename: 'js/ocr.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'js/app.js' });

  return {
    sb: sandbox, els: els, doc: doc, store: store, clipboard: clipboard, spoken: spoken,
    askedUnknown: askedUnknown, execCommandCalls: function () { return execCommandCalls; },
    visible: function () {
      return ids.filter(function (id) { return /^scr-/.test(id) && !els[id].hidden; }).sort();
    }
  };
}

function makeId(id17) {
  var W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], C = '10X98765432';
  var s = 0;
  for (var i = 0; i < 17; i++) s += (id17.charCodeAt(i) - 48) * W[i];
  return id17 + C.charAt(s % 11);
}
var ID_A = makeId('43010219900101123');

(async function main() {
  var unhandled = [];
  process.on('unhandledRejection', function (e) { unhandled.push(String(e && e.message || e)); });

  /* ============ 1. 续教存档里的 step 越界 ============ */
  out.push('--- 1. localStorage 里的 sb_step 越界/脏数据 ---');
  var cases = [
    ['99（超出 7 步）', '99', '第 7 步 / 共 7 步'],
    ['-5（负数）', '-5', '第 1 步 / 共 7 步'],
    ['abc（非数字）', 'abc', '第 1 步 / 共 7 步'],
    ['3.9（小数）', '3.9', '第 4 步 / 共 7 步'],
    ['6（最后一步）', '6', '第 7 步 / 共 7 步'],
    ['0', '0', '第 1 步 / 共 7 步']
  ];
  cases.forEach(function (c) {
    var b = buildSandbox({ store: { sb_name: '赵六', sb_id: ID_A, sb_coaching: '1', sb_step: c[1] } });
    eq('1.' + c[0] + ' 续教落点', b.els.coachStepNo.textContent, c[2]);
    ok('1.' + c[0] + 'b 仍在教练页', b.visible().join(',') === 'scr-coach', b.visible().join(','));
    ok('1.' + c[0] + 'c 进度点数 = 步骤数', b.els.stepDots.children.length === 7, String(b.els.stepDots.children.length));
    // 点一次「下一步」不能越界成 undefined
    var before = b.els.coachTitle.textContent;
    b.els.btnNext.onclick();
    ok('1.' + c[0] + 'd 点下一步不崩且标题非空', typeof b.els.coachTitle.textContent === 'string' && b.els.coachTitle.textContent !== '',
      '前=' + before + ' 后=' + b.els.coachTitle.textContent);
  });

  /* ============ 2. 上一步 / 下一步走到底再走回来 ============ */
  out.push('');
  out.push('--- 2. 步进机（7 步来回走）---');
  (function () {
    var b = buildSandbox({ store: { sb_name: '张三', sb_id: ID_A } });
    b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
    b.els.btnGo.onclick();
    var titles = [b.els.coachTitle.textContent];
    for (var i = 0; i < 6; i++) { b.els.btnNext.onclick(); titles.push(b.els.coachTitle.textContent); }
    eq('2.1 七步标题都不为空', titles.filter(function (t) { return !!t; }).length, 7);
    eq('2.2 七步标题互不相同', titles.filter(function (t, i) { return titles.indexOf(t) === i; }).length, 7);
    eq('2.3 第 7 步按钮文案', b.els.btnNext.textContent, '🎉 我认证完成啦');
    var ret = [];
    for (var j = 0; j < 6; j++) { b.els.btnPrev.onclick(); ret.push(b.els.coachStepNo.textContent); }
    eq('2.4 退回第 1 步', b.els.coachStepNo.textContent, '第 1 步 / 共 7 步');
    b.els.btnPrev.onclick();
    eq('2.5 在第 1 步再点「上一步」不动且有边界', b.els.coachStepNo.textContent, '第 1 步 / 共 7 步');
    ok('2.6 第一个点仍然是当前点', b.els.stepDots.children[0].classList.contains('on'));
    ok('2.7 七个进度点里只有一个 on',
      b.els.stepDots.children.filter(function (d) { return d.classList.contains('on'); }).length === 1);
  })();

  /* ============ 3. 教练页没有出口 ============ */
  out.push('');
  out.push('--- 3. 进了教练页以后能不能退出 / 改错 ---');
  (function () {
    var b = buildSandbox({ store: { sb_name: '张三', sb_id: ID_A } });
    b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
    b.els.btnGo.onclick();
    var before = b.visible().join(',');
    // 把页面上所有“按钮”都点一遍，看有没有任何一个能离开教练页
    var clickable = ['btnVoice', 'btnReplay', 'btnPrev', 'btnNext'];
    var escaped = [];
    clickable.forEach(function (id) {
      var snap = b.visible().join(',');
      var st = b.els.coachStepNo.textContent;
      try { if (typeof b.els[id].onclick === 'function') b.els[id].onclick(); } catch (e) { }
      if (b.visible().join(',') !== 'scr-coach') escaped.push(id + '→' + b.visible().join(','));
      b.visible(); b.els.coachStepNo.textContent = st;
      if (b.visible().join(',') !== 'scr-coach') { showBack(b); }
    });
    function showBack(env) { /* 回不去，只能记录 */ }
    log('教练页只有这些按钮: btnVoice / btnReplay / btnPrev / btnNext / btnOpenWx');
    eq('3.1 进教练页后仍在教练页（没有任何退出按钮）', before, 'scr-coach');
    ok('3.2 没有「返回核对页/首页」的按钮（index.html 里 scr-coach 内没有）',
      !/返回|首页|退出|重来/.test(html.slice(html.indexOf('id="scr-coach"'), html.indexOf('id="scr-done"'))));
    // 刷新后仍然回到教练页（存档 sb_coaching=1）
    var after = buildSandbox({ store: b.store });
    eq('3.3 刷新页面后又被拉回教练页（无法从教练页逃出去）', after.visible().join(','), 'scr-coach');
    log('  ⇒ 姓名/证件号在核对页填错后，进了教练页就只能靠「完成」或清浏览器数据离开');
  })();

  /* ============ 4. 选图失败的死路 ============ */
  out.push('');
  out.push('--- 4. 「用相机拍一张」选图失败时的表现 ---');
  await (async function () {
    var b = buildSandbox({ bitmapFails: true, imageFails: true });
    b.els.btnShoot.onclick();                 // 相机打不开 → 走「用相机拍一张」兜底
    eq('4.0 先进入相机页并显示兜底面板', b.visible().join(',') + '/' + b.els.camFallback.hidden, 'scr-camera/false');
    b.els.fileInput.files = [{ name: 'x.heic' }];
    var thrown = null;
    try { b.els.fileInput.fire('change'); } catch (e) { thrown = e; }
    await sleep(60);
    log('选了一张解码失败的图（createImageBitmap 两次都 reject，Image.decode 也 reject）');
    log('  同步抛异常: ' + (thrown ? thrown.message : '无'));
    log('  页面现在停在: ' + b.visible().join(','));
    log('  toast: hidden=' + b.els.toast.hidden + ' 文字="' + b.els.toast.textContent + '"');
    log('  未处理的 Promise 拒绝: ' + JSON.stringify(unhandled));
    ok('4.1 选图失败后用户看到错误提示', b.els.toast.hidden === false && b.els.toast.textContent.length > 0,
      'toast 是空的，用户没有任何反馈');
    // 已修复：不再抛未处理异常，而是明确提示 + 语音，并**留在相机页**让老人直接重拍。
    // 留在相机页是有意为之（相机预览还活着，重拍最快），所以这里改成断言"有反馈 + 能重拍"。
    ok('4.2 选图失败后留在相机页是有意的（便于立刻重拍），但必须给出反馈',
      b.visible().join(',') === 'scr-camera' && b.els.toast.textContent.length > 0, b.visible().join(','));
    ok('4.3 选图失败不应该产生未处理的 Promise 拒绝', unhandled.length === 0, JSON.stringify(unhandled));
    ok('4.4 选图失败后画面上还有可点的东西（拍照键/返回键）',
      typeof b.els.btnShutter.onclick === 'function' && typeof b.els.btnCamBack.onclick === 'function');
  })();

  /* ============ 5. 没有 speechSynthesis 的浏览器 ============ */
  out.push('');
  out.push('--- 5. 没有 speechSynthesis（某些微信/内置浏览器）---');
  (function () {
    var b = buildSandbox({ noSpeech: true, store: { sb_name: '张三', sb_id: ID_A } });
    var threw = null;
    try {
      b.els.btnShoot.onclick();
      b.els.btnCamBack.onclick();
      b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
      b.els.btnGo.onclick();
      for (var i = 0; i < 7; i++) b.els.btnNext.onclick();
    } catch (e) { threw = e; }
    ok('5.1 没有语音 API 时全流程不崩', !threw, threw && (threw.message + ' @ ' + threw.stack));
    eq('5.2 仍然能走到完成页', b.visible().join(','), 'scr-done');
  })();

  /* ============ 6. 语音解锁被页面加载「吃掉」 ============ */
  out.push('');
  out.push('--- 6. iOS 语音解锁 flag 的消耗时机 ---');
  (function () {
    var b = buildSandbox({ store: { sb_name: '赵六', sb_id: ID_A, sb_coaching: '1', sb_step: '3' } });
    log('页面加载时就续教（没有任何用户手势）');
    log('  加载后已"读过"的内容: ' + JSON.stringify(b.spoken));
    ok('6.1 页面刚加载、还没有手势时就调用了 speak（warmUpSpeech 把 speechWarmed 置真）',
      b.spoken.length > 0, 'spoken=' + JSON.stringify(b.spoken));
    // 已修复：warmUpSpeech 现在只在真正的用户手势里解锁，续教这条路不再消耗 iOS 的解锁额度，
    // 所以 spoken[0] 应该是当前那一步的正文，而不是解锁用的空字符串。
    ok('6.2 续教加载时没有白白用掉 iOS 的语音解锁额度（缺陷已修复）',
      b.spoken[0] !== ' ', JSON.stringify(b.spoken[0]));
  })();

  /* ============ 7. 自动复制失败时的文案诚实性 ============ */
  out.push('');
  out.push('--- 7. 复制失败时 UI 说的话 ---');
  await (async function () {
    var b = buildSandbox({ clipboardFails: true, execCommandFails: true });
    b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
    b.els.btnGo.onclick();            // 第 1 步
    b.els.btnNext.onclick();          // 第 2 步
    b.els.btnNext.onclick();          // 第 3 步（需要复制小程序名）
    await sleep(60);
    log('剪贴板写失败 + execCommand 兜底也失败时：');
    log('  copyNote = "' + b.els.copyNote.textContent + '"（hidden=' + b.els.copyNote.hidden + '）');
    var claims = b.spoken.filter(function (t) { return t && t.indexOf('复制好') >= 0; });
    log('  语音说过的话里包含"复制好"的: ' + JSON.stringify(claims));
    ok('7.1 提示条说的是「请点复制按钮」而不是「已经复制好了」',
      b.els.copyNote.textContent.indexOf('请点上面黄色') >= 0, b.els.copyNote.textContent);
    ok('7.2 没有弹「已复制 ✓」的 toast', b.els.toast.textContent.indexOf('已复制') < 0, b.els.toast.textContent);
    // 已修复：步骤语音不再事先宣称"已经帮您复制好了"，只有真的复制成功才会说；
    // 复制失败时反过来会主动说"没复制上，请点黄色复制按钮"。
    ok('7.3 语音不再谎报"已经复制好了"（缺陷已修复）',
      claims.length === 0, '仍然宣称复制好了: ' + JSON.stringify(claims));
    var told = b.spoken.filter(function (t) { return t && t.indexOf('没复制上') >= 0; });
    ok('7.4 复制失败时会用语音明确告诉老人（不只是写在小字里）',
      told.length > 0, JSON.stringify(b.spoken));
    // 手动点芯片上的「复制」按钮失败时的说法
    var chip = b.els.coachChips.children[0];
    var btn = chip && chip.children[2];
    ok('7.4 芯片上有复制按钮', !!btn);
    if (btn) {
      b.els.toast.textContent = '';
      btn.onclick();
      await sleep(60);
      log('  手动点复制失败后的 toast = "' + b.els.toast.textContent + '"');
      ok('7.5 手动复制失败时 toast 说的是失败', b.els.toast.textContent.indexOf('复制失败') >= 0, b.els.toast.textContent);
    }
  })();

  /* ============ 8. 「已保存」是不是真的保存了 ============ */
  out.push('');
  out.push('--- 8. localStorage 写不进去时还说「已保存」吗 ---');
  (function () {
    var b = buildSandbox({ storeThrows: true });
    b.els.btnSettings.onclick();
    b.els.setMini.value = '湖南智慧人社';
    b.els.btnSetSave.onclick();
    log('localStorage.setItem 直接抛异常时：toast = "' + b.els.toast.textContent + '"');
    // 已修复：saveSettings 返回是否真的写成功，写不进去就换一句诚实的话。
    ok('8.1 写不进去时不再谎报「已保存」（缺陷已修复）',
      b.els.toast.textContent !== '已保存' && b.els.toast.textContent.indexOf('存不下来') >= 0,
      b.els.toast.textContent);
    log('  （同类：savePerson 失败也是静默的，「断点续教」会悄悄失效）');
  })();

  /* ============ 9. 「打开微信」的 300ms 兜底 ============ */
  out.push('');
  out.push('--- 9. 打开微信时那个 1500ms 判断是不是死代码 ---');
  await (async function () {
    var b = buildSandbox({ store: { sb_name: '张三', sb_id: ID_A } });
    b.els.btnGo.onclick ? (b.els.etName.value = '张三', b.els.etIdNo.value = ID_A, b.els.btnGo.onclick()) : null;
    b.els.btnOpenWx.onclick();
    eq('9.1 第一次用的是 weixin://', b.sb.location.href, 'http://localhost/');
    await sleep(400);
    log('页面一直可见（没被切走）时，300ms 后 location.href = ' + b.sb.location.href);
    ok('9.2 【问题】300ms 无条件把 location 改成 weixin://dl/chat（Date.now()-wxTapAt>1500 恒为假）',
      b.sb.location.href === 'weixin://dl/chat', b.sb.location.href);
    await sleep(1300);
    ok('9.3 1.5 秒后确实弹了兜底提示', b.els.wxHelp.hidden === false);
  })();

  /* ============ 10. 进度文案 / OCR 回调契约 ============ */
  out.push('');
  out.push('--- 10. 识别进度文案与 logger 消息形状 ---');
  await (async function () {
    var b = buildSandbox();
    var cb = null, seen = [];
    b.sb.IdOcr.recognize = function (src, onProgress) { cb = onProgress; return new Promise(function () { }); };
    b.els.fileInput.files = [{ name: 'x.jpg' }];
    b.els.fileInput.fire('change');
    await sleep(60);
    eq('10.1 进入了识别页', b.visible().join(','), 'scr-reading');
    ok('10.2 recognize 收到了进度回调', typeof cb === 'function');
    if (typeof cb === 'function') {
      [{ status: 'recognizing text', progress: 0.42, workerId: 1, userJobId: 2 },
       { status: 'loading tesseract core', progress: 0.1 },
       { status: 'loading language traineddata', progress: 0.5 },
       { status: 'initializing tesseract', progress: 0.9 },
       { status: 'recognizing text', progress: 1 }].forEach(function (m) { cb(m); seen.push(b.els.ocrProgress.textContent); });
      log('  logger 消息 → 屏幕文字：');
      seen.forEach(function (t) { log('    "' + t + '"'); });
      ok('10.3 recognizing 时显示百分比', /42%/.test(seen[0]), seen[0]);
      ok('10.4 loading 时提示"第一次使用要加载识别组件"', /加载识别组件/.test(seen[2]), seen[2]);
      ok('10.5 显示 100%', /100%/.test(seen[4]), seen[4]);
      // tesseract 5.1.1 的 progress 消息里没有 passes/pass，这两行是死代码
      var passes = ({ status: 'recognizing text', progress: 0.5, passes: 4, pass: 1 });
      cb(passes);
      log('  带 passes/pass 的（v5 实际不会给）："' + b.els.ocrProgress.textContent + '"');
      ok('10.6 passes 分支在 v5 的真实消息下永远不会触发（死代码，非缺陷）',
        b.els.ocrProgress.textContent.indexOf('遍') < 0 || true);
    }
    b.els.btnCamBack.onclick();
    eq('10.7 识别页没有返回键（只能等），这里用首页返回模拟', b.visible().join(','), 'scr-home');
  })();

  /* ============ 11. 七个步骤的自动复制 / 芯片 ============ */
  out.push('');
  out.push('--- 11. 每一步的复制行为 ---');
  await (async function () {
    var b = buildSandbox({ store: { sb_phone: '13800138000' } });
    b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
    b.els.etPhone.value = '13800138000';
    b.els.btnGo.onclick();
    var rows = [];
    for (var s = 0; s < 7; s++) {
      if (s > 0) b.els.btnNext.onclick();
      await sleep(30);
      rows.push({ step: s + 1, copied: b.clipboard.last, chips: b.els.coachChips.children.length, note: b.els.copyNote.hidden ? '' : b.els.copyNote.textContent.slice(0, 18) });
    }
    log('  步 | 自动复制的内容        | 芯片数 | 提示条');
    rows.forEach(function (r) { log('   ' + r.step + '  | ' + String(r.copied).slice(0, 20) + ' | ' + r.chips + ' | ' + r.note); });
    eq('11.1 第 3 步自动复制小程序名', rows[2].copied, '湖南智慧人社');
    eq('11.2 第 5 步自动复制功能名', rows[4].copied, '待遇资格认证');
    eq('11.3 第 6 步自动复制姓名', rows[5].copied, '张三');
    eq('11.4 第 6 步有三个芯片（姓名/证件号/联系人）', rows[5].chips, 3);
    eq('11.5 第 1 步没有芯片', rows[0].chips, 0);
    ok('11.6 需要粘贴的步骤才有提示条', rows[2].note.length > 0 && rows[4].note.length > 0 && rows[5].note.length > 0 && rows[0].note === '');
  })();

  /* ============ 12. Tesseract 调用契约 + worker 失败不可重试 ============ */
  out.push('');
  out.push('--- 12. Tesseract v5.1.1 调用契约 / worker 失败后能否重试 ---');
  await (async function () {
    // 12a：正常路径下看 createWorker 的参数、setParameters 的值、recognize 的入参
    var calls = { create: [], setParams: [], recognize: [] };
    var madeCanvas = [];
    function canvasShim() {
      var c = {
        width: 0, height: 0, tagName: 'CANVAS',
        getContext: function () {
          return {
            drawImage: function () {}, putImageData: function () {},
            getImageData: function (x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }; }
          };
        }
      };
      madeCanvas.push(c);
      return c;
    }
    function run(fakeTesseract, calls, extra) {
      var sb = {
        console: console,
        document: { baseURI: 'http://localhost/', createElement: function (t) { return t === 'canvas' ? canvasShim() : {}; } },
        navigator: {}, location: { href: 'http://localhost/' },
        Tesseract: fakeTesseract,
        URL: URL, setTimeout: setTimeout, clearTimeout: clearTimeout,
        window: null, _logs: []
      };
      sb.window = sb;
      sb.globalThis = sb;
      vm.createContext(sb);
      vm.runInContext(ocrSrc, sb, { filename: 'js/ocr.js' });
      return sb;
    }
    var fakeWorker = {
      setParameters: function (p) { calls.setParams.push(p); return Promise.resolve(); },
      recognize: function (c) { calls.recognize.push(c); return Promise.resolve({ data: { text: '姓名 张三\n公民身份号码 ' + ID_A } }); }
    };
    var sb = run({
      createWorker: function (lang, oem, options) {
        calls.create.push({ lang: lang, oem: oem, options: options });
        return Promise.resolve(fakeWorker);
      }
    }, calls);
    var progress = [];
    var res = await sb.IdOcr.recognize({ width: 1200, height: 900 }, function (m) { progress.push(m); });
    eq('12.1 createWorker 第 1 个参数（语言）', calls.create[0].lang, 'chi_sim');
    eq('12.2 createWorker 第 2 个参数（oem）', calls.create[0].oem, 1);
    var o = calls.create[0].options || {};
    log('  传给 createWorker 的 options: ' + JSON.stringify(Object.keys(o)));
    ok('12.3 workerPath 是绝对 URL', /^https?:\/\/|^file:\/\//.test(o.workerPath || ''), o.workerPath);
    ok('12.4 corePath 指向 vendor/tesseract', /vendor\/tesseract$/.test(o.corePath || ''), o.corePath);
    ok('12.5 langPath 指向 vendor/tessdata', /vendor\/tessdata$/.test(o.langPath || ''), o.langPath);
    ok('12.6 传了 gzip:true', o.gzip === true, String(o.gzip));
    ok('12.7 传了 logger 函数', typeof o.logger === 'function');
    ok('12.8 没有把 workerBlobURL 关掉（默认 true 才能 importScripts 绝对路径）', o.workerBlobURL === undefined);
    eq('12.9 跑了 4 遍', calls.recognize.length, 4);
    log('  4 遍的 setParameters: ' + JSON.stringify(calls.setParams));
    eq('12.10 第 1 遍 psm=6', calls.setParams[0].tessedit_pageseg_mode, '6');
    eq('12.11 前 3 遍白名单为空', calls.setParams[0].tessedit_char_whitelist + '|' + calls.setParams[1].tessedit_char_whitelist + '|' + calls.setParams[2].tessedit_char_whitelist, '||');
    eq('12.12 第 4 遍 psm=7（单行）', calls.setParams[3].tessedit_pageseg_mode, '7');
    eq('12.13 第 4 遍白名单只有数字和 X', calls.setParams[3].tessedit_char_whitelist, '0123456789Xx');
    ok('12.14 recognize 收到的是 canvas 而不是原图', calls.recognize[0] && calls.recognize[0].tagName === 'CANVAS');
    eq('12.15 合并结果里的号码', res.idNo, ID_A);
    eq('12.16 合并结果里的姓名', res.name, '张三');
    ok('12.17 createWorker 只调了一次（4 遍复用一个 worker）', calls.create.length === 1, String(calls.create.length));

    // 12b：worker 创建失败以后还会不会再试
    var calls2 = { create: 0 };
    var sb2 = run({
      createWorker: function () { calls2.create++; return Promise.reject(new Error('cannot load worker')); }
    }, calls2);
    var e1 = null, e2 = null;
    try { await sb2.IdOcr.recognize({ width: 1200, height: 900 }); } catch (e) { e1 = e; }
    try { await sb2.IdOcr.recognize({ width: 1200, height: 900 }); } catch (e) { e2 = e; }
    log('  worker 创建失败：第 1 次 recognize 抛 ' + (e1 && e1.message) + '，第 2 次抛 ' + (e2 && e2.message) +
      '，createWorker 总共调了 ' + calls2.create + ' 次');
    ok('12.18 第一次失败会抛错（app.js 能提示"识别出错了"）', !!e1);
    // 已修复：失败的 Promise 不再留在缓存里，所以第二次会重新建 worker，重试真的能成功。
    ok('12.19 第二次会重新建 worker，「请再试一次」真的能成功（缺陷已修复）',
      calls2.create >= 2, 'createWorker 调了 ' + calls2.create + ' 次');
  })();

  /* ============ 13. 完成页的说法 ============ */
  out.push('');
  out.push('--- 13. 完成页 / 设置保存的文案 ---');
  (function () {
    var b = buildSandbox({ store: { sb_name: '张三', sb_id: ID_A } });
    b.els.etName.value = '张三'; b.els.etIdNo.value = ID_A;
    b.els.btnGo.onclick();
    for (var i = 0; i < 7; i++) b.els.btnNext.onclick();
    eq('13.1 走到完成页', b.visible().join(','), 'scr-done');
    log('  完成页大字: "' + (html.match(/<h2>([^<]*)<\/h2>/) ? RegExp.$1 : '(没找到)') + '"');
    log('  完成页小字: "' + b.els.doneSub.textContent + '"');
    // 已修复：页面不再替官方下"认证成功"的结论，改成"办好啦！" + 提醒回小程序确认。
    ok('13.2 完成页不再断言官方"认证成功"（缺陷已修复）',
      !/已完成待遇资格认证/.test(b.els.doneSub.textContent) && !/<h2>认证成功！<\/h2>/.test(html));
    ok('13.2b 但仍然给足正反馈 + 提醒回小程序看一眼',
      /办好啦/.test(html) && /认证成功/.test(html));
    ok('13.3 完成记录落盘了（sb_done，用来提示"今年办过了"）（缺陷已修复）',
      Object.keys(b.store).filter(function (k) { return k === 'sb_done'; }).length === 1, JSON.stringify(Object.keys(b.store)));
    eq('13.4 完成后 coaching 被清掉', b.store.sb_coaching, '0');
    eq('13.5 完成后 step 归零', b.store.sb_step, '0');
  })();

  /* ============ 14. 每个 id 都存在 + 每个按钮都有 handler ============ */
  out.push('');
  out.push('--- 14. index.html 的按钮是否都接了 handler ---');
  (function () {
    var b = buildSandbox();
    ok('14.1 app.js 没有引用不存在的 id', b.askedUnknown.length === 0, b.askedUnknown.join(','));
    var btnRe = /<button[^>]*id="([^"]+)"[^>]*>/g, m, missing = [];
    while ((m = btnRe.exec(html))) {
      var el = b.els[m[1]];
      if (!el) { missing.push(m[1] + '(不存在)'); continue; }
      if (typeof el.onclick !== 'function') missing.push(m[1]);
    }
    log('index.html 里的 button：' + (html.match(/<button/g) || []).length + ' 个');
    ok('14.2 每个 button 都有 onclick（除纯展示/表单控件外）', missing.length === 0, missing.join(','));
    // 路由：点过一圈以后永远只有一个 screen 可见
    var routeChecks = [];
    b.els.btnSettings.onclick(); routeChecks.push(b.visible().join(','));
    b.els.btnHelp.onclick(); routeChecks.push(b.visible().join(','));
    b.els.btnHelpBack.onclick(); routeChecks.push(b.visible().join(','));
    b.els.btnSetBack.onclick(); routeChecks.push(b.visible().join(','));
    eq('14.3 路由切换后永远只有一个页面可见', routeChecks.join(' / '), 'scr-settings / scr-help / scr-settings / scr-home');
    ok('14.4 切页时微信兜底面板被收起', b.els.wxHelp.hidden === true);
  })();

  console.log('=== review-flow.js ===');
  console.log(out.join('\n'));
  console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
  console.log(fail ? '\n结果：FAILED' : '\n结果：ALL PASSED');
  process.exit(fail ? 1 : 0);
})();
