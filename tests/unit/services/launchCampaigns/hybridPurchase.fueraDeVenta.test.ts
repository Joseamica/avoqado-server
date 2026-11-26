/**
 * Planes editables B2, Task 10 (§11 F, §11.2): la compra híbrida (funciones sueltas a Pro, `HYBRID_REPLACE`, y el Básico) respeta la
 * versión del editor.
 *
 * - Con una versión del editor, un plan fuera de venta sólo se cotiza con una prueba vigente de ese plan (regalada o en Stripe), y el
 *   Básico no se cotiza ni se acepta: 409 `PLAN_NOT_ON_SALE`.
 * - La cotización con una línea de plan cita la versión (`offerVersion`, dentro del `quoteHash`); la aceptación la compara, con la
 *   `tx` y DESPUÉS de `lockProducts` (el publicador toma esos mismos candados), con la vigente: otra → «vuelve a cotizar», sin claim.
 * - Lo ya aceptado se cobra y se entrega; una cotización sólo de funciones sueltas no se toca; sin versión del editor, todo como hoy
 *   (también la forma del `quote` y su hash).
 *
 * Stripe, el inventario, la regla común (`autorizarObligacionNueva`, que aquí corre su callback con `prismaMock` como `tx`) y el
 * crédito de origen se simulan en su borde; la base es `prismaMock`.
 */
import { prismaMock } from '../../../__helpers__/setup'
const inventory = jest.fn()
const customers = jest.fn()
const paymentMethod = jest.fn()
const subsList = jest.fn()
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: (...a: unknown[]) => inventory(...a) }))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: {
      retrieve: (...a: unknown[]) => customers(...a),
      listBalanceTransactions: jest.fn().mockResolvedValue({ data: [], has_more: true }),
    },
    subscriptions: { list: (...a: unknown[]) => subsList(...a) },
    paymentMethods: { retrieve: (...a: unknown[]) => paymentMethod(...a) },
  },
  getOrCreateStripeCustomer: jest.fn(),
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
const autorizar = jest.fn()
jest.mock('@/services/access/autorizarObligacionNueva', () => ({ autorizarObligacionNueva: (...a: unknown[]) => autorizar(...a) }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({ assertKeepSelection: jest.fn() }))
const creditSource = jest.fn()
jest.mock('@/services/launchCampaigns/hybridSources', () => ({ readHybridCreditSource: (...a: unknown[]) => creditSource(...a) }))

import { Prisma } from '@prisma/client'
import { acceptHybridQuote, createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridHash } from '@/services/launchCampaigns/hybridProvider'
import { exigirCompraNuevaPermitida } from '@/services/billing/cotizacionDeLaOferta'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const DIA = 86_400_000
const now = Date.now()
const terms = (price: number) => ({
  currency: 'MXN',
  interval: 'MONTHLY',
  price,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
})
const lista = (id: string, campaignId: string, listProductKey: string) => ({
  id: campaignId,
  code: `L_${campaignId}`,
  slug: `lista-${campaignId}`,
  purpose: 'LIST',
  listProductKey,
  status: 'ACTIVE',
  revision: 3,
  startsAt: new Date(now - 10_000),
  endsAt: null,
  capacity: null,
  reservedCount: 0,
  redeemedCount: 0,
  audience: 'ALL',
  eligibleOrganizationIds: [],
  currentPublicationId: id,
  promotionGroupId: null,
})

/** La lista híbrida de Pro: un plan, a $1,158.84 con IVA al mes. */
const proPubId = 'cm100000000000000000000001'
const proCampaignId = 'cm100000000000000000000002'
const proCompiled = compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms: terms(1158.84) })
const proPublication = {
  id: proPubId,
  campaignId: proCampaignId,
  name: 'Plan Pro',
  version: 1,
  definitionHash: proCompiled.definitionHash,
  includedFeatureCodes: proCompiled.includedFeatureCodes,
  stripePriceId: 'price_pro_lista',
  stripeRenewalPriceId: null,
  stripeProductId: 'prod_pro_lista',
  definition: proCompiled.definition,
  campaign: lista(proPubId, proCampaignId, 'PLAN:PRO'),
}

/** Una función suelta que Pro también trae (la que se reemplaza). */
const LOOSE = 'LOYALTY_PROGRAM'
const loosePubId = 'cm200000000000000000000001'
const looseCampaignId = 'cm200000000000000000000002'
const looseCompiled = compileHybridPublication({ schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms: terms(229) })
const loosePublication = {
  ...proPublication,
  id: loosePubId,
  campaignId: looseCampaignId,
  name: 'CFDI suelto',
  definitionHash: looseCompiled.definitionHash,
  includedFeatureCodes: looseCompiled.includedFeatureCodes,
  definition: looseCompiled.definition,
  campaign: lista(loosePubId, looseCampaignId, 'FEATURE:CFDI'),
}

/** El Básico: funciones con la marca `basicPlan`, en su lista `PLAN:BASICO`. */
const BASIC_CODES = ['ADVANCED_REPORTS', 'CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS', 'RESERVATIONS']
const basicPubId = 'cm300000000000000000000001'
const basicCampaignId = 'cm300000000000000000000002'
const basicPublication = {
  ...proPublication,
  id: basicPubId,
  campaignId: basicCampaignId,
  name: 'Plan Básico',
  definitionHash: 'b'.repeat(64),
  includedFeatureCodes: BASIC_CODES,
  definition: { schemaVersion: 1, kind: 'FEATURES', basicPlan: true, seatCap: 3, featureCodes: BASIC_CODES, terms: terms(578.84) },
  campaign: lista(basicPubId, basicCampaignId, 'PLAN:BASICO'),
}

/** El negocio paga hoy una función suelta (`sub_loose`): la compra a Pro la reemplaza. */
const conSuelta = () => ({
  vivas: [{ subscriptionId: 'sub_loose', proyecciones: [{ tipo: 'FUNCION', featureCode: LOOSE }] }],
  detalle: {
    sub_loose: {
      status: 'active',
      customerId: 'cus_test',
      variosItems: false,
      pausaDeCobranza: false,
      metodoDeCobro: 'charge_automatically',
      terminaEn: null,
    },
  },
  conCambiosProgramados: [],
})
const aPro = { lines: [{ publicationId: proPubId }], replaceSubscriptionIds: ['sub_loose'] }
const basicInput = { lines: [{ publicationId: basicPubId }] }
const looseInput = { lines: [{ publicationId: loosePubId }] }

// Las versiones: la v1 (lo de hoy), la v2 del editor y la v3. Ningún precio de plan cambia el de la lista híbrida aquí.
const v1 = () => punteroA('ver_v1', 1, versionUno())
const v2 = (pro: { onSale?: boolean } = {}) =>
  punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PRO: { onSale: pro.onSale ?? true } } }))
const v3 = (pro: { onSale?: boolean; annualNet?: number } = {}) =>
  punteroA(
    'ver_v3',
    3,
    definicionDePrueba({
      ids: idsDeLaVersion('v3'),
      netos: pro.annualNet ? { 'PRO:annual': pro.annualNet } : {},
      planes: { PRO: { onSale: pro.onSale ?? true } },
    }),
  )
const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const fueraDeVenta = (tier: string, nombre: string) => ({
  statusCode: 409,
  code: 'PLAN_NOT_ON_SALE',
  message: `El plan ${nombre} ya no está a la venta. Elige otro plan. No se te cobró nada.`,
  details: { tier },
})

/** Filas de `VenueFeature`: la de plan sólo para la consulta de la fila del plan (y, si `retenida`, también para lo que se conserva). */
let filasDelPlan: unknown[] = []
const pruebaRegalada = (code = 'PLAN_PRO', endDate = new Date(now + 10 * DIA)) => ({
  id: 'vf_regalo',
  active: true,
  endDate,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  stripeSubscriptionId: null,
  updatedAt: new Date(now - DIA),
  feature: { code },
})

beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  filasDelPlan = []
  pointer.mockReset().mockResolvedValue(null)
  customers.mockReset().mockResolvedValue({ id: 'cus_test', balance: 0, invoice_settings: { default_payment_method: null } })
  subsList.mockReset().mockResolvedValue({ data: [], has_more: false })
  paymentMethod.mockReset()
  creditSource.mockReset().mockResolvedValue({ sourceSubscriptionId: 'sub_loose', amount: new Prisma.Decimal('0') })
  inventory.mockReset().mockResolvedValue(conSuelta())
  autorizar.mockReset()
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue',
    organizationId: 'org',
    stripeCustomerId: 'cus_test',
    timezone: 'America/Mexico_City',
    organization: { id: 'org', createdAt: new Date(now), email: 'test@example.test', name: 'Test' },
  })
  prismaMock.hybridOfferPublication.findMany.mockImplementation(async ({ where }: any) =>
    [proPublication, loosePublication, basicPublication].filter(p => where.id.in.includes(p.id)),
  )
  prismaMock.hybridCampaign.count.mockResolvedValue(0)
  prismaMock.venueFeature.findMany.mockImplementation(async ({ where }: any) => (where.feature ? filasDelPlan : []))
  prismaMock.capabilityGrant.findMany.mockResolvedValue([])
  prismaMock.hybridContract.findMany.mockResolvedValue([])
  prismaMock.hybridContract.findFirst.mockResolvedValue(null)
  prismaMock.hybridRedemption.findMany.mockResolvedValue([])
  prismaMock.hybridPaymentPeriod.findFirst.mockResolvedValue(null)
  prismaMock.hybridPurchase.create.mockImplementation(async ({ data }: any) => ({ id: 'quote', ...data }))
  prismaMock.hybridPurchase.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.hybridCampaign.findUniqueOrThrow.mockReset()
  prismaMock.hybridCampaign.updateMany.mockReset().mockResolvedValue({ count: 1 })
  prismaMock.hybridPurchase.findUniqueOrThrow.mockResolvedValue({ id: 'quote', status: 'ACCEPTED' })
  prismaMock.activityLog.create.mockResolvedValue({})
})
afterEach(() => {
  delete process.env.HYBRID_BILLING_ENABLED
})

/** Cotiza y deja la compra lista para aceptarse (`hybridPurchase.findUnique` la devuelve). */
async function cotizado(input: object) {
  const row = await createHybridQuote('venue', 'staff', input)
  const purchase = { ...row, id: 'quote', venueId: 'venue', quoteExpiresAt: new Date(now + 60_000) }
  prismaMock.hybridPurchase.findUnique.mockImplementation(async ({ where }: any) => (where.id === 'quote' ? purchase : null))
  return purchase
}
const aceptar = (purchase: { quoteHash: string }) =>
  acceptHybridQuote('venue', 'staff', 'quote', { quoteHash: purchase.quoteHash, clientKey: 'clave-intento-1' })

/**
 * La regla común corre el callback con `prismaMock` como `tx`; ANTES (después de la re-observación de la aceptación) `entre` cambia lo
 * que haga falta. Devuelve el orden de la llamada del candado `precio:<llave>` (`lockProducts`) para comparar.
 */
function bajoLaRegla(entre: () => void) {
  autorizar.mockImplementation(async (_venue: string, _customer: string, _intent: unknown, crear: any) => {
    entre()
    pointer.mockClear()
    // El mismo inventario que vio la cotización: el hash del inventario cuadra.
    return crear(prismaMock, await inventory())
  })
}
const ordenDelCandado = () => {
  const llamadas = (prismaMock.$executeRaw as jest.Mock).mock.calls.map((c: unknown[], i: number) => ({
    texto: (c[0] as string[]).join('?'),
    valores: c.slice(1),
    orden: (prismaMock.$executeRaw as jest.Mock).mock.invocationCallOrder[i],
  }))
  const candado = llamadas.find(l => l.texto.includes('pg_advisory_xact_lock') && String(l.valores[0]).startsWith('precio:'))
  if (!candado) throw new Error('no se tomó el candado de producto')
  return candado.orden
}

describe('B2 Task 10 · la compra híbrida respeta la versión del editor', () => {
  it('🔴 con la v2 y Pro fuera de venta: cotizar HYBRID_REPLACE a Pro → 409 PLAN_NOT_ON_SALE; con una prueba vigente de Pro → cotiza', async () => {
    pointer.mockResolvedValue(v2({ onSale: false }))
    await expect(createHybridQuote('venue', 'staff', aPro)).rejects.toMatchObject(fueraDeVenta('PRO', 'Pro'))
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
    // Se niega antes de leer Stripe: ni inventario, ni cliente, ni la factura de origen.
    expect(inventory).not.toHaveBeenCalled()
    expect(customers).not.toHaveBeenCalled()
    expect(creditSource).not.toHaveBeenCalled()

    // Una prueba REGALADA vigente de Pro da derecho a contratarlo: cotiza, y la cotización cita la versión.
    filasDelPlan = [pruebaRegalada()]
    const quote = await createHybridQuote('venue', 'staff', aPro)
    expect(quote).toMatchObject({ status: 'QUOTED', quote: { offerVersion: 2, replaces: ['sub_loose'] } })
    expect(quote.quoteHash).toBe(hybridHash(quote.quote))

    // La prueba de otro plan, o ya vencida, no.
    filasDelPlan = [pruebaRegalada('PLAN_PREMIUM')]
    await expect(createHybridQuote('venue', 'staff', aPro)).rejects.toMatchObject(fueraDeVenta('PRO', 'Pro'))
    filasDelPlan = [pruebaRegalada('PLAN_PRO', new Date(now - DIA))]
    await expect(createHybridQuote('venue', 'staff', aPro)).rejects.toMatchObject(fueraDeVenta('PRO', 'Pro'))

    // Una prueba EN STRIPE vigente de Pro (la fila ligada a su suscripción, con el fin de la prueba por venir) también.
    filasDelPlan = [{ ...pruebaRegalada(), stripeSubscriptionId: 'sub_prueba' }]
    await expect(exigirCompraNuevaPermitida(prismaMock, { venueId: 'venue', tier: 'PRO', basico: false })).resolves.toBeUndefined()
    // Pagada (Stripe borra el vencimiento al cobrar) ya no es una prueba.
    filasDelPlan = [{ ...pruebaRegalada(), stripeSubscriptionId: 'sub_pagada', endDate: null }]
    await expect(exigirCompraNuevaPermitida(prismaMock, { venueId: 'venue', tier: 'PRO', basico: false })).rejects.toMatchObject(
      fueraDeVenta('PRO', 'Pro'),
    )
  })

  it('🔴 Pro sale de venta entre la cotización y la aceptación → aceptar responde 409 PLAN_NOT_ON_SALE, revisado con la tx después de lockProducts', async () => {
    pointer.mockResolvedValue(v2())
    const purchase = await cotizado(aPro)
    expect(purchase.quote).toMatchObject({ offerVersion: 2 })
    // Después de la re-observación (que todavía vio la v2): el puntero pasa a una v3 con Pro fuera de venta.
    bajoLaRegla(() => pointer.mockResolvedValue(v3({ onSale: false })))
    await expect(aceptar(purchase)).rejects.toMatchObject(fueraDeVenta('PRO', 'Pro'))
    expect(autorizar).toHaveBeenCalledTimes(1)
    // Leído con la tx, DESPUÉS del candado de producto (el que toma el publicador), y sin claim ni campañas.
    const candado = ordenDelCandado()
    expect(pointer.mock.invocationCallOrder.length).toBeGreaterThan(0)
    expect(pointer.mock.invocationCallOrder.every((orden: number) => orden > candado)).toBe(true)
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.hybridCampaign.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it('una compra ya ACCEPTED se cobra y se entrega igual', async () => {
    pointer.mockResolvedValue(v2())
    const purchase = await cotizado(aPro)
    pointer.mockClear().mockResolvedValue(v3({ onSale: false }))
    for (const status of ['ACCEPTED', 'PROVISIONING', 'PAYMENT_PENDING', 'PAID', 'DELIVERING'] as const) {
      prismaMock.hybridPurchase.findUnique.mockResolvedValue({ ...purchase, status })
      await expect(aceptar(purchase)).resolves.toMatchObject({ id: 'quote', status })
    }
    // No vuelve a leer la oferta ni pasa por la regla común: sigue a la entrega con lo que ya aceptó.
    expect(pointer).not.toHaveBeenCalled()
    expect(autorizar).not.toHaveBeenCalled()
  })

  it('🔴 con la v2, cotizar o aceptar el Básico → 409 PLAN_NOT_ON_SALE (tier BASICO); sin versión del editor, el Básico como hoy', async () => {
    inventory.mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
    pointer.mockResolvedValue(v2())
    await expect(createHybridQuote('venue', 'staff', basicInput)).rejects.toMatchObject(fueraDeVenta('BASICO', 'Básico'))
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
    expect(customers).not.toHaveBeenCalled()

    // Sin versión del editor: se cotiza como hoy (sin `offerVersion`: el Básico no es una línea de plan).
    pointer.mockResolvedValue(null)
    const purchase = await cotizado(basicInput)
    expect(purchase).toMatchObject({ status: 'QUOTED', quote: { total: '578.84' } })
    expect(purchase.quote).not.toHaveProperty('offerVersion')

    // Se publica la v2 antes de aceptar: la re-observación ya lo niega, sin llegar a la regla común.
    pointer.mockResolvedValue(v2())
    await expect(aceptar(purchase)).rejects.toMatchObject(fueraDeVenta('BASICO', 'Básico'))
    expect(autorizar).not.toHaveBeenCalled()

    // Y si se publica justo después de la re-observación: lo niega la revisión con la tx, sin claim.
    pointer.mockResolvedValue(null)
    bajoLaRegla(() => pointer.mockResolvedValue(v2()))
    await expect(aceptar(purchase)).rejects.toMatchObject(fueraDeVenta('BASICO', 'Básico'))
    expect(autorizar).toHaveBeenCalledTimes(1)
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 b2-r1 #11: QUOTED de HYBRID_REPLACE a Pro con la v2; se publica una v3 que sólo cambió el anual (misma publicación híbrida); aceptar → 409 HYBRID_QUOTE_STALE, sin claim', async () => {
    pointer.mockResolvedValue(v2())
    const purchase = await cotizado(aPro)
    expect(purchase.quote).toMatchObject({ offerVersion: 2 })
    // La v3 sólo cambia el anual de Pro: la publicación híbrida (mensual) es la misma, pero la versión que se citó ya no rige.
    pointer.mockResolvedValue(v3({ annualNet: 899000 }))
    await expect(aceptar(purchase)).rejects.toMatchObject({ statusCode: 409, code: 'HYBRID_QUOTE_STALE' })
    expect(autorizar).not.toHaveBeenCalled()
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 b2-r2 #9: QUOTED tomada con la v1 (sin offerVersion); la v2 se publica antes de lockProducts reusando la publicación mensual → offerChanged bajo el candado, sin claim', async () => {
    pointer.mockResolvedValue(v1())
    const purchase = await cotizado(aPro)
    expect(purchase.quote).not.toHaveProperty('offerVersion')
    // Después de la re-observación (la v1 todavía: el hash cuadra) y antes del candado, el editor publica la v2.
    bajoLaRegla(() => pointer.mockResolvedValue(v2()))
    await expect(aceptar(purchase)).rejects.toMatchObject({
      statusCode: 409,
      code: 'HYBRID_OFFER_UNAVAILABLE',
      message: 'La oferta cambió; revisa una cotización nueva.',
    })
    const candado = ordenDelCandado()
    expect(pointer.mock.invocationCallOrder.every((orden: number) => orden > candado)).toBe(true)
    expect(prismaMock.hybridPurchase.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.hybridCampaign.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it('una cotización sólo de funciones sueltas no se niega por una publicación de los planes; sin versión del editor, el quote y su hash como hoy', async () => {
    inventory.mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
    // Una v2 que saca de venta los dos planes: la función suelta se cotiza y se acepta igual, sin leer la oferta.
    pointer.mockResolvedValue(
      punteroA(
        'ver_v2',
        2,
        definicionDePrueba({ ids: idsDeLaVersion('v2'), planes: { PRO: { onSale: false }, PREMIUM: { onSale: false } } }),
      ),
    )
    const loose = await cotizado(looseInput)
    expect(loose).toMatchObject({ status: 'QUOTED', quote: { total: '229.00' } })
    expect(loose.quote).not.toHaveProperty('offerVersion')
    prismaMock.hybridCampaign.findUniqueOrThrow.mockResolvedValue(loosePublication.campaign)
    autorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: any) =>
      crear(prismaMock, { vivas: [], detalle: {}, conCambiosProgramados: [] }),
    )
    await expect(aceptar(loose)).resolves.toMatchObject({ id: 'quote', status: 'ACCEPTED' })
    expect(prismaMock.hybridPurchase.updateMany).toHaveBeenCalledTimes(1)
    expect(pointer).not.toHaveBeenCalled()

    // Sin versión del editor, una cotización a Pro: la forma de hoy (sin `offerVersion`) y su hash sobre esa forma.
    inventory.mockResolvedValue(conSuelta())
    pointer.mockResolvedValue(null)
    const pro = await createHybridQuote('venue', 'staff', aPro)
    expect(Object.keys(pro.quote as object).sort()).toEqual(
      [
        'campaigns',
        'credit',
        'creditBalanceAfter',
        'currency',
        'droppedFeatureCodes',
        'dueNow',
        'effectiveAt',
        'existingBalance',
        'featureCodes',
        'input',
        'interval',
        'inventoryHash',
        'lines',
        'replaces',
        'schemaVersion',
        'sources',
        'taxIncluded',
        'total',
      ].sort(),
    )
    expect(pro.quoteHash).toBe(hybridHash(pro.quote))
  })

  it('si leer la oferta falla: con el puntero en la v1, la cotización a Pro sigue como hoy; en una versión del editor, 503 sin cotizar ni leer Stripe', async () => {
    // Una v1 cuya definición no pasa el esquema: el camino híbrido nunca leyó la oferta, así que sigue como hoy (con un aviso).
    pointer.mockResolvedValue(punteroA('ver_v1', 1, { schemaVersion: 1, roto: true }))
    const hoy = await createHybridQuote('venue', 'staff', aPro)
    expect(hoy.status).toBe('QUOTED')
    expect(hoy.quote).not.toHaveProperty('offerVersion')
    // Una v2 dañada: no se sabe qué vende el editor, así que una compra nueva de un plan falla cerrada, antes de Stripe.
    pointer.mockResolvedValue(punteroA('ver_v2', 2, { schemaVersion: 1, roto: true }))
    customers.mockClear()
    inventory.mockClear()
    prismaMock.hybridPurchase.create.mockClear()
    await expect(createHybridQuote('venue', 'staff', aPro)).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(prismaMock.hybridPurchase.create).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
    expect(customers).not.toHaveBeenCalled()
  })
})
