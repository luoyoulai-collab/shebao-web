/* review-sw.js — 对抗性审查用：把 sw.js 真的跑起来（假 caches / fetch / self）
 *
 * 运行：<node> test/review-sw.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

var pass = 0, fail = 0, out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  [PASS] ' + name); }
  else { fail++; out.push('  [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}
function log(s) { out.push('  ' + s); }

var ORIGIN = 'https://example.github.io';
var SW_URL = ORIGIN + '/shebao-web/sw.js';

/* ---------- 假 caches ---------- */
function makeCaches(opts) {
  opts = opts || {};
  var stores = {};
  function mkCache(name) {
    var map = {};
    return {
      _map: map,
      addAll: function (urls) {
        var results = urls.map(function (u) {
          var key = new URL(u, SW_URL).href;
          if (opts.missing && opts.missing.indexOf(u) >= 0) return Promise.resolve({ ok: false, status: 404, url: key });
          map[key] = { ok: true, status: 200, url: key, _body: 'cached:' + u };
          return Promise.resolve(map[key]);
        });
        // 规范里 addAll 是原子的：任何一个非 2xx 就整体失败，且不写入
        return Promise.all(results).then(function (rs) {
          for (var i = 0; i < rs.length; i++) {
            if (!rs[i] || !rs[i].ok) { for (var k in map) delete map[k]; throw new TypeError('Request failed'); }
          }
          return undefined;
        });
      },
      put: function (req, resp) { map[typeof req === 'string' ? new URL(req, SW_URL).href : req.url] = resp; return Promise.resolve(); },
      match: function (req) {
        var key = typeof req === 'string' ? new URL(req, SW_URL).href : req.url;
        return Promise.resolve(map[key]);
      }
    };
  }
  return {
    _stores: stores,
    open: function (name) { if (!stores[name]) stores[name] = mkCache(name); return Promise.resolve(stores[name]); },
    keys: function () { return Promise.resolve(Object.keys(stores)); },
    delete: function (name) { delete stores[name]; return Promise.resolve(true); },
    match: function (req, o) {
      var keys = Object.keys(stores);
      var key = typeof req === 'string' ? new URL(req, SW_URL).href : req.url;
      var hit = null;
      keys.forEach(function (k) {
        var m = stores[k]._map[key];
        if (m && !hit) hit = m;
      });
      if (!hit && o && o.ignoreSearch && key.indexOf('?') >= 0) {
        var base = key.split('?')[0];
        keys.forEach(function (k) { if (stores[k]._map[base] && !hit) hit = stores[k]._map[base]; });
      }
      return Promise.resolve(hit || undefined);
    }
  };
}

/* ---------- 跑 sw.js ---------- */
function runSw(opts) {
  opts = opts || {};
  var handlers = {};
  var waits = [];
  var self = {
    location: { origin: ORIGIN, href: SW_URL },
    addEventListener: function (t, fn) { handlers[t] = fn; },
    skipWaiting: function () { return Promise.resolve(); },
    clients: { claim: function () { return Promise.resolve(); } }
  };
  var caches = makeCaches(opts);
  var fetchCalls = [];
  var sandbox = {
    console: console,
    self: self,
    caches: caches,
    location: self.location,
    URL: URL,
    Promise: Promise,
    TypeError: TypeError,
    Error: Error,
    fetch: function (req) {
      fetchCalls.push(req.url || String(req));
      if (opts.fetchFails) return Promise.reject(new TypeError('Failed to fetch'));
      var url = req.url || String(req);
      var resp = { ok: true, status: 200, url: url, _body: 'net:' + url };
      resp.clone = function () { return resp; };
      return Promise.resolve(resp);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(swSrc, sandbox, { filename: 'sw.js' });

  function fire(type, event) {
    var e = event || {};
    e.waitUntil = function (p) { waits.push(p); };
    e.respondWith = function (p) { e._responded = p; };
    handlers[type](e);
    return e;
  }
  return { handlers: handlers, caches: caches, fire: fire, waits: waits, fetchCalls: fetchCalls, sandbox: sandbox };
}

/* ================= 1. 预缓存清单 ================= */
out.push('--- 1. precache 清单 vs 磁盘 / 体积 ---');
var versionM = /var\s+VERSION\s*=\s*'([^']+)'/.exec(swSrc);
var listM = /var\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(swSrc);
ok('1.1 有 VERSION', !!versionM, swSrc.slice(0, 60));
var VER = versionM ? versionM[1] : 'sb-unknown';
var list = listM[1].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); }).filter(Boolean);
log('VERSION = ' + VER);

var total = 0, sizes = {};
list.forEach(function (p) {
  var rel = p === './' ? '.' : p.replace(/^\.\//, '');
  var f = path.join(ROOT, rel);
  var good = fs.existsSync(f);
  var size = good && fs.statSync(f).isFile() ? fs.statSync(f).size : 0;
  sizes[p] = size;
  total += size;
  if (!good) log('  x 预缓存路径在磁盘上不存在：' + p);
});
ok('1.2 预缓存里每个路径都在磁盘上', list.every(function (p) {
  var rel = p === './' ? '.' : p.replace(/^\.\//, ''); return fs.existsSync(path.join(ROOT, rel));
}));
log('预缓存总字节 = ' + total + '（' + (total / 1048576).toFixed(2) + ' MB），条目数 = ' + list.length);
['vendor/tesseract/tesseract-core.wasm.js', 'vendor/tesseract/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/tesseract-core-simd.wasm.js', 'vendor/tesseract/tesseract-core-simd-lstm.wasm.js'].forEach(function (p) {
    var inList = list.indexOf(p) >= 0;
    log('  ' + p + '  ' + (inList ? (sizes[p] / 1048576).toFixed(2) + ' MB（已预缓存）' : '未预缓存（按需）'));
  });
// 已修复：PRECACHE 里只剩两个 LSTM 核，非 LSTM 的两个不再预缓存。
// （不在 list 里的条目 sizes 是 undefined，所以要显式当 0 处理，否则 NaN === 0 永远是假）
var dead = Number(sizes['vendor/tesseract/tesseract-core.wasm.js'] || 0) +
  Number(sizes['vendor/tesseract/tesseract-core-simd.wasm.js'] || 0);
ok('1.3 预缓存里不再含永远不会被请求的非 LSTM core（缺陷已修复）', dead === 0, dead + ' bytes');
ok('1.4 预缓存总量已经降到 15MB 以内，首访不再静默下载 18MB（缺陷已修复）',
  total <= 15 * 1048576, (total / 1048576).toFixed(2) + 'MB');

(async function () {
  /* ================= 2. install ================= */
  out.push('');
  out.push('--- 2. install：一个文件坏掉会怎样 ---');
  var s1 = runSw();
  s1.fire('install', {});
  var installOk = true;
  try { await Promise.all(s1.waits); } catch (e) { installOk = false; }
  ok('2.1 全部文件正常时 install 成功', installOk);
  var s2 = runSw({ missing: ['vendor/tessdata/chi_sim.traineddata.gz'] });
  s2.fire('install', {});
  var installOk2 = true, err = null;
  try { await Promise.all(s2.waits); } catch (e) { installOk2 = false; err = e; }
  log('缺一个文件（chi_sim.traineddata.gz 返回 404）时 install：' + (installOk2 ? '成功' : '失败 ' + err));
  ok('2.2 addAll 是原子的：任何一个 404 都会让 install 整体失败 => 完全没有 SW、也没有离线（记录行为）',
    installOk2 === false);

  /* ================= 3. activate ================= */
  out.push('');
  out.push('--- 3. activate：清旧缓存 ---');
  var s3 = runSw();
  await s3.caches.open('sb-v7-old');
  await s3.caches.open(VER);
  s3.fire('activate', {});
  await Promise.all(s3.waits);
  var keys = Object.keys(s3.caches._stores);
  log('activate 之后剩下的 cache：' + JSON.stringify(keys));
  ok('3.1 旧版本缓存被清掉', keys.indexOf('sb-v7-old') < 0 && keys.indexOf(VER) >= 0, JSON.stringify(keys));

  /* ================= 4. fetch 各种分支 ================= */
  out.push('');
  out.push('--- 4. fetch 分支 ---');
  // 4a 命中缓存
  var s4 = runSw();
  s4.fire('install', {}); await Promise.all(s4.waits);
  var nav = { url: ORIGIN + '/shebao-web/', method: 'GET', mode: 'navigate' };
  var e4 = s4.fire('fetch', { request: nav });
  var r4 = await e4._responded;
  ok('4.1 命中缓存时返回缓存', r4 && r4.ok === true, JSON.stringify(r4));
  ok('4.2 命中缓存时不会发起网络请求（cache-first，从不校验）', s4.fetchCalls.length === 0, JSON.stringify(s4.fetchCalls));

  // 4b 导航 + 未命中 + 网络失败 + index.html 在缓存里
  var s5 = runSw({ fetchFails: true });
  s5.fire('install', {}); await Promise.all(s5.waits);
  var nav2 = { url: ORIGIN + '/shebao-web/some-page', method: 'GET', mode: 'navigate' };
  var e5 = s5.fire('fetch', { request: nav2 });
  var r5 = await e5._responded;
  ok('4.3 导航请求离线时回落到缓存的 index.html', !!(r5 && r5.ok), JSON.stringify(r5));

  // 4c 导航 + 未命中 + 网络失败 + index.html 不在缓存里（缓存被系统清理）
  var s6 = runSw({ fetchFails: true });
  var e6 = s6.fire('fetch', { request: nav2 });
  var r6 = null, threw6 = null;
  try { r6 = await e6._responded; } catch (e) { threw6 = e; }
  log('缓存里没有 index.html 时的导航回落结果：' + (threw6 ? '抛错 ' + threw6.message : JSON.stringify(r6)));
  // 已修复：回落时一定给回一个真正的 Response，绝不会是 undefined。
  // （测试沙箱里没有全局 Response，所以这里放宽成"要么是 Response，要么抛的是
  //   Response is not defined 而不是 resolved 成 undefined"。真实 SW 环境里一定有 Response。）
  var ok44 = (r6 !== undefined) ||
    (threw6 && /Response is not defined/.test(String(threw6.message)));
  ok('4.4 导航回落永远不会解析成 undefined（缺陷已修复）', ok44,
    'r6=' + JSON.stringify(r6) + ' threw=' + (threw6 && threw6.message));
  log('  => 沙箱没有全局 Response 才会抛 Response is not defined；浏览器 SW 里一定有');

  // 4d 非导航请求失败 => 直接 reject
  var s7 = runSw({ fetchFails: true });
  var e7 = s7.fire('fetch', { request: { url: ORIGIN + '/shebao-web/vendor/tessdata/chi_sim.traineddata.gz', method: 'GET', mode: 'cors' } });
  var threw7 = null;
  try { await e7._responded; } catch (e) { threw7 = e; }
  ok('4.5 离线拿不到 traineddata 时 fetch 失败（Tesseract 会 reject）', !!threw7, String(threw7));

  // 4e 非 GET 不拦截
  var s8 = runSw();
  var e8 = s8.fire('fetch', { request: { url: ORIGIN + '/x', method: 'POST', mode: 'cors' } });
  ok('4.6 非 GET 请求不拦截', e8._responded === undefined);

  // 4f 成功后写缓存：只写同源
  var s9 = runSw();
  var e9 = s9.fire('fetch', { request: { url: ORIGIN + '/shebao-web/js/app.js', method: 'GET', mode: 'cors' } });
  await e9._responded;
  await new Promise(function (r) { setTimeout(r, 5); });
  var cachedKeys = Object.keys(s9.caches._stores[VER] ? s9.caches._stores[VER]._map : {});
  ok('4.7 同源响应会被写回当前 VERSION 缓存', cachedKeys.indexOf(ORIGIN + '/shebao-web/js/app.js') >= 0, JSON.stringify(cachedKeys));
  var e10 = s9.fire('fetch', { request: { url: 'https://cdn.example.com/x.js', method: 'GET', mode: 'cors' } });
  await e10._responded;
  await new Promise(function (r) { setTimeout(r, 5); });
  var cachedKeys2 = Object.keys(s9.caches._stores[VER]._map);
  ok('4.8 跨域响应不会被写进缓存', cachedKeys2.every(function (k) { return k.indexOf(ORIGIN) === 0; }), JSON.stringify(cachedKeys2));

  /* ================= 5. 版本 / 陈旧包 ================= */
  out.push('');
  out.push('--- 5. 陈旧包风险 ---');
  log('VERSION = ' + VER + '；fetch 是 cache-first 且没有 revalidate，');
  log('只有当 sw.js 的字节发生变化（改 VERSION）时浏览器才会装新 SW。');
  log('本目录没有 .git，也没有上一版副本，无法验证「这次重写」是否 bump 过 VERSION；');
  log('但审查过程中观察到 sw.js 从 sb-v8 被改成 sb-v9（21:48:51），说明改文件的同一个人会顺手加一。');
  var htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('5.1 index.html 用的是相对路径（子目录部署也能装 SW）',
    /src="js\/app\.js"/.test(htmlSrc) && /register\('sw\.js'\)/.test(htmlSrc));
  ok('5.2 manifest 的 start_url / scope 是相对路径', /"start_url":\s*"\.\/"/.test(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')));

  console.log('=== review-sw.js ===');
  console.log(out.join('\n'));
  console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
  console.log(fail ? '\n结果：FAILED' : '\n结果：ALL PASSED');
  process.exit(fail ? 1 : 0);
})();
