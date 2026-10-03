# 一键社保认证（网页版 · 语音教练模式）

**线上地址：<https://luoyoulai-collab.github.io/shebao-web/>**

帮中老年人完成社保「待遇资格认证」的网页工具：**拍一下身份证，自动识别姓名和证件号，然后一步一步用语音+大字教您在微信里完成认证**。

- 打开链接就能用，无需安装（可"添加到桌面"变成图标，之后离线也能用）
- 安卓 / iPhone 都能用
- **照片不上传**：识别在手机浏览器本地完成（Tesseract 中文模型随网站一起下发，全程无第三方请求）
- 自动适配「湖南智慧人社」小程序流程；其他省份可在页面右上角 ⚙ 里改小程序/功能名称

## 老人怎么用（3 步）

1. 点开链接（或桌面图标）
2. 把身份证**有照片的一面**放进白框，点大圆钮拍照
3. 核对姓名证件号 → 点「没错，开始语音教我认证」，然后跟着语音和复制按钮一步步点

## 部署到自己的网址（任选其一）

### 方式 A：GitHub Pages

```bash
# 1. 在 github.com 网页上新建一个仓库（比如 shebao-web），不要勾选任何初始化
# 2. 本机进入本目录后：
git remote add origin https://github.com/<你的用户名>/shebao-web.git
git push -u origin main
```

3. 仓库页面 → **Settings → Pages** → Source 选 `main` 分支 / 目录 `/ (root)` → Save
4. 1 分钟后访问 `https://<你的用户名>.github.io/shebao-web/`

> 国内直连 github.io 可能不稳定，若老人打不开，可用方式 B，或给老人手机配上家人常用的网络环境。

### 方式 B：Gitee Pages（国内访问快）

1. 注册/登录 gitee.com → 新建仓库（公开），如 `shebao-web`
2. 推送代码：

```bash
git remote add gitee https://gitee.com/<你的用户名>/shebao-web.git
git push -u gitee main
```

3. 仓库页面 → **服务 → Gitee Pages** → 部署分支 `main`、目录 `/ ` → 启动
4. 访问 `https://<你的用户名>.gitee.io/shebao-web/`

### 方式 C：任何静态空间

本目录就是纯静态网站（HTML/JS/图标/识别模型），整体上传到任意支持 HTTPS 的静态托管即可。

## 本地测试

```bash
cd shebao-web
python -m http.server 8765
# 浏览器打开 http://127.0.0.1:8765/
```

> 相机取景需要 HTTPS 或 localhost 环境；手机真机请用部署后的网址。

## 技术说明

- 纯静态，无构建、无框架、无任何外部 CDN —— 所有资源（含 1.7MB 中文 OCR 模型与 Tesseract WASM）随仓库分发
- `js/ocr.js`：身份证 OCR 解析（18 位号码正则 + GB11643 校验码 + 常见混淆字符修正 + 姓名启发式提取）
- `js/app.js`：界面流程（拍照 getUserMedia → 失败自动降级为系统相机；复制按钮 navigator.clipboard → execCommand 兜底；语音 speechSynthesis；断点续教 localStorage）
- `sw.js`：Service Worker 预缓存全部资源，添加到桌面后**完全离线可用**（改文件后记得把开头的 `VERSION` 加一）
- 微信内打开会提示"用浏览器打开"（微信内置浏览器限制相机与剪贴板）

## 与 Android APP 版的差别

| | 网页版（本仓库） | Android APP |
|---|---|---|
| 安装 | 点链接即用 | 装 APK + 开无障碍开关 |
| 自动化 | 语音教练引导，老人自己点 | 全自动操作微信 |
| 平台 | 安卓 + iPhone | 仅安卓 |

两个版本可以配套使用：APP 给安卓老人全自动，网页版给 iPhone 老人和不想装 APP 的场景。

## 隐私

- 无统计、无埋点、无外部请求；照片识别后仅在内存中使用，不落盘、不上传
- 姓名/证件号仅存在老人自己手机的 localStorage（用于"上次的，再来一次"），可在浏览器设置里随时清除
