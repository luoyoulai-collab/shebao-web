/* 一键社保认证 · 页面逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    name: '', idNo: '', phone: '',
    coaching: false, step: 0,
    settings: { mini: '湖南智慧人社', func: '待遇资格认证', voice: true }
  };

  /* ---------- 持久化 ---------- */
  function load() {
    try {
      state.name = localStorage.getItem('sb_name') || '';
      state.idNo = localStorage.getItem('sb_id') || '';
      state.phone = localStorage.getItem('sb_phone') || '';
      state.coaching = localStorage.getItem('sb_coaching') === '1';
      state.step = parseInt(localStorage.getItem('sb_step') || '0', 10) || 0;
      var s = localStorage.getItem('sb_settings');
      if (s) { s = JSON.parse(s); if (s && s.mini) state.settings = s; }
    } catch (e) {}
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

  /* ---------- 屏幕路由 ---------- */
  var screens = ['home', 'camera', 'reading', 'confirm', 'coach', 'done', 'settings'];
  function show(name) {
    screens.forEach(function (s) { $('scr-' + s).hidden = (s !== name); });
    window.scrollTo(0, 0);
  }

  /* ---------- 语音 ---------- */
  var speechOK = 'speechSynthesis' in window;
  function speak(text) {
    if (!speechOK || !state.settings.voice) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.85;
      var vs = speechSynthesis.getVoices();
      for (var i = 0; i < vs.length; i++) {
        if (/zh[-_]CN/i.test(vs[i].lang)) { u.voice = vs[i]; break; }
      }
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  if (speechOK) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = function () {}; }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }

  /* ---------- 复制 ---------- */
  function copyText(text, done) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else fallback();
  }

  /* ---------- 屏幕常亮（尽力而为） ---------- */
  var wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
  }

  /* ================= 首页 ================= */
  function initHome() {
    if (/MicroMessenger/i.test(navigator.userAgent)) $('wxBanner').hidden = false;
    refreshLast();
    $('btnShoot').onclick = function () { speak('请把身份证放进白框里，点下面的大圆钮拍照'); openCamera(); };
    $('btnLast').onclick = function () {
      state.name = localStorage.getItem('sb_name') || '';
      state.idNo = localStorage.getItem('sb_id') || '';
      state.phone = localStorage.getItem('sb_phone') || '';
      if (!state.name || !state.idNo) { toast('上次的信息不完整，请重新拍'); return; }
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
    var n = localStorage.getItem('sb_name');
    var i = localStorage.getItem('sb_id');
    var b = $('btnLast');
    if (n && i) { b.hidden = false; b.innerHTML = '上次的：' + esc(n) + '<br>再来一次'; }
    else b.hidden = true;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ================= 相机 ================= */
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

  function shutter() {
    var v = $('video');
    if (!stream || !v.videoWidth) { toast('相机还没准备好'); return; }
    speak('正在读取身份证，请稍等');
    var cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    stopStream();
    runOcr(cv);
  }

  async function onFilePicked(file) {
    if (!file) return;
    speak('正在读取身份证，请稍等');
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

  async function runOcr(src) {
    show('reading');
    keepAwake();
    try {
      var r = await IdOcr.recognize(src, function (m) {
        if (m.status === 'recognizing text') {
          $('ocrProgress').textContent = '识别中 ' + Math.round((m.progress || 0) * 100) + '%';
        } else if (m.status === 'loading language traineddata' || m.status === 'loading tesseract core') {
          $('ocrProgress').textContent = '第一次使用需加载识别组件 ' + Math.round((m.progress || 0) * 100) + '%';
        }
      });
      if (r.name || r.idNo) {
        if (r.name) state.name = r.name;
        if (r.idNo) state.idNo = r.idNo;
        state.phone = localStorage.getItem('sb_phone') || '';
        toConfirm(true, !r.name || !r.idNo);
      } else {
        toast('没认清楚，请离近一点、亮一点，再拍一次', 3400);
        speak('没认清楚，请离近一点亮一点，再拍一次');
        openCamera();
      }
    } catch (e) {
      toast('识别出错了，请重试', 3000);
      openCamera();
    }
  }

  /* ================= 核对 ================= */
  function toConfirm(fromOcr, partial) {
    show('confirm');
    $('tvName').textContent = state.name || '（点「改一改」填姓名）';
    $('tvIdNo').textContent = state.idNo || '（点「改一改」填号码）';
    $('etName').value = state.name;
    $('etIdNo').value = state.idNo;
    $('etPhone').value = state.phone;
    $('editBox').hidden = !partial;
    if (fromOcr) speak('请核对一下屏幕上的姓名和身份证号');
  }

  function initConfirm() {
    $('btnGo').onclick = function () {
      applyEdits();
      if (!state.name || !state.idNo) {
        toast('姓名和身份证号都要有');
        $('editBox').hidden = false;
        return;
      }
      state.coaching = true;
      state.step = 0;
      savePerson();
      keepAwake();
      speak('好嘞，跟着语音一步步来。先别着急，每做完一步，回到这个页面点下一步。');
      show('coach');
      setTimeout(renderStep, 3500);
    };
    $('btnEdit').onclick = function () {
      var box = $('editBox');
      box.hidden = !box.hidden;
      if (!box.hidden) $('etName').focus();
    };
    $('btnReshoot').onclick = function () { openCamera(); };
    $('etPhone').addEventListener('change', function () { state.phone = this.value.trim(); });
  }
  function applyEdits() {
    state.name = $('etName').value.trim() || state.name;
    state.idNo = $('etIdNo').value.trim().toUpperCase() || state.idNo;
    state.phone = $('etPhone').value.trim();
  }

  /* ================= 语音教练 ================= */
  function buildSteps() {
    var mini = state.settings.mini, func = state.settings.func;
    var steps = [
      { t: '① 打开微信', b: '回到手机桌面，点绿色的【微信】', voice: '第一步，打开微信' },
      { t: '② 点放大镜', b: '点微信<b>最上方</b>的【放大镜 🔍】（搜索）', voice: '第二步，点微信最上方的放大镜，就是搜索' },
      {
        t: '③ 输入小程序名', b: '点一下【复制】，再到微信里<b>长按搜索框</b>，选【粘贴】，然后点【搜索】',
        voice: '第三步，点复制，回到微信长按搜索框粘贴，然后点搜索',
        chips: [{ label: mini }]
      },
      {
        t: '④ 点搜索结果', b: '点写着【<b>' + esc(mini) + '</b>】的那一条，认准下面标着【政府】的',
        voice: '第四步，点搜索结果里的' + mini + '，认准标着政府的那条'
      },
      {
        t: '⑤ 找到' + esc(func), b: '在小程序里找到【<b>' + esc(func) + '</b>】点进去。没看到的话，点页面上方的搜索框，输入【' + esc(func) + '】再点结果',
        voice: '第五步，在小程序里找到' + func + '，点进去'
      },
      {
        t: '⑥ 填姓名和证件号', b: '分别点【姓名】和【证件号码】输入框，<b>长按</b>后选【粘贴】',
        voice: '第六步，分别粘贴姓名和证件号码',
        chips: [{ label: state.name, name: '姓名' }, { label: state.idNo, name: '证件号' }]
      }
    ];
    if (state.phone && state.phone.length >= 5) {
      steps.push({
        t: '⑦ 紧急联系人', b: '如果页面有【紧急联系人】一栏，粘贴这个号码',
        voice: '第七步，如果有紧急联系人一栏，粘贴这个号码',
        chips: [{ label: state.phone, name: '联系人' }]
      });
    }
    var n = steps.length;
    steps.push({
      t: num(n) + ' 点开始认证', b: '核对姓名证件号没错后，点红色的【<b>开始认证</b>】。若弹出【我同意，开始人脸识别】，点【我同意】',
      voice: '核对没错后，点红色的开始认证。如果弹出我同意开始人脸识别，就点我同意'
    });
    steps.push({
      t: num(n + 1) + ' 同意人脸识别', b: '把【<b>本人已知悉并同意快捷人脸模式条款</b>】前面的小圆圈点成 ✔，再点绿色的【下一步】',
      voice: '把同意条款前面的小圆圈点亮，再点绿色的下一步'
    });
    steps.push({
      t: num(n + 2) + ' 人脸识别', b: '<b>正对屏幕</b>，把脸放进框里，跟着提示眨眨眼、摇摇头',
      voice: '正对屏幕，把脸放进框里，跟着提示做动作'
    });
    steps.push({
      t: num(n + 3) + ' 就要完成了', b: '看到【<b>认证成功</b>】就办好啦！回到这个页面，点下面的按钮',
      voice: '看到认证成功就办好啦，回到这个页面点完成'
    });
    return steps;
  }
  function num(i) { return '①②③④⑤⑥⑦⑧⑨⑩⑪⑫'[i] || (i + 1); }

  var steps = [];
  function renderStep() {
    steps = buildSteps();
    if (state.step >= steps.length) state.step = steps.length - 1;
    if (state.step < 0) state.step = 0;
    var s = steps[state.step];
    $('coachStepNo').textContent = '第 ' + (state.step + 1) + ' 步 / 共 ' + steps.length + ' 步';
    // 最后一步：下一步按钮变成“我认证完成啦”
    var isLast = state.step >= steps.length - 1;
    $('btnNext').textContent = isLast ? '🎉 我认证完成啦' : '我点好了，下一步';
    $('coachTitle').innerHTML = s.t;
    $('coachBody').innerHTML = s.b;
    var chips = $('coachChips');
    chips.innerHTML = '';
    (s.chips || []).forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'chip';
      var nameTag = c.name ? '<span class="chipname">' + esc(c.name) + '</span>' : '';
      row.innerHTML = nameTag + '<span class="txt">' + esc(c.label) + '</span>';
      var btn = document.createElement('button');
      btn.textContent = '复制';
      btn.onclick = function () {
        copyText(c.label, function (ok) {
          toast(ok ? '已复制 ✓ 回到微信长按输入框粘贴' : '复制失败，请长按文字手动复制');
          if (ok) speak('已复制，回到微信长按输入框，选粘贴');
        });
      };
      row.appendChild(btn);
      chips.appendChild(row);
    });
    savePerson();
    if (s.voice) speak(s.voice);
  }

  function initCoach() {
    $('btnNext').onclick = function () {
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
      var s = steps[state.step];
      speak(s ? (s.voice || s.t) : ' ');
    };
    $('btnVoice').onclick = function () {
      state.settings.voice = !state.settings.voice;
      saveSettings();
      $('btnVoice').textContent = state.settings.voice ? '🔊' : '🔇';
      toast(state.settings.voice ? '语音已打开' : '语音已关闭');
    };
    // 从微信切回来时自动重念当前步骤
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !$('scr-coach').hidden && steps[state.step]) {
        speak(steps[state.step].voice || steps[state.step].t);
      }
    });
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

  /* ================= 设置 ================= */
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
  }

  /* ================= 相机按钮 ================= */
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

  /* ================= 启动 ================= */
  load();
  initHome();
  initConfirm();
  initCoach();
  initDone();
  initSettings();
  initCameraButtons();

  // 上次进行到一半的教学，直接续上
  if (state.coaching && state.name && state.idNo) {
    show('coach');
    renderStep();
    toast('接着上次的进度继续');
  } else {
    show('home');
  }
})();
