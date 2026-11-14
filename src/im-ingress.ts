import { z } from 'zod'
import type { Trigger } from './core/model.ts'

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.@-]+$/)
const message = z.object({
  platform: z.enum(['qq', 'wechat']), account: id, conversation: id, sender: id,
  messageId: id, threadRoot: id.optional(), parentId: id.optional(),
  chat: z.enum(['direct', 'group']), senderKind: z.enum(['human', 'bot', 'self']),
  addressed: z.boolean(), sentAt: z.iso.datetime({ offset: true }),
  text: z.string().max(4000).trim().min(1),
}).strict()

type Grant = {
  platform: 'qq' | 'wechat'; account: string; conversation: string;
  chat: 'direct' | 'group'; senders: readonly string[];
}

/** Normalize trusted transport metadata. Never pass unverified web requests here. */
export function imIngress(input: unknown, grants: readonly Grant[]):
  { trigger: Trigger } | { reason: 'invalid' | 'non-human' | 'not-allowed' | 'not-addressed' } {
  const parsed = message.safeParse(input)
  if (!parsed.success) return { reason: 'invalid' }
  const event = parsed.data
  if (event.senderKind !== 'human') return { reason: 'non-human' }
  if (!grants.some(grant => grant.platform === event.platform && grant.account === event.account &&
      grant.conversation === event.conversation && grant.chat === event.chat &&
      grant.senders.includes(event.sender))) return { reason: 'not-allowed' }
  if (event.chat === 'group' && !event.addressed && !event.threadRoot) return { reason: 'not-addressed' }

  // No thread root: a new group mention starts a new thread. A transport must
  // resolve replies within this same account and conversation before setting it.
  const scope = [event.platform, event.account, event.chat, event.conversation].join(':')
  const thread = [scope, event.threadRoot ?? (event.chat === 'direct' ? 'direct' : event.messageId)].join(':')
  const source = 'im'
  return { trigger: {
    id: [source, scope, event.messageId].join(':'), source,
    actor: { source, id: [event.platform, event.account, event.sender].join(':') },
    threads: [{ source, id: thread }], human: true,
    ...(event.chat === 'direct' ? { addressed: 'direct' as const } :
      event.addressed ? { addressed: 'mention' as const } : {}),
    at: new Date(event.sentAt).toISOString(), text: event.text,
    meta: { platform: event.platform, account: event.account, conversation: event.conversation,
      ...(event.parentId ? { parentId: [source, scope, event.parentId].join(':') } : {}) },
  } }
}
