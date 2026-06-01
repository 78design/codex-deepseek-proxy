#!/usr/bin/env bash
# ============================================================
# Codex DeepSeek Proxy 一键安装脚本
# https://github.com/78design/codex-deepseek-proxy
#
# 用法: bash install.sh [你的DeepSeek API Key]
#
# 做了什么:
#   1. 安装 Node.js (如果没有)
#   2. 安装 Codex CLI (如果没有)
#   3. 部署代理脚本 + 模型目录 + 配置
#   4. 配置 macOS LaunchAgent 开机自启
# ============================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERR ]${NC} $1"; exit 1; }

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Codex DeepSeek Proxy 一键安装                  ║${NC}"
echo -e "${GREEN}║   https://github.com/78design/codex-deepseek-proxy║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── 0. 获取 API Key ──
API_KEY="${1:-}"
if [ -z "$API_KEY" ]; then
  if [ -n "$OPENAI_API_KEY" ]; then
    API_KEY="$OPENAI_API_KEY"
    info "使用环境变量 OPENAI_API_KEY"
  else
    echo -n "请输入你的 DeepSeek API Key (在 platform.deepseek.com 获取): "
    read -r API_KEY
    [ -z "$API_KEY" ] && err "API Key 不能为空"
  fi
fi

CODEX_HOME="${HOME}/.codex"
PROXY_PORT="${2:-15722}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 1. Node.js ──
info "检查 Node.js ..."
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  ok "Node.js 已安装: $NODE_VER"
else
  warn "Node.js 未安装，正在安装 ..."
  if command -v brew &>/dev/null; then
    brew install node
  elif command -v nvm &>/dev/null; then
    nvm install --lts
    nvm use --lts
  else
    err "请先安装 Node.js: https://nodejs.org/ 或 brew install node"
  fi
  ok "Node.js 安装完成"
fi

# ── 2. Codex CLI ──
info "检查 Codex CLI ..."
if command -v codex &>/dev/null; then
  CODEX_VER=$(codex --version 2>&1 | head -1)
  ok "Codex CLI 已安装: $CODEX_VER"
else
  warn "Codex CLI 未安装，正在安装 ..."
  npm install -g @openai/codex
  ok "Codex CLI 安装完成"
fi

# ── 3. 创建 .codex 目录 ──
info "创建配置目录 $CODEX_HOME ..."
mkdir -p "$CODEX_HOME"

# ── 4. 部署代理 ──
info "部署代理脚本 ..."
cp "$SCRIPT_DIR/codex_proxy.js" "$CODEX_HOME/codex_proxy.js"
ok "codex_proxy.js → $CODEX_HOME/"

# ── 5. 部署模型目录 ──
if [ -f "$SCRIPT_DIR/model-catalog.json" ]; then
  cp "$SCRIPT_DIR/model-catalog.json" "$CODEX_HOME/model-catalog.json"
  ok "model-catalog.json → $CODEX_HOME/"
elif [ -f "$SCRIPT_DIR/cc-switch-model-catalog.json" ]; then
  cp "$SCRIPT_DIR/cc-switch-model-catalog.json" "$CODEX_HOME/model-catalog.json"
  ok "model-catalog.json → $CODEX_HOME/"
fi

# ── 6. 配置 config.toml ──
info "配置 Codex CLI ..."
cat > "$CODEX_HOME/config.toml" << TOML
# Codex + DeepSeek 配置 (由 install.sh 自动生成)
model = "deepseek-v4-flash"
model_provider = "deepseek"
wire_api = "responses"
model_catalog_json = "~/.codex/model-catalog.json"
disable_response_storage = true
approvals_reviewer = "user"
model_reasoning_effort = "medium"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://127.0.0.1:${PROXY_PORT}/v1"
env_key = "OPENAI_API_KEY"
TOML
ok "config.toml 已配置 (端口 $PROXY_PORT)"

# ── 7. 配置 API Key ──
info "配置 API Key ..."

# 写入 .zshrc (如果还没有)
if grep -q "OPENAI_API_KEY" "$HOME/.zshrc" 2>/dev/null; then
  warn "OPENAI_API_KEY 已存在于 ~/.zshrc，跳过写入"
else
  echo "" >> "$HOME/.zshrc"
  echo "# Codex + DeepSeek API Key (由 install.sh 添加)" >> "$HOME/.zshrc"
  echo "export OPENAI_API_KEY=\"$API_KEY\"" >> "$HOME/.zshrc"
  ok "API Key 已写入 ~/.zshrc"
fi

# 同时给 codex 添加 alias (KEY 紧跟 codex 命令)
if grep -q "alias codex=" "$HOME/.zshrc" 2>/dev/null; then
  warn "codex alias 已存在，跳过"
else
  # 找到 npx 完整路径
  NODE_BIN_DIR="$(dirname "$(which node)")"
  echo "alias codex='OPENAI_API_KEY=\"$API_KEY\" ${NODE_BIN_DIR}/npx -y @openai/codex'" >> "$HOME/.zshrc"
  ok "codex alias 已添加"
fi

# ── 8. macOS LaunchAgent ──
if [[ "$(uname)" == "Darwin" ]]; then
  info "配置 macOS 开机自启 ..."

  LAUNCHD_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LAUNCHD_DIR"

  cat > "$LAUNCHD_DIR/com.codex.deepseek-proxy.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex.deepseek-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>${CODEX_HOME}/codex_proxy.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${CODEX_HOME}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENAI_API_KEY</key>
        <string>${API_KEY}</string>
        <key>PATH</key>
        <string>$(dirname "$(which node)"):/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${CODEX_HOME}/proxy.log</string>
    <key>StandardErrorPath</key>
    <string>${CODEX_HOME}/proxy.err.log</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST

  # 停止旧代理，加载新配置
  launchctl unload "$LAUNCHD_DIR/com.codex.deepseek-proxy.plist" 2>/dev/null || true
  launchctl load "$LAUNCHD_DIR/com.codex.deepseek-proxy.plist"
  ok "LaunchAgent 已装配，开机自启 | 端口 $PROXY_PORT"
else
  warn "非 macOS 系统，跳过 LaunchAgent"
fi

# ── 9. 验证 ──
info "验证代理 ..."
sleep 3
if lsof -i ":$PROXY_PORT" 2>/dev/null | grep -q LISTEN; then
  ok "代理已启动: 127.0.0.1:$PROXY_PORT"
else
  warn "代理未启动，手动启动: node $CODEX_HOME/codex_proxy.js &"
fi

# ── 10. 完成 ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   安装完成！                                     ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}║   启动 Codex:  codex                              ║${NC}"
echo -e "${GREEN}║   切换模型:    /model                              ║${NC}"
echo -e "${GREEN}║   查看日志:    tail -f ~/.codex/proxy.log          ║${NC}"
echo -e "${GREEN}║   重启代理:    launchctl stop com.codex.deepseek-proxy && launchctl start com.codex.deepseek-proxy${NC}"
echo -e "${GREEN}║                                                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo "  新终端生效: source ~/.zshrc (或重新打开终端)"
echo ""
