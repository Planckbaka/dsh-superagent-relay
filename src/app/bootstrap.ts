/** One-time, operator-owned initialization of a native deployment; credentials remain in private account files. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { SettingsSchema, type Settings } from '../policy.ts'
import { discordCredentials } from '../sources/discord.ts'

export const BootstrapSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  githubCli: z.string().startsWith('/'),
  agentLogin: z.string().regex(/^[A-Za-z0-9-]+$/),
  githubAllowed: z.array(z.string().regex(/^[A-Za-z0-9-]+$/)).default([]),
  discordConfigFile: z.string().startsWith('/').optional(),
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
}).strict()

/** Parse the private bootstrap file and fill only a fresh profile; later changes belong to the authenticated panel. */
export function bootstrapSettings(file: string, current: Settings): { settings: Settings; agentLogin: string } {
  let config: z.infer<typeof BootstrapSchema>
  try {
    const text = readFileSync(file, 'utf8')
    if (text.length > 16000) throw new Error('oversize')
    config = BootstrapSchema.parse(JSON.parse(text))
  } catch { throw new Error('Invalid Superagent bootstrap configuration') }
  if (config.agentLogin.toLowerCase() === config.repository.split('/')[0]!.toLowerCase()) {
    throw new Error('Use a dedicated agent identity, separate from the repository owner')
  }
  if (Object.keys(current.sources).length) throw new Error('Bootstrap requires a fresh profile; configure existing profiles in the management panel')
  const discord = config.discordConfigFile
    ? discordCredentials(config.discordConfigFile) : undefined
  const prepare = `git clone --filter=blob:none -- https://github.com/${config.repository}.git "$DSH_SUPERAGENT_DIR" && git -C "$DSH_SUPERAGENT_DIR" switch -c "agent/$DSH_SUPERAGENT_NAME"`
  return { agentLogin: config.agentLogin, settings: SettingsSchema.parse({ ...current,
    sources: { github: { enabled: true, config: { repository: config.repository, cli: config.githubCli } },
      ...(discord ? { discord: { enabled: true, config: { configFile: config.discordConfigFile } } } : {}) },
    policy: { ...current.policy, sources: {
      github: { allowed: config.githubAllowed.map(id => ({ id })), admission: {} },
      ...(discord ? { discord: { allowed: [{ id: discord.owner }], admission: {} } } : {}),
    } },
    eval: { ...current.eval, mode: 'observe' },
    executor: { ...current.executor, permissionPreset: config.permissionPreset, prepare },
  }) }
}
