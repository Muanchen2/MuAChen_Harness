# Agent Note: Project frozen — AI price hike suspends harness development

Status: implemented

English | [中文](2026-08-17-project-frozen-ai-price-hike.zh.md)

## Problem

DeepSeek API price increases make self-hosted harness operation (each turn calls the API directly) cost-prohibitive. Routine agent work moves to WorkBuddy and other tools with free quota; to keep memory continuity across agents, project memory and handoffs move to the agent-agnostic Rin memory system.

## Decision

- The repository is frozen for active development and routine use. Completed unpushed work (memory performance optimization, skill management, apiproxy image degradation, request-fingerprint diagnostics) is committed and pushed as archival state; the tree remains recoverable.
- Routine agent work runs on WorkBuddy and other free-quota tools. Project memory and handoffs are read and written through Rin (`rin remember` / `rin status` / `rin read handoff/...`), which shares the `.dsh-memory` storage format with this harness, so switching tools loses no context.
- Request-fingerprint diagnostics (`agent/request-fingerprint` / `agent/request-usage`, enabled via `DSH_REQUEST_DIAGNOSTICS_PATH`) ship as the measurement base for DeepSeek context-cache hit optimization when development resumes.
- Resumption condition: when API pricing becomes affordable again, reactivate this repository from the Rin roadmap item "harness switches to Rin core".

## Alternatives considered

- Keep self-hosting the harness at lower frequency — the per-turn cost is unchanged, so it does not solve the cost problem.
- Switch to a cheaper provider or model — kept as an option at resume time; the fingerprint diagnostics port to other provider adapters.

## Consequences

- No harness features advance during the freeze; Rin is the single entry for project memory and handoffs.
- The committed memory performance work (39 s → 31 ms) and fingerprint diagnostics remain directly usable on resume.
- The shared storage format means the freeze loses no existing memory assets.
