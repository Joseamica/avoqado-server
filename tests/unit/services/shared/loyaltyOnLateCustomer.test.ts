/**
 * Sello TARDÍO (Testarudo, 14-oct-2026): el barista agrega al cliente en «Cobro exitoso», DESPUÉS de cobrar. La lealtad
 * corría una sola vez al saldarse la venta; 3 de 5 ventas con cliente perdieron su sello. Esto fija la regla de la spec
 * §2: 24 h desde el cobro, un sello por venta, sólo al primario, el tope diario del negocio, sólo ventas saldadas.
 *
 * Y la ronda B de Codex (rulings B1/B2, vinculantes): el reembolso manda TAMBIÉN en la recuperación — un solo envoltorio
 * (`otorgarLealtadRespetandoReembolsos`) para la liga tardía, el reconciliador y la reparación (S9).
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { tablaDeUnaVenta, type FilaDeLealtad } from '@tests/__helpers__/ordenConMarcasDeLealtad'

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn() }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ getStampCardStatus: jest.fn(), reverseStampForOrder: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { getStampCardStatus, reverseStampForOrder } from '@/services/wallet/stampLedger.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'
import logger from '@/config/logger'
import { NotFoundError } from '@/errors/AppError'
import {
  LATE_STAMP_WINDOW_MS,
  MARCA_LEALTAD_REABIERTA,
  awardLoyaltyForLateCustomer,
  decideSaleStamp,
  describeSaleStamp,
  describeSaleStampForPayment,
  esElegibleParaLealtad,
  otorgarLealtadRespetandoReembolsos,
  previewSaleStamp,
  reabrirLealtadSiAplica,
  type SaleStampSnapshot,
} from '@/services/shared/loyaltyOnLateCustomer'

const awardMock = awardLoyaltyForPaidOrder as jest.Mock
const cardMock = getStampCardStatus as jest.Mock
const reverseMock = reverseStampForOrder as jest.Mock
const featureMock = venueHasFeatureAccess as jest.Mock
const logActionMock = logAction as jest.Mock

const VENUE = 'venue-1'
const ORDER = 'order-1'
const CUST = 'cust-1'
const STAFF = 'staff-1'
const MIN = 60_000
// Reloj FIJO: los minutos de la auditoría y la frontera de 24 h no pueden depender de cuántos milisegundos tardó la prueba
// entre que armó la venta y que el helper leyó la hora (con el reloj real, «30 min» salía a veces 29).
const AHORA_FIJO = Date.UTC(2026, 9, 14, 18, 0, 0)
// Sobre el reloj FIJO, no sobre `Date.now()`: las tablas de `it.each` se arman al cargar el archivo, antes del `spyOn`.
const hace = (ms: number) => new Date(AHORA_FIJO - ms)
const D = (n: number) => new Prisma.Decimal(n)
const EARN = (customerId: string) => ({ type: 'EARN', stampCard: { customerId } })
const cron = () => ({ start: jest.fn(), stop: jest.fn() })
/**
 * La MARCA de fila que deja la reapertura (ruling del coordinador tras la medición de S3b): el cierre «sin cliente» de
 * `awardLoyaltyForPaidOrder` que esperó el candado de la liga sólo relee las columnas de la fila; esta columna lo detiene.
 */
const MARCA = 'REABIERTA: cliente ligado después del cobro'

type Evento = { type: string; stampCard: { customerId: string } }
let eventosDeLaVenta: Evento[]
/** Clientes que ya recibieron PUNTOS por esta venta (LoyaltyTransaction EARN). */
let puntosDeLaVenta: Array<{ customerId: string }>

function venta(over: Record<string, unknown> = {}) {
  return {
    id: ORDER,
    orderNumber: 'ORD-1',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    total: D(90),
    tipAmount: D(10),
    customerId: CUST,
    loyaltyEligibleAt: hace(30 * MIN),
    loyaltyProcessedAt: hace(30 * MIN),
    orderCustomers: [{ customerId: CUST }],
    // El ÚLTIMO cobro no-REFUND (la consulta pide sólo ése); los reembolsos se cuentan aparte, exactos.
    payments: [{ createdAt: hace(30 * MIN) }],
    stampEvents: [...eventosDeLaVenta],
    loyaltyTransactions: [...puntosDeLaVenta],
    ...over,
  }
}

function conVenta(over: Record<string, unknown> = {}) {
  prismaMock.order.findFirst.mockImplementation(async () => venta(over))
}

/** Las escrituras de `order.updateMany` que CIERRAN la venta (marcan `loyaltyProcessedAt`). */
const cierres = () =>
  (prismaMock.order.updateMany.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>).filter(
    ([a]) => a.data.loyaltyProcessedAt instanceof Date,
  )
/** Los textos de error que se dejaron en la venta (escrituras de FALLO). */
const erroresEscritos = () =>
  (prismaMock.order.updateMany.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)
    .filter(([a]) => !('loyaltyProcessedAt' in a.data) && typeof a.data.loyaltyLastError === 'string')
    .map(([a]) => a.data.loyaltyLastError)

/** La venta del ejemplo como fila con marcas: ya cobrada SIN cliente, su lealtad corrió y quedó procesada. */
function filaYaProcesada(): FilaDeLealtad {
  return {
    id: ORDER,
    venueId: VENUE,
    total: D(90),
    tipAmount: D(10),
    loyaltyEligibleAt: hace(30 * MIN),
    loyaltyProcessedAt: hace(30 * MIN),
    loyaltyProcessingAt: null,
    loyaltyLastError: null,
    loyaltyAttempts: 0,
    loyaltyStaffId: null,
    customer: null,
    clientes: 1, // la liga ya creó el OrderCustomer (la reapertura corre DESPUÉS, en la misma transacción)
  }
}

let relojFijo: jest.SpyInstance
afterEach(() => relojFijo.mockRestore())

beforeEach(() => {
  // Sin colas «Once» sobrantes de la prueba anterior (una prueba que falla dejaría su rechazo para la siguiente).
  for (const m of [awardMock, reverseMock, prismaMock.order.updateMany, prismaMock.payment.count] as jest.Mock[]) m.mockReset()
  relojFijo = jest.spyOn(Date, 'now').mockReturnValue(AHORA_FIJO)
  eventosDeLaVenta = []
  puntosDeLaVenta = []
  conVenta()
  prismaMock.payment.count.mockResolvedValue(0) // sin reembolsos
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true, maxStampsPerDay: 1 } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.stampEvent.count.mockResolvedValue(0)
  featureMock.mockResolvedValue(true)
  cardMock.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
  reverseMock.mockImplementation(async () => {
    eventosDeLaVenta.push({ type: 'REVERSAL', stampCard: { customerId: CUST } })
    return { reversed: true }
  })
  // El libro de verdad, idempotente como `awardLoyaltyForPaidOrder`: sella si falta el sello, acredita si faltan los puntos;
  // lo que ya está no se repite (índices únicos).
  awardMock.mockImplementation(async () => {
    if (!eventosDeLaVenta.some(e => e.type === 'EARN')) eventosDeLaVenta.push(EARN(CUST))
    if (!puntosDeLaVenta.some(p => p.customerId === CUST)) puntosDeLaVenta.push({ customerId: CUST })
    return { complete: true, errors: [] }
  })
})

describe('decideSaleStamp (pura)', () => {
  const AHORA = Date.UTC(2026, 9, 14, 18, 0, 0)
  const base: SaleStampSnapshot = {
    customerId: CUST,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    reembolsada: false,
    hasReversal: false,
    primaryCustomerId: CUST,
    stampOwnerCustomerId: null,
    pointsOwnerCustomerIds: [],
    settledAt: new Date(AHORA - 30 * MIN),
  }
  it.each<[string, Partial<SaleStampSnapshot>, string]>([
    ['elegible', {}, 'ELIGIBLE'],
    ['abierta (PARTIAL)', { paymentStatus: 'PARTIAL' }, 'OPEN'],
    ['abierta (PENDING)', { paymentStatus: 'PENDING' }, 'OPEN'],
    ['cancelada', { status: 'CANCELLED', paymentStatus: 'PENDING' }, 'NOT_PAID'],
    ['REFUNDED', { paymentStatus: 'REFUNDED' }, 'NOT_PAID'],
    ['reembolsada y sigue PAID (la TPV no cambia el estado)', { reembolsada: true }, 'NOT_PAID'],
    ['sello revertido', { hasReversal: true, stampOwnerCustomerId: CUST }, 'NOT_PAID'],
    ['ya sellada a este cliente', { stampOwnerCustomerId: CUST }, 'STAMPED'],
    ['sello de otro', { stampOwnerCustomerId: 'otro', primaryCustomerId: null }, 'OTHER_CUSTOMER'],
    ['primario es otro', { primaryCustomerId: 'otro' }, 'OTHER_CUSTOMER'],
    ['sin primario (se volverá primario)', { primaryCustomerId: null }, 'ELIGIBLE'],
    ['puntos ya de otro (heredado)', { pointsOwnerCustomerIds: ['heredado'] }, 'OTHER_CUSTOMER'],
    ['sin ancla', { settledAt: null }, 'NO_ANCHOR'],
    ['23 h 59 min', { settledAt: new Date(AHORA - (LATE_STAMP_WINDOW_MS - MIN)) }, 'ELIGIBLE'],
    ['24 h exactas', { settledAt: new Date(AHORA - LATE_STAMP_WINDOW_MS) }, 'ELIGIBLE'],
    ['24 h 01 min', { settledAt: new Date(AHORA - (LATE_STAMP_WINDOW_MS + MIN)) }, 'WINDOW_EXPIRED'],
  ])('%s', (_n, over, esperado) => {
    expect(decideSaleStamp({ ...base, ...over }, AHORA)).toBe(esperado)
  })

  it('ignorarPlazo (sólo la reparación S9): ni el plazo ni el ancla cuentan; todo lo demás sí', () => {
    const vieja = { ...base, settledAt: new Date(AHORA - 30 * LATE_STAMP_WINDOW_MS) }
    expect(decideSaleStamp(vieja, AHORA, { ignorarPlazo: true })).toBe('ELIGIBLE')
    expect(decideSaleStamp({ ...base, settledAt: null }, AHORA, { ignorarPlazo: true })).toBe('ELIGIBLE')
    expect(decideSaleStamp({ ...vieja, reembolsada: true }, AHORA, { ignorarPlazo: true })).toBe('NOT_PAID')
    expect(decideSaleStamp({ ...vieja, primaryCustomerId: 'otro' }, AHORA, { ignorarPlazo: true })).toBe('OTHER_CUSTOMER')
  })
})

describe('esElegibleParaLealtad (¿se corre —o se COMPLETA— la lealtad? auditoría A #1)', () => {
  const AHORA = Date.UTC(2026, 9, 14, 18, 0, 0)
  const base: SaleStampSnapshot = {
    customerId: CUST,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    reembolsada: false,
    hasReversal: false,
    primaryCustomerId: CUST,
    stampOwnerCustomerId: null,
    pointsOwnerCustomerIds: [],
    settledAt: new Date(AHORA - 30 * MIN),
  }
  const vieja = new Date(AHORA - 3 * LATE_STAMP_WINDOW_MS)
  it.each<[string, Partial<SaleStampSnapshot>, boolean, boolean]>([
    ['elegible', {}, false, true],
    ['🔴 el sello de ESTE cliente ya existe: SÍ (completa puntos/visita que falten)', { stampOwnerCustomerId: CUST }, false, true],
    ['el sello es de otro cliente', { stampOwnerCustomerId: 'otro' }, false, false],
    ['ya sellada pero reembolsada', { stampOwnerCustomerId: CUST, reembolsada: true }, false, false],
    ['ya sellada y revertida', { stampOwnerCustomerId: CUST, hasReversal: true }, false, false],
    ['abierta', { paymentStatus: 'PARTIAL' }, false, false],
    ['otro primario', { primaryCustomerId: 'otro' }, false, false],
    ['fuera de plazo', { settledAt: vieja }, false, false],
    ['fuera de plazo pero reparación (sin plazo)', { settledAt: vieja, stampOwnerCustomerId: CUST }, true, true],
  ])('%s', (_n, over, ignorarPlazo, esperado) => {
    expect(esElegibleParaLealtad({ ...base, ...over }, AHORA, { ignorarPlazo })).toBe(esperado)
  })
})

describe('awardLoyaltyForLateCustomer', () => {
  it('🔴 venta pagada hace 30 min: llama la lealtad con el actor y la base sin propina, y sella', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 4, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    // H1: la lealtad NO cierra la venta; la cierra el envoltorio después de su comprobación final de reembolso.
    expect(awardMock).toHaveBeenCalledWith(
      { venueId: VENUE, orderId: ORDER, orderTotal: 80, staffId: STAFF, legacyCustomer: null },
      { cerrar: false },
    )
    expect(r).toEqual({ stampsEnabled: true, stamped: true, reason: null, stampsEarned: 4, stampsRequired: 7, rewardReady: false })
  })

  it('🔴 idempotencia: dos ligas seguidas = UN sello y UNOS puntos (la lealtad se llama las dos veces: es idempotente)', async () => {
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    const segunda = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(awardMock).toHaveBeenCalledTimes(2)
    expect(eventosDeLaVenta.filter(e => e.type === 'EARN')).toHaveLength(1)
    expect(puntosDeLaVenta).toEqual([{ customerId: CUST }])
    expect(segunda?.stamped).toBe(true)
  })

  it('🔴 el sello quedó pero los puntos NO (se cayó entre uno y otro): la siguiente liga vuelve a llamar la lealtad y los completa', async () => {
    eventosDeLaVenta = [EARN(CUST)] // el sello sí quedó (earnPoints sella ANTES de acreditar)
    puntosDeLaVenta = [] // los puntos no
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(puntosDeLaVenta).toEqual([{ customerId: CUST }])
    expect(eventosDeLaVenta.filter(e => e.type === 'EARN')).toHaveLength(1)
    expect(r).toMatchObject({ stamped: true, reason: null })
  })

  it('completó la cartilla: la nueva arranca en 0 y hay premio por cobrar', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 0, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 1 })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ stamped: true, stampsEarned: 0, rewardReady: true })
  })

  it('23 h 59 min después del cobro: sí sella', async () => {
    conVenta({ loyaltyEligibleAt: hace(LATE_STAMP_WINDOW_MS - MIN) })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(r?.stamped).toBe(true)
  })

  it('24 h 01 min después: se liga sin sello, WINDOW_EXPIRED, sin tocar la lealtad', async () => {
    conVenta({ loyaltyEligibleAt: hace(LATE_STAMP_WINDOW_MS + MIN) })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'WINDOW_EXPIRED' })
  })

  it('sin loyaltyEligibleAt el plazo se mide desde el ÚLTIMO cobro completado que no es reembolso', async () => {
    conVenta({ loyaltyEligibleAt: null, payments: [{ createdAt: hace(2 * 60 * MIN) }] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r?.stamped).toBe(true)
    // La consulta pide SÓLO ése: el más nuevo, completado, sin REFUND. 🔴 `type` admite NULL (columna opcional): un
    // `{ not: 'REFUND' }` pelón deja fuera esas filas en SQL y la venta se quedaría sin ancla.
    expect((prismaMock.order.findFirst as jest.Mock).mock.calls[0][0].select.payments).toMatchObject({
      where: { status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 1,
    })
  })

  it('🔴 venta reembolsada (sigue PAID): no sella, NOT_PAID — y el reembolso se cuenta EXACTO, no de una lista con tope', async () => {
    prismaMock.payment.count.mockResolvedValue(1)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'NOT_PAID' })
    expect(prismaMock.payment.count).toHaveBeenCalledWith({
      where: { orderId: ORDER, venueId: VENUE, type: 'REFUND', status: 'COMPLETED' },
    })
  })

  it('🔴 el reembolso entra MIENTRAS se otorga (auditoría A #2): se revierte el sello y la respuesta es NOT_PAID', async () => {
    // El reembolso aparece justo cuando la lealtad está otorgando: toda lectura de antes lo ve en 0, toda la de después en 1.
    let reembolsado = false
    prismaMock.payment.count.mockImplementation((async () => (reembolsado ? 1 : 0)) as never)
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      reembolsado = true
      return { complete: true, errors: [] }
    })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(reverseMock).toHaveBeenCalledWith(VENUE, ORDER)
    expect(eventosDeLaVenta.map(e => e.type)).toEqual(['EARN', 'REVERSAL'])
    expect(r).toMatchObject({ stamped: false, reason: 'NOT_PAID' })
  })

  it('🔴 B2: el reembolso entra entre la lectura y el otorgamiento: el envoltorio no otorga y la respuesta es NOT_PAID', async () => {
    prismaMock.payment.count.mockResolvedValueOnce(0).mockResolvedValue(1)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(awardMock).not.toHaveBeenCalled()
    // H1: la reversión (idempotente) corre ANTES de cerrar: un sello previo de esta venta no queda vivo.
    expect(reverseMock).toHaveBeenCalledWith(VENUE, ORDER)
    expect(r).toMatchObject({ stamped: false, reason: 'NOT_PAID' })
  })

  it('sin reembolso después de otorgar: no revierte nada', async () => {
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(reverseMock).not.toHaveBeenCalled()
  })

  it('venta cancelada: NOT_PAID', async () => {
    conVenta({ status: 'CANCELLED', paymentStatus: 'PENDING' })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ reason: 'NOT_PAID' })
  })

  it('🔴 venta abierta (cuenta dividida a medias): null, sin lealtad ni auditoría — el sello se decide al saldarse', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    expect(await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })).toBeNull()
    expect(awardMock).not.toHaveBeenCalled()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('🔴 la venta ya tiene otro cliente primario: OTHER_CUSTOMER y no se le da nada', async () => {
    conVenta({ orderCustomers: [{ customerId: 'ana' }] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'OTHER_CUSTOMER' })
  })

  it('el sello de la venta es de otro cliente: OTHER_CUSTOMER', async () => {
    eventosDeLaVenta = [EARN('ana')]
    conVenta({ orderCustomers: [], stampEvents: eventosDeLaVenta })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ reason: 'OTHER_CUSTOMER' })
  })

  it('🔴 venta vieja con cliente heredado que ya cobró puntos: el agregado tarde NO cobra puntos dobles', async () => {
    conVenta({ orderCustomers: [], loyaltyTransactions: [{ customerId: 'heredado' }] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ reason: 'OTHER_CUSTOMER' })
  })

  it('🔴 ya recibió su sello de hoy: DAILY_LIMIT, contado en el día del NEGOCIO', async () => {
    awardMock.mockResolvedValue({ complete: true, errors: [] }) // grantStamp rebota por el tope: no hay EARN
    prismaMock.stampEvent.count.mockResolvedValue(1)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ stamped: false, reason: 'DAILY_LIMIT' })
    const where = (prismaMock.stampEvent.count as jest.Mock).mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: VENUE, type: 'EARN', stampCard: { customerId: CUST } })
    expect(where.createdAt.gte).toBeInstanceOf(Date)
    expect(where.createdAt.lte.getTime() - where.createdAt.gte.getTime()).toBe(24 * 60 * MIN - 1)
  })

  it('tope 0 = sin tope: no cuenta y, si no selló, es ERROR', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true, maxStampsPerDay: 0 } as any)
    awardMock.mockResolvedValue({ complete: false, errors: ['loyalty:cust-1'] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(prismaMock.stampEvent.count).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'ERROR' })
  })

  it('sellos apagados: stampsEnabled false, reason null, pero puntos y visita SÍ corren', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: false, maxStampsPerDay: 1 } as any)
    awardMock.mockResolvedValue({ complete: true, errors: [] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ stampsEnabled: false, stamped: false, reason: null })
  })

  it('sin el plan (LOYALTY_PROGRAM): stampsEnabled false', async () => {
    featureMock.mockResolvedValue(false)
    awardMock.mockResolvedValue({ complete: true, errors: [] })
    expect(await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })).toMatchObject({ stampsEnabled: false })
  })

  it('pagada sin ancla de tiempo: no sella, ERROR y aviso en el log', async () => {
    conVenta({ loyaltyEligibleAt: null, payments: [] })
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ reason: 'ERROR' })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('🔴 nunca lanza: si la base truena devuelve null y lo registra', async () => {
    prismaMock.order.findFirst.mockRejectedValue(new Error('P1001'))
    await expect(awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })).resolves.toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })

  it('orden de otro negocio / inexistente: null', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    expect(await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: 'ajena', customerId: CUST })).toBeNull()
    expect((prismaMock.order.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'ajena', venueId: VENUE })
  })

  it('🔴 auditoría: CUSTOMER_ATTACHED_TO_PAID_ORDER con el actor, el resultado y los minutos desde el cobro', async () => {
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock).toHaveBeenCalledWith({
      action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER',
      entity: 'Order',
      entityId: ORDER,
      staffId: STAFF,
      venueId: VENUE,
      data: { customerId: CUST, orderNumber: 'ORD-1', decision: 'ELIGIBLE', stamped: true, reason: null, minutosDesdeElCobro: 30 },
    })
  })

  it('fuera de plazo también se audita (la liga sí quedó)', async () => {
    conVenta({ loyaltyEligibleAt: hace(LATE_STAMP_WINDOW_MS + MIN) })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      stamped: false,
      reason: 'WINDOW_EXPIRED',
      minutosDesdeElCobro: 24 * 60 + 1,
    })
  })

  it('re-liga de una venta que YA tenía su sello para este cliente: no audita otra vez (no-op)', async () => {
    eventosDeLaVenta = [EARN(CUST)]
    conVenta({ stampEvents: eventosDeLaVenta })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock).not.toHaveBeenCalled()
  })
})

describe('otorgarLealtadRespetandoReembolsos (B2: UN envoltorio para la liga tardía, el reconciliador y la reparación S9)', () => {
  const ARGS = { venueId: VENUE, orderId: ORDER, orderTotal: 80, staffId: STAFF, legacyCustomer: null }
  const REEMBOLSO_EXACTO = { where: { orderId: ORDER, venueId: VENUE, type: 'REFUND', status: 'COMPLETED' } }

  it('sin reembolso: otorga con los MISMOS argumentos, no revierte y devuelve el resultado de la lealtad', async () => {
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledWith(ARGS, { cerrar: false })
    expect(reverseMock).not.toHaveBeenCalled()
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false })
    // Antes y después de otorgar, y las dos veces EXACTO (un count por la orden, sin lista con tope).
    expect(prismaMock.payment.count).toHaveBeenCalledTimes(2)
    expect(prismaMock.payment.count).toHaveBeenNthCalledWith(1, REEMBOLSO_EXACTO)
    expect(prismaMock.payment.count).toHaveBeenNthCalledWith(2, REEMBOLSO_EXACTO)
  })

  it('🔴 la venta ya está reembolsada: NO otorga, revierte un sello previo (H1) y SÓLO entonces la deja cerrada', async () => {
    prismaMock.payment.count.mockResolvedValue(1)
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).not.toHaveBeenCalled()
    // H1 (Codex): con el reembolso ya al entrar, un sello que esta venta hubiera dado antes no puede quedar vivo.
    expect(reverseMock).toHaveBeenCalledWith(VENUE, ORDER)
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER, venueId: VENUE, loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null },
      data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
    expect(reverseMock.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.updateMany.mock.invocationCallOrder[0])
    expect(r).toEqual({ complete: true, errors: [], reembolsada: true })
  })

  it('🔴 H1: ya reembolsada al entrar y la reversión FALLA: NO cierra (queda para el reconciliador) y deja el error', async () => {
    prismaMock.payment.count.mockResolvedValue(1)
    reverseMock.mockRejectedValueOnce(new Error('P1001'))
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: false, errors: [expect.stringContaining('reversal:')], reembolsada: true })
    expect(cierres()).toHaveLength(0)
    expect(erroresEscritos()).toEqual([expect.stringContaining('reversal:P1001')])
    expect(logger.error).toHaveBeenCalled()
  })

  it('🔴 el reembolso aparece MIENTRAS otorga: revierte el sello (idempotente) y lo dice', async () => {
    prismaMock.payment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(reverseMock).toHaveBeenCalledWith(VENUE, ORDER)
    expect(eventosDeLaVenta.map(e => e.type)).toEqual(['EARN', 'REVERSAL'])
    expect(r).toEqual({ complete: true, errors: [], reembolsada: true })
  })

  it('la lealtad quedó incompleta y sin reembolso: el resultado sale tal cual (el reconciliador la reintenta)', async () => {
    awardMock.mockResolvedValue({ complete: false, errors: ['loyalty:cust-1'] })
    expect(await otorgarLealtadRespetandoReembolsos(ARGS)).toEqual({ complete: false, errors: ['loyalty:cust-1'], reembolsada: false })
    expect(reverseMock).not.toHaveBeenCalled()
  })

  it('🔴 H1: el reembolso aparece MIENTRAS otorga y la reversión FALLA: la venta NO se cierra (el reconciliador la ve) y el error queda', async () => {
    // Antes: la lealtad ya había marcado `loyaltyProcessedAt` y la reversión fallida dejaba el sello vivo para siempre.
    prismaMock.payment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    reverseMock.mockRejectedValueOnce(new Error('P1001'))
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: false, errors: [expect.stringContaining('reversal:P1001')], reembolsada: true })
    expect(cierres()).toHaveLength(0)
    expect(erroresEscritos()).toEqual([expect.stringContaining('reversal:P1001')])
  })

  it('🔴 H1: sin reembolso, el envoltorio CIERRA después de la comprobación final (no antes)', async () => {
    await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(cierres()).toHaveLength(1)
    const segundoConteo = prismaMock.payment.count.mock.invocationCallOrder[1]
    expect(segundoConteo).toBeLessThan(prismaMock.order.updateMany.mock.invocationCallOrder[0])
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER, venueId: VENUE, loyaltyEligibleAt: { not: null }, loyaltyProcessedAt: null },
      data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
  })

  it('🔴 H1: si la corrida leyó «sin cliente», el envoltorio cierra con la MISMA guarda (sin clientes y sin la marca)', async () => {
    awardMock.mockResolvedValueOnce({ complete: true, errors: [], leyoSinCliente: true })
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false })
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: ORDER,
        venueId: VENUE,
        loyaltyEligibleAt: { not: null },
        loyaltyProcessedAt: null,
        orderCustomers: { none: {} },
        OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA } }],
      },
      data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
  })

  it('H1: la lealtad incompleta no se cierra (sin reembolso de por medio)', async () => {
    awardMock.mockResolvedValue({ complete: false, errors: ['loyalty:cust-1'] })
    await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(cierres()).toHaveLength(0)
  })

  it('H1: si el cierre del envoltorio truena, la venta queda pendiente y el resultado lo dice (complete false)', async () => {
    prismaMock.order.updateMany.mockRejectedValueOnce(new Error('P1001'))
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: false, errors: [expect.stringContaining('marker:P1001')], reembolsada: false })
  })
})

describe('describeSaleStamp (sólo lee)', () => {
  it('no llama la lealtad nunca', async () => {
    await describeSaleStamp({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(awardMock).not.toHaveBeenCalled()
  })
  it('venta abierta se DESCRIBE como NOT_PAID', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    expect(await describeSaleStamp({ venueId: VENUE, orderId: ORDER, customerId: CUST })).toMatchObject({ reason: 'NOT_PAID' })
  })
})

describe('describeSaleStampForPayment (GET de la app)', () => {
  beforeEach(() => {
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: ORDER } as any)
  })
  it('pago de otro negocio: 404', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null)
    await expect(describeSaleStampForPayment({ venueId: VENUE, paymentId: 'pago-ajeno' })).rejects.toThrow(NotFoundError)
    expect((prismaMock.payment.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: 'pago-ajeno', venueId: VENUE })
  })
  it('venta sin cliente: null', async () => {
    conVenta({ orderCustomers: [], customerId: null })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toBeNull()
  })
  it('venta abierta: null', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toBeNull()
  })
  it('🔴 pagada y la lealtad aún no corre: PENDING (la app reintenta una vez)', async () => {
    conVenta({ loyaltyProcessedAt: null })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toMatchObject({ stamped: false, reason: 'PENDING' })
  })
  it('🔴 venta que una liga tardía REABRIÓ (marca de fila) y espera su sello: PENDING, no «no suma»', async () => {
    // Así la deja `reabrirLealtadSiAplica`: cobrada sin cliente, `loyaltyEligibleAt` puesto al último cobro (era null),
    // `loyaltyProcessedAt` en null y la marca. El cliente ya es primario y el sello aún no llega (intento inmediato caído).
    conVenta({ loyaltyEligibleAt: hace(30 * MIN), loyaltyProcessedAt: null, loyaltyLastError: MARCA })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toMatchObject({
      stampsEnabled: true,
      stamped: false,
      reason: 'PENDING',
    })
  })
  it('ya sellada: stamped true aunque loyaltyProcessedAt siga null', async () => {
    eventosDeLaVenta = [EARN(CUST)]
    conVenta({ loyaltyProcessedAt: null, stampEvents: eventosDeLaVenta })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toMatchObject({ stamped: true, reason: null })
  })
  it('usa el cliente heredado si no hay OrderCustomer', async () => {
    eventosDeLaVenta = [EARN('heredado')]
    conVenta({ orderCustomers: [], customerId: 'heredado', stampEvents: eventosDeLaVenta })
    expect(await describeSaleStampForPayment({ venueId: VENUE, paymentId: 'p1' })).toMatchObject({ stamped: true })
  })
})

describe('previewSaleStamp (vista previa del MCP)', () => {
  it('sin primario: el cliente se volvería primario ⇒ ELIGIBLE', async () => {
    conVenta({ orderCustomers: [] })
    expect(await previewSaleStamp({ venueId: VENUE, orderId: ORDER, customerId: CUST })).toMatchObject({
      decision: 'ELIGIBLE',
      stampsEnabled: true,
      dailyLimitReached: false,
      minutosDesdeElCobro: 30,
      orderNumber: 'ORD-1',
    })
    expect(awardMock).not.toHaveBeenCalled()
  })
})

describe('reabrirLealtadSiAplica (DENTRO de la transacción de la liga — auditoría A #1)', () => {
  const tx = () => prismaMock as unknown as Parameters<typeof reabrirLealtadSiAplica>[0]
  beforeEach(() => prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any))

  it('la marca es el texto EXACTO del ruling y se exporta (la lee el cierre «sin cliente» de awardLoyaltyForPaidOrder)', () => {
    expect(MARCA_LEALTAD_REABIERTA).toBe(MARCA)
  })

  it('🔴 venta elegible y el cliente quedó primario: reabre (processedAt/processingAt en null) y deja la MARCA de fila', async () => {
    expect(await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(true)
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER, venueId: VENUE },
      data: { loyaltyProcessedAt: null, loyaltyProcessingAt: null, loyaltyLastError: MARCA },
    })
  })

  it('sin loyaltyEligibleAt: lo pone a la hora del último cobro (la MISMA ancla del plazo) para que el reconciliador la vea', async () => {
    const cobro = hace(45 * MIN)
    conVenta({ loyaltyEligibleAt: null, payments: [{ createdAt: cobro }] })
    await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).toEqual({
      loyaltyProcessedAt: null,
      loyaltyProcessingAt: null,
      loyaltyLastError: MARCA,
      loyaltyEligibleAt: cobro,
    })
  })

  it('🔴 ya sellada a ESTE cliente pero dentro de plazo: también reabre (la liga puede completar puntos que falten)', async () => {
    eventosDeLaVenta = [EARN(CUST)]
    expect(await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(true)
  })

  it.each<[string, Record<string, unknown>]>([
    ['el cliente NO quedó primario (ya había otro)', { orderCustomers: [{ customerId: 'ana' }] }],
    ['fuera de plazo', { loyaltyEligibleAt: hace(LATE_STAMP_WINDOW_MS + MIN) }],
    ['abierta (cuenta dividida)', { paymentStatus: 'PARTIAL' }],
    ['cancelada', { status: 'CANCELLED', paymentStatus: 'PENDING' }],
    ['el sello es de otro', { stampEvents: [EARN('ana')] }],
  ])('no reabre: %s', async (_n, over) => {
    conVenta(over)
    expect(await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(false)
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })

  it('no reabre una venta reembolsada', async () => {
    prismaMock.payment.count.mockResolvedValue(1)
    expect(await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(false)
  })

  it('orden de otro negocio / inexistente: no toca nada', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    expect(await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: 'ajena', customerId: CUST })).toBe(false)
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
  })
})

describe('🔴 recuperación durable de punta a punta (auditoría A #1)', () => {
  it('la liga reabre la venta; el intento inmediato falla; el reconciliador de SIEMPRE la encuentra y la termina', async () => {
    // La venta se cobró SIN cliente: la lealtad ya corrió (sin nadie a quien dar) y quedó marcada como procesada.
    const fila = filaYaProcesada()
    const tabla = tablaDeUnaVenta(fila) // su `updateMany` SÍ respeta el `where` (auditoría ronda B)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)

    // 1) Dentro de la transacción de la liga.
    expect(await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(true)
    expect(fila.loyaltyProcessedAt).toBeNull()
    expect(fila.loyaltyLastError).toBe(MARCA)

    // 2) El intento inmediato falla (la base se cae a media lealtad): nadie vuelve a marcar la venta como procesada.
    awardMock.mockResolvedValueOnce({ complete: false, errors: ['loyalty:cust-1'] })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(fila.loyaltyProcessedAt).toBeNull()

    // 3) El reconciliador existente (sólo mira loyaltyEligibleAt puesto y loyaltyProcessedAt null) la toma y la termina.
    const reintento = jest.fn().mockResolvedValue({ complete: true, errors: [] })
    const job = new LoyaltyReconciliationJob({
      prisma: { order: tabla } as never,
      cron: cron(),
      award: reintento,
      now: () => new Date(Date.now()),
    })
    const r = await job.runNow()
    expect(reintento).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, orderId: ORDER, orderTotal: 80 }))
    expect(r).toMatchObject({ scanned: 1, applied: 1 })
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})

describe('🔴 B2: el reembolso manda también en la recuperación (rulings ronda B)', () => {
  it('el intento inmediato falla ANTES del sello → se reembolsa → el reconciliador NO sella y deja la venta cerrada', async () => {
    const fila = filaYaProcesada()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    expect(await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST })).toBe(true)

    // El intento inmediato truena antes de sellar: no hay EARN.
    awardMock.mockResolvedValueOnce({ complete: false, errors: ['loyalty:cust-1'] })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(eventosDeLaVenta).toEqual([])

    // Se devuelve el pago. Su reversa no encuentra sello que revertir (todavía no existe).
    prismaMock.payment.count.mockResolvedValue(1)

    // El reconciliador con SU lealtad de siempre (sin inyectar nada): debe pasar por el envoltorio.
    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => new Date(Date.now()) })
    const r = await job.runNow()

    expect(awardMock).toHaveBeenCalledTimes(1) // sólo el intento inmediato; el reconciliador no otorgó
    expect(eventosDeLaVenta.filter(e => e.type === 'EARN')).toHaveLength(0)
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date) // cerrada: no se reintenta 15 veces una venta devuelta
    expect(r).toMatchObject({ scanned: 1, applied: 1, failed: 0 })
  })

  it('🔴 H1: el reembolso entra mientras el reconciliador sella y la reversión FALLA ⇒ la venta queda pendiente; la siguiente vuelta revierte y cierra', async () => {
    const fila = filaYaProcesada()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST })

    let reembolsado = false
    prismaMock.payment.count.mockImplementation((async () => (reembolsado ? 1 : 0)) as never)
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      reembolsado = true // el reembolso entra justo mientras el reconciliador otorga…
      return { complete: true, errors: [] }
    })
    reverseMock.mockRejectedValueOnce(new Error('P1001')) // …y la reversión se cae

    const ahora = Date.now()
    const primera = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => new Date(ahora) })
    expect(await primera.runNow()).toMatchObject({ scanned: 1, applied: 0, failed: 1 })
    // Antes: la lealtad ya la había cerrado y el sello quedaba vivo sobre una venta devuelta, sin que nadie la volviera a ver.
    expect(fila.loyaltyProcessedAt).toBeNull()
    expect(eventosDeLaVenta.map(e => e.type)).toEqual(['EARN'])

    const siguiente = new LoyaltyReconciliationJob({
      prisma: { order: tabla } as never,
      cron: cron(),
      now: () => new Date(ahora + 11 * 60_000),
    })
    expect(await siguiente.runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })
    expect(eventosDeLaVenta.map(e => e.type)).toEqual(['EARN', 'REVERSAL'])
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })

  it('el reembolso entra MIENTRAS el reconciliador sella: el sello se revierte y no queda ninguno válido', async () => {
    const fila = filaYaProcesada()
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST })
    awardMock.mockResolvedValueOnce({ complete: false, errors: ['loyalty:cust-1'] })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })

    let reembolsado = false
    prismaMock.payment.count.mockImplementation((async () => (reembolsado ? 1 : 0)) as never)
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      reembolsado = true // el reembolso entra justo mientras el reconciliador otorga
      return { complete: true, errors: [] }
    })
    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => new Date(Date.now()) })
    await job.runNow()

    expect(reverseMock).toHaveBeenCalledWith(VENUE, ORDER)
    expect(eventosDeLaVenta.map(e => e.type)).toEqual(['EARN', 'REVERSAL'])
    expect(fila.loyaltyProcessedAt).toBeInstanceOf(Date)
  })
})
