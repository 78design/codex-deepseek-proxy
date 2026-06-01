# 更新日志
## v1.0.1 (2026-06-01)

- 上下文超限自动处理：检测到 DeepSeek context length 限制时，返回 200 + 友好提示（`/clear` 或 `/compact`），不再让 Codex 无限重试 400
- 错误分类处理：context overflow 返回降级消息，其他 API 错误仍正常报错


## v1.0.0 (2026-06-01)

- 核心修复：连续 function_call item 合并为单条 assistant(tc:N) 消息
- text-only assistant 的文本和 reasoning_content 自动提升到后续 tool_calls assistant
- flush-on-boundary 策略确保 tool results 紧随正确的 assistant 消息
- 完善的 SSE 错误处理与优雅降级
- 支持 DeepSeek V4 全系列模型
- macOS LaunchAgent 自启配置模板
- 完整中英文 README 文档
