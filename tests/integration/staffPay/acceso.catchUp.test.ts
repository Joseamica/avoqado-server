// tests/integration/staffPay/acceso.catchUp.test.ts
// Pago al personal por plan (fase 3, C1b, ronda 1). El catch-up de SERVICE_PAY en los contratos comerciales:
//   - sólo toca compras COMPLETED: a una compra a medio pagar le cambiaría los contratos y `provisionHybridPurchase`
//     («Reanudar pago») respondería 409 HYBRID_CONTRACT_MISMATCH para siempre (hybridProvision.service.ts:164);
//   - un contrato inconsistente se reporta y se salta: no aborta la corrida de los demás;
//   - (C5-fix) las ofertas por republicar se buscan en TODAS las campañas vivas, por páginas (Codex Bloque C r1-2).
import prisma from '@/utils/prismaClient'

const subscriptions = new Map<string, any>()
jest.mock('@/services/stripe.service', () => ({
  stripe: { subscriptions: { retrieve: jest.fn(async (id: string) => subscriptions.get(id)) } },
  STRIPE_DENTRO_DEL_CANDADO: { timeout: 15000, maxNetworkRetries: 0 },
}))

import { provisionHybridPurchase } from '@/services/launchCampaigns/hybridProvision.service'
import { addServicePayToLivePlanContracts, staleCampaigns } from '@/services/launchCampaigns/hybridPlanCatchUp'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

const DIA = 86400
const ANTES = ['LOYALTY_PROGRAM', 'RESERVATIONS']
const CON_PAGO = ['LOYALTY_PROGRAM', 'RESERVATIONS', 'SERVICE_PAY']
const stamp = `${Date.now()}${process.pid}`
let n = 0
let organizationId: string
let staffId: string

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `pf3c-${stamp}`, email: `pf3c-${stamp}@example.test`, phone: '5550000000' } })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `pf3c-${stamp}@example.test`, firstName: 'Planes', lastName: 'QA' } })).id
})

/** Una compra de plan PRO como la deja `provisionHybridPurchase`: contrato creado y factura inicial ABIERTA, sin pagar. */
async function compraEnCurso() {
  const key = `pf3c${stamp}${++n}`
  const ahora = Math.floor(Date.now() / 1000)
  const venueId = (await prisma.venue.create({ data: { name: key, slug: key, organizationId } })).id
  const terms = {
    currency: 'MXN',
    interval: 'MONTHLY',
    price: 999,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
  }
  const definition = { schemaVersion: 1, kind: 'PLAN', planTier: 'PRO', terms }
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
      includedFeatureCodes: ANTES,
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
    planTier: 'PRO',
    featureCodes: ANTES,
    terms,
  }
  const quote = {
    schemaVersion: 1,
    lines: [line],
    featureCodes: ANTES,
    total: '999.00',
    credit: '0.00',
    dueNow: '999.00',
    sources: [],
    replaces: [],
    effectiveAt: ahora,
  }
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: staffId,
      quote,
      quoteHash: key,
      quoteExpiresAt: new Date(Date.now() + 300000),
      status: 'PAYMENT_PENDING',
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
      featureCodes: ANTES,
      planTier: 'PRO',
      startsAt: new Date(ahora * 1000),
    },
  })
  subscriptions.set(`sub_${key}`, {
    id: `sub_${key}`,
    customer: `cus_${key}`,
    status: 'incomplete',
    metadata: { kind: 'HYBRID_PURCHASE', hybridPurchaseId: purchase.id, venueId, quoteHash: key },
    items: { has_more: false, data: [{ id: `si_${key}`, price: { id: `price_${key}` }, quantity: 1, current_period_start: ahora }] },
    latest_invoice: { id: `in_${key}`, customer: `cus_${key}`, currency: 'mxn', total: 99900, amount_due: 99900, status: 'open' },
  })
  return { key, venueId, purchase, contract, ahora }
}
type Compra = Awaited<ReturnType<typeof compraEnCurso>>

/** Lo que deja la entrega del primer pago: compra COMPLETED, periodo P1 pagado con la composición de antes y sus grants. */
async function completar(f: Compra) {
  const endsAt = new Date((f.ahora + 30 * DIA) * 1000)
  await prisma.hybridPurchase.update({ where: { id: f.purchase.id }, data: { status: 'COMPLETED' } })
  const period = await prisma.hybridPaymentPeriod.create({
    data: {
      venueId: f.venueId,
      stripeSubscriptionId: `sub_${f.key}`,
      stripeInvoiceId: `in_${f.key}`,
      startsAt: f.contract.startsAt,
      endsAt,
      fundedAmount: '999.00',
      composition: [{ contractId: f.contract.id, itemId: `si_${f.key}`, featureCodes: ANTES, priceId: `price_${f.key}`, amount: '999.00' }],
    },
  })
  await prisma.hybridContract.update({ where: { id: f.contract.id }, data: { paidThrough: endsAt } })
  await prisma.capabilityGrant.createMany({
    data: ANTES.map(featureCode => ({
      venueId: f.venueId,
      featureCode,
      sourceId: `${period.id}:${f.contract.id}`,
      contractId: f.contract.id,
      paymentPeriodId: period.id,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
    })),
  })
  return period
}

/** Termina el contrato al final de una prueba que lo dejó raro a propósito, para que las corridas siguientes no lo arrastren. */
const terminar = (f: Compra) => prisma.hybridContract.update({ where: { id: f.contract.id }, data: { endedAt: new Date() } })

describe('C1b ronda 1 — compras en curso y contratos inconsistentes', () => {
  it('una compra a medio pagar no se toca: «Reanudar pago» sigue funcionando y la corrida la cuenta como en curso', async () => {
    const f = await compraEnCurso()

    const r = await addServicePayToLivePlanContracts()

    expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(0)
    expect((await prisma.hybridContract.findUniqueOrThrow({ where: { id: f.contract.id } })).featureCodes).toEqual(ANTES)
    expect(r.inFlightPurchases.find(row => row.status === 'PAYMENT_PENDING')?.purchases).toBeGreaterThanOrEqual(1)
    // Estar en curso no es una anomalía: se cuenta, no se reporta como contrato saltado.
    expect(r.skippedContracts.map(row => row.contractId)).not.toContain(f.contract.id)
    await expect(provisionHybridPurchase(f.venueId, f.purchase.id)).resolves.toMatchObject({ status: 'PAYMENT_PENDING' })
  })

  it('la misma compra, ya COMPLETED, recibe SERVICE_PAY en la siguiente corrida', async () => {
    const f = await compraEnCurso()
    await addServicePayToLivePlanContracts()
    const period = await completar(f)

    await addServicePayToLivePlanContracts()

    expect(await prisma.hybridContractSelection.findFirstOrThrow({ where: { contractId: f.contract.id } })).toMatchObject({
      effectiveAt: period.endsAt,
      featureCodes: CON_PAGO,
    })
    expect(await prisma.capabilityGrant.findFirstOrThrow({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toMatchObject({
      paymentPeriodId: period.id,
      revokedAt: null,
    })
    await expect(venueHasFeatureAccess(f.venueId, 'SERVICE_PAY')).resolves.toBe(true)
  })

  it('si la compra dejara de estar COMPLETED mientras la corrida espera su candado, se salta y se reporta', async () => {
    const f = await compraEnCurso()
    await completar(f)
    const candado = `hybrid-delivery:${f.purchase.id}`
    let soltar!: () => void
    const suelto = new Promise<void>(resolve => (soltar = resolve))
    let tomado!: () => void
    const yaTomado = new Promise<void>(resolve => (tomado = resolve))
    const entrega = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${candado}))::text`
        tomado()
        await suelto
      },
      { timeout: 60000 },
    )
    let corrida: Promise<Awaited<ReturnType<typeof addServicePayToLivePlanContracts>>> | undefined
    try {
      await yaTomado
      let terminada = false
      corrida = addServicePayToLivePlanContracts().finally(() => (terminada = true))
      let esperando = false
      for (let i = 0; i < 600 && !esperando && !terminada; i++) {
        const [{ n: espera }] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
            AND objid::bigint = (hashtext(${candado})::bigint & 4294967295)`
        esperando = espera > 0
        if (!esperando) await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(esperando).toBe(true)
      // La página ya la leyó COMPLETED; antes de que le toque el candado, deja de estarlo. Hoy la base lo impide (el trigger
      // `hybrid_purchase_immutable_quote` hace terminal a COMPLETED): se apaga sólo en ESTA transacción para probar la
      // defensa por si esa regla se relaja algún día.
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`
        await tx.hybridPurchase.update({ where: { id: f.purchase.id }, data: { status: 'PAYMENT_PENDING' } })
      })
      soltar()
      await entrega
      const r = await corrida

      expect(r.skippedContracts).toContainEqual({ contractId: f.contract.id, reason: 'PURCHASE_NOT_COMPLETED:PAYMENT_PENDING' })
      expect(await prisma.hybridContractSelection.count({ where: { contractId: f.contract.id } })).toBe(0)
      expect(await prisma.capabilityGrant.count({ where: { venueId: f.venueId, featureCode: 'SERVICE_PAY' } })).toBe(0)
    } finally {
      soltar()
      await entrega
      await corrida?.catch(() => undefined)
      await terminar(f)
    }
  })

  it('un contrato inconsistente (su selección ya escrita sin sus featureCodes) se reporta y se salta; los demás siguen', async () => {
    // El estado que dejó la mutación M16: la fila del historial en `paidThrough` existe, `featureCodes` no la trae.
    const malo = await compraEnCurso()
    const periodoMalo = await completar(malo)
    await prisma.hybridContractSelection.create({
      data: { contractId: malo.contract.id, effectiveAt: periodoMalo.endsAt, featureCodes: CON_PAGO },
    })
    // Creado después ⇒ id mayor ⇒ la corrida lo recorre DESPUÉS del malo.
    const bueno = await compraEnCurso()
    await completar(bueno)

    try {
      const r = await addServicePayToLivePlanContracts()

      expect(r.skippedContracts).toContainEqual({ contractId: malo.contract.id, reason: 'SELECTION_ALREADY_AT_EFFECTIVE_DATE' })
      expect((await prisma.hybridContract.findUniqueOrThrow({ where: { id: malo.contract.id } })).featureCodes).toEqual(ANTES)
      expect(await prisma.capabilityGrant.count({ where: { venueId: malo.venueId, featureCode: 'SERVICE_PAY' } })).toBe(0)
      expect(await prisma.hybridContractSelection.count({ where: { contractId: bueno.contract.id } })).toBe(1)
      expect(await prisma.capabilityGrant.count({ where: { venueId: bueno.venueId, featureCode: 'SERVICE_PAY', revokedAt: null } })).toBe(1)
    } finally {
      await terminar(malo)
    }
  })
})

/** Campañas en venta (ACTIVE) con su publicación vigente. Con `ids`, en ese lugar del orden por id. */
async function ofertasEnVenta(kind: 'PLAN' | 'FEATURES', incluidas: string[], ids: string[]) {
  const terms = {
    currency: 'MXN',
    interval: 'MONTHLY',
    price: 199,
    taxIncluded: true,
    promotionCycles: null,
    renewal: { kind: 'SAME_PRICE' },
  }
  const definition =
    kind === 'PLAN' ? { schemaVersion: 1, kind, planTier: 'PRO', terms } : { schemaVersion: 1, kind, featureCodes: incluidas, terms }
  const filas = ids.map(id => ({ id, code: `${id}-x`.slice(0, 60), publicationId: `${id}p` }))
  await prisma.hybridCampaign.createMany({
    data: filas.map(f => ({
      id: f.id,
      code: f.code,
      slug: f.code,
      name: f.code,
      draftDefinition: definition,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + DIA * 1000),
      capacity: 5,
      audience: 'ALL',
      createdById: staffId,
      status: 'ACTIVE' as const,
      currentPublicationId: f.publicationId,
    })),
  })
  await prisma.hybridOfferPublication.createMany({
    data: filas.map(f => ({
      id: f.publicationId,
      campaignId: f.id,
      version: 1,
      name: f.code,
      definition,
      definitionHash: 'd'.repeat(64),
      includedFeatureCodes: incluidas,
      createdById: staffId,
    })),
  })
  return filas.map(f => ({ id: f.id, code: f.code }))
}

describe('C5-fix — las ofertas por republicar salen de TODAS las campañas vivas (Codex Bloque C r1-2)', () => {
  it('500 campañas ajenas antes por id no esconden una oferta PRO vieja: se recorren por páginas', async () => {
    // Las ajenas van ANTES que cualquier cuid por id ('c0…' < 'cm…'): son las primeras 500 que se leían. La oferta PRO vieja
    // (sin SERVICE_PAY en su publicación vigente) va DESPUÉS de todas ellas.
    const base = `c0${BigInt(stamp).toString(36)}`
    const ajenas = await ofertasEnVenta(
      'FEATURES',
      ['LOYALTY_PROGRAM'],
      Array.from({ length: 500 }, (_, i) => `${base}${String(i).padStart(4, '0')}`),
    )
    const [vieja] = await ofertasEnVenta('PLAN', ANTES, [`czz${BigInt(stamp).toString(36)}`])
    try {
      const antes = await prisma.hybridCampaign.count({
        where: { status: { in: ['ACTIVE', 'PAUSED'] }, currentPublicationId: { not: null }, id: { lt: vieja.id } },
      })
      expect(antes).toBeGreaterThanOrEqual(500) // el escenario: al menos 500 campañas vivas van antes que la oferta vieja

      // La misma función que `addServicePayToLivePlanContracts` devuelve en `staleCampaigns` (sin recorrer los contratos).
      const porRepublicar = await staleCampaigns()

      expect(porRepublicar).toContainEqual(vieja)
      const ajenasIds = new Set(ajenas.map(a => a.id))
      expect(porRepublicar.filter(c => ajenasIds.has(c.id))).toEqual([]) // las de funciones sueltas no se republican
      expect(new Set(porRepublicar.map(c => c.id)).size).toBe(porRepublicar.length) // las páginas no se enciman: cada una, una vez
    } finally {
      // Las publicaciones no se pueden borrar (trigger) y la campaña no se borra con publicaciones: se terminan.
      await prisma.hybridCampaign.updateMany({ where: { id: { in: [...ajenas, vieja].map(c => c.id) } }, data: { status: 'ENDED' } })
    }
  })
})
