// tests/integration/commission/efectivoPosMovil.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES S-EF, contra Postgres REAL: ¿el cobro en EFECTIVO del POS móvil genera comisión?
 *
 * Hipótesis del /full-testing final (8-oct), sin medir: `payCashOrder` (`POST /mobile/venues/:id/orders/:orderId/pay`, y la cola
 * sin red `PAY_CASH` del sync, que lo reutiliza) crea el `Payment` COMPLETED pero no encola el efecto `COMMISSION`, mientras la
 * terminal (`recordOrderPayment` / `recordFastPayment`) y la liga de pago sí lo hacen con `enqueuePaymentCommissionInTx`. Si es
 * así, las ventas en efectivo de Android e iOS con orden no comisionan.
 *
 * Lo correcto: el MISMO gancho que la terminal, en la MISMA transacción del cobro (el efecto se congela con el dinero), con la
 * deduplicación por cobro que ya tiene (un efecto por cobro: el reintento con la misma llave no comisiona dos veces).
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/efectivoPosMovil.integration.test.ts --ci --runInBand
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones, procesarEfectos } from './_mundoComisiones'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
}))

let m: MundoComisiones
let n = 0
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('efectivo-pos-movil')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

/** Una cuenta ABIERTA de $100 (sin IVA aparte), como la deja el POS móvil antes de cobrar. */
async function cuentaAbierta(): Promise<string> {
  const D = (x: number) => new Prisma.Decimal(x)
  const o = await prisma.order.create({
    data: {
      venueId: m.venueId,
      orderNumber: `${m.key}-ef-${++n}`,
      subtotal: D(100),
      discountAmount: D(0),
      taxAmount: D(0),
      total: D(100),
      paidAmount: D(0),
      remainingBalance: D(100),
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
    },
  })
  return o.id
}

const comisionesDe = (paymentId: string) => prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId }, take: 10 })
const efectosDe = (paymentId: string) => prisma.paymentEffect.count({ where: { venueId: m.venueId, paymentId, kind: 'COMMISSION' } })

describe('S-EF · el cobro en efectivo del POS móvil genera su comisión', () => {
  it('🔴 en vivo: el efecto de comisión nace con el cobro y el worker deja el 10 % de $100 a quien cobró', async () => {
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, { amount: 10000, tip: 0, staffId: m.ana, idempotencyKey: `ef-vivo-${orderId}` })

    expect(await efectosDe(r.paymentId)).toBe(1)
    await procesarEfectos(m)
    const filas = await comisionesDe(r.paymentId)
    expect(filas.map(f => [f.staffId, f.configId, f.netCommission.toFixed(2)])).toEqual([[m.ana, m.configId, '10.00']])
  })

  it('🔴 la cola sin red (PAY_CASH reproduce payCashOrder con isOfflineReplay) también comisiona', async () => {
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, {
      amount: 10000,
      tip: 0,
      staffId: m.bea,
      idempotencyKey: `ef-cola-${orderId}`,
      isOfflineReplay: true,
    })
    await procesarEfectos(m)
    expect((await comisionesDe(r.paymentId)).map(f => [f.staffId, f.netCommission.toFixed(2)])).toEqual([[m.bea, '10.00']])
  })

  it('🔴 el reintento con la MISMA llave devuelve el mismo cobro y no comisiona dos veces', async () => {
    const orderId = await cuentaAbierta()
    const llave = `ef-reintento-${orderId}`
    const a = await payCashOrder(m.venueId, orderId, { amount: 10000, tip: 0, staffId: m.ana, idempotencyKey: llave })
    const b = await payCashOrder(m.venueId, orderId, { amount: 10000, tip: 0, staffId: m.ana, idempotencyKey: llave })
    expect(b.paymentId).toBe(a.paymentId)
    await procesarEfectos(m)
    expect(await efectosDe(a.paymentId)).toBe(1)
    expect((await comisionesDe(a.paymentId)).map(f => f.netCommission.toFixed(2))).toEqual(['10.00'])
  })

  it('🔴 dividido en dos abonos: cada cobro comisiona SU parte ($6 y $4)', async () => {
    const orderId = await cuentaAbierta()
    const a = await payCashOrder(m.venueId, orderId, { amount: 6000, tip: 0, staffId: m.ana, idempotencyKey: `ef-a-${orderId}` })
    const b = await payCashOrder(m.venueId, orderId, { amount: 4000, tip: 0, staffId: m.bea, idempotencyKey: `ef-b-${orderId}` })
    await procesarEfectos(m)
    expect((await comisionesDe(a.paymentId)).map(f => [f.staffId, f.netCommission.toFixed(2)])).toEqual([[m.ana, '6.00']])
    expect((await comisionesDe(b.paymentId)).map(f => [f.staffId, f.netCommission.toFixed(2)])).toEqual([[m.bea, '4.00']])
  })

  // ── Regresión: sin esquema activo, el cobro sigue igual y no deja nada de comisión ──
  it('sin esquema activo el cobro se registra igual y no hay comisión', async () => {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { active: false } })
    const orderId = await cuentaAbierta()
    const r = await payCashOrder(m.venueId, orderId, { amount: 10000, tip: 0, staffId: m.ana, idempotencyKey: `ef-sin-${orderId}` })
    expect(r.status).toBe('COMPLETED')
    await procesarEfectos(m)
    expect(await comisionesDe(r.paymentId)).toEqual([])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paymentStatus).toBe('PAID')
  })
})
