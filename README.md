# dsh-antigravity-empty-response-recovery

针对 DSH + Antigravity / Gemini 代理链出现：

```text
model "gemini-3.8-flash-tiered" returned a completed response with no content
```

的插件级恢复方案。

## 设计

```text
provider stream
      │
      ▼
 llm/stream
      │
      ├─ 正常内容 → 原样通过
      │
      └─ finish=stop 且没有任何 content block
                    │
                    ▼
              转成 EMPTY_RESPONSE
                    │
                    ▼
          agent/request-error
                    │
          ┌─────────┴─────────┐
          │                   │
      普通重试一次         重试仍为空
                              │
                              ▼
                    ctx.compaction.compactIfNeeded(..., 'context-overflow', ...)
                              │
                              ▼
                    ctx.compaction.compactIfNeeded(..., 'context-overflow', ...)
                              │
                              ▼
                   DSH 从压缩后的 durable
                   session 重新构造请求
                              │
                              ▼
                           retry
```

插件不修改 frozen request，也不直接操作 session 文件。

## DSH 兼容性

目标版本：

- DSH `0.1.6-alpha.2`
- Node `>=22.19.0`
- `@deepseek-ai/cordis` `^4.0.1`
- `@deepseek-ai/dsh-llm` `0.1.6-alpha.2`
- `@deepseek-ai/dsh-compaction` `0.1.6-alpha.2`

DSH `0.1.6-alpha.2` 已公开 `agent/request-error`、`llm/stream` 和 `ctx.compaction` 这些扩展点；`request-error` 返回 `{ kind: 'retry' }` 时，Agent Loop 会从 durable session 重新构造下一次请求。

## 安装

先关闭 DSH，然后：

```powershell
dsh plugin --profile web add .\dsh-antigravity-empty-response-recovery
```

如果插件已经打成 tgz：

```powershell
dsh plugin --profile web add .\dsh-antigravity-empty-response-recovery-0.1.0.tgz
```

然后：

```powershell
dsh --profile web --dump-config
```

确认出现：

```text
dsh-antigravity-empty-response-recovery
```

最后重新启动 DSH。

## 默认策略

- `maxEmptyRetriesBeforeCompact = 1`
  - 第一次检测到 EMPTY_RESPONSE：先让 DSH 再重试一次。
  - 第二次仍 EMPTY_RESPONSE：执行一次强制 compaction。
- `maxCompactionsPerTurn = 1`
  - 同一 turn 最多主动压缩一次。
- 压缩失败：不伪造模型内容，恢复原始错误。
- 正常响应：完全不介入。

## 为什么不直接调用 `compactIfNeeded`

这里故意使用 `compactNow()`。

`compactIfNeeded(..., 'context-overflow', ...)` 是策略型接口，而本插件是在“连续空响应已经确认”的情况下主动维护上下文，所以需要显式 compaction。

`compactNow()` 会通过 `ctx.compaction.compactIfNeeded(..., 'context-overflow', ...)` 在 idle 边界安全执行，并在成功后由 Agent Loop 通过 `{ kind: 'retry' }` 重新构造请求。

## 注意

这个插件解决的是 DSH 侧“空响应后的恢复”。

它不会修复 SUB2API / Antigravity 本身产生空响应的根因；它只是利用 DSH 官方公开的 stream、request-error 和 compaction seam 做自动恢复。

如果你的请求本身已经大到“单个不可拆分的请求 envelope 就超过模型限制”，compaction 也可能无法修复，此时插件会保留原始错误。
