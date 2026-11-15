/** Structured Discord questions use native reply IDs; internal Worker summaries stay with the orchestrator. */
import type { Ticket, Trigger, WorkerReport, ReplyRequest } from '../core/index.ts'

/** Queue the concrete human-action question once; the orchestrator still composes final results and answers. */
export function deliverDiscordReport(ticket: Ticket, report: WorkerReport, origin: Trigger | undefined,
  reply: (request: ReplyRequest) => unknown): void {
  if (origin?.source !== 'discord' || !origin.channel || !report.question || !ticket.attention) return
  reply({ purpose: 'attention', ticketId: ticket.id, question: ticket.attention.question, text: ticket.attention.question })
}
