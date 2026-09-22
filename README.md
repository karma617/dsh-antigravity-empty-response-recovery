# DSh Antigravity Empty Response Recovery 0.4.0

面向 DSh `0.1.6-alpha.2` / DSH Desktop 的全自动 SUB2API / Antigravity 空响应恢复插件。

## 核心特性 (v0.4.0)

1. **全局流拦截器 (Universal Stream Interceptor)**：
   - 监听 DSH 底层 `ctx.on('llm/stream')` 瀑布流钩子，无缝覆盖 **所有** Provider（包括 `gemini`, `sub2api`, `anthropic-messages`, 以及多模型调度器 `dsh-multi-model-orchestrator` 下派生的所有子代理/模型）。
   - 用户无需更改 Provider 名称为独立渠道，直接使用系统原有的 `gemini` 即可享受保护。
2. **多层级无感恢复策略**：
   - **Tier 1 (Nudge Retry)**: 遇到 Gemini Flash 只输出 thinking 或空响应直接 `stop` 时，自动追加单轮继续提示词（例如：“上一个操作已执行完毕。请分析当前执行结果并继续完成任务或输出结论。”）触发二次推理。
   - **Tier 2 (No-Tools Retry)**: 若模型在 Tool 调用时卡死空响应，临时剔除 tools 参数强制纯文本回复，打破模型思考死循环。
   - **Tier 3 (Synthetic Fallback 兜底保活)**: 若多次重试依然空响应，插件直接返回合法的合成文本响应（`finish: stop`），避免抛出 `EMPTY_RESPONSE` 导致 `agent-loop` 崩溃报错 `returned a completed response with no content`。
   - **Tier 4 (Context Compaction 上下文压缩)**: 注册 `agent/request-error` 高优先级钩子，当发生上下文超限或空响应异常时，触发 DSH 原生压缩。
3. **独立磁盘日志追踪 (File Logging)**：
   - DSH 桌面端 (Electron) 默认不会将后端控制台输出写盘，导致排查困难。
   - 本插件内置持久化滚动文件日志，实时写入：
     `C:\Users\Administrator\.dsh\antigravity-recovery.log`
   - 自动按 10MB 滚动备份，完整记录每一次拦截、重试、恢复或兜底状态。

## 默认配置 (`cordis.patch.yml`)

```yaml
- insert:
    - id: dsh-antigravity-empty-response-recovery
      name: 'dsh-antigravity-empty-response-recovery'
      config:
        enabled: true
        interceptAllProviders: true
        targetModels:
          - gemini
          - antigravity
          - flash
        retryWithNudge: true
        nudgePrompt: '上一个操作已执行完毕。请分析当前执行结果并继续完成任务或输出结论。'
        enableToolChoiceNone: true
        syntheticFallback: true
        syntheticResponse: '已自动捕获并恢复前序空响应。当前任务上下文已完整保留，请继续下一步操作。'
        logFilePath: '' # 默认为 C:\Users\Administrator\.dsh\antigravity-recovery.log
        logLevel: info
```

## 日志查看

在运行 DSH 桌面端时，可在终端或 PowerShell 中实时监控日志：

```powershell
Get-Content -Path "C:\Users\Administrator\.dsh\antigravity-recovery.log" -Wait -Tail 30
```

典型日志输出：
```text
[2026-09-21T05:25:18.832Z] [INFO ] [PluginInit] Antigravity Empty Response Recovery v0.4.0 active
[2026-09-21T05:30:12.100Z] [WARN ] [EmptyDetected] Upstream returned empty response with NO content! {"model":"gemini-3.8-flash-tiered"}
[2026-09-21T05:30:12.105Z] [INFO ] [NudgeRetry] Attempting nudge retry with continuation prompt...
[2026-09-21T05:30:14.320Z] [INFO ] [RecoverySuccess] Nudge retry SUCCEEDED with content! Forwarding to agent.
```

## 测试覆盖

运行完整单元测试套件：
```bash
node --test test/recovery.test.mjs test/universal-stream.test.mjs
```
包含了 16 项针对正常请求、空响应重试、工具剥离重试、合成流生成、上下文压缩等核心场景的端到端单测。
