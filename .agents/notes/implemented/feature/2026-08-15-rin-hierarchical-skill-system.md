# Agent Note: Rin hierarchical skill system

Status: implemented

English | [中文](2026-08-15-rin-hierarchical-skill-system.zh.md)

## Problem

The shipped skill filesystem provider scans a fixed two-level root set: the nearest `.git` project root and the user roots (`<dshHome>/skills`, `<agentsHome>/skills`). The user roots are global by design, so a user-global skill such as the `investing` knowledge base was injected into every project session — a Blender session advertised an investing skill. The Rin memory system solved the same class of problem with a directory-chain hierarchy (any level may carry its own store; children inherit ancestors). Skills needed the isomorphic layout without coupling to memory storage.

## Decision

The filesystem provider gains a `rootMode: 'rin'` configuration. In Rin mode the roots are:

- `<cwd>/.dsh-skills`, then each ancestor's `.dsh-skills`, nearest first. The chain uses negative ranks (`-n` for the farthest, `-1` for the nearest) so a nearer directory always wins a duplicate name regardless of chain depth.
- The project compatibility roots `<projectRoot>/.dsh/skills` and `<projectRoot>/.agents/skills` at ranks 100/200, so repository-local instructions keep working.
- `<dshHome>/skills` as the general user layer (rank 400).
- The user-level `<agentsHome>/skills` root is excluded, so user-global skills cannot enter a Rin session. Configured custom and bundled roots remain explicit additions.

`@deepseek-ai/dsh-rin-skill-filesystem` is a thin plugin entry that fixes `providerName: 'rin-filesystem'` and `rootMode: 'rin'` and delegates to the existing filesystem implementation — frontmatter parsing, body loading, `fs/observed` invalidation, and watcher lifecycle are shared, not duplicated. The `skill` tool, the session catalog, and the GUI slash menu keep reading the same `ctx.skills` registry, so a Rin session's catalog and loader stay consistent with the standard provider.

The watcher manager now releases watchers for roots that disappear from a cwd's chain (shared roots and per-workspace project roots), and invalidates the registry cache when the watched topology changes, so switching a session's cwd cannot leave stale watchers or cached catalogs behind.

`SkillSource` gains `rin-workspace` and `rin-user` so consumers can label chain contributions.

## Alternatives considered

**Add a provider-name filter to the skill registry and tool.** Rejected: it would have split the GUI slash menu, the catalog digest, and the loader onto a second selection axis, and the registry contract already resolves duplicates by layer and rank. Isolation belongs to discovery roots, not to a new read option.

**Fork a separate hierarchical provider package that reimplements discovery.** Rejected: frontmatter parsing, watchers, and body loading would have been duplicated and would drift. The wrapper delegates to the shipped implementation.

**Keep `investing` in the user-global layer.** Rejected: that is the pollution being fixed. The skill moved to `D:\Software\Work-software\量化\.dsh-skills\investing`, and the general skills (`knowledge-hub`, `knowledge-write`) stay in `<dshHome>/skills`.

## Consequences

A Rin preset (the user's `rin` and `rin-opt` agent presets) mounts `rin-skill-filesystem` and no longer advertises user-global skills outside their workspace chain. Standard presets keep the two-level behavior unchanged. The `gen-cordis-catalog` policy now classifies the `ctx.memories` types (documented in the dsh-memory README) and `Array` as foundation, and `gen-doc-graphs` classifies the `memories` service role; both were pre-existing documentation gaps that the Rin skill change surfaced through the doc gates.

The hierarchy is inheritance of roots, not nested skill ids: skill names stay kebab-case and discovery stays one level per root. Nested ids remain deferred.
