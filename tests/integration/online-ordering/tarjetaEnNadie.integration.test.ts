// tests/integration/online-ordering/tarjetaEnNadie.integration.test.ts
/**
 * Integration (REAL DB) — D661 tarea 2: el borrador de tarjeta en «Nadie» contra Postgres de verdad. Lo que los simulacros no prueban:
 * la marca `customerPhone = ''` en los filtros, la ruta JSON `request.customerId` del tope por clienta, los apartados por
 * `OnlineOrder.order.customerId`, el cupo de la sucursal y que llenarlo no cierra «Pagar en caja» (r6 #6) por el camino de admisión real.
 * Los apartados se fabrican como los dejará la confirmación (tarea 3): la cuenta con `requiresAcceptance:false` y el cargo `AUTHORIZED`.
 */
import prisma from '@/utils/prismaClient'
import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { apartadosNadieWhere, borradoresNadieWhere, liveCardDraftsWhere, unpaidFoliosWhere } from '@/services/online-ordering/constants'
import { listFolios } from '@/services/online-ordering/folios.service'
import { clearPublicMenuCache } from '@/services/online-ordering/menu.service'
import { createOnlineOrder, toQuoteSnapshot, writeOnlineOrderInTx } from '@/services/online-ordering/order.service'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { quoteCart } from '@/services/online-ordering/quote.service'
import { updateSettings } from '@/services/online-ordering/settings.service'
import { generateTrackingToken } from '@/services/online-ordering/trackingToken'
import type { TxConReintento } from '@/utils/serializableRetry'

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base desechable o la propia de la fase.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(avoqado_[a-z0-9_]+_test_[a-z0-9_]+|av-db-25-[a-z0-9-]+)$/.test(database.pathname)
) {
  throw new Error('Esta suite sólo corre contra una base desechable (avoqado_<tarea>_test_<fecha> o av-db-25-<fase>) en localhost.')
}

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  socketManager: { broadcastToVenue: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({
  ...jest.requireActual('@/services/kds/kitchenTicketAuthoring.service'),
  armarComandasTrasCommit: jest.fn(async () => undefined),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({
  ...jest.requireActual('@/services/superadmin/platformSettings.service'),
  getVatRateBps: jest.fn(async () => 1600),
}))

const RUN = Date.now()
const MIN = 60_000
const PUEDE_CREAR = { assertCanCreate: async () => {} }

describe('D661 · tarjeta en «Nadie»: marca, tope por clienta y cupo de la sucursal (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let productId: string
  /** Clientas con sesión (por correo: sin teléfono probado). */
  const clientas: string[] = []
  let seq = 0
  const llave = () => `nadie-${RUN}-${++seq}-`.padEnd(40, 'x')
  const ITEMS = () => [{ productId, quantity: 1 }]

  /** Stripe espiado con su idempotencia: la misma clave devuelve la misma sesión. */
  const sesiones = new Map<string, { id: string; url: string; expiresAt: Date }>()
  let spy: jest.SpyInstance

  /** La tarjeta de «Nadie» de una clienta con sesión; sin teléfono en el cuerpo. */
  const tarjeta = (clienta: string, verifiedPhone: string | null = null) =>
    createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-nadie-${RUN}`,
        idempotencyKey: llave(),
        items: ITEMS(),
        expectedTotal: '250.00',
        customer: { name: 'Ana Nadie', email: 'ana@test.com' },
        note: null,
        whatsappConsent: false,
        customerId: clienta,
        verifiedPhone,
      },
      PUEDE_CREAR,
    )
  /** Un folio para pagar en caja, anónimo, por el camino de admisión REAL. */
  const folioEnCaja = () =>
    createOnlineOrder(
      {
        venueId: venueId!,
        idempotencyKey: llave(),
        items: ITEMS(),
        paymentMode: 'PAY_AT_PICKUP',
        expectedTotal: '250.00',
        customer: { name: 'Bea Caja' },
        customerId: null,
        verifiedPhone: null,
        channel: 'QR',
        note: null,
        whatsappConsent: false,
      },
      PUEDE_CREAR,
    )
  const cargo = (trackingToken: string) => prisma.onlineOrderCharge.findUniqueOrThrow({ where: { trackingToken } })
  /** La confirmación de la tarea 3: su cuenta nace con la clienta del borrador, `requiresAcceptance:false`, y el cargo queda apartado. */
  const apartar = async (trackingToken: string) => {
    const c = await cargo(trackingToken)
    const req = c.request as any
    await prisma.$transaction(async tx => {
      const created = await writeOnlineOrderInTx(tx as unknown as TxConReintento, {
        venueId: venueId!,
        externalId: req.externalId,
        orderNumber: `WN${seq}-${c.id.slice(-4)}`,
        quote: req.quote,
        customer: req.customer,
        customerId: req.customerId,
        note: null,
        paymentMode: 'CARD_ONLINE',
        trackingToken: c.trackingToken,
        requestHash: c.requestHash,
        acceptDeadlineAt: new Date(Date.now() + 10 * MIN),
        whatsappConsent: false,
        requiresAcceptance: false,
        channel: null,
      })
      await tx.onlineOrderCharge.update({ where: { id: c.id }, data: { status: 'AUTHORIZED', onlineOrderId: created.onlineOrderId } })
    })
  }
  /** Un folio de caja SIN pagar de la clienta (su cuenta con su `customerId`), con filas reales. */
  const folioDe = async (clienta: string) => {
    const quote = toQuoteSnapshot(await quoteCart(venueId!, ITEMS()))
    await prisma.$transaction(tx =>
      writeOnlineOrderInTx(tx as unknown as TxConReintento, {
        venueId: venueId!,
        externalId: `web:${llave()}`,
        orderNumber: `WF${seq}`,
        quote,
        customer: { name: 'Ana Nadie', phone: null, email: null },
        customerId: clienta,
        note: null,
        paymentMode: 'PAY_AT_PICKUP',
        trackingToken: generateTrackingToken(),
        requestHash: `folio-${seq}`,
        acceptDeadlineAt: new Date(Date.now() + 30 * MIN),
        whatsappConsent: false,
        requiresAcceptance: false,
        channel: 'QR',
      }),
    )
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Nadie Org', slug: `itest-nadie-org-${RUN}`, email: `itest-nadie-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Nadie Venue',
        slug: `itest-nadie-${RUN}`,
        organizationId: org.id,
        timezone: 'America/Mexico_City',
        address: 'Av. Coyoacán 123',
        city: 'CDMX',
        state: 'CDMX',
        zipCode: '04000',
        phone: '5512345678',
      },
    })
    venueId = venue.id
    // R18: encender la tienda exige domicilio, teléfono y un aviso de privacidad publicado.
    await prisma.privacyNoticeVersion.create({ data: { venueId, content: 'Aviso ITEST', contentHash: `itest-nadie-${RUN}` } })
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Flautas', slug: `flautas-nadie-${RUN}` } })
    productId = (
      await prisma.product.create({
        data: { venueId, name: 'Orden grande', sku: `NADIE-${RUN}`, price: 250, categoryId: category.id, availableOnline: true },
      })
    ).id
    for (let i = 0; i < 12; i++) {
      clientas.push(
        (await prisma.customer.create({ data: { venueId, email: `clienta${i}-${RUN}@test.com`, firstName: `Clienta ${i}` } })).id,
      )
    }
    const provider = await prisma.paymentProvider.upsert({
      where: { code: 'STRIPE_CONNECT' },
      update: {},
      create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'ITEST Nadie',
        contactEmail: `itest-nadie-merchant-${RUN}@test.com`,
        publicKey: `pk_test_itest_nadie_${RUN}`,
        secretKeyHash: `itest-nadie-hash-${RUN}`,
        providerId: provider.id,
        providerCredentials: { connectAccountId: 'acct_itest_nadie' },
        chargesEnabled: true,
        platformFeeBps: 100,
        sandboxMode: true,
      },
    })
    await updateSettings(venueId, { enabled: true, minOrderAmount: 0, defaultPrepMinutes: 15 }, null)
    clearPublicMenuCache()
    spy = jest.spyOn(StripeConnectProvider.prototype, 'createAuthorizationCheckout')
  })

  beforeEach(async () => {
    spy.mockReset()
    spy.mockImplementation(async (_m: any, p: any) => {
      if (!sesiones.has(p.idempotencyKey)) {
        const id = `cs_itest_nadie_${RUN}_${sesiones.size + 1}`
        sesiones.set(p.idempotencyKey, { id, url: `https://checkout.stripe.test/${id}`, expiresAt: p.expiresAt })
      }
      return sesiones.get(p.idempotencyKey)!
    })
    // Lo de la prueba anterior queda resuelto (el conciliador lo abandonó; nadie abrió los apartados): no ocupa lugar en ésta.
    await prisma.onlineOrderCharge.updateMany({ where: { venueId: venueId!, status: 'PENDING_AUTH' }, data: { status: 'ABANDONED' } })
    await prisma.onlineOrder.updateMany({ where: { venueId: venueId!, status: 'PENDING_ACCEPTANCE' }, data: { status: 'EXPIRED' } })
    // «Nadie» con su interruptor, la caja que cobra folios y la caja que avisa tarjetas, ahora.
    const ahora = new Date()
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: {
        requiresAcceptance: false,
        cardOnlineNadie: true,
        acceptsCardOnline: false,
        acceptsPayAtPickup: true,
        lastToPayPollAt: ahora,
        lastCardAlertPollAt: ahora,
        cardAlertFastPollAt: ahora,
        lastInboxPollAt: ahora,
      },
    })
  })

  afterAll(async () => {
    spy?.mockRestore()
    // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
    if (!venueId) return
    const v = { venueId }
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: `venue:${venueId}` } })
    await prisma.activityLog.deleteMany({ where: v })
    await prisma.onlineOrderCharge.deleteMany({ where: v }) // antes del comercio (Restrict)
    await prisma.onlineOrder.deleteMany({ where: v })
    await prisma.order.deleteMany({ where: v })
    await prisma.ecommerceMerchant.deleteMany({ where: v })
    await prisma.product.deleteMany({ where: v })
    await prisma.menuCategory.deleteMany({ where: v })
    await prisma.customer.deleteMany({ where: v })
    await prisma.onlineOrderingSettings.deleteMany({ where: v })
    await prisma.privacyNoticeVersion.deleteMany({ where: v })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  })

  it('c · la marca contra Postgres: liveCardDraftsWhere no cuenta un borrador de «Nadie» (customerPhone vacío), borradoresNadieWhere sí, la ruta JSON separa clientas y unpaidFoliosWhere no cuenta un apartado CARD_ONLINE', async () => {
    const [a, b] = clientas
    // Un borrador de «Mi equipo» (con teléfono, sin sesión): el único que debe ver la saturación.
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: true, acceptsCardOnline: true },
    })
    const deMiEquipo = await createCardOnlineDraft(
      {
        venueId: venueId!,
        venueSlug: `itest-nadie-${RUN}`,
        idempotencyKey: llave(),
        items: ITEMS(),
        expectedTotal: '250.00',
        customer: { name: 'Eva Equipo', phone: '55 1234 0000' },
        customerId: null,
        verifiedPhone: null,
      },
      PUEDE_CREAR,
    )
    await prisma.onlineOrderingSettings.update({
      where: { venueId: venueId! },
      data: { requiresAcceptance: false, acceptsCardOnline: false },
    })

    const deA = await tarjeta(a)
    const apartadoDeA = await tarjeta(a)
    const deB = await tarjeta(b, '+525598765432')
    await apartar(apartadoDeA.trackingToken)
    await expect(folioEnCaja()).resolves.toMatchObject({ replay: false })

    // Lo que escribió el código real.
    expect((await cargo(deMiEquipo.trackingToken)).customerPhone).toMatch(/^\+52\d{10}$/)
    expect(await cargo(deA.trackingToken)).toMatchObject({
      customerPhone: '',
      request: expect.objectContaining({ nadie: true, customerId: a }),
    })
    expect((await cargo(deB.trackingToken)).request).toMatchObject({ nadie: true, customerId: b, telefonoVerificado: '+525598765432' })

    const enLaBase = (where: any) => prisma.onlineOrderCharge.count({ where })
    expect(await enLaBase(liveCardDraftsWhere(venueId!, new Date()))).toBe(1) // sólo el de «Mi equipo»
    expect(await enLaBase(borradoresNadieWhere(venueId!))).toBe(2) // deA y deB (el otro de A ya está apartado)
    expect(await enLaBase({ ...borradoresNadieWhere(venueId!), request: { path: ['customerId'], equals: a } })).toBe(1)
    expect(await enLaBase({ ...borradoresNadieWhere(venueId!), request: { path: ['customerId'], equals: b } })).toBe(1)
    expect(await enLaBase({ ...borradoresNadieWhere(venueId!), request: { path: ['customerId'], equals: clientas[2] } })).toBe(0)
    expect(await prisma.onlineOrder.count({ where: apartadosNadieWhere(venueId!) })).toBe(1)
    expect(await prisma.onlineOrder.count({ where: { ...apartadosNadieWhere(venueId!), order: { customerId: a } } })).toBe(1)
    expect(await prisma.onlineOrder.count({ where: { ...apartadosNadieWhere(venueId!), order: { customerId: b } } })).toBe(0)
    expect(await prisma.onlineOrder.count({ where: unpaidFoliosWhere(venueId!) })).toBe(1) // el folio de caja, no el apartado
  })

  it('a · el tope por clienta en «Nadie» con filas reales: borradores (ruta JSON) + apartados (order.customerId) rechazan el 4.º intento de la MISMA clienta; los de otra clienta y sus folios de caja no cuentan', async () => {
    const [a, b] = clientas
    for (let i = 0; i < 3; i++) await tarjeta(b) // otra clienta en su tope: no cuenta para A
    const primera = await tarjeta(a)
    await apartar(primera.trackingToken) // A: un apartado
    await folioDe(a)
    await folioDe(a) // A: dos folios de caja suyos, sin pagar
    await tarjeta(a)
    await tarjeta(a) // A: un apartado + dos borradores = 3

    await expect(tarjeta(a)).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })
    // Lo que contó el tope: sus 2 borradores vivos (ruta JSON) + su apartado; nada más de A quedó abierto (el 4.º no se creó).
    expect(
      await prisma.onlineOrderCharge.count({ where: { ...borradoresNadieWhere(venueId!), request: { path: ['customerId'], equals: a } } }),
    ).toBe(2)
    expect(await prisma.onlineOrder.count({ where: { ...apartadosNadieWhere(venueId!), order: { customerId: a } } })).toBe(1)
    expect(await prisma.onlineOrder.count({ where: { ...unpaidFoliosWhere(venueId!), order: { customerId: a } } })).toBe(2)
    // B sigue en su propio tope.
    await expect(tarjeta(b)).rejects.toMatchObject({ code: 'TOO_MANY_PENDING_ORDERS' })
  })

  it('b · el cupo de tarjeta de la sucursal: borradores vivos y apartados lo llenan, la siguiente tarjeta recibe CARD_ONLINE_QUEUE_FULL y el folio para pagar en caja sigue entrando (r6 #6, admisión real)', async () => {
    const llenas = clientas.slice(0, 10)
    for (const c of llenas) for (let i = 0; i < 3; i++) await tarjeta(c) // 30 borradores vivos de «Nadie»

    // r6 #6: antes, 30 borradores vivos pausaban la tienda entera (TOO_BUSY) y el folio no entraba.
    await expect(getAcceptingStatus(venueId!)).resolves.toMatchObject({ status: 'OPEN', reason: null })
    await expect(tarjeta(clientas[10])).rejects.toMatchObject({ statusCode: 409, code: 'CARD_ONLINE_QUEUE_FULL' })
    await expect(folioEnCaja()).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', replay: false })

    // La mezcla: 10 se apartan y 5 de los demás ya vencieron su página sin resolverse. Siguen siendo 30 lugares.
    const vivos = await prisma.onlineOrderCharge.findMany({
      where: borradoresNadieWhere(venueId!),
      select: { trackingToken: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 30,
    })
    expect(vivos).toHaveLength(30)
    for (const v of vivos.slice(0, 10)) await apartar(v.trackingToken)
    await prisma.onlineOrderCharge.updateMany({
      where: { venueId: venueId!, trackingToken: { in: vivos.slice(10, 15).map(v => v.trackingToken) } },
      data: { checkoutExpiresAt: new Date(Date.now() - MIN) },
    })
    expect(await prisma.onlineOrder.count({ where: apartadosNadieWhere(venueId!) })).toBe(10)
    expect(await prisma.onlineOrderCharge.count({ where: borradoresNadieWhere(venueId!) })).toBe(20)

    await expect(getAcceptingStatus(venueId!)).resolves.toMatchObject({ status: 'OPEN' })
    await expect(tarjeta(clientas[10])).rejects.toMatchObject({ code: 'CARD_ONLINE_QUEUE_FULL' })
    await expect(folioEnCaja()).resolves.toMatchObject({ status: 'PENDING_ACCEPTANCE', replay: false })
  })

  it('d · un borrador de «Nadie» con su página de pago ya vencida pero todavía PENDING_AUTH conserva su lugar hasta que el conciliador lo resuelve', async () => {
    const c = clientas[2]
    const suyos = [await tarjeta(c), await tarjeta(c), await tarjeta(c)]
    await prisma.onlineOrderCharge.updateMany({
      where: { venueId: venueId!, trackingToken: { in: suyos.map(s => s.trackingToken) } },
      data: { checkoutExpiresAt: new Date(Date.now() - MIN) },
    })
    // Para la saturación de «Mi equipo» ya no existen; para el cupo de «Nadie», sí (Stripe pudo autorizarlos).
    expect(await prisma.onlineOrderCharge.count({ where: liveCardDraftsWhere(venueId!, new Date()) })).toBe(0)
    expect(await prisma.onlineOrderCharge.count({ where: borradoresNadieWhere(venueId!) })).toBe(3)
    await expect(tarjeta(c)).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })

    // El conciliador resuelve uno (nunca se autorizó): su lugar se libera.
    await prisma.onlineOrderCharge.update({ where: { trackingToken: suyos[0].trackingToken }, data: { status: 'ABANDONED' } })
    await expect(tarjeta(c)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', replay: false })
  })

  it('D661 · A6: un borrador cobrado fuera de Avoqado (sigue PENDING_AUTH a propósito) ya no ocupa el lugar de la clienta, el de la sucursal ni deja las cajas en sondeo rápido', async () => {
    const c = clientas[3]
    const suyos = [await tarjeta(c), await tarjeta(c), await tarjeta(c)]
    await expect(tarjeta(c)).rejects.toMatchObject({ statusCode: 409, code: 'TOO_MANY_PENDING_ORDERS' })
    await prisma.onlineOrderCharge.updateMany({
      where: { venueId: venueId!, trackingToken: { in: suyos.map(s => s.trackingToken) } },
      data: { lastError: 'CAPTURED_OUTSIDE' },
    })
    // Un borrador vivo con otro tropiezo anotado sí cuenta (el filtro no se come los `lastError` distintos ni los nulos).
    const conTropiezo = await tarjeta(clientas[4])
    await prisma.onlineOrderCharge.update({ where: { trackingToken: conTropiezo.trackingToken }, data: { lastError: 'timeout' } })
    const sinNada = await tarjeta(clientas[4])

    expect(await prisma.onlineOrderCharge.count({ where: borradoresNadieWhere(venueId!) })).toBe(2)
    expect(
      await prisma.onlineOrderCharge.count({ where: { ...borradoresNadieWhere(venueId!), trackingToken: sinNada.trackingToken } }),
    ).toBe(1)
    // Los tres de la clienta siguen PENDING_AUTH (lo resuelve una persona), pero ya no le cuentan: puede pedir otra vez.
    expect(
      await prisma.onlineOrderCharge.count({ where: { venueId: venueId!, status: 'PENDING_AUTH', lastError: 'CAPTURED_OUTSIDE' } }),
    ).toBe(3)
    await expect(tarjeta(c)).resolves.toMatchObject({ status: 'AWAITING_PAYMENT', replay: false })

    // El sondeo rápido: con la tienda en «Mi equipo» y sin nada vivo, sólo un borrador cobrado fuera ya no la deja en 30 s.
    await prisma.onlineOrderCharge.updateMany({
      where: { venueId: venueId!, status: 'PENDING_AUTH', OR: [{ lastError: null }, { lastError: { not: 'CAPTURED_OUTSIDE' } }] },
      data: { status: 'ABANDONED' },
    })
    await prisma.onlineOrderingSettings.update({ where: { venueId: venueId! }, data: { requiresAcceptance: true } })
    await expect(listFolios({ venueId: venueId! })).resolves.toMatchObject({ showTile: false, pollSeconds: 600 })
    // Un borrador sin resolver de verdad sí la deja en 30 s.
    await prisma.onlineOrderCharge.update({ where: { trackingToken: sinNada.trackingToken }, data: { status: 'PENDING_AUTH' } })
    await expect(listFolios({ venueId: venueId! })).resolves.toMatchObject({ showTile: false, pollSeconds: 30 })
  })
})
