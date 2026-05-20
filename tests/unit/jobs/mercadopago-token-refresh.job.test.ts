import { MercadoPagoTokenRefreshJob } from '@/jobs/mercadopago-token-refresh.job'
import prisma from '@/utils/prismaClient'
import * as connectionService from '@/services/mercado-pago/connection.service'

jest.mock('@/services/mercado-pago/connection.service')

const mockPrisma = prisma as unknown as {
  paymentProvider: { findUnique: jest.Mock }
  ecommerceMerchant: { findMany: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('MercadoPagoTokenRefreshJob.runNow', () => {
  it('returns zero counts when MERCADO_PAGO provider is not seeded', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue(null)

    const result = await new MercadoPagoTokenRefreshJob().runNow()
    expect(result).toEqual({ total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 })
    expect(connectionService.refreshIfExpiring).not.toHaveBeenCalled()
  })

  it('iterates only MP merchants with providerMerchantId set', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'em_1' }, { id: 'em_2' }, { id: 'em_3' }])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockResolvedValueOnce('refreshed')
      .mockResolvedValueOnce('not_needed')
      .mockResolvedValueOnce('refreshed')

    const result = await new MercadoPagoTokenRefreshJob().runNow()

    expect(mockPrisma.ecommerceMerchant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerId: 'pp_1', providerMerchantId: { not: null } },
        select: { id: true },
      }),
    )
    expect(connectionService.refreshIfExpiring).toHaveBeenCalledTimes(3)
    expect(result.refreshed).toBe(2)
    expect(result.notNeeded).toBe(1)
    expect(result.errors).toBe(0)
  })

  it('counts no_credentials outcomes separately', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'em_1' }, { id: 'em_2' }])
    ;(connectionService.refreshIfExpiring as jest.Mock).mockResolvedValueOnce('no_credentials').mockResolvedValueOnce('merchant_not_found')

    const result = await new MercadoPagoTokenRefreshJob().runNow()
    expect(result.noCredentials).toBe(2) // both bucket into "noCredentials"
    expect(result.errors).toBe(0)
  })

  it('isolates per-merchant errors so one failure does not block the batch', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'em_1' }, { id: 'em_2' }, { id: 'em_3' }])
    ;(connectionService.refreshIfExpiring as jest.Mock)
      .mockRejectedValueOnce(new Error('MP API 503'))
      .mockResolvedValueOnce('refreshed')
      .mockRejectedValueOnce(new Error('Network timeout'))

    const result = await new MercadoPagoTokenRefreshJob().runNow()
    expect(result.errors).toBe(2)
    expect(result.refreshed).toBe(1)
    expect(result.total).toBe(3)
  })

  it('declines to run twice concurrently (re-entrant guard)', async () => {
    mockPrisma.paymentProvider.findUnique.mockResolvedValue({ id: 'pp_1' })
    mockPrisma.ecommerceMerchant.findMany.mockResolvedValue([{ id: 'em_1' }])

    // Use a deferred promise so we control timing precisely
    let resolveRefresh!: (v: string) => void
    const refreshGate = new Promise<string>(r => (resolveRefresh = r))
    ;(connectionService.refreshIfExpiring as jest.Mock).mockReturnValue(refreshGate)

    const job = new MercadoPagoTokenRefreshJob()
    const firstCall = job.runNow()
    // Yield microtasks so the first call reaches refreshIfExpiring and sets isRunning=true
    await new Promise(r => setImmediate(r))
    // Second call while first is mid-flight (refreshIfExpiring still pending)
    const secondCall = job.runNow()
    const secondResult = await secondCall // resolves immediately due to re-entrant guard

    // Now release the first call's pending refresh and let it finish
    resolveRefresh('refreshed')
    const firstResult = await firstCall

    expect(firstResult.total).toBe(1)
    expect(firstResult.refreshed).toBe(1)
    expect(secondResult).toEqual({ total: 0, refreshed: 0, notNeeded: 0, noCredentials: 0, errors: 0 })
  })
})
