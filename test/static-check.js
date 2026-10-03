/* 静态完整性检查（Node 里跑，不需要浏览器）
 *
 * 运行：
 *   "C:\Users\dell\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/static-check.js
 *
 * 查四件事：
 *   a) index.html 里每个 id="..." 都收集起来
 *   b) js/app.js 里 $('...') / getElementById('...') 引用的 id 全都存在
 *   c) index.html / js/*.js / css/*.css / sw.js 里没有 http:// https:// 外链（注释不算）
 *   d) sw.js 的 PRECACHE 里每个文件都真的在磁盘上
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var problems = [];
var notes = [];
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* ---------- a) index.html 里的 id ---------- */
var html = read('index.html');
var htmlIds = [];
var idRe = /\sid\s*=\s*"([^"]+)"/g, m;
while ((m = idRe.exec(html))) htmlIds.push(m[1]);
var idSet = {};
htmlIds.forEach(function (id) {
  if (idSet[id]) problems.push('index.html 里 id 重复：' + id);
  idSet[id] = true;
});
console.log('=== a) index.html 里的 id（共 ' + htmlIds.length + ' 个）===');
console.log('  ' + htmlIds.join(', '));

/* ---------- b) app.js 引用的 id ---------- */
var app = read('js/app.js');
var refs = [];
var refRe = /\$\(\s*'([^']+)'\s*\)|getElementById\(\s*'([^']+)'\s*\)/g;
while ((m = refRe.exec(app))) refs.push(m[1] || m[2]);
var missing = [];
refs.forEach(function (r) {
  if (!idSet[r] && missing.indexOf(r) < 0) missing.push(r);
});
console.log('\n=== b) app.js 里引用的 id（去重后 ' + uniq(refs).length + ' 个）===');
console.log('  ' + uniq(refs).join(', '));
if (missing.length) {
  problems.push('app.js 引用了 index.html 里不存在的 id：' + missing.join(', '));
  console.log('  ✗ 找不到的 id：' + missing.join(', '));
} else {
  console.log('  ✓ 全部存在于 index.html');
}
// 反向：index.html 里的 id 有没有 app.js 从没管过的
var unused = htmlIds.filter(function (id) { return refs.indexOf(id) < 0; });
console.log('  （index.html 中未被 app.js 直接取用的 id：' + (unused.join(', ') || '无') + '）');

/* ---------- c) 没有外部网络请求 ---------- */
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' '); }
function stripHtmlComments(s) { return s.replace(/<!--[\s\S]*?-->/g, ' '); }

var targets = [
  { file: 'index.html', strip: stripHtmlComments },
  { file: 'sw.js', strip: stripJsComments },
  { file: 'manifest.webmanifest', strip: function (s) { return s; } }
];
fs.readdirSync(path.join(ROOT, 'js')).forEach(function (f) {
  if (/\.js$/.test(f)) targets.push({ file: 'js/' + f, strip: stripJsComments });
});
fs.readdirSync(path.join(ROOT, 'css')).forEach(function (f) {
  if (/\.css$/.test(f)) targets.push({ file: 'css/' + f, strip: stripCssComments });
});

console.log('\n=== c) 外链扫描（http:// 与 https://）===');
var urlHits = 0;
targets.forEach(function (t) {
  var body = t.strip(read(t.file));
  var re = /https?:\/\/[^\s"')<>]*/g, hit;
  var seen = [];
  while ((hit = re.exec(body))) seen.push(hit[0]);
  if (seen.length) {
    urlHits += seen.length;
    problems.push(t.file + ' 里有外部链接：' + seen.join(' '));
    console.log('  ✗ ' + t.file + ' -> ' + seen.join(' '));
  } else {
    console.log('  ✓ ' + t.file + ' 无外链');
  }
});
if (!urlHits) console.log('  （README.md 里的部署地址不算，未纳入扫描）');

/* ---------- d) sw.js PRECACHE 里的文件都在 ---------- */
var sw = read('sw.js');
var block = /var\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(sw);
console.log('\n=== d) sw.js 预缓存清单 ===');
var version = /var\s+VERSION\s*=\s*'([^']+)'/.exec(sw);
console.log('  VERSION = ' + (version ? version[1] : '（没找到！）'));
if (!version) problems.push('sw.js 里找不到 VERSION');
if (!block) {
  problems.push('sw.js 里找不到 PRECACHE');
  console.log('  ✗ 找不到 PRECACHE');
} else {
  var list = block[1].split(',').map(function (s) { return s.trim().replace(/^['"]|['"]$/g, ''); })
    .filter(function (s) { return s.length > 0; });
  var bad = [];
  list.forEach(function (p) {
    var rel = p === './' ? '.' : p.replace(/^\.\//, '');
    var good = exists(rel);
    console.log('  ' + (good ? '✓' : '✗') + ' ' + p);
    if (!good) bad.push(p);
  });
  if (bad.length) problems.push('sw.js 预缓存了不存在的文件：' + bad.join(', '));
  // 反向：js/css 目录里的文件有没有漏掉
  ['js/app.js', 'js/ocr.js', 'css/style.css', 'index.html', 'manifest.webmanifest'].forEach(function (f) {
    if (list.indexOf(f) < 0) notes.push('提示：sw.js 的 PRECACHE 里没有 ' + f);
  });
}

/* ---------- 汇总 ---------- */
function uniq(a) {
  var out = [];
  a.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
  return out;
}

console.log('\n=== 汇总 ===');
notes.forEach(function (n) { console.log('  ' + n); });
if (problems.length) {
  problems.forEach(function (p) { console.log('  ✗ ' + p); });
  console.log('\n结果：FAILED（' + problems.length + ' 个问题）');
  process.exit(1);
} else {
  console.log('  ✓ 全部检查通过');
  console.log('\n结果：ALL PASSED');
}
