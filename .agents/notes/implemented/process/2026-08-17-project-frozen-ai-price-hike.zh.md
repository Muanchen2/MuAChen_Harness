# Agent Note: 因 AI 模型涨价冻结项目，开发转到 Rin

Status: implemented

[English](2026-08-17-project-frozen-ai-price-hike.md) | 中文

## 问题

DeepSeek API 定价上调，使自托管 harness 的运行方式（每轮对话直接调用 API）成本不可接受。日常 agent 工作迁移到 WorkBuddy 等提供免费额度的工具；为保持跨 agent 的记忆连续性，项目记忆与交接统一转入与 agent 软件解耦的 Rin 记忆系统。

## 决策

- 本仓库冻结主动开发与日常使用。已完成的未推送工作（memory 性能优化、skill 管理、apiproxy 图片降级、请求指纹诊断）全部提交并推送存档，冻结期间仓库保持可恢复状态。
- 日常 agent 工作运行在 WorkBuddy 及其他免费额度工具上。项目记忆与交接单通过 Rin（`rin remember` / `rin status` / `rin read handoff/...`）读写；Rin 与本 harness 共享 `.dsh-memory` 存储格式，换工具不丢失背景。
- 请求指纹诊断（`agent/request-fingerprint` / `agent/request-usage`，经 `DSH_REQUEST_DIAGNOSTICS_PATH` 启用）作为恢复开发时优化 DeepSeek 上下文缓存命中、降低 token 成本的测量基础，随本次提交存档。
- 恢复条件：API 价格回落或预算允许时，从 Rin 路线图「harness 切 core 去重」重新激活本仓库。

## 曾考虑的替代方案

- 继续自托管 harness 但降低使用频率——单次对话成本不变，无法解决成本问题。
- 换用更便宜的提供商/模型——保留为恢复时的选项；指纹诊断可迁移到其他 provider 适配器。

## 后果

- 冻结期间不推进 harness 功能；Rin 成为项目记忆与交接的唯一入口。
- 已提交的 memory 性能优化（39s → 31ms）与请求指纹诊断在恢复时直接可用，无需重做。
- 双方共享存储格式，冻结不丢失任何既有记忆资产。
