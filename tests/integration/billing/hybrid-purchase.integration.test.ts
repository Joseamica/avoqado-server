import prisma from '@/utils/prismaClient'
// B2 Task 10 (el caso de abajo): Stripe, el inventario y el crédito de origen se simulan en su borde; la regla común es la real.
const mockInventario = jest.fn()
const mockCreditoDeOrigen = jest.fn()
const mockSubscriptionsCreate = jest.fn()
jest.mock('@/services/access/inventarioDeObligaciones', () => ({ inventarioDeObligaciones: (...a: unknown[]) => mockInventario(...a) }))
jest.mock('@/services/launchCampaigns/hybridSources', () => ({ readHybridCreditSource: (...a: unknown[]) => mockCreditoDeOrigen(...a) }))
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    customers: { retrieve: jest.fn(async (id: string) => ({ id, balance: 0 })) },
    checkout: { sessions: { list: jest.fn(async () => ({ data: [], has_more: false })) } },
    subscriptions: { create: (...a: unknown[]) => mockSubscriptionsCreate(...a) },
  },
  getOrCreateStripeCustomer: jest.fn(),
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { acceptHybridQuote, createHybridQuote } from '@/services/launchCampaigns/hybridPurchase.service'
import { definicionDePrueba, idsDeLaVersion } from '@tests/__helpers__/planOfferFixtures'

let venueId: string
const stamp = `${Date.now()}${process.pid}`
beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable test DB required')
  const org = await prisma.organization.create({ data: { name: stamp, email: `${stamp}@example.test`, phone: '5550000000' } })
  venueId = (await prisma.venue.create({ data: { name: stamp, slug: `purchase-${stamp}`, organizationId: org.id } })).id
})

const quote = () => ({
  venueId,
  quotedById: 'test',
  quote: { total: '179.90' },
  quoteHash: 'hash',
  quoteExpiresAt: new Date(Date.now() + 300000),
})
describe('durable hybrid purchase invariants', () => {
  it('allows quotes side by side but only one accepted obligation for a venue', async () => {
    const a = await prisma.hybridPurchase.create({ data: quote() })
    const b = await prisma.hybridPurchase.create({ data: quote() })
    const accepted = await Promise.allSettled(
      [a, b].map(row => prisma.hybridPurchase.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } })),
    )
    expect(accepted.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const winner = accepted.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>
    await expect(prisma.hybridPurchase.update({ where: { id: winner.value.id }, data: { quote: { total: '0.01' } } })).rejects.toThrow(
      /immutable/i,
    )
    await prisma.hybridPurchase.update({ where: { id: winner.value.id }, data: { status: 'COMPLETED' } })
  })
  it('does not reuse a caller idempotency key for another quote in the same venue', async () => {
    await prisma.hybridPurchase.create({ data: { ...quote(), clientKey: `key-${stamp}` } })
    await expect(prisma.hybridPurchase.create({ data: { ...quote(), clientKey: `key-${stamp}` } })).rejects.toThrow()
  })
  it('preserves the exact provider request before the call and never changes it on replay', async () => {
    const purchase = await prisma.hybridPurchase.create({ data: { ...quote(), status: 'ACCEPTED', acceptedAt: new Date() } })
    const operation = await prisma.hybridBillingOperation.create({
      data: { purchaseId: purchase.id, step: 'CREATE_SUBSCRIPTION', request: { price: 'price_test' }, requestHash: 'request-hash' },
    })
    await expect(
      prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { request: { price: 'other' } } }),
    ).rejects.toThrow(/immutable/i)
    await expect(
      prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { providerId: 'sub_test', status: 'OBSERVED' } }),
    ).resolves.toMatchObject({ providerId: 'sub_test' })
  })
  it('cannot start a provider mutation after an unprovisioned intent was cancelled', async () => {
    const purchase = await prisma.hybridPurchase.create({ data: { ...quote(), status: 'CANCELLED' } })
    await expect(
      prisma.hybridBillingOperation.create({ data: { purchaseId: purchase.id, step: 'SUBSCRIPTION', request: {}, requestHash: 'hash' } }),
    ).rejects.toThrow(/closed/i)
  })
})

it('keeps the first confirmed schedule result immutable', async () => {
  const prior = await prisma.hybridPurchase.findFirstOrThrow({ where: { venueId, status: 'ACCEPTED' } })
  const operation = await prisma.hybridBillingOperation.create({
    data: { purchaseId: prior.id, step: 'SCHEDULE_CONFIGURE', request: {}, requestHash: 'body' },
  })
  await prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { resultHash: 'first' } })
  await expect(prisma.hybridBillingOperation.update({ where: { id: operation.id }, data: { resultHash: 'different' } })).rejects.toThrow(
    /immutable/i,
  )
})

/**
 * Planes editables B2, Task 10 (§11 F): la compra de funciones sueltas a Pro (`HYBRID_REPLACE`) cita la versión del editor y no se
 * acepta con un plan que salió de venta. La v2 y la v3 se escriben directo en Postgres como `PUBLISHED` con su puntero; la lista
 * híbrida `PLAN:PRO` es de esta suite (las `PLAN:*` de otras suites se aparcan y se restauran).
 *
 * Higiene: guardia `preparada` antes de tocar nada y limpieza paso por paso. Los negocios de esta suite no se borran (como el resto
 * del archivo: una `HybridPurchase` es inmutable y frena el borrado de su negocio) y no dejan nada que cite una versión (ninguna
 * `PlanAcceptance`), así que después se borran `PlanOfferPointer`, `PlanOfferVersion` y el interruptor `PLANES_EDITABLES`.
 */
describe('B2 Task 10 · la compra híbrida a Pro respeta la versión del editor (Postgres real)', () => {
  const MARK = 'test:hybrid-purchase-oferta'
  const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
  const TOPE_DE_APARCADOS = 100
  let preparada = false
  let staffId: string
  let proPub: string
  const aparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []

  const borrarLaOferta = async () => {
    await prisma.planOfferPointer.deleteMany({})
    await prisma.planOfferVersion.deleteMany({})
    await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
  }

  /** Publica `definition` con ese número directo en Postgres: la anterior queda SUPERSEDED y el puntero pasa a ésta. */
  async function publicar(number: number, definition: unknown) {
    const v = await prisma.planOfferVersion.create({
      data: {
        status: 'PUBLISHED',
        number,
        definition: definition as never,
        createdById: staffId,
        publishedById: staffId,
        publishedAt: new Date(),
      },
    })
    const antes = await prisma.planOfferPointer.findUnique({ where: { id: 'vigente' } })
    await prisma.planOfferPointer.upsert({
      where: { id: 'vigente' },
      create: { id: 'vigente', currentVersionId: v.id, revision: number },
      update: { currentVersionId: v.id, revision: number },
    })
    if (antes?.currentVersionId)
      await prisma.planOfferVersion.update({ where: { id: antes.currentVersionId }, data: { status: 'SUPERSEDED' } })
  }

  beforeAll(async () => {
    if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable test DB required')
    preparada = true
    process.env.HYBRID_BILLING_ENABLED = 'true'
    await borrarLaOferta()
    // Las listas de los planes que dejaron otras suites: aparcadas durante la corrida (se guardan ANTES de cambiarlas).
    const listas = await prisma.hybridCampaign.findMany({
      where: { purpose: 'LIST', listProductKey: { in: KEYS } },
      select: { id: true, listProductKey: true, code: true, slug: true },
      orderBy: { id: 'asc' },
      take: TOPE_DE_APARCADOS + 1,
    })
    if (listas.length > TOPE_DE_APARCADOS) throw new Error('Hay demasiadas listas de planes que aparcar: la suite se detiene sin tocarlas')
    for (const lista of listas) {
      await prisma.hybridCampaign.update({
        where: { id: lista.id },
        data: { listProductKey: `FEATURE:PARKED_${lista.id}`, code: `PARKED_${lista.id}`, slug: `parked-${lista.id}` },
      })
      aparcadas.push(lista)
    }
    staffId = (await prisma.staff.create({ data: { email: `oferta-${stamp}@example.test`, firstName: 'Hybrid', lastName: 'Oferta' } })).id
    // La lista híbrida de Pro, en venta a $1,158.84 con IVA al mes.
    const compiled = compileHybridPublication({
      schemaVersion: 1,
      kind: 'PLAN',
      planTier: 'PRO',
      terms: {
        currency: 'MXN',
        interval: 'MONTHLY',
        price: 1158.84,
        taxIncluded: true,
        promotionCycles: null,
        renewal: { kind: 'SAME_PRICE' },
      },
    })
    const campaign = await prisma.hybridCampaign.create({
      data: {
        code: `HPO${stamp}`,
        slug: `hpo-${stamp}`,
        name: `Lista Pro ${stamp}`,
        purpose: 'LIST',
        listProductKey: 'PLAN:PRO',
        draftDefinition: compiled.definition,
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: null,
        capacity: null,
        audience: 'ALL',
        listed: true,
        status: 'ACTIVE',
        revision: 2,
        createdById: MARK,
      },
    })
    const publication = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: campaign.id,
        version: 1,
        name: campaign.name,
        definition: compiled.definition,
        definitionHash: compiled.definitionHash,
        includedFeatureCodes: compiled.includedFeatureCodes,
        stripePriceId: `price_hpo_${stamp}`,
        stripeProductId: `prod_hpo_${stamp}`,
        createdById: MARK,
      },
    })
    await prisma.hybridCampaign.update({ where: { id: campaign.id }, data: { currentPublicationId: publication.id } })
    proPub = publication.id
  })

  afterAll(async () => {
    if (!preparada) return
    // Paso por paso: si uno falla, los demás igual corren; al final se lanza un solo error con todos.
    const errores: string[] = []
    const paso = async (que: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (error) {
        errores.push(`${que}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // La lista de esta suite suelta su producto (una LIST por producto en toda la base) y deja de vender.
    await paso('retirar la lista de Pro de la suite', async () => {
      const propias = await prisma.hybridCampaign.findMany({
        where: { createdById: MARK, purpose: 'LIST' },
        select: { id: true },
        take: 10,
      })
      for (const { id } of propias)
        await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey: `FEATURE:RETIRED_${id}`, status: 'PAUSED' } })
    })
    await paso('borrar la oferta', borrarLaOferta)
    for (const { id, listProductKey, code, slug } of aparcadas)
      await paso(`devolver la lista aparcada ${id}`, () =>
        prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } }),
      )
    delete process.env.HYBRID_BILLING_ENABLED
    if (errores.length) throw new Error(`La limpieza de hybrid-purchase (oferta) no quedó completa:\n- ${errores.join('\n- ')}`)
  })

  it('🔴 cotización de HYBRID_REPLACE a Pro con la v2; el puntero pasa a una v3 con Pro fuera de venta; aceptar → 409 PLAN_NOT_ON_SALE y la compra sigue QUOTED, sin suscripción', async () => {
    if (!preparada) throw new Error('la suite no se preparó')
    // Un negocio que paga una función suelta que Pro también trae: la compra a Pro la reemplaza.
    const customerId = `cus_hpo_${stamp}`
    const sueltaId = `sub_hpo${stamp}`
    const org = await prisma.organization.create({ data: { name: stamp, email: `hpo-${stamp}@example.test`, phone: '5550000000' } })
    const venue = await prisma.venue.create({
      data: { name: stamp, slug: `hpo-${stamp}`, organizationId: org.id, stripeCustomerId: customerId },
    })
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: sueltaId, proyecciones: [{ tipo: 'FUNCION', featureCode: 'LOYALTY_PROGRAM' }] }],
      detalle: {
        [sueltaId]: {
          status: 'active',
          customerId,
          variosItems: false,
          pausaDeCobranza: false,
          metodoDeCobro: 'charge_automatically',
          terminaEn: null,
        },
      },
      conCambiosProgramados: [],
    })
    mockCreditoDeOrigen.mockResolvedValue({ sourceSubscriptionId: sueltaId, sourceInvoiceId: `in_hpo${stamp}`, amount: '0.00' })

    await publicar(2, definicionDePrueba({ ids: idsDeLaVersion(`hpo2${stamp}`) }))
    const cotizada = await createHybridQuote(venue.id, staffId, { lines: [{ publicationId: proPub }], replaceSubscriptionIds: [sueltaId] })
    expect(cotizada).toMatchObject({ status: 'QUOTED', quote: { offerVersion: 2, replaces: [sueltaId] } })

    // El editor publica una v3 que saca Pro de venta (la lista híbrida de Pro sigue ACTIVE).
    await publicar(3, definicionDePrueba({ ids: idsDeLaVersion(`hpo3${stamp}`), planes: { PRO: { onSale: false } } }))
    await expect(
      acceptHybridQuote(venue.id, staffId, cotizada.id, { quoteHash: cotizada.quoteHash, clientKey: `hpo-${stamp}` }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_NOT_ON_SALE', details: { tier: 'PRO' } })

    expect(await prisma.hybridPurchase.findUnique({ where: { id: cotizada.id } })).toMatchObject({
      status: 'QUOTED',
      clientKey: null,
      acceptedAt: null,
      stripeSubscriptionId: null,
    })
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled()
  })
})
