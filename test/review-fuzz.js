/* review-fuzz.js — 对抗性审查用：parse / parseAll 的敌意输入模糊测试
 *
 * 运行：<node> test/review-fuzz.js
 */
'use strict';

var path = require('path');

global.window = global;
global.document = {
  baseURI: 'http://localhost/',
  createElement: function () { throw new Error('解析测试不应该创建 DOM 元素'); }
};
global.Tesseract = { createWorker: function () { throw new Error('解析测试不应该启动 Tesseract'); } };

require(path.join(__dirname, '..', 'js', 'ocr.js'));
var IdOcr = global.window.IdOcr;

var pass = 0, fail = 0, out = [];
function ok(name, cond, extra) {
  if (cond) { pass++; out.push('  [PASS] ' + name); }
  else { fail++; out.push('  [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }
function log(s) { out.push('  ' + s); }

var W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
var C = '10X98765432';
function refCheck(id17) { var s = 0; for (var i = 0; i < 17; i++) s += (id17.charCodeAt(i) - 48) * W[i]; return C.charAt(s % 11); }
function makeId(b) { return b + refCheck(b); }
var ID_A = makeId('43010219900101123');   // 430102199001011238
var ID_B = makeId('43052419851212008');

function safe(fn) { try { return { v: fn() }; } catch (e) { return { e: e }; } }

/* ================= 1. 敌意输入不许崩 ================= */

out.push('--- 1. 敌意输入（不许抛异常，必须返回 {name,idNo} 形状）---');
var nasty = [
  ['空字符串', ''],
  ['null', null],
  ['undefined', undefined],
  ['数字 0', 0],
  ['false', false],
  ['true', true],
  ['NaN', NaN],
  ['空对象', {}],
  ['空数组', []],
  ['嵌套数组', [['a']]],
  ['对象带 text', { text: '姓名 张三' }],
  ['Date', new Date(0)],
  ['只有换行', '\n\n\n'],
  ['只有空白', '   \t  \u3000 '],
  ['超长单行 20 万字符', new Array(200001).join('7')],
  ['超长单行里藏真号码', new Array(100001).join('8') + ID_A + new Array(100001).join('8')],
  ['5 万行', new Array(50001).join('姓名\n')],
  ['全角号码', '公民身份号码 ' + ID_A.replace(/[0-9]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) + 0xFEE0); })],
  ['号码里插空格', ID_A.slice(0, 6) + ' ' + ID_A.slice(6, 14) + ' ' + ID_A.slice(14)],
  ['号码里插连字符', ID_A.slice(0, 6) + '-' + ID_A.slice(6, 14) + '-' + ID_A.slice(14)],
  ['号码里插中文间隔号', ID_A.slice(0, 6) + '·' + ID_A.slice(6)],
  ['号码被拆成 3 行', ID_A.slice(0, 6) + '\n' + ID_A.slice(6, 12) + '\n' + ID_A.slice(12)],
  ['号码被拆成 17+1', ID_A.slice(0, 17) + '\n' + ID_A.charAt(17)],
  ['号码倒序', ID_A.split('').reverse().join('')],
  ['一万个数字', new Array(10001).join('1234567890')],
  ['混入零宽字符', ID_A.slice(0, 9) + '\u200b' + ID_A.slice(9)],
  ['BOM 开头', '\ufeff姓名 张三\n号码 ' + ID_A],
  ['emoji 混汉字', '姓名 张😀三\n号码 ' + ID_A],
  ['代理对', '姓名 \ud83d\ude00\n' + ID_A],
  ['只有标签', '姓名 性别 民族 出生 住址 公民身份号码'],
  ['重复姓名标签', '姓名 姓名 姓名 张三'],
  ['号码重复十遍', new Array(11).join(ID_A + '\n')]
];
for (var i = 0; i < nasty.length; i++) {
  (function (caseName, input) {
    var t0 = Date.now();
    var r = safe(function () { return IdOcr.parse(input); });
    var ms = Date.now() - t0;
    ok('1.' + i + ' parse 不抛异常：' + caseName, !r.e, r.e && r.e.message);
    if (!r.e) {
      ok('1.' + i + 'b 返回 {name,idNo}：' + caseName,
        r.v !== null && typeof r.v === 'object' && 'name' in r.v && 'idNo' in r.v, JSON.stringify(r.v));
      ok('1.' + i + 'c name 只能是 null 或字符串：' + caseName,
        r.v.name === null || typeof r.v.name === 'string', JSON.stringify(r.v.name));
      ok('1.' + i + 'd idNo 只能是 null 或字符串：' + caseName,
        r.v.idNo === null || typeof r.v.idNo === 'string', JSON.stringify(r.v.idNo));
      if (r.v.idNo) ok('1.' + i + 'e 认出来的号码长度必须是 18：' + caseName, r.v.idNo.length === 18, r.v.idNo);
    }
    if (ms > 2000) log('  ! ' + caseName + ' 耗时 ' + ms + 'ms');
    var r2 = safe(function () { return IdOcr.parseAll(input); });
    ok('1.' + i + 'f parseAll 不抛异常：' + caseName, !r2.e, r2.e && r2.e.message);
  })(nasty[i][0], nasty[i][1]);
}

out.push('');
out.push('--- 1x. parseAll 的容器形态 ---');
var containers = [
  ['字符串', '姓名 张三'],
  ['数字', 123],
  ['true', true],
  ['null', null],
  ['undefined', undefined],
  ['对象（没有 length）', { text: '姓名 张三' }],
  ['单个对象数组', [{ text: '姓名 张三', bonus: 0.3 }]],
  ['元素是 null', [null]],
  ['元素是数字', [1, 2, 3]],
  ['嵌套数组', [['姓名 张三']]],
  ['bonus 是字符串', [{ text: '姓名 张三', bonus: 'big' }]],
  ['bonus 是 NaN', [{ text: '姓名 张三', bonus: NaN }]],
  ['text 是数字号码', [{ text: 430102199001011238 }]],
  ['text 是 null', [{ text: null }]],
  ['空数组', []],
  ['10 万个空元素', new Array(100000)]
];
for (var j = 0; j < containers.length; j++) {
  (function (n, v) {
    var r = safe(function () { return IdOcr.parseAll(v); });
    ok('1x.' + j + ' parseAll 不抛：' + n, !r.e, r.e && r.e.message);
    if (!r.e) ok('1x.' + j + 'b 形状正确：' + n, 'name' in r.v && 'idNo' in r.v, JSON.stringify(r.v));
  })(containers[j][0], containers[j][1]);
}

/* ================= 2. 号码拆分的边界 ================= */

out.push('');
out.push('--- 2. 正常拆分必须拼回来 ---');
eq('2.1 空格分隔', IdOcr.parse('号码 ' + ID_A.slice(0, 6) + ' ' + ID_A.slice(6, 14) + ' ' + ID_A.slice(14)).idNo, ID_A);
eq('2.2 连字符分隔', IdOcr.parse('号码 ' + ID_A.slice(0, 6) + '-' + ID_A.slice(6)).idNo, ID_A);
eq('2.3 两行', IdOcr.parse('号码\n' + ID_A.slice(0, 9) + '\n' + ID_A.slice(9)).idNo, ID_A);
eq('2.4 三行', IdOcr.parse('号码\n' + ID_A.slice(0, 6) + '\n' + ID_A.slice(6, 12) + '\n' + ID_A.slice(12)).idNo, ID_A);
eq('2.5 全角', IdOcr.parse('号码 ' + ID_A.replace(/[0-9]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) + 0xFEE0); })).idNo, ID_A);
eq('2.6 混淆字符 O/I/l/S/B/Z/G', IdOcr.parse('号码 ' + ID_A.replace(/0/g, 'O').replace(/1/g, 'l').replace(/5/g, 'S').replace(/8/g, 'B')).idNo, ID_A);
eq('2.7 小写 x 结尾（若本来是小写）', IdOcr.parse('号码 ' + ID_A.slice(0, 17) + '8').idNo, ID_A);
eq('2.8 号码后面跟着中文', IdOcr.parse('公民身份号码 ' + ID_A + ' 有效期限 2020-2040').idNo, ID_A);
eq('2.9 号码前面是地址', IdOcr.parse('住址 湖南省长沙市\n公民身份号码 ' + ID_A).idNo, ID_A);

out.push('');
out.push('--- 2x. 不存在的号码必须返回 null（宁缺勿错）---');
eq('2x.1 17 位', IdOcr.parse('号码 43010219900101123').idNo, null);
// 19 位时取其中合法的前 18 位：这是刻意的容错（OCR 偶尔多带一位），记录行为、不算缺陷
eq('2x.2 19 位时取其中校验通过的 18 位（记录行为，可接受）', IdOcr.parse('号码 ' + ID_A + '9').idNo, ID_A);
eq('2x.3 出生月份非法 13', IdOcr.parse('号码 430102199013011238').idNo, null);
eq('2x.4 出生日期非法 32', IdOcr.parse('号码 430102199001321238').idNo, null);
eq('2x.5 地址码以 0 开头', IdOcr.parse('号码 030102199001011238').idNo, null);
eq('2x.6 全是数字但不合法', IdOcr.parse('号码 123456789012345678').idNo, null);

/* ================= 3. 姓名黑名单碰撞 ================= */

out.push('');
out.push('--- 3. 姓名 / 黑名单碰撞 ---');
eq('3.1 标签同行「姓名 张三」', IdOcr.parse('姓名 张三').name, '张三');
eq('3.2 标签同行粘连「姓名张三性别男」', IdOcr.parse('姓名张三性别男').name, '张三');
eq('3.3 姓名里带「男」字被拒（记录行为）', IdOcr.parse('姓名 李男').name, null);
eq('3.4 姓名里带「女」字被拒', IdOcr.parse('姓名 王女').name, null);
eq('3.5 复姓 4 字', IdOcr.parse('姓名 欧阳娜娜').name, '欧阳娜娜');
eq('3.6 只有「性别」行不能猜姓名', IdOcr.parse('性别 男').name, null);
eq('3.7 地址行不能当姓名', IdOcr.parse('住址 湖南省长沙市望城区高塘岭街道').name, null);
eq('3.8 民族行不能当姓名', IdOcr.parse('民族 汉').name, null);
eq('3.9 5 个汉字不算姓名', IdOcr.parse('姓名 张三李四王').name, null);
eq('3.10 单字不算姓名', IdOcr.parse('姓名 张').name, null);
eq('3.11 「区」姓在标签旁能认出来', IdOcr.parse('姓名 区大明').name, '区大明');
// 下面两条原来断言「区」「路」两个真姓氏会被兜底规则拒掉（记录缺陷）。
// 已修复：REJECT_CHARS 里去掉了 区/路，所以现在应当能认出来。
eq('3.12 没有标签时「区」姓也能认出来（缺陷已修复）', IdOcr.parse('区大明\n430102199001011238').name, '区大明');
eq('3.13 「路」姓同理', IdOcr.parse('路遥\n430102199001011238').name, '路遥');
eq('3.14 没有标签时普通姓名能兜底认出', IdOcr.parse('张三\n430102199001011238').name, '张三');
eq('3.15 「有效期」行不会被当名字', IdOcr.parse('有效期 2020.01.01-2040.01.01').name, null);
eq('3.16 「签发机关」行不会被当名字', IdOcr.parse('签发机关 长沙市公安局望城分局').name, null);
eq('3.17 姓名行被 OCR 前后加空格', IdOcr.parse('  姓名   张三  \n 性别 男').name, '张三');
eq('3.18 姓名标签在号码之后', IdOcr.parse('公民身份号码 ' + ID_A + '\n姓名 孙七').name, '孙七');

/* ================= 4. 校验位修正的双刃剑 ================= */

out.push('');
out.push('--- 4. 滑窗「修校验位」是否可能造出一个假的合法号码 ---');
(function () {
  // 真实号码少一位（OCR 漏字），后面跟着一个电话号：数字流拼接后滑窗
  var trueId = ID_A;                       // 430102199001011238
  var short = trueId.slice(0, 16);         // 4301021990010112（少了 1 位）
  var r = IdOcr.parse('公民身份号码 ' + short + '\n联系电话 13800138000');
  log('输入：' + short + ' + 电话 13800138000');
  log('真号码 = ' + trueId + '，解析结果 idNo = ' + r.idNo);
  var valid = r.idNo ? IdOcr.checksumValid(r.idNo) : false;
  log('解析结果是否通过校验位 = ' + valid + '（核对页的「抄错一位」警告就靠这个判断）');
  ok('4.1 漏字 + 混入电话号时结果要么 null 要么 ≠ 真号码（说明确实会错）',
    r.idNo === null || r.idNo !== trueId, String(r.idNo));
  ok('4.2 若给出了号码且校验位通过，核对页不会报警（记录风险）',
    r.idNo === null || (valid === true), 'idNo=' + r.idNo + ' valid=' + valid);
})();

(function () {
  // 只错最后一位：应当被修回来（这是设计的正确用法）
  var bad = ID_B.slice(0, 17) + (ID_B.charAt(17) === '9' ? '8' : '9');
  eq('4.3 只错校验位一位要被修回来', IdOcr.parse('号码 ' + bad).idNo, ID_B);
})();

/* ================= 5. checksumValid 的边界 ================= */

out.push('');
out.push('--- 5. checksumValid 边界 ---');
ok('5.1 空串 false', IdOcr.checksumValid('') === false);
ok('5.2 null false', IdOcr.checksumValid(null) === false);
ok('5.3 undefined false', IdOcr.checksumValid(undefined) === false);
ok('5.4 17 位 false', IdOcr.checksumValid('43010219900101123') === false);
ok('5.5 19 位 false', IdOcr.checksumValid(ID_A + '1') === false);
ok('5.6 小写 x 结尾 true', IdOcr.checksumValid('11010819600307091x') === true);
ok('5.7 大写 X 结尾 true', IdOcr.checksumValid('11010819600307091X') === true);
var t = safe(function () { return IdOcr.checksumValid(430102199001011238); });
ok('5.8 数字类型的 18 位【不崩】（当前会抛 TypeError，见下）', !t.e, t.e && (t.e.name + ': ' + t.e.message));
if (t.e) log('  ✗ checksumValid(430102199001011238) 抛异常：' + t.e.name + ': ' + t.e.message);
ok('5.9 带空格 false（调用方必须先去空格）', IdOcr.checksumValid('430102 199001011238') === false);

/* ================= 6. 性能 ================= */

out.push('');
out.push('--- 6. 性能（防止老人手机上卡死）---');
(function () {
  var t0 = Date.now();
  var r = IdOcr.parse(new Array(200001).join('8') + ID_A + new Array(200001).join('8'));
  var ms = Date.now() - t0;
  log('40 万字符单行里找号码：' + ms + 'ms，结果 idNo=' + r.idNo);
  ok('6.1 40 万字符 < 3000ms', ms < 3000, ms + 'ms');
  var t1 = Date.now();
  var r2 = IdOcr.parseAll([{ text: new Array(50001).join('姓名\n'), bonus: 0.2 }, { text: ID_A }]);
  var ms2 = Date.now() - t1;
  log('5 万行 + 一遍号码：' + ms2 + 'ms，结果 idNo=' + r2.idNo);
  ok('6.2 5 万行 < 3000ms', ms2 < 3000, ms2 + 'ms');
})();

/* ================= 输出 ================= */

console.log('=== review-fuzz.js ===');
console.log(out.join('\n'));
console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
console.log(fail ? '\n结果：FAILED' : '\n结果：ALL PASSED');
process.exit(fail ? 1 : 0);
