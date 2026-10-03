/* 一键社保认证 · 页面逻辑
 *
 * 设计原则（给自己看，也给下一个人看）：
 *  - 老人一次只能看见一件事：当前这一步的字最大，别的都让开；
 *  - 绝不让人在浏览器和微信之间瞎找：底部永远有一个绿色【打开微信】大按钮；
 *  - 能自动复制的就自动复制，绝不谎报"已经复制好了"；
 *  - 语音在 iOS 上要先用一次用户手势"解锁"，否则第一次不出声。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    name: '', idNo: '', phone: '',
    coaching: false, step: 0,
    settings: { mini: '湖南智慧人社', func: '待遇资格认证', voice: true }
  };

  /* ==================== 存档 ==================== */

  function load() {
    try {
      state.name = localStorage.getItem('sb_name') || '';
      state.idNo = localStorage.getItem('sb_id') || '';
      state.phone = localStorage.getItem('sb_phone') || '';
      state.coaching = localStorage.getItem('sb_coaching') === '1';
      state.step = parseInt(localStorage.getItem('sb_step') || '0', 10) || 0;
      var raw = localStorage.getItem('sb_settings');
      if (raw) {
        var s = JSON.parse(raw);
        // 逐项合并：老版本存的设置可能缺 voice 字段，整块覆盖会把语音开关弄丢
        if (s && typeof s === 'object') {
          if (typeof s.mini === 'string' && s.mini) state.settings.mini = s.mini;
          if (typeof s.func === 'string' && s.func) state.settings.func = s.func;
          if (typeof s.voice === 'boolean') state.settings.voice = s.voice;
        }
      }
    } catch (e) {}
    if (state.step < 0) state.step = 0;
  }
  function savePerson() {
    try {
      localStorage.setItem('sb_name', state.name);
      localStorage.setItem('sb_id', state.idNo);
      localStorage.setItem('sb_phone', state.phone);
      localStorage.setItem('sb_coaching', state.coaching ? '1' : '0');
      localStorage.setItem('sb_step', String(state.step));
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem('sb_settings', JSON.stringify(state.settings)); } catch (e) {}
  }

  /* ==================== 屏幕路由 ==================== */

  var screens = ['home', 'camera', 'reading', 'confirm', 'coach', 'done', 'settings', 'help'];
  function show(name) {
    screens.forEach(function (s) {
      var el = $('scr-' + s);
      if (el) el.hidden = (s !== name);
    });
    $('wxHelp').hidden = true;
    window.scrollTo(0, 0);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ==================== 语音 ==================== */

  var speechOK = typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';
  var zhVoice = null;
  var speechWarmed = false;

  function pickVoice() {
    if (!speechOK) return;
    try {
      var vs = speechSynthesis.getVoices() || [];
      for (var i = 0; i < vs.length; i++) {
        var lang = vs[i].lang || '';
        if (/^zh[-_]CN/i.test(lang) || /^zh[-_]Hans/i.test(lang)) { zhVoice = vs[i]; return; }
      }
      // 没有 zh-CN 就退而求其次找任何中文声音
      for (var j = 0; j < vs.length; j++) {
        if (/^zh/i.test(vs[j].lang || '')) { zhVoice = vs[j]; return; }
      }
    } catch (e) {}
  }

  if (speechOK) {
    pickVoice();
    // iOS/安卓上声音列表是异步加载的，必须监听 voiceschanged 再挑一次
    try { speechSynthesis.onvoiceschanged = pickVoice; } catch (e) {}
    try { speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) {}
  }

  /** iOS 必须先有一次用户手势才肯出声，用一段空的朗读把语音"解锁" */
  function warmUpSpeech() {
    if (!speechOK || speechWarmed) return;
    speechWarmed = true;
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.lang = 'zh-CN';
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  function speak(text) {
    if (!speechOK || !state.settings.voice || !text) return;
    try {
      warmUpSpeech();
      if (!zhVoice) pickVoice();
      var u = new SpeechSynthesisUtterance(String(text));
      u.lang = 'zh-CN';
      u.rate = 0.8;   // 老人听，慢一点
      u.pitch = 1;
      if (zhVoice) u.voice = zhVoice;
      // iOS 上"刚 cancel 就 speak"会把这句话吞掉，所以只有正在说话时才 cancel，并延后一点再念
      var busy = false;
      try { busy = speechSynthesis.speaking || speechSynthesis.pending; } catch (e) {}
      if (busy) {
        try { speechSynthesis.cancel(); } catch (e) {}
        setTimeout(function () { try { speechSynthesis.speak(u); } catch (e) {} }, 140);
      } else {
        speechSynthesis.speak(u);
      }
    } catch (e) {}
  }

  /* ==================== 提示条 ==================== */

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2800);
  }

  /* ==================== 复制 ==================== */

  function copyText(text, done) {
    var value = String(text == null ? '' : text);
    if (!value) { done(false); return; }
    function fallback() {
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        try { ta.setSelectionRange(0, value.length); } catch (e) {}
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { done(true); }, fallback);
    } else fallback();
  }

  /** auto=true 表示是"进这一步时自动复制"，这时不抢语音，只更新提示文字 */
  function doCopy(text, what, auto) {
    copyText(text, function (ok) {
      var note = $('copyNote');
      if (ok) {
        if (note) {
          note.hidden = false;
          note.textContent = '已经帮您复制好了（' + (what || '内容') + '）。到微信里长按方框，点「粘贴」。';
        }
        if (!auto) {
          toast('已复制 ✓ 到微信里长按方框，点「粘贴」', 3200);
          speak('已经复制好了。到微信里长按方框，点粘贴。');
        }
      } else if (auto) {
        if (note) {
          note.hidden = false;
          note.textContent = '请点上面黄色的【复制】按钮，再长按方框点「粘贴」。';
        }
      } else {
        toast('复制失败，请长按上面的文字自己选复制', 3800);
      }
    });
  }

  /* ==================== 屏幕常亮（尽力而为） ==================== */

  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    try {
      navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
    } catch (e) {}
  }

  /* ==================== 首页 ==================== */

  function initHome() {
    if (/MicroMessenger/i.test(navigator.userAgent)) $('wxBanner').hidden = false;
    refreshLast();
    $('btnShoot').onclick = function () {
      warmUpSpeech();
      speak('把身份证放进白框里，点下面的大圆钮拍照');
      openCamera();
    };
    $('btnLast').onclick = function () {
      // 用已经读进来的 state，别再读一次 localStorage（两处会不一致）
      if (!state.name || !state.idNo) { toast('上次的信息不完整，请重新拍'); return; }
      warmUpSpeech();
      toConfirm(false);
    };
    $('btnSettings').onclick = function () {
      $('setMini').value = state.settings.mini;
      $('setFunc').value = state.settings.func;
      $('setVoice').checked = state.settings.voice;
      show('settings');
    };
  }

  function refreshLast() {
    var b = $('btnLast');
    if (state.name && state.idNo) {
      b.hidden = false;
      b.innerHTML = '上次的：' + esc(state.name) + '<br>再来一次';
    } else {
      b.hidden = true;
    }
  }

  /* ==================== 相机 ==================== */

  var stream = null, torchOn = false, torchOK = false;

  function openCamera() {
    show('camera');
    drawFrameOverlay();
    startLive();
  }
  function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFallback('这台手机的浏览器不支持取景拍照');
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    }).then(function (s) {
      stream = s;
      var v = $('video');
      v.srcObject = s;
      v.play().catch(function () {});
      v.onloadedmetadata = drawFrameOverlay;
      var track = s.getVideoTracks()[0];
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      torchOK = !!caps.torch;
      $('btnTorch').style.visibility = torchOK ? 'visible' : 'hidden';
      $('camFallback').hidden = true;
    }).catch(function () {
      cameraFallback('相机没有授权');
    });
  }
  function cameraFallback(msg) {
    var box = $('camFallback');
    box.querySelector('p').textContent = msg;
    box.hidden = false;
    $('btnTorch').style.visibility = 'hidden';
  }
  function stopStream() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    torchOn = false;
  }
  function drawFrameOverlay() {
    var cv = $('frameOverlay');
    requestAnimationFrame(function () {
      var w = cv.clientWidth || cv.parentElement.clientWidth;
      var h = cv.clientHeight || cv.parentElement.clientHeight;
      if (!w || !h) return;
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      var cw = w * 0.88, ch = cw * 54 / 85.6;
      var x = (w - cw) / 2, y = h * 0.18;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      roundRect(ctx, x, y, cw, ch, 18);
      ctx.fill('evenodd');
      ctx.restore();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 5;
      roundRect(ctx, x, y, cw, ch, 18);
      ctx.stroke();
      var c = 34;
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = 7;
      corner(ctx, x, y + c, x, y, x + c, y);
      corner(ctx, x + cw - c, y, x + cw, y, x + cw, y + c);
      corner(ctx, x + cw, y + ch - c, x + cw, y + ch, x + cw - c, y + ch);
      corner(ctx, x + c, y + ch, x, y + ch, x, y + ch - c);
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function corner(ctx, x1, y1, x2, y2, x3, y3) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke();
  }

  /**
   * 只截取取景框里看到的那一块（object-fit:cover 会裁掉画面两边）。
   * 这样拍出来的图和白框位置一一对应，OCR 才能按比例找到证件。
   */
  function captureFrame() {
    var v = $('video');
    var vw = v.videoWidth, vh = v.videoHeight;
    var cvEl = $('frameOverlay');
    var ew = v.clientWidth || cvEl.clientWidth;
    var eh = v.clientHeight || cvEl.clientHeight;
    if (!vw || !vh || !ew || !eh) return null;
    var scale = Math.max(ew / vw, eh / vh);
    var srcW = Math.min(vw, Math.round(ew / scale));
    var srcH = Math.min(vh, Math.round(eh / scale));
    var srcX = Math.max(0, Math.round((vw - srcW) / 2));
    var srcY = Math.max(0, Math.round((vh - srcH) / 2));
    var cv = document.createElement('canvas');
    cv.width = srcW; cv.height = srcH;
    cv.getContext('2d').drawImage(v, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    return cv;
  }

  function shutter() {
    var v = $('video');
    if (!stream || !v.videoWidth) { toast('相机还没准备好，请稍等一下'); return; }
    warmUpSpeech();
    var cv = captureFrame();
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
    }
    stopStream();
    speak('正在读身份证，请稍等');
    runOcr(cv);
  }

  async function onFilePicked(file) {
    if (!file) return;
    warmUpSpeech();
    speak('正在读身份证，请稍等');
    var bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { bmp = await createImageBitmap(file); }
      catch (e2) {
        var img = new Image();
        img.src = URL.createObjectURL(file);
        await img.decode();
        bmp = img;
      }
    }
    runOcr(bmp);
  }

  /* ==================== 识别进度 ==================== */

  function progressText(m) {
    var st = String((m && m.status) || '');
    var pct = Math.round((((m && m.progress) || 0) * 100));
    var passTxt = (m && m.passes && m.passes > 1) ? '（第 ' + ((m.pass || 0) + 1) + '/' + m.passes + ' 遍）' : '';
    if (/recogniz/i.test(st)) return '正在认字 ' + pct + '%' + passTxt;
    if (/load|initial|core|traineddata|wasm|lang/i.test(st)) {
      return '第一次使用要加载识别组件，请稍等 ' + pct + '%';
    }
    return '正在读取身份证…' + passTxt;
  }

  async function runOcr(src) {
    show('reading');
    keepAwake();
    $('ocrProgress').textContent = '正在读取身份证…';
    try {
      var r = await IdOcr.recognize(src, function (m) {
        var el = $('ocrProgress');
        if (el && m) el.textContent = progressText(m);
      });
      if (r.name || r.idNo) {
        if (r.name) state.name = r.name;
        if (r.idNo) state.idNo = r.idNo;
        toConfirm(true);
      } else {
        toast('没认清楚，请离近一点、亮一点，再拍一次', 3600);
        speak('没认清楚。请离近一点，亮一点，再拍一次。');
        openCamera();
      }
    } catch (e) {
      toast('识别出错了，请再试一次', 3200);
      speak('识别出错了，请再试一次。');
      openCamera();
    }
  }

  /* ==================== 核对 ==================== */

  function setWarn(msg) {
    var w = $('warnBox');
    if (!msg) { w.hidden = true; w.textContent = ''; return; }
    w.hidden = false;
    w.textContent = msg;
  }

  function openEdit(focusId) {
    $('editBox').hidden = false;
    if (focusId && $(focusId)) {
      setTimeout(function () {
        try {
          $(focusId).focus();
          $(focusId).scrollIntoView({ block: 'center' });
        } catch (e) {}
      }, 120);
    }
  }

  var wrongIdAccepted = false;   // 校验位不对时，需要再点一次才放行

  function toConfirm(fromOcr) {
    show('confirm');
    wrongIdAccepted = false;
    var missName = !state.name, missId = !state.idNo;
    $('tvName').textContent = state.name || '（没认出来）';
    $('tvIdNo').textContent = state.idNo || '（没认出来）';
    $('etName').value = state.name || '';
    $('etIdNo').value = state.idNo || '';
    $('etPhone').value = state.phone || '';

    var checksumBad = !!(state.idNo && !IdOcr.checksumValid(state.idNo));
    if (missName && missId) {
      setWarn('两样都没认出来。请用键盘自己填上姓名和身份证号。');
      openEdit('etName');
    } else if (missName) {
      setWarn('姓名没认出来，请在下面的方框里打上姓名。');
      openEdit('etName');
    } else if (missId) {
      setWarn('身份证号没认出来，请照着身份证打上 18 位号码。');
      openEdit('etIdNo');
    } else if (checksumBad) {
      setWarn('这个身份证号好像抄错了一位，请对着身份证再看一遍。');
    } else {
      setWarn('');
    }
    $('btnGo').innerHTML = '✅ 没错，开始<br>语音教我认证';
    if (fromOcr) {
      speak(missName || missId ? '有两样没认出来，请照着身份证自己填一下' : '请核对一下屏幕上的姓名和身份证号');
    }
  }

  function initConfirm() {
    $('btnGo').onclick = function () {
      warmUpSpeech();
      applyEdits();
      if (!state.name || !state.idNo) {
        setWarn('姓名和身份证号都要填上，才能继续。');
        openEdit(!state.name ? 'etName' : 'etIdNo');
        toast('姓名和身份证号都要填上', 3200);
        speak('姓名和身份证号都要填上，才能继续');
        return;
      }
      if (!IdOcr.checksumValid(state.idNo) && !wrongIdAccepted) {
        wrongIdAccepted = true;
        setWarn('身份证号对不上（18 位号码有校验位）。请再核对一遍；确定没抄错就再点一次绿色按钮。');
        toast('号码可能抄错了，请看一遍身份证', 4200);
        speak('这个身份证号对不上，请再看一遍身份证。确定没错，就再点一次绿色按钮。');
        $('btnGo').innerHTML = '还要继续';
        return;
      }
      state.coaching = true;
      state.step = 0;
      savePerson();
      keepAwake();
      show('coach');
      renderStep();
    };
    $('btnEdit').onclick = function () {
      // 只负责展开、不负责收起：老人按错了也不会把输入框弄没
      warmUpSpeech();
      $('editBox').hidden = false;
      openEdit(!state.name ? 'etName' : (!state.idNo ? 'etIdNo' : 'etName'));
      speak('请在方框里修改姓名和身份证号');
    };
    $('btnManual').onclick = function () {
      warmUpSpeech();
      $('editBox').hidden = false;
      setWarn('请用键盘把姓名和身份证号填上，填好点绿色按钮。');
      openEdit(!state.name ? 'etName' : (!state.idNo ? 'etIdNo' : 'etName'));
      speak('请照着身份证，把姓名和号码打上去');
    };
    $('btnReshoot').onclick = function () { openCamera(); };
    $('etIdNo').addEventListener('input', function () {
      wrongIdAccepted = false;
      $('btnGo').innerHTML = '✅ 没错，开始<br>语音教我认证';
    });
    $('etPhone').addEventListener('change', function () { state.phone = this.value.trim(); });
    $('etPhone').addEventListener('blur', function () { state.phone = this.value.trim(); });
  }

  /** 从输入框里取值：空就是空，绝不用旧值兜底（否则改错了也清不掉） */
  function applyEdits() {
    var n = $('etName').value.replace(/[\s\u3000]+/g, '');
    var i = $('etIdNo').value.replace(/[\s\u3000]+/g, '').toUpperCase();
    state.name = n;
    state.idNo = i;
    state.phone = $('etPhone').value.replace(/[^\d+\-]/g, '');
  }

  /* ==================== 语音教练 ==================== */

  function buildSteps() {
    var mini = state.settings.mini, func = state.settings.func;
    var phone = state.phone;
    var steps = [
      {
        t: '打开微信',
        b: '点屏幕最下面那个<b>绿色大按钮</b>【💬 打开微信】。<br>' +
           '要是点了没反应，就回到手机桌面，点绿色的<b>微信</b>图标。',
        voice: '第一步，打开微信。点屏幕下面绿色的大按钮。要是没反应，就回到手机桌面，点绿色的微信图标。',
        wx: true
      },
      {
        t: '微信最上面往下滑',
        b: '在微信<b>最上面</b>，手指<b>往下滑一下</b>。<br>' +
           '看到【<b>搜索小程序</b>】以后，点它。',
        voice: '第二步，手指放在微信最上面，往下滑一下。看到搜索小程序，点它。'
      },
      {
        t: '搜索小程序名',
        b: '在搜索框里<b>长按</b>，点【<b>粘贴</b>】，再点【<b>搜索</b>】。',
        voice: '第三步，我已经帮您把小程序名复制好了。在搜索框里长按，点粘贴，再点搜索。',
        chips: [{ label: mini, name: '小程序名' }],
        copy: mini,
        copyWhat: '小程序名'
      },
      {
        t: '点「政府」那一条',
        b: '点写着【<b>' + esc(mini) + '</b>】的那一条。<br>' +
           '认准下面标着【<b>政府</b>】的，别的不要点。',
        voice: '第四步，点搜索结果里的' + mini + '。认准下面标着政府的那一条，别的不要点。'
      },
      {
        t: '点「' + func + '」',
        b: '进小程序以后，找到【<b>' + esc(func) + '</b>】点进去。<br>' +
           '看不到的话，点小程序<b>最上面</b>的搜索框，再搜一次【' + esc(func) + '】。',
        voice: '第五步，找到' + func + '，点进去。看不到的话，点最上面的搜索框，再搜一次。',
        chips: [{ label: func, name: '功能名' }],
        copy: func,
        copyWhat: '功能名'
      },
      {
        t: '粘贴姓名和证件号',
        b: '先长按【<b>姓名</b>】框，点【粘贴】。<br>' +
           '再点下面【证件号】旁边的<b>复制</b>，长按【<b>证件号码</b>】框，点【粘贴】。' +
           (phone ? '<br>有【紧急联系人】一栏的话，把最后一个也粘上。' : '') +
           '<br>核对没错，就点【<b>开始认证</b>】。',
        voice: '第六步，我已经帮您把姓名复制好了。先长按姓名框，点粘贴。再点证件号旁边的复制，长按证件号码框，点粘贴。核对没错，点开始认证。',
        chips: [{ label: state.name, name: '姓名' }, { label: state.idNo, name: '证件号' }]
          .concat(phone ? [{ label: phone, name: '联系人' }] : []),
        copy: state.name,
        copyWhat: '姓名'
      },
      {
        t: '同意后做动作',
        b: '把【<b>本人已知悉并同意快捷人脸模式条款</b>】前面的小圆圈点成 ✔，' +
           '再点绿色的【<b>下一步</b>】。<br>然后<b>正对屏幕</b>，跟着提示<b>眨眨眼、摇摇头</b>。',
        voice: '第七步，把同意前面的小圆圈点亮，点绿色的下一步。然后正对屏幕，跟着提示眨眨眼，摇摇头。',
        wx: true
      }
    ];
    return steps;
  }

  var steps = [];

  function renderStep() {
    steps = buildSteps();
    if (state.step >= steps.length) state.step = steps.length - 1;
    if (state.step < 0) state.step = 0;
    var s = steps[state.step];

    $('coachStepNo').textContent = '第 ' + (state.step + 1) + ' 步 / 共 ' + steps.length + ' 步';

    var dots = $('stepDots');
    dots.innerHTML = '';
    for (var i = 0; i < steps.length; i++) {
      var d = document.createElement('span');
      d.className = 'dot' + (i === state.step ? ' on' : (i < state.step ? ' done' : ''));
      d.setAttribute('aria-label', '第 ' + (i + 1) + ' 步');
      dots.appendChild(d);
    }

    var isLast = state.step >= steps.length - 1;
    $('btnNext').textContent = isLast ? '🎉 我认证完成啦' : '我点好了，下一步';
    $('coachTitle').textContent = s.t;
    $('coachBody').innerHTML = s.b;
    $('btnVoice').textContent = state.settings.voice ? '🔊' : '🔇';

    var chips = $('coachChips');
    chips.innerHTML = '';
    (s.chips || []).forEach(function (c) {
      if (!c || !c.label) return;
      var row = document.createElement('div');
      row.className = 'chip';
      var tag = document.createElement('span');
      tag.className = 'chipname';
      tag.textContent = c.name || '内容';
      var txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = c.label;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '复制';
      btn.onclick = function () { doCopy(c.label, c.name, false); };
      row.appendChild(tag); row.appendChild(txt); row.appendChild(btn);
      chips.appendChild(row);
    });

    var note = $('copyNote');
    note.hidden = true;
    note.textContent = '';

    savePerson();
    if (s.voice) speak(s.voice);
    // 需要老人去微信里粘贴的内容，进这一步就自动帮他复制好
    if (s.copy) doCopy(s.copy, s.copyWhat, true);
    window.scrollTo(0, 0);
  }

  function flashCard() {
    var card = $('coachCard');
    card.classList.remove('flash');
    // 强制重排一次，否则连着重播同一段动画不会重新触发
    void card.offsetWidth;
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 1500);
  }

  /* ---- 打开微信 ---- */

  var wxTapAt = 0;

  function tryScheme(url) {
    try {
      var a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {}
  }

  /** 微信被挡住时页面依旧可见，所以用「页面有没有被切走」来判断有没有打开成功 */
  function wxStillHere() { return document.visibilityState !== 'hidden'; }

  function openWeChat() {
    wxTapAt = Date.now();
    $('wxHelp').hidden = true;
    warmUpSpeech();
    tryScheme('weixin://');
    setTimeout(function () {
      if (!wxStillHere() || Date.now() - wxTapAt > 1500) return;
      try { location.href = 'weixin://dl/chat'; } catch (e) {}
    }, 300);
    setTimeout(function () {
      if (!wxStillHere()) return;      // 微信已经打开了
      $('wxHelp').hidden = false;
      speak('没反应的话，请回到手机桌面，点绿色的微信图标。');
    }, 1500);
  }

  function initCoach() {
    $('btnNext').onclick = function () {
      warmUpSpeech();
      if (state.step >= steps.length - 1) { finish(); return; }
      state.step++;
      renderStep();
    };
    $('btnPrev').onclick = function () {
      if (state.step <= 0) return;
      state.step--;
      renderStep();
    };
    $('btnReplay').onclick = function () {
      warmUpSpeech();
      var s = steps[state.step];
      if (s) speak(s.voice || s.t);
      flashCard();
    };
    $('btnVoice').onclick = function () {
      state.settings.voice = !state.settings.voice;
      saveSettings();
      $('btnVoice').textContent = state.settings.voice ? '🔊' : '🔇';
      toast(state.settings.voice ? '语音已打开' : '语音已关闭');
      if (state.settings.voice) speak('语音已经打开');
    };
    $('btnOpenWx').onclick = openWeChat;
    $('btnWxHelpOk').onclick = function () { $('wxHelp').hidden = true; };
  }

  function finish() {
    var d = new Date();
    var dateStr = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    $('doneSub').textContent = state.name + ' 已完成待遇资格认证 · ' + dateStr;
    state.coaching = false;
    state.step = 0;
    savePerson();
    speak('认证成功，恭喜您！');
    show('done');
  }

  function initDone() {
    $('btnDoneHome').onclick = function () {
      state.coaching = false;
      state.step = 0;
      savePerson();
      refreshLast();
      show('home');
    };
  }

  /* ==================== 设置 / 帮助 ==================== */

  function initSettings() {
    $('btnSetSave').onclick = function () {
      state.settings.mini = $('setMini').value.trim() || '湖南智慧人社';
      state.settings.func = $('setFunc').value.trim() || '待遇资格认证';
      state.settings.voice = $('setVoice').checked;
      saveSettings();
      toast('已保存');
      show('home');
    };
    $('btnSetBack').onclick = function () { show('home'); };
    $('btnHelp').onclick = function () { show('help'); };
    $('btnHelpBack').onclick = function () { show('settings'); };
  }

  /* ==================== 相机按钮 ==================== */

  function initCameraButtons() {
    $('btnCamBack').onclick = function () { stopStream(); show('home'); };
    $('btnShutter').onclick = shutter;
    $('btnTorch').onclick = function () {
      if (!stream) return;
      torchOn = !torchOn;
      var track = stream.getVideoTracks()[0];
      track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
    };
    $('btnFilePick').onclick = function () { $('fileInput').click(); };
    $('fileInput').addEventListener('change', function () {
      onFilePicked(this.files && this.files[0]);
      this.value = '';
    });
    window.addEventListener('resize', function () {
      if (!$('scr-camera').hidden) drawFrameOverlay();
    });
  }

  /* ==================== 从微信切回来 ==================== */

  var hiddenAt = 0;
  function initVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      var away = hiddenAt ? (Date.now() - hiddenAt) : 0;
      hiddenAt = 0;
      // 去微信里操作完回来：把当前这一步再念一遍，并把卡片闪一下
      if (!$('scr-coach').hidden && steps[state.step] && away > 1500) {
        speak(steps[state.step].voice || steps[state.step].t);
        flashCard();
      }
    });
  }

  /* ==================== 启动 ==================== */

  load();
  initHome();
  initConfirm();
  initCoach();
  initDone();
  initSettings();
  initCameraButtons();
  initVisibility();

  // 第一次点屏幕就把语音解锁（iOS 不给手势就不出声）
  ['pointerdown', 'touchstart', 'click'].forEach(function (ev) {
    document.addEventListener(ev, function once() {
      warmUpSpeech();
      document.removeEventListener(ev, once);
    }, { passive: true });
  });

  if (state.coaching && state.name && state.idNo) {
    show('coach');
    renderStep();
    toast('接着上次的进度继续', 3200);
  } else {
    show('home');
  }
})();
