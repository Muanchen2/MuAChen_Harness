/**
 * Model-facing `skill-admin` tool over the git-backed Rin skill stores.
 *
 * Distinct from `skill` (read): skill-admin is the write/maintenance side —
 * create, update, archive, remove, history, revert, manual commit, and
 * promotion of loose scripts into proper skills. Every skill root is its own
 * git repository, so all writes are committed and revertable.
 *
 * @module @deepseek-ai/dsh-skill-admin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SkillAdminInput, SkillAdminTarget } from './manager.ts'
import { SkillAdminManager } from './manager.ts'

export type { SkillAdminTarget } from './manager.ts'

export const name = 'tool-skill-admin'
export const inject = ['tools', 'skills', 'systemPrompt']

/** Tool configuration. */
export interface Config {
  /** Where the system-prompt guidance section appears. */
  sectionOrder?: number
  /** Resolved `$DSH_HOME`; defaults to `resolveDshHome()`. */
  dshHome?: string
}

export const Config: Schema<Config> = z.object({
  sectionOrder: z.number().default(116),
  dshHome: z.string(),
})

const ADMIN_GUIDANCE = '使用 skill-admin 工具管理技能库（写/维护面），区别于只读的 skill 工具：'
  + '创建/更新/归档/删除技能、查看与回滚历史、手动补 commit、把 .tmp 脚本提升为正式技能。'
  + '技能层级：user=~/.dsh/skills（跨项目共享）、workspace=当前工作区最近的 .dsh-skills（项目内）。'
  + '每层是独立 git 仓库，写动作自动 commit，随时可 history/revert；技能单线演进，没有 branch/merge。'
  + 'promote 判定：同一脚本被 2+ 任务复用，或主人点名要求固化时。'
  + 'skill-admin 只管理 skill 文件，不碰记忆（记忆用 memory 工具）。'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
    },
  } as const,
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
}

/** Register the `skill-admin` tool and its policy guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.systemPrompt.section({
    name: 'tool:skill-admin',
    order: config.sectionOrder ?? 116,
    text: ADMIN_GUIDANCE,
  })

  const manager = new SkillAdminManager(ctx, resolveDshHome(config.dshHome))

  ctx.tools.register(defineTool({
    name: 'skill-admin',
    description: 'Manage the git-backed skill stores (write/maintenance side, distinct from the read-only skill tool): create, update, archive, remove, list, history, revert, commit, and promote skills.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'update', 'archive', 'remove', 'list', 'history', 'revert', 'commit', 'promote'] },
      target: { type: 'string', description: 'Skill layer to operate on: user (~/.dsh/skills) or workspace (nearest .dsh-skills of the session cwd).' },
      name: { type: 'string', description: 'Kebab-case skill name (required by every action except list/commit).' },
      description: { type: 'string', description: 'Required non-empty description for create/promote; optional field update for update.' },
      whenToUse: { type: 'string', description: 'Optional routing guidance for create/update/promote.' },
      script: { type: 'string', description: 'Optional executable entry name for create/update (script skill).' },
      runtime: { type: 'string', description: 'Optional runtime for the script skill (node, python, pwsh, ...).' },
      content: { type: 'string', description: 'SKILL.md body: required for create/promote, replaces the body for update.' },
      revision: { type: 'string', description: 'Git revision to restore for revert (take it from history).' },
      source: { type: 'string', description: 'Source script path (absolute or cwd-relative) for promote.' },
      message: { type: 'string', description: 'Optional one-line commit message; a default is generated per action.' },
    },
    output: OUTPUT,
    execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      return renderAdmin(manager, ctx, cwd, args).then(text => ({ text }))
    },
    presentCall: args => ({ card: 'generic' as const, title: `skill-admin:${args.action}`, kind: 'other' as const, rawInput: args.name }),
  }))
}

/** Dispatch one skill-admin action and shape the model-visible result. */
async function renderAdmin(
  manager: SkillAdminManager,
  ctx: Context,
  cwd: string | undefined,
  args: {
    action: string
    target?: string
    name?: string
    description?: string
    whenToUse?: string
    script?: string
    runtime?: string
    content?: string
    revision?: string
    source?: string
    message?: string
  },
): Promise<string> {
  const target = args.target as SkillAdminTarget | undefined
  const base: SkillAdminInput = {
    target: target ?? 'workspace',
    cwd,
    name: args.name ?? '',
    ...args.description !== undefined ? { description: args.description } : {},
    ...args.whenToUse !== undefined ? { whenToUse: args.whenToUse } : {},
    ...args.script !== undefined ? { script: args.script } : {},
    ...args.runtime !== undefined ? { runtime: args.runtime } : {},
    ...args.content !== undefined ? { content: args.content } : {},
    ...args.revision !== undefined ? { revision: args.revision } : {},
    ...args.source !== undefined ? { source: args.source } : {},
    ...args.message !== undefined ? { message: args.message } : {},
  }
  switch (args.action) {
    case 'create':
      return manager.create(base)
    case 'update':
      return manager.update(base)
    case 'archive':
      return manager.archive(base)
    case 'remove':
      return manager.remove(base)
    case 'history':
      return manager.history({ target: base.target, cwd, name: base.name })
    case 'revert':
      return manager.revert(base)
    case 'commit':
      return manager.commitChanges({
        target: base.target,
        cwd,
        ...args.message !== undefined ? { message: args.message } : {},
      })
    case 'promote':
      return manager.promote(base)
    case 'list':
      return renderCatalog(ctx, cwd)
    default:
      throw new Error(`skill-admin: unknown action "${args.action}"`)
  }
}

/** Render the layered skill catalog the session sees, with each skill's source. */
async function renderCatalog(ctx: Context, cwd: string | undefined): Promise<string> {
  const skills = await ctx.skills.list({ cwd })
  if (skills.length === 0) return 'no skills available'
  return skills
    .map(skill => `- ${skill.name}: ${skill.description} (source=${skill.source}, provider=${skill.provider})`)
    .join('\n')
}
