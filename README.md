# DSh Antigravity Empty Response Recovery 0.3.1

面向 DSh `0.1.6-alpha.2` 的一体化 SUB2API / Antigravity 空响应恢复插件。

## 目标

无需 Python Proxy、无需单独进程。插件自己注册一个 DSh LLM provider adapter，直接向 SUB2API 发 OpenAI-compatible `/chat/completions` 请求，并负责完整恢复链：

1. 原请求
2. 原请求 retry
3. `tool_choice: none`
4. 通知 DSh `agent/request-error`
5. `ctx.compaction.compactIfNeeded(..., 'context-overflow', ...)`
6. DSh 从压缩后的 durable session 重新构造请求
7. 压缩后的请求再次经过本插件
8. 仍为空时 synthetic fallback

DSH 当前官方 LLM adapter 合约要求插件继承 `LlmAdapter`、实现 `stream()` 并通过 `ctx.llm.registerAdapter()` 注册 provider；`GenerateOptions` 本身没有 `tool_choice`，所以 `tool_choice:none` 在本插件的 provider wire 层实现。详见官方文档。 

## 配置

```yaml
plugins:
  - dsh-antigravity-empty-response-recovery:
      enabled: true
      providers:
        - sub2api-antigravity-recovery
      upstreamBaseUrl: http://127.0.0.1:3000/v1
      apiKey: ''
      timeoutMs: 300000
      retryOriginal: 1
      enableToolChoiceNone: true
      compactAfterToolChoiceNone: true
      postCompactionRetry: 1
      syntheticFallback: true
      logLevel: info
      includeRequestBodyInDebugLog: false
```

然后 DSh 路由必须使用：

```yaml
provider: sub2api-antigravity-recovery
model: gemini-3.8-flash-tiered
```

不能把新 provider 仍然写成 `sub2api`，因为 DSh 当前一个 provider route 只能由一个 adapter 持有，重复注册会得到 `DUPLICATE_ADAPTER`。

## 日志

默认 `logLevel: info`。

典型成功：

```text
[AG-RECOVERY ...] plugin:ready {...}
[AG-RECOVERY ...] request:start {...}
[AG-RECOVERY ...] recovery:success {"strategy":"original"}
```

典型空响应恢复：

```text
[AG-RECOVERY ...] recovery:empty {"strategy":"original"}
[AG-RECOVERY ...] recovery:empty {"strategy":"original-retry"}
[AG-RECOVERY ...] recovery:tool_choice:none {...}
[AG-RECOVERY ...] recovery:empty {"strategy":"tool-choice-none"}
[AG-RECOVERY ...] recovery:compaction-required {...}
[AG-RECOVERY ...] compaction:start {...}
[AG-RECOVERY ...] compaction:end {"progressed":true,...}
[AG-RECOVERY ...] recovery:success {"strategy":"original"}
```

最终失败：

```text
[AG-RECOVERY ...] recovery:post-compaction-empty {"action":"synthetic-fallback"}
```

## 日志级别

- `silent`: 不输出插件日志
- `error`: 只输出恢复失败
- `warn`: 输出空响应、tool_choice:none、无进展压缩
- `info`: 推荐；输出恢复阶段
- `debug`: 额外输出 upstream HTTP 状态、响应字节数；`includeRequestBodyInDebugLog=true` 时还输出请求 body，生产环境不要开启

## 测试覆盖（0.3.1）

`npm test` 会先构建插件，再以 mock Cordis context 捕获通过 `apply()` 注册的真实 adapter。回归测试覆盖：

- 正常响应、原请求 retry 与 `tool_choice: none`。
- SSE text、reasoning、usage 以及分片 tool-call 参数。
- HTTP `429`/`5xx` 透传、已取消请求、畸形 SSE。
- compaction 触发后 synthetic fallback 的一次性消费，以及禁用 fallback 时的 `EMPTY_RESPONSE` 终态。

未使用真实 SUB2API 或 Antigravity 服务进行长时间运行验证。

## 重要说明

为了可靠判断空响应，插件会完整缓冲一次 upstream SSE，再决定是否重试。因此只有发生恢复判断的这条链路会牺牲首 token 延迟；这是为了避免已经把一个空 `finish` 转发给 DSh 后再无法改变当前 attempt。

插件不会修改 DSh Session 文件。压缩仍由 DSh 原生 compaction seam 完成；`agent/request-error` 在压缩产生 durable surface replacement 后返回 `{ kind: 'retry' }`，由 Agent Loop 重新构造请求。
