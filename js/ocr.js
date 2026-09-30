/* 身份证文字识别与解析（Tesseract.js 中文模型，全部本地运行） */
(function () {
  'use strict';

  // 18 位身份证：6 位地址码 + 出生日期 + 顺序码 + 校验码
  var ID_RE = /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx]/g;
  var WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var CHECK_CODES = '10X98765432';
  var NAME_BLACKLIST = ['姓名', '性别', '民族', '出生', '住址', '公民', '身份', '号码',
    '签发', '机关', '有效', '期限', '中华人民共和国', '居民身份证', '人像面', '国徽面', '男性', '女性'];

  function isHan(c) { return c >= '\u4e00' && c <= '\u9fa5'; }

  function checksumValid(id) {
    if (!/^\d{17}[0-9Xx]$/.test(id)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * WEIGHTS[i];
    return CHECK_CODES[sum % 11] === id[17].toUpperCase();
  }

  function normalizeLine(s) {
    var out = '';
    for (var i = 0; i < s.trim().length; i++) {
      var c = s[i], code = s.charCodeAt(i);
      if (code >= 0xFF10 && code <= 0xFF19) c = String.fromCharCode(48 + code - 0xFF10);
      else if (code === 0xFF58) c = 'x';
      else if (code === 0xFF38) c = 'X';
      out += c;
    }
    return out;
  }

  function findIdNo(lines) {
    function strip(s) { return s.replace(/[\s.·•\-—]/g, ''); }
    function fixed(s) {
      return strip(s).replace(/O/g, '0').replace(/o/g, '0').replace(/Ｏ/g, '0')
        .replace(/Ｉ/g, '1').replace(/ｌ/g, '1').replace(/l/g, '1').replace(/I/g, '1')
        .replace(/Ｚ/g, '2').replace(/Ｂ/g, '8');
    }
    var m, i, j;
    // 第一轮：原始文本 + 校验码
    for (i = 0; i < lines.length; i++) {
      ID_RE.lastIndex = 0;
      while ((m = ID_RE.exec(strip(lines[i])))) {
        if (checksumValid(m[0])) return m[0].toUpperCase();
      }
    }
    // 第二轮：常见 OCR 混淆修正 + 校验码
    for (i = 0; i < lines.length; i++) {
      ID_RE.lastIndex = 0;
      while ((m = ID_RE.exec(fixed(lines[i])))) {
        if (checksumValid(m[0])) return m[0].toUpperCase();
      }
    }
    // 第三轮：格式匹配兜底
    for (j = 0; j < lines.length; j++) {
      ID_RE.lastIndex = 0;
      m = ID_RE.exec(strip(lines[j]));
      if (m) return m[0].toUpperCase();
    }
    return null;
  }

  function findName(lines) {
    var i, line, idx, rest, k;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      idx = line.indexOf('姓名');
      if (idx >= 0) {
        rest = '';
        for (k = idx + 2; k < line.length; k++) if (isHan(line[k])) rest += line[k];
        if (rest.length >= 2 && rest.length <= 4) return rest;
      }
    }
    for (i = 0; i < lines.length; i++) {
      line = lines[i].replace(/\s+/g, ''); // OCR 常在汉字间插空格
      if (line.length >= 2 && line.length <= 4) {
        var allHan = true;
        for (k = 0; k < line.length; k++) if (!isHan(line[k])) { allHan = false; break; }
        if (!allHan) continue;
        var blacklisted = false;
        for (k = 0; k < NAME_BLACKLIST.length; k++) {
          if (line.indexOf(NAME_BLACKLIST[k]) >= 0) { blacklisted = true; break; }
        }
        if (!blacklisted) return line;
      }
    }
    return null;
  }

  function parse(rawText) {
    var lines = (rawText || '').split(/\r?\n/)
      .map(normalizeLine)
      .filter(function (l) { return l.trim().length > 0; });
    return { name: findName(lines), idNo: findIdNo(lines) };
  }

  /** 拍摄图预处理：限制长边 + 灰度 + 直方图拉伸对比度 */
  function preprocess(src, maxSide) {
    var longSide = Math.max(src.width, src.height);
    var scale = longSide > maxSide ? maxSide / longSide : 1;
    var w = Math.max(1, Math.round(src.width * scale));
    var h = Math.max(1, Math.round(src.height * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    try {
      var img = ctx.getImageData(0, 0, w, h);
      var d = img.data, hist = new Array(256).fill(0), i, v;
      for (i = 0; i < d.length; i += 4) {
        v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        hist[v]++;
      }
      // 2%~98% 分位拉伸
      var total = w * h, acc = 0, lo = 0, hi = 255;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
      acc = 0;
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.02) { hi = i; break; } }
      if (hi - lo > 40) {
        var range = hi - lo;
        for (i = 0; i < d.length; i += 4) {
          v = d[i];
          v = v <= lo ? 0 : v >= hi ? 255 : ((v - lo) * 255 / range) | 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* getImageData 失败时直接用原图 */ }
    return cv;
  }

  var workerReady = null;
  function getWorker(onProgress) {
    if (!workerReady) {
      // 必须传绝对 URL：tesseract 会把 worker 包成 blob，相对路径在 blob 内无法解析
      var abs = function (p) { return new URL(p, document.baseURI).href; };
      workerReady = Tesseract.createWorker('chi_sim', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract'),
        langPath: abs('vendor/tessdata'),
        gzip: true,
        logger: function (m) { if (onProgress) onProgress(m); }
      });
    }
    return workerReady;
  }

  /** 识别入口：bitmap 可以是 <img>/<canvas>/ImageBitmap */
  async function recognize(src, onProgress) {
    var canvas = preprocess(src, 1800);
    var worker = await getWorker(onProgress);
    var res = await worker.recognize(canvas);
    var text = (res && res.data && res.data.text) || '';
    try { window.__idOcrRaw = text; } catch (e) {}
    return parse(text);
  }

  window.IdOcr = {
    parse: parse,
    checksumValid: checksumValid,
    preprocess: preprocess,
    recognize: recognize,
    // 调试/测试钩子：直接对 dataURL 识别
    __recognizeDataUrl: async function (dataUrl) {
      var img = new Image();
      img.src = dataUrl;
      await img.decode();
      return recognize(img);
    }
  };
})();
