jest.mock('@/services/support/store.service', () => ({ claimNext: jest.fn(), readCurrentClaim: jest.fn(), completeClaim: jest.fn() }))
jest.mock('@/services/support/delivery.service', () => ({ deliverSupportMessage: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { claimNext } from '@/services/support/store.service'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import { runSupportBatch } from '@/services/support/worker.service'
import { getContext } from '@/observability/executionContext'
beforeEach(() => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: 'central',
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
  })
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
  ;(prisma.supportMessage.findUnique as jest.Mock).mockResolvedValue({
    answer: 'Respuesta ya guardada',
    conversation: { staffId: null, venueId: null },
  })
})
it('claims at most twenty units, runs at most two at once, and gives each message a fresh context', async () => {
  let serial = 0,
    active = 0,
    peak = 0
  const contexts: string[] = []
  ;(claimNext as jest.Mock).mockImplementation(async () => ({
    messageId: `message-${++serial}`,
    conversationId: 'conversation',
    generation: 1,
    claimToken: 'claim',
    leaseUntil: new Date(Date.now() + 90000),
  }))
  ;(deliverSupportMessage as jest.Mock).mockImplementation(async () => {
    active++
    peak = Math.max(peak, active)
    contexts.push(getContext()!.correlationId)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return 'SENT'
  })
  expect(await runSupportBatch()).toEqual({ claimed: 20, completed: 20, unknown: 0 })
  expect(claimNext).toHaveBeenCalledTimes(20)
  expect(peak).toBe(2)
  expect(new Set(contexts).size).toBe(20)
})
it('does not claim or send when the operator flag is off', async () => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
  expect(await runSupportBatch()).toEqual({ claimed: 0, completed: 0, unknown: 0 })
  expect(claimNext).not.toHaveBeenCalled()
  expect(deliverSupportMessage).not.toHaveBeenCalled()
})
it('counts an uncertain delivery once and never wraps it in a retry', async () => {
  ;(claimNext as jest.Mock)
    .mockResolvedValueOnce({
      messageId: 'message',
      conversationId: 'conversation',
      generation: 1,
      claimToken: 'claim',
      leaseUntil: new Date(Date.now() + 90000),
    })
    .mockResolvedValue(null)
  ;(deliverSupportMessage as jest.Mock).mockResolvedValue('UNKNOWN')
  expect(await runSupportBatch()).toEqual({ claimed: 1, completed: 0, unknown: 1 })
  expect(deliverSupportMessage).toHaveBeenCalledTimes(1)
})
it('waits for the other lane after one fails before rejecting the batch', async () => {
  ;(claimNext as jest.Mock).mockResolvedValueOnce({ messageId: 'one' }).mockResolvedValueOnce({ messageId: 'two' }).mockResolvedValue(null)
  let release!: () => void,
    ended = false
  ;(deliverSupportMessage as jest.Mock).mockRejectedValueOnce(new Error('private provider detail')).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => {
      release = resolve
    })
    ended = true
    return 'SENT'
  })
  let rejected = false
  const batch = runSupportBatch().catch(err => {
    rejected = true
    throw err
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(rejected).toBe(false)
  release()
  await expect(batch).rejects.toThrow('SUPPORT_BATCH_FAILED')
  expect(ended).toBe(true)
})
