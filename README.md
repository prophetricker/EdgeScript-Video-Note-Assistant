# EdgeScript Video Note Assistant

一个 Edge 浏览器扩展（Manifest V3），用于在 B 站视频页一键完成：

1. 提取视频文本（优先字幕）。
2. 无字幕时强制 ASR 音频转写（可配置）。
3. 生成结构化学习笔记（Markdown）。
4. 导入飞书知识库（主笔记 + 转写与时间戳文档）。
5. 基于历史笔记样本做风格学习。

## 目录结构

- `manifest.json`：扩展清单
- `content-script.js`：B 站页面提取与页面内 ASR
- `background.js`：任务编排、模型调用、飞书导入、日志持久化
- `popup.*`：一键执行与运行日志面板
- `options.*`：设置页与风格样本管理
- `local-asr-whisper/`：本地 Whisper（faster-whisper）服务

## 安装方式

1. 打开 Edge：`edge://extensions/`
2. 开启“开发人员模式”
3. 点击“加载解压缩的扩展”
4. 选择目录：`d:\MyProject\EdgeScript`

## 必填配置

### 模型配置

- `API Base URL`：例如 `https://www.sophnet.com/api/open-apis/v1`
- `API Key`
- `模型名`：例如 `DeepSeek-V3.1-Fast`

### ASR 配置（建议本地 Whisper）

- 勾选 `无字幕时自动提取音频并转写`
- 建议勾选 `无字幕时必须 ASR 成功（失败则终止，不回退简介）`
- `ASR Base URL`：例如 `http://127.0.0.1:8171/v1`
- `ASR API Key`：本地服务可留空（或与你本地服务配置一致）
- `转写模型`：`whisper-1`

### 飞书配置

- `App ID`
- `App Secret`
- `Space ID`
- 可选：`父节点 Token`

## 使用流程

1. 打开 B 站视频详情页
2. 在插件弹窗点击“运行前自检”
3. 点击“一键提取并生成笔记”
4. 结果会写入飞书知识库：
- 主笔记文档
- 转写与时间戳文档

## 运行日志

- 日志会按任务持久化到本地存储
- 弹窗支持恢复最近多次任务日志
- 不同任务之间使用分隔线展示

## 常见问题

### 1. ASR `Failed to fetch`

优先检查：

- 本地 ASR 服务是否在运行（`http://127.0.0.1:8171/v1/models`）
- 设置中的 ASR URL / Key 是否正确
- 扩展是否已刷新到最新版本

如果你使用的是本地 Whisper，建议按下面顺序操作：

1. 打开 PowerShell，进入目录：`d:\MyProject\EdgeScript\local-asr-whisper`
2. 临时放开当前窗口脚本策略：`Set-ExecutionPolicy -Scope Process Bypass`
3. 启动服务：`.\start_quick.ps1`
4. 保持该窗口不要关闭，再回到扩展点“运行前自检”

### 2. 飞书已创建文档但位置不对

- 请检查 `Space ID` 与 `父节点 Token`
- 若父节点权限不足，可能会创建文档但挂载失败

### 3. 无字幕时生成内容空泛

- 启用“无字幕必须 ASR 成功”
- 未成功转写时任务会终止，不再回退简介文本

