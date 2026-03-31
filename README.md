# EdgeScript Video Note Assistant

Edge 浏览器扩展（Manifest V3），用于在 B 站视频页一键生成结构化学习笔记，并可导入飞书知识库。

## 功能特性

- 字幕优先提取，自动识别并锁定当前视频 `BV/CID`。
- 无字幕时走本地 ASR（Whisper），支持服务端下载音频转写。
- 两阶段笔记生成（事实要点抽取 + 结构化写作），减少偏题。
- 飞书双文档导入：
  - 学习笔记
  - 转写与时间戳
- 运行日志持久化、异常可强制中断、429 自动退避重试。

## 仓库结构

- `manifest.json`：扩展清单
- `background.js`：主流程编排、LLM/ASR/飞书集成
- `content-script.js`：页面提取逻辑
- `popup.*`：任务面板与日志
- `options.*`：配置页
- `local-asr-whisper/`：本地 ASR 服务

## 给普通用户的安装方式（推荐）

### 1) 从 Release 下载

在 GitHub Release 下载并解压：

- `EdgeScript-extension-v*.zip`
- `local-asr-whisper-v*.zip`

### 2) 安装扩展

1. 打开 `edge://extensions/`
2. 开启“开发人员模式”
3. 点击“加载解压缩的扩展程序”
4. 选择 `EdgeScript-extension` 解压目录

### 3) 启动本地 ASR

在 `local-asr-whisper` 目录执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1 -PythonExe py -PythonVersionArg -3.11
.\start_quick.ps1
```

保持该窗口运行。

## 扩展配置说明

### LLM（必填）

- `API Base URL`：例如 `https://api.moonshot.cn/v1`
- `API Key`
- `模型名`：例如 `kimi-k2`

### ASR（推荐本地）

- 开启 `无字幕时自动提取音频并转写`
- 开启 `无字幕时必须 ASR 成功`
- `ASR Base URL`：`http://127.0.0.1:8171/v1`
- `ASR API Key`：本地服务可留空
- `ASR Model`：`whisper-1`

### 飞书（可选）

- `App ID`
- `App Secret`
- `Space ID`
- `父节点 Token`（可选）

## 使用流程

1. 打开 B 站视频页
2. 在插件弹窗点击“运行前自检”
3. 点击“开始任务”
4. 等待结果写入飞书或本地日志

## 常见问题

### 1) 任务卡在“结构化笔记生成”

- 当前版本有心跳日志和阶段超时。
- 若超过 8 分钟会自动失败并提示。
- 建议切换到响应更稳定的模型或降低并发任务。

### 2) ASR 连不上

先检查：

- `http://127.0.0.1:8171/health`
- `http://127.0.0.1:8171/v1/models`

### 3) 转写文本繁体

本地 ASR 默认开启 `ZH_TEXT_CONVERT_MODE=t2s`（繁转简）。

## 发布者指南

本仓库已内置打包脚本，可直接生成 Release 附件：

```powershell
cd d:\MyProject\EdgeScript
.\build_release.ps1
```

输出目录：

- `dist/EdgeScript-extension-v{manifest.version}.zip`
- `dist/local-asr-whisper-v{server.APP_VERSION}.zip`
- `dist/SHA256SUMS.txt`

## 安全与隐私

- 请勿提交任何 API Key、飞书密钥、cookie 文件。
- 建议仅在本地配置密钥。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
