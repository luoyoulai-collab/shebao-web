/* 身份证文字识别与解析（Tesseract.js 5.x 中文模型，全部在手机本机运行，照片不联网上传）
 *
 * 设计要点：
 *  1. 多次识别（整页 / 证件框 / 姓名区 / 号码区）后合并结果，单次识别的错字不再致命；
 *  2. 号码区用 tessedit_char_whitelist=0123456789Xx + 单行模式，避免中文模型乱认数字；
 *  3. 号码提取优先取「GB11643 校验位通过」的候选，其次才是结构匹配兜底；
 *  4. 姓名提取优先取紧挨着「姓名」标签的那一行，其次是证件框内孤立的 2~4 个汉字。
 */
(function () {
  'use strict';

  /* ==================== 常量 ==================== */

  // 与 app.js 的 drawFrameOverlay() 保持一致：框宽 = 画面宽 * 0.88，框顶 = 画面高 * 0.18
  var CARD_RATIO = 0.88;
  var CARD_Y = 0.18;
  var CARD_W_MM = 85.6;
  var CARD_H_MM = 54;
  var CARD_MARGIN = 0.08;      // 裁切证件时四周多留 8%，容忍没对准

  var WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var CHECK_CODES = '10X98765432';

  // 18 位身份证：6 位地址码 + 出生日期 + 3 位顺序码 + 1 位校验码
  var ID_STRUCT = '[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[0-9X]';
  var ID_STRUCT_17 = '[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}';

  // 「姓名」标签右边截断用的词（OCR 常把「姓名 张三 性别 男」连成一行）
  var CUT_LABELS = ['性别', '民族', '出生', '住址', '公民身份号码', '公民', '身份', '号码',
    '签发机关', '签发', '机关', '有效期限', '有效', '期限', '中华人民共和国', '居民身份证',
    '人像面', '国徽面', '男', '女'];

  // 明显不是姓名的词
  var REJECT_WORDS = ['姓名', '性别', '民族', '出生', '住址', '公民', '身份', '号码',
    '签发', '机关', '有效', '期限', '长期', '居民身份证', '中华人民共和国', '人像面', '国徽面',
    '派出所', '公安局', '分局', '村委会', '居委会', '街道', '社区', '单元', '日期', '年月',
    '地址', '有效期'];
  // 明显不是姓名的单字（地址/标签用字）
  var REJECT_CHARS = '省市县区镇村路街号期证址族别男女签';

  /* ==================== 基础工具 ==================== */

  function isHan(c) { return c >= '\u4e00' && c <= '\u9fa5'; }

  function allHan(s) {
    if (!s) return false;
    for (var i = 0; i < s.length; i++) if (!isHan(s.charAt(i))) return false;
    return true;
  }

  function hanRun(s, start) {
    var out = '';
    for (var i = start; i < s.length; i++) {
      if (!isHan(s.charAt(i))) break;
      out += s.charAt(i);
    }
    return out;
  }

  /** 全角 → 半角，并统一常见的叉号写法 */
  function normalizeLine(s) {
    if (s === null || s === undefined) return '';
    var str = String(s), out = '';
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i), c = str.charAt(i);
      if (code === 0x3000) c = ' ';                                   // 全角空格
      else if (code >= 0xFF01 && code <= 0xFF5E) c = String.fromCharCode(code - 0xFEE0);
      else if (c === '\u00D7' || c === '\u2715' || c === '\u2573' || c === '\u3007') c = 'x';
      out += c;
    }
    return out;
  }

  /** 专给身份证号用的混淆字符修正（O→0、I/l/|→1、Z→2、B→8、S→5、G→6、〇→0） */
  function fixConfusables(s) {
    return normalizeLine(s)
      .replace(/[Oo\uFF4F\u3007\u25CB]/g, '0')
      .replace(/[Il|\uFF5C\uFF49\u2160]/g, '1')
      .replace(/[Zz]/g, '2')
      .replace(/[Bb]/g, '8')
      .replace(/[Ss]/g, '5')
      .replace(/[Gg]/g, '6')
      .replace(/[Qq]/g, '0');
  }

  function stripSep(s) { return String(s).replace(/[\s.\u00B7\u2022\u30FB\-\u2014_\uFF0D]/g, ''); }

  /* ==================== 身份证号 ==================== */

  function checksumValid(id) {
    if (!id || !/^\d{17}[0-9Xx]$/.test(id)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += (id.charCodeAt(i) - 48) * WEIGHTS[i];
    return CHECK_CODES.charAt(sum % 11) === id.charAt(17).toUpperCase();
  }

  /** 按 GB11643 算出正确的校验位（用于修正只错最后一位的情况） */
  function checkCode(id17) {
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += (id17.charCodeAt(i) - 48) * WEIGHTS[i];
    return CHECK_CODES.charAt(sum % 11);
  }

  function reValid() { return new RegExp(ID_STRUCT, 'g'); }
  function reAny() { return new RegExp(ID_STRUCT, 'g'); }
  function reStruct() { return new RegExp('^' + ID_STRUCT + '$'); }
  function reStruct17() { return new RegExp('^' + ID_STRUCT_17 + '$'); }

  /** 在一段文本里找校验通过的号码；找不到返回 null */
  function scanValid(str) {
    var re = reValid(), m;
    while ((m = re.exec(str))) {
      if (checksumValid(m[0])) return m[0].toUpperCase();
    }
    return null;
  }

  /** 在一段文本里找第一个结构像身份证的号码（不校验） */
  function scanAny(str) {
    var m = reAny().exec(str);
    return m ? m[0].toUpperCase() : null;
  }

  /** 只保留数字和 X，用于滑窗 */
  function digitStream(s) {
    var t = fixConfusables(s), out = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c >= '0' && c <= '9') out += c;
      else if (c === 'x' || c === 'X') out += 'X';
    }
    return out;
  }

  /** 在数字流上滑 18 位窗口，返回校验通过的号码 */
  function slideWindow(stream) {
    if (!stream || stream.length < 18) return null;
    var re = reStruct();
    for (var i = 0; i + 18 <= stream.length; i++) {
      var w = stream.substr(i, 18);
      if (!re.test(w)) continue;
      if (checksumValid(w)) return w;
    }
    return null;
  }

  /** 滑窗 + 修正只错校验位的情况（OCR 经常把最后一位认错） */
  function slideWindowRepair(stream) {
    if (!stream || stream.length < 18) return null;
    var re = reStruct17();
    for (var i = 0; i + 18 <= stream.length; i++) {
      var w17 = stream.substr(i, 17);
      var last = stream.charAt(i + 17);
      if (last !== 'X' && !(last >= '0' && last <= '9')) continue;
      if (!re.test(w17)) continue;
      return (w17 + checkCode(w17)).toUpperCase();
    }
    return null;
  }

  /**
   * 号码提取。rank 含义：1 = 校验位通过（最可信），0.5 = 滑窗后修正了校验位，0 = 仅结构匹配。
   */
  function findIdRanked(lines) {
    var i, k;
    var pool = [];
    var joined = '', joinedDash = '';
    for (i = 0; i < lines.length; i++) {
      var s = stripSep(lines[i]);
      pool.push(s);
      joined += s;
      if (i) joinedDash += '-';
      joinedDash += s;
    }
    pool.push(joined);
    pool.push(joinedDash);

    // ① 原文里直接找校验通过的
    for (i = 0; i < pool.length; i++) {
      var v = scanValid(pool[i]);
      if (v) return { id: v, rank: 1 };
    }

    // ② 混淆字符修正后再找
    var pool2 = [];
    for (i = 0; i < pool.length; i++) pool2.push(fixConfusables(pool[i]));
    for (i = 0; i < pool2.length; i++) {
      var v2 = scanValid(pool2[i]);
      if (v2) return { id: v2, rank: 1 };
    }

    // ③ 相邻 1~3 行拼成数字流后滑窗（处理号码被 OCR 拆成两行）
    var streams = [];
    for (i = 0; i < lines.length; i++) {
      var buf = '';
      for (k = 0; k < 3 && i + k < lines.length; k++) {
        buf += digitStream(lines[i + k]);
        if (buf.length >= 18) streams.push(buf);
      }
    }
    for (i = 0; i < streams.length; i++) {
      var w = slideWindow(streams[i]);
      if (w) return { id: w, rank: 1 };
    }

    // ④ 滑窗并修正校验位
    for (i = 0; i < streams.length; i++) {
      var r = slideWindowRepair(streams[i]);
      if (r) return { id: r, rank: 0.5 };
    }

    // ⑤ 结构匹配兜底（校验位不对也先给用户看，让他在核对页手动改）
    for (i = 0; i < pool2.length; i++) {
      var v3 = scanAny(pool2[i]);
      if (v3) return { id: v3, rank: 0 };
    }
    return null;
  }

  /* ==================== 姓名 ==================== */

  /**
   * 判断一个候选串是不是姓名。
   * strict=true 时连「省市区路号」这类地址用字也一并否掉——只有兜底猜测才需要这么严；
   * 紧挨着「姓名」标签拿到的候选不能用严标准，否则「路」「区」这种真姓氏会被误杀。
   */
  function isRejected(s, strict) {
    if (!s) return true;
    if (s.length < 2 || s.length > 4) return true;
    if (!allHan(s)) return true;
    var i;
    for (i = 0; i < REJECT_WORDS.length; i++) if (s.indexOf(REJECT_WORDS[i]) >= 0) return true;
    if (strict) {
      for (i = 0; i < s.length; i++) if (REJECT_CHARS.indexOf(s.charAt(i)) >= 0) return true;
    }
    return false;
  }

  /** 把「张三性别男」这样的粘连串在标签处截断 */
  function cutAtLabel(run) {
    var cut = run.length;
    for (var i = 0; i < CUT_LABELS.length; i++) {
      var p = run.indexOf(CUT_LABELS[i]);
      if (p >= 0 && p < cut) cut = p;
    }
    return run.slice(0, cut);
  }

  /**
   * 姓名提取。rank：3 = 与「姓名」同行；2 = 在「姓名」下一行；1 = 兜底的纯汉字行。
   */
  function findNameRanked(lines) {
    var i, k, s, flat = [];
    for (i = 0; i < lines.length; i++) flat.push(String(lines[i]).replace(/[\s\u3000]+/g, ''));

    // ① 「姓名」后面直接跟 2~4 个汉字
    for (i = 0; i < flat.length; i++) {
      var idx = flat[i].indexOf('姓名');
      if (idx < 0) continue;
      var cand = cutAtLabel(hanRun(flat[i], idx + 2));
      if (!isRejected(cand, false)) return { name: cand, rank: 3 };
    }
    // ② 「姓名」的下一行是 2~4 个汉字
    for (i = 0; i < flat.length; i++) {
      if (flat[i].indexOf('姓名') < 0) continue;
      for (k = i + 1; k <= i + 2 && k < flat.length; k++) {
        s = flat[k];
        if (s.indexOf('姓名') >= 0) continue;
        if (!isRejected(s, false)) return { name: s, rank: 2 };
      }
    }
    // ③ 兜底：任意 2~4 个纯汉字且不在黑名单里的行
    for (i = 0; i < flat.length; i++) {
      if (!isRejected(flat[i], true)) return { name: flat[i], rank: 1 };
    }
    return null;
  }

  /* ==================== 单遍 / 多遍解析 ==================== */

  function analyze(rawText, bonus) {
    bonus = bonus || 0;
    var text = normalizeLine(rawText === null || rawText === undefined ? '' : String(rawText));
    var lines = text.split(/\r?\n/).filter(function (l) { return stripSep(l).length > 0; });
    var n = findNameRanked(lines);
    var d = findIdRanked(lines);
    return {
      name: n ? n.name : null,
      nameRank: n ? n.rank + bonus : -1,
      idNo: d ? d.id : null,
      idRank: d ? d.rank + bonus : -1
    };
  }

  /**
   * 合并多遍识别结果。
   * texts 可以是字符串数组，也可以是 {text, bonus} 数组（bonus 表示这一遍的可信度加成，<0.5）。
   * 号码：校验位通过的必定胜过没通过的；姓名：挨着「姓名」标签的必定胜过兜底猜的。
   */
  function parseAll(texts) {
    var list;
    if (texts === null || texts === undefined) list = [];
    else if (typeof texts === 'string') list = [texts];
    else list = texts;

    var bestName = null, bestNameRank = -1;
    var bestId = null, bestIdRank = -1;
    for (var i = 0; i < list.length; i++) {
      var item = list[i], txt, bonus = 0;
      if (item && typeof item === 'object') {
        txt = item.text;
        bonus = typeof item.bonus === 'number' ? item.bonus : 0;
      } else {
        txt = item;
      }
      var a = analyze(txt, bonus);
      if (a.name && a.nameRank > bestNameRank) { bestName = a.name; bestNameRank = a.nameRank; }
      if (a.idNo && a.idRank > bestIdRank) { bestId = a.idNo; bestIdRank = a.idRank; }
    }
    return { name: bestName, idNo: bestId };
  }

  function parse(rawText) { return parseAll([rawText]); }

  /* ==================== 图像处理 ==================== */

  /**
   * 证件框在图片里的位置（纯几何计算，和 app.js 画的白框公式一模一样）。
   * 拍摄时已经按取景框裁过，所以这里直接按比例算就对准了。
   */
  function cardRect(w, h, margin) {
    var cw = w * CARD_RATIO;
    var ch = cw * CARD_H_MM / CARD_W_MM;
    var x = (w - cw) / 2;
    var y = h * CARD_Y;
    if (ch > h) { ch = h; y = 0; } else if (y + ch > h) { y = h - ch; }
    var m = (margin === null || margin === undefined) ? CARD_MARGIN : margin;
    var dx = cw * m, dy = ch * m;
    var rx = Math.max(0, x - dx), ry = Math.max(0, y - dy);
    var rw = Math.min(w, x + cw + dx) - rx, rh = Math.min(h, y + ch + dy) - ry;
    return { x: Math.round(rx), y: Math.round(ry), w: Math.round(rw), h: Math.round(rh) };
  }

  /** 在 card 内按比例取子区域，fx/fy 都是 0~1 */
  function subRect(card, fx0, fy0, fx1, fy1) {
    var x = card.x + card.w * fx0, y = card.y + card.h * fy0;
    var w = card.w * (fx1 - fx0), h = card.h * (fy1 - fy0);
    return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  function clampRect(rect, w, h) {
    var x = Math.max(0, Math.min(w - 1, Math.round(rect.x || 0)));
    var y = Math.max(0, Math.min(h - 1, Math.round(rect.y || 0)));
    var rw = Math.max(1, Math.min(w - x, Math.round(rect.w || 1)));
    var rh = Math.max(1, Math.min(h - y, Math.round(rect.h || 1)));
    return { x: x, y: y, w: rw, h: rh };
  }

  function makeCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  /** 拍到的画面裁一块出来，太小的顺手放大，Tesseract 认小字更准 */
  function cropCanvas(src, rect) {
    var r = clampRect(rect, src.width, src.height);
    var cv = makeCanvas(r.w, r.h);
    cv.getContext('2d', { willReadFrequently: true })
      .drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    if (r.w < 900) {
      var f = Math.min(3, 900 / r.w);
      if (f > 1.01) {
        var big = makeCanvas(Math.round(r.w * f), Math.round(r.h * f));
        var bctx = big.getContext('2d');
        bctx.imageSmoothingEnabled = true;
        bctx.drawImage(cv, 0, 0, big.width, big.height);
        return big;
      }
    }
    return cv;
  }

  /** 灰度 + 2%/98% 分位对比度拉伸 */
  function preprocess(src, maxSide) {
    maxSide = maxSide || 1800;
    var longSide = Math.max(src.width, src.height);
    var scale = longSide > maxSide ? maxSide / longSide : 1;
    var w = Math.max(1, Math.round(src.width * scale));
    var h = Math.max(1, Math.round(src.height * scale));
    var cv = makeCanvas(w, h);
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    try {
      var img = ctx.getImageData(0, 0, w, h);
      var d = img.data, hist = new Array(256), i, v;
      for (i = 0; i < 256; i++) hist[i] = 0;
      for (i = 0; i < d.length; i += 4) {
        v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
        if (v < 0) v = 0; else if (v > 255) v = 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        hist[v]++;
      }
      // 分别从两端累计，取 2% 和 98% 分位点（两次都用各自的累计量，不能复用同一个 acc）
      var total = w * h;
      var lo = percentile(hist, total, 0.02, false);
      var hi = percentile(hist, total, 0.02, true);
      if (hi > lo && hi - lo > 40) {
        var range = hi - lo;
        for (i = 0; i < d.length; i += 4) {
          v = d[i];
          v = v <= lo ? 0 : v >= hi ? 255 : ((v - lo) * 255 / range) | 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* getImageData 失败（画布被污染等）时直接用原图 */ }
    return cv;
  }

  /** tail=true 表示从 255 往 0 累计（即高分位点） */
  function percentile(hist, total, frac, tail) {
    var need = total * frac, acc = 0, i;
    if (tail) {
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= need) return i; }
      return 255;
    }
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= need) return i; }
    return 0;
  }

  /* ==================== Tesseract ==================== */

  var workerReady = null;
  var progressCb = null;
  var currentPass = { pass: 0, passes: 1, label: '' };

  function emitProgress(m) {
    if (!progressCb || !m) return;
    var msg = { status: m.status, progress: m.progress, pass: currentPass.pass, passes: currentPass.passes, label: currentPass.label };
    try { progressCb(msg); } catch (e) {}
  }

  function getWorker() {
    if (!workerReady) {
      // 必须传绝对 URL：tesseract 会把 worker 包成 blob，相对路径在 blob 内无法解析
      var abs = function (p) { return new URL(p, document.baseURI).href; };
      workerReady = Tesseract.createWorker('chi_sim', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract'),
        langPath: abs('vendor/tessdata'),
        gzip: true,
        logger: emitProgress
      });
    }
    return workerReady;
  }

  /** 单遍识别：先设参数（设不上也不影响流程），再 recognize */
  async function recognizeOnce(worker, canvas, psm, whitelist) {
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: whitelist || ''
      });
    } catch (e) { /* 老版本 / 不支持的参数：忽略，继续识别 */ }
    var res = await worker.recognize(canvas);
    return (res && res.data && res.data.text) || '';
  }

  // 每一遍的加成：都小于 0.5，保证「校验位通过」永远压过「没通过」
  var PASSES = [
    { key: 'full', label: '整页', psm: 6, wl: '', bonus: 0 },
    { key: 'card', label: '证件框', psm: 6, wl: '', bonus: 0.1 },
    { key: 'name', label: '姓名区', psm: 6, wl: '', bonus: 0.3 },
    { key: 'idno', label: '号码区', psm: 7, wl: '0123456789Xx', bonus: 0.15 }
  ];

  /**
   * 识别入口：src 可以是 <img>/<canvas>/ImageBitmap。
   * geom 可选，{rect:{x,y,w,h}} 表示证件框在原图里的像素位置；不传就按取景框比例算。
   */
  async function recognize(src, onProgress, geom) {
    var full = preprocess(src, 1800);
    var card = (geom && geom.rect) ? clampRect(geom.rect, full.width, full.height)
      : cardRect(full.width, full.height, CARD_MARGIN);

    var canvases = {
      full: full,
      card: cropCanvas(full, card),
      name: cropCanvas(full, subRect(card, 0, 0.20, 0.58, 0.60)),   // 姓名在左上
      idno: cropCanvas(full, subRect(card, 0, 0.58, 1, 1))          // 公民身份号码在最下面一条
    };

    progressCb = onProgress || null;
    var worker = await getWorker();

    var results = [];
    for (var i = 0; i < PASSES.length; i++) {
      var p = PASSES[i];
      currentPass = { pass: i, passes: PASSES.length, label: p.label };
      try {
        var txt = await recognizeOnce(worker, canvases[p.key], p.psm, p.wl);
        results.push({ text: txt, bonus: p.bonus });
      } catch (e) {
        results.push({ text: '', bonus: p.bonus });
      }
    }
    // 号码区那一遍通常最干净，放在最后再看一遍它的原始文本便于排查
    try {
      window.__idOcrRaw = results.map(function (r, i) {
        return '===== ' + PASSES[i].label + ' =====\n' + r.text;
      }).join('\n');
    } catch (e) {}

    return parseAll(results);
  }

  window.IdOcr = {
    parse: parse,
    parseAll: parseAll,
    analyze: analyze,
    checksumValid: checksumValid,
    checkCode: checkCode,
    normalizeLine: normalizeLine,
    fixConfusables: fixConfusables,
    isHan: isHan,
    cardRect: cardRect,
    subRect: subRect,
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
