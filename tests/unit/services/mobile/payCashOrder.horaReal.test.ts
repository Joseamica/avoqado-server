/**
 * D93 (encargo 18cc7f, founder 16-nov «B», como Square): el cobro de una cuenta que sube de la cola sin red del POS (HTTP `/pay` o el
 * intent `PAY_CASH`) guarda la hora del aparato en `Payment.clientCreatedAt`, SÓLO para reportes. `createdAt` (la llegada) y el
 * movimiento del cajón NO cambian: el corte y la caja siguen preguntando «¿llegó después de X?». En línea, como siempre.
 *
 * (Cabecera heredada de payCashOrder.cashDrawer.test.ts, cuyo andamio se reusa:)
 * El cableado: cobrar en efectivo desde el POS móvil DEBE mover el cajón.
 *
 * `payCashOrder` es el mismo servicio por el que pasan el cobro en línea
 * (`POST /mobile/venues/:venueId/orders/:orderId/pay`) y la reproducción del
 * outbox offline (`PAY_CASH` → `applyPayCash` → `payCashOrder`). Enganchar aquí
 * cubre los dos caminos con UN solo punto.
 *
 * Y lo que NO debe pasar: un cobro declarado a mano (tarjeta de una terminal
 * ajena, transferencia) viaja por este MISMO servicio con `method` distinto de
 * CASH. Ese dinero nunca entró al cajón; sumarlo le inventaría al cajero un
 * faltante por ese monto al cerrar.
 */

// FT-GRAVES S-EF: payCashOrder encola la comisión del cobro en su transacción, igual que la terminal. No es objeto de esta
// suite (su prueba es tests/integration/commission/efectivoPosMovil.integration.test.ts).
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))

jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
}))

jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  cashSaleDrawerLocalId: (paymentId: string) => `pay:${paymentId}`,
}))

import { Decimal } from '@prisma/client/runtime/library'

import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

function installFakeStore() {
  const row = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    venueId: 'venue-1',
    paymentStatus: 'PENDING' as string,
    status: 'CONFIRMED',
    subtotal: new Decimal(100),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(100),
    paidAmount: new Decimal(0),
    remainingBalance: new Decimal(100),
    version: 1,
    areaTicketCode: null,
  }

  const payments: Array<{ id: string; idempotencyKey: string | null }> = []

  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockImplementation(async () => ({ ...row }))
  prismaMock.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const versionMatches = where.version === undefined || where.version === row.version
    const statusMatches = !where.paymentStatus?.in || where.paymentStatus.in.includes(row.paymentStatus)
    if (!versionMatches || !statusMatches) return { count: 0 }
    row.paymentStatus = data.paymentStatus ?? row.paymentStatus
    if (data.version?.increment) row.version += data.version.increment
    return { count: 1 }
  })
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created = { id: `payment-${payments.length + 1}`, idempotencyKey: data.idempotencyKey ?? null }
    payments.push(created)
    return { ...created, ...data, receipts: [] }
  })
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', firstName: 'Ana', lastName: 'Cajera' })
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
  // La caja OPEN al cobrar se lee dentro de la transacción (plan 2026-10-13-sync-retoma-por-llave).
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue({ id: 'caja-abierta' })

  return { row, payments }
}

const LLEGADA = new Date('2026-11-12T02:11:42.000Z') // 20:11:42 en CDMX
const VEINTE_03 = new Date('2026-11-12T02:03:00.000Z')

describe('payCashOrder — la hora del aparato del cobro sin red, sólo para reportes (D93)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(postCashSaleToDrawer as jest.Mock).mockResolvedValue('POSTED')
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    })
    jest.setSystemTime(LLEGADA)
  })
  afterEach(() => jest.useRealTimers())

  const cobrar = (extra: Record<string, unknown>) =>
    payCashOrder('venue-1', 'order-1', { amount: 10000, tip: 0, staffId: 'staff-1', ...extra } as any)
  const datosDelCobro = () => prismaMock.payment.create.mock.calls[0][0].data

  it('P1 el cobro de la cola guarda la hora del aparato aparte; createdAt y el cajón quedan como hoy', async () => {
    installFakeStore()
    await cobrar({ isOfflineReplay: true, createdAtLocal: VEINTE_03.getTime() })
    expect(datosDelCobro().clientCreatedAt).toEqual(VEINTE_03)
    expect(datosDelCobro().createdAt).toBeUndefined()
    expect((postCashSaleToDrawer as jest.Mock).mock.calls[0][0].createdAt).toBeUndefined()
  })

  it('P1 reloj del aparato tres días atrás, o adelantado: no se guarda', async () => {
    installFakeStore()
    await cobrar({ isOfflineReplay: true, createdAtLocal: LLEGADA.getTime() - 3 * 86_400_000 })
    expect(datosDelCobro()).not.toHaveProperty('clientCreatedAt')
    jest.clearAllMocks()
    installFakeStore()
    await cobrar({ isOfflineReplay: true, createdAtLocal: LLEGADA.getTime() + 3_600_000 })
    expect(datosDelCobro()).not.toHaveProperty('clientCreatedAt')
  })

  it('P1 la hora que el intent PAY_CASH recortó al piso de 24 h (clampSoldAt) no se guarda como si fuera real', async () => {
    installFakeStore()
    await cobrar({ isOfflineReplay: true, createdAtLocal: LLEGADA.getTime() - 86_400_000 })
    expect(datosDelCobro()).not.toHaveProperty('clientCreatedAt')
  })

  it('regresión: en línea no se guarda (aunque venga createdAtLocal), ni cambia la hora del cajón', async () => {
    installFakeStore()
    await cobrar({ createdAtLocal: VEINTE_03.getTime() })
    expect(datosDelCobro()).not.toHaveProperty('clientCreatedAt')
    expect(datosDelCobro().createdAt).toBeUndefined()
    expect((postCashSaleToDrawer as jest.Mock).mock.calls[0][0].createdAt).toBeUndefined()
  })

  it('regresión: de la cola sin hora legible, como hoy', async () => {
    installFakeStore()
    await cobrar({ isOfflineReplay: true })
    expect(datosDelCobro()).not.toHaveProperty('clientCreatedAt')
  })
})
