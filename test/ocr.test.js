/* 身份证解析单元测试（Node 里跑，不需要浏览器、不需要 Tesseract）
 *
 * 运行：
 *   "C:\Users\dell\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" test/ocr.test.js
 *
 * 说明：GB11643 校验算法在测试里**独立实现一遍**，不调用被测代码的 checkCode，
 * 否则测试和实现错在同一个地方也发现不了。
 */
'use strict';

var path = require('path');

/* ---------- 1. 最小化浏览器环境垫片 ---------- */
global.window = global;
global.document = {
  baseURI: 'http://localhost/',
  createElement: function () {
    throw new Error('解析测试不应该创建 DOM 元素');
  }
};
global.Tesseract = {
  createWorker: function () {
    throw new Error('解析测试不应该启动 Tesseract');
  }
};

require(path.join(__dirname, '..', 'js', 'ocr.js'));
var IdOcr = global.window.IdOcr;

/* ---------- 2. 独立实现 GB11643 ---------- */
var W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
var C = '10X98765432';
function refCheck(id17) {
  var s = 0;
  for (var i = 0; i < 17; i++) s += (id17.charCodeAt(i) - 48) * W[i];
  return C.charAt(s % 11);
}
function makeId(id17) { return id17 + refCheck(id17); }

// 真实可用的号码（用上面的独立算法现算出来的）
var ID_A = makeId('43010219900101123');
var ID_B = makeId('43052419851212008');
var ID_C = makeId('11010819600307091');

/* ---------- 3. 迷你断言器 ---------- */
var pass = 0, fail = 0, lines = [];
function ok(name, cond, extra) {
  if (cond) { pass++; lines.push('  [PASS] ' + name); }
  else { fail++; lines.push('  [FAIL] ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function fullWidth(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) + 0xFEE0);
  return out;
}

console.log('=== 测试数据（校验位由测试内独立算法算出）===');
console.log('  ID_A = ' + ID_A + '  (17位基数 43010219900101123, 校验位 ' + refCheck('43010219900101123') + ')');
console.log('  ID_B = ' + ID_B + '  (17位基数 43052419851212008, 校验位 ' + refCheck('43052419851212008') + ')');
console.log('  ID_C = ' + ID_C + '  (17位基数 11010819600307091, 校验位 ' + refCheck('11010819600307091') + ')');

/* ---------- 4. 用例 ---------- */

// 1. 干净的身份证号（校验位有效）
(function () {
  var r = IdOcr.parse('中华人民共和国居民身份证\n姓名 张三\n公民身份号码 ' + ID_A);
  eq('1. 干净号码：认出身份证号', r.idNo, ID_A);
  eq('1. 干净号码：同时认出姓名', r.name, '张三');
})();

// 2. 号码被 OCR 拆成两行
(function () {
  var half1 = ID_A.slice(0, 12), half2 = ID_A.slice(12);
  var r = IdOcr.parse('公民身份号码\n' + half1 + '\n' + half2);
  eq('2. 拆成两行的号码要能拼回来', r.idNo, ID_A);
})();

// 3. O / I / l 混淆必须被修好
(function () {
  var messy = ID_A.replace(/0/g, 'O').replace(/1/g, 'l');
  var r = IdOcr.parse('证件号码 ' + messy);
  eq('3. O/I/l 混淆修正（' + messy + '）', r.idNo, ID_A);

  var messy2 = ID_A.replace(/0/g, 'O').replace(/1/g, 'I');
  eq('3b. O/I 混淆修正（' + messy2 + '）', IdOcr.parse(messy2).idNo, ID_A);
})();

// 4. 校验位错的号码要被淘汰，选校验位对的
(function () {
  var badChar = ID_A.charAt(17) === '9' ? '8' : '9';
  var bad = ID_A.slice(0, 17) + badChar;
  ok('4. 先确认构造出来的坏号码确实校验不过', !IdOcr.checksumValid(bad));
  var r = IdOcr.parse('姓名李四 号码 ' + bad + ' 另一个 ' + ID_B);
  eq('4. 坏号码在后面有好号码时被淘汰', r.idNo, ID_B);
})();

// 5. 全角数字
(function () {
  var r = IdOcr.parse('公民身份号码 ' + fullWidth(ID_B));
  eq('5. 全角数字要能认出来', r.idNo, ID_B);
})();

// 6. 姓名和「姓名」同行
(function () {
  eq('6. 姓名与标签同一行', IdOcr.parse('姓名 王五\n性别 男').name, '王五');
  eq('6b. 标签粘连（姓名王五性别男）', IdOcr.parse('姓名王五性别男').name, '王五');
})();

// 7. 姓名在「姓名」下一行
(function () {
  eq('7. 姓名在标签下一行', IdOcr.parse('姓名\n赵六\n性别 女').name, '赵六');
})();

// 8. 汉字之间被 OCR 插了空格
(function () {
  eq('8. 汉字中间有空格', IdOcr.parse('姓 名\n张 三').name, '张三');
  eq('8b. 汉字中间多个空格', IdOcr.parse('姓名\n王  五  ').name, '王五');
})();

// 9. 黑名单行不能被当成姓名
(function () {
  var txt = '中华人民共和国\n居民身份证\n性别 男\n民族 汉\n出生 1950年1月1日\n住址 湖南省长沙市望城区\n公民身份号码 ' + ID_C;
  var r = IdOcr.parse(txt);
  eq('9. 黑名单/地址行不能当姓名', r.name, null);
  eq('9b. 但号码还是要认出来', r.idNo, ID_C);
  eq('9c. 只有「性别/民族」时也不能猜出姓名', IdOcr.parse('性别 男\n民族 汉').name, null);
})();

// 10. parseAll 跨遍合并：A 遍有姓名、B 遍有号码
(function () {
  var r = IdOcr.parseAll([
    { text: '姓名 孙七\n住址 湖南省', bonus: 0.3 },
    { text: '公民身份号码 ' + ID_B, bonus: 0.15 }
  ]);
  eq('10. parseAll 合并姓名', r.name, '孙七');
  eq('10b. parseAll 合并号码', r.idNo, ID_B);
  ok('10c. parseAll 返回的对象就两个字段',
    Object.keys(r).sort().join(',') === 'idNo,name', Object.keys(r).join(','));
})();

// 10d. parseAll 也接受纯字符串数组
(function () {
  var r = IdOcr.parseAll(['啥也没有', '姓名 周八', '号码 ' + ID_A]);
  eq('10d. parseAll 传字符串数组', r.name + '/' + r.idNo, '周八/' + ID_A);
})();

// 11. checksumValid 真 / 假
(function () {
  ok('11. checksumValid 对真号码返回 true', IdOcr.checksumValid(ID_A) === true);
  var badChar = ID_A.charAt(17) === '9' ? '8' : '9';
  ok('11b. checksumValid 改一位后返回 false', IdOcr.checksumValid(ID_A.slice(0, 17) + badChar) === false);
  ok('11c. checksumValid 长度不对返回 false', IdOcr.checksumValid('43010219900101') === false);
  var xBase = null;
  for (var n2 = 0; n2 < 200 && !xBase; n2++) {
    var c2 = '43010219900101' + ('000' + n2).slice(-3);
    if (refCheck(c2) === 'X') xBase = c2;
  }
  ok('11d. checksumValid 小写 x 结尾照样算',
    IdOcr.checksumValid(xBase + 'x') === true && IdOcr.checksumValid(xBase + 'X') === true,
    'xBase=' + xBase);
})();

// 12. normalizeLine 全角 → 半角
(function () {
  eq('12. 全角数字转半角', IdOcr.normalizeLine('１２３４５６７８９０'), '1234567890');
  eq('12b. 全角字母转半角', IdOcr.normalizeLine('ＸｘＡＢ'), 'XxAB');
  eq('12c. 全角空格转半角', IdOcr.normalizeLine('张\u3000三'), '张 三');
  eq('12d. 全角符号转半角', IdOcr.normalizeLine('（２０２４）'), '(2024)');
})();

// 13. 校验位恰好是 X 的号码
(function () {
  var base = null;
  for (var n = 0; n < 200; n++) {
    var cand = '43010219900101' + ('000' + n).slice(-3);
    if (refCheck(cand) === 'X') { base = cand; break; }
  }
  ok('13. 测试数据里找到了校验位为 X 的号码', !!base, 'base=' + base);
  if (base) {
    var id = base + 'X';
    eq('13b. 校验位 X 的号码', IdOcr.parse('号码 ' + id).idNo, id);
    ok('13c. 小写 x 版本也能识别', IdOcr.parse('号码 ' + base + 'x').idNo === id);
  }
})();

// 14. 只错校验位一位 → 用滑窗把校验位修回来
(function () {
  var badChar = ID_C.charAt(17) === '9' ? '8' : '9';
  var bad = ID_C.slice(0, 17) + badChar;
  var r = IdOcr.parse('公民身份号码 ' + bad);
  eq('14. 只错校验位时自动修正', r.idNo, ID_C);
})();

// 15. 证件框几何：白框在图上按 0.88 宽 / 0.18 高处，裁切要包含它
(function () {
  var w = 1000, h = 1200;
  var rect = IdOcr.cardRect(w, h, 0.08);
  var cw = w * 0.88, ch = cw * 54 / 85.6, x = (w - cw) / 2, y = h * 0.18;
  ok('15. 裁切区域包住整个白框',
    rect.x <= x && rect.y <= y && rect.x + rect.w >= x + cw && rect.y + rect.h >= y + ch,
    JSON.stringify(rect));
  ok('15b. 裁切区域没超出图片',
    rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= w && rect.y + rect.h <= h,
    JSON.stringify(rect));
  var name = IdOcr.subRect(rect, 0, 0.20, 0.58, 0.60);
  ok('15c. 姓名区在证件框左上',
    name.x >= rect.x && name.y >= rect.y && name.x + name.w <= rect.x + rect.w,
    JSON.stringify(name));
  var idr = IdOcr.subRect(rect, 0, 0.58, 1, 1);
  ok('15d. 号码区在证件框下方', idr.y > rect.y + rect.h * 0.5, JSON.stringify(idr));
})();

// 16. 空输入不能崩
(function () {
  var r = IdOcr.parse('');
  ok('16. 空字符串返回空结果', r.name === null && r.idNo === null);
  eq('16b. undefined 也不崩', IdOcr.parseAll(undefined).idNo, null);
  eq('16c. parseAll(null)', IdOcr.parseAll(null).name, null);
})();

/* ---------- 5. 输出 ---------- */
console.log('\n=== 用例结果 ===');
console.log(lines.join('\n'));
console.log('\n合计：' + (pass + fail) + ' 条断言，通过 ' + pass + '，失败 ' + fail);
if (fail > 0) {
  console.log('\n结果：FAILED');
  process.exit(1);
} else {
  console.log('结果：ALL PASSED');
}
