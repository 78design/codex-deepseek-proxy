# 更新日志

## v6.0.0 (2026-06-03)

- **架构重构 — reasoning-store 模式**（借鉴 MetaFARS/codex-relay）：用 call_id 索引的 reasonStore 替代 pr/pr_bak 字符串推算，彻底消除 reasoning_content 丢失
- 推理内容按 call_id 精确存储和恢复，不再依赖输入项中不可靠的 reasoning 字段
- 推理输入项现在直接丢弃，由 store 负责恢复
- 工具调用去重：检测 previous_response_id 回放中的重复 call_id 并跳过
- system/developer 消息自动重排到消息列表最前面（即使被夹在 tool 调用之间）
- **移除 token 估算和裁剪**（estok/trim）：不再猜测上下文大小，交给 DeepSeek 报错 + Codex 处理
- 内联 LRU Map 实现，零外部依赖

## v5.0.0 (2026-06-03)

- 全面修复 token 估算精度：content /1.6、tools /1.6、reasoning /1.3（旧版 /2.2 严重低估 ~50%）
- 重写 trim 逻辑：移除有 bug 的 safe/cand 回退机制，四步简单裁剪
- sanitizeSchema：修复 type:null→"object"，自动补 additionalProperties，删除无效属性定义
- reasoning_effort 映射修正：low→low, medium→medium, high→high（旧版 low 被错误映射为 high）
- 流式响应 ID 统一：response.created 和 response.completed 使用同一个 rid
- max_tokens 上限 8192、请求体/响应体缓冲区上限、error handler 补全
## v1.0.4 (2026-06-01)

- **修复上下文过快占满**：token 估算改用全局保守系数 2.2 chars/token，裁剪阈值从 900K 降到 650K
- **CJK 字符检测修复**：正则扩大覆盖中英文标点、全角符号、日韩文，之前漏 ~28% 中文标点导致严重低估
- **双重安全边际**：估算高估 ~15% + 650K 阈值留 ~35%，合计覆盖 ~50% 估算误差

## v1.0.3 (2026-06-01)

- **系统健壮性**：全局 `uncaughtException` / `unhandledRejection` 兜底，防止崩溃
- **请求体保护**：50MB 上限防止超大请求导致内存溢出
- **非流式修复**：上游错误处理 + 客户端断连清理，防止请求挂死
- **性能优化**：`autoTrim` 从 O(n²) 优化为 O(n) 单趟反向裁剪
- **Content-Length**：显式 UTF-8 字节长度声明
- **优雅退出**：SIGTERM / SIGINT 信号处理

## v1.0.2 (2026-06-01)

- **自动裁剪上下文**：请求前估算消息 token 数（中英文混合算法），超过 900K 时自动裁剪历史消息
- 保留 system message + 最近对话轮次，透明降级不中断用户体验
- 裁剪时记录 `[AUTO_TRIM]` 日志

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
