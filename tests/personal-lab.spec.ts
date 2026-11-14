import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop() })

it('isolates two synthetic tickets and delivers a replayed follow-up only once', async () => {
  const h = host = await startRuntime()
  const a = await h.acceptedTicket(feishu('101', '@bot summarize fixture A'))
  const b = await h.acceptedTicket(feishu('102', '@bot summarize fixture B'))
  expect(a.sessionId).not.toBe(b.sessionId)
  h.deliveries.mockClear()
  h.runtime.receive(a.trigger)
  const followup = feishu('103', 'Only add the total for fixture A', { mentions: [], root_id: 'om_101' })
  h.runtime.receive(followup)
  h.runtime.receive(followup)
  h.runtime.receive(feishu('104', '@bot read fixture C', { sender_id: 'ou_guest' }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list()).toHaveLength(2)
  expect(h.relays(a.sessionId).filter(item => item.trigger_id === followup.id)).toHaveLength(1)
  expect(h.relays(b.sessionId)).toEqual([])
  await h.runTool(b.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Fixture B completed.' })
  h.runtime.engine.stopTicket(a.ticket.id)
  await expect(h.runTool(a.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Late result' })).rejects.toThrow()
})
