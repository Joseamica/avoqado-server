/**
 * 🔴 R4-1 (ronda 4 post-QA de sellos tardíos; Codex recheck-8, P2): los hechos «otorgó sello / otorgó puntos» no se pierden
 * aunque falle una lectura POSTERIOR dentro de `earnPoints`.
 *
 * El caso de Codex: una re-liga con permiso otorga el sello (`grantStamp`) y después truena una de las lecturas que
 * `earnPoints` hace DESPUÉS de sellar — el movimiento de puntos, el saldo, el cálculo de puntos (relee la config) o las dos
 * lecturas de la recuperación de un P2002. El error salía SIN `otorgadoAntesDelFallo`: el envoltorio devolvía `FALLO` sin
 * hechos y la auditoría de la re-liga no corría (sello otorgado y CERO filas); con `ligaNueva: true` la fila decía
 * `otorgo: false`. Y un P2002 DIFERIDO del sellado que llega después de confirmar los puntos perdía «otorgó puntos» si la
 * recuperación fallaba.
 *
 * Estas pruebas atraviesan TODO lo real — `awardLoyaltyForLateCustomer` → `otorgarLealtadRespetandoReembolsos` →
 * `awardLoyaltyForPaidOrder` → `acreditar` → `earnPoints` (NO un doble) — y sólo simulan la base (Prisma), el sellado
 * (`grantStamp`), el plan y las métricas. Cada una afirma la fila de auditoría y sus hechos.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/wallet/stampLedger.service', () => ({
  grantStamp: jest.fn(),
  getStampCardStatus: jest.fn(),
  reverseStampForOrder: jest.fn(),
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ updateCustomerMetrics: jest.fn() }))

import { grantStamp, getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { awardLoyaltyForLateCustomer } from '@/services/shared/loyaltyOnLateCustomer'

const grantStampMock = grantStamp as jest.Mock
const cardMock = getStampCardStatus as jest.Mock
const featureMock = venueHasFeatureAccess as jest.Mock
const metricsMock = updateCustomerMetrics as jest.Mock
const logActionMock = logAction as jest.Mock

const VENUE = 'venue-1'
const ORDER = 'order-1'
const CUST = 'cust-1'
const STAFF = 'staff-1'
const AUDITORIA = 'CUSTOMER_ATTACHED_TO_PAID_ORDER'
const AHORA_FIJO = Date.UTC(2026, 9, 15, 18, 0, 0)
const hace = (ms: number) => new Date(AHORA_FIJO - ms)
const D = (n: number) => new Prisma.Decimal(n)

/** El libro simulado de ESTA venta: lo que `grantStamp` y la escritura de puntos dejan, y lo que las relecturas ven. */
let sellosDeLaVenta: Array<{ type: string; stampCard: { customerId: string } }>
let puntosDeLaVenta: Array<{ customerId: string }>
/** Cuántas lecturas «EARN de este cliente en esta venta» (`{ customerId, orderId, type }`) van: 1.ª = idempotencia, … */
let lecturasDelEarnPropio: number
/** Cuántas lecturas de la config completa (`findUnique({ where: { venueId } })`, sin `select`) van: 1.ª = earnPoints. */
let lecturasDeConfig: number

const errorDeBase = (texto: string) => new Error(texto)
const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })

function venta() {
  return {
    id: ORDER,
    orderNumber: 'ORD-1',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    total: D(30),
    tipAmount: D(0),
    customerId: null,
    loyaltyEligibleAt: hace(10 * 60_000),
    loyaltyProcessedAt: hace(10 * 60_000),
    orderCustomers: [{ customerId: CUST }],
    payments: [{ createdAt: hace(10 * 60_000) }],
    stampEvents: [...sellosDeLaVenta],
    loyaltyTransactions: [...puntosDeLaVenta],
  }
}

/** Las filas de auditoría de la liga a una venta cobrada que se escribieron. */
const filas = () => logActionMock.mock.calls.map(([a]) => a).filter(a => a.action === AUDITORIA)

let relojFijo: jest.SpyInstance
afterEach(() => relojFijo.mockRestore())

beforeEach(() => {
  relojFijo = jest.spyOn(Date, 'now').mockReturnValue(AHORA_FIJO)
  sellosDeLaVenta = []
  puntosDeLaVenta = []
  lecturasDelEarnPropio = 0
  lecturasDeConfig = 0
  for (const m of [
    grantStampMock,
    prismaMock.order.findFirst,
    prismaMock.order.updateMany,
    prismaMock.payment.count,
    prismaMock.$queryRaw,
    prismaMock.$transaction,
    prismaMock.loyaltyConfig.findUnique,
    prismaMock.loyaltyTransaction.findFirst,
    prismaMock.loyaltyTransaction.create,
    prismaMock.customer.findUnique,
    prismaMock.customer.update,
    prismaMock.stampEvent.findFirst,
    prismaMock.stampEvent.count,
    prismaMock.staffVenue.findFirst,
    prismaMock.orderCustomer.findMany,
  ] as jest.Mock[])
    m.mockReset()

  featureMock.mockResolvedValue(true)
  metricsMock.mockResolvedValue(undefined)
  cardMock.mockResolvedValue({ stampsEarned: 1, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })

  prismaMock.order.findFirst.mockImplementation(async () => venta())
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.payment.count.mockResolvedValue(0) // sin reembolsos
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  prismaMock.stampEvent.count.mockResolvedValue(0)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  // La foto de UNA sentencia del envoltorio (H4/H5), sacada del mismo libro simulado.
  prismaMock.$queryRaw.mockImplementation(async () => [
    {
      staffId: null,
      primario: CUST,
      clientes: 1,
      sellos: sellosDeLaVenta.filter(e => e.type === 'EARN').map(e => e.stampCard.customerId),
      puntos: puntosDeLaVenta.map(p => p.customerId),
    },
  ])
  prismaMock.orderCustomer.findMany.mockResolvedValue([
    { customerId: CUST, isPrimary: true, customer: { id: CUST, firstName: 'Kev', lastName: null } },
  ])
  // Programa activo con sellos y 1 punto por peso. `leerPrograma` pide un `select`; earnPoints y su cálculo, la fila completa.
  prismaMock.loyaltyConfig.findUnique.mockImplementation(async (args: { select?: unknown }) => {
    if (!args?.select) lecturasDeConfig++
    return {
      id: 'cfg',
      venueId: VENUE,
      active: true,
      stampsEnabled: true,
      maxStampsPerDay: 0,
      pointsPerDollar: D(1),
      pointsPerVisit: D(0),
      redemptionRate: D(0.01),
      minPointsRedeem: 100,
      pointsExpireDays: 365,
    }
  })
  // El sellado de verdad deja su EARN en el libro.
  grantStampMock.mockImplementation(async () => {
    sellosDeLaVenta.push({ type: 'EARN', stampCard: { customerId: CUST } })
    return { granted: true, stampsEarned: 1, stampsRequired: 7 }
  })
  prismaMock.loyaltyTransaction.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const w = args?.where ?? {}
    if (w.customerId === CUST && w.orderId === ORDER) {
      lecturasDelEarnPropio++
      return puntosDeLaVenta.some(p => p.customerId === CUST) ? { id: 'lt-1', points: 30 } : null
    }
    return null // los EARN de OTRO cliente (dentro de la transacción de puntos)
  })
  prismaMock.stampEvent.findFirst.mockResolvedValue(null)
  prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prismaMock))
  prismaMock.loyaltyTransaction.create.mockImplementation(async () => {
    puntosDeLaVenta.push({ customerId: CUST })
    return { id: 'lt-1', points: 30 }
  })
  prismaMock.customer.update.mockResolvedValue({ loyaltyPoints: 30 })
  prismaMock.customer.findUnique.mockResolvedValue({ loyaltyPoints: 30 })
})

/** Hace fallar la N-ésima lectura del EARN propio (1.ª = idempotencia; con P2002 de los puntos, la 2.ª = recuperación). */
function fallaLaLecturaDelEarnPropio(n: number, error: Error) {
  const original = prismaMock.loyaltyTransaction.findFirst.getMockImplementation() as (a: any) => Promise<unknown>
  prismaMock.loyaltyTransaction.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    const w = args?.where ?? {}
    if (w.customerId === CUST && w.orderId === ORDER && lecturasDelEarnPropio + 1 === n) {
      lecturasDelEarnPropio++
      throw error
    }
    return original(args)
  })
}

/** Los cinco puntos de Codex (`loyalty.dashboard.service.ts` en e2dd863f0) + el P2002 diferido del sellado. */
const PUNTOS_DE_FALLA: Array<[string, () => void, { otorgoSello: boolean; otorgoPuntos: boolean }]> = [
  ['búsqueda del movimiento de puntos (:384)', () => fallaLaLecturaDelEarnPropio(1, errorDeBase('lectura del EARN')), SOLO_SELLO()],
  [
    'saldo cuando ya existían los puntos (:394)',
    () => {
      puntosDeLaVenta.push({ customerId: CUST }) // los puntos los dejó un intento anterior; el sello es de ESTA llamada
      prismaMock.customer.findUnique.mockRejectedValue(errorDeBase('lectura del saldo'))
    },
    SOLO_SELLO(),
  ],
  [
    'cálculo de puntos que relee la config (:408)',
    () => {
      const original = prismaMock.loyaltyConfig.findUnique.getMockImplementation() as (a: any) => Promise<unknown>
      prismaMock.loyaltyConfig.findUnique.mockImplementation(async (args: { select?: unknown }) => {
        if (!args?.select && lecturasDeConfig === 1) {
          lecturasDeConfig++
          throw errorDeBase('relectura de la config')
        }
        return original(args)
      })
    },
    SOLO_SELLO(),
  ],
  [
    'recuperación de P2002: el movimiento ganador (:507)',
    () => {
      prismaMock.$transaction.mockRejectedValue(p2002())
      fallaLaLecturaDelEarnPropio(2, errorDeBase('relectura del EARN ganador'))
    },
    SOLO_SELLO(),
  ],
  [
    'recuperación de P2002: el saldo (:510)',
    () => {
      prismaMock.$transaction.mockRejectedValue(p2002())
      prismaMock.customer.findUnique.mockRejectedValue(errorDeBase('relectura del saldo'))
    },
    SOLO_SELLO(),
  ],
  [
    'P2002 DIFERIDO del sellado que llega después de confirmar los puntos, y la recuperación falla',
    () => {
      grantStampMock.mockReset().mockRejectedValue(p2002()) // el sello NO quedó
      // 1.ª = idempotencia, 2.ª = la de adentro de la transacción de puntos, 3.ª = la recuperación (la que truena).
      fallaLaLecturaDelEarnPropio(3, errorDeBase('relectura tras el P2002 diferido'))
    },
    { otorgoSello: false, otorgoPuntos: true },
  ],
]

function SOLO_SELLO() {
  return { otorgoSello: true, otorgoPuntos: false }
}

describe('🔴 R4-1: lo otorgado viaja hasta la auditoría aunque truene una lectura posterior de earnPoints (earnPoints REAL)', () => {
  it.each(PUNTOS_DE_FALLA)(
    're-liga con permiso (ligaNueva:false) — falla %s ⇒ la fila EXISTE y dice lo otorgado',
    async (_n, fallar, hechos) => {
      fallar()
      await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })

      expect(filas()).toEqual([
        expect.objectContaining({
          entityId: ORDER,
          staffId: STAFF,
          data: expect.objectContaining({ customerId: CUST, ligaNueva: false, otorgo: true, ...hechos }),
        }),
      ])
    },
  )

  it.each(PUNTOS_DE_FALLA)('liga nueva (ligaNueva:true) — falla %s ⇒ UNA fila que NO dice «no otorgó»', async (_n, fallar, hechos) => {
    fallar()
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: true })

    expect(filas()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ customerId: CUST, ligaNueva: true, otorgo: true, ...hechos }) }),
    ])
  })

  it('🔴 carrera H4: ESTA llamada selló y, al escribir los puntos, OTRO cliente ya los tenía (otroCliente) ⇒ la fila existe y dice «otorgó sello»', async () => {
    // Los puntos del otro aparecen DESPUÉS de la foto del envoltorio: sólo los ve la transacción de puntos (bajo su candado).
    const original = prismaMock.loyaltyTransaction.findFirst.getMockImplementation() as (a: any) => Promise<unknown>
    prismaMock.loyaltyTransaction.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      typeof args?.where?.customerId === 'object' ? { customerId: 'otro' } : original(args),
    )
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(filas()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ ligaNueva: false, otorgo: true, otorgoSello: true, otorgoPuntos: false }),
      }),
    ])
  })

  it('con el sello otorgado, la fila dice `stamped: true` (la relectura ve el sello)', async () => {
    fallaLaLecturaDelEarnPropio(1, errorDeBase('lectura del EARN'))
    const r = await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(r).toMatchObject({ stamped: true })
    expect(filas()[0].data).toMatchObject({ stamped: true, reason: null })
  })

  it('regresión: sin fallas, sello y puntos de ESTA llamada ⇒ una fila con los dos hechos', async () => {
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(filas()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ ligaNueva: false, otorgo: true, otorgoSello: true, otorgoPuntos: true }) }),
    ])
  })

  it('regresión: re-liga que no otorga nada (venta ya sellada y con sus puntos) ⇒ CERO filas', async () => {
    sellosDeLaVenta.push({ type: 'EARN', stampCard: { customerId: CUST } })
    puntosDeLaVenta.push({ customerId: CUST })
    grantStampMock.mockReset().mockResolvedValue({ granted: false, reason: 'ALREADY_STAMPED' })
    await awardLoyaltyForLateCustomer({ venueId: VENUE, orderId: ORDER, customerId: CUST, staffId: STAFF, ligaNueva: false })
    expect(filas()).toEqual([])
  })
})
