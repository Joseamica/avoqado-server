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
import { createHash } from 'crypto'
import { Prisma, StaffRole, VenueStatus } from '@prisma/client'
import type { Audiencia } from '@/schemas/crm.schema'
import type { CrmAccess } from '@/services/crm/access.service'
import {
  buscarPersonasParaCampana,
  contarAudiencia,
  paginaDeDestinatarios,
  personasNoElegibles,
  recorrerAudiencia,
  type Destinatario,
} from '@/services/crm/email/audience.service'
import { filtrarBloqueados, sqlBloqueado } from '@/services/crm/email/optOut.service'
import { deleteAccount, erasedHashes } from '@/services/crm/erase.service'
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
/** Las lápidas que deja «Eliminar» en la prueba de quién se puede agregar. */
const erasedKeys: string[] = []
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
  const { entregados: total, conjuntoHash } = await recorrerAudiencia(aud, async lote => {
    lotes.push(lote)
  })
  return { lotes, filas: lotes.flat(), total, conjuntoHash }
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

/** Una persona del CRM que SÍ se puede agregar: contacto con correo en una cuenta abierta y su fila de permiso. */
async function conPermiso(
  alias: string,
  over: { archivedAt?: Date; organizationId?: string; contacto?: string; nombre?: string; stageId?: string; ownerStaffId?: string } = {},
) {
  const id = await cuenta({ archivedAt: over.archivedAt, name: over.nombre, stageId: over.stageId, ownerStaffId: over.ownerStaffId })
  if (over.organizationId) await prisma.crmAccount.update({ where: { id }, data: { organizationId: over.organizationId } })
  await contacto(id, `Persona ${alias}`, over.contacto ?? correo(alias), true)
  await consentimiento(correo(alias), id)
  return id
}

/** El `conjuntoHash` que deben dar estos correos, en ESTE orden: sha256 de «correo\n» por persona. */
const hashDe = (emails: string[]) =>
  createHash('sha256')
    .update(emails.map(e => `${e}\n`).join(''))
    .digest('hex')

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
    // Un contacto colgado de una cuenta que no es de este archivo (la del equipo, si ya existía) no se va en cascada.
    await prisma.crmContact.deleteMany({ where: { email: { contains: suffix, mode: 'insensitive' } } })
    if (erasedKeys.length) await prisma.crmErased.deleteMany({ where: { keyHash: { in: erasedKeys } } })
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
      expect(conteo).toEqual({
        total: 1,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 1, AGREGADOS: 0 },
        bloqueados: 4,
        conjuntoHash: hashDe([correo('bien')]),
      })
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
      const { entregados: total } = await recorrerAudiencia(usuarios([StaffRole.HOST], {}, ciudad), async lote => {
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
        porSegmento: { PROSPECTOS: 0, CLIENTES: 3, USUARIOS: 2_497, AGREGADOS: 0 },
        bloqueados: 0,
        conjuntoHash: hashDe(emails),
      })
    }, 120_000)
  })
  // ── Quién se puede agregar (plan B, tarea 4): cada caso es una exclusión de `personasNoElegibles`, la revisión del PATCH ──

  describe('quién se puede agregar', () => {
    const noSalen = (...alias: string[]) => personasNoElegibles(alias.map(correo))

    it('con_permiso_y_cuenta_abierta_sale_elegible', async () => {
      await conPermiso('agr-ok')
      // El contacto se escribió con mayúsculas y espacios: es la misma persona.
      await conPermiso('agr-mayus', { contacto: `  Agr-Mayus-${suffix}@Test.MX ` })
      expect(await noSalen('agr-ok', 'agr-mayus')).toEqual([])
      // Lo que se pregunta también se normaliza, y sin correos no se consulta.
      expect(await personasNoElegibles([` AGR-OK-${suffix}@TEST.MX`])).toEqual([])
      expect(await personasNoElegibles([])).toEqual([])
    })

    it('sin_fila_de_permiso_no_es_elegible', async () => {
      const id = await cuenta()
      await contacto(id, 'Sin Permiso', correo('agr-sin-permiso'), true)
      expect(await noSalen('agr-sin-permiso', 'agr-nadie')).toEqual([correo('agr-sin-permiso'), correo('agr-nadie')])
    })

    it('dado_de_baja_o_con_rebote_no_es_elegible', async () => {
      for (const alias of ['agr-baja', 'agr-rebote', 'agr-queja', 'agr-libre']) await conPermiso(alias)
      await prisma.crmEmailOptOut.create({ data: { email: correo('agr-baja'), source: 'UN_CLIC' } })
      await prisma.emailSuppression.createMany({
        data: [
          { email: correo('agr-rebote'), reason: 'HARD_BOUNCE' },
          { email: correo('agr-queja'), reason: 'COMPLAINT' },
        ],
      })
      expect(await noSalen('agr-baja', 'agr-rebote', 'agr-queja', 'agr-libre')).toEqual([
        correo('agr-baja'),
        correo('agr-rebote'),
        correo('agr-queja'),
      ])
    })

    it('con_su_cuenta_archivada_no_es_elegible', async () => {
      await conPermiso('agr-archivada', { archivedAt: new Date() })
      expect(await noSalen('agr-archivada')).toEqual([correo('agr-archivada')])
    })

    it('🔴 por_correo_un_permiso_colgado_de_una_cuenta_archivada_sirve_si_hay_un_contacto_visible_en_otra', async () => {
      // A (archivada) es dueña del permiso; B (abierta) tiene un contacto con el mismo correo: se decide por el correo.
      const a = await conPermiso('agr-dos-cuentas', { archivedAt: new Date() })
      const b = await cuenta()
      await contacto(b, 'En la abierta', correo('agr-dos-cuentas'), false)
      expect(await noSalen('agr-dos-cuentas')).toEqual([])
      expect((await prisma.crmEmailConsent.findUniqueOrThrow({ where: { email: correo('agr-dos-cuentas') } })).accountId).toBe(a)
    })

    it('🔴 de_un_cliente_oculto_no_es_elegible_aunque_tenga_permiso', async () => {
      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      await conPermiso('agr-oculta', { organizationId: oculta })
      // Control: la misma forma, en una organización que no está oculta, sí sale.
      await conPermiso('agr-visible', { organizationId: await organizacion() })
      expect(await noSalen('agr-oculta', 'agr-visible')).toEqual([correo('agr-oculta')])
    })

    it('de_la_organizacion_del_equipo_no_es_elegible', async () => {
      const equipo = await ensureCrmTeamVenue()
      // Una cuenta del CRM por organización: si otra prueba ya ligó la del equipo, el contacto va en ésa.
      const ya = await prisma.crmAccount.findUnique({ where: { organizationId: equipo.organizationId }, select: { id: true } })
      if (ya) {
        await contacto(ya.id, 'Del equipo', correo('agr-equipo'), false)
        await consentimiento(correo('agr-equipo'), ya.id)
      } else {
        await conPermiso('agr-equipo', { organizationId: equipo.organizationId })
      }
      expect(await noSalen('agr-equipo')).toEqual([correo('agr-equipo')])
    })

    it('eliminado_del_CRM_no_es_elegible', async () => {
      const nombre = `Para borrar ${suffix}`
      const id = await conPermiso('agr-eliminado', { nombre })
      expect(await noSalen('agr-eliminado')).toEqual([])
      erasedKeys.push(...erasedHashes({ keys: [], emails: [correo('agr-eliminado')], phones: [], organizationId: null }).person)
      // «Eliminar» borra a la persona (su contacto se va en cascada) y su fila de permiso.
      await deleteAccount({ staffId: vendedor.id, isSuperadmin: true } as CrmAccess, id, nombre)
      expect(await noSalen('agr-eliminado')).toEqual([correo('agr-eliminado')])
    })

    it('🔴 sqlBloqueado_dice_lo_mismo_que_filtrarBloqueados_para_una_baja_un_rebote_una_queja_y_uno_libre', async () => {
      const [baja, rebote, queja, libre] = ['blq-baja', 'blq-rebote', 'blq-queja', 'blq-libre'].map(correo)
      await prisma.crmEmailOptOut.create({ data: { email: baja, source: 'ADMIN' } })
      await prisma.emailSuppression.createMany({
        data: [
          { email: rebote, reason: 'HARD_BOUNCE' },
          { email: queja, reason: 'COMPLAINT' },
        ],
      })
      const emails = [baja, rebote, queja, libre]
      const filas = await prisma.$queryRaw<Array<{ email: string; bloqueado: boolean }>>(Prisma.sql`
        SELECT p."email", ${sqlBloqueado(Prisma.sql`p."email"`)} AS "bloqueado" FROM unnest(${emails}::text[]) AS p("email")`)
      const porSql = filas.filter(f => f.bloqueado).map(f => f.email)
      const porLote = await filtrarBloqueados(prisma, emails)
      expect(porSql.sort()).toEqual([...porLote].sort())
      expect(porSql.sort()).toEqual([baja, queja, rebote].sort())
    })
  })

  // ── Personas quitadas y agregadas a mano (plan B, tarea 5; rediseño tras Codex r2 y r3) ─────────────────────────────────────────
  // Contar, ver y mandar son la MISMA consulta: `incluir` es una cuarta rama (con la regla de `sqlCorreoAgregable`, por correo) y
  // `excluir` gana sobre todas, antes del DISTINCT ON. El conjunto que se confirma (`conjuntoHash`) sale de esa misma pasada.

  describe('excluir e incluir', () => {
    /** Un negocio en una ciudad que sólo existe en esta prueba, con estas personas como cajeras. */
    async function cajeras(etiqueta: string, alias: string[]) {
      const ciudad = `${etiqueta} ${suffix}`
      const v = await venue(await organizacion(), { name: `Negocio ${etiqueta}`, city: ciudad })
      for (const a of alias) await enVenue((await persona(correo(a))).id, v, StaffRole.CASHIER)
      return usuarios([StaffRole.CASHIER], {}, ciudad)
    }

    it('incluir_agrega_a_quien_es_elegible_aunque_su_cuenta_este_en_otra_etapa_y_sale_como_PROSPECTO_en_AGREGADOS', async () => {
      const duena = await persona(correo('inc-duena'), { firstName: 'Lupe', lastName: 'Ventas' })
      const id = await conPermiso('inc-perdida', { stageId: perdidaId, nombre: 'Tacos La Perdida', ownerStaffId: duena.id })
      const abiertas: Audiencia = { segmentos: [{ tipo: 'PROSPECTOS', etapas: [abiertaId] }] }

      // Control: su cuenta está en «perdida», así que el público de etapas abiertas no la alcanza.
      expect(correos((await recorrer(abiertas)).filas)).not.toContain(correo('inc-perdida'))
      const { filas } = await recorrer({ ...abiertas, incluir: [correo('inc-perdida')] })

      expect(filas.filter(d => d.email === correo('inc-perdida'))).toEqual([
        {
          email: correo('inc-perdida'),
          name: 'Persona inc-perdida',
          reason: 'PROSPECTO',
          publico: 'AGREGADOS',
          vars: { nombre: 'Persona inc-perdida', negocio: 'Tacos La Perdida', vendedor: 'Lupe Ventas' },
          accountId: id,
        },
      ])
      expect(await contarAudiencia({ segmentos: [], incluir: [correo('inc-perdida')] })).toEqual({
        total: 1,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 1 },
        bloqueados: 0,
        conjuntoHash: hashDe([correo('inc-perdida')]),
      })
    })

    it('🔴 incluir_no_alcanza_a_un_archivado_ni_a_un_cliente_oculto_ni_al_equipo_ni_a_quien_no_tiene_permiso', async () => {
      await conPermiso('inc-archivada', { archivedAt: new Date() })
      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      await conPermiso('inc-oculta', { organizationId: oculta })
      const equipo = await ensureCrmTeamVenue()
      // Una cuenta del CRM por organización: si otra prueba ya ligó la del equipo, el contacto va en ésa.
      const ya = await prisma.crmAccount.findUnique({ where: { organizationId: equipo.organizationId }, select: { id: true } })
      if (ya) {
        await contacto(ya.id, 'Del equipo', correo('inc-equipo'), false)
        await consentimiento(correo('inc-equipo'), ya.id)
      } else {
        await conPermiso('inc-equipo', { organizationId: equipo.organizationId })
      }
      await contacto(await cuenta(), 'Sin Permiso', correo('inc-sin-permiso'), true)
      // Control: la misma forma, abierta y con permiso, sí sale.
      await conPermiso('inc-ok')

      const aud: Audiencia = {
        segmentos: [],
        incluir: ['inc-archivada', 'inc-oculta', 'inc-equipo', 'inc-sin-permiso', 'inc-nadie', 'inc-ok'].map(correo),
      }

      expect(correos((await recorrer(aud)).filas)).toEqual([correo('inc-ok')])
      expect(await contarAudiencia(aud)).toMatchObject({ total: 1, porSegmento: { AGREGADOS: 1 }, bloqueados: 0 })
      // La misma respuesta que la revisión del PATCH: los cinco que no salen son los que no se pueden agregar.
      expect(await personasNoElegibles(aud.incluir!)).toEqual(
        ['inc-archivada', 'inc-oculta', 'inc-equipo', 'inc-sin-permiso', 'inc-nadie'].map(correo),
      )
    })

    it('🔴 quien_esta_en_incluir_Y_en_un_segmento_y_luego_en_excluir_no_se_resuelve_ni_se_manda', async () => {
      const publico = await cajeras('Quitada', ['qx-queda', 'qx-quitada'])
      await conPermiso('qx-quitada')
      const aud: Audiencia = { ...publico, excluir: [correo('qx-quitada')], incluir: [correo('qx-quitada')] }

      const { filas, total } = await recorrer(aud)

      expect(correos(filas)).toEqual([correo('qx-queda')])
      expect(total).toBe(1)
      // Quitada a mano no es una baja: no cuenta en «bloqueados».
      expect(await contarAudiencia(aud)).toEqual({
        total: 1,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 1, AGREGADOS: 0 },
        bloqueados: 0,
        conjuntoHash: hashDe([correo('qx-queda')]),
      })
    })

    it('quien_esta_en_un_publico_y_ademas_agregado_sale_una_vez_por_su_publico', async () => {
      const publico = await cajeras('Doble', ['dob-usuaria'])
      await conPermiso('dob-usuaria')
      const aud: Audiencia = { ...publico, incluir: [correo('dob-usuaria')] }

      const { filas } = await recorrer(aud)

      expect(filas).toHaveLength(1)
      expect(filas[0]).toMatchObject({
        email: correo('dob-usuaria'),
        reason: 'USUARIO',
        publico: 'USUARIOS',
        reasonVenueName: 'Negocio Doble',
      })
      expect(await contarAudiencia(aud)).toMatchObject({ total: 1, porSegmento: { USUARIOS: 1, AGREGADOS: 0 } })
    })

    it('un_agregado_dado_de_baja_no_sale_ni_cuenta_un_quitado_no_cuenta_en_bloqueados', async () => {
      const publico = await cajeras('BajaAgregada', ['ba-usuaria', 'ba-quitada'])
      await conPermiso('ba-agregada-baja')
      await conPermiso('ba-agregada-ok')
      await prisma.crmEmailOptOut.create({ data: { email: correo('ba-agregada-baja'), source: 'UN_CLIC' } })
      const aud: Audiencia = {
        ...publico,
        excluir: [correo('ba-quitada')],
        incluir: [correo('ba-agregada-baja'), correo('ba-agregada-ok')],
      }

      const { filas, conjuntoHash } = await recorrer(aud)

      expect(correos(filas)).toEqual([correo('ba-agregada-ok'), correo('ba-usuaria')])
      // La agregada con baja ya no es agregable (la misma regla que el PATCH), así que tampoco es un «bloqueado» de este público.
      expect(await contarAudiencia(aud)).toEqual({
        total: 2,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 1, AGREGADOS: 1 },
        bloqueados: 0,
        conjuntoHash,
      })
    })

    it('sin_publicos_y_con_incluir_salen_solo_los_agregados', async () => {
      await conPermiso('so-a')
      await conPermiso('so-b')
      const aud: Audiencia = { segmentos: [], incluir: [correo('so-b'), correo('so-a')] }

      const { filas } = await recorrer(aud)

      // En orden de correo, no en el de la lista.
      expect(filas.map(d => d.email)).toEqual([correo('so-a'), correo('so-b')])
      expect(filas.every(d => d.reason === 'PROSPECTO' && d.publico === 'AGREGADOS')).toBe(true)
      expect(await contarAudiencia(aud)).toEqual({
        total: 2,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 2 },
        bloqueados: 0,
        conjuntoHash: hashDe([correo('so-a'), correo('so-b')]),
      })
    })

    it('sin_publicos_ni_incluir_no_hay_nadie_y_no_se_consulta', async () => {
      const espia = jest.spyOn(prisma, '$queryRaw')
      try {
        expect(await contarAudiencia({ segmentos: [], excluir: [correo('nadie')] })).toEqual({
          total: 0,
          porSegmento: { PROSPECTOS: 0, CLIENTES: 0, USUARIOS: 0, AGREGADOS: 0 },
          bloqueados: 0,
          conjuntoHash: hashDe([]),
        })
        expect(await recorrer({ segmentos: [], incluir: [] })).toMatchObject({ total: 0, filas: [], conjuntoHash: hashDe([]) })
        expect(espia).not.toHaveBeenCalled()
      } finally {
        espia.mockRestore()
      }
    })

    it('🔴 el_conteo_es_igual_a_lo_que_entrega_recorrerAudiencia_y_el_conjuntoHash_coincide', async () => {
      const publico = await cajeras('Mezcla', ['mz-a', 'mz-b', 'mz-baja', 'mz-quitada'])
      await prisma.crmEmailOptOut.create({ data: { email: correo('mz-baja'), source: 'ADMIN' } })
      await conPermiso('mz-agregada')
      await conPermiso('mz-b')
      const a: Audiencia = { ...publico, excluir: [correo('mz-quitada')], incluir: [correo('mz-agregada'), correo('mz-b')] }

      const { total, conjuntoHash, bloqueados } = await contarAudiencia(a)
      const vistos: string[] = []
      const recorrido = await recorrerAudiencia(a, async lote => void vistos.push(...lote.map(d => d.email)))

      expect(vistos).toHaveLength(total)
      expect(new Set(vistos).size).toBe(total)
      expect(recorrido).toEqual({ entregados: total, conjuntoHash })
      // Las personas, en el orden de bytes del correo (COLLATE "C"), y el hash es el de ESA lista en ESE orden.
      expect(vistos).toEqual([correo('mz-a'), correo('mz-agregada'), correo('mz-b')])
      expect(conjuntoHash).toBe(hashDe(vistos))
      expect(bloqueados).toBe(1)
    })

    it('🔴 un_correo_en_dos_cuentas_A_archivada_duena_del_permiso_y_B_abierta_sale_con_el_nombre_el_negocio_y_la_cuenta_de_B', async () => {
      const duena = await persona(correo('dc-duena-b'), { firstName: 'Bety', lastName: 'Abierta' })
      // A (archivada) tiene el permiso y un contacto PRINCIPAL con ese correo: nunca debe asomarse.
      await conPermiso('dc-persona', { archivedAt: new Date(), nombre: 'Negocio A archivado' })
      const b = await cuenta({ name: 'Negocio B abierto', ownerStaffId: duena.id })
      await contacto(b, 'Nombre en B', `  DC-Persona-${suffix}@Test.mx `, false)
      // Y una cuenta de un cliente oculto con otro contacto principal del mismo correo: tampoco.
      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      const d = await cuenta({ name: 'Negocio D oculto' })
      await prisma.crmAccount.update({ where: { id: d }, data: { organizationId: oculta } })
      await contacto(d, 'Nombre en D', correo('dc-persona'), true)

      const { filas } = await recorrer({ segmentos: [], incluir: [correo('dc-persona')] })

      expect(filas).toEqual([
        {
          email: correo('dc-persona'),
          name: 'Nombre en B',
          reason: 'PROSPECTO',
          publico: 'AGREGADOS',
          vars: { nombre: 'Nombre en B', negocio: 'Negocio B abierto', vendedor: 'Bety Abierta' },
          accountId: b,
        },
      ])
      // Y la regla dice lo mismo: es agregable (por el contacto visible de B).
      expect(await personasNoElegibles([correo('dc-persona')])).toEqual([])
    })

    it('🔴 entre_DOS_cuentas_visibles_incluir_toma_el_contacto_PRINCIPAL_aunque_sea_el_mas_nuevo', async () => {
      const duena = await persona(correo('tb-duena'), { firstName: 'Paty', lastName: 'Principal' })
      // La cuenta vieja tiene el permiso y un contacto NO principal, creado antes: si el orden fuera «el más viejo», ganaría ésta.
      const vieja = await cuenta({ name: 'Negocio viejo' })
      await prisma.crmContact.create({
        data: {
          accountId: vieja,
          name: 'Nombre viejo',
          email: correo('tb-persona'),
          isPrimary: false,
          createdAt: new Date(Date.now() - 60_000),
        },
      })
      await consentimiento(correo('tb-persona'), vieja)
      const nueva = await cuenta({ name: 'Negocio nuevo', ownerStaffId: duena.id })
      await contacto(nueva, 'Nombre nuevo', correo('tb-persona'), true)

      const { filas } = await recorrer({ segmentos: [], incluir: [correo('tb-persona')] })

      expect(filas).toEqual([
        {
          email: correo('tb-persona'),
          name: 'Nombre nuevo',
          reason: 'PROSPECTO',
          publico: 'AGREGADOS',
          vars: { nombre: 'Nombre nuevo', negocio: 'Negocio nuevo', vendedor: 'Paty Principal' },
          accountId: nueva,
        },
      ])
      // El buscador de «Agregar» desempata igual (principal, luego el más viejo).
      expect((await buscarPersonasParaCampana(correo('tb-persona'))).rows).toEqual([
        expect.objectContaining({ email: correo('tb-persona'), nombre: 'Nombre nuevo', negocio: 'Negocio nuevo', agregable: true }),
      ])
    })

    it('🔴 un_correo_de_negocio_con_un_espacio_invisible_al_final_y_quitado_no_se_cuenta_ni_se_firma_ni_se_entrega_ni_se_lista', async () => {
      const ciudad = `Invisible ${suffix}`
      // `normalizeEmail` (JS, el correo con el que se manda y el que guarda «Quitar») quita U+00A0, U+202F y U+FEFF; el `btrim` de SQL no.
      const invisibles = { bom: '\uFEFF', nbsp: '\u00A0', nnbsp: '\u202F' }
      for (const [alias, caracter] of Object.entries(invisibles)) {
        await planPagado(await venue(await organizacion(), { email: `${correo(`inv-${alias}`)}${caracter}`, city: ciudad }), 'PRO')
      }
      await planPagado(await venue(await organizacion(), { email: correo('inv-queda'), city: ciudad }), 'PRO')
      const quitadas = Object.keys(invisibles).map(alias => correo(`inv-${alias}`))
      const publico = clientes({}, ciudad)

      // Control: la regla de forma de SQL los deja pasar con el correo CRUDO (así el filtro de SQL no los iguala con lo que se quitó) y se
      // mandan normalizados. Sin el filtro en JS, los tres de abajo saldrían.
      expect(correos((await recorrer(publico)).filas)).toEqual([...quitadas, correo('inv-queda')].sort())
      const [{ igual }] = await prisma.$queryRaw<Array<{ igual: boolean }>>(
        Prisma.sql`SELECT lower(btrim(${`${quitadas[1]}\u00A0`})) = ${quitadas[1]} AS "igual"`,
      )
      expect(igual).toBe(false)

      // Lo que guarda «Quitar»: el correo que enseñó «Ver quiénes», ya normalizado.
      const aud: Audiencia = { ...publico, excluir: quitadas }
      const soloQueda = hashDe([correo('inv-queda')])

      const { filas, total, conjuntoHash } = await recorrer(aud)
      expect(correos(filas)).toEqual([correo('inv-queda')])
      expect({ total, conjuntoHash }).toEqual({ total: 1, conjuntoHash: soloQueda })
      expect(await contarAudiencia(aud)).toEqual({
        total: 1,
        porSegmento: { PROSPECTOS: 0, CLIENTES: 1, USUARIOS: 0, AGREGADOS: 0 },
        bloqueados: 0,
        conjuntoHash: soloQueda,
      })
      // «Ver quiénes» tampoco la lista, y con páginas de 1 el cursor (el correo crudo) no repite ni pierde a nadie.
      expect((await paginaDeDestinatarios(aud, { limit: 100 })).filas.map(d => d.email)).toEqual([correo('inv-queda')])
      const vistos: string[] = []
      let desde: string | undefined
      for (let vuelta = 0; vuelta < 10; vuelta++) {
        const { filas: pagina, siguiente } = await paginaDeDestinatarios(aud, { desde, limit: 1 })
        vistos.push(...pagina.map(d => d.email))
        if (siguiente === null) break
        desde = siguiente
      }
      expect(vistos).toEqual([correo('inv-queda')])
    })
  })
  // ── Buscar a quién agregar (plan B, tarea 7; rediseño tras Codex r2 y r3) ────────────────────────────────────────────────────
  // Sólo gente que ya está en el CRM y es VISIBLE (cuenta abierta, cliente no oculto, no del equipo). «Agregable» es lo mismo que
  // contesta `personasNoElegibles` (el PATCH): permiso Y no bloqueado, sobre un contacto visible.

  describe('buscar a quién agregar', () => {
    const buscar = async (q: string) => buscarPersonasParaCampana(q)
    const emailsDe = async (q: string) => (await buscar(q)).rows.map(r => r.email)

    it('busca_sin_acentos_y_dice_quien_no_acepto_correos_y_quien_se_dio_de_baja', async () => {
      await conPermiso('bus7-jose', { nombre: `Cafetería La Esquina ${suffix}` })
      await prisma.crmContact.updateMany({ where: { email: correo('bus7-jose') }, data: { name: `José Pérez ${suffix}` } })
      const sin = await cuenta({ name: `Sin permiso ${suffix}` })
      await contacto(sin, `Sin Permiso ${suffix}`, correo('bus7-sin'), true)
      await conPermiso('bus7-baja', { nombre: `Dada de baja ${suffix}` })
      await prisma.crmEmailOptOut.create({ data: { email: correo('bus7-baja'), source: 'UN_CLIC' } })

      expect((await buscar(`jose perez ${suffix}`)).rows).toEqual([
        {
          email: correo('bus7-jose'),
          nombre: `José Pérez ${suffix}`,
          negocio: `Cafetería La Esquina ${suffix}`,
          aceptoCorreos: true,
          bloqueado: false,
          agregable: true,
        },
      ])
      expect(await emailsDe(`CAFETERIA la esquina ${suffix}`)).toEqual([correo('bus7-jose')])
      const [sinPermiso] = (await buscar(`sin permiso ${suffix}`)).rows
      expect(sinPermiso).toMatchObject({ email: correo('bus7-sin'), aceptoCorreos: false, bloqueado: false, agregable: false })
      const [baja] = (await buscar(`dada de baja ${suffix}`)).rows
      expect(baja).toMatchObject({ email: correo('bus7-baja'), aceptoCorreos: true, bloqueado: true, agregable: false })
    })

    it('🔴 no_devuelve_a_nadie_de_una_cuenta_archivada_ni_sus_datos', async () => {
      await conPermiso('bus7-arch', { archivedAt: new Date(), nombre: `Archivada ${suffix}` })
      expect(await emailsDe(correo('bus7-arch'))).toEqual([])
      expect(await emailsDe(`Archivada ${suffix}`)).toEqual([])
      expect(await emailsDe(`Persona bus7-arch`)).toEqual([])
    })

    it('🔴 no_devuelve_a_nadie_de_un_cliente_oculto', async () => {
      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      await conPermiso('bus7-oculto', { organizationId: oculta, nombre: `Oculto ${suffix}` })
      await conPermiso('bus7-visible', { organizationId: await organizacion(), nombre: `Visible ${suffix}` })
      expect(await emailsDe(correo('bus7-oculto'))).toEqual([])
      expect(await emailsDe(`Oculto ${suffix}`)).toEqual([])
      expect(await emailsDe(correo('bus7-visible'))).toEqual([correo('bus7-visible')])
    })

    it('no_devuelve_a_nadie_de_la_organizacion_del_equipo', async () => {
      const equipo = await ensureCrmTeamVenue()
      const ya = await prisma.crmAccount.findUnique({ where: { organizationId: equipo.organizationId }, select: { id: true } })
      if (ya) {
        await contacto(ya.id, 'Del equipo', correo('bus7-equipo'), false)
        await consentimiento(correo('bus7-equipo'), ya.id)
      } else {
        await conPermiso('bus7-equipo', { organizationId: equipo.organizationId })
      }
      expect(await emailsDe(correo('bus7-equipo'))).toEqual([])
    })

    it('no_devuelve_a_un_eliminado', async () => {
      const nombre = `Para borrar bus7 ${suffix}`
      const id = await conPermiso('bus7-eliminado', { nombre })
      expect(await emailsDe(correo('bus7-eliminado'))).toEqual([correo('bus7-eliminado')])
      erasedKeys.push(...erasedHashes({ keys: [], emails: [correo('bus7-eliminado')], phones: [], organizationId: null }).person)
      await deleteAccount({ staffId: vendedor.id, isSuperadmin: true } as CrmAccess, id, nombre)
      expect(await emailsDe(correo('bus7-eliminado'))).toEqual([])
    })

    it('🔴 agregable_en_el_buscador_es_lo_mismo_que_elegible_para_personasNoElegibles', async () => {
      const oculta = await organizacion()
      await prisma.crmHiddenClient.create({ data: { organizationId: oculta } })
      const equipo = await ensureCrmTeamVenue()
      const yaEquipo = await prisma.crmAccount.findUnique({ where: { organizationId: equipo.organizationId }, select: { id: true } })
      const sin = await cuenta()
      await contacto(sin, 'Sin permiso', correo('par-sin-permiso'), true)
      await conPermiso('par-ok')
      await conPermiso('par-baja')
      await prisma.crmEmailOptOut.create({ data: { email: correo('par-baja'), source: 'UN_CLIC' } })
      await conPermiso('par-rebote')
      await prisma.emailSuppression.create({ data: { email: correo('par-rebote'), reason: 'HARD_BOUNCE' } })
      await conPermiso('par-archivada', { archivedAt: new Date() })
      await conPermiso('par-oculta', { organizationId: oculta })
      if (yaEquipo) {
        await contacto(yaEquipo.id, 'Del equipo', correo('par-equipo'), false)
        await consentimiento(correo('par-equipo'), yaEquipo.id)
      } else {
        await conPermiso('par-equipo', { organizationId: equipo.organizationId })
      }
      // Un correo en dos cuentas: A archivada y dueña del permiso, B abierta.
      await conPermiso('par-dos', { archivedAt: new Date(), nombre: `Negocio A ${suffix}` })
      await contacto(await cuenta({ name: `Negocio B ${suffix}` }), 'En B', correo('par-dos'), false)
      // Y uno que sólo vive en una cuenta archivada (el permiso es de la landing, sin cuenta visible).
      const soloA = await cuenta({ archivedAt: new Date() })
      await contacto(soloA, 'Sólo en A', correo('par-solo-archivada'), true)
      await consentimiento(correo('par-solo-archivada'))
      // Sin ninguna cuenta: sólo el permiso de la landing.
      await consentimiento(correo('par-sin-cuenta'))
      // Eliminado.
      const nombre = `Eliminada par ${suffix}`
      const borrar = await conPermiso('par-eliminado', { nombre })
      erasedKeys.push(...erasedHashes({ keys: [], emails: [correo('par-eliminado')], phones: [], organizationId: null }).person)
      await deleteAccount({ staffId: vendedor.id, isSuperadmin: true } as CrmAccess, borrar, nombre)

      const alias = [
        'par-ok',
        'par-sin-permiso',
        'par-baja',
        'par-rebote',
        'par-archivada',
        'par-oculta',
        'par-equipo',
        'par-dos',
        'par-solo-archivada',
        'par-sin-cuenta',
        'par-eliminado',
        'par-inexistente',
      ]
      const emails = alias.map(correo)
      const noElegibles = new Set(await personasNoElegibles(emails))
      for (const email of emails) {
        const { rows } = await buscar(email)
        const fila = rows.find(r => r.email === email)
        const agregableEnBuscador = !!fila && fila.aceptoCorreos && !fila.bloqueado
        expect([email, agregableEnBuscador, fila?.agregable ?? false]).toEqual([email, !noElegibles.has(email), !noElegibles.has(email)])
      }
      // Control: el reparto no es trivial (hay de los dos lados).
      expect(emails.filter(e => !noElegibles.has(e)).sort()).toEqual([correo('par-dos'), correo('par-ok')])
      // El de las dos cuentas sale con los datos de B, nunca los de A archivada.
      const [dos] = (await buscar(correo('par-dos'))).rows
      expect(dos).toMatchObject({ email: correo('par-dos'), nombre: 'En B', negocio: `Negocio B ${suffix}`, aceptoCorreos: true })
      expect(await emailsDe(`Negocio A ${suffix}`)).toEqual([])
    })

    it('una_persona_en_dos_cuentas_sale_una_vez', async () => {
      await conPermiso('bus7-dup', { nombre: `Dup A ${suffix}` })
      await contacto(await cuenta({ name: `Dup B ${suffix}` }), 'Otra vez', `  BUS7-DUP-${suffix}@Test.MX`, false)
      const { rows } = await buscar(`bus7-dup-${suffix}`)
      expect(rows.map(r => r.email)).toEqual([correo('bus7-dup')])
      // Gana el contacto principal.
      expect(rows[0].negocio).toBe(`Dup A ${suffix}`)
    })

    it('trae_20_y_dice_hayMas_con_21', async () => {
      for (let i = 0; i < 21; i++) {
        const id = await cuenta({ name: `Veintiuno ${suffix}` })
        await contacto(id, `Persona ${i}`, correo(`v21-${String(i).padStart(2, '0')}`), true)
      }
      const lleno = await buscar(`veintiuno ${suffix}`)
      expect(lleno.rows).toHaveLength(20)
      expect(lleno.hayMas).toBe(true)
      expect(lleno.rows.map(r => r.email)).toEqual(Array.from({ length: 20 }, (_, i) => correo(`v21-${String(i).padStart(2, '0')}`)))
      // Con exactamente 20 no hay más.
      await prisma.crmContact.deleteMany({ where: { email: correo('v21-20') } })
      const justo = await buscar(`veintiuno ${suffix}`)
      expect(justo.rows).toHaveLength(20)
      expect(justo.hayMas).toBe(false)
    })

    it('un_comodin_no_trae_a_todos', async () => {
      await conPermiso('bus7-com', { nombre: `Comodin ${suffix}` })
      for (const q of ['%%', '__', '!!', 'bus7_com', 'bus7%com', '%', '_']) expect((await buscar(q)).rows).toEqual([])
      // Y lo que sólo es espacio no es una búsqueda.
      expect(await buscar('    ')).toEqual({ rows: [], hayMas: false })
    })
  })

  describe('ver quiénes', () => {
    /** Recorre «Ver quiénes» página por página, como lo hace la pantalla con «Ver más». */
    async function paginas(aud: Audiencia, limit: number, buscar?: string) {
      const paginas: Destinatario[][] = []
      let desde: string | undefined
      for (;;) {
        const { filas, siguiente } = await paginaDeDestinatarios(aud, { desde, limit, buscar })
        paginas.push(filas)
        if (siguiente === null) return paginas
        expect(filas[filas.length - 1].email).toBe(siguiente)
        desde = siguiente
      }
    }
    async function cajerasDe(etiqueta: string, nombres: Array<{ alias: string; firstName?: string }>, negocio = `Negocio ${etiqueta}`) {
      const ciudad = `${etiqueta} ${suffix}`
      const v = await venue(await organizacion(), { name: negocio, city: ciudad })
      for (const { alias, firstName } of nombres) await enVenue((await persona(correo(alias), { firstName })).id, v, StaffRole.CASHIER)
      return usuarios([StaffRole.CASHIER], {}, ciudad)
    }

    it('las_paginas_no_repiten_ni_pierden_y_su_union_es_el_recorrido_completo_en_orden', async () => {
      const aud = await cajerasDe(
        'Ciento veinte',
        Array.from({ length: 120 }, (_, i) => ({ alias: `p120-${String(i).padStart(3, '0')}` })),
      )
      const todas = await paginas(aud, 100)
      expect(todas.map(p => p.length)).toEqual([100, 20])
      const unidas = todas.flat().map(d => d.email)
      expect(unidas).toEqual([...unidas].sort())
      expect(unidas).toEqual(correos((await recorrer(aud)).filas))
      expect(new Set(unidas).size).toBe(120)
      expect((await contarAudiencia(aud)).total).toBe(120)
      // Una página exacta no inventa otra con filas: la última dice que no hay siguiente.
      expect((await paginas(aud, 120)).map(p => p.length)).toEqual([120])
    })

    it('🔴 con_bajas_y_rebotes_la_union_de_las_paginas_es_el_conteo_y_ninguno_esta_bloqueado', async () => {
      const aud = await cajerasDe(
        'Con bajas lista',
        Array.from({ length: 10 }, (_, i) => ({ alias: `bl-${i}` })),
      )
      await prisma.crmEmailOptOut.createMany({ data: [0, 1, 2].map(i => ({ email: correo(`bl-${i}`), source: 'UN_CLIC' })) })
      await prisma.emailSuppression.createMany({ data: [3, 4].map(i => ({ email: correo(`bl-${i}`), reason: 'HARD_BOUNCE' })) })

      const unidas = (await paginas(aud, 3)).flat().map(d => d.email)

      expect(unidas).toHaveLength((await contarAudiencia(aud)).total)
      expect(unidas).toEqual([5, 6, 7, 8, 9].map(i => correo(`bl-${i}`)))
      expect(unidas).toEqual(correos((await recorrer(aud)).filas))
      expect(await filtrarBloqueados(prisma, unidas)).toEqual(new Set())
    })

    it('🔴 buscar_jose_encuentra_a_José_y_cafeteria_a_Cafetería_sin_mayusculas_ni_acentos', async () => {
      const aud = await cajerasDe(
        'Busca',
        [
          { alias: 'bus-1', firstName: 'José' },
          { alias: 'bus-2', firstName: 'Ana' },
        ],
        'Cafetería La Esquina',
      )
      const buscar = async (q: string) => (await paginas(aud, 100, q)).flat().map(d => d.email)

      expect(await buscar('jose')).toEqual([correo('bus-1')])
      expect(await buscar('JOSÉ')).toEqual([correo('bus-1')])
      expect(await buscar('cafeteria')).toEqual([correo('bus-1'), correo('bus-2')])
      expect(await buscar(`BUS-2-${suffix}`)).toEqual([correo('bus-2')])
      expect(await buscar('nadie-se-llama-asi')).toEqual([])
      expect(await buscar('   ')).toEqual([correo('bus-1'), correo('bus-2')])
      // La búsqueda pagina igual y el cursor sigue valiendo con ella.
      expect((await paginas(aud, 1, 'cafeteria')).map(p => p.length)).toEqual([1, 1])
    })

    it('buscar_con_porcentaje_guion_bajo_o_signo_de_cierre_no_es_comodin', async () => {
      const aud = await cajerasDe('Comodin', [{ alias: 'com-1' }, { alias: 'com-2' }])
      for (const q of ['%', '_', '!', 'com_1', 'com%']) expect((await paginas(aud, 100, q)).flat()).toEqual([])
    })

    it('el_motivo_dice_AGREGADO_para_incluir_y_PROSPECTO_para_el_publico_y_los_quitados_no_salen', async () => {
      await consentimiento(correo('mot-prosp'))
      await consentimiento(correo('mot-quitado'))
      await conPermiso('mot-agregada')
      const aud: Audiencia = {
        segmentos: [{ tipo: 'PROSPECTOS' }],
        incluir: [correo('mot-agregada')],
        excluir: [correo('mot-quitado')],
      }
      const filas = (await paginas(aud, 100, `-${suffix}`)).flat().filter(d => d.email.startsWith('mot-'))

      expect(filas.map(d => [d.email, d.publico])).toEqual([
        [correo('mot-agregada'), 'PROSPECTOS'],
        [correo('mot-prosp'), 'PROSPECTOS'],
      ])
      // Sin el público, la misma persona sólo llega por «agregada».
      const soloAgregada = (await paginas({ segmentos: [], incluir: [correo('mot-agregada')] }, 100)).flat()
      expect(soloAgregada.map(d => [d.email, d.publico])).toEqual([[correo('mot-agregada'), 'AGREGADOS']])
      expect(await paginas({ segmentos: [] }, 100)).toEqual([[]])
    })
  })
})
