# Codex DeepSeek Proxy

[![Version](https://img.shields.io/badge/version-1.0.2-blue)](./VERSION)

让 [OpenAI Codex CLI](https://github.com/openai/codex) 通过本地代理接入 [DeepSeek API](https://platform.deepseek.com/)，无需 OpenAI 付费账号。

## 工作原理

```
┌──────────┐   Responses API    ┌─────────────────┐   Chat Completions   ┌──────────────┐
│ Codex CLI │ ──→ 127.0.0.1:15722 ──→ │  codex_proxy.js  │ ──→ /v1/chat/completions ──→ │ DeepSeek API │
└──────────┘                     └─────────────────┘                       └──────────────┘
```

Codex CLI v0.135+ 使用 OpenAI Responses API，而 DeepSeek 只支持 Chat Completions API。本代理在本地完成协议转换：

| Responses API | → | Chat Completions API |
|---|---|---|
| `input` 数组 | → | `messages` 数组 |
| `type: "message"` role=`developer` | → | `role: "system"` |
| `type: "reasoning"` | → | `reasoning_content` |
| `type: "function_call"` | → | `tool_calls` |
| `type: "function_call_output"` | → | `role: "tool"` |
| `type: "namespace"` tools | → | 展开为多个 `type: "function"` |
| `reasoning.effort` | → | DeepSeek V4 `reasoning_effort` |

## 快速开始

### 1. 获取 DeepSeek API Key

在 [platform.deepseek.com](https://platform.deepseek.com/) 注册并获取 API Key。

### 2. 安装 Codex CLI

```bash
npm install -g @openai/codex
```

### 3. 配置代理

```bash
# 创建配置目录
mkdir -p ~/.codex

# 复制代理脚本
cp codex_proxy.js ~/.codex/

# 复制模型目录
cp model-catalog.json ~/.codex/

# 复制配置模板，修改端口指向代理
cp config.example.toml ~/.codex/config.toml

# 设置 API Key 环境变量
export OPENAI_API_KEY="sk-your-deepseek-key"
```

建议将 `export OPENAI_API_KEY=...` 写入 `~/.zshrc`。

### 4. 启动代理

```bash
node ~/.codex/codex_proxy.js
```

### 5. 启动 Codex

```bash
codex
```

在 Codex 中输入 `/model` 即可切换模型。

## 可用模型

| 模型 | 说明 |
|---|---|
| `deepseek-v4-flash` | 快速通用（284B 参数），适合日常编码 |
| `deepseek-v4-pro` | 高性能（1.6T 参数），适合复杂推理 |

## macOS LaunchAgent（开机自启）

```bash
# 1. 编辑 plist 文件，替换其中的路径和 API Key
#    - YOUR_USERNAME → 你的用户名
#    - node 路径 → 运行 `which node` 查看
#    - sk-YOUR_DEEPSEEK_API_KEY → 你的 DeepSeek Key

cp com.codex.deepseek-proxy.example.plist ~/Library/LaunchAgents/com.codex.deepseek-proxy.plist

# 2. 编辑后加载
launchctl load ~/Library/LaunchAgents/com.codex.deepseek-proxy.plist

# 3. 检查状态（退出码 0 表示正常）
launchctl list | grep codex
```

常用命令：

```bash
# 重启代理（修改代码后）
launchctl unload ~/Library/LaunchAgents/com.codex.deepseek-proxy.plist
launchctl load ~/Library/LaunchAgents/com.codex.deepseek-proxy.plist

# 查看日志
tail -f ~/.codex/proxy.log
tail -f ~/.codex/proxy.err.log
```

## 配置说明

### config.toml

```toml
model = "deepseek-v4-flash"          # 默认模型
model_provider = "deepseek"          # provider 名称
wire_api = "responses"               # 使用 Responses API 协议
model_catalog_json = "~/.codex/model-catalog.json"  # 模型目录
base_url = "http://127.0.0.1:15722/v1"             # 代理地址
```

### model-catalog.json

定义 `/model` 命令显示的模型列表。如需添加新模型，在 `models` 数组中新增条目即可。

### 自定义端口

默认端口 `15722`。如需修改：

1. 编辑 `codex_proxy.js` 底部的 `PORT` 常量
2. 同步修改 `config.toml` 中的 `base_url`

## 故障排查

### 代理启动失败 / 端口被占用

```bash
lsof -i :15722                    # 查看端口占用
lsof -ti :15722 | xargs kill -9   # 强制释放
```

### Codex 报 "Missing environment variable: OPENAI_API_KEY"

```bash
echo $OPENAI_API_KEY              # 检查是否已设置
export OPENAI_API_KEY="sk-xxx"    # 设置后重试
```

### 模型切换后报错

确保 `model-catalog.json` 中的模型名与 DeepSeek API 一致。代理不做模型名翻译，直接透传。

### 对话过长导致出错

```bash
# 清空对话历史
rm ~/.codex/history.jsonl
# 或在 Codex 内输入 /clear
```

### 查看代理日志

```bash
# 实时跟踪
tail -f ~/.codex/proxy.log

# 日志格式
# [REQ] model=deepseek-v4-flash messages=6 tools=8 stream=true
# [OK] streaming done, reasoning=135 text=421 tool_calls=0
# [ERR] DeepSeek HTTP 400: ...
```

## 安全提醒

- **不要将 API Key 提交到代码仓库**。本项目使用环境变量 `OPENAI_API_KEY` 读取密钥
- plist 示例文件中的 Key 为占位符，使用前需替换
- 代理仅监听 `127.0.0.1`，不会暴露到公网

## 发布流程

本项目使用 [GitHub Actions](.github/workflows/release.yml) 自动发布。只需要：

```bash
# 1. 做出修改，正常 commit
git add -A
git commit -m "feat: 你的修改说明"

# 2. 用 release: 前缀提交，自动触发发布
git commit --allow-empty -m "release: v1.0.1"
git push
```

之后 GitHub Actions 会自动：
- 更新 `VERSION` 文件和 README 版本徽章
- 从 commit 历史生成 `CHANGELOG.md`
- 创建 Git tag 并推送
- 生成 GitHub Release 和 Release Notes

[查看完整更新日志 →](CHANGELOG.md)

## 许可

MIT License
