/**
 * Lealtad de un cambio de producto contra un Postgres real (spec 2026-10-20 §7.7):
 * - el cambio no le quita el sello a la venta original: sus devoluciones (el gemelo del crédito, `CREDIT`, y la diferencia
 *   devuelta, `DIFFERENCE`) no cuentan como «la venta tiene un reembolso»; la cadena (`CHAIN`) y los reembolsos de siempre sí;
 * - la venta nueva da puntos sólo sobre lo cobrado de más y nunca un sello, también cuando la recupera el reconciliador o se le
 *   liga un cliente después (la TPV no recibe un «no sumó por error»).
 *
 * Todo real: el reconciliador (con su envoltorio por defecto), `awardLoyaltyForPaidOrder`, `earnPoints` y `grantStamp`.
 *
 * Correr (sólo en una base DESECHABLE, nunca av-db-25): exporta TEST_DATABASE_URL hacia ella y luego
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/exchanges/exchangeLoyalty.integration.test.ts --runInBand --ci
 *
 * Cada corrida usa su propio negocio con nombres únicos y sólo limpia lo de ese negocio.
 */
import { Prisma, type Payment } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn(async () => undefined) }))
// El aviso al pase y el correo del primer sello salen hacia afuera: aquí no aportan.
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
// El plan del negocio no es lo que se prueba: con LOYALTY_PROGRAM los puntos y los sellos corren de verdad.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { grantStamp } from '@/services/wallet/stampLedger.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { addCustomerToOrder } from '@/services/tpv/order.tpv.service'
import { awardLoyaltyForLateCustomer } from '@/services/shared/loyaltyOnLateCustomer'
import { ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { ventaTieneReembolso } from '@/services/shared/ligaDeClienteEnVenta'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

const D = (pesos: number) => new Prisma.Decimal(pesos)
const SUF = `cambio-lealtad-${process.pid}-${Date.now()}`
let venueId: string
let staffId: string
let ecTenderId: string
let n = 0

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('cambio-lealtad'))
  ecTenderId = (await ensureExchangeCreditTender(prisma, venueId)).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, stampsEnabled: true, stampsRequired: 7, maxStampsPerDay: 0 },
  })
})

afterAll(async () => {
  // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  if (!venueId) return
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await prisma.stampReward.deleteMany({ where: { venueId } })
  await prisma.stampEvent.deleteMany({ where: { venueId } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId } })
  await prisma.exchange.deleteMany({ where: { venueId } }) // sus ligas del crédito se van en cascada
  await limpiarNegocioDePrueba(venueId)
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

async function cliente(nombre: string): Promise<string> {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId, firstName: nombre, phone: `+52557788${String(i).padStart(4, '0')}` } })).id
}

/** Una venta cobrada hace un minuto con su lealtad PENDIENTE (el proceso murió antes de cerrarla) y su cobro en efectivo. */
async function ventaPendiente(total: number, primario?: string): Promise<{ orderId: string; cobro: Payment }> {
  const orderId = (
    await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${SUF}-${++n}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: D(total),
        taxAmount: D(0),
        tipAmount: D(0),
        total: D(total),
        paidAmount: D(total),
        remainingBalance: D(0),
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        createdById: staffId,
        loyaltyEligibleAt: new Date(Date.now() - 60_000),
      },
    })
  ).id
  if (primario) await prisma.orderCustomer.create({ data: { orderId, customerId: primario, isPrimary: true } })
  return { orderId, cobro: await movimiento(orderId, total) }
}

/** Un cobro (importe positivo) o una devolución (`type: 'REFUND'`, importe negativo) en efectivo, salvo que se diga otra cosa. */
function movimiento(orderId: string, pesos: number, extra: Partial<Prisma.PaymentUncheckedCreateInput> = {}): Promise<Payment> {
  return prisma.payment.create({
    data: {
      venueId,
      orderId,
      amount: D(pesos),
      tipAmount: D(0),
      netAmount: D(pesos),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'POS',
      fundsFlow: 'CASH_DRAWER',
      processedById: staffId,
      ...extra,
    },
  })
}

const conCredito: Partial<Prisma.PaymentUncheckedCreateInput> = {
  method: 'OTHER',
  fundsFlow: 'EXTERNAL_RECORDED',
  tenderRevision: 1,
}

/** El registro del cambio (sin FK: basta con los ids). */
function registrarCambio(p: {
  originalOrderId: string
  originalPaymentId: string
  newOrderId: string
  returned: number
  taken: number
}): Promise<{ id: string }> {
  const diferencia = p.taken - p.returned
  return prisma.exchange.create({
    data: {
      venueId,
      idempotencyKey: `${SUF}-x${++n}`,
      requestHash: 'a'.repeat(64),
      status: 'COMPLETED',
      originalOrderId: p.originalOrderId,
      originalPaymentId: p.originalPaymentId,
      newOrderId: p.newOrderId,
      returnedAmount: D(p.returned),
      takenAmount: D(p.taken),
      differenceAmount: D(diferencia),
      settlementKind: diferencia === 0 ? 'EVEN' : diferencia > 0 ? 'COLLECT' : 'PAYOUT',
      settlementMethod: diferencia === 0 ? null : 'CASH',
      lines: [],
      staffId,
    },
    select: { id: true },
  })
}

/** La marca que escribe el cambio en sus devoluciones. */
const marca = (exchangeId: string, role: 'CREDIT' | 'DIFFERENCE' | 'CHAIN', raiz: string) => ({
  originalPaymentId: raiz,
  exchange: { exchangeId, role, rootPaymentId: raiz },
})

/** El reconciliador REAL (su envoltorio por defecto), acotado a ESTA venta: otras pruebas pueden compartir la base. */
function reconciliadorDe(orderId: string) {
  const soloEsta = (args: any) => ({ ...args, where: { AND: [args.where, { id: orderId }] } })
  return new LoyaltyReconciliationJob({
    prisma: {
      order: {
        findMany: (args: any) => prisma.order.findMany(soloEsta(args)),
        updateMany: (args: any) => prisma.order.updateMany(soloEsta(args)),
      },
    } as never,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
  })
}

const sellos = (orderId: string, type: 'EARN' | 'REVERSAL') => prisma.stampEvent.count({ where: { venueId, orderId, type } })
const procesada = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { loyaltyProcessedAt: true } })).loyaltyProcessedAt

describe('ventaTieneReembolso against a real database: the refunds of an exchange do not count', () => {
  type Fila = 'ORDINARIA' | 'SIN_DATOS' | 'JSON_NULL' | 'CAMBIO_SIN_PAPEL' | 'CREDIT' | 'DIFFERENCE' | 'CHAIN' | 'ORDINARIA_PENDIENTE'

  async function ventaCon(filas: Fila[]): Promise<string> {
    const { orderId, cobro } = await ventaPendiente(100)
    const { id: exchangeId } = await registrarCambio({
      originalOrderId: orderId,
      originalPaymentId: cobro.id,
      newOrderId: cuid(),
      returned: 100,
      taken: 60,
    })
    const devolucion = (extra: Partial<Prisma.PaymentUncheckedCreateInput>) => movimiento(orderId, -10, { type: 'REFUND', ...extra })
    for (const fila of filas) {
      if (fila === 'ORDINARIA') await devolucion({ processorData: { originalPaymentId: cobro.id } })
      if (fila === 'ORDINARIA_PENDIENTE') await devolucion({ status: 'PENDING', processorData: { originalPaymentId: cobro.id } })
      if (fila === 'SIN_DATOS') await devolucion({ processorData: Prisma.DbNull })
      if (fila === 'JSON_NULL') await devolucion({ processorData: Prisma.JsonNull })
      if (fila === 'CAMBIO_SIN_PAPEL') await devolucion({ processorData: { originalPaymentId: cobro.id, exchange: { exchangeId } } })
      if (fila === 'CREDIT')
        await devolucion({ ...conCredito, tenderTypeId: ecTenderId, processorData: marca(exchangeId, 'CREDIT', cobro.id) })
      if (fila === 'DIFFERENCE') await devolucion({ processorData: marca(exchangeId, 'DIFFERENCE', cobro.id) })
      if (fila === 'CHAIN')
        await devolucion({
          processorData: { ...marca(exchangeId, 'CHAIN', cobro.id), rootPaymentId: cobro.id, originalPaymentId: cuid() },
        })
    }
    return orderId
  }

  it.each<[Fila[], boolean]>([
    [['ORDINARIA'], true],
    [['SIN_DATOS'], true],
    [['JSON_NULL'], true],
    [['CAMBIO_SIN_PAPEL'], true],
    [['CHAIN'], true],
    [['CREDIT'], false],
    [['DIFFERENCE'], false],
    [['CREDIT', 'DIFFERENCE'], false],
    [['CREDIT', 'DIFFERENCE', 'ORDINARIA'], true],
    [['CREDIT', 'DIFFERENCE', 'CHAIN'], true],
    [['ORDINARIA_PENDIENTE'], false],
    [[], false],
  ])('refunds %j ⇒ %s', async (filas, esperado) => {
    const orderId = await ventaCon(filas)
    await expect(ventaTieneReembolso(prisma, { venueId, orderId })).resolves.toBe(esperado)
  })

  it.each<[Fila[], boolean]>([
    [['CREDIT', 'DIFFERENCE'], true],
    [['CHAIN'], false],
    [['ORDINARIA'], false],
  ])('grantStamp respects exchange refund roles %j after merging the refund guard', async (filas, granted) => {
    const orderId = await ventaCon(filas)
    const customerId = await cliente('Sello tras cambio')
    const result = await grantStamp(venueId, customerId, orderId)
    expect(result.granted).toBe(granted)
    if (!granted) expect(result.reason).toBe('ORDER_REFUNDED')
    expect(await sellos(orderId, 'EARN')).toBe(granted ? 1 : 0)
  })
})

describe('loyalty reconciliation around a product exchange (real reconciler)', () => {
  it('loyalty reconciliation keeps the original stamp after an exchange with cash payout', async () => {
    const ana = await cliente('Ana')
    const original = await ventaPendiente(500, ana)
    // Ana ya tiene su sello y sus puntos de la venta original; el proceso murió antes de cerrarla.
    expect((await earnPoints(venueId, ana, 500, original.orderId)).pointsEarned).toBe(500)
    expect(await sellos(original.orderId, 'EARN')).toBe(1)

    // El cambio: regresa $500, se lleva $300 y se le devuelven $200 en efectivo.
    const nueva = await ventaPendiente(0)
    const { id: exchangeId } = await registrarCambio({
      originalOrderId: original.orderId,
      originalPaymentId: original.cobro.id,
      newOrderId: nueva.orderId,
      returned: 500,
      taken: 300,
    })
    await movimiento(original.orderId, -300, {
      ...conCredito,
      type: 'REFUND',
      tenderTypeId: ecTenderId,
      processorData: marca(exchangeId, 'CREDIT', original.cobro.id),
    })
    await movimiento(original.orderId, -200, { type: 'REFUND', processorData: marca(exchangeId, 'DIFFERENCE', original.cobro.id) })

    expect(await reconciliadorDe(original.orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    // El sello de la original sigue vivo: el cambio no es una devolución que lo revierta.
    expect(await sellos(original.orderId, 'EARN')).toBe(1)
    expect(await sellos(original.orderId, 'REVERSAL')).toBe(0)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: original.orderId, customerId: ana, type: 'EARN' } })).toBe(1)
    expect(await procesada(original.orderId)).toBeInstanceOf(Date)
  })

  it('an ordinary refund still makes the reconciler reverse the stamp', async () => {
    const beto = await cliente('Beto')
    const venta = await ventaPendiente(500, beto)
    expect((await earnPoints(venueId, beto, 500, venta.orderId)).pointsEarned).toBe(500)
    await movimiento(venta.orderId, -100, { type: 'REFUND', processorData: { originalPaymentId: venta.cobro.id } })

    expect(await reconciliadorDe(venta.orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    expect(await sellos(venta.orderId, 'REVERSAL')).toBe(1)
    expect(await procesada(venta.orderId)).toBeInstanceOf(Date)
  })

  it('the new sale of an exchange earns points only on the collected difference and no stamp', async () => {
    const cata = await cliente('Cata')
    const original = await ventaPendiente(60)
    // La venta nueva: se lleva $90, paga $60 con crédito de cambio y $30 en efectivo.
    const nueva = await ventaPendiente(90, cata)
    await prisma.payment.update({
      where: { id: nueva.cobro.id },
      data: { ...conCredito, tenderTypeId: ecTenderId, amount: D(60), netAmount: D(60) },
    })
    await movimiento(nueva.orderId, 30)
    await registrarCambio({
      originalOrderId: original.orderId,
      originalPaymentId: original.cobro.id,
      newOrderId: nueva.orderId,
      returned: 60,
      taken: 90,
    })

    expect(await reconciliadorDe(nueva.orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    const puntos = await prisma.loyaltyTransaction.findMany({
      where: { orderId: nueva.orderId, customerId: cata, type: 'EARN' },
      select: { points: true },
      take: 5,
    })
    expect(puntos).toEqual([{ points: 30 }])
    expect(await sellos(nueva.orderId, 'EARN')).toBe(0)
    expect(await procesada(nueva.orderId)).toBeInstanceOf(Date)
  })

  it('R=0, N=10000: the new sale earns points on 10000 but no new stamp (real reconciler)', async () => {
    const dani = await cliente('Dani')
    const original = await ventaPendiente(80)
    // N = 10000 centavos ($100), nada regresado: sin cobro con crédito, pero es la venta nueva de un cambio.
    const nueva = await ventaPendiente(100, dani)
    await registrarCambio({
      originalOrderId: original.orderId,
      originalPaymentId: original.cobro.id,
      newOrderId: nueva.orderId,
      returned: 0,
      taken: 100,
    })

    expect(await reconciliadorDe(nueva.orderId).runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    expect(await prisma.loyaltyTransaction.count({ where: { orderId: nueva.orderId, customerId: dani, type: 'EARN', points: 100 } })).toBe(
      1,
    )
    expect(await sellos(nueva.orderId, 'EARN')).toBe(0)
  })

  it('late-linking a customer to the new sale of an exchange reports no stamp reason (not ERROR) and credits the difference once', async () => {
    const eva = await cliente('Eva')
    const original = await ventaPendiente(60)
    // La venta nueva se cobró SIN cliente ($90 = $60 de crédito + $30 en efectivo) y su lealtad ya se cerró sin nadie a quien dar.
    const nueva = await ventaPendiente(90)
    await prisma.payment.update({
      where: { id: nueva.cobro.id },
      data: { ...conCredito, tenderTypeId: ecTenderId, amount: D(60), netAmount: D(60) },
    })
    await movimiento(nueva.orderId, 30)
    await registrarCambio({
      originalOrderId: original.orderId,
      originalPaymentId: original.cobro.id,
      newOrderId: nueva.orderId,
      returned: 60,
      taken: 90,
    })
    await prisma.order.update({ where: { id: nueva.orderId }, data: { loyaltyProcessedAt: new Date() } })
    ;(logAction as jest.Mock).mockClear()

    // Un gerente liga a Eva desde la TPV después del cobro (develop, 28-oct: ligar a una venta ya cobrada es de gerente o
    // superior): no hay sello que prometer ni un «no sumó por error».
    const ligada = await addCustomerToOrder(venueId, nueva.orderId, eva, staffId, {
      otorgarLealtad: true,
      customerAttribution: { staffId, canAssignHistorical: true },
    })
    expect(ligada.loyalty).toBeNull()
    // La app reintenta (re-liga): igual, y los puntos no se repiten.
    expect(await awardLoyaltyForLateCustomer({ venueId, orderId: nueva.orderId, customerId: eva, staffId, ligaNueva: false })).toBeNull()

    const puntos = await prisma.loyaltyTransaction.findMany({
      where: { orderId: nueva.orderId, customerId: eva, type: 'EARN' },
      select: { points: true },
      take: 5,
    })
    expect(puntos).toEqual([{ points: 30 }])
    expect(await sellos(nueva.orderId, 'EARN')).toBe(0)
    // La bitácora de la liga dice «no aplica», sin motivo: nada de «ERROR».
    const filas = (logAction as jest.Mock).mock.calls
      .map(([a]) => a)
      .filter(a => a.action === 'CUSTOMER_ATTACHED_TO_PAID_ORDER' && a.entityId === nueva.orderId)
    expect(filas.length).toBeGreaterThan(0)
    for (const fila of filas) expect(fila.data).toMatchObject({ decision: 'NOT_APPLICABLE', reason: null, stamped: false })
  })
})
