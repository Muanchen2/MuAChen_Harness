# @deepseek-ai/dsh-rin-skill-filesystem

English | [中文](README.zh.md)

Hierarchical Rin skill provider for `ctx.skills`.

This plugin is the Rin entry point for local skills. It fixes the provider name to `rin-filesystem` and the discovery mode to the ancestor-chain layout: `<cwd>/.dsh-skills`, each ancestor `.dsh-skills` root from nearest to farthest, and the DSH user root `<dshHome>/skills`. A nearer workspace root wins a duplicate skill name. Project `.dsh/skills` and `.agents/skills` remain low-priority compatibility roots for repository-local instructions; the user-level `.agents/skills` root is excluded so global skills cannot enter a Rin session.

The plugin delegates frontmatter parsing, body loading, filesystem observation, and disposal to `@deepseek-ai/dsh-skill-filesystem`. The registry remains in `@deepseek-ai/dsh-skill`, while `@deepseek-ai/dsh-tool-skill` supplies the shared model-facing catalog and loader. Rin and standard skills therefore use the same `skill` tool without sharing storage roots.

## Plugin

Requires `ctx.skills` (`inject: ['skills']`). The configuration has the same watcher and root controls as the local provider except `providerName` and `rootMode`, which are fixed by this package.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-skill`, which renders the Rin catalog and loads the selected skill body.

#### KV Cache effect

The catalog changes when a Rin root or its frontmatter changes. Body-only edits affect later loads without changing the catalog digest.

## Known Limitations and Deferred Work

- Skill names remain kebab-case and discovery remains one level per root; hierarchy comes from inherited roots rather than nested skill ids.
