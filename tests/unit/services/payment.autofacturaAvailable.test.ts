/**
 * resolveAutofacturaAvailable — TPV payment-response `digitalReceipt.autofacturaAvailable`
 *
 * Mirrors `getAutofacturaStatusController` (`src/controllers/public/cfdi.public.controller.ts`):
 * a ticket may self-invoice ONLY when `loadOrderForCfdiFromDb` resolves a bundle with BOTH
 * `facturacionEnabled` and `autofacturaEnabled` true. This is a hot payment path — the resolver
 * must NEVER throw; any lookup error (or missing orderId) must degrade to `false`.
 */
import { resolveAutofacturaAvailable } from '@/services/tpv/payment.tpv.service'
import { loadOrderForCfdiFromDb } from '@/services/fiscal/cfdi.service'

jest.mock('@/services/fiscal/cfdi.service', () => ({
  loadOrderForCfdiFromDb: jest.fn(),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

const mockLoadOrderForCfdiFromDb = loadOrderForCfdiFromDb as jest.MockedFunction<typeof loadOrderForCfdiFromDb>

describe('resolveAutofacturaAvailable', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns true when bundle has facturacionEnabled:true and autofacturaEnabled:true', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({
      facturacionEnabled: true,
      autofacturaEnabled: true,
    } as any)

    const result = await resolveAutofacturaAvailable('order-123')

    expect(result).toBe(true)
    expect(mockLoadOrderForCfdiFromDb).toHaveBeenCalledWith('order-123')
  })

  it('returns false when bundle is null', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue(null)

    const result = await resolveAutofacturaAvailable('order-123')

    expect(result).toBe(false)
  })

  it('returns false when facturacionEnabled:false', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({
      facturacionEnabled: false,
      autofacturaEnabled: true,
    } as any)

    const result = await resolveAutofacturaAvailable('order-123')

    expect(result).toBe(false)
  })

  it('returns false when autofacturaEnabled:false', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({
      facturacionEnabled: true,
      autofacturaEnabled: false,
    } as any)

    const result = await resolveAutofacturaAvailable('order-123')

    expect(result).toBe(false)
  })

  it('returns false when orderId is null (short-circuits, never calls the resolver)', async () => {
    const result = await resolveAutofacturaAvailable(null)

    expect(result).toBe(false)
    expect(mockLoadOrderForCfdiFromDb).not.toHaveBeenCalled()
  })

  it('returns false when orderId is undefined (short-circuits, never calls the resolver)', async () => {
    const result = await resolveAutofacturaAvailable(undefined)

    expect(result).toBe(false)
    expect(mockLoadOrderForCfdiFromDb).not.toHaveBeenCalled()
  })

  it('returns false (never throws) when loadOrderForCfdiFromDb rejects', async () => {
    mockLoadOrderForCfdiFromDb.mockRejectedValue(new Error('DB connection lost'))

    const result = await resolveAutofacturaAvailable('order-123')

    expect(result).toBe(false)
  })
})
