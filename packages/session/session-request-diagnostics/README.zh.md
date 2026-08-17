# @deepseek-ai/dsh-session-request-diagnostics

[English](README.md) | 中文

可选 collector 将脱敏的请求 fingerprint 与提供方 usage 观察写成 JSONL。只有插件收到明确的 `path` 时才启用；缺失或空路径不会注册监听器。记录只包含会话、轮、步、哈希和 token 数量，不会写入提示词、消息、工具参数或凭据。

```yaml
- id: request-diagnostics
  name: '@deepseek-ai/dsh-session-request-diagnostics'
  config:
    path: '/var/tmp/dsh/request-diagnostics.jsonl'
```

每条事件同步入队、异步追加，因此 agent 事件分发不会等待文件 I/O。目录创建和追加失败只产生 warning，不会使请求失败。插件销毁时尽力排空队列。

## 模型体验

无。collector 只观察瞬时诊断，不修改 session 事件或模型请求。

#### KV Cache 影响

无；它在请求组装后记录 usage 和哈希，不改变提供方输入。

## 已知局限与延后工作

- **尽力而为**——进程崩溃可能丢失队列中的记录，文件失败只告警而不重试。
- **必须明确目的地**——部署必须选择路径；没有默认文件或自动持久化接入。
