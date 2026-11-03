/**
 * Los 3 públicos de las campañas del CRM (prospectos con consentimiento, clientes y usuarios por rol) contra un Postgres
 * real (fase 2, plan tarea 4). Los de unit no pueden probar lo que sólo contesta la base: que el correo del prospecto es el
 * de QUIEN MARCÓ la casilla, que el plan de un cliente sale de la MISMA regla que «Clientes» (un contrato comercial cuenta
 * aunque no haya fila de plan), que un correo repetido entre públicos y entre lotes sale UNA vez y que una baja que llega a
 * media campaña ya no sale en el lote siguiente.
 *
 * La base puede traer datos de otras suites. Lo de clientes y usuarios se acota con una ciudad que sólo existe aquí (cada
 * prueba que cuenta exacto lleva la suya) y lo de prospectos se lee por el sufijo del correo.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/audiencias.integration.test.ts --ci
 */
import { StaffRole, VenueStatus } from '@prisma/client'
import type { Audiencia } from '@/schemas/crm.schema'
import { contarAudiencia, recorrerAudiencia, type Destinatario } from '@/services/crm/email/audience.service'
import { ensureCrmTeamVenue } from '@/services/crm/teamVenue.service'
import prisma from '@/utils/prismaClient'

const suffix = `aud${Date.now()}`
const CIUDAD = `Ciudad ${suffix}`
const correo = (alias: string) => `${alias}-${suffix}@test.mx`

const stageIds: string[] = []
const accountIds: string[] = []
const organizationIds: string[] = []
const venueIds: string[] = []
/** Los negocios con un contrato comercial: Postgres no deja borrarlos (publicaciones inmutables), sólo apagarlos. */
const hybridContractIds: string[] = []
let abiertaId: string
let ganadaId: string
let perdidaId: string
let vendedor: { id: string }
let planProId: string
let planPremiumId: string
let n = 0

/** Recorre una audiencia y junta los lotes tal como los recibe quien manda. */
async function recorrer(aud: Audiencia) {
  const lotes: Destinatario[][] = []
  const total = await recorrerAudiencia(aud, async lote => {
    lotes.push(lote)
  })
  return { lotes, filas: lotes.flat(), total }
}
const correos = (filas: Destinatario[]) => filas.map(d => d.email).sort()
/** Los prospectos de ESTA prueba (la base puede traer consentimientos de otras suites): los que empiezan con `prefijos`. */
const prospectosDe = async (prefijos: RegExp, etapas?: string[]) =>
  correos((await recorrer({ segmentos: [{ tipo: 'PROSPECTOS', etapas }] })).filas).filter(c => prefijos.test(c))

const clientes = (extra: { giros?: string[]; planes?: Array<'GRATIS' | 'PRO' | 'PREMIUM'> } = {}, ciudad = CIUDAD): Audiencia => ({
  segmentos: [{ tipo: 'CLIENTES', ciudades: [ciudad], ...extra }],
})
const usuarios = (roles: StaffRole[], extra: { giros?: string[]; soloClientes?: boolean } = {}, ciudad = CIUDAD): Audiencia => ({
  segmentos: [{ tipo: 'USUARIOS', roles, ciudades: [ciudad], ...extra }],
})

async function organizacion(over: { email?: string } = {}) {
  const key = `${suffix}${++n}`
  const { id } = await prisma.organization.create({
    data: { name: `Org ${key}`, email: over.email ?? `org-${key}@test.mx`, phone: '5555555555' },
  })
  organizationIds.push(id)
  return id
}

async function venue(
  organizationId: string,
  over: {
    name?: string
    email?: string | null
    city?: string
    status?: VenueStatus
    demoExpiresAt?: Date
    type?: 'RESTAURANT' | 'BAR'
  } = {},
) {
  const key = `${suffix}${++n}`
  const { id } = await prisma.venue.create({
    data: {
      organizationId,
      name: over.name ?? `Negocio ${key}`,
      slug: `v-${key}`,
      city: over.city ?? CIUDAD,
      status: over.status ?? VenueStatus.ACTIVE,
      email: over.email === undefined ? null : over.email,
      demoExpiresAt: over.demoExpiresAt,
      type: over.type,
    },
  })
  venueIds.push(id)
  return id
}

async function persona(email: string, over: { firstName?: string; lastName?: string; active?: boolean; emailVerified?: boolean } = {}) {
  return prisma.staff.create({
    data: {
      email,
      firstName: over.firstName ?? 'Persona',
      lastName: over.lastName ?? 'Audiencias',
      active: over.active ?? true,
      emailVerified: over.emailVerified ?? true,
    },
    select: { id: true },
  })
}

const enVenue = (staffId: string, venueId: string, role: StaffRole, active = true) =>
  prisma.staffVenue.create({ data: { staffId, venueId, role, active } })

/** Un plan de pago vigente, como lo deja Stripe: activo, sin suspender y sin fecha de prueba. */
async function planPagado(venueId: string, plan: 'PRO' | 'PREMIUM', over: { suspendedAt?: Date; endDate?: Date } = {}) {
  await prisma.venueFeature.create({
    data: { venueId, featureId: plan === 'PRO' ? planProId : planPremiumId, monthlyPrice: 999, active: true, ...over },
  })
}

/** «Ganado» en el CRM: hace cliente a una organización sin plan ni cobros (GRATIS). */
async function ganada(organizationId: string, over: { ownerStaffId?: string } = {}) {
  const { id } = await prisma.crmAccount.create({
    data: { name: `Cuenta ${suffix}${++n}`, source: 'MANUAL', stageId: ganadaId, organizationId, ownerStaffId: over.ownerStaffId },
  })
  accountIds.push(id)
  return id
}

/** Un contrato comercial vigente y NINGUNA fila de plan: la misma forma que el arnés de tarjetas de regalo. */
async function contratoComercial(venueId: string, planTier: 'PRO' | 'PREMIUM') {
  const key = `aud${suffix}${++n}`
  const funciones = ['LOYALTY_PROGRAM', 'RESERVATIONS']
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
      endsAt: new Date(Date.now() + 86_400_000),
      capacity: 5,
      audience: 'ALL',
      createdById: vendedor.id,
    },
  })
  const publication = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      name: key,
      definition,
      definitionHash: 'b'.repeat(64),
      includedFeatureCodes: funciones,
      createdById: vendedor.id,
      stripePriceId: `price_${key}`,
      stripeProductId: `prod_${key}`,
    },
  })
  const inicio = Math.floor(Date.now() / 1000) - 20 * 86_400
  const line = {
    publicationId: publication.id,
    name: key,
    definitionHash: 'b'.repeat(64),
    kind: 'PLAN',
    planTier,
    featureCodes: funciones,
    terms,
  }
  const quote = {
    schemaVersion: 1,
    lines: [line],
    featureCodes: funciones,
    total: '999.00',
    credit: '0.00',
    dueNow: '999.00',
    sources: [],
    replaces: [],
    effectiveAt: inicio,
  }
  const purchase = await prisma.hybridPurchase.create({
    data: {
      venueId,
      quotedById: vendedor.id,
      quote,
      quoteHash: key,
      quoteExpiresAt: new Date(Date.now() + 300_000),
      status: 'COMPLETED',
      stripeCustomerId: `cus_${key}`,
      stripeSubscriptionId: `sub_${key}`,
      initialInvoiceId: `in_${key}`,
    },
  })
  const { id } = await prisma.hybridContract.create({
    data: {
      venueId,
      purchaseId: purchase.id,
      publicationId: publication.id,
      stripeSubscriptionId: `sub_${key}`,
      stripeItemId: `si_${key}`,
      featureCodes: funciones,
      planTier,
      startsAt: new Date(inicio * 1000),
      paidThrough: new Date(Date.now() + 10 * 86_400_000),
    },
  })
  hybridContractIds.push(id)
}

/** Un consentimiento de la landing: la persona que marcó la casilla, con o sin cuenta del CRM. */
async function consentimiento(email: string, accountId?: string) {
  await prisma.crmEmailConsent.create({
    data: { email, accountId, entryId: `centry${suffix}${++n}`, consentAt: new Date(), source: 'LANDING', noticeVersion: 'v1' },
  })
}

async function cuenta(over: { name?: string; stageId?: string; ownerStaffId?: string; archivedAt?: Date } = {}) {
  const { id } = await prisma.crmAccount.create({
    data: {
      name: over.name ?? `Prospecto ${suffix}${++n}`,
      source: 'MANUAL',
      stageId: over.stageId ?? abiertaId,
      ownerStaffId: over.ownerStaffId,
      archivedAt: over.archivedAt,
    },
  })
  accountIds.push(id)
  return id
}

const contacto = (accountId: string, name: string, email: string | null, isPrimary: boolean) =>
  prisma.crmContact.create({ data: { accountId, name, email, isPrimary } })

describe('Públicos de las campañas del CRM contra Postgres', () => {
  beforeAll(async () => {
    vendedor = await persona(correo('vendedor'), { firstName: 'Rafa', lastName: 'Vendedor' })
    for (const [kind, label] of [
      ['ABIERTA', 'abierta'],
      ['GANADA', 'ganada'],
      ['PERDIDA', 'perdida'],
    ] as const) {
      const { id } = await prisma.crmStage.create({ data: { name: `Etapa ${label} ${suffix}`, order: 900 + stageIds.length, kind } })
      stageIds.push(id)
    }
    ;[abiertaId, ganadaId, perdidaId] = stageIds
    planProId = (
      await prisma.feature.upsert({
        where: { code: 'PLAN_PRO' },
        update: {},
        create: { code: 'PLAN_PRO', name: 'Plan Pro', category: 'OPERATIONS', monthlyPrice: 999 },
      })
    ).id
    planPremiumId = (
      await prisma.feature.upsert({
        where: { code: 'PLAN_PREMIUM' },
        update: {},
        create: { code: 'PLAN_PREMIUM', name: 'Plan Premium', category: 'OPERATIONS', monthlyPrice: 1699 },
      })
    ).id
  })

  afterAll(async () => {
    // Todo borrado va por ids o por el sufijo de ESTE archivo: un `where` con un valor undefined vaciaría la tabla.
    // Un contrato comercial no deja borrar su negocio; se apaga para que no cuente como cliente en la base compartida.
    if (hybridContractIds.length) {
      await prisma.hybridContract.updateMany({ where: { id: { in: hybridContractIds } }, data: { endedAt: new Date() } })
    }
    await prisma.crmEmailOptOut.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.emailSuppression.deleteMany({ where: { email: { contains: suffix } } })
    await prisma.crmEmailConsent.deleteMany({ where: { email: { contains: suffix } } })
    if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
    if (stageIds.length) await prisma.crmStage.deleteMany({ where: { id: { in: stageIds } } })
    await prisma.staff.deleteMany({ where: { email: { contains: suffix } } })
    if (venueIds.length) await prisma.venue.deleteMany({ where: { id: { in: venueIds }, hybridContracts: { none: {} } } })
    if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds }, venues: { none: {} } } })
  })

  // ── Prospectos ────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('prospectos', () => {
    it('un_prospecto_sin_consentimiento_no_sale_ni_con_la_marca_vieja_de_la_cuenta', async () => {
      const sin = await cuenta()
      await contacto(sin, 'Sin Casilla', correo('sin-casilla'), true)
      // La marca vieja de la cuenta ya no es la verdad: sólo cuenta una fila de consentimiento.
      const vieja = await cuenta()
      await contacto(vieja, 'Marca Vieja', correo('marca-vieja'), true)
      await prisma.crmAccount.update({
        where: { id: vieja },
        data: { consentMarketing: true, consentAt: new Date(), consentSource: 'LANDING' },
      })
      // Control: con su casilla sí sale, así que la prueba no está vacía.
      await consentimiento(correo('sin-marca-pero-con-casilla'), sin)

      const salen = await prospectosDe(/^(sin-casilla|marca-vieja|sin-marca)/)

      expect(salen).toEqual([correo('sin-marca-pero-con-casilla')])
    })

    it('con_consentimiento_sale_el_correo_de_quien_marco_la_casilla_no_el_del_contacto_principal', async () => {
      const dueno = await persona(correo('dueno-crm'), { firstName: 'Lupe', lastName: 'Ventas' })
      const id = await cuenta({ name: 'Cafetería La Esquina', ownerStaffId: dueno.id })
      await contacto(id, 'Carlos Principal', correo('carlos-principal'), true)
      await contacto(id, 'Elena Socia', correo('elena-socia'), false)
      // Quien marcó la casilla es Elena (que además es un contacto) y alguien más que no tiene contacto.
      await consentimiento(correo('elena-socia'), id)
      await consentimiento(correo('otra-persona'), id)

      const { filas } = await recorrer({ segmentos: [{ tipo: 'PROSPECTOS' }] })

      const mios = filas.filter(d => /^(elena-socia|otra-persona|carlos-principal)/.test(d.email))
      expect(correos(mios)).toEqual([correo('elena-socia'), correo('otra-persona')])
      // Elena: el contacto de la cuenta con ESE correo. La otra persona no tiene contacto: cae en el principal.
      expect(mios.find(d => d.email === correo('elena-socia'))).toMatchObject({
        reason: 'PROSPECTO',
        name: 'Elena Socia',
        accountId: id,
        vars: { nombre: 'Elena Socia', negocio: 'Cafetería La Esquina', vendedor: 'Lupe Ventas' },
      })
      expect(mios.find(d => d.email === correo('otra-persona'))).toMatchObject({ name: 'Carlos Principal', accountId: id })
    })

    it('sale_Brenda_que_marco_la_casilla_y_no_Ana_que_comparte_su_telefono', async () => {
      const id = await cuenta({ name: 'Salón Ana' })
      await prisma.crmContact.create({
        data: { accountId: id, name: 'Ana', email: correo('ana'), phoneE164: '+525512345678', isPrimary: true },
      })
      await consentimiento(correo('brenda'), id)

      expect(await prospectosDe(/^(ana|brenda)-/)).toEqual([correo('brenda')])
    })

    it('la_etapa_abierta_es_la_de_siempre_las_archivadas_no_salen_y_sin_cuenta_solo_sin_pedir_etapa', async () => {
      const abierta = await cuenta()
      const perdida = await cuenta({ stageId: perdidaId })
      const archivada = await cuenta({ archivedAt: new Date() })
      await consentimiento(correo('en-abierta'), abierta)
      await consentimiento(correo('en-perdida'), perdida)
      await consentimiento(correo('en-archivada'), archivada)
      await consentimiento(correo('sin-cuenta'))
      const mios = /^(en-|sin-cuenta)/

      expect(await prospectosDe(mios)).toEqual([correo('en-abierta'), correo('sin-cuenta')])
      // Pedir una etapa: sólo esa (aunque sea «Perdida»), nunca una cuenta archivada ni un consentimiento sin cuenta.
      expect(await prospectosDe(mios, [perdidaId])).toEqual([correo('en-perdida')])
      expect(await prospectosDe(mios, [perdidaId, abiertaId])).toEqual([correo('en-abierta'), correo('en-perdida')])
    })
  })

  // ── Clientes ──────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('clientes', () => {
    it('un_contrato_comercial_PREMIUM_sin_fila_de_plan_sale_como_PREMIUM_y_no_como_GRATIS', async () => {
      const ciudad = `Contrato ${suffix}`
      const v = await venue(await organizacion(), { name: 'Contrato', email: correo('contrato'), city: ciudad })
      await contratoComercial(v, 'PREMIUM')

      const premium = await recorrer(clientes({ planes: ['PREMIUM'] }, ciudad))
      const gratis = await recorrer(clientes({ planes: ['GRATIS'] }, ciudad))
      const pro = await recorrer(clientes({ planes: ['PRO'] }, ciudad))

      expect(correos(premium.filas)).toEqual([correo('contrato')])
      expect(premium.filas[0]).toMatchObject({ reason: 'CLIENTE', vars: { negocio: 'Contrato' } })
      expect(gratis.filas).toEqual([])
      expect(pro.filas).toEqual([])
    })

    it('planes_GRATIS_excluye_a_los_que_pagan_y_cuenta_un_plan_suspendido_o_en_prueba_como_GRATIS', async () => {
      const ciudad = `Planes ${suffix}`
      const conPro = await venue(await organizacion(), { email: correo('pro'), city: ciudad })
      await planPagado(conPro, 'PRO')
      const conPremium = await venue(await organizacion(), { email: correo('premium'), city: ciudad })
      await planPagado(conPremium, 'PREMIUM')
      const soloGanado = await organizacion()
      await venue(soloGanado, { email: correo('gratis'), city: ciudad })
      await ganada(soloGanado)
      // Su plan está suspendido: hoy no paga nada, así que es GRATIS (y es cliente por la cuenta ganada).
      const suspendido = await organizacion()
      await planPagado(await venue(suspendido, { email: correo('suspendido'), city: ciudad }), 'PRO', { suspendedAt: new Date() })
      await ganada(suspendido)
      // En prueba (tiene fecha de fin): tampoco paga todavía.
      const enPrueba = await organizacion()
      await planPagado(await venue(enPrueba, { email: correo('prueba'), city: ciudad }), 'PRO', {
        endDate: new Date(Date.now() + 86_400_000),
      })
      await ganada(enPrueba)

      const de = async (planes?: Array<'GRATIS' | 'PRO' | 'PREMIUM'>) => correos((await recorrer(clientes({ planes }, ciudad))).filas)
      expect(await de(['GRATIS'])).toEqual([correo('gratis'), correo('prueba'), correo('suspendido')])
      expect(await de(['PRO'])).toEqual([correo('pro')])
      expect(await de(['PREMIUM'])).toEqual([correo('premium')])
      expect(await de(['PRO', 'GRATIS'])).toEqual([correo('gratis'), correo('pro'), correo('prueba'), correo('suspendido')])
      // Sin filtro de plan salen todos los clientes de la ciudad.
      expect(await de()).toEqual([correo('gratis'), correo('premium'), correo('pro'), correo('prueba'), correo('suspendido')])
    })

    it('el_correo_del_cliente_sigue_la_cadena_del_negocio_el_dueno_el_admin_y_la_organizacion', async () => {
      const ciudad = `Cadena ${suffix}`
      const dueno = await persona(correo('o2'), { firstName: 'Olga' })
      const admin = await persona(correo('a2'), { firstName: 'Abel' })
      const soloAdmin = await persona(correo('a3'), { firstName: 'Ariel' })
      const exDueno = await persona(correo('x3'), { firstName: 'Ex' })
      const rafa = await persona(correo('rafa'), { firstName: 'Rafa', lastName: 'Closer' })

      // 1) El correo del negocio manda sobre todo, y el vendedor es el dueño de la cuenta del CRM ligada.
      const org1 = await organizacion()
      const v1 = await venue(org1, { name: 'Uno', email: correo('v1'), city: ciudad })
      await planPagado(v1, 'PRO')
      await enVenue(dueno.id, v1, StaffRole.OWNER)
      await ganada(org1, { ownerStaffId: rafa.id })
      // 2) Sin correo del negocio: el dueño activo, aunque haya un admin.
      const v2 = await venue(await organizacion(), { name: 'Dos', email: null, city: ciudad })
      await planPagado(v2, 'PRO')
      await enVenue(admin.id, v2, StaffRole.ADMIN)
      await enVenue(dueno.id, v2, StaffRole.OWNER)
      // 3) Sin dueño activo: un admin activo (el dueño dado de baja de ese negocio no cuenta). Un correo en blanco es «sin correo».
      const v3 = await venue(await organizacion(), { name: 'Tres', email: '   ', city: ciudad })
      await planPagado(v3, 'PRO')
      await enVenue(soloAdmin.id, v3, StaffRole.ADMIN)
      await enVenue(exDueno.id, v3, StaffRole.OWNER, false)
      // 4) Nadie: el correo de la organización.
      const v4 = await venue(await organizacion({ email: correo('org4') }), { name: 'Cuatro', email: null, city: ciudad })
      await planPagado(v4, 'PRO')

      const { filas } = await recorrer(clientes({}, ciudad))
      const por = (email: string) => filas.find(d => d.email === email)

      expect(correos(filas)).toEqual([correo('a3'), correo('o2'), correo('org4'), correo('v1')])
      // `vendedor` es el dueño de la cuenta del CRM ligada; el nombre es el de la persona sólo si su correo es el elegido.
      expect(por(correo('v1'))).toMatchObject({ reason: 'CLIENTE', vars: { negocio: 'Uno', vendedor: 'Rafa Closer' } })
      expect(por(correo('v1'))?.name).toBeUndefined()
      expect(por(correo('o2'))).toMatchObject({ name: 'Olga', vars: { nombre: 'Olga', negocio: 'Dos' } })
      expect(por(correo('o2'))?.vars.vendedor).toBeUndefined()
      expect(por(correo('a3'))).toMatchObject({ name: 'Ariel' })
      expect(por(correo('org4'))?.name).toBeUndefined()
    })

    it('solo_los_negocios_reales_con_el_giro_y_la_ciudad_pedidos_y_un_negocio_de_demo_no_cuenta', async () => {
      const ciudad = `Giros ${suffix}`
      const org = await organizacion()
      await venue(org, { name: 'Real bar', email: correo('real-bar'), type: 'BAR', city: ciudad })
      await venue(org, { name: 'Real restaurante', email: correo('real-rest'), type: 'RESTAURANT', city: ciudad })
      await venue(org, { name: 'Demo', email: correo('demo'), status: VenueStatus.LIVE_DEMO, city: ciudad })
      await venue(org, {
        name: 'Con fecha de demo',
        email: correo('fecha-demo'),
        demoExpiresAt: new Date(Date.now() + 86_400_000),
        city: ciudad,
      })
      await venue(org, { name: 'Otra ciudad', email: correo('otra-ciudad'), city: 'Otra' })
      await ganada(org)

      const de = async (extra: { giros?: string[] } = {}, ciudades = [ciudad]) =>
        correos((await recorrer({ segmentos: [{ tipo: 'CLIENTES', ciudades, ...extra }] })).filas)

      // Un negocio de demo no sale aunque su organización sea cliente.
      expect(await de()).toEqual([correo('real-bar'), correo('real-rest')])
      expect(await de({ giros: ['BAR'] })).toEqual([correo('real-bar')])
      expect(await de({ giros: ['bar', ' RESTAURANT '] })).toEqual([correo('real-bar'), correo('real-rest')])
      // La ciudad se compara sin importar mayúsculas ni espacios de más.
      expect(await de({ giros: ['BAR'] }, [`  ${ciudad.toUpperCase()} `])).toEqual([correo('real-bar')])
      expect(await de({}, ['Otra'])).toContain(correo('otra-ciudad'))
    })
  })

  // ── Usuarios ──────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('usuarios', () => {
    it('solo_personas_activas_y_verificadas_con_el_rol_pedido_en_un_negocio_real_y_el_primero_por_nombre', async () => {
      const ciudad = `Roles ${suffix}`
      const org = await organizacion()
      const a = await venue(org, { name: 'A primero', city: ciudad })
      const b = await venue(org, { name: 'B segundo', city: ciudad })
      const demo = await venue(org, { name: 'Demo', status: VenueStatus.TRIAL, city: ciudad })
      const multi = await persona(correo('multi'), { firstName: 'Multi' })
      await enVenue(multi.id, b, StaffRole.MANAGER)
      await enVenue(multi.id, a, StaffRole.MANAGER)
      const cajera = await persona(correo('cajera'))
      await enVenue(cajera.id, a, StaffRole.CASHIER)
      const inactiva = await persona(correo('inactiva'), { active: false })
      await enVenue(inactiva.id, a, StaffRole.MANAGER)
      const sinVerificar = await persona(correo('sin-verificar'), { emailVerified: false })
      await enVenue(sinVerificar.id, a, StaffRole.MANAGER)
      const dadaDeBaja = await persona(correo('dada-de-baja'))
      await enVenue(dadaDeBaja.id, a, StaffRole.MANAGER, false)
      const soloDemo = await persona(correo('solo-demo'))
      await enVenue(soloDemo.id, demo, StaffRole.MANAGER)

      const { filas } = await recorrer(usuarios([StaffRole.MANAGER], {}, ciudad))

      expect(correos(filas)).toEqual([correo('multi')])
      expect(filas[0]).toMatchObject({
        reason: 'USUARIO',
        name: 'Multi',
        reasonVenueName: 'A primero',
        vars: { nombre: 'Multi', negocio: 'A primero', vendedor: 'el equipo de Avoqado' },
      })
      expect(correos((await recorrer(usuarios([StaffRole.MANAGER, StaffRole.CASHIER], {}, ciudad))).filas)).toEqual([
        correo('cajera'),
        correo('multi'),
      ])
    })

    it('soloClientes_deja_los_negocios_de_organizaciones_que_ya_son_clientes', async () => {
      const ciudad = `Solo clientes ${suffix}`
      const vCliente = await venue(await organizacion(), { name: 'Cliente', city: ciudad })
      await planPagado(vCliente, 'PRO')
      const vProspecto = await venue(await organizacion(), { name: 'Todavía no', city: ciudad })
      const deCliente = await persona(correo('de-cliente'))
      await enVenue(deCliente.id, vCliente, StaffRole.WAITER)
      const deProspecto = await persona(correo('de-prospecto'))
      await enVenue(deProspecto.id, vProspecto, StaffRole.WAITER)

      expect(correos((await recorrer(usuarios([StaffRole.WAITER], {}, ciudad))).filas)).toEqual([
        correo('de-cliente'),
        correo('de-prospecto'),
      ])
      expect(correos((await recorrer(usuarios([StaffRole.WAITER], { soloClientes: true }, ciudad))).filas)).toEqual([correo('de-cliente')])
    })

    it('el_negocio_del_equipo_de_ventas_y_un_cliente_oculto_no_salen_en_ninguno_de_los_dos_publicos', async () => {
      const ciudad = `Equipo ${suffix}`
      const equipo = await ensureCrmTeamVenue()
      // Un negocio MÁS de la organización del equipo, con plan: sin la exclusión sería cliente y su gente, usuarios.
      const vEquipo = await venue(equipo.organizationId, { name: 'Del equipo', email: correo('equipo-negocio'), city: ciudad })
      await planPagado(vEquipo, 'PRO')
      await enVenue((await persona(correo('vendedora'))).id, vEquipo, StaffRole.VIEWER)

      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      const vOculta = await venue(oculta, { name: 'Oculto', email: correo('oculto-negocio'), city: ciudad })
      await planPagado(vOculta, 'PRO')
      await enVenue((await persona(correo('de-oculta'))).id, vOculta, StaffRole.VIEWER)

      // Control: un cliente normal con su gente SÍ sale, así que el filtro por ciudad no está vacío.
      const vNormal = await venue(await organizacion(), { name: 'Normal', email: correo('normal-negocio'), city: ciudad })
      await planPagado(vNormal, 'PRO')
      await enVenue((await persona(correo('de-normal'))).id, vNormal, StaffRole.VIEWER)

      const { filas } = await recorrer({
        segmentos: [
          { tipo: 'CLIENTES', ciudades: [ciudad] },
          { tipo: 'USUARIOS', roles: [StaffRole.VIEWER], ciudades: [ciudad] },
        ],
      })

      expect(correos(filas)).toEqual([correo('de-normal'), correo('normal-negocio')])
    })
  })

  // ── Mezcla de públicos, bajas y lotes ─────────────────────────────────────────────────────────────────────────────

  describe('juntos por correo, sin bloqueados y en lotes', () => {
    it('quien_es_dueno_en_3_negocios_y_ademas_correo_de_cliente_sale_una_vez_como_CLIENTE', async () => {
      const ciudad = `Dueno ${suffix}`
      const org = await organizacion()
      const v1 = await venue(org, { name: 'C uno', email: correo('multi-dueno'), city: ciudad })
      const v2 = await venue(org, { name: 'B dos', city: ciudad })
      const v3 = await venue(org, { name: 'A tres', city: ciudad })
      for (const v of [v1, v2, v3]) await planPagado(v, 'PRO')
      const multi = await persona(correo('multi-dueno'), { firstName: 'Mónica' })
      for (const v of [v1, v2, v3]) await enVenue(multi.id, v, StaffRole.OWNER)

      const ambos = await recorrer({
        segmentos: [
          { tipo: 'USUARIOS', roles: [StaffRole.OWNER], ciudades: [ciudad] },
          { tipo: 'CLIENTES', ciudades: [ciudad] },
        ],
      })
      expect(ambos.filas).toHaveLength(1)
      expect(ambos.filas[0]).toMatchObject({ email: correo('multi-dueno'), reason: 'CLIENTE' })

      // Sólo como usuarios: una vez también, con el primer negocio por nombre.
      const usuario = (await recorrer(usuarios([StaffRole.OWNER], {}, ciudad))).filas
      expect(usuario).toHaveLength(1)
      expect(usuario[0]).toMatchObject({ reason: 'USUARIO', reasonVenueName: 'A tres' })

      // Y el mismo correo en mayúsculas es la misma persona: sale una vez.
      const alias = await persona(`Mayusculas-${suffix}@Test.mx`)
      await enVenue(alias.id, v1, StaffRole.OWNER)
      const igual = await persona(`mayusculas-${suffix}@test.mx`)
      await enVenue(igual.id, v2, StaffRole.OWNER)
      const mayus = (await recorrer(usuarios([StaffRole.OWNER], {}, ciudad))).filas.filter(d => d.email.startsWith('mayusculas-'))
      expect(mayus).toHaveLength(1)
    })

    it('una_baja_y_un_rebote_no_salen_y_se_cuentan_en_bloqueados', async () => {
      const ciudad = `Bajas ${suffix}`
      const v = await venue(await organizacion(), { name: 'Con bajas', city: ciudad })
      for (const alias of ['bien', 'baja', 'rebote', 'queja']) await enVenue((await persona(correo(alias))).id, v, StaffRole.CASHIER)
      // La baja se guardó en minúsculas; la persona está en Staff con mayúsculas: es la misma dirección.
      await enVenue((await persona(`Mixto-${suffix}@Test.mx`)).id, v, StaffRole.CASHIER)
      await prisma.crmEmailOptOut.createMany({
        data: [
          { email: correo('baja'), source: 'UN_CLIC' },
          { email: `mixto-${suffix}@test.mx`, source: 'ADMIN' },
        ],
      })
      await prisma.emailSuppression.createMany({
        data: [
          { email: correo('rebote'), reason: 'HARD_BOUNCE' },
          { email: correo('queja'), reason: 'COMPLAINT' },
        ],
      })

      const aud = usuarios([StaffRole.CASHIER], {}, ciudad)
      const { filas, total } = await recorrer(aud)
      const conteo = await contarAudiencia(aud)

      expect(correos(filas)).toEqual([correo('bien')])
      expect(total).toBe(1)
      expect(conteo).toEqual({ total: 1, porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 1 }, bloqueados: 4 })
    })

    it('una_baja_que_llega_a_media_campana_ya_no_sale_en_el_lote_siguiente', async () => {
      const ciudad = `Media ${suffix}`
      const v = await venue(await organizacion(), { name: 'Media campaña', city: ciudad })
      const emails = Array.from({ length: 1_300 }, (_, i) => `zmed${String(i).padStart(4, '0')}-${suffix}@test.mx`)
      await prisma.staff.createMany({
        data: emails.map(email => ({ email, firstName: 'Media', lastName: 'Campaña', emailVerified: true })),
      })
      const personas = await prisma.staff.findMany({
        where: { email: { startsWith: 'zmed', endsWith: `${suffix}@test.mx` } },
        select: { id: true },
        take: 2_000,
      })
      await prisma.staffVenue.createMany({ data: personas.map(p => ({ staffId: p.id, venueId: v, role: StaffRole.HOST })) })

      const lotes: Destinatario[][] = []
      const tardia = emails[1_200]
      const total = await recorrerAudiencia(usuarios([StaffRole.HOST], {}, ciudad), async lote => {
        lotes.push(lote)
        // Entre el primer lote y el segundo, alguien pide la baja con la liga de un clic.
        if (lotes.length === 1) await prisma.crmEmailOptOut.create({ data: { email: tardia, source: 'UN_CLIC' } })
      })

      expect(lotes.map(l => l.length)).toEqual([1_000, 299])
      expect(total).toBe(1_299)
      expect(lotes.flat().map(d => d.email)).not.toContain(tardia)
    })

    it('2500_usuarios_se_recorren_en_3_lotes_ordenados_sin_repetir_con_el_total_exacto', async () => {
      const ciudad = `Grande ${suffix}`
      const v = await venue(await organizacion(), { name: 'Grande', city: ciudad })
      const emails = Array.from({ length: 2_500 }, (_, i) => `zbig${String(i).padStart(4, '0')}-${suffix}@test.mx`)
      await prisma.staff.createMany({
        data: emails.map(email => ({ email, firstName: 'Usuario', lastName: 'Grande', emailVerified: true })),
      })
      const personas = await prisma.staff.findMany({
        where: { email: { startsWith: 'zbig', endsWith: `${suffix}@test.mx` } },
        select: { id: true },
        take: 3_000,
      })
      expect(personas).toHaveLength(2_500)
      await prisma.staffVenue.createMany({ data: personas.map(p => ({ staffId: p.id, venueId: v, role: StaffRole.KITCHEN })) })
      // Tres de ellos son además el correo de un cliente: justo en la orilla de los lotes (999 cierra el primero, 1000 abre el
      // segundo) y en medio del tercero. Salen UNA vez, como CLIENTE.
      for (const i of [999, 1_000, 2_000]) {
        await planPagado(await venue(await organizacion(), { name: `Cliente ${i}`, city: ciudad, email: emails[i] }), 'PRO')
      }

      const aud: Audiencia = {
        segmentos: [
          { tipo: 'USUARIOS', roles: [StaffRole.KITCHEN], ciudades: [ciudad] },
          { tipo: 'CLIENTES', ciudades: [ciudad] },
        ],
      }
      const { lotes, filas, total } = await recorrer(aud)

      expect(lotes.map(l => l.length)).toEqual([1_000, 1_000, 500])
      expect(total).toBe(2_500)
      expect(filas.map(d => d.email)).toEqual(emails)
      expect(filas.filter(d => d.reason === 'CLIENTE').map(d => d.email)).toEqual([emails[999], emails[1_000], emails[2_000]])
      expect(await contarAudiencia(aud)).toEqual({
        total: 2_500,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 3, USUARIOS: 2_497 },
        bloqueados: 0,
      })
    }, 120_000)
  })
})
