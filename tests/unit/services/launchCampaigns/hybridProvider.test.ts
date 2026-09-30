import prisma from '@/utils/prismaClient'
import { recordedStripeWrite } from '@/services/launchCampaigns/hybridProvider'

const db = prisma as any
const request = { customer: 'cus_test', items: [{ price: 'price_test', quantity: 1 }] }
let row: any
beforeEach(() => {
  row = { id: 'op_test', purchaseId: 'purchase', step: 'SUBSCRIPTION', request, status: 'PENDING', providerId: null, createdAt: new Date() }
  db.hybridBillingOperation.upsert.mockImplementation(async ({ create }: any) => {
    row.requestHash ??= create.requestHash
    return row
  })
  db.hybridBillingOperation.update.mockImplementation(async ({ data }: any) => Object.assign(row, data))
})

describe('durable provider writes', () => {
  it('records the request before making the call and uses its stable operation identity', async () => {
    const perform = jest.fn(async (saved, key) => {
      expect(db.hybridBillingOperation.upsert).toHaveBeenCalled()
      expect(saved).toEqual(request)
      expect(key).toBe('hybrid:op_test')
      return { id: 'sub_test' }
    })
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)).resolves.toEqual({ id: 'sub_test' })
    expect(row).toMatchObject({ status: 'OBSERVED', providerId: 'sub_test' })
  })
  it('adopts an object recovered after a lost response without creating another', async () => {
    const perform = jest.fn()
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => ({ id: 'sub_test' }))).resolves.toEqual({
      id: 'sub_test',
    })
    expect(perform).not.toHaveBeenCalled()
  })
  it('rejects a different body for the same durable operation', async () => {
    row.requestHash = 'other'
    const perform = jest.fn()
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)).rejects.toThrow(/cambió/i)
    expect(perform).not.toHaveBeenCalled()
  })
  it('does not retry a blind creation after the provider idempotency window', async () => {
    row.createdAt = new Date(Date.now() - 24 * 3600000)
    const perform = jest.fn()
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)).rejects.toMatchObject({
      code: 'HYBRID_PROVIDER_UNKNOWN',
    })
    expect(perform).not.toHaveBeenCalled()
  })
  it('keeps a timeout unknown and reuses the same key on a safe retry', async () => {
    const perform = jest.fn().mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce({ id: 'sub_test' })
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)).rejects.toThrow(/confirmar/i)
    expect(row.status).toBe('UNKNOWN')
    await recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)
    expect(perform.mock.calls.map(call => call[1])).toEqual(['hybrid:op_test', 'hybrid:op_test'])
  })
  it('never recreates an observed object when its readback cannot confirm it', async () => {
    row.providerId = 'sub_test'
    row.status = 'OBSERVED'
    const perform = jest.fn()
    await expect(recordedStripeWrite('purchase', 'SUBSCRIPTION', request, perform, async () => null)).rejects.toThrow()
    expect(perform).not.toHaveBeenCalled()
  })
})
