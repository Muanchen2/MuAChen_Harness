/**
 * Hierarchical Rin skill provider.
 *
 * The provider reuses the local filesystem implementation while fixing its
 * discovery mode to the Rin directory chain. Rin skills live in
 * `.dsh-skills` directories along the workspace ancestor chain; the standard
 * project/user roots remain available through `dsh-skill-filesystem`.
 *
 * @module @deepseek-ai/dsh-rin-skill-filesystem
 */

import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
import z from '@deepseek-ai/schemastery'
import type { Config as FileSystemConfig } from '@deepseek-ai/dsh-skill-filesystem'
import * as FileSystemSkills from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'rin-skill-filesystem'
export const inject = ['skills']

/** Configuration for the hierarchical Rin skill provider. */
export interface Config {
  /** Whether the DSH project and user roots are included around the Rin chain. */
  includeDefaultRoots?: boolean
  /** DeepSeek Harness config root containing the shared `skills` directory. */
  dshHome?: string
  /** Additional skill roots scanned after the Rin chain. */
  customSkillDirs?: string[]
  /** Whether host-local skill roots are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling for existing skill roots. */
  watchUsePolling?: boolean
  /** Stable-write window for watched skill entries, in milliseconds. */
  watchStabilityThresholdMs?: number
  /** Polling and missing-path probe interval, in milliseconds. */
  watchPollIntervalMs?: number
  /** Maximum number of workspace cwd watcher groups retained. */
  watchMaxProjects?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
  /** Explicit packaged skill root. */
  bundledSkillDir?: string
}

/** Validate Rin provider configuration; root mode and provider name are owned here. */
export const Config: Schema<Config> = z.object({
  includeDefaultRoots: z.boolean().default(true),
  dshHome: z.string(),
  customSkillDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(200),
  watchPollIntervalMs: z.number().default(100),
  watchMaxProjects: z.number().default(128),
  watchFollowSymlinks: z.boolean().default(true),
  bundledSkillDir: z.string(),
})

/** Register the fixed Rin hierarchy provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  const providerConfig: FileSystemConfig = {
    ...(config.includeDefaultRoots !== undefined ? { includeDefaultRoots: config.includeDefaultRoots } : {}),
    ...(config.dshHome !== undefined ? { dshHome: config.dshHome } : {}),
    ...(config.customSkillDirs !== undefined ? { customSkillDirs: config.customSkillDirs } : {}),
    ...(config.watch !== undefined ? { watch: config.watch } : {}),
    ...(config.watchUsePolling !== undefined ? { watchUsePolling: config.watchUsePolling } : {}),
    ...(config.watchStabilityThresholdMs !== undefined ? { watchStabilityThresholdMs: config.watchStabilityThresholdMs } : {}),
    ...(config.watchPollIntervalMs !== undefined ? { watchPollIntervalMs: config.watchPollIntervalMs } : {}),
    ...(config.watchMaxProjects !== undefined ? { watchMaxProjects: config.watchMaxProjects } : {}),
    ...(config.watchFollowSymlinks !== undefined ? { watchFollowSymlinks: config.watchFollowSymlinks } : {}),
    ...(config.bundledSkillDir !== undefined ? { bundledSkillDir: config.bundledSkillDir } : {}),
    providerName: 'rin-filesystem',
    rootMode: 'rin',
  }
  FileSystemSkills.apply(ctx, providerConfig)
}
