# Agent Note: Memory stores own their git repository

Status: implemented

English | [中文](2026-08-14-memory-stores-own-their-git-repository.zh.md)

## Problem

`dsh-memory` keeps each store in its own git repository, but `GitBackend.ensureRepo` decided whether to run `git init` by asking `git rev-parse --is-inside-work-tree`. For a store directory nested inside an unrelated repository — the common case, since a workspace store lives at `<workspace>/.dsh-memory` and most workspaces are themselves git repositories — that probe answers "yes" without any store-owned repository existing, so `git init` is skipped. Every later git operation then runs against the outer repository: `git add -A` stages the memory files there, `commit` writes into outer history, `read` resolves `HEAD:<id>.md` against the outer tree root and never finds the file, and `timeline` reports the outer HEAD. The store silently contaminates the workspace repository's history and the read path can never succeed.

## Decision

`GitBackend.ensureRepo` now checks whether the store directory itself contains a `.git` directory and runs `git init` only when it does not. The store owns its repository regardless of any outer repository: all git commands keep running with the store as cwd and resolve paths against the store root, so nested stores read, list, and timeline correctly and never touch outer history. The check is a plain `fs.stat` of `<store>/.git` rather than a git probe, because the question is ownership of that directory, not membership in some enclosing work tree.

The same change brings `dsh-memory`'s invariant companion in line with the package invariant contract: it now injects `invariants` instead of `memories`, matching every other package's companion.

## Testing

`packages/memory/dsh-memory/tests/service.spec.ts` covers the store contract with real git through `ctx.subprocess`: a store nested inside an unrelated committed repository stays owned (the outer repo's tracked files never grow the memory file, the store carries its own `.git`, and `read`/`timeline` succeed), standalone workspaces record/read/list/timeline, the central store works without a workspace path, a missing id reads as undefined, and a workspace-scoped operation without a workspace path rejects.

## Alternatives considered

**Continue probing the enclosing work tree and accept outer-repo contamination for nested workspaces.** Rejected because most workspaces are git repositories, so the bug would be the default experience, and the contamination writes into unrelated user history.

**Compare `git rev-parse --absolute-git-dir` against `<store>/.git`.** Rejected because the answer still arrives through a git probe that can be confounded by worktree and gitfile setups, while a filesystem check states the ownership question directly; it is also one less subprocess invocation per write.

**Require callers to initialize the repository and fail loudly otherwise.** Rejected because the service contract promises a git-backed store per scope, and `ensureRepo` is the one place that can establish it uniformly.

## Consequences

A store created in a workspace that is itself a repository no longer leaks commits into that repository, and `read` works for every store. The ownership check costs one `stat` per store write, negligible next to the git subprocess invocations. Stores initialized before this change inside a nested outer repository have no store-owned `.git` and were already unusable through `read`; recreating the store (or deleting the leaked outer commits) restores correct behavior rather than migrating anything.
