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
  auditarLigaSinPermisoDeCobro,
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
/** El sello EARN de la venta con su cartilla (lo que lee `cartillaDeLaVenta`). */
const earnDeLaVenta = (c: {
  stampsEarned: number
  stampsRequired: number
  completa?: boolean
  premio?: { rewardLabel: string; status: string }
}) => ({
  stampCard: {
    stampsEarned: c.stampsEarned,
    stampsRequired: c.stampsRequired,
    completedAt: c.completa ? new Date(AHORA_FIJO) : null,
    rewards: c.premio ? [c.premio] : [],
  },
})
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
  for (const m of [awardMock, reverseMock, prismaMock.order.updateMany, prismaMock.payment.count, prismaMock.$queryRaw] as jest.Mock[])
    m.mockReset()
  relojFijo = jest.spyOn(Date, 'now').mockReturnValue(AHORA_FIJO)
  eventosDeLaVenta = []
  puntosDeLaVenta = []
  conVenta()
  // La foto de UNA sentencia del envoltorio (H4/H5): primario, clientes, actor y dueños de EARN, sacada de la MISMA venta simulada.
  prismaMock.$queryRaw.mockImplementation((async () => {
    const leer = prismaMock.order.findFirst.getMockImplementation() as ((a?: unknown) => Promise<any>) | undefined
    const v = leer ? await leer({}) : null
    if (!v) return []
    return [
      {
        staffId: v.loyaltyStaffId ?? null,
        primario: v.orderCustomers[0]?.customerId ?? null,
        clientes: v.orderCustomers.length,
        sellos: v.stampEvents.filter((e: Evento) => e.type === 'EARN').map((e: Evento) => e.stampCard.customerId),
        puntos: v.loyaltyTransactions.map((t: { customerId: string }) => t.customerId),
      },
    ]
  }) as never)
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
    esVentaDeTarjetas: false,
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
    // Cierre (punto 15, B6/R1): comprar tarjetas de regalo no da sellos; ni pagada ni abierta se promete uno.
    ['🔴 venta de tarjetas de regalo pagada', { esVentaDeTarjetas: true }, 'NOT_APPLICABLE'],
    ['🔴 venta de tarjetas de regalo abierta', { esVentaDeTarjetas: true, paymentStatus: 'PENDING' }, 'NOT_APPLICABLE'],
  ])('%s', (_n, over, esperado) => {
    expect(decideSaleStamp({ ...base, ...over }, AHORA)).toBe(esperado)
  })

  it('ignorarPlazo (sólo la reparación S9): ni el plazo ni el ancla cuentan; todo lo demás sí', () => {
    const vieja = { ...base, settledAt: new Date(AHORA - 30 * LATE_STAMP_WINDOW_MS) }
    expect(decideSaleStamp(vieja, AHORA, { ignorarPlazo: true })).toBe('ELIGIBLE')
    expect(decideSaleStamp({ ...base, settledAt: null }, AHORA, { ignorarPlazo: true })).toBe('ELIGIBLE')
    expect(decideSaleStamp({ ...vieja, reembolsada: true }, AHORA, { ignorarPlazo: true })).toBe('NOT_PAID')
    expect(decideSaleStamp({ ...vieja, primaryCustomerId: 'otro' }, AHORA, { ignorarPlazo: true })).toBe('OTHER_CUSTOMER')
    // La reparación (S9) tampoco sella una venta de tarjetas.
    expect(decideSaleStamp({ ...vieja, esVentaDeTarjetas: true }, AHORA, { ignorarPlazo: true })).toBe('NOT_APPLICABLE')
  })
})

describe('🔴 cierre (punto 15): la venta de tarjetas de regalo nunca PROMETE un sello (el otorgamiento ya está bloqueado, B6)', () => {
  // La marca COMPLETA de la cuenta, leída en la MISMA consulta de la venta (`SELECT_MARCA_DE_CUENTA_DE_TARJETAS`).
  const deTarjetas = { items: [{ id: 'oi-gc' }], _count: { items: 0 } }

  it('la vista previa del MCP dice NOT_APPLICABLE (no ELIGIBLE) y no mira el tope del día', async () => {
    conVenta(deTarjetas)
    const v = await previewSaleStamp({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(v?.decision).toBe('NOT_APPLICABLE')
    expect(v?.dailyLimitReached).toBe(false)
    expect((prismaMock.order.findFirst as jest.Mock).mock.calls[0][0].select).toMatchObject({
      items: { where: { giftCardId: { not: null } }, select: { id: true }, take: 1 },
      _count: { select: { items: { where: { giftCardId: null } } } },
    })
  })

  it('ligar al cliente no corre la lealtad, la app no pinta nada (null) y la liga queda auditada con la decisión', async () => {
    conVenta(deTarjetas)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(r).toBeNull()
    expect(awardMock).not.toHaveBeenCalled()
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER',
        data: expect.objectContaining({ decision: 'NOT_APPLICABLE', stamped: false }),
      }),
    )
  })

  it('el GET tras el cobro no pinta nada (null), ni siquiera «pendiente»', async () => {
    conVenta({ ...deTarjetas, loyaltyProcessedAt: null })
    prismaMock.payment.findFirst.mockResolvedValue({ orderId: ORDER } as never)
    await expect(describeSaleStampForPayment({ venueId: VENUE, paymentId: 'pay-1' })).resolves.toBeNull()
  })

  it('regresión: una cuenta con un renglón de tarjeta Y otro sin ella (marca completa) sigue la regla de siempre', async () => {
    conVenta({ items: [{ id: 'oi-gc' }], _count: { items: 1 } })
    const v = await previewSaleStamp({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(v?.decision).toBe('ELIGIBLE')
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
    esVentaDeTarjetas: false,
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
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(earnDeLaVenta({ stampsEarned: 4, stampsRequired: 7 }) as any)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    // H1: la lealtad NO cierra la venta; la cierra el envoltorio después de su comprobación final de reembolso.
    expect(awardMock).toHaveBeenCalledWith(
      { venueId: VENUE, orderId: ORDER, orderTotal: 80, staffId: STAFF, legacyCustomer: null },
      // H4 (segunda ola): el beneficiario VALIDADO viaja a la lealtad; si el primario cambia, no acredita a nadie.
      { cerrar: false, beneficiario: CUST },
    )
    // La tarjetita de «Cobro exitoso» (21-oct): la cartilla de ESTA venta y lo que ofrece hoy el negocio.
    expect(r).toEqual({
      stampsEnabled: true,
      stamped: true,
      reason: null,
      stampsEarned: 4,
      stampsRequired: 7,
      rewardReady: false,
      saleCard: { stampsEarned: 4, stampsRequired: 7, completed: false, rewardLabel: 'Café', rewardPending: false },
    })
    expect((prismaMock.stampEvent.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      venueId: VENUE,
      orderId: ORDER,
      type: 'EARN',
      stampCard: { customerId: CUST },
    })
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

  // Codex r1 #1-#3 (21-oct): la tarjetita describe la cartilla de ESTA venta, no la abierta hoy.
  it('su cartilla de 7 está llena aunque el negocio ya pide 10 y ya renombró el premio: dice 7 de 7 y el premio GANADO', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 0, stampsRequired: 10, rewardLabel: '10 % de descuento', pendingRewards: 1 })
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(
      earnDeLaVenta({
        stampsEarned: 7,
        stampsRequired: 7,
        completa: true,
        premio: { rewardLabel: 'Café gratis', status: 'PENDING' },
      }) as any,
    )
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r?.saleCard).toEqual({ stampsEarned: 7, stampsRequired: 7, completed: true, rewardLabel: 'Café gratis', rewardPending: true })
    // Codex r2 #2 / r3 #1: no se ordenan sellos para adivinar cuál llenó la cartilla; una sola lectura, la del sello de la venta.
    expect(prismaMock.stampEvent.findFirst).toHaveBeenCalledTimes(1)
  })

  it('cartilla llena y otro aparato ya cobró el premio: no dice «por cobrar»', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 0, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(
      earnDeLaVenta({ stampsEarned: 7, stampsRequired: 7, completa: true, premio: { rewardLabel: 'Café', status: 'REDEEMED' } }) as any,
    )
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r?.saleCard).toMatchObject({ completed: true, rewardPending: false })
  })

  it('cartilla reabierta por una devolución tras cobrar el premio (6 de 7 con fecha de llena): sin tarjetita, nunca «7 de 7»', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 0, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(
      earnDeLaVenta({ stampsEarned: 6, stampsRequired: 7, completa: true, premio: { rewardLabel: 'Café', status: 'REDEEMED' } }) as any,
    )
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ stamped: true, saleCard: null })
  })

  it('sin sello EARN de la venta (no quedó o se revirtió): sin tarjetita', async () => {
    cardMock.mockResolvedValue({ stampsEarned: 1, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(null)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST })
    expect(r).toMatchObject({ stamped: true, saleCard: null })
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

  it('🔴 H4: otro cliente recibió el sello ENTRE la lectura de la liga y el otorgamiento: OTHER_CUSTOMER y no se acredita', async () => {
    let lecturas = 0
    prismaMock.order.findFirst.mockImplementation((async () =>
      ++lecturas === 1 ? venta() : venta({ stampEvents: [EARN('ana')] })) as never)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'OTHER_CUSTOMER' })
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
    expect(r).toMatchObject({ stampsEnabled: false, stamped: false, reason: null, saleCard: null })
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

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): «cobrada» para la auditoría es PAID/REFUNDED. Una cuenta PARTIAL con un abono devuelto
  // nunca se saldó: no sella (con reembolso es NOT_PAID, como siempre) y NO es una liga a una venta cobrada — no se audita.
  it('🔴 R7-2: cuenta PARTIAL con un abono devuelto: no sella (NOT_PAID) y NO audita (no es una venta cobrada)', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    prismaMock.payment.count.mockResolvedValue(1)
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ stamped: false, reason: 'NOT_PAID' })
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('regresión: venta PARTIAL sin reembolso: cuenta abierta ⇒ null y sin auditoría', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    expect(
      await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true }),
    ).toBeNull()
    expect(logActionMock).not.toHaveBeenCalled()
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

  // 🔴 BAJO-3 (full-testing, 15-oct-2026): seis «Agregar cliente» del MISMO cliente a la vez dejaron DOS filas de auditoría:
  // las llamadas que llegaron juntas leyeron la venta sin sello (ELIGIBLE) y cada una auditó. La fila es del hecho «X ligó
  // a Y», y ese hecho lo hizo UNA llamada: la que creó (o promovió) la liga. Las demás no auditan.
  it('🔴 BAJO-3: la llamada que NO creó la liga (ligaNueva: false) completa la lealtad pero NO audita', async () => {
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(awardMock).toHaveBeenCalledTimes(1) // la lealtad corre igual (idempotente): completa lo que falte
    expect(r?.stamped).toBe(true)
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('BAJO-3: la llamada que SÍ creó la liga (ligaNueva: true) audita como siempre', async () => {
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0]).toMatchObject({ action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER', entityId: ORDER })
  })

  // ── F2 (ronda 1 post-QA): la llamada que CREA o PROMUEVE la liga audita siempre; una re-liga, sólo si ESTA llamada otorgó ──
  it('🔴 F2: la fila de la llamada que creó la liga dice `ligaNueva` y si ESTA llamada otorgó (`otorgo`)', async () => {
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      return { complete: true, errors: [], otorgado: { sello: true, puntos: true } }
    })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: true, otorgo: true, stamped: true, decision: 'ELIGIBLE' })
  })

  it('🔴 F2: una RE-liga (ligaNueva: false) que SÍ otorgó el sello audita — antes: CERO filas si la liga original no auditó (COCINA)', async () => {
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      return { complete: true, errors: [], otorgado: { sello: true, puntos: false } }
    })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0]).toMatchObject({ action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER', staffId: STAFF })
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: false, otorgo: true, stamped: true })
  })

  // ── R3-1 (ronda 3; Codex recheck-7 P2-1 + N4): la auditoría sale de los HECHOS de esta llamada, pase lo que pase después ──
  it('🔴 R3-1: una re-liga que RECUPERA los puntos de una venta que ya tenía sello audita (otorgar puntos cuenta, haya sello o no)', async () => {
    eventosDeLaVenta = [EARN(CUST)] // la venta ya tenía su sello; faltaban los puntos
    conVenta({ stampEvents: eventosDeLaVenta })
    awardMock.mockImplementationOnce(async () => ({ complete: true, errors: [], otorgado: { sello: false, puntos: true } }))
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      ligaNueva: false,
      otorgo: true,
      otorgoSello: false,
      otorgoPuntos: true,
      stamped: true,
    })
  })

  it('🔴 R3-1: una re-liga que otorga el sello y LUEGO falla la cartilla audita igual, con sus hechos (antes: cero filas)', async () => {
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      return { complete: true, errors: [], otorgado: { sello: true, puntos: false } }
    })
    cardMock.mockRejectedValue(new Error('P1001'))
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(r).toBeNull()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      ligaNueva: false,
      otorgo: true,
      otorgoSello: true,
      otorgoPuntos: false,
      stamped: true,
      error: expect.stringContaining('P1001'),
    })
  })

  it('🔴 R3-1: liga nueva y falla la lectura del PROGRAMA (Promise.all): audita igual con la venta que sí se leyó (antes: cero filas)', async () => {
    prismaMock.loyaltyConfig.findUnique.mockRejectedValue(new Error('P1001'))
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(r).toBeNull()
    expect(awardMock).not.toHaveBeenCalled()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      orderNumber: 'ORD-1',
      ligaNueva: true,
      otorgo: false,
      stamped: false,
      reason: 'ERROR',
    })
  })

  it('🔴 N4: liga nueva que SÍ otorgó y luego falla una lectura: la fila dice la verdad (stamped/otorgo true), no un falso «sin sello»', async () => {
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      return { complete: true, errors: [], otorgado: { sello: true, puntos: true } }
    })
    cardMock.mockRejectedValue(new Error('P1001'))
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      ligaNueva: true,
      otorgo: true,
      otorgoSello: true,
      otorgoPuntos: true,
      stamped: true,
      reason: null,
    })
  })

  it('🔴 R3-1: el otorgamiento se anota EN CUANTO ocurre: si el envoltorio truena DESPUÉS (2.º conteo de reembolsos), la re-liga audita', async () => {
    awardMock.mockImplementationOnce(async () => {
      eventosDeLaVenta.push(EARN(CUST))
      return { complete: true, errors: [], otorgado: { sello: true, puntos: false } }
    })
    // Conteos de reembolso: la lectura de la venta, el 1.º del envoltorio y el 2.º (el que truena, DESPUÉS de otorgar).
    prismaMock.payment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('P1001'))
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(r).toBeNull()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: false, otorgoSello: true, stamped: true })
  })

  it('R3-1: liga nueva y falla la lectura de la VENTA: audita con lo que quien llama sabe (venta cobrada), sin número de orden', async () => {
    prismaMock.order.findFirst.mockRejectedValueOnce(new Error('P1001'))
    const r = await awardLoyaltyForLateCustomer({
      venueId: VENUE,
      orderId: ORDER,
      customerId: CUST,
      staffId: STAFF,
      ligaNueva: true,
      ventaCobrada: true,
    })
    expect(r).toBeNull()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0]).toMatchObject({ entityId: ORDER, staffId: STAFF })
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: true, otorgo: false, reason: 'ERROR', orderNumber: null })
  })

  it('R3-1: liga nueva y falla la lectura de la venta SIN saber si estaba cobrada: no inventa una fila de «venta cobrada»', async () => {
    prismaMock.order.findFirst.mockRejectedValueOnce(new Error('P1001'))
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('F2: una re-liga que creó los puntos de una venta SIN sello (negocio sin sellos) sí audita', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: false, maxStampsPerDay: 0 } as any)
    awardMock.mockImplementationOnce(async () => ({ complete: true, errors: [], otorgado: { sello: false, puntos: true } }))
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: false, otorgo: true })
  })

  it('🔴 F2: la que creó la liga audita aunque la lealtad truene después de leer la venta; la liga ya quedó', async () => {
    cardMock.mockRejectedValue(new Error('P1001'))
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(r).toBeNull()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    // N4 (ronda 3): la relectura ya vio el sello de esta liga: la fila dice que SÍ quedó sellada (antes: un falso stamped:false).
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ ligaNueva: true, stamped: true, reason: null, error: 'P1001' })
  })

  it('F2: una re-liga cuya lealtad truena no audita (no creó la liga ni se sabe que otorgara)', async () => {
    cardMock.mockRejectedValue(new Error('P1001'))
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('🔴 BAJO-3: la que creó la liga audita AUNQUE otra llamada simultánea ya le haya dado el sello antes de que ésta leyera', async () => {
    // Sin esto, en la carrera la única fila podía perderse: la que creó leía «ya sellada» y las demás no auditan.
    eventosDeLaVenta = [EARN(CUST)]
    conVenta({ stampEvents: eventosDeLaVenta })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({ decision: 'STAMPED', stamped: true })
  })
})

describe('otorgarLealtadRespetandoReembolsos (B2: UN envoltorio para la liga tardía, el reconciliador y la reparación S9)', () => {
  const ARGS = { venueId: VENUE, orderId: ORDER, orderTotal: 80, staffId: STAFF, legacyCustomer: null }
  const REEMBOLSO_EXACTO = { where: { orderId: ORDER, venueId: VENUE, type: 'REFUND', status: 'COMPLETED' } }

  it('sin reembolso: otorga con los MISMOS argumentos, no revierte y devuelve el resultado de la lealtad', async () => {
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledWith(ARGS, { cerrar: false, beneficiario: CUST })
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
        orderCustomers: { none: { isPrimary: true } },
        OR: [{ loyaltyLastError: null }, { loyaltyLastError: { not: MARCA } }],
      },
      data: { loyaltyProcessedAt: expect.any(Date), loyaltyProcessingAt: null, loyaltyLastError: null },
    })
  })

  // ── F1 (ronda 1 post-QA): sin PRIMARIO las ligas no cuentan; el beneficiario es el que tendría la venta sin ellas ─────────
  it('🔴 F1: ligas sin primario (acompañante de una liga sin permiso) ⇒ el beneficiario validado es el heredado de la orden', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ staffId: null, primario: null, clientes: 1, sellos: [], puntos: [] }] as never)
    const legacy = { id: 'cust-heredado', firstName: 'Leo', lastName: null }
    await otorgarLealtadRespetandoReembolsos({ ...ARGS, legacyCustomer: legacy })
    expect(awardMock).toHaveBeenCalledWith({ ...ARGS, legacyCustomer: legacy }, { cerrar: false, beneficiario: 'cust-heredado' })
  })

  it('F1: ligas sin primario y sin heredado ⇒ beneficiario «sin cliente» (null)', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ staffId: null, primario: null, clientes: 1, sellos: [], puntos: [] }] as never)
    await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledWith(ARGS, { cerrar: false, beneficiario: null })
  })

  it('🔴 R3-1: el envoltorio AVISA lo otorgado en cuanto ocurre (antes del 2.º conteo, que puede tronar)', async () => {
    awardMock.mockResolvedValueOnce({ complete: true, errors: [], leyoSinCliente: false, otorgado: { sello: true, puntos: false } })
    prismaMock.payment.count.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('P1001'))
    const alOtorgar = jest.fn()
    await expect(otorgarLealtadRespetandoReembolsos(ARGS, { alOtorgar })).rejects.toThrow('P1001')
    expect(alOtorgar).toHaveBeenCalledWith({ sello: true, puntos: false })
  })

  it('F2: el envoltorio pasa `otorgado` de la lealtad (lo que ESTA corrida creó)', async () => {
    awardMock.mockResolvedValueOnce({ complete: true, errors: [], leyoSinCliente: false, otorgado: { sello: true, puntos: false } })
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false, otorgado: { sello: true, puntos: false } })
  })

  // ── H4 (auditoría de Codex del código, 15-oct-2026) ─────────────────────────────────────────────────────────────────────
  it('🔴 H4: la venta ya le dio su SELLO a otro cliente (el primario cambió): no se acredita al primario nuevo y se cierra como OTHER_CUSTOMER', async () => {
    eventosDeLaVenta = [EARN('ana')] // Ana recibió el sello; luego la TPV la quitó y quedó CUST como primario
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false, otroCliente: true })
    expect(cierres()).toHaveLength(1) // cerrada: el reconciliador no la vuelve a tomar
  })

  it('🔴 H4: la venta ya le dio PUNTOS a otro cliente: «ya sellada» nunca habilita puntos para alguien distinto', async () => {
    puntosDeLaVenta = [{ customerId: 'ana' }]
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ complete: true, otroCliente: true })
  })

  it('H4: el EARN es del MISMO primario (corrida cortada entre el sello y los puntos): sí completa', async () => {
    eventosDeLaVenta = [EARN(CUST)]
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false })
  })

  it('H4: sin OrderCustomer, el beneficiario es el cliente heredado que la lealtad acreditaría: su propio EARN no estorba', async () => {
    eventosDeLaVenta = [EARN('heredado')]
    conVenta({ orderCustomers: [] })
    const r = await otorgarLealtadRespetandoReembolsos({ ...ARGS, legacyCustomer: { id: 'heredado', firstName: null, lastName: null } })
    expect(awardMock).toHaveBeenCalledTimes(1)
    expect(r).not.toHaveProperty('otroCliente')
  })

  it('H4: la comprobación es UNA sentencia sobre esta venta de este negocio (primario, clientes, actor y dueños de EARN juntos)', async () => {
    await otorgarLealtadRespetandoReembolsos(ARGS)
    const q = prismaMock.$queryRaw.mock.calls[0][0] as unknown as Prisma.Sql
    expect(q.text).toMatch(/FROM "Order" o WHERE o\."id" = \$1 AND o\."venueId" = \$2/)
    expect(q.text).toMatch(/"isPrimary" = true ORDER BY oc\."addedAt" ASC LIMIT 1\) AS "primario"/)
    expect(q.text).toMatch(/AS "clientes"/)
    expect(q.text).toMatch(/o\."loyaltyStaffId" AS "staffId"/)
    expect(q.text).toMatch(/AS "sellos"/)
    expect(q.text).toMatch(/AS "puntos"/)
    expect(q.values).toEqual([ORDER, VENUE])
  })

  it('🔴 H4 (segunda ola): sin OrderCustomer el beneficiario validado es el heredado que pasa quien llama', async () => {
    conVenta({ orderCustomers: [] })
    await otorgarLealtadRespetandoReembolsos({ ...ARGS, legacyCustomer: { id: 'heredado', firstName: null, lastName: null } })
    expect(awardMock).toHaveBeenCalledWith(expect.anything(), { cerrar: false, beneficiario: 'heredado' })
  })

  it('H4 (segunda ola): la venta ya no existe (o no es del negocio): la lealtad corre sin beneficiario fijado (no acredita a nadie de otro lado)', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null)
    await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(awardMock).toHaveBeenCalledWith(ARGS, { cerrar: false })
  })

  it('🔴 H4 (tercera ola): la lealtad dice que OTRO intento ganó la venta para otro cliente ⇒ otroCliente y la venta se cierra', async () => {
    awardMock.mockResolvedValueOnce({ complete: true, errors: [], leyoSinCliente: false, otroCliente: true })
    const r = await otorgarLealtadRespetandoReembolsos(ARGS)
    expect(r).toEqual({ complete: true, errors: [], reembolsada: false, otroCliente: true })
    expect(cierres()).toHaveLength(1)
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

/**
 * 🔴 F2 (ronda 1 post-QA): la liga SIN `payments:create` a una venta cobrada (TPV) no pasa por el sello tardío, pero el hecho
 * «X ligó a Y a una venta YA cobrada» se audita igual, y la fila dice que no hubo lealtad por falta de permiso.
 */
describe('auditarLigaSinPermisoDeCobro', () => {
  it('🔴 venta cobrada: UNA fila CUSTOMER_ATTACHED_TO_PAID_ORDER con el actor, ligaNueva y lealtad SIN_PERMISO', async () => {
    await auditarLigaSinPermisoDeCobro({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock).toHaveBeenCalledWith({
      action: 'CUSTOMER_ATTACHED_TO_PAID_ORDER',
      entity: 'Order',
      entityId: ORDER,
      staffId: STAFF,
      venueId: VENUE,
      data: {
        customerId: CUST,
        orderNumber: 'ORD-1',
        decision: null,
        stamped: false,
        reason: 'SIN_PERMISO',
        lealtad: 'SIN_PERMISO',
        ligaNueva: true,
        otorgo: false,
        minutosDesdeElCobro: 30,
      },
    })
    expect(awardMock).not.toHaveBeenCalled()
  })

  it('cuenta abierta: no audita (no es una venta cobrada)', async () => {
    conVenta({ paymentStatus: 'PENDING' })
    await auditarLigaSinPermisoDeCobro({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('🔴 R7-2: cuenta PARTIAL con un abono devuelto (nunca se saldó): no es una venta cobrada, NO audita', async () => {
    conVenta({ paymentStatus: 'PARTIAL' })
    prismaMock.payment.count.mockResolvedValue(1)
    await auditarLigaSinPermisoDeCobro({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF })
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('nunca lanza: si la lectura truena, la liga (que ya quedó) no se entera', async () => {
    prismaMock.order.findFirst.mockRejectedValueOnce(new Error('P1001'))
    await expect(auditarLigaSinPermisoDeCobro({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: null })).resolves.toBeUndefined()
    expect(logActionMock).not.toHaveBeenCalled()
  })

  it('🔴 R3-1: si la relectura truena pero quien llama ya leyó la venta cobrada (bajo su candado), la fila sale con lo que sabe', async () => {
    prismaMock.order.findFirst.mockRejectedValueOnce(new Error('P1001'))
    await expect(
      auditarLigaSinPermisoDeCobro({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, orderNumber: 'ORD-1' }),
    ).resolves.toBeUndefined()
    expect(logActionMock).toHaveBeenCalledTimes(1)
    expect(logActionMock.mock.calls[0][0]).toMatchObject({ entityId: ORDER, staffId: STAFF })
    expect(logActionMock.mock.calls[0][0].data).toMatchObject({
      orderNumber: 'ORD-1',
      lealtad: 'SIN_PERMISO',
      ligaNueva: true,
      otorgo: false,
      minutosDesdeElCobro: null,
    })
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

  // ── H5 (auditoría de Codex del código + revisión final Minor 5, 15-oct-2026) ──────────────────────────────────────────
  it('🔴 H5: guarda al actor de la liga en loyaltyStaffId: si el intento inmediato falla, el reconciliador sella a nombre de quien LIGÓ', async () => {
    await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: 'barista' })
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER, venueId: VENUE },
      data: { loyaltyProcessedAt: null, loyaltyProcessingAt: null, loyaltyLastError: MARCA, loyaltyStaffId: 'barista' },
    })
  })

  it('H5: sin actor conocido no se toca loyaltyStaffId (se conserva quien cobró)', async () => {
    await reabrirLealtadSiAplica(tx(), { venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: null })
    expect(prismaMock.order.updateMany.mock.calls[0][0].data).not.toHaveProperty('loyaltyStaffId')
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

describe('🔴 H5: el reconciliador sella a nombre de quien LIGÓ al cliente, no de quien cobró', () => {
  it('la liga reabre con su actor; el intento inmediato falla; el reconciliador usa el actor de la liga', async () => {
    const fila = { ...filaYaProcesada(), loyaltyStaffId: 'cajero' }
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    expect(
      await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: 'barista' }),
    ).toBe(true)
    expect(fila.loyaltyStaffId).toBe('barista')

    const reintento = jest.fn().mockResolvedValue({ complete: true, errors: [] })
    const job = new LoyaltyReconciliationJob({
      prisma: { order: tabla } as never,
      cron: cron(),
      award: reintento,
      now: () => new Date(Date.now()),
    })
    expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 1 })
    expect(reintento).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'barista' }))
  })

  it('la liga cambia el actor ENTRE la lectura del reconciliador y su reclamo: esa vuelta no la toma con el actor viejo; la siguiente sí, con el nuevo', async () => {
    const fila = { ...filaYaProcesada(), loyaltyProcessedAt: null, loyaltyStaffId: 'cajero' }
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    let primeraLectura = true
    const lectura = {
      ...tabla,
      // La lectura devuelve una COPIA (como Postgres); justo después, la liga reabre con su actor.
      findMany: jest.fn(async (a: any) => {
        const copia = (await tabla.findMany(a)).map(f => ({ ...f }))
        if (primeraLectura) {
          primeraLectura = false
          await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: 'barista' })
        }
        return copia
      }),
    }
    const reintento = jest.fn().mockResolvedValue({ complete: true, errors: [] })
    const job = () =>
      new LoyaltyReconciliationJob({ prisma: { order: lectura } as never, cron: cron(), award: reintento, now: () => new Date(Date.now()) })

    expect(await job().runNow()).toMatchObject({ scanned: 1, applied: 0, skipped: 1 })
    expect(reintento).not.toHaveBeenCalled()
    expect(await job().runNow()).toMatchObject({ scanned: 1, applied: 1 })
    expect(reintento).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'barista' }))
  })
})

describe('🔴 H5, segunda ola: la liga llega DESPUÉS del reclamo del reconciliador', () => {
  it('el reconciliador reclama (actor leído: cajero) → el barista liga a CUST y reabre → la lealtad sella con el BARISTA', async () => {
    // Venta pendiente sin cliente, cobrada por el cajero.
    const fila = { ...filaYaProcesada(), loyaltyProcessedAt: null, loyaltyStaffId: 'cajero', clientes: 0 }
    conVenta({ orderCustomers: [], loyaltyStaffId: 'cajero' })
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    const conLigaTrasElReclamo = {
      ...tabla,
      updateMany: jest.fn(async (a: any) => {
        const r = await tabla.updateMany(a)
        if (a.data?.loyaltyAttempts && r.count === 1) {
          // La liga: OrderCustomer primario + reapertura con su actor (processingAt en null, marca, loyaltyStaffId).
          fila.clientes = 1
          conVenta({ orderCustomers: [{ customerId: CUST }], loyaltyStaffId: 'barista' })
          await reabrirLealtadSiAplica(prismaMock as never, { venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: 'barista' })
        }
        return r
      }),
    }
    const job = new LoyaltyReconciliationJob({
      prisma: { order: conLigaTrasElReclamo } as never,
      cron: cron(),
      now: () => new Date(Date.now()),
    })
    await job.runNow()

    expect(fila.loyaltyStaffId).toBe('barista')
    // El actor sale de la MISMA lectura que el cliente que se acredita: nunca «cajero + cliente nuevo».
    expect(awardMock).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'barista' }), { cerrar: false, beneficiario: CUST })
  })

  it('el envoltorio sólo cambia el actor si quien llama lo pide (la liga y la reparación pasan el suyo)', async () => {
    conVenta({ loyaltyStaffId: 'cajero' })
    await otorgarLealtadRespetandoReembolsos({ venueId: VENUE, orderId: ORDER, orderTotal: 80, staffId: STAFF, legacyCustomer: null })
    expect(awardMock).toHaveBeenCalledWith(expect.objectContaining({ staffId: STAFF }), expect.anything())
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

  it('🔴 H4: Ana sellada y con puntos → la TPV quita a Ana y pone a CUST → el reconciliador ⇒ CUST no recibe nada y la venta se cierra', async () => {
    // La venta quedó pendiente (otro efecto falló) DESPUÉS de darle sello y puntos a Ana.
    const fila = { ...filaYaProcesada(), loyaltyProcessedAt: null, loyaltyLastError: 'metrics:ana:deadlock' }
    const tabla = tablaDeUnaVenta(fila)
    prismaMock.order.updateMany.mockImplementation(tabla.updateMany as never)
    eventosDeLaVenta = [EARN('ana')]
    puntosDeLaVenta = [{ customerId: 'ana' }]
    conVenta({ orderCustomers: [{ customerId: CUST }] }) // la TPV quitó a Ana y CUST quedó primario

    const job = new LoyaltyReconciliationJob({ prisma: { order: tabla } as never, cron: cron(), now: () => new Date(Date.now()) })
    expect(await job.runNow()).toMatchObject({ scanned: 1, applied: 1, failed: 0 })

    expect(awardMock).not.toHaveBeenCalled() // ni sello ni puntos ni visita para CUST por una compra que ya era de Ana
    expect(puntosDeLaVenta).toEqual([{ customerId: 'ana' }])
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
