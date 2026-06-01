# 更新日志

## v1.0.0 (2026-06-01)

- 核心修复：连续 function_call item 合并为单条 assistant(tc:N) 消息
- text-only assistant 的文本和 reasoning_content 自动提升到后续 tool_calls assistant
- flush-on-boundary 策略确保 tool results 紧随正确的 assistant 消息
- 完善的 SSE 错误处理与优雅降级
- 支持 DeepSeek V4 全系列模型
- macOS LaunchAgent 自启配置模板
- 完整中英文 README 文档
