/* 页面流程冒烟测试：用最小 DOM 垫片在 Node 里真的把 app.js 跑一遍
 *
 * 运行：
 *   node test/app.smoke.js
 *
 * 覆盖：
 *   - 初始化只显示首页（验证 hidden 切换逻辑）
 *   - 走完 7 步教练流程 → 完成页
 *   - 进度文字「第 N 步 / 共 7 步」和 7 个进度点
 *   - 进入需要数据的步骤时自动复制
 *   - OCR 只认出一个字段时的核对页（自动展开输入框 + 红色大字警告）
 *   - 「打开微信」打不开时 1.5 秒后弹出兜底提示
 *   - 上次没教完时自动续上
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

/* ---------- 最小 DOM ---------- */
function makeEl(id) {
  var el = {
    id: id || '',
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    className: '',
    style: {},
    children: [],
    offsetWidth: 0,
    _listeners: {},
    classList: {
      add: function (c) {
        if ((' ' + el.className + ' ').indexOf(' ' + c + ' ') < 0) el.className = (el.className + ' ' + c).trim();
      },
      remove: function (c) {
        el.className = (' ' + el.className + ' ').split(' ' + c + ' ').join(' ').trim();
      },
      contains: function (c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; }
    },
    setAttribute: function (k, v) { el['_' + k] = v; },
    appendChild: function (c) { el.children.push(c); return c; },
    removeChild: function (c) {
      var i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    focus: function () { el._focused = true; },
    scrollIntoView: function () {},
    querySelector: function () { return makeEl('p'); },
    addEventListener: function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    fire: function (t) {
      (el._listeners[t] || []).forEach(function (fn) { fn.call(el, { target: el }); });
    }
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
  ids.forEach(function (id) { els[id] = makeEl(id); });
  var askedUnknown = [];

  var store = opts.store || {};
  var clipboard = { last: null, writes: 0 };
  var spoken = [];

  var body = makeEl('body');
  var doc = {
    baseURI: 'http://localhost/',
    hidden: false,
    visibilityState: 'visible',
    body: body,
    _listeners: {},
    getElementById: function (id) {
      if (!els[id]) { askedUnknown.push(id); return null; }
      return els[id];
    },
    createElement: function (tag) { return makeEl(tag); },
    addEventListener: function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
    removeEventListener: function () {},
    fire: function (t) { (doc._listeners[t] || []).forEach(function (fn) { fn({}); }); }
  };

  var sandbox = {
    console: console,
    document: doc,
    scrollTo: function () {},
    _winListeners: {},
    addEventListener: function (t, fn) { (sandbox._winListeners[t] = sandbox._winListeners[t] || []).push(fn); },
    removeEventListener: function () {},
    navigator: {
      userAgent: 'smoke-test',
      clipboard: {
        writeText: function (v) {
          clipboard.last = v; clipboard.writes++;
          return Promise.resolve();
        }
      }
      // 故意不给 mediaDevices / wakeLock，走降级分支
    },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); }
    },
    location: { href: 'http://localhost/' },
    speechSynthesis: {
      speaking: false, pending: false,
      getVoices: function () { return [{ lang: 'zh-CN', name: '测试声音' }]; },
      speak: function (u) { spoken.push(u && u.text); },
      cancel: function () {}
    },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
    requestAnimationFrame: function (fn) { fn(); },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URL: URL,
    Image: function () {},
    createImageBitmap: function () { return Promise.resolve({ width: 1200, height: 900 }); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(ocrSrc, sandbox, { filename: 'js/ocr.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'js/app.js' });

  return {
    sandbox: sandbox, els: els, doc: doc, store: store,
    clipboard: clipboard, spoken: spoken, askedUnknown: askedUnknown,
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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
  /* ============ 场景 1：干净启动 → 走完 7 步 ============ */
  var a = buildSandbox();
  out.push('--- 场景 1：首次打开，走完整个教练流程 ---');
  eq('1.1 初始化只显示首页', a.visible().join(','), 'scr-home');
  ok('1.2 没有引用不存在的 id', a.askedUnknown.length === 0, a.askedUnknown.join(','));
  ok('1.3 没有存过信息时「上次的」按钮隐藏', a.els.btnLast.hidden === true);

  // 本来应走 OCR，这里直接模拟已经核对好数据
  a.els.etName.value = '张三';
  a.els.etIdNo.value = ID_A;
  a.els.btnGo.onclick();
  eq('1.4 点开始后进入教练页', a.visible().join(','), 'scr-coach');
  eq('1.5 步骤总数是 7 步', a.els.coachStepNo.textContent, '第 1 步 / 共 7 步');
  eq('1.6 进度点正好 7 个', a.els.stepDots.children.length, 7);
  ok('1.7 第 1 个进度点是当前点',
    a.els.stepDots.children[0].classList.contains('on') &&
    !a.els.stepDots.children[1].classList.contains('on'));
  ok('1.8 第 1 步讲打开微信', /打开微信/.test(a.els.coachTitle.textContent), a.els.coachTitle.textContent);
  ok('1.9 底部【打开微信】按钮已接线且页面里有这个大字按钮',
    typeof a.els.btnOpenWx.onclick === 'function' && /💬 打开微信/.test(html));

  a.els.btnNext.onclick();   // → 第 2 步
  eq('1.10 第 2 步文案', a.els.coachStepNo.textContent, '第 2 步 / 共 7 步');
  ok('1.11 第 2 步讲往下滑', /往下滑/.test(a.els.coachBody.innerHTML));

  a.els.btnNext.onclick();   // → 第 3 步（需要复制小程序名）
  await sleep(10);
  eq('1.12 第 3 步自动复制了小程序名', a.clipboard.last, '湖南智慧人社');
  ok('1.13 提示语说已经复制好了', /已经帮您复制好/.test(a.els.copyNote.textContent), a.els.copyNote.textContent);
  ok('1.14 第 3 步有一个「复制」按钮', a.els.coachChips.children.length === 1, String(a.els.coachChips.children.length));

  a.els.btnNext.onclick();   // → 第 4 步
  ok('1.15 第 4 步讲「政府」', /政府/.test(a.els.coachBody.innerHTML));
  a.els.btnNext.onclick();   // → 第 5 步
  await sleep(10);
  eq('1.16 第 5 步自动复制了功能名', a.clipboard.last, '待遇资格认证');
  a.els.btnNext.onclick();   // → 第 6 步
  await sleep(10);
  eq('1.17 第 6 步自动复制了姓名', a.clipboard.last, '张三');
  eq('1.18 第 6 步有两个数据块', a.els.coachChips.children.length, 2);
  a.els.btnNext.onclick();   // → 第 7 步
  eq('1.19 到第 7 步', a.els.coachStepNo.textContent, '第 7 步 / 共 7 步');
  ok('1.20 最后一步按钮变成「我认证完成啦」', /我认证完成啦/.test(a.els.btnNext.textContent));
  ok('1.21 第 7 步讲眨眼摇头', /眨眨眼/.test(a.els.coachBody.innerHTML));

  a.els.btnNext.onclick();   // → 完成
  eq('1.22 点完成后到完成页', a.visible().join(','), 'scr-done');
  ok('1.23 完成页写了姓名', /张三/.test(a.els.doneSub.textContent), a.els.doneSub.textContent);
  ok('1.24 真的调用过语音播报', a.spoken.length > 0, 'spoken=' + a.spoken.length);

  // 「打开微信」兜底：页面没被切走，1.5 秒后要弹提示
  a.els.btnOpenWx.onclick();
  ok('1.25 点了打开微信先把旧提示藏起来', a.els.wxHelp.hidden === true);
  await sleep(1700);
  ok('1.26 1.5 秒后弹出「回桌面点绿色微信」提示', a.els.wxHelp.hidden === false);

  /* ============ 场景 2：OCR 只认出一个字段 ============ */
  out.push('--- 场景 2：OCR 只认出姓名，身份证号没认出来 ---');
  var b = buildSandbox();
  b.sandbox.IdOcr.recognize = function () {
    return Promise.resolve({ name: '李四', idNo: null });
  };
  b.els.fileInput.value = '';
  b.els.fileInput.files = [{ name: 'x.jpg' }];
  b.els.fileInput.fire('change');
  await sleep(50);
  eq('2.1 识别完停在核对页', b.visible().join(','), 'scr-confirm');
  eq('2.2 姓名填进输入框', b.els.etName.value, '李四');
  eq('2.3 身份证号是空的（没有被旧值兜底）', b.els.etIdNo.value, '');
  ok('2.4 输入框自动展开', b.els.editBox.hidden === false);
  ok('2.5 弹出了红色大字警告', b.els.warnBox.hidden === false && /身份证号没认出来/.test(b.els.warnBox.textContent),
    b.els.warnBox.textContent);

  // 手动补号后可以继续
  b.els.etIdNo.value = ID_A;
  b.els.btnGo.onclick();
  eq('2.6 补上号码后进入教练页', b.visible().join(','), 'scr-coach');

  // 校验位错误时必须先警告一次
  var c = buildSandbox({ store: { sb_name: '王五', sb_id: '430102199001011239', sb_coaching: '0', sb_step: '0' } });
  c.els.btnLast.onclick();
  ok('2.7 上次的号码填进核对页', c.els.etIdNo.value === '430102199001011239');
  out.push('  （号码 430102199001011239 校验位是错的，下面点两次）');
  c.els.btnGo.onclick();
  ok('2.8 第一次点不放行，给出警告', c.visible().join(',') === 'scr-confirm' && /对不上/.test(c.els.warnBox.textContent));
  c.els.btnGo.onclick();
  ok('2.9 再点一次就放行（允许继续）', c.visible().join(',') === 'scr-coach');

  /* ============ 场景 3：清空输入不能被旧值顶回来 ============ */
  out.push('--- 场景 3：把识别错的姓名清空 ---');
  var d = buildSandbox({ store: { sb_name: '张三', sb_id: ID_A } });
  d.els.btnLast.onclick();
  d.els.etName.value = '';                 // 老人发现姓名是错的，删掉
  d.els.btnGo.onclick();
  eq('3.1 清空后不能被旧值顶回来', d.visible().join(','), 'scr-confirm');
  ok('3.2 提示姓名要填', /姓名和身份证号都要填/.test(d.els.warnBox.textContent), d.els.warnBox.textContent);

  /* ============ 场景 4：上次没教完 → 自动续上 ============ */
  out.push('--- 场景 4：中途退出后再打开 ---');
  var e = buildSandbox({ store: { sb_name: '赵六', sb_id: ID_B_DUMMY(), sb_coaching: '1', sb_step: '3' } });
  eq('4.1 直接回到教练页', e.visible().join(','), 'scr-coach');
  eq('4.2 回到第 4 步', e.els.coachStepNo.textContent, '第 4 步 / 共 7 步');
  ok('4.3 第 4 个进度点是当前点', e.els.stepDots.children[3].classList.contains('on'));
  ok('4.4 前 3 个点是已完成', [0, 1, 2].every(function (i) { return e.els.stepDots.children[i].classList.contains('done'); }));

  /* ============ 场景 5：设置里能进帮助页 ============ */
  out.push('--- 场景 5：帮助页 ---');
  e.els.btnSettings.onclick();
  eq('5.1 打开设置', e.visible().join(','), 'scr-settings');
  e.els.btnHelp.onclick();
  eq('5.2 打开帮助', e.visible().join(','), 'scr-help');
  e.els.btnHelpBack.onclick();
  eq('5.3 从帮助返回设置', e.visible().join(','), 'scr-settings');
  e.els.btnSetBack.onclick();
  eq('5.4 从设置返回首页', e.visible().join(','), 'scr-home');

  /* ============ 场景 6：语音开关被合并保留（老存档没 voice 字段）============ */
  out.push('--- 场景 6：老存档里的设置合并 ---');
  var f = buildSandbox({ store: { sb_settings: JSON.stringify({ mini: '湖南智慧人社' }) } });
  f.els.btnSettings.onclick();
  ok('6.1 老存档缺 voice 时默认仍然是开', f.els.setVoice.checked === true);

  console.log('=== 页面流程冒烟测试 ===');
  console.log(out.join('\n'));
  console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
  console.log(fail ? '\n结果：FAILED' : '\n结果：ALL PASSED');
  process.exit(fail ? 1 : 0);
})();

function ID_B_DUMMY() { return makeId('43052419851212008'); }
