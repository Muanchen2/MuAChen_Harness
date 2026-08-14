# @deepseek-ai/dsh-memory-accumulate

Rin memory accumulation: turn-end judgment proposes candidate memories for the agent to confirm.

## What this is

The write-side automation half of the Rin memory system (half-automatic distillation). At each turn end an auxiliary LLM call judges whether the turn produced experience worth keeping — a bug fixed, a decision made, a pitfall solved, a learned path. Candidates are cached per session and presented to the agent at the next step boundary as a `rin-accumulate` context message; the agent decides to write them through the `memory` tool (editing or dropping as it sees fit).

The same judgment also proposes a handoff memo when the turn clearly leaves a task unfinished (the user says "next time", or the assistant closes with open next steps and pitfalls), so cross-session handoffs no longer rely on agent self-discipline either; the agent confirms them as `handoff/<task>` memories.

Judgment is the system's — reliable without trusting agent self-discipline — while the write stays a conscious agent action, so noise never enters the stores silently. The `memory` tool's dedup hints (same-directory ids) then steer an accepted candidate toward updating an existing node instead of creating a duplicate.

## Plugin

Injects `llm`.

### Config

| Field | Default | Meaning |
|---|---|---|
| `trigger` | `on-activity` | When to run the judge: `on-activity` (only turns with tool results) or `always` (every turn end). |
| `maxCandidates` | `2` | Max candidate memories or handoff memos one turn may produce. |
| `maxInputMessages` | `12` | Trailing messages the judge sees. |
| `maxInputBytes` | `16384` | Max framed judge input in UTF-8 bytes; larger turns are skipped. |
| `maxOutputTokens` | `512` | Judge output-token cap. |
| `timeoutMs` | `30000` | Judge request deadline. |
| `provider` / `model` | — | Explicit route; defaults to the session's latest `request/header` route. |

## Design

- `session/event` `turn/end` → judge (unless `on-activity` and the turn had no `tools/result`).
- The judge streams an auxiliary `ctx.llm` call (route from config or the latest `request/header`) over the trailing session messages framed as JSON, asking for `{"candidates":[{title, content}], "handoffs":[{title, content}]}` where `handoffs` carries unfinished-task memos (目标/进度/下一步/遗留坑/相关文件 structure); the answer is parsed tolerantly (code fences and stray prose allowed).
- Both lists are deduplicated against the stored ancestor-chain memories by a second verifier call; handoff memos already present as `handoff/<task>` nodes are dropped.
- Candidates are cached per session (`WeakMap`); the next `agent/pre-step` folds one `rin-accumulate` user message into the request and clears the cache, so candidates are presented exactly once.
- Failures (route missing, timeout, parse failure, stream error) are logged and skipped; the session never blocks on judgment.

## Model Experience

### Request context and condition

#### What the model sees

One `rin-accumulate` context message at the first step after a judged turn, when candidates exist:

```markdown
## 记忆沉淀候选（来自第 3 轮）

系统检测到以下可能值得记住的项目经验，请决定是否写入 memory：
1. 修复了 ENOENT
   store 目录缺失导致 spawn 失败
```

A handoff proposal renders as a second section, when present:

```markdown
## 交接单候选（来自第 3 轮）

系统检测到当前任务尚未完成，建议写入 handoff 交接单，下次会话会主动读取衔接：
1. 记忆分支语义收尾
   ## 交接单：记忆分支语义收尾
   目标：交付分支语义
   进度：已完成
   下一步：推送
```

#### Token effect

- Judge calls: one per judged turn, input = trailing messages (bounded by `maxInputMessages`/`maxInputBytes`), output capped by `maxOutputTokens`. A dedup verifier call follows when the ancestor chain holds memories.
- Candidate messages: only when candidates or handoffs exist, once per session.

#### KV Cache effect

Judge calls are out-of-band auxiliary requests with no cache interaction. The `rin-accumulate` message sits in the user prefix of the next step; once presented it is gone, so it does not repeat across steps.

## Known Limitations and Deferred Work

- **Judgment quality depends on the model** — the judge prompt is heuristic; a weak model may propose noise or miss conclusions. The confirmation step is the safety net.
- **`on-activity` keys on tool results only** — a turn that reaches conclusions purely in prose without tool calls is not judged under the default trigger.
- **No automatic write-through** — candidates never enter stores without the agent's `memory` call; a fully automatic mode with thresholds is deferred.
