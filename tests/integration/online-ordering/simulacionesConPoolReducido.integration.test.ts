/**
 * S11 (R2''', Codex r4 #2) contra Postgres REAL y con el pool del proceso REDUCIDO a 6 conexiones: las cotizaciones de la tienda
 * (S10) y los borradores de tarjeta con sesión (S11) comparten UN semáforo calculado sobre ese `connection_limit` (⌊6/6⌋ = 1), y un
 * cobro de caja independiente consigue conexión y termina MIENTRAS la simulación que tomó el lugar sigue ocupada.
 *
 * Cómo se reduce el pool: la fábrica de `jest.mock('@/utils/prismaClient')` pone `connection_limit=6` en la `DATABASE_URL` de la base
 * de pruebas y carga el módulo REAL. Es el singleton que usan todos los servicios de este archivo, así que el pool de 6 es el del
 * proceso, y `SIMULACION.global` sale de esa MISMA URL al cargar `beneficios.service` (como en producción). La URL original vuelve
 * en `afterAll`.
 *
 * Cómo se mide: un gancho en `prisma.$transaction` reconoce la transacción de la simulación (su `timeout` único) y la RETIENE ya dentro
 * de ella (con su conexión) hasta que el cobro termina o pasa el reloj. El control quita el tope (12 lugares): las simulaciones
 * retenidas llenan el pool de 6 y el MISMO cobro espera detrás de ellas. Así la prueba distingue: si el semáforo no protegiera el
 * pool, el cobro no terminaría con la simulación retenida.
 */
import '../../__helpers__/integration-setup'
import cuid from 'cuid'
import type AppError from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => {
  const url = new URL(process.env.DATABASE_URL as string)
  process.env.S11_DATABASE_URL_SIN_REDUCIR = process.env.DATABASE_URL
  url.searchParams.set('connection_limit', '6')
  process.env.DATABASE_URL = url.toString()
  return jest.requireActual('@/utils/prismaClient')
})
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn(async () => ({ notified: 0 })),
  reintentarAvisosDeTarjeta: jest.fn().mockResolvedValue({ avisados: 0, fallidos: 0, ocupados: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/online-ordering/notifications.service', () => ({
  ...jest.requireActual('@/services/online-ordering/notifications.service'),
  notifyOrderEvent: jest.fn(async () => undefined),
}))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn() }))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))

import prisma, { buildDatasourceUrl } from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { SIMULACION, cotizarConBeneficios, topeGlobalDeSimulaciones } from '@/services/online-ordering/beneficios.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'

jest.setTimeout(120_000)

const POOL = 6
const RUN = cuid()
/** El `timeout` de la transacción de simulación en este archivo: único, así el gancho la reconoce sin tocar las demás. */
const TIEMPO_DE_SIMULACION = 19_999
const original = { ...SIMULACION, transaccion: { ...SIMULACION.transaccion } }
let n = 0
const llave = () => `s11p-${RUN}-${++n}`.padEnd(40, 'x')
const telefono = () => `+5255${50_000_000 + (((Date.now() % 1_000_000) * 10 + ++n) % 40_000_000)}`
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms))
async function hasta(condicion: () => boolean, ms: number, que: string) {
  const limite = Date.now() + ms
  while (!condicion()) {
    if (Date.now() > limite) throw new Error(`no ocurrió a tiempo: ${que}`)
    await esperar(10)
  }
}

interface Negocio {
  orgId: string
  venueId: string
  productoId: string
}
const negocios: Negocio[] = []

/** Un negocio en «Mi equipo» con tarjeta en línea (comercio Stripe), su producto de $100 en línea y la lealtad prendida. */
async function negocio(): Promise<Negocio> {
  const sello = `${RUN}-${negocios.length + 1}`
  const orgId = (
    await prisma.organization.create({ data: { name: `s11p-${sello}`, email: `s11p-${sello}@example.test`, phone: '5550000000' } })
  ).id
  const venueId = (
    await prisma.venue.create({
      data: {
        organizationId: orgId,
        name: `s11p-${sello}`,
        slug: `itest-s11p-${sello}`,
        status: 'LIVE_DEMO',
        timezone: 'America/Mexico_City',
      },
    })
  ).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Menú', slug: `menu-${sello}` } })
  const productoId = (
    await prisma.product.create({
      data: { venueId, categoryId: categoria.id, name: 'Combo', sku: `S11P-${sello}`, price: 100, availableOnline: true },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, stampsEnabled: true, pointsPerDollar: 1, redemptionRate: 0.01, minPointsRedeem: 1, stampsRequired: 7 },
  })
  await prisma.onlineOrderingSettings.create({
    data: {
      venueId,
      enabled: true,
      minOrderAmount: 0,
      defaultPrepMinutes: 15,
      requiresAcceptance: true,
      acceptsPayAtPickup: true,
      acceptsCardOnline: true,
      lastInboxPollAt: new Date(),
    },
  })
  const provider = await prisma.paymentProvider.upsert({
    where: { code: 'STRIPE_CONNECT' },
    update: {},
    create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  await prisma.ecommerceMerchant.create({
    data: {
      venueId,
      businessName: `s11p-${sello}`,
      contactEmail: `s11p-merchant-${sello}@example.test`,
      publicKey: `pk_test_s11p_${sello}`,
      secretKeyHash: `s11p-hash-${sello}`,
      providerId: provider.id,
      providerCredentials: { connectAccountId: 'acct_s11p' },
      chargesEnabled: true,
      platformFeeBps: 100,
      sandboxMode: true,
    },
  })
  const r = { orgId, venueId, productoId }
  negocios.push(r)
  return r
}

const clienta = async (neg: Negocio) => {
  const phone = telefono()
  const c = await prisma.customer.create({ data: { venueId: neg.venueId, firstName: `Ana ${++n}`, phone, loyaltyPoints: 500 } })
  return { id: c.id, phone }
}

type Resultado = 'ok' | AppError
const resultado = (p: Promise<unknown>): Promise<Resultado> =>
  p.then(
    () => 'ok' as const,
    (e: unknown) => e as AppError,
  )

/** El borrador de tarjeta con sesión de teléfono probado (siempre simula su total, R2''). */
const borrador = (neg: Negocio, c: { id: string; phone: string }, key: string) =>
  createCardOnlineDraft(
    {
      venueId: neg.venueId,
      venueSlug: 'itest-s11p',
      idempotencyKey: key,
      items: [{ productId: neg.productoId, quantity: 1 }],
      expectedTotal: '100.00',
      customer: { name: 'Ana Tarjeta', phone: c.phone, email: 'ana@test.com' },
      note: null,
      whatsappConsent: false,
      customerId: c.id,
      verifiedPhone: c.phone,
      beneficios: null,
    },
    { assertCanCreate: async () => {} },
  )

/** Una cuenta abierta de $100 en un TERCER negocio: el cobro independiente de la caja. */
async function cuentaDeCaja(neg: Negocio) {
  return prisma.order.create({
    data: {
      venueId: neg.venueId,
      orderNumber: `S11P${++n}`,
      type: 'PICKUP',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: 100,
      discountAmount: 0,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: { create: [{ productId: neg.productoId, productName: 'Combo', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 }] },
    },
  })
}

let checkoutSpy: jest.SpyInstance

beforeAll(() => {
  clearPublicMenuCache()
})

beforeEach(() => {
  Object.assign(SIMULACION, { ...original, transaccion: { maxWait: 5_000, timeout: TIEMPO_DE_SIMULACION } })
  checkoutSpy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout').mockImplementation(async (_m: any, p: any) => ({
    id: `cs_s11p_${p.metadata.chargeId}`,
    url: `https://checkout.stripe.test/${p.metadata.chargeId}`,
    expiresAt: p.expiresAt,
  }))
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  Object.assign(SIMULACION, original)
  for (const { venueId, orgId } of negocios) {
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.onlineOrderCharge.deleteMany({ where: { venueId } })
    await prisma.inventoryPosting.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.walletPassOutbox.deleteMany({ where: { venueId } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  }
  await prisma.$disconnect()
  process.env.DATABASE_URL = process.env.S11_DATABASE_URL_SIN_REDUCIR
})

/**
 * La ráfaga: en DOS negocios, 3 cotizaciones con sesión y 3 borradores (dos de ellos la MISMA solicitud con la MISMA K) a la vez. Las
 * simulaciones que entran a su transacción quedan retenidas ahí. Cuando hay `retenidas` (y, si se pide, las demás operaciones ya
 * terminaron), se cobra en efectivo una cuenta de un TERCER negocio y se mide. Se sueltan al terminar el cobro o a los `soltarTrasMs`.
 */
async function rafagaConCobro(o: { retenidas: number; lasDemasTerminadas: boolean; soltarTrasMs: number }) {
  const [a, b, caja] = [await negocio(), await negocio(), await negocio()]
  const venta = await cuentaDeCaja(caja)
  let soltar!: () => void
  const compuerta = new Promise<void>(r => (soltar = r))
  let enVuelo = 0
  let maximo = 0
  let entradas = 0
  const real = prisma.$transaction.bind(prisma) as (...a: any[]) => any
  jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, opts: any) => {
    if (typeof fn !== 'function' || opts?.timeout !== TIEMPO_DE_SIMULACION) return real(fn, opts)
    return real(async (tx: unknown) => {
      entradas++
      enVuelo++
      maximo = Math.max(maximo, enVuelo)
      try {
        await compuerta // retenida DENTRO de su transacción: con su conexión del pool
        return await fn(tx)
      } finally {
        enVuelo--
      }
    }, opts)
  }) as any)

  const operaciones: Array<{ tipo: 'cotizacion' | 'borrador'; venueId: string; key?: string; promesa: Promise<unknown> }> = []
  let terminadas = 0
  const lanzar = (tipo: 'cotizacion' | 'borrador', venueId: string, promesa: Promise<unknown>, key?: string) => {
    promesa.then(
      () => terminadas++,
      () => terminadas++,
    )
    operaciones.push({ tipo, venueId, key, promesa })
  }
  for (const neg of [a, b]) {
    const cs = await Promise.all([clienta(neg), clienta(neg), clienta(neg), clienta(neg), clienta(neg)])
    const K = llave()
    await prisma.onlineOrderingSettings.update({ where: { venueId: neg.venueId }, data: { lastInboxPollAt: new Date() } })
    for (const c of cs.slice(0, 3)) {
      lanzar(
        'cotizacion',
        neg.venueId,
        cotizarConBeneficios(neg.venueId, [{ productId: neg.productoId, quantity: 1 }], { customerId: c.id, eleccion: null }),
      )
    }
    lanzar('borrador', neg.venueId, resultado(borrador(neg, cs[3], K)), K)
    lanzar('borrador', neg.venueId, resultado(borrador(neg, cs[3], K)), K) // la repetición de K
    const K2 = llave()
    lanzar('borrador', neg.venueId, resultado(borrador(neg, cs[4], K2)), K2)
  }

  await hasta(() => enVuelo >= o.retenidas, 20_000, `${o.retenidas} simulación(es) retenida(s)`)
  if (o.lasDemasTerminadas) await hasta(() => terminadas >= operaciones.length - o.retenidas, 20_000, 'las demás operaciones')

  let soltadoEn = 0
  let soltadoPorReloj = false
  const reloj = setTimeout(() => {
    soltadoPorReloj = true
    soltadoEn = Date.now()
    soltar()
  }, o.soltarTrasMs)
  const inicio = Date.now()
  const cobro = await payCashOrder(caja.venueId, venta.id, {
    amount: 10_000,
    tip: 0,
    idempotencyKey: `s11p-cobro-${venta.id}`,
  } as any).then(
    () => ({ ok: true as const, codigo: null }),
    (e: any) => ({ ok: false as const, codigo: String(e?.code ?? e?.errorCode ?? e?.message ?? e) }),
  )
  const terminoEn = Date.now()
  const retenidasAlTerminar = enVuelo
  if (!soltadoPorReloj) {
    clearTimeout(reloj)
    soltadoEn = Date.now()
    soltar()
  }
  const finales = await Promise.all(operaciones.map(op => op.promesa.catch((e: unknown) => e)))
  return {
    cobro: { ...cobro, ms: terminoEn - inicio, terminoEn, retenidasAlTerminar },
    soltadoEn,
    soltadoPorReloj,
    maximo,
    entradas,
    venta,
    operaciones: operaciones.map((op, i) => ({ ...op, final: finales[i] })),
    negocios: [a, b],
  }
}

describe("S11 · R2''': simulaciones de cotizar y de borradores contra el pool REDUCIDO del proceso", () => {
  it('el pool de 6 da un tope de 1 sacado de la MISMA URL; la ráfaga entre dos negocios nunca pasa de 1 simulación y el cobro termina con ella retenida', async () => {
    expect(new URL(buildDatasourceUrl() as string).searchParams.get('connection_limit')).toBe(String(POOL))
    expect(topeGlobalDeSimulaciones(buildDatasourceUrl())).toBe(1)
    expect(original.global).toBe(1) // lo que calculó beneficios.service al cargar, con esta misma URL

    const r = await rafagaConCobro({ retenidas: 1, lasDemasTerminadas: true, soltarTrasMs: 8_000 })

    // Nunca más simulaciones a la vez que el tope, y sólo una llegó a simular: las demás no esperaron conexión, se rindieron.
    expect(r.maximo).toBe(1)
    expect(r.entradas).toBe(1)
    // El cobro consiguió conexión y terminó MIENTRAS la simulación seguía retenida, en tiempo acotado (nunca detrás de ella).
    expect(r.cobro).toMatchObject({ ok: true, retenidasAlTerminar: 1 })
    expect(r.soltadoPorReloj).toBe(false)
    expect(r.cobro.ms).toBeLessThan(5_000)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: r.venta.id } })).paymentStatus).toBe('PAID')

    // Sin lugar: la cotización sale sin beneficios y el borrador responde 503 reintentable; la única que simuló, completa.
    const cotizaciones = r.operaciones
      .filter(op => op.tipo === 'cotizacion')
      .map(op => op.final as { beneficios?: { calculados: boolean } })
    const borradores = r.operaciones.filter(op => op.tipo === 'borrador').map(op => op.final as Resultado)
    expect(cotizaciones.filter(q => q.beneficios?.calculados === true).length + borradores.filter(x => x === 'ok').length).toBe(1)
    for (const x of borradores.filter(x => x !== 'ok')) {
      expect(x).toMatchObject({ statusCode: 503, code: 'BENEFITS_CALCULATION_UNAVAILABLE' })
    }
    // Las repeticiones de K: a lo más UN borrador por llave, y un 503 nunca deja decisión guardada bajo la llave.
    for (const { venueId } of r.negocios) {
      for (const key of new Set(r.operaciones.filter(op => op.venueId === venueId && op.key).map(op => op.key as string))) {
        expect(await prisma.onlineOrderCharge.count({ where: { venueId, idempotencyKey: key } })).toBeLessThanOrEqual(1)
        expect(await prisma.idempotencyRequest.count({ where: { organizationId: `venue:${venueId}`, idempotencyKey: key } })).toBe(0)
      }
    }
    expect(checkoutSpy.mock.calls.length).toBe(borradores.filter(x => x === 'ok').length)
  })

  it('control: sin tope efectivo (12 lugares) las simulaciones retenidas llenan el pool de 6 y el MISMO cobro espera detrás de ellas', async () => {
    SIMULACION.global = 12
    SIMULACION.porNegocio = 12

    const r = await rafagaConCobro({ retenidas: POOL, lasDemasTerminadas: false, soltarTrasMs: 3_000 })

    // El semáforo dejaba 12: lo que las detuvo en 6 fue el pool (prueba de que el pool del proceso es de 6).
    expect(r.maximo).toBe(POOL)
    // El cobro no pudo terminar con ellas retenidas: o terminó DESPUÉS de soltarlas, o se agotó esperando conexión.
    expect(r.soltadoPorReloj).toBe(true)
    if (r.cobro.ok) {
      expect(r.cobro.terminoEn).toBeGreaterThanOrEqual(r.soltadoEn)
    } else {
      expect(r.cobro.codigo).toMatch(/P2024|P2028|Timed out|Unable to start a transaction/)
    }
  })
})
