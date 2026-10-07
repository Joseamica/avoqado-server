// tests/integration/staffPay/acceso.feature.test.ts
// Pago al personal por plan (fase 3, Bloque C). C1b: los contratos comerciales de PRO y PREMIUM que ya existían conservan
// SERVICE_PAY hoy y DESPUÉS de renovar (Review Focus 5; spec §10, Codex r2-8 y r3-2). Stripe simulado como en
// tests/integration/billing/hybrid-delivery.integration.test.ts; la renovación pasa por la entrega REAL.
import prisma from '@/utils/prismaClient'

const subscriptions = new Map<string, any>()
const invoices = new Map<string, any>()
const payments = new Map<string, any[]>()
const disputes = new Map<string, any[]>()
jest.mock('@/services/stripe.service', () => ({
  stripe: {
    subscriptions: { retrieve: jest.fn(async (id: string) => subscriptions.get(id)) },
    invoices: { retrieve: jest.fn(async (id: string) => invoices.get(id)) },
    invoicePayments: {
      list: jest.fn(async ({ invoice }: { invoice: string }) => ({ has_more: false, data: payments.get(invoice) ?? [] })),
    },
    disputes: { list: jest.fn(async ({ charge }: { charge: string }) => ({ data: disputes.get(charge) ?? [], has_more: false })) },
    creditNotes: { list: jest.fn(async () => ({ has_more: false, data: [] })) },
  },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))

// C2 (la puerta por función y la activación) vive en acceso.feature.c2.test.ts; C3 (la migración), en acceso.feature.c3.test.ts.
import { reconcileHybridInvoice } from '@/services/launchCampaigns/hybridDelivery.service'
import { addServicePayToLivePlanContracts } from '@/services/launchCampaigns/hybridPlanCatchUp'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

const DIA = 86400
const stamp = `${Date.now()}${process.pid}`
let n = 0
let organizationId: string
let staffId: string
/** La composición que se congeló ANTES de que SERVICE_PAY entrara al plan. */
const ANTES = ['LOYALTY_PROGRAM', 'RESERVATIONS']
const CON_PAGO = ['LOYALTY_PROGRAM', 'RESERVATIONS', 'SERVICE_PAY']

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `pf3-${stamp}`, email: `pf3-${stamp}@example.test`, phone: '5550000000' } })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `pf3-${stamp}@example.test`, firstName: 'Planes', lastName: 'QA' } })).id
})

/**
 * Un contrato comercial de plan ya entregado con la composición de antes. Su periodo pagado P1 va de hace `desde` días a
 * dentro de `hasta` días (por default cubre hoy; con `hasta` negativo ya terminó y la renovación está por entregarse).
 */
async function contratoDePlan(planTier: 'PRO' | 'PREMIUM', incluidas: string[] = ANTES, desde = 20, hasta = 10) {
  const key = `pf3${stamp}${++n}`
  const ahora = Math.floor(Date.now() / 1000)
  const p1 = { start: ahora - desde * DIA, end: ahora + hasta * DIA }
  const venueId = (await prisma.venue.create({ data: { name: key, slug: key, organizationId } })).id
  const terms = {
    currency: 'MXN',
    interval: 'MONTHLY',
    price: 999,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
  }
  const definition = { schemaVersion: 1, kind: 'PLAN', planTier, terms }
  const campaign = await prisma.hybridCampaign.create({
    data: {
      code: key,
      slug: key,
      name: key,
      draftDefinition: definition,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + DIA * 1000),
      capacity: 5,
      audience: 'ALL',
      createdById: staffId,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: key,
      definition,
      definitionHash: 'b'.repeat(64),
      includedFeatureCodes: incluidas,
      createdById: staffId,
      stripePriceId: `price_${key}`,
      stripeProductId: `prod_${key}`,
    },
  })
  const line = {
    publicationId: publication.id,
    name: key,
    definitionHash: 'b'.repeat(64),
    kind: 'PLAN',
    planTier,
    featureCodes: incluidas,
    terms,
  }
  const quote = {
    schemaVersion: 1,
    lines: [line],
    featureCodes: incluidas,
    total: '999.00',
    credit: '0.00',
    dueNow: '999.00',
    sources: [],
    replaces: [],
    effectiveAt: p1.start,
  }
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: staffId,
      quote,
      quoteHash: key,
      quoteExpiresAt: new Date(Date.now() + 300000),
      status: 'COMPLETED',
      stripeCustomerId: `cus_${key}`,
      stripeSubscriptionId: `sub_${key}`,
      initialInvoiceId: `in_${key}`,
    },
  })
  const contract = await prisma.hybridContract.create({
    data: {
      venueId,
      purchaseId: purchase.id,
      publicationId: publication.id,
      stripeSubscriptionId: `sub_${key}`,
      stripeItemId: `si_${key}`,
      featureCodes: incluidas,
      planTier,
      startsAt: new Date(p1.start * 1000),
      paidThrough: new Date(p1.end * 1000),
    },
  })
  const period = await prisma.hybridPaymentPeriod.create({
    data: {
      venueId,
      stripeSubscriptionId: `sub_${key}`,
      stripeInvoiceId: `in_${key}`,
      startsAt: new Date(p1.start * 1000),
      endsAt: new Date(p1.end * 1000),
      fundedAmount: '999.00',
      composition: [{ contractId: contract.id, itemId: `si_${key}`, featureCodes: incluidas, priceId: `price_${key}`, amount: '999.00' }],
    },
  })
  await prisma.capabilityGrant.createMany({
    data: incluidas.map(featureCode => ({
      venueId,
      featureCode,
      sourceId: `${period.id}:${contract.id}`,
      contractId: contract.id,
      paymentPeriodId: period.id,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
    })),
  })
  subscriptions.set(`sub_${key}`, {
    id: `sub_${key}`,
    customer: `cus_${key}`,
    status: 'active',
    metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: purchase.id, venueId, quoteHash: key },
    schedule: null,
    items: { has_more: false, data: [{ id: `si_${key}`, price: { id: `price_${key}` }, quantity: 1 }] },
  })
  return { key, venueId, campaign, publication, purchase, contract, period, p1 }
}
type Contrato = Awaited<ReturnType<typeof contratoDePlan>>

/** Factura pagada de la suscripción de `f` por `periodo` (`reembolsada` = devuelta completa; `disputada` = su cargo en disputa). */
function factura(
  f: Contrato,
  id: string,
  periodo: { start: number; end: number },
  { reembolsada = false, disputada = false }: { reembolsada?: boolean; disputada?: boolean } = {},
) {
  invoices.set(id, {
    id,
    customer: `cus_${f.key}`,
    parent: { subscription_details: { subscription: `sub_${f.key}` } },
    status: 'paid',
    currency: 'mxn',
    total: 99900,
    amount_remaining: 0,
    starting_balance: 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${id}`,
          amount: 99900,
          quantity: 1,
          pricing: { price_details: { price: `price_${f.key}` } },
          parent: { subscription_item_details: { subscription_item: `si_${f.key}`, proration: false } },
          period: periodo,
        },
      ],
    },
  })
  payments.set(id, [
    {
      status: 'paid',
      currency: 'mxn',
      amount_paid: 99900,
      payment: {
        type: 'charge',
        charge: {
          id: `ch_${id}`,
          amount: 99900,
          amount_refunded: reembolsada ? 99900 : 0,
          currency: 'mxn',
          paid: true,
          disputed: disputada,
        },
      },
    },
  ])
  return id
}

describe('C1b — contratos comerciales vivos (spec fase 3 §10, Review Focus 5)', () => {
  it.each(['PRO', 'PREMIUM'] as const)(
    'un contrato %s vivo gana SERVICE_PAY hoy, ligado a su periodo pagado, y lo conserva al renovar',
    async planTier => {
      const f = await contratoDePlan(planTier)
      await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(false)

      await addServicePayToLivePlanContracts()

      await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
      expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toMatchObject({
        sourceId: `${f.period.id}:${f.contract.id}`,
        contractId: f.contract.id,
        paymentPeriodId: f.period.id,
        startsAt: f.period.startsAt,
        endsAt: f.period.endsAt,
        revokedAt: null,
      })
      // La selección que leen las renovaciones: desde el próximo periodo sin entregar, sin mover la revisión.
      expect(await prisma.hybridContractSelection.findFirstOrThrow({ where: { contractId: f.contract.id } })).toMatchObject({
        effectiveAt: f.contract.paidThrough,
        featureCodes: CON_PAGO,
      })
      expect(await prisma.hybridContract.findUniqueOrThrow({ where: { id: f.contract.id } })).toMatchObject({
        featureCodes: CON_PAGO,
        revision: f.contract.revision,
      })

      // La renovación, por la entrega REAL.
      const id = factura(f, `in_${f.key}_r`, { start: f.p1.end, end: f.p1.end + 30 * DIA })
      await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'ACTIVE' })
      const p2 = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: id } })
      expect(p2.composition).toEqual([expect.objectContaining({ contractId: f.contract.id, featureCodes: CON_PAGO })])
      expect(await prisma.capabilityGrant.count({ where: { paymentPeriodId: p2.id, featureCode: 'SERVICE_PAY', revokedAt: null } })).toBe(1)
    },
  )

  it('correrlo dos veces no duplica la selección, el acceso ni la bitácora', async () => {
    const f = await contratoDePlan('PRO')
    await addServicePayToLivePlanContracts()
    await addServicePayToLivePlanContracts()
    expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { action: 'HYBRID_PLAN_FEATURE_ADDED', entityId: f.contract.id } })).toBe(1)
  })

  it('espera el candado de entrega de la compra: no escribe a la mitad de una entrega en curso', async () => {
    const f = await contratoDePlan('PRO')
    const candado = `hybrid-delivery:${f.purchase.id}`
    let soltar!: () => void
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    let tomado!: () => void
    const yaTomado = new Promise<void>(resolve => (tomado = resolve))
    // Una «entrega» que tiene el candado de la compra, como `reconcileHybridInvoice`.
    const entrega = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${candado}))::text`
        tomado()
        await suelto
      },
      { timeout: 60000 },
    )
    let corrida: Promise<unknown> | undefined
    try {
      await yaTomado
      let terminada = false
      corrida = addServicePayToLivePlanContracts().finally(() => (terminada = true))
      // Una llave bigint de candado consultivo sale en pg_locks con su mitad baja en `objid` y `objsubid` = 1.
      let esperando = false
      for (let i = 0; i < 600 && !esperando && !terminada; i++) {
        const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
            AND objid::bigint = (hashtext(${candado})::bigint & 4294967295)`
        esperando = n > 0
        if (!esperando) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(esperando).toBe(true)
      expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(0)
      soltar()
      await entrega
      await corrida
      expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(1)
    } finally {
      soltar()
      await entrega
      await corrida?.catch(() => undefined)
    }
  })

  it('un reembolso del periodo pagado revoca también el SERVICE_PAY ligado a él', async () => {
    const f = await contratoDePlan('PRO')
    await addServicePayToLivePlanContracts()
    const id = factura(f, `in_${f.key}`, f.p1, { reembolsada: true })
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'PAYMENT_REVERSED' })
    expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toMatchObject({
      revokedAt: expect.any(Date),
    })
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(false)
  })

  it('un contrato terminado no se toca; uno con su periodo ya revocado gana la selección y un acceso revocado como sus hermanos', async () => {
    const terminado = await contratoDePlan('PRO')
    await prisma.hybridContract.update({ where: { id: terminado.contract.id }, data: { endedAt: new Date() } })
    const revocado = await contratoDePlan('PREMIUM')
    await prisma.capabilityGrant.updateMany({ where: { contractId: revocado.contract.id }, data: { revokedAt: new Date() } })

    await addServicePayToLivePlanContracts()

    expect(await prisma.hybridContractSelection.count({ where: { contractId: terminado.contract.id } })).toBe(0)
    expect((await prisma.hybridContract.findUniqueOrThrow({ where: { id: terminado.contract.id } })).featureCodes).toEqual(ANTES)
    expect(await prisma.hybridContractSelection.count({ where: { contractId: revocado.contract.id } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: revocado.venueId, featureCode: 'SERVICE_PAY' } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: revocado.venueId, featureCode: 'SERVICE_PAY', revokedAt: null } })).toBe(
      0,
    )
  })

  it('un contrato que no es de plan (funciones sueltas) no gana SERVICE_PAY', async () => {
    const sueltas = await contratoDePlan('PRO')
    await prisma.hybridContract.update({ where: { id: sueltas.contract.id }, data: { planTier: null } })

    await addServicePayToLivePlanContracts()

    expect(await prisma.hybridContractSelection.count({ where: { contractId: sueltas.contract.id } })).toBe(0)
    expect((await prisma.hybridContract.findUniqueOrThrow({ where: { id: sueltas.contract.id } })).featureCodes).toEqual(ANTES)
    expect(await prisma.capabilityGrant.count({ where: { venueId: sueltas.venueId, featureCode: 'SERVICE_PAY' } })).toBe(0)
  })

  it('sólo un periodo SIN TERMINAR que cobró ESTE contrato recibe el acceso', async () => {
    // P1 ya terminó; P2 (de la misma suscripción, vigente) no cobró este contrato: ninguno de los dos lo recibe.
    const f = await contratoDePlan('PRO', ANTES, 40, -10)
    await prisma.hybridPaymentPeriod.create({
      data: {
        venueId: f.venueId,
        stripeSubscriptionId: `sub_${f.key}`,
        stripeInvoiceId: `in_${f.key}_otro`,
        startsAt: new Date(f.p1.end * 1000),
        endsAt: new Date((f.p1.end + 30 * DIA) * 1000),
        fundedAmount: '999.00',
        composition: [
          {
            contractId: `otro_${f.key}`,
            itemId: `si_otro_${f.key}`,
            featureCodes: ANTES,
            priceId: `price_otro_${f.key}`,
            amount: '999.00',
          },
        ],
      },
    })

    await addServicePayToLivePlanContracts()

    expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(1)
    expect(await prisma.capabilityGrant.count({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toBe(0)
  })

  it('una renovación que empezó ANTES de correr esto y se entrega DESPUÉS también la trae (Codex plan r1)', async () => {
    // P1 terminó hace 10 días; P2 empezó ahí y su factura todavía no se entrega cuando corre la función.
    const f = await contratoDePlan('PRO', ANTES, 40, -10)
    await addServicePayToLivePlanContracts()
    expect(await prisma.hybridContractSelection.findFirstOrThrow({ where: { contractId: f.contract.id } })).toMatchObject({
      effectiveAt: f.contract.paidThrough,
      featureCodes: CON_PAGO,
    })

    const id = factura(f, `in_${f.key}_tarde`, { start: f.p1.end, end: f.p1.end + 30 * DIA })
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'ACTIVE' })
    const p2 = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: id } })
    expect(p2.composition).toEqual([expect.objectContaining({ contractId: f.contract.id, featureCodes: CON_PAGO })])
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
  })

  it('un periodo revocado por una disputa recibe su acceso revocado y la entrega lo RESTAURA al ganarla (Codex plan r1)', async () => {
    const f = await contratoDePlan('PRO')
    const id = factura(f, `in_${f.key}`, f.p1, { disputada: true })
    disputes.set(`ch_${id}`, [{ status: 'needs_response' }])
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'PAYMENT_REVERSED' })

    await addServicePayToLivePlanContracts()
    expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toMatchObject({
      paymentPeriodId: f.period.id,
      revokedAt: expect.any(Date),
    })
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(false)

    disputes.set(`ch_${id}`, [{ status: 'won' }])
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'ACTIVE' })
    expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toMatchObject({
      revokedAt: null,
    })
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
  })

  it('la PRIMERA conciliación de la renovación salió en disputa (periodo sin grants y con la composición vieja): al ganarla, también la trae (Codex plan r2)', async () => {
    // P1 terminó; la primera conciliación de P2 encuentra el cargo en disputa: se guarda P2 sin crear ningún grant.
    const f = await contratoDePlan('PRO', ANTES, 40, -10)
    const id = factura(f, `in_${f.key}_p2`, { start: f.p1.end, end: f.p1.end + 30 * DIA }, { disputada: true })
    disputes.set(`ch_${id}`, [{ status: 'needs_response' }])
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'PAYMENT_REVERSED' })
    const p2 = await prisma.hybridPaymentPeriod.findUniqueOrThrow({ where: { stripeInvoiceId: id } })
    expect(p2.composition).toEqual([expect.objectContaining({ featureCodes: ANTES })])
    expect(await prisma.capabilityGrant.count({ where: { paymentPeriodId: p2.id } })).toBe(0)

    await addServicePayToLivePlanContracts()
    expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { paymentPeriodId: p2.id, featureCode: 'SERVICE_PAY' } })).toMatchObject({
      sourceId: `${p2.id}:${f.contract.id}`,
      contractId: f.contract.id,
      startsAt: p2.startsAt,
      endsAt: p2.endsAt,
      revokedAt: expect.any(Date),
    })
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(false)

    // Se gana la disputa: la entrega reutiliza la composición vieja guardada, y restaura también el SERVICE_PAY.
    disputes.set(`ch_${id}`, [{ status: 'won' }])
    await expect(reconcileHybridInvoice(f.venueId, f.purchase.id, id)).resolves.toMatchObject({ status: 'ACTIVE' })
    expect(await prisma.capabilityGrant.count({ where: { paymentPeriodId: p2.id, featureCode: 'SERVICE_PAY', revokedAt: null } })).toBe(1)
    // `venueHasServicePayAccess` es exactamente esto desde C2 (Feature SERVICE_PAY); en C1b todavía lee el módulo.
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
  })

  it('dice qué ofertas de plan en venta hay que republicar en superadmin (la publicación no se puede editar)', async () => {
    const vieja = await contratoDePlan('PRO')
    const nueva = await contratoDePlan('PRO', CON_PAGO)
    for (const f of [vieja, nueva])
      await prisma.hybridCampaign.update({
        where: { id: f.campaign.id },
        data: { status: 'ACTIVE', currentPublicationId: f.publication.id },
      })
    // Una oferta de funciones sueltas en venta no lleva SERVICE_PAY por diseño: no se republica.
    const key = `pf3${stamp}${++n}sueltas`
    const terms = {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 199,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    }
    const definition = { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['LOYALTY_PROGRAM'], terms }
    const sueltas = await prisma.hybridCampaign.create({
      data: {
        code: key,
        slug: key,
        name: key,
        draftDefinition: definition,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + DIA * 1000),
        capacity: 5,
        audience: 'ALL',
        createdById: staffId,
      },
    })
    const publicacion = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: sueltas.id,
        version: 1,
        name: key,
        definition,
        definitionHash: 'c'.repeat(64),
        includedFeatureCodes: ['LOYALTY_PROGRAM'],
        createdById: staffId,
      },
    })
    await prisma.hybridCampaign.update({ where: { id: sueltas.id }, data: { status: 'ACTIVE', currentPublicationId: publicacion.id } })

    const { staleCampaigns } = await addServicePayToLivePlanContracts()

    expect(staleCampaigns).toContainEqual({ id: vieja.campaign.id, code: vieja.campaign.code })
    expect(staleCampaigns.map(c => c.id)).not.toContain(nueva.campaign.id)
    expect(staleCampaigns.map(c => c.id)).not.toContain(sueltas.id)
  })
})
