/**
 * 🔴 Venta manual SIN orden previa (la orden sombra del panel): su lealtad se RECUPERA si el proceso muere.
 *
 * Antes la sombra acreditaba con `updateCustomerMetrics` + `earnPoints` sueltos y nunca dejaba la venta marcada
 * (`loyaltyEligibleAt`): si el proceso moría entre el commit y esas llamadas, el reconciliador no la veía y el cliente perdía
 * su visita, su sello y sus puntos para siempre.
 *
 * Ruling de Codex r3 #2: el camino en línea conserva los números de hoy EXACTOS —la visita suma el total CON propina
 * ($120 por $100 + $20) y los puntos van SIN propina ($100)—. Sólo cambia que la venta nace marcada en su transacción y que,
 * al terminar bien, queda cerrada (el reconciliador ya no la toma); si algo falla queda el error y el reconciliador la
 * recupera con la regla compartida. Corre aquí de verdad, con la fila doblada por `tablaDeUnaVenta`.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
const mockEarnPoints = jest.fn()
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ earnPoints: (...a: unknown[]) => mockEarnPoints(...a) }))
const mockMetrics = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ updateCustomerMetrics: (...a: unknown[]) => mockMetrics(...a) }))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({ lockAreaTicketCheckoutHierarchy: jest.fn(async () => null) }))
jest.mock('@/services/tpv/paymentEffects.service', () => ({ enqueuePaymentCommissionInTx: jest.fn(async () => undefined) }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({ createSalePostingInTx: jest.fn(async () => null) }))
jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashSaleToDrawer: jest.fn(async () => undefined) }))
jest.mock('@/services/giftCards/giftCardLedger', () => ({ activarSobresDeCuentaPagadaEnTx: jest.fn(async () => undefined) }))
const mockOnOrderPaid = jest.fn(async () => undefined)
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: (...a: unknown[]) => mockOnOrderPaid(...(a as [])) }))

import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { tablaDeUnaVenta, type FilaDeLealtad } from '@tests/__helpers__/ordenConMarcasDeLealtad'
import { createManualPayment } from '@/services/dashboard/manualPayment.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'

const VENUE = 'v1'
const STAFF = 'staff1'
const CLIENTE = 'cus-1'
const SOMBRA = 'shadow-1'
/** $100 de venta + $20 de propina, con cliente: la venta manual sin orden previa. */
const venta = { amount: '100', tipAmount: '20', method: 'CASH', source: 'OTHER', customerId: CLIENTE } as const

let fila: FilaDeLealtad | null = null
let creadaDentroDeLaTransaccion: boolean | null = null
let dentro = false
const datosDeLaSombra = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data

/** `updateCustomerMetrics` real deduplica por (cliente, venta) con `CustomerOrderMetric`: la primera visita es la que queda. */
const visitas = new Map<string, number>()
/** `earnPoints` real deduplica por (cliente, venta, EARN) con índice único. */
const puntos = new Map<string, { base: number; staffVenueId: unknown }>()

async function reconciliar() {
  prismaMock.$queryRaw.mockResolvedValue([
    { staffId: fila?.loyaltyStaffId ?? null, primario: CLIENTE, clientes: 1, sellos: [], puntos: [] },
  ])
  const job = new LoyaltyReconciliationJob({
    prisma: { order: tablaDeUnaVenta(fila!), payment: prismaMock.payment } as any,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
    barrerCupones: async () => 0,
    barrerWallet: (async () => undefined) as any,
  })
  return job.runNow()
}

beforeEach(() => {
  fila = null
  creadaDentroDeLaTransaccion = null
  dentro = false
  visitas.clear()
  puntos.clear()
  mockMetrics.mockReset()
  mockMetrics.mockImplementation(async (customerId: string, monto: number, orderId: string) => {
    const llave = `${customerId}:${orderId}`
    if (!visitas.has(llave)) visitas.set(llave, monto)
  })
  mockEarnPoints.mockReset()
  mockEarnPoints.mockImplementation(async (_v: string, customerId: string, base: number, orderId: string, staffVenueId: unknown) => {
    const llave = `${customerId}:${orderId}`
    if (!puntos.has(llave)) puntos.set(llave, { base, staffVenueId })
    return { pointsEarned: Math.floor(base), newBalance: Math.floor(base) }
  })
  prismaMock.$transaction.mockImplementation((async (fn: any) => {
    dentro = true
    try {
      return await fn(prismaMock)
    } finally {
      dentro = false
    }
  }) as any)
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.payment.create.mockImplementation((async ({ data }: any) => ({ id: 'p1', ...data })) as any)
  prismaMock.customer.findFirst.mockResolvedValue({ id: CLIENTE } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: STAFF } as any)
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.exchange.findUnique.mockResolvedValue(null)
  prismaMock.orderCustomer.findMany.mockResolvedValue([
    { customerId: CLIENTE, isPrimary: true, customer: { id: CLIENTE, firstName: 'Ana', lastName: null } },
  ] as any)
  prismaMock.order.create.mockImplementation((async ({ data }: any) => {
    creadaDentroDeLaTransaccion = dentro
    fila = {
      id: SOMBRA,
      venueId: data.venueId,
      total: new Prisma.Decimal(data.total),
      tipAmount: new Prisma.Decimal(data.tipAmount ?? 0),
      loyaltyEligibleAt: data.loyaltyEligibleAt ?? null,
      loyaltyProcessedAt: null,
      loyaltyProcessingAt: null,
      loyaltyLastError: null,
      loyaltyAttempts: 0,
      loyaltyStaffId: data.loyaltyStaffId ?? null,
      customer: data.customerId ? { id: data.customerId, firstName: null, lastName: null } : null,
      clientes: data.customerId ? 1 : 0,
    }
    return { id: SOMBRA }
  }) as any)
  prismaMock.order.updateMany.mockImplementation((async (args: any) =>
    fila ? tablaDeUnaVenta(fila).updateMany(args) : { count: 0 }) as any)
})

afterAll(() => {
  prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
})

describe('venta manual sin orden previa · la lealtad se recupera si el proceso muere', () => {
  it('la sombra con cliente nace con loyaltyEligibleAt (y quien la registró) en la misma transacción que la deja pagada', async () => {
    await createManualPayment(VENUE, STAFF, venta)

    const datos = datosDeLaSombra()
    expect(datos.paymentStatus).toBe('PAID')
    expect(datos.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(datos.loyaltyStaffId).toBe(STAFF)
    expect(creadaDentroDeLaTransaccion).toBe(true)
  })

  it('los números de hoy no cambian: la visita suma $120 (con propina) y los puntos van sobre $100 (sin propina), con quien la registró', async () => {
    await createManualPayment(VENUE, STAFF, venta)

    expect(mockMetrics).toHaveBeenCalledTimes(1)
    expect(mockMetrics).toHaveBeenCalledWith(CLIENTE, 120, SOMBRA, VENUE)
    expect(mockEarnPoints).toHaveBeenCalledTimes(1)
    expect(mockEarnPoints).toHaveBeenCalledWith(VENUE, CLIENTE, 100, SOMBRA, 'sv-1')
  })

  it('venta manual pagada con éxito en línea marca loyaltyProcessedAt y el reconciliador ya no la toma (métricas una sola vez)', async () => {
    await createManualPayment(VENUE, STAFF, venta)

    expect(fila!.loyaltyProcessedAt).toBeInstanceOf(Date)
    const vuelta = await reconciliar()

    expect(vuelta.scanned).toBe(0)
    expect(mockMetrics).toHaveBeenCalledTimes(1)
    expect(mockEarnPoints).toHaveBeenCalledTimes(1)
  })

  it('si el otorgamiento en línea falla, el reconciliador otorga sello y puntos una vez (base $100, mismo cajero) y no repite la visita', async () => {
    mockEarnPoints.mockRejectedValueOnce(new Error('lealtad caída'))

    await expect(createManualPayment(VENUE, STAFF, venta)).resolves.toBeDefined()
    expect(fila!.loyaltyProcessedAt).toBeNull()
    expect(fila!.loyaltyLastError).toBeTruthy()

    const primera = await reconciliar()
    const segunda = await reconciliar()

    expect(primera).toEqual(expect.objectContaining({ scanned: 1, applied: 1, failed: 0 }))
    expect(segunda.scanned).toBe(0)
    expect([...puntos.entries()]).toEqual([[`${CLIENTE}:${SOMBRA}`, { base: 100, staffVenueId: 'sv-1' }]])
    // La visita quedó UNA vez, con los $120 de la corrida en línea: la recuperación no la duplica.
    expect([...visitas.entries()]).toEqual([[`${CLIENTE}:${SOMBRA}`, 120]])
  })

  it('camino raro (documentado): si en línea falló la VISITA, la recuperación la suma sin propina ($100), como la regla compartida', async () => {
    mockMetrics.mockRejectedValueOnce(new Error('candado del cliente'))

    await createManualPayment(VENUE, STAFF, venta)
    expect(fila!.loyaltyProcessedAt).toBeNull()

    await reconciliar()

    expect([...visitas.entries()]).toEqual([[`${CLIENTE}:${SOMBRA}`, 100]])
    expect([...puntos.values()]).toEqual([{ base: 100, staffVenueId: 'sv-1' }])
  })

  it('sin cliente la sombra no deja obligación ni toca lealtad ni referidos, como hoy', async () => {
    await createManualPayment(VENUE, STAFF, { ...venta, customerId: undefined })

    expect(datosDeLaSombra()).not.toHaveProperty('loyaltyEligibleAt')
    expect(mockMetrics).not.toHaveBeenCalled()
    expect(mockEarnPoints).not.toHaveBeenCalled()
    expect(mockOnOrderPaid).not.toHaveBeenCalled()
  })
})
