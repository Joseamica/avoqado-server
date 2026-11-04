/**
 * «Duplicar tienda» contra Postgres real (diseño docs/superpowers/specs/2026-11-04-duplicar-tienda-design.md).
 * Corre en la nube con su base propia, como el CI:
 *   cd Avoqado && AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration \
 *     --testPathPattern "venueDuplication.service" --ci
 */
import { randomUUID } from 'crypto'
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import * as notificationService from '@/services/dashboard/notification.service'
import { getVenueBaseTier } from '@/services/access/basePlan.service'
import { getVenueSeatCap } from '@/services/access/seatCap.service'
import { generateSlug } from '@/utils/slugify'
import { duplicateVenue, getVenueDuplicationOptions } from '@/services/organization-dashboard/venueDuplication.service'

const tag = `dup${randomUUID().slice(0, 8)}`
const ORG_A = cuid()
const ORG_B = cuid()
const ORG_C = cuid() // módulo apagado
const DIA = 24 * 60 * 60 * 1000

// Columnas de Venue que se copian (diseño, «Cambios tras Codex r1», punto 3).
const COLUMNAS = [
  'type',
  'currency',
  'timezone',
  'language',
  'country',
  'status',
  'active',
  'kycStatus',
  'operationalRole',
  'posStatus',
  'salesEnabled',
  'whatsappContactMode',
  'feeType',
  'feeValue',
  'planTier',
  'seatCapExempt',
] as const

const s: Record<string, string> = {} // staff
let modeloId = ''
let modeloCId = ''
let venueBId = ''
let merchantId = ''
let permisoAdminId = ''
let featureId = ''
const hibridos: { campaign: string; publication: string; purchase: string; contract: string }[] = []
let n = 0

const plano = (x: unknown) => JSON.parse(JSON.stringify(x))
const LLAVES_DE_REGISTRO = new Set(['id', 'venueId', 'createdAt', 'updatedAt', 'enabledAt'])
const sinLlaves = (fila: Record<string, unknown>, fuera: string[] = []) =>
  plano(Object.fromEntries(Object.entries(fila).filter(([k]) => !LLAVES_DE_REGISTRO.has(k) && !fuera.includes(k))))
const direccion = {
  address: 'Av. Siempre Viva 742',
  city: 'Querétaro',
  state: 'Querétaro',
  zipCode: '76000',
  latitude: 20.5888,
  longitude: -100.3899,
}
const entrada = (extra: Partial<Parameters<typeof duplicateVenue>[0]> = {}) => ({
  orgId: ORG_A,
  actorStaffId: s.owner,
  idempotencyKey: randomUUID(),
  templateVenueId: modeloId,
  name: `TIENDA NUEVA (${9000 + ++n})`,
  address: direccion,
  supervisorStaffId: s.supervisor,
  ...extra,
})
const tiendasDe = (organizationId: string) => prisma.venue.count({ where: { organizationId } })

async function staff(clave: string, organizationId?: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER', isActive = true) {
  s[clave] = (await prisma.staff.create({ data: { email: `${tag}-${clave}@example.test`, firstName: clave, lastName: tag } })).id
  if (organizationId) await prisma.staffOrganization.create({ data: { staffId: s[clave], organizationId, role, isActive } })
}

async function tienda(organizationId: string, name: string, data: Record<string, unknown> = {}) {
  return (await prisma.venue.create({ data: { organizationId, name, slug: `${tag}-${++n}`, status: 'ACTIVE', ...data } })).id
}

/** Contrato híbrido sin `endedAt`, como en tests/integration/staffPay/acceso.feature.test.ts. */
async function contratoVigente(venueId: string, cancelAt: Date | null = null) {
  const key = `${tag}h${++n}`
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
      endsAt: new Date(Date.now() + DIA),
      capacity: 5,
      audience: 'ALL',
      createdById: s.owner,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: key,
      definition,
      definitionHash: 'b'.repeat(64),
      includedFeatureCodes: [],
      createdById: s.owner,
    },
  })
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: s.owner,
      quote: { schemaVersion: 1, lines: [] },
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
      featureCodes: [],
      planTier: 'PRO',
      startsAt: new Date(Date.now() - DIA),
      paidThrough: new Date(Date.now() + 10 * DIA),
      cancelAt,
    },
  })
  hibridos.push({ campaign: campaign.id, publication: publication.id, purchase: purchase.id, contract: contract.id })
}

beforeAll(async () => {
  for (const [id, sufijo] of [
    [ORG_A, 'A'],
    [ORG_B, 'B'],
    [ORG_C, 'C'],
  ])
    await prisma.organization.create({
      data: { id, name: `${tag} ${sufijo}`, email: `${tag}-${sufijo}@example.test`, phone: '5500000000' },
    })

  await staff('owner', ORG_A, 'OWNER')
  await staff('admin', ORG_A, 'ADMIN')
  await staff('adminSinOrg') // ADMIN de la tienda sin StaffOrganization: no se copia
  await staff('manager', ORG_A)
  await staff('waiter', ORG_A)
  await staff('supervisor', ORG_A)
  await staff('supInactivo', ORG_A, 'MEMBER', false)
  await staff('supApagado', ORG_A) // StaffOrganization activo, pero Staff.active=false
  await prisma.staff.update({ where: { id: s.supApagado }, data: { active: false } })
  await staff('supOtraOrg', ORG_B)
  await staff('superadmin')
  await staff('ownerC', ORG_C, 'OWNER')

  const dup = await prisma.module.upsert({
    where: { code: 'VENUE_DUPLICATION' },
    update: {},
    create: { code: 'VENUE_DUPLICATION', name: 'Duplicar tiendas', scope: 'ORGANIZATION_ONLY', defaultConfig: {} },
  })
  await prisma.organizationModule.create({ data: { organizationId: ORG_A, moduleId: dup.id, enabled: true, enabledBy: s.owner } })
  const serial = await prisma.module.upsert({
    where: { code: 'SERIALIZED_INVENTORY' },
    update: {},
    create: { code: 'SERIALIZED_INVENTORY', name: 'Inventario serializado', defaultConfig: {} },
  })

  const angelpay = await prisma.paymentProvider.upsert({
    where: { code: 'ANGELPAY' },
    update: {},
    create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  merchantId = (
    await prisma.merchantAccount.create({ data: { providerId: angelpay.id, externalMerchantId: `${tag}-m`, credentialsEncrypted: {} } })
  ).id

  modeloId = await tienda(ORG_A, 'BAE MISION SAN PEDRO (3952)', {
    type: 'OTHER',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
    language: 'es',
    country: 'MX',
    active: true,
    kycStatus: 'VERIFIED',
    operationalRole: 'STORE',
    posStatus: 'NOT_INTEGRATED',
    salesEnabled: true,
    whatsappContactMode: 'DISABLED',
    feeType: 'PERCENTAGE',
    feeValue: 0.03,
    planTier: null,
    seatCapExempt: true,
    // Lo que NO se copia:
    address: 'Calle modelo 1',
    city: 'San Luis Potosí',
    latitude: 22.1,
    longitude: -100.9,
    phone: '4440000000',
    googleBusinessProfileConnected: true,
    googlePlaceId: `place-${tag}`,
    googleAccessToken: 'tok-acceso',
    googleRefreshToken: 'tok-refresco',
    stripeCustomerId: `cus_${tag}`,
    pendingSeatReconciliation: { pendiente: true },
  })
  await prisma.venueSettings.create({
    data: {
      venueId: modeloId,
      requirePinLogin: false,
      trackPromoterLocation: true,
      promoterLocationStartHour: 9,
      tipSuggestions: [10, 15],
      hiddenSidebarItems: ['/menu'],
      googleReviewLink: 'https://search.google.com/local/writereview?placeid=modelo',
    },
  })
  await prisma.venueModule.create({
    data: { venueId: modeloId, moduleId: serial.id, config: { labels: { item: 'SIM' }, enablePortabilidad: true }, enabledBy: s.owner },
  })
  await prisma.venuePaymentConfig.create({
    data: { venueId: modeloId, primaryAccountId: merchantId, routingRules: { factura: 'primary' } },
  })
  await prisma.venuePricingStructure.create({
    data: {
      venueId: modeloId,
      accountType: 'PRIMARY',
      debitRate: 0.03,
      creditRate: 0.03,
      amexRate: 0.035,
      internationalRate: 0.033,
      fixedFeePerTransaction: 3,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })
  for (const [role, displayName] of [
    ['OWNER', 'Propietario'],
    ['MANAGER', 'Supervisor'],
    ['WAITER', 'Promotor'],
  ] as const)
    await prisma.venueRoleConfig.create({ data: { venueId: modeloId, role, displayName } })
  await prisma.venueRolePermission.create({
    data: { venueId: modeloId, role: 'WAITER', permissions: ['orders:read'], modifiedBy: s.owner },
  })
  permisoAdminId = (
    await prisma.permissionSet.create({
      data: { venueId: modeloId, name: 'Back office', permissions: ['reports:read', 'staff:read'], createdBy: s.owner },
    })
  ).id
  await prisma.staffVenue.createMany({
    data: [
      { staffId: s.owner, venueId: modeloId, role: 'OWNER' },
      { staffId: s.admin, venueId: modeloId, role: 'ADMIN', permissionSetId: permisoAdminId },
      { staffId: s.adminSinOrg, venueId: modeloId, role: 'ADMIN' },
      { staffId: s.manager, venueId: modeloId, role: 'MANAGER' },
      { staffId: s.waiter, venueId: modeloId, role: 'WAITER', pin: '3952' },
    ],
  })
  featureId = (await prisma.feature.create({ data: { code: `${tag}-F`, name: tag, category: 'OPERATIONS', monthlyPrice: 0 } })).id
  await prisma.venueFeature.create({
    data: { venueId: modeloId, featureId, active: false, monthlyPrice: 0, stripeSubscriptionId: `sub_${tag}` }, // inactiva: no bloquea
  })
  const cat = await prisma.menuCategory.create({ data: { venueId: modeloId, name: 'SIMs', slug: `${tag}-cat` } })
  await prisma.product.create({ data: { venueId: modeloId, sku: `${tag}-sku`, name: 'SIM', categoryId: cat.id, price: 100 } })
  await prisma.terminal.create({ data: { venueId: modeloId, name: 'PAX', serialNumber: `AVQD-${tag}`, type: 'TPV_ANDROID' } })
  await prisma.order.create({ data: { venueId: modeloId, orderNumber: `${tag}-o`, subtotal: 100, taxAmount: 0, total: 100 } })

  // El supervisor es MANAGER en otra tienda de A (así sale en las opciones).
  const otraA = await tienda(ORG_A, 'BAE LOMAS (4120)')
  await prisma.staffVenue.create({ data: { staffId: s.supervisor, venueId: otraA, role: 'MANAGER' } })

  venueBId = await tienda(ORG_B, 'TIENDA DE B (7777)')
  await prisma.staffVenue.create({ data: { staffId: s.superadmin, venueId: venueBId, role: 'SUPERADMIN' } })

  modeloCId = await tienda(ORG_C, 'TIENDA DE C (1)')
})

let aviso: jest.SpyInstance
beforeEach(() => {
  aviso = jest.spyOn(notificationService, 'sendNotification').mockResolvedValue(null)
})
afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  const orgs = [ORG_A, ORG_B, ORG_C]
  const venues = (await prisma.venue.findMany({ where: { organizationId: { in: orgs } }, select: { id: true } })).map(v => v.id)
  // La compra COMPLETED es inmutable por trigger (`hybrid_purchase_immutable_quote`): se borra con los triggers
  // apagados sólo en esta transacción, como en tests/integration/staffPay/acceso.catchUp.test.ts.
  if (venues.length)
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.capabilityGrant.deleteMany({ where: { venueId: { in: venues } } })
      await tx.hybridContract.deleteMany({ where: { id: { in: hibridos.map(h => h.contract) } } })
      await tx.hybridPurchase.deleteMany({ where: { id: { in: hibridos.map(h => h.purchase) } } })
      await tx.hybridOfferPublication.deleteMany({ where: { id: { in: hibridos.map(h => h.publication) } } })
      await tx.hybridCampaign.deleteMany({ where: { id: { in: hibridos.map(h => h.campaign) } } })
    })
  if (venues.length) {
    await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.terminal.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  }
  await prisma.activityLog.deleteMany({ where: { organizationId: { in: orgs } } })
  if (featureId) await prisma.feature.deleteMany({ where: { id: featureId } })
  if (merchantId) await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  const staffIds = Object.values(s)
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
  await prisma.$disconnect()
})

describe('duplicateVenue — qué copia', () => {
  let nueva = ''
  let llave = ''

  beforeAll(async () => {
    jest.spyOn(notificationService, 'sendNotification').mockResolvedValue(null)
    const input = entrada({ name: 'BAE VALENTIN AMADOR (2973)' })
    llave = input.idempotencyKey
    nueva = (await duplicateVenue(input)).venueId
    jest.restoreAllMocks()
  })

  it('copia la configuración: columnas permitidas, ajustes, módulo, cobro, tarifa, puestos y permisos', async () => {
    const [m, v] = await Promise.all([modeloId, nueva].map(id => prisma.venue.findUniqueOrThrow({ where: { id } })))
    expect(v.organizationId).toBe(ORG_A)
    expect(v.name).toBe('BAE VALENTIN AMADOR (2973)')
    expect(v.slug).not.toBe(m.slug)
    for (const c of COLUMNAS) expect([c, plano(v[c])]).toEqual([c, plano(m[c])])
    expect(v.status).toBe('ACTIVE')
    expect(v.active).toBe(true)
    expect({ address: v.address, city: v.city, state: v.state, zipCode: v.zipCode }).toEqual({
      address: direccion.address,
      city: direccion.city,
      state: direccion.state,
      zipCode: direccion.zipCode,
    })
    expect(Number(v.latitude)).toBeCloseTo(direccion.latitude, 6)
    expect(Number(v.longitude)).toBeCloseTo(direccion.longitude, 6)
    expect(v.phone).toBeNull() // fuera de la lista: nace en su default

    const settings = await Promise.all([modeloId, nueva].map(venueId => prisma.venueSettings.findUniqueOrThrow({ where: { venueId } })))
    // googleReviewLink es la liga de reseñas del lugar de la modelo: no se copia (abajo).
    expect(sinLlaves(settings[1], ['googleReviewLink'])).toEqual(sinLlaves(settings[0], ['googleReviewLink']))

    const modulos = await Promise.all([modeloId, nueva].map(venueId => prisma.venueModule.findMany({ where: { venueId } })))
    expect(modulos[1].map(f => sinLlaves(f))).toEqual(modulos[0].map(f => sinLlaves(f)))

    const pago = await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId: nueva } })
    expect(pago.primaryAccountId).toBe(merchantId)
    expect(sinLlaves(pago)).toEqual(sinLlaves(await prisma.venuePaymentConfig.findUniqueOrThrow({ where: { venueId: modeloId } })))

    const tarifas = await Promise.all([modeloId, nueva].map(venueId => prisma.venuePricingStructure.findMany({ where: { venueId } })))
    expect(tarifas[1].map(f => sinLlaves(f))).toEqual(tarifas[0].map(f => sinLlaves(f)))

    const orden = { orderBy: { role: 'asc' as const } }
    const puestos = await Promise.all([modeloId, nueva].map(venueId => prisma.venueRoleConfig.findMany({ where: { venueId }, ...orden })))
    expect(puestos[1]).toHaveLength(3)
    expect(puestos[1].map(f => sinLlaves(f))).toEqual(puestos[0].map(f => sinLlaves(f)))

    const permisos = await Promise.all(
      [modeloId, nueva].map(venueId => prisma.venueRolePermission.findMany({ where: { venueId }, ...orden })),
    )
    expect(permisos[1]).toHaveLength(1)
    expect(permisos[1].map(f => sinLlaves(f))).toEqual(permisos[0].map(f => sinLlaves(f)))
  })

  it('no copia conexiones, suscripciones ni comisiones', async () => {
    const v = await prisma.venue.findUniqueOrThrow({ where: { id: nueva } })
    expect(v).toMatchObject({
      googleBusinessProfileConnected: false,
      googlePlaceId: null,
      googleAccessToken: null,
      googleRefreshToken: null,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      pendingSeatReconciliation: null,
    })
    expect(await prisma.venueFeature.count({ where: { venueId: nueva } })).toBe(0)
    expect(await prisma.venueCommission.count({ where: { venueId: nueva } })).toBe(0)
    const ajustes = await prisma.venueSettings.findUniqueOrThrow({ where: { venueId: nueva }, select: { googleReviewLink: true } })
    expect(ajustes.googleReviewLink).toBeNull()
  })

  it('PermissionSet: el ADMIN copiado apunta a un clon propio de la tienda nueva', async () => {
    const fila = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId: s.admin, venueId: nueva } } })
    expect(fila.permissionSetId).not.toBeNull()
    expect(fila.permissionSetId).not.toBe(permisoAdminId)
    const [original, clon] = await Promise.all(
      [permisoAdminId, fila.permissionSetId!].map(id => prisma.permissionSet.findUniqueOrThrow({ where: { id } })),
    )
    expect(clon.venueId).toBe(nueva)
    expect({ name: clon.name, permissions: clon.permissions }).toEqual({ name: original.name, permissions: original.permissions })
  })

  it('gente: OWNER y ADMIN de la organización + el supervisor como MANAGER; nadie más', async () => {
    const filas = await prisma.staffVenue.findMany({ where: { venueId: nueva }, select: { staffId: true, role: true, active: true } })
    expect(filas.map(f => [f.staffId, f.role, f.active]).sort()).toEqual(
      [
        [s.owner, 'OWNER', true],
        [s.admin, 'ADMIN', true],
        [s.supervisor, 'MANAGER', true],
      ].sort(),
    )
  })

  it('no copia operación: productos, terminales ni órdenes', async () => {
    expect(await prisma.product.count({ where: { venueId: nueva } })).toBe(0)
    expect(await prisma.terminal.count({ where: { venueId: nueva } })).toBe(0)
    expect(await prisma.order.count({ where: { venueId: nueva } })).toBe(0)
  })

  it('bitácora: VENUE_DUPLICATED con modelo, organización, llave y actor', async () => {
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'VENUE_DUPLICATED', entityId: nueva } })
    expect(log).toMatchObject({ staffId: s.owner, venueId: nueva, organizationId: ORG_A, entity: 'Venue' })
    expect(log.data).toMatchObject({ templateVenueId: modeloId, organizationId: ORG_A, idempotencyKey: llave })
  })
})

describe('duplicateVenue — mismo plan que la modelo', () => {
  it.each([true, false])('seatCapExempt=%s: mismo tier y mismo tope de usuarios', async exento => {
    const modelo = await tienda(ORG_A, `PLAN ${exento} (${8000 + ++n})`, { seatCapExempt: exento, planTier: null })
    const { venueId } = await duplicateVenue(entrada({ templateVenueId: modelo }))
    expect(await getVenueBaseTier(venueId)).toEqual(await getVenueBaseTier(modelo))
    expect(await getVenueSeatCap(venueId)).toEqual(await getVenueSeatCap(modelo))
    expect(await getVenueSeatCap(venueId)).toEqual(exento ? null : 2)
  })
})

describe('duplicateVenue — rechazos (ninguno crea tienda)', () => {
  async function rechaza(input: ReturnType<typeof entrada>, esperado: Record<string, unknown>, org = ORG_A) {
    const antes = await tiendasDe(org)
    await expect(duplicateVenue(input)).rejects.toMatchObject(esperado)
    expect(await tiendasDe(org)).toBe(antes)
  }

  it('modelo con una VenueFeature activa → TEMPLATE_HAS_PAID_PLAN', async () => {
    const modelo = await tienda(ORG_A, `CON PLAN (${8000 + ++n})`)
    await prisma.venueFeature.create({ data: { venueId: modelo, featureId, active: true, monthlyPrice: 0 } })
    await rechaza(entrada({ templateVenueId: modelo }), {
      code: 'TEMPLATE_HAS_PAID_PLAN',
      message: 'Esta tienda tiene un plan contratado; para duplicarla habla con Avoqado',
    })
  })

  it('modelo con un HybridContract vigente → TEMPLATE_HAS_PAID_PLAN', async () => {
    const modelo = await tienda(ORG_A, `CON CONTRATO (${8000 + ++n})`)
    await contratoVigente(modelo)
    await rechaza(entrada({ templateVenueId: modelo }), { code: 'TEMPLATE_HAS_PAID_PLAN' })
  })

  it('modelo con un HybridContract sin endedAt aunque su cancelAt ya pasó → TEMPLATE_HAS_PAID_PLAN', async () => {
    const modelo = await tienda(ORG_A, `CONTRATO CANCELADO (${8000 + ++n})`)
    await contratoVigente(modelo, new Date(Date.now() - DIA))
    await rechaza(entrada({ templateVenueId: modelo }), { code: 'TEMPLATE_HAS_PAID_PLAN' })
  })

  it('modelo con un CapabilityGrant vivo (sin contrato) → TEMPLATE_HAS_PAID_PLAN', async () => {
    const modelo = await tienda(ORG_A, `CON CONCESION (${8000 + ++n})`)
    await prisma.capabilityGrant.create({
      data: {
        venueId: modelo,
        featureCode: 'SERVICE_PAY',
        sourceId: `${tag}-grant`,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + DIA),
      },
    })
    await rechaza(entrada({ templateVenueId: modelo }), { code: 'TEMPLATE_HAS_PAID_PLAN' })
  })

  it.each([{ status: 'SUSPENDED' }, { status: 'TRIAL' }, { status: 'LIVE_DEMO' }, { status: 'ACTIVE', active: false }])(
    'modelo no activa %o → TEMPLATE_NOT_ACTIVE',
    async estado => {
      const modelo = await tienda(ORG_A, `NO ACTIVA (${8000 + ++n})`, estado)
      await rechaza(entrada({ templateVenueId: modelo }), {
        code: 'TEMPLATE_NOT_ACTIVE',
        message: 'Esa tienda ya no está activa; elige otra',
      })
    },
  )

  it('falla la bitácora → error y la tienda no queda', async () => {
    // El tx real, salvo `activityLog.create`, que truena.
    const atado = (o: any, k: PropertyKey) => (typeof o[k] === 'function' ? o[k].bind(o) : o[k])
    const original = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: any) => Promise<unknown>, opciones?: unknown) =>
      original(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get: (t, k) =>
                k === 'activityLog'
                  ? new Proxy(t.activityLog, {
                      get: (d, m) => (m === 'create' ? () => Promise.reject(new Error('bitácora caída')) : atado(d, m)),
                    })
                  : atado(t, k),
            }),
          ),
        opciones as any,
      )) as any)
    const input = entrada()
    await rechaza(input, { message: 'bitácora caída' })
    expect(await prisma.venue.count({ where: { organizationId: ORG_A, name: input.name } })).toBe(0)
  })

  it('módulo apagado → module_disabled', async () => {
    await rechaza(
      entrada({ orgId: ORG_C, actorStaffId: s.ownerC, templateVenueId: modeloCId }),
      { code: 'module_disabled', statusCode: 403 },
      ORG_C,
    )
  })

  it('modelo de otra organización → NotFound', async () => {
    await rechaza(entrada({ templateVenueId: venueBId }), { statusCode: 404 })
    expect(await tiendasDe(ORG_B)).toBe(1)
  })

  it.each(['supOtraOrg', 'supInactivo', 'supApagado'])('supervisor %s → SUPERVISOR_NOT_IN_ORG', async clave => {
    await rechaza(entrada({ supervisorStaffId: s[clave] }), { code: 'SUPERVISOR_NOT_IN_ORG', statusCode: 400 })
  })

  it('número repetido → VENUE_NAME_TAKEN', async () => {
    await rechaza(entrada({ name: 'BAE X (3952)' }), { code: 'VENUE_NAME_TAKEN', message: 'Ya hay una tienda con el número 3952' })
  })

  it('mismo nombre sin número → «Ya hay una tienda con ese nombre»', async () => {
    await tienda(ORG_A, 'TIENDA SIN NUMERO')
    await rechaza(entrada({ name: '  tienda   sin número ' }), { code: 'VENUE_NAME_TAKEN', message: 'Ya hay una tienda con ese nombre' })
  })
})

describe('duplicateVenue — entradas que no mandan', () => {
  it('llaves de más en address no llegan a la tienda nueva (plan, tarifa, Stripe)', async () => {
    const extra = { ...direccion, planTier: 'PREMIUM', seatCapExempt: false, feeValue: 0.5, stripeCustomerId: `cus_extra_${tag}` }
    const { venueId } = await duplicateVenue(entrada({ address: extra as any }))
    const [m, v] = await Promise.all([modeloId, venueId].map(id => prisma.venue.findUniqueOrThrow({ where: { id } })))
    expect(plano({ planTier: v.planTier, seatCapExempt: v.seatCapExempt, feeValue: v.feeValue })).toEqual(
      plano({ planTier: m.planTier, seatCapExempt: m.seatCapExempt, feeValue: m.feeValue }),
    )
    expect(v.stripeCustomerId).toBeNull()
  })

  it('el slug ya lo tiene una tienda de OTRA organización → crea con otro slug, sin 500', async () => {
    const name = `SLUG TOMADO (${8000 + ++n})`
    const ajena = await prisma.venue.create({ data: { organizationId: ORG_C, name: 'ajena', slug: generateSlug(name) } })
    const { venueId, slug } = await duplicateVenue(entrada({ name }))
    expect(slug).not.toBe(ajena.slug)
    expect(slug.startsWith(ajena.slug)).toBe(true)
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId } })).organizationId).toBe(ORG_A)
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: ajena.id } })).organizationId).toBe(ORG_C)
  })
})

describe('duplicateVenue — reintentos', () => {
  it('doble envío en paralelo con la misma llave → una sola tienda, mismo venueId', async () => {
    const input = entrada()
    const antes = await tiendasDe(ORG_A)
    const [a, b] = await Promise.allSettled([duplicateVenue(input), duplicateVenue(input)])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    if (a.status !== 'fulfilled' || b.status !== 'fulfilled') return
    expect(b.value.venueId).toBe(a.value.venueId)
    expect(await tiendasDe(ORG_A)).toBe(antes + 1)
    expect(aviso.mock.calls.filter(c => c[0].recipientId === s.superadmin)).toHaveLength(1) // el reintento no avisa otra vez
  })

  it('reintento tras renombrar → la misma tienda', async () => {
    const input = entrada()
    const primera = await duplicateVenue(input)
    await prisma.venue.update({ where: { id: primera.venueId }, data: { name: `RENOMBRADA (${8000 + ++n})` } })
    const antes = await tiendasDe(ORG_A)
    const segunda = await duplicateVenue(input)
    expect(segunda.venueId).toBe(primera.venueId)
    expect(await tiendasDe(ORG_A)).toBe(antes)
  })

  it('llave distinta, mismo nombre → VENUE_NAME_TAKEN', async () => {
    const input = entrada()
    await duplicateVenue(input)
    await expect(duplicateVenue({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'VENUE_NAME_TAKEN' })
  })
})

describe('duplicateVenue — aviso a superadmins', () => {
  it('ALERT por IN_APP y EMAIL, una vez por superadmin', async () => {
    const input = entrada()
    const { venueId, name } = await duplicateVenue(input)
    const mios = aviso.mock.calls.filter(c => c[0].recipientId === s.superadmin)
    expect(mios).toHaveLength(1)
    expect(mios[0][0]).toMatchObject({
      type: 'ALERT',
      channels: ['IN_APP', 'EMAIL'],
      title: 'Tienda nueva por duplicado',
      message: `owner ${tag} creó ${name} copiando BAE MISION SAN PEDRO (3952)`,
      entityId: venueId,
    })
  })

  it('un aviso que falla no revierte la tienda', async () => {
    aviso.mockRejectedValue(new Error('correo caído'))
    const { venueId } = await duplicateVenue(entrada())
    expect(await prisma.venue.count({ where: { id: venueId } })).toBe(1)
  })
})

describe('getVenueDuplicationOptions', () => {
  it('módulo apagado → nada', async () => {
    expect(await getVenueDuplicationOptions(ORG_C)).toEqual({ enabled: false, templates: [], supervisors: [] })
  })

  it('tiendas ACTIVE ordenadas y supervisores MANAGER con StaffOrganization activo', async () => {
    const opciones = await getVenueDuplicationOptions(ORG_A)
    expect(opciones.enabled).toBe(true)
    const nombres = opciones.templates.map(t => t.name)
    // Orden por nombre (el de Postgres): «BAE LOMAS» antes que «BAE MISION».
    expect(nombres.indexOf('BAE LOMAS (4120)')).toBeGreaterThanOrEqual(0)
    expect(nombres.indexOf('BAE LOMAS (4120)')).toBeLessThan(nombres.indexOf('BAE MISION SAN PEDRO (3952)'))
    expect(nombres.some(x => x.startsWith('NO ACTIVA'))).toBe(false)
    expect(opciones.templates.every(t => !!t.id)).toBe(true)
    const supIds = opciones.supervisors.map(x => x.staffId)
    expect(supIds).toContain(s.supervisor)
    expect(supIds).toContain(s.manager)
    expect(supIds).not.toContain(s.supInactivo)
    expect(supIds).not.toContain(s.supOtraOrg)
    expect(supIds).not.toContain(s.waiter)
  })
})
