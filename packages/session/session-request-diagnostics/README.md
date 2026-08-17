# @deepseek-ai/dsh-session-request-diagnostics

English | [中文](README.zh.md)

The optional collector writes redacted request-fingerprint and provider-usage observations as JSONL. It is disabled unless the plugin receives an explicit `path`; an empty or missing path mounts no listeners. Records contain session, turn, step, hashes, and token counts only. Prompt text, messages, tool arguments, and credentials never enter the file.

```yaml
- id: request-diagnostics
  name: '@deepseek-ai/dsh-session-request-diagnostics'
  config:
    path: '/var/tmp/dsh/request-diagnostics.jsonl'
```

Each event is queued synchronously and appended asynchronously, so the agent event dispatcher does not wait for filesystem I/O. Directory creation and append failures produce warnings and do not fail the request. Plugin disposal drains queued appends on a best-effort basis.

## Model Experience

None. The collector observes transient diagnostics and does not modify session events or model requests.

#### KV Cache effect

None; it records usage and hashes after request assembly without changing provider input.

## Known Limitations and Deferred Work

- **Best effort** — a process crash can lose queued records, and filesystem failures are warned rather than retried.
- **Explicit destination** — deployments must choose a path; there is no default file or automatic persistence integration.
