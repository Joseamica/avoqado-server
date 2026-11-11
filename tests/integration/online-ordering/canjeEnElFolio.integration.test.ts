/**
 * S11 (B2, P2-3, P2-4) contra Postgres REAL: canjear dentro del folio, UNA vez, al crearlo. Rulings de `task-S11-go.md`:
 * - E1/E2/E11: la clienta de la sesión (en «Nadie» con cualquier contacto probado) y la cotización de S10 = el folio de verdad.
 * - R1/R1': un `PRICE_CHANGED` es LA decisión de la llave (negocio + llave): un envío demorado nunca crea un segundo folio.
 * - R2: pagar al recoger nace con el total estricto ≤ lo que vio; `descartados` sale del error estricto.
 * - R2'/R2''/R2''': la tarjeta autoriza su total estricto simulado y el folio nace sólo si el estricto = lo autorizado (la ráfaga
 *   contra el pool reducido vive en `simulacionesConPoolReducido.integration.test.ts`).
 * - R4/R4': el motivo y el precio nuevo de una tarjeta liberada sobreviven a la liberación y a la recarga del seguimiento.
 * - R6/R8: el folio en $0 se cierra pagado (en «Nadie» al crearlo; en «Mi equipo» al aceptarlo), también en una tienda de sólo tarjeta.
 * - R7: una fila de bitácora por canje real, en la transacción del folio.
 *
 * Proveedores simulados (Stripe espiado, sockets, Wallet, avisos, comandas); todo lo demás es el código real.
 */
import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import * as cocina from '@/services/kds/kitchenDisplayStations'
import * as cotizador from '@/services/online-ordering/quote.service'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { SIMULACION, cotizarConBeneficios, type EleccionDeBeneficios } from '@/services/online-ordering/beneficios.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { createOnlineOrder, getTrackingByToken, type CreateOnlineOrderResult } from '@/services/online-ordering/order.service'
import { acceptOnlineOrder, cancelOnlineOrderByStaff, rejectOnlineOrder } from '@/services/online-ordering/transitions.service'

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

jest.setTimeout(120_000)

const RUN = cuid()
const PESOS = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v).toFixed(2)
const PUEDE = { assertCanCreate: async () => {} }
/** Codex r5: la comprobación del plan que no se pudo hacer (el 503 reintentable de `requirePublicVenueFeatureStrict`). */
const PLAN_503 = {
  assertCanCreate: async () => {
    throw new AppError('No pudimos verificar la disponibilidad. Intenta de nuevo.', 503, true, 'FEATURE_CHECK_UNAVAILABLE')
  },
}
const original = { ...SIMULACION, transaccion: { ...SIMULACION.transaccion } }
let n = 0
const llave = () => `s11-${RUN}-${++n}`.padEnd(40, 'x')
const telefono = () => `+5255${40_000_000 + (((Date.now() % 1_000_000) * 10 + ++n) % 50_000_000)}`

interface Negocio {
  orgId: string
  venueId: string
  productoId: string
  /** Un producto de $0 (para los $0 sin beneficio). */
  merchantId?: string
}
const negocios: Negocio[] = []

async function negocio(o: { nadie: boolean; tarjeta?: boolean }): Promise<Negocio> {
  const sello = `${RUN}-${negocios.length + 1}`
  const orgId = (
    await prisma.organization.create({ data: { name: `s11-${sello}`, email: `s11-${sello}@example.test`, phone: '5550000000' } })
  ).id
  const venueId = (
    await prisma.venue.create({
      data: {
        organizationId: orgId,
        name: `s11-${sello}`,
        slug: `itest-s11-${sello}`,
        status: 'LIVE_DEMO',
        timezone: 'America/Mexico_City',
      },
    })
  ).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Menú', slug: `menu-${sello}` } })
  const productoId = (
    await prisma.product.create({
      data: { venueId, categoryId: categoria.id, name: 'Combo', sku: `S11-${sello}`, price: 100, availableOnline: true },
    })
  ).id
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, stampsEnabled: true, pointsPerDollar: 1, redemptionRate: 0.01, minPointsRedeem: 1, stampsRequired: 7 },
  })
  // La fila de ajustes directa: los requisitos de encender la tienda (domicilio, aviso) no son de esta suite.
  await prisma.onlineOrderingSettings.create({
    data: {
      venueId,
      enabled: true,
      minOrderAmount: 0,
      defaultPrepMinutes: 15,
      requiresAcceptance: !o.nadie,
      acceptsPayAtPickup: true,
      acceptsCardOnline: o.tarjeta === true,
    },
  })
  let merchantId: string | undefined
  if (o.tarjeta) {
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    merchantId = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId,
          businessName: `s11-${sello}`,
          contactEmail: `s11-merchant-${sello}@example.test`,
          publicKey: `pk_test_s11_${sello}`,
          secretKeyHash: `s11-hash-${sello}`,
          providerId: provider.id,
          providerCredentials: { connectAccountId: 'acct_s11' },
          chargesEnabled: true,
          platformFeeBps: 100,
          sandboxMode: true,
        },
      })
    ).id
  }
  const r = { orgId, venueId, productoId, merchantId }
  negocios.push(r)
  return r
}

let nadie: Negocio
let equipo: Negocio
/** Stripe espiado. */
let checkoutSpy: jest.SpyInstance
let authSpy: jest.SpyInstance
let voidSpy: jest.SpyInstance
let captureSpy: jest.SpyInstance

beforeAll(async () => {
  nadie = await negocio({ nadie: true })
  equipo = await negocio({ nadie: false, tarjeta: true })
  clearPublicMenuCache()
  checkoutSpy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
  authSpy = jest.spyOn(StripeConnectProvider.prototype, 'getAuthorization')
  voidSpy = jest.spyOn(StripeConnectProvider.prototype, 'voidAuthorization')
  captureSpy = jest.spyOn(StripeConnectProvider.prototype, 'capture')
})

beforeEach(async () => {
  // El tope de este proceso depende de la URL de la base de pruebas: aquí se fija para que los casos simulen.
  Object.assign(SIMULACION, { ...original, global: 3, transaccion: { ...original.transaccion } })
  checkoutSpy.mockReset()
  checkoutSpy.mockImplementation(async (_m: any, p: any) => ({
    id: `cs_s11_${p.metadata.chargeId}`,
    url: `https://checkout.stripe.test/${p.metadata.chargeId}`,
    expiresAt: p.expiresAt,
  }))
  authSpy.mockReset()
  voidSpy.mockReset()
  voidSpy.mockImplementation(async (_m: any, p: any) => ({ ...apartado(0), paymentIntentId: p.paymentIntentId, piStatus: 'canceled' }))
  captureSpy.mockReset()
  captureSpy.mockImplementation(async (_m: any, p: any) => ({
    ...apartado(0),
    paymentIntentId: p.paymentIntentId,
    piStatus: 'succeeded',
    amountCapturableCents: 0,
    amountReceivedCents: p.amountCents,
  }))
  for (const neg of negocios) {
    await prisma.onlineOrderingSettings.update({
      where: { venueId: neg.venueId },
      data: { lastInboxPollAt: new Date(), lastToPayPollAt: new Date() },
    })
    // Los borradores vigentes de otros casos no topan a éste.
    await prisma.onlineOrderCharge.updateMany({
      where: { venueId: neg.venueId },
      data: { checkoutExpiresAt: new Date(Date.now() - 60_000) },
    })
  }
})

afterEach(() => {
  jest.restoreAllMocks()
  checkoutSpy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
  authSpy = jest.spyOn(StripeConnectProvider.prototype, 'getAuthorization')
  voidSpy = jest.spyOn(StripeConnectProvider.prototype, 'voidAuthorization')
  captureSpy = jest.spyOn(StripeConnectProvider.prototype, 'capture')
})

afterAll(async () => {
  Object.assign(SIMULACION, original)
  for (const { venueId, orgId } of negocios) {
    if (!venueId) continue
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.onlineOrderCharge.deleteMany({ where: { venueId } })
    await prisma.inventoryPosting.deleteMany({ where: { venueId } })
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.couponRedemption.deleteMany({ where: { couponCode: { discount: { venueId } } } })
    await prisma.walletPassOutbox.deleteMany({ where: { venueId } })
    await prisma.stampReward.deleteMany({ where: { venueId } })
    await prisma.stampCard.deleteMany({ where: { venueId } })
    await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.couponCode.deleteMany({ where: { discount: { venueId } } })
    await prisma.discount.deleteMany({ where: { venueId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.customerGroup.deleteMany({ where: { venueId } })
    await prisma.ecommerceMerchant.deleteMany({ where: { venueId } })
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
  }
  await prisma.$disconnect()
})

// ── siembra ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Clienta {
  id: string
  phone: string
  premioId: string
  grupoId: string
}

/** Una clienta en su propio grupo (así un automático de grupo no toca a otras), con un premio PENDING de `premio` pesos y `puntos`. */
async function clienta(neg: Negocio, o: { puntos?: number; premio?: number; conTelefono?: boolean } = {}): Promise<Clienta> {
  const grupo = await prisma.customerGroup.create({ data: { venueId: neg.venueId, name: `grupo-${++n}` } })
  const phone = telefono()
  const c = await prisma.customer.create({
    data: {
      venueId: neg.venueId,
      firstName: `Ana ${n}`,
      phone: o.conTelefono === false ? null : phone,
      loyaltyPoints: o.puntos ?? 0,
      customerGroupId: grupo.id,
    },
  })
  const cartilla = await prisma.stampCard.create({
    data: { customerId: c.id, venueId: neg.venueId, cycle: 1, stampsRequired: 7, stampsEarned: 7, completedAt: new Date() },
  })
  const premioId = (
    await prisma.stampReward.create({
      data: {
        stampCardId: cartilla.id,
        customerId: c.id,
        venueId: neg.venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: o.premio ?? 10,
        rewardLabel: 'Café gratis',
        status: 'PENDING',
      },
    })
  ).id
  return { id: c.id, phone, premioId, grupoId: grupo.id }
}

/** Un automático de grupo de `monto` pesos para la clienta. */
const automatico = (neg: Negocio, c: Clienta, monto = 10) =>
  prisma.discount.create({
    data: {
      venueId: neg.venueId,
      name: `Grupo ${++n}`,
      type: 'FIXED_AMOUNT',
      value: monto,
      scope: 'ORDER',
      customerGroupId: c.grupoId,
      isAutomatic: true,
      isStackable: true,
      active: true,
    },
  })

/** Un cupón de cuenta del 10 % con `usos` usos del código. */
async function cupon(neg: Negocio, usos: number | null = null) {
  const d = await prisma.discount.create({
    data: { venueId: neg.venueId, name: `Diez ${++n}`, type: 'PERCENTAGE', value: 10, scope: 'ORDER', isAutomatic: false, active: true },
  })
  const codigo = `S11${n}${RUN.slice(-6)}`.toUpperCase()
  const cc = await prisma.couponCode.create({ data: { discountId: d.id, code: codigo, maxUses: usos } })
  return { discountId: d.id, codigo, couponCodeId: cc.id }
}

/** Pagar al recoger. `sesion`: 'correo' = sesión sin teléfono probado; 'telefono' = con el teléfono probado del pedido. */
function pedir(
  neg: Negocio,
  o: {
    c?: Clienta | null
    sesion?: 'correo' | 'telefono' | null
    beneficios?: EleccionDeBeneficios | null
    expectedTotal: string
    key?: string
    puede?: typeof PUEDE
  },
): Promise<CreateOnlineOrderResult> {
  const sesion = o.c ? (o.sesion ?? 'correo') : null
  return createOnlineOrder(
    {
      venueId: neg.venueId,
      idempotencyKey: o.key ?? llave(),
      items: [{ productId: neg.productoId, quantity: 1 }],
      paymentMode: 'PAY_AT_PICKUP',
      expectedTotal: o.expectedTotal,
      customer: { name: 'Ana Canje', phone: sesion === 'telefono' ? o.c!.phone : null, email: null },
      customerId: sesion ? o.c!.id : null,
      verifiedPhone: sesion === 'telefono' ? o.c!.phone : null,
      beneficios: o.beneficios ?? null,
      note: null,
      whatsappConsent: false,
    },
    o.puede ?? PUEDE,
  )
}

const rechazo = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as AppError & { details?: any; final?: true },
  )

const cotizar = (neg: Negocio, c: Clienta, eleccion: EleccionDeBeneficios | null) =>
  cotizarConBeneficios(neg.venueId, [{ productId: neg.productoId, quantity: 1 }], { customerId: c.id, eleccion })

const filasDe = (orderId: string) =>
  prisma.orderDiscount.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
const bitacoraDe = (orderId: string, rewardId: string) =>
  prisma.activityLog.findMany({
    where: {
      OR: [
        { entity: 'Order', entityId: orderId, action: { in: ['DISCOUNT_APPLIED', 'LOYALTY_POINTS_REDEEMED'] } },
        { entity: 'StampReward', entityId: rewardId, action: 'STAMP_REWARD_REDEEMED' },
      ],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 50,
  })
const premio = (id: string) => prisma.stampReward.findUniqueOrThrow({ where: { id }, select: { status: true, orderDiscountId: true } })
const puntos = async (id: string) =>
  (await prisma.customer.findUniqueOrThrow({ where: { id }, select: { loyaltyPoints: true } })).loyaltyPoints

/** Lo que la tarjeta contesta apartada por `cents`. */
let pi = 0
const apartado = (cents: number) => ({
  sessionStatus: 'complete',
  paymentIntentId: `pi_s11_${RUN}_${++pi}`,
  piStatus: 'requires_capture',
  amountCapturableCents: cents,
  amountReceivedCents: 0,
  captureBefore: new Date(Date.now() + 7 * 24 * 3_600_000),
  card: { brand: 'visa', last4: '4242', funding: 'credit' },
  paymentMethodType: 'card',
})

/** El borrador de tarjeta de «Mi equipo» con su sesión de teléfono probado. */
const borrador = (c: Clienta, o: { expectedTotal: string; beneficios?: EleccionDeBeneficios | null; key?: string; puede?: typeof PUEDE }) =>
  createCardOnlineDraft(
    {
      venueId: equipo.venueId,
      venueSlug: 'itest-s11',
      idempotencyKey: o.key ?? llave(),
      items: [{ productId: equipo.productoId, quantity: 1 }],
      expectedTotal: o.expectedTotal,
      customer: { name: 'Ana Tarjeta', phone: c.phone, email: 'ana@test.com' },
      note: null,
      whatsappConsent: false,
      customerId: c.id,
      verifiedPhone: c.phone,
      beneficios: o.beneficios ?? null,
    },
    o.puede ?? PUEDE,
  )
const cargoDe = (trackingToken: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken } })

// ── casos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('S11 · el canje real al crear, con la MISMA regla de la cotización (E1, E11, R7)', () => {
  it('premio y puntos quedan escritos al crear (StampReward REDEEMED, LoyaltyTransaction REDEEM y sus filas); cotización = folio', async () => {
    const c = await clienta(nadie, { puntos: 1000, premio: 10 })
    await automatico(nadie, c, 10)
    const eleccion = { premioId: c.premioId, puntos: 500 }
    // A mano, con la regla vigente de la caja: $100 − $10 (automático) − $10 (premio) − $5 (500 puntos a $0.01) = $75.
    const q = await cotizar(nadie, c, eleccion)
    expect(q.beneficios).toEqual({ calculados: true })
    expect(PESOS(q.totalConBeneficios!)).toBe('75.00')

    const r = await pedir(nadie, { c, beneficios: eleccion, expectedTotal: PESOS(q.totalConBeneficios!) })
    expect(r).toMatchObject({ replay: false, total: '75.00', status: 'PENDING_ACCEPTANCE' })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
    expect(cuenta.customerId).toBe(c.id) // «Nadie» con sesión de correo: el folio nace con su clienta
    expect(PESOS(cuenta.total)).toBe('75.00')
    const filas = await filasDe(r.orderId)
    expect(filas.map(f => PESOS(f.amount))).toEqual(q.aplicados!.map(a => PESOS(a.monto)))
    expect(await premio(c.premioId)).toMatchObject({ status: 'REDEEMED' })
    expect(await puntos(c.id)).toBe(500)
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: c.id, type: 'REDEEM' } })).toBe(1)

    // R7: una fila de bitácora por canje real (automático, premio y puntos), en la transacción del folio.
    const bitacora = await bitacoraDe(r.orderId, c.premioId)
    expect(bitacora.map(b => b.action).sort()).toEqual(['DISCOUNT_APPLIED', 'LOYALTY_POINTS_REDEEMED', 'STAMP_REWARD_REDEEMED'])
  })

  it('la repetición de la MISMA solicitud (misma llave) devuelve su folio: cero canjes y cero bitácoras nuevas', async () => {
    const c = await clienta(nadie, { puntos: 300, premio: 10 })
    const key = llave()
    const eleccion = { premioId: c.premioId, puntos: 300 }
    const r = await pedir(nadie, { c, beneficios: eleccion, expectedTotal: '87.00', key })
    const antes = {
      bitacora: (await bitacoraDe(r.orderId, c.premioId)).length,
      movimientos: await prisma.loyaltyTransaction.count({ where: { customerId: c.id } }),
    }
    const otra = await pedir(nadie, { c, beneficios: eleccion, expectedTotal: '87.00', key })
    expect(otra).toMatchObject({ replay: true, orderId: r.orderId, total: '87.00' })
    expect((await bitacoraDe(r.orderId, c.premioId)).length).toBe(antes.bitacora)
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: c.id } })).toBe(antes.movimientos)
  })

  it('R2: con S10 degradado (pool sin lugar) y un automático de $10, el folio nace en $90 aunque vio $100', async () => {
    const c = await clienta(nadie)
    await automatico(nadie, c, 10)
    SIMULACION.global = 0
    const q = await cotizar(nadie, c, null)
    expect(q).toMatchObject({ beneficios: { calculados: false } })
    expect(PESOS(q.total)).toBe('100.00')
    const r = await pedir(nadie, { c, expectedTotal: '100.00' })
    expect(r).toMatchObject({ replay: false, total: '90.00' })
    expect(PESOS((await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).total)).toBe('90.00')
  })
})

describe('S11 · lo que cambió entre cotizar y pedir: PRICE_CHANGED, nada escrito, y se pide otra vez sin eso (E8, codex-plan2-r1 #5)', () => {
  it('otra pestaña usó el premio ⇒ PRICE_CHANGED con descartados [PREMIO] y la cotización sin él; pedir otra vez sin el premio crea', async () => {
    const c = await clienta(nadie, { premio: 10 })
    const primero = await pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })
    const cuentas = await prisma.order.count({ where: { venueId: nadie.venueId } })
    const err = await rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00' }))
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { descartados: ['PREMIO'] } })
    expect(err!.details.quote).toMatchObject({ total: 100, descartados: ['PREMIO'] })
    // Nada escrito: ni cuenta, ni filas, y el premio sigue del primer folio.
    expect(await prisma.order.count({ where: { venueId: nadie.venueId } })).toBe(cuentas)
    const p = await premio(c.premioId)
    expect((await prisma.orderDiscount.findUniqueOrThrow({ where: { id: p.orderDiscountId! } })).orderId).toBe(primero.orderId)
    // La tienda quita lo descartado y pide con otra llave, al total de la cotización nueva.
    const otra = await pedir(nadie, { c, expectedTotal: PESOS(err!.details.quote.total) })
    expect(otra).toMatchObject({ replay: false, total: '100.00' })
  })

  it('puntos que otra pestaña ya gastó ⇒ PRICE_CHANGED [PUNTOS]; nunca un saldo negativo; sin ellos, crea', async () => {
    const c = await clienta(nadie, { puntos: 400 })
    await pedir(nadie, { c, beneficios: { puntos: 400 }, expectedTotal: '96.00' })
    const err = await rechazo(pedir(nadie, { c, beneficios: { puntos: 400 }, expectedTotal: '96.00' }))
    expect(err).toMatchObject({ code: 'PRICE_CHANGED', details: { descartados: ['PUNTOS'] } })
    expect(await puntos(c.id)).toBe(0)
    await expect(pedir(nadie, { c, expectedTotal: '100.00' })).resolves.toMatchObject({ total: '100.00' })
  })

  it('el último uso de un cupón que otra pestaña apartó ⇒ PRICE_CHANGED [CUPON]; sin él, crea', async () => {
    const c = await clienta(nadie)
    const otra = await clienta(nadie)
    const cc = await cupon(nadie, 1)
    await pedir(nadie, { c: otra, beneficios: { cupon: cc.codigo }, expectedTotal: '90.00' })
    const err = await rechazo(pedir(nadie, { c, beneficios: { cupon: cc.codigo.toLowerCase() }, expectedTotal: '90.00' }))
    expect(err).toMatchObject({ code: 'PRICE_CHANGED', details: { descartados: ['CUPON'] } })
    await expect(pedir(nadie, { c, expectedTotal: '100.00' })).resolves.toMatchObject({ total: '100.00' })
  })

  it('Review Focus #1: dos pestañas usan el mismo premio A LA VEZ ⇒ una lo logra y la otra PRICE_CHANGED; dos folios con los mismos puntos ⇒ nunca negativo', async () => {
    const c = await clienta(nadie, { puntos: 300, premio: 10 })
    const [a, b] = await Promise.all([
      rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })).then(e => e ?? 'ok'),
      rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })).then(e => e ?? 'ok'),
    ])
    expect([a, b].filter(x => x === 'ok')).toHaveLength(1)
    expect([a, b].find(x => x !== 'ok')).toMatchObject({ code: 'PRICE_CHANGED', details: { descartados: ['PREMIO'] } })

    const [x, y] = await Promise.all([
      rechazo(pedir(nadie, { c, beneficios: { puntos: 300 }, expectedTotal: '97.00' })).then(e => e ?? 'ok'),
      rechazo(pedir(nadie, { c, beneficios: { puntos: 300 }, expectedTotal: '97.00' })).then(e => e ?? 'ok'),
    ])
    expect([x, y].filter(v => v === 'ok')).toHaveLength(1)
    expect(await puntos(c.id)).toBe(0)
  })

  it('el último uso de un cupón con dos folios a la vez ⇒ uno lo aparta', async () => {
    const [c1, c2] = [await clienta(nadie), await clienta(nadie)]
    const cc = await cupon(nadie, 1)
    const r = await Promise.all([
      rechazo(pedir(nadie, { c: c1, beneficios: { cupon: cc.codigo }, expectedTotal: '90.00' })).then(e => e ?? 'ok'),
      rechazo(pedir(nadie, { c: c2, beneficios: { cupon: cc.codigo }, expectedTotal: '90.00' })).then(e => e ?? 'ok'),
    ])
    expect(r.filter(v => v === 'ok')).toHaveLength(1)
    expect(await prisma.orderDiscount.count({ where: { couponCodeId: cc.couponCodeId } })).toBe(1)
  })
})

describe("S11 · R1/R1': la decisión de precio es UNA por negocio + llave (un envío demorado nunca crea otro folio)", () => {
  /** Detiene el PRÓXIMO `quoteCart` (el de afuera de la transacción) hasta `soltar()`. */
  function demorarLaCotizacion() {
    const real = cotizador.quoteCart
    let soltar: () => void = () => undefined
    const puede = new Promise<void>(r => (soltar = r))
    let llego: () => void = () => undefined
    const detenido = new Promise<void>(r => (llego = r))
    jest.spyOn(cotizador, 'quoteCart').mockImplementationOnce(async (...a: Parameters<typeof real>) => {
      llego()
      await puede
      return real(...a)
    })
    return { detenido, soltar: () => soltar() }
  }

  it('K demorado + K pierde el premio (PRICE_CHANGED) + K2 corregido + S9 regresa el premio + llega el K demorado ⇒ UN solo folio', async () => {
    const c = await clienta(nadie, { premio: 10 })
    const otra = await pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00' }) // el premio ya está usado
    const K = llave()
    const freno = demorarLaCotizacion()
    const demorado = rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }))
    await freno.detenido
    const segundo = await rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }))
    expect(segundo).toMatchObject({ code: 'PRICE_CHANGED', final: true })
    const K2 = llave()
    const corregido = await pedir(nadie, { c, expectedTotal: '100.00', key: K2 })
    // S9: se cancela el folio que tenía el premio: regresa a la clienta.
    await expect(cancelOnlineOrderByStaff({ venueId: nadie.venueId, orderId: otra.orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
    })
    expect(await premio(c.premioId)).toMatchObject({ status: 'PENDING' })
    freno.soltar()
    expect(await demorado).toMatchObject({ code: 'PRICE_CHANGED', final: true })
    expect(await prisma.order.count({ where: { venueId: nadie.venueId, externalId: { in: [`web:${K}`, `web:${K2}`] } } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: corregido.orderId } })).externalId).toBe(`web:${K2}`)
    expect(await premio(c.premioId)).toMatchObject({ status: 'PENDING' }) // el demorado no lo gastó
  })

  it("R1': K demorado CON sesión + K sin sesión (SIN_SESION) + K2 ⇒ un solo folio; K con otra elección ⇒ IDEMPOTENCY_KEY_CONFLICT", async () => {
    const c = await clienta(nadie, { premio: 10 })
    const K = llave()
    const freno = demorarLaCotizacion()
    const demorado = rechazo(pedir(nadie, { c, beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }))
    await freno.detenido
    // La sesión se cerró: el mismo carrito con beneficios, sin sesión.
    const sinSesion = await rechazo(pedir(nadie, { c: null, beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }))
    expect(sinSesion).toMatchObject({ code: 'PRICE_CHANGED', final: true, details: { motivo: 'SIN_SESION' } })
    const K2 = llave()
    await pedir(nadie, { c: null, expectedTotal: '100.00', key: K2 })
    freno.soltar()
    expect(await demorado).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    await expect(rechazo(pedir(nadie, { c, expectedTotal: '100.00', key: K }))).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(await prisma.order.count({ where: { venueId: nadie.venueId, externalId: { in: [`web:${K}`, `web:${K2}`] } } })).toBe(1)
    expect(await premio(c.premioId)).toMatchObject({ status: 'PENDING' })
  })
})

describe('S11 · el folio en $0 (E5, R6, R8)', () => {
  it('«Nadie» en $0 por un premio ⇒ PAID sin Payment, «Por entregar», comanda marcada, vale, cupón canjeado y sin loyaltyEligibleAt', async () => {
    jest.spyOn(cocina, 'debeMarcarCocina').mockResolvedValue(true)
    const c = await clienta(nadie, { premio: 100 })
    const cc = await cupon(nadie)
    // El cupón del 10 % deja $90 y el premio de $100 cubre lo que queda (topado a la base): $0. Lo prueba cerrarFolioEnCeroEnTx.
    const r = await pedir(nadie, { c, beneficios: { cupon: cc.codigo, premioId: c.premioId }, expectedTotal: '0.00' })
    expect(r).toMatchObject({ replay: false, total: '0.00', status: 'ACCEPTED' })
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })
    expect(cuenta).toMatchObject({ paymentStatus: 'PAID', status: 'COMPLETED', loyaltyEligibleAt: null })
    expect(PESOS(cuenta.remainingBalance)).toBe('0.00')
    expect(cuenta.completedAt).not.toBeNull()
    expect(cuenta.kitchenPendingAt).not.toBeNull()
    expect(await prisma.payment.count({ where: { orderId: r.orderId } })).toBe(0)
    expect(await prisma.onlineOrder.findUniqueOrThrow({ where: { orderId: r.orderId } })).toMatchObject({ status: 'ACCEPTED' })
    expect(await prisma.inventoryPosting.count({ where: { venueId: nadie.venueId, sourceId: r.orderId, effectKind: 'SALE' } })).toBe(1)
    expect(await prisma.couponRedemption.count({ where: { orderId: r.orderId, couponCodeId: cc.couponCodeId } })).toBe(1)
    expect(await prisma.couponCode.findUniqueOrThrow({ where: { id: cc.couponCodeId } })).toMatchObject({ currentUses: 1 })
    expect(await prisma.discount.findUniqueOrThrow({ where: { id: cc.discountId } })).toMatchObject({ currentUses: 1 })
    expect(await prisma.activityLog.count({ where: { entity: 'Order', entityId: r.orderId, action: 'ONLINE_ORDER_CLOSED_AT_ZERO' } })).toBe(
      1,
    )
  })

  it('«Mi equipo» en $0 espera a una persona; aceptarlo lo cierra pagado en esa transacción; si se rechaza, su premio regresa (S9)', async () => {
    const c = await clienta(equipo, { premio: 100 })
    const r = await pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '0.00' })
    expect(r).toMatchObject({ status: 'PENDING_ACCEPTANCE', total: '0.00' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ paymentStatus: 'PENDING' })
    await expect(acceptOnlineOrder({ venueId: equipo.venueId, orderId: r.orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
      status: 'ACCEPTED',
    })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      loyaltyEligibleAt: null,
    })
    expect(await prisma.payment.count({ where: { orderId: r.orderId } })).toBe(0)

    const otra = await clienta(equipo, { premio: 100 })
    const r2 = await pedir(equipo, { c: otra, sesion: 'telefono', beneficios: { premioId: otra.premioId }, expectedTotal: '0.00' })
    await expect(
      rejectOnlineOrder({ venueId: equipo.venueId, orderId: r2.orderId, staffId: null, reason: 'OTHER' as never }),
    ).resolves.toMatchObject({
      outcome: 'OK',
    })
    expect(await premio(otra.premioId)).toMatchObject({ status: 'PENDING' })
  })

  it('R8: tienda de sólo tarjeta: un beneficio que deja $0 ⇒ nace; con $5 ⇒ el rechazo de hoy y nada escrito', async () => {
    await prisma.onlineOrderingSettings.update({ where: { venueId: equipo.venueId }, data: { acceptsPayAtPickup: false } })
    try {
      const c = await clienta(equipo, { premio: 100 })
      await expect(
        pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '0.00' }),
      ).resolves.toMatchObject({
        total: '0.00',
        status: 'PENDING_ACCEPTANCE',
      })
      const d = await clienta(equipo, { premio: 95 })
      const cuentas = await prisma.order.count({ where: { venueId: equipo.venueId } })
      const err = await rechazo(pedir(equipo, { c: d, sesion: 'telefono', beneficios: { premioId: d.premioId }, expectedTotal: '5.00' }))
      expect(err).toMatchObject({ statusCode: 400, code: 'PAYMENT_MODE_NOT_ACCEPTED' })
      expect(await prisma.order.count({ where: { venueId: equipo.venueId } })).toBe(cuentas)
      expect(await premio(d.premioId)).toMatchObject({ status: 'PENDING' })
    } finally {
      await prisma.onlineOrderingSettings.update({ where: { venueId: equipo.venueId }, data: { acceptsPayAtPickup: true } })
    }
  })
})

describe("S11 · tarjeta: el borrador autoriza su total estricto y el folio nace sólo si el estricto = lo autorizado (R2', R2'', R2''', R4, R4')", () => {
  it('el borrador con sesión guarda customerId y la elección; el pedido nace con ellos y se captura lo autorizado', async () => {
    const c = await clienta(equipo, { premio: 10 })
    const d = await borrador(c, { expectedTotal: '90.00', beneficios: { premioId: c.premioId } })
    const cargo = await cargoDe(d.trackingToken)
    expect(PESOS(cargo.amount)).toBe('90.00')
    expect(cargo.request).toMatchObject({ customerId: c.id, beneficios: { premioId: c.premioId } })
    authSpy.mockResolvedValue(apartado(9000))
    await expect(confirmCardAuthorization(cargo.id)).resolves.toBe('CREATED')
    const pedido = await prisma.onlineOrder.findFirstOrThrow({ where: { trackingToken: d.trackingToken }, include: { order: true } })
    expect(pedido.order).toMatchObject({ customerId: c.id })
    expect(PESOS(pedido.order.total)).toBe('90.00')
    expect(await premio(c.premioId)).toMatchObject({ status: 'REDEEMED' })
    await expect(acceptOnlineOrder({ venueId: equipo.venueId, orderId: pedido.orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
    })
    expect(captureSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountCents: 9000 }))
  })

  it("R2'': S10 degradado + automático de $10: el borrador ⇒ PRICE_CHANGED con totalEstricto 90; K2 con 90 ⇒ autoriza, confirma, acepta y captura $90", async () => {
    const c = await clienta(equipo)
    await automatico(equipo, c, 10)
    SIMULACION.global = 0
    expect(await cotizar(equipo, c, null)).toMatchObject({ beneficios: { calculados: false } })
    SIMULACION.global = 3
    const err = await rechazo(borrador(c, { expectedTotal: '100.00' }))
    expect(err).toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { totalEstricto: 90 } })
    expect(checkoutSpy).not.toHaveBeenCalled()
    const d = await borrador(c, { expectedTotal: '90.00' })
    const cargo = await cargoDe(d.trackingToken)
    expect(PESOS(cargo.amount)).toBe('90.00')
    authSpy.mockResolvedValue(apartado(9000))
    await expect(confirmCardAuthorization(cargo.id)).resolves.toBe('CREATED')
    const pedido = await prisma.onlineOrder.findFirstOrThrow({ where: { trackingToken: d.trackingToken } })
    await expect(acceptOnlineOrder({ venueId: equipo.venueId, orderId: pedido.orderId, staffId: null })).resolves.toMatchObject({
      outcome: 'OK',
    })
    expect(captureSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountCents: 9000 }))
  })

  it("R2''': sin lugar en el semáforo (tope 0) el borrador con sesión responde 503 reintentable, sin decisión bajo la llave ni Checkout", async () => {
    const c = await clienta(equipo)
    SIMULACION.global = 0
    const K = llave()
    await expect(rechazo(borrador(c, { expectedTotal: '100.00', key: K }))).resolves.toMatchObject({
      statusCode: 503,
      code: 'BENEFITS_CALCULATION_UNAVAILABLE',
    })
    expect(await prisma.idempotencyRequest.count({ where: { organizationId: `venue:${equipo.venueId}`, idempotencyKey: K } })).toBe(0)
    expect(checkoutSpy).not.toHaveBeenCalled()
    // Con lugar, la MISMA llave sigue libre.
    SIMULACION.global = 3
    await expect(borrador(c, { expectedTotal: '100.00', key: K })).resolves.toMatchObject({ replay: false })
  })

  describe("Codex r4 #1 (R1'): lo ya decidido sobre K gana antes de la tienda y del semáforo", () => {
    const pausar = (manualPause: boolean) =>
      prisma.onlineOrderingSettings.update({ where: { venueId: equipo.venueId }, data: { manualPause } })
    const decisiones = (K: string) =>
      prisma.idempotencyRequest.count({ where: { organizationId: `venue:${equipo.venueId}`, idempotencyKey: K } })

    it('borrador: K con PRICE_CHANGED repetida con la tienda pausada, sin lugar en el semáforo o con el plan sin verificar ⇒ la MISMA decisión; otra elección ⇒ conflicto', async () => {
      const c = await clienta(equipo)
      await automatico(equipo, c, 10)
      const K = llave()
      const mismo = () => rechazo(borrador(c, { expectedTotal: '100.00', key: K }))
      const otraEleccion = () => rechazo(borrador(c, { expectedTotal: '100.00', key: K, beneficios: { premioId: c.premioId } }))
      await expect(mismo()).resolves.toMatchObject({ code: 'PRICE_CHANGED', details: { totalEstricto: 90 } })
      await pausar(true)
      try {
        await expect(mismo()).resolves.toMatchObject({
          statusCode: 409,
          code: 'PRICE_CHANGED',
          final: true,
          details: { totalEstricto: 90 },
        })
        await expect(otraEleccion()).resolves.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
      } finally {
        await pausar(false)
      }
      SIMULACION.global = 0
      await expect(mismo()).resolves.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true, details: { totalEstricto: 90 } })
      await expect(otraEleccion()).resolves.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' })
      // Codex r5: con el plan sin poder verificarse (503), igual.
      SIMULACION.global = 3
      await expect(rechazo(borrador(c, { expectedTotal: '100.00', key: K, puede: PLAN_503 }))).resolves.toMatchObject({
        code: 'PRICE_CHANGED',
        final: true,
      })
      expect(await decisiones(K)).toBe(1)
      expect(checkoutSpy).not.toHaveBeenCalled()
      expect(await prisma.onlineOrderCharge.count({ where: { venueId: equipo.venueId, idempotencyKey: K } })).toBe(0)
    })

    it('pagar al recoger: K con PRICE_CHANGED repetida con la tienda pausada o el plan sin verificar (503) ⇒ la MISMA decisión; otra elección ⇒ conflicto', async () => {
      const c = await clienta(equipo, { premio: 10 })
      await pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })
      const K = llave()
      const mismo = () =>
        rechazo(pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }))
      await expect(mismo()).resolves.toMatchObject({ code: 'PRICE_CHANGED' })
      await pausar(true)
      try {
        await expect(mismo()).resolves.toMatchObject({ statusCode: 409, code: 'PRICE_CHANGED', final: true })
        await expect(rechazo(pedir(equipo, { c, sesion: 'telefono', expectedTotal: '100.00', key: K }))).resolves.toMatchObject({
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        })
      } finally {
        await pausar(false)
      }
      // Codex r5: con el plan sin poder verificarse (503): la decisión, y otra elección choca; con K libre, el 503 de siempre.
      const conPlan503 = (o: { beneficios?: EleccionDeBeneficios; expectedTotal: string; key: string }) =>
        rechazo(pedir(equipo, { c, sesion: 'telefono', ...o, puede: PLAN_503 }))
      await expect(conPlan503({ beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K })).resolves.toMatchObject({
        statusCode: 409,
        code: 'PRICE_CHANGED',
        final: true,
      })
      await expect(conPlan503({ expectedTotal: '100.00', key: K })).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
      await expect(conPlan503({ expectedTotal: '100.00', key: llave() })).resolves.toMatchObject({
        statusCode: 503,
        code: 'FEATURE_CHECK_UNAVAILABLE',
      })
      expect(await decisiones(K)).toBe(1)
      expect(await prisma.order.count({ where: { venueId: equipo.venueId, externalId: { endsWith: K } } })).toBe(0)
    })
  })

  it('Review Focus #5: el premio ya no está al confirmar ⇒ no nace pedido, se libera (BENEFIT_GONE) y el seguimiento lo dice tras recargar', async () => {
    const c = await clienta(equipo, { premio: 10 })
    const d = await borrador(c, { expectedTotal: '90.00', beneficios: { premioId: c.premioId } })
    // Otra pestaña usa el premio antes de que el banco confirme.
    await pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })
    const cargo = await cargoDe(d.trackingToken)
    authSpy.mockResolvedValue(apartado(9000))
    await expect(confirmCardAuthorization(cargo.id)).resolves.toBe('RELEASED_LATE')
    expect(await prisma.onlineOrder.count({ where: { trackingToken: d.trackingToken } })).toBe(0)
    expect(voidSpy).toHaveBeenCalled()
    expect(await cargoDe(d.trackingToken)).toMatchObject({ status: 'RELEASED' })
    for (let recarga = 0; recarga < 2; recarga++) {
      expect(await getTrackingByToken(d.trackingToken)).toMatchObject({
        cardStatus: 'RELEASED',
        precioNuevo: {
          motivo: 'BENEFIT_GONE',
          total: 100,
          descartados: ['PREMIO'],
          mensaje: 'Tu beneficio ya no estaba: no se te cobró. Confirma el precio nuevo.',
        },
      })
    }
  })

  it('R4: si la liberación falla, el seguimiento no dice «no se te cobró»; la conciliación la termina y el motivo sigue ahí', async () => {
    const c = await clienta(equipo, { premio: 10 })
    const d = await borrador(c, { expectedTotal: '90.00', beneficios: { premioId: c.premioId } })
    await pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })
    const cargo = await cargoDe(d.trackingToken)
    const ap = apartado(9000)
    authSpy.mockResolvedValue(ap)
    voidSpy.mockRejectedValueOnce(new Error('stripe caído'))
    await expect(confirmCardAuthorization(cargo.id)).rejects.toThrow()
    expect(await cargoDe(d.trackingToken)).toMatchObject({ status: 'RELEASING' })
    const enCurso = await getTrackingByToken(d.trackingToken)
    expect(enCurso).toMatchObject({ cardStatus: 'RELEASING', precioNuevo: { motivo: 'BENEFIT_GONE' } })
    expect(enCurso!.precioNuevo!.mensaje).not.toMatch(/no se te cobró/)
    // El conciliador repite la liberación con la MISMA clave; el motivo no se borra.
    authSpy.mockResolvedValue({ ...ap, piStatus: 'canceled' })
    await expect(releaseCharge(cargo.id)).resolves.toBe('RELEASED')
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({
      cardStatus: 'RELEASED',
      precioNuevo: { motivo: 'BENEFIT_GONE', mensaje: 'Tu beneficio ya no estaba: no se te cobró. Confirma el precio nuevo.' },
    })
  })

  it("R4': el aviso de Stripe confirma primero (el total cambió) y luego se recarga el seguimiento ⇒ precioNuevo 90; en $0 ⇒ 0", async () => {
    const c = await clienta(equipo)
    const d = await borrador(c, { expectedTotal: '100.00' })
    await automatico(equipo, c, 10) // un automático nuevo entre autorizar y confirmar
    authSpy.mockResolvedValue(apartado(10000))
    await expect(confirmCardAuthorization((await cargoDe(d.trackingToken)).id)).resolves.toBe('RELEASED_LATE')
    expect(await getTrackingByToken(d.trackingToken)).toMatchObject({
      precioNuevo: { motivo: 'PRICE_CHANGED', total: 90, descartados: [] },
    })

    const z = await clienta(equipo)
    const dz = await borrador(z, { expectedTotal: '100.00' })
    await automatico(equipo, z, 100)
    authSpy.mockResolvedValue(apartado(10000))
    await expect(confirmCardAuthorization((await cargoDe(dz.trackingToken)).id)).resolves.toBe('RELEASED_LATE')
    expect(await getTrackingByToken(dz.trackingToken)).toMatchObject({ precioNuevo: { motivo: 'PRICE_CHANGED', total: 0 } })
    // Con $0 la tienda pasa al flujo sin tarjeta.
    await expect(rechazo(borrador(z, { expectedTotal: '0.00' }))).resolves.toMatchObject({ code: 'ZERO_TOTAL' })
  })

  it("R1': una llave con decisión de pagar al recoger no abre Checkout (otra huella ⇒ conflicto)", async () => {
    const c = await clienta(equipo, { premio: 10 })
    await pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00' })
    const K = llave()
    const err = await rechazo(
      pedir(equipo, { c, sesion: 'telefono', beneficios: { premioId: c.premioId }, expectedTotal: '90.00', key: K }),
    )
    expect(err).toMatchObject({ code: 'PRICE_CHANGED' })
    await expect(rechazo(borrador(c, { expectedTotal: '100.00', key: K }))).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(checkoutSpy).not.toHaveBeenCalled()
  })

  it('R3: pagar al recoger y el borrador de tarjeta con la MISMA llave, a la vez y en los dos órdenes: sin 40P01 y un solo ganador', async () => {
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const c = await clienta(equipo)
      const K = llave()
      const operaciones = [
        () => rechazo(pedir(equipo, { c, sesion: 'telefono', expectedTotal: '100.00', key: K })).then(e => e ?? 'ok'),
        () => rechazo(borrador(c, { expectedTotal: '100.00', key: K })).then(e => e ?? 'ok'),
      ]
      const r = await Promise.all(vuelta === 0 ? operaciones.map(f => f()) : [...operaciones].reverse().map(f => f()))
      expect(r.filter(v => v === 'ok')).toHaveLength(1)
      expect(r.find(v => v !== 'ok')).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    }
  })
})
