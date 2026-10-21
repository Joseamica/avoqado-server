/**
 * resolveAutofacturaAvailable — TPV payment-response `digitalReceipt.autofacturaAvailable`
 *
 * Mirrors `getAutofacturaStatusController` (`src/controllers/public/cfdi.public.controller.ts`):
 * a ticket may self-invoice ONLY when `loadOrderForCfdiFromDb` resolves a bundle with BOTH
 * `facturacionEnabled` and `autofacturaEnabled` true. This is a hot payment path — the resolver
 * must NEVER throw; any lookup error (or missing orderId) must degrade to `false`.
 */
import { resolveAutofacturaAvailable } from '@/services/tpv/payment.tpv.service'
import { loadOrderForCfdiFromDb, ventaConDevolucion } from '@/services/fiscal/cfdi.service'

jest.mock('@/services/fiscal/cfdi.service', () => ({
  loadOrderForCfdiFromDb: jest.fn(),
  ventaConDevolucion: jest.fn(),
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

  it('returns false when the order is outside the safe envelope (unsupportedReasons): the ticket must not offer autofactura for a document the engine would refuse', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({
      facturacionEnabled: true,
      autofacturaEnabled: true,
      unsupportedReasons: ['La cuenta lleva cargo por servicio; …'],
    } as any)

    expect(await resolveAutofacturaAvailable('order-123')).toBe(false)
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

  // T-I2 · A7-R10: el espejo del GET público. Con una devolución completada el ticket (también el RECIBO DE LA DEVOLUCIÓN de la TPV,
  // `refund.tpv.service.ts`) no promete «…y factura».
  it('🔴 A7-R10: venta con devolución completada ⇒ false aunque el comercio la tenga prendida', async () => {
    mockLoadOrderForCfdiFromDb.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true } as any)
    ;(ventaConDevolucion as jest.Mock).mockResolvedValueOnce(true)

    expect(await resolveAutofacturaAvailable('order-123')).toBe(false)
    expect(ventaConDevolucion).toHaveBeenCalledWith('order-123')
  })
})
