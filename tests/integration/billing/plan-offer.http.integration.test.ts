/**
 * Planes editables B1, Task 9: el recorrido HTTP de la oferta de los planes, contra Postgres REAL.
 *
 * La app real por HTTP (`/api/v1/superadmin/plan-offer`), con el JWT real de un SUPERADMIN sembrado (su fila SUPERADMIN activa la
 * relee `rolVigente`). Publicar, reintentar, descartar, el interruptor y los destinatarios corren con el código real; lo que se
 * comprueba después de cada paso se lee en Postgres: la versión (estado, ranuras, intentos, listas ligadas), el puntero y las dos
 * listas híbridas `PLAN:*`.
 *
 * Stripe se simula entero (`jest.mock('stripe')`). Sus precios son el almacén de Task 5 (`tests/__helpers__/fakeStripePrices.ts`):
 * guarda la PRIMERA respuesta de cada llave de idempotencia (también un 500), rechaza una llave de búsqueda repetida y puede
 * «perder» la respuesta después de crear. La preparación de las listas híbridas (`ensureHybridPublicationPrices`) sólo estampa ids
 * falsos, como en `hybrid-plan-list-seed`, y cada caso puede hacerla fallar o detenerla en un plan. `planesEditablesListos` se simula
 * listo (en B1 el código real no deja prender).
 *
 * Higiene (como `plan-offer.candado`): las listas `PLAN:*` de otras suites se aparcan y se restauran; cada caso empieza con sus
 * propias listas en venta al precio de la v1 (las del caso anterior se retiran: las listas y sus publicaciones no se pueden borrar);
 * las filas de la oferta (puntero, versiones e interruptor) se borran antes y después; las campañas ACTIVE de otras suites se pausan;
 * las Features de los planes y los destinatarios de `PlatformSettings` vuelven a como estaban; lo que creó la suite se borra.
 */
import { crearAlmacenDePrecios } from '@tests/__helpers__/fakeStripePrices'

// ---------------------------------------------------------------------------------------------------------------------
// Stripe simulado y la preparación de las listas híbridas, con fallas y pausas que pone cada caso
// ---------------------------------------------------------------------------------------------------------------------

interface MockPausa {
  /** Se cumple cuando la llamada llega a la pausa. */
  llego: Promise<void>
  avisar: () => void
  soltar: () => void
  promesa: Promise<void>
}
function mockNuevaPausa(): MockPausa {
  let avisar!: () => void
  let soltar!: () => void
  const llego = new Promise<void>(r => (avisar = r))
  const promesa = new Promise<void>(r => (soltar = r))
  return { llego, avisar, soltar, promesa }
}

const mockAlmacen = crearAlmacenDePrecios()
const mockNoExiste = (que: string) =>
  Object.assign(new Error(`No such ${que}`), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' })
const mockCliente = {
  prices: {
    list: (...a: unknown[]) => mockAlmacen.list(...a),
    create: (...a: unknown[]) => mockAlmacen.create(...a),
    retrieve: async (id: string) => {
      const p = mockAlmacen.store.find((x: { id: string }) => x.id === id)
      if (!p) throw mockNoExiste('price')
      return { ...p }
    },
  },
  // El renombre que pide el publicador al mover: con nombres sin cambiar, no toca Stripe; si lo tocara, que se note.
  products: {
    retrieve: async (id: string) => ({ id, name: 'Plan Avoqado', description: null }),
    update: async () => {
      throw new Error('Esta suite no cambia nombres de planes')
    },
  },
}
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockCliente))

type Plan = 'PRO' | 'PREMIUM'
const mockListas = {
  /** El plan cuya SIGUIENTE preparación de Stripe falla (una vez), sin estampar ids. */
  falla: null as Plan | null,
  /** La siguiente preparación de ese plan estampa sus ids y luego espera esta pausa. */
  pausa: null as { tier: Plan; pausa: MockPausa } | null,
  /** Cada preparación, en orden: la publicación y su plan. */
  llamadas: [] as Array<{ id: string; tier: string }>,
}
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) => {
    const db = require('@/utils/prismaClient').default
    const pub = await db.hybridOfferPublication.findUniqueOrThrow({ where: { id }, select: { definition: true } })
    const tier = String((pub.definition as { planTier?: string }).planTier ?? '')
    mockListas.llamadas.push({ id, tier })
    if (mockListas.falla === tier) {
      mockListas.falla = null
      throw new Error('Stripe no contestó')
    }
    await db.hybridOfferPublication.update({ where: { id }, data: { stripeProductId: `prod_t9_${id}`, stripePriceId: `price_t9_${id}` } })
    const detenida = mockListas.pausa
    if (detenida && detenida.tier === tier) {
      mockListas.pausa = null
      detenida.pausa.avisar()
      await detenida.pausa.promesa
    }
  }),
}))
// Los requisitos de código para prender el interruptor: listos (en B1 el SERVIDOR no deja; se prueba en plan-offer.api).
jest.mock('@/services/billing/planesEditablesListos', () => ({
  SERVIDOR_LISTO_PARA_PLANES_EDITABLES: true,
  cuponDeIntroduccionRetirado: () => true,
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { productKeySql } from '@/services/launchCampaigns/hybridProduct'
import { compileHybridPublication } from '@/services/launchCampaigns/hybridOffer.service'
import { hybridOfferDefinition } from '@/services/launchCampaigns/hybridOffer.schema'
import { planOfferRenameJob } from '@/jobs/plan-offer-rename.job'
import { ofertaDeRespaldo } from '@/services/billing/planOffer'
import { __resetInterruptorPlanesParaPruebas } from '@/services/billing/interruptorPlanesEditables'
import { definicionDeLaListaDelPlan } from '@tests/__helpers__/planOfferFixtures'

jest.setTimeout(120_000)

const BASE = '/api/v1/superadmin/plan-offer'
const stamp = `${Date.now().toString(36)}${process.pid}`.toUpperCase()
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const CODIGOS_DE_LISTA = ['L_PLAN_PRO', 'L_PLAN_PREMIUM']
const SLUGS_DE_LISTA = ['lista-plan-pro', 'lista-plan-premium']
/** Lo de hoy (la v1), con IVA, en pesos: lo que venden las listas al empezar cada caso. */
const LISTA_V1: Record<Plan, number> = { PRO: 1158.84, PREMIUM: 1970.84 }
/** El recorrido: Pro mensual $799 + IVA ($926.84) y Premium mensual $1,499 + IVA ($1,738.84). */
const PRO_NETO = 79900
const PREMIUM_NETO = 149900
const PRO_BRUTO = Math.round((PRO_NETO * 116) / 100) // 92684
const PREMIUM_BRUTO = Math.round((PREMIUM_NETO * 116) / 100) // 173884

const productos = { PRO: `prod_t9_pro_${stamp}`, PREMIUM: `prod_t9_premium_${stamp}` }
const superadmin = { staffId: '', orgId: '', venueId: '', token: '' }
let versionUnoId: string
let listasSembradas: Record<Plan, { listId: string; publicationId: string }>
const featuresOriginales: Array<{ code: string; existia: boolean; stripeProductId: string | null; active: boolean }> = []
const listasAparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []
let campanasAparcadas: string[] = []
let promocionesAparcadas: string[] = []
/** Los destinatarios de antes de la suite; `null` = todavía no se leyeron (entonces no se restaura nada). */
let ajustesOriginales: { existia: boolean; avisosDelAltaCorreos: string[]; updatedById: string | null } | null = null
/**
 * `true` sólo cuando la guarda de la base desechable pasó. Si la guarda lanzó, Jest igual corre `afterEach` y `afterAll`: su limpieza
 * (borrar toda la oferta, retirar las listas `PLAN:*`, borrar el renglón de `PlatformSettings`) no debe tocar una base que no es la de
 * pruebas.
 */
let preparada = false
/** Lo más que se aparca de cada cosa: si hay más, la suite se detiene antes de tocar nada (nunca deja filas activas en silencio). */
const TOPE_DE_APARCADOS = 100
const misPromociones: string[] = []
let sembradas = 0

// ---------------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------------

const autorizado = () => ({ Authorization: `Bearer ${superadmin.token}` })
const pedir = {
  get: () => request(app).get(BASE).set(autorizado()),
  post: (ruta: string, cuerpo: object = {}) => request(app).post(`${BASE}${ruta}`).set(autorizado()).send(cuerpo),
  put: (ruta: string, cuerpo: object) => request(app).put(`${BASE}${ruta}`).set(autorizado()).send(cuerpo),
}

type CambiosDelPlan = Partial<{ monthlyNetCents: number; annualNetCents: number; displayName: string }>
/** Lo que hace el editor: lee el estado (`GET /`), cambia la entrada que trae y publica sobre su revisión. */
async function publicarPorHttp(cambios: Partial<Record<Plan, CambiosDelPlan>> = { PRO: { monthlyNetCents: PRO_NETO } }) {
  const estado = await pedir.get()
  expect(estado.status).toBe(200)
  const entrada = estado.body.data.vigente.entrada
  for (const tier of ['PRO', 'PREMIUM'] as const) Object.assign(entrada[tier], cambios[tier] ?? {})
  return pedir.post('/publish', { entrada, expectedRevision: estado.body.data.revision })
}
const RECORRIDO = { PRO: { monthlyNetCents: PRO_NETO }, PREMIUM: { monthlyNetCents: PREMIUM_NETO } }
const reintentar = (versionId: string) => pedir.post(`/pending/${versionId}/retry`)
const descartar = (versionId: string) => pedir.post(`/pending/${versionId}/discard`)

// ---------------------------------------------------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------------------------------------------------

const leerVersion = (id: string) => prisma.planOfferVersion.findUniqueOrThrow({ where: { id } })
const elPuntero = () => prisma.planOfferPointer.findUniqueOrThrow({ where: { id: 'vigente' } })
const pendienteId = async () => (await elPuntero()).pendingVersionId as string
const definicion = (v: { definition: unknown }) =>
  v.definition as Record<Plan, Record<'monthly' | 'annual', { stripePriceId: string | null }>>
const ligadasDe = (v: { hybridPublicationIds: unknown }) => v.hybridPublicationIds as Record<Plan, string | null>
const preparacionDe = (v: { preparacion: unknown }) =>
  v.preparacion as { intentos: Record<string, number>; ultimoError: Record<string, unknown> | null }

/** Las dos listas de los planes (la de cada plan), como están en Postgres. */
async function lasListas(): Promise<Record<Plan, { currentPublicationId: string | null; pendingPublicationId: string | null }>> {
  const filas = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: KEYS } },
    select: { listProductKey: true, currentPublicationId: true, pendingPublicationId: true },
    take: 2,
  })
  const de = (tier: Plan) => {
    const fila = filas.find(f => f.listProductKey === `PLAN:${tier}`)
    if (!fila) throw new Error(`No está la lista PLAN:${tier}`)
    return { currentPublicationId: fila.currentPublicationId, pendingPublicationId: fila.pendingPublicationId }
  }
  return { PRO: de('PRO'), PREMIUM: de('PREMIUM') }
}
const precioDeLaPublicacion = async (id: string) =>
  hybridOfferDefinition.parse((await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id } })).definition).terms.price

/** Los precios del almacén de Stripe con esa llave de búsqueda, y cuántas `prices.create` la pidieron. */
const preciosConLlave = (llave: string) => mockAlmacen.store.filter((p: { lookup_key?: string }) => p.lookup_key === llave)
const creacionesConLlave = (llave: string) =>
  mockAlmacen.create.mock.calls.filter((c: unknown[]) => (c[0] as { lookup_key?: string }).lookup_key === llave).length
const llavesDeIdempotencia = () =>
  mockAlmacen.create.mock.calls.map((c: unknown[]) => (c[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey)

// ---------------------------------------------------------------------------------------------------------------------
// Ayudas de cada caso
// ---------------------------------------------------------------------------------------------------------------------

const borrarLaOferta = async () => {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
}

/** Las listas de los planes que dejó un caso anterior (o esta suite): no se pueden borrar, se retiran. */
async function retirarListas() {
  const mias = await prisma.hybridCampaign.findMany({
    where: {
      purpose: 'LIST',
      OR: [{ listProductKey: { in: KEYS } }, { code: { in: CODIGOS_DE_LISTA } }, { slug: { in: SLUGS_DE_LISTA } }],
    },
    select: { id: true },
    take: 10,
  })
  for (const { id } of mias)
    await prisma.hybridCampaign.update({
      where: { id },
      data: {
        listProductKey: `FEATURE:RETIRED_${id}`,
        code: `RETIRED_${id}`,
        slug: `retired-${id}`,
        status: 'PAUSED',
        pendingPublicationId: null,
      },
    })
}

/** Las dos listas en venta al precio de la v1, cada una con su publicación vigente ya preparada en Stripe (como tras B0). */
async function sembrarListas() {
  const sembrada = async (tier: Plan) => {
    const compiled = compileHybridPublication(definicionDeLaListaDelPlan(tier, LISTA_V1[tier]))
    const sufijo = tier.toLowerCase()
    const nombre = `Plan ${tier === 'PRO' ? 'Pro' : 'Premium'}`
    const lista = await prisma.hybridCampaign.create({
      data: {
        purpose: 'LIST',
        listProductKey: `PLAN:${tier}`,
        code: `L_PLAN_${tier}`,
        slug: `lista-plan-${sufijo}`,
        name: nombre,
        draftDefinition: compiled.definition as never,
        startsAt: new Date(),
        audience: 'ALL',
        listed: true,
        status: 'ACTIVE',
        revision: 2,
        createdById: superadmin.staffId,
      },
    })
    const marca = `${stamp}_${++sembradas}`
    const publicacion = await prisma.hybridOfferPublication.create({
      data: {
        campaignId: lista.id,
        version: 1,
        name: nombre,
        definition: compiled.definition as never,
        definitionHash: compiled.definitionHash,
        includedFeatureCodes: compiled.includedFeatureCodes,
        stripeProductId: `prod_t9_lista_${sufijo}_${marca}`,
        stripePriceId: `price_t9_lista_${sufijo}_${marca}`,
        createdById: superadmin.staffId,
      },
    })
    await prisma.hybridCampaign.update({ where: { id: lista.id }, data: { currentPublicationId: publicacion.id } })
    return { listId: lista.id, publicationId: publicacion.id }
  }
  listasSembradas = { PRO: await sembrada('PRO'), PREMIUM: await sembrada('PREMIUM') }
}

/** La v1 sembrada (lo de hoy, con los priceId de las llaves) y el interruptor prendido. */
async function reiniciarLaOferta() {
  const d = ofertaDeRespaldo()
  d.PRO.monthly.stripePriceId = 'price_key_pro_m'
  d.PRO.annual.stripePriceId = 'price_key_pro_a'
  d.PREMIUM.monthly.stripePriceId = 'price_key_premium_m'
  d.PREMIUM.annual.stripePriceId = 'price_key_premium_a'
  const v1 = await prisma.planOfferVersion.create({
    data: {
      status: 'PUBLISHED',
      number: 1,
      definition: d as never,
      createdById: superadmin.staffId,
      publishedById: superadmin.staffId,
      publishedAt: new Date(),
    },
  })
  versionUnoId = v1.id
  await prisma.planOfferPointer.create({ data: { id: 'vigente', currentVersionId: v1.id, revision: 1 } })
  await prisma.interruptorDePlataforma.create({
    data: { clave: 'PLANES_EDITABLES', desde: new Date(), actualizadoPor: superadmin.staffId },
  })
  __resetInterruptorPlanesParaPruebas()
}

/** Una promoción ACTIVE de `PLAN:PRO` a `precio` pesos (escrita directo en la base, como la deja activar una promoción). */
async function promocionActivaDePro(precio: number): Promise<string> {
  const compiled = compileHybridPublication({
    schemaVersion: 1,
    kind: 'PLAN',
    planTier: 'PRO',
    terms: {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: precio,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    },
  })
  const code = `T9PROMO${stamp}${misPromociones.length + 1}`
  const campana = await prisma.hybridCampaign.create({
    data: {
      code,
      slug: code.toLowerCase(),
      name: `Promoción ${code}`,
      draftDefinition: compiled.definition as never,
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 7 * 86_400_000),
      capacity: 10,
      audience: 'ALL',
      listed: false,
      purpose: 'PROMOTION',
      status: 'ACTIVE',
      revision: 2,
      createdById: superadmin.staffId,
    },
  })
  misPromociones.push(campana.id)
  const publicacion = await prisma.hybridOfferPublication.create({
    data: {
      campaignId: campana.id,
      version: 1,
      name: campana.name,
      definition: compiled.definition as never,
      definitionHash: compiled.definitionHash,
      includedFeatureCodes: compiled.includedFeatureCodes,
      createdById: superadmin.staffId,
    },
  })
  await prisma.hybridCampaign.update({ where: { id: campana.id }, data: { currentPublicationId: publicacion.id } })
  return campana.id
}

/** Detiene la siguiente preparación de Stripe de la lista de ese plan (después de estampar sus ids). */
function detenerLaLista(tier: Plan): MockPausa {
  const pausa = mockNuevaPausa()
  mockListas.pausa = { tier, pausa }
  return pausa
}

/** Una operación que corre en segundo plano: su rechazo se observa después (o en el `finally`), nunca queda suelto. */
function enSegundoPlano<T>(p: Promise<T>): Promise<T> {
  p.catch(() => undefined)
  return p
}

/** Espera a que la operación llegue a la pausa; si termina antes (bien o mal), falla de inmediato en vez de colgarse. */
async function hastaQueLlegue(llego: Promise<void>, operacion: Promise<unknown>) {
  const termino = operacion.then(
    () => {
      throw new Error('La operación terminó sin llegar a su pausa')
    },
    error => {
      throw error
    },
  )
  termino.catch(() => undefined)
  await Promise.race([llego, termino])
}

const asentar = (...operaciones: Array<Promise<unknown> | undefined>) =>
  Promise.allSettled(operaciones.filter((o): o is Promise<unknown> => o !== undefined))

async function hastaQue(condicion: () => boolean | Promise<boolean>, que: string) {
  for (let i = 0; i < 400; i++) {
    if (await condicion()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`No se cumplió: ${que}`)
}
const renombreCorriendo = () => Reflect.get(planOfferRenameJob, 'corriendo') === true

// ---------------------------------------------------------------------------------------------------------------------
// Antes y después
// ---------------------------------------------------------------------------------------------------------------------

/** Aparca a lo más `TOPE_DE_APARCADOS`; con más, falla en voz alta (antes de cambiar nada). */
function dentroDelTope<T>(filas: T[], que: string): T[] {
  if (filas.length > TOPE_DE_APARCADOS)
    throw new Error(`Hay más de ${TOPE_DE_APARCADOS} ${que}: la suite no aparca sólo una parte y se detiene sin tocarlas`)
  return filas
}

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  preparada = true
  // Los destinatarios de hoy (el renglón es único y compartido), antes de cambiar nada: vuelven a como estaban.
  const ajustes = await prisma.platformSettings.findUnique({
    where: { id: 'default' },
    select: { avisosDelAltaCorreos: true, updatedById: true },
  })
  ajustesOriginales = {
    existia: !!ajustes,
    avisosDelAltaCorreos: ajustes?.avisosDelAltaCorreos ?? [],
    updatedById: ajustes?.updatedById ?? null,
  }
  await borrarLaOferta()
  // El SUPERADMIN de verdad: persona activa con su fila SUPERADMIN activa (la relee `rolVigente` en cada petición).
  const org = await prisma.organization.create({
    data: { name: `Planes T9 ${stamp}`, email: `planes-t9-${stamp.toLowerCase()}@example.com`, phone: '5555555555' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Planes T9 ${stamp}`, slug: `planes-t9-${stamp.toLowerCase()}` },
  })
  const staff = await prisma.staff.create({
    data: { email: `superadmin-t9-${stamp.toLowerCase()}@example.com`, firstName: 'Súper', lastName: 'Prueba' },
  })
  Object.assign(superadmin, { staffId: staff.id, orgId: org.id, venueId: venue.id })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'SUPERADMIN', active: true } })
  superadmin.token = jwt.sign(
    { sub: staff.id, orgId: org.id, venueId: venue.id, role: 'SUPERADMIN' },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h' },
  )
  // Los productos de Stripe de los planes (los que lee el publicador), sin perder lo que había.
  for (const [code, product] of [
    ['PLAN_PRO', productos.PRO],
    ['PLAN_PREMIUM', productos.PREMIUM],
  ] as const) {
    const antes = await prisma.feature.findUnique({ where: { code } })
    featuresOriginales.push({ code, existia: !!antes, stripeProductId: antes?.stripeProductId ?? null, active: antes?.active ?? true })
    await prisma.feature.upsert({
      where: { code },
      create: {
        code,
        name: code === 'PLAN_PRO' ? 'Plan Pro' : 'Plan Premium',
        category: 'OPERATIONS',
        monthlyPrice: 999,
        stripeProductId: product,
      },
      update: { stripeProductId: product, active: true },
    })
  }
  // Las listas de los planes que dejaron otras suites: aparcadas durante la corrida (se guardan ANTES de cambiarlas: si una falla,
  // `afterAll` devuelve las que sí cambió).
  const listas = dentroDelTope(
    await prisma.hybridCampaign.findMany({
      where: {
        purpose: 'LIST',
        OR: [{ listProductKey: { in: KEYS } }, { code: { in: CODIGOS_DE_LISTA } }, { slug: { in: SLUGS_DE_LISTA } }],
      },
      select: { id: true, listProductKey: true, code: true, slug: true },
      orderBy: { id: 'asc' },
      take: TOPE_DE_APARCADOS + 1,
    }),
    'listas de planes que aparcar',
  )
  for (const lista of listas) {
    await prisma.hybridCampaign.update({
      where: { id: lista.id },
      data: { listProductKey: `FEATURE:PARKED_${lista.id}`, code: `PARKED_${lista.id}`, slug: `parked-${lista.id}` },
    })
    listasAparcadas.push(lista)
  }
  // Una campaña ACTIVE de otra suite bloquearía publicar: se pausa durante la corrida.
  const campanas = dentroDelTope(
    await prisma.launchCampaign.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: TOPE_DE_APARCADOS + 1,
    }),
    'campañas ACTIVE',
  ).map(c => c.id)
  if (campanas.length) {
    await prisma.launchCampaign.updateMany({ where: { id: { in: campanas } }, data: { status: 'PAUSED' } })
    campanasAparcadas = campanas
  }
  // Una promoción ACTIVE de un plan que dejó otra suite podría romper la regla del precio de lista: se pausa durante la corrida.
  const promociones = dentroDelTope(
    await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "HybridCampaign" c JOIN "HybridOfferPublication" p ON p.id = c."currentPublicationId"
      WHERE c.purpose = 'PROMOTION' AND c.status = 'ACTIVE' AND ${productKeySql('p')} IN (${'PLAN:PRO'}, ${'PLAN:PREMIUM'})
      ORDER BY c.id LIMIT ${TOPE_DE_APARCADOS + 1}`,
    'promociones ACTIVE de los planes',
  ).map(c => c.id)
  if (promociones.length) {
    await prisma.hybridCampaign.updateMany({ where: { id: { in: promociones } }, data: { status: 'PAUSED' } })
    promocionesAparcadas = promociones
  }
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
  await hastaQue(() => !renombreCorriendo(), 'el renombre en segundo plano terminó').catch(() => undefined)
  await paso('borrar la oferta', borrarLaOferta)
  __resetInterruptorPlanesParaPruebas()
  if (misPromociones.length)
    await paso('terminar las promociones de la suite', () =>
      prisma.hybridCampaign.updateMany({ where: { id: { in: misPromociones } }, data: { status: 'ENDED' } }),
    )
  if (campanasAparcadas.length)
    await paso('reactivar las campañas aparcadas', () =>
      prisma.launchCampaign.updateMany({ where: { id: { in: campanasAparcadas } }, data: { status: 'ACTIVE' } }),
    )
  if (promocionesAparcadas.length)
    await paso('reactivar las promociones aparcadas', () =>
      prisma.hybridCampaign.updateMany({ where: { id: { in: promocionesAparcadas } }, data: { status: 'ACTIVE' } }),
    )
  await paso('retirar las listas de la suite', retirarListas)
  for (const { id, listProductKey, code, slug } of listasAparcadas)
    await paso(`devolver la lista aparcada ${id}`, () =>
      prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } }),
    )
  for (const f of featuresOriginales)
    await paso(`devolver la función ${f.code}`, () =>
      f.existia
        ? prisma.feature.update({ where: { code: f.code }, data: { stripeProductId: f.stripeProductId, active: f.active } })
        : prisma.feature.deleteMany({ where: { code: f.code } }),
    )
  const ajustes = ajustesOriginales
  if (ajustes)
    await paso('devolver los destinatarios de PlatformSettings', () =>
      ajustes.existia
        ? prisma.platformSettings.update({
            where: { id: 'default' },
            data: { avisosDelAltaCorreos: ajustes.avisosDelAltaCorreos, updatedById: ajustes.updatedById },
          })
        : prisma.platformSettings.deleteMany({ where: { id: 'default' } }),
    )
  // Su bitácora queda (sin actor: `staffId` es SET NULL); la persona, su fila, el negocio y la organización de prueba se van.
  if (superadmin.staffId)
    await paso('borrar al SUPERADMIN de prueba', async () => {
      await prisma.staffVenue.deleteMany({ where: { staffId: superadmin.staffId } })
      await prisma.venue.deleteMany({ where: { id: superadmin.venueId } })
      await prisma.organization.deleteMany({ where: { id: superadmin.orgId } })
      await prisma.staff.deleteMany({ where: { id: superadmin.staffId } })
    })
  if (errores.length) throw new Error(`La limpieza de plan-offer.http no quedó completa:\n- ${errores.join('\n- ')}`)
})

beforeEach(async () => {
  if (!preparada) return
  mockAlmacen.reset()
  mockListas.falla = null
  mockListas.pausa = null
  mockListas.llamadas = []
  jest.mocked(ensureHybridPublicationPrices).mockClear()
  await borrarLaOferta()
  await retirarListas()
  await sembrarListas()
  await reiniciarLaOferta()
})

afterEach(async () => {
  // Una pausa que quedó armada no detiene a la siguiente prueba, y lo que corre en segundo plano termina antes de borrar la oferta.
  mockListas.pausa?.pausa.soltar()
  mockListas.pausa = null
  if (!preparada) return
  if (misPromociones.length) await prisma.hybridCampaign.updateMany({ where: { id: { in: misPromociones } }, data: { status: 'ENDED' } })
  await hastaQue(() => !renombreCorriendo(), 'el renombre en segundo plano terminó')
})

// ---------------------------------------------------------------------------------------------------------------------
// El recorrido
// ---------------------------------------------------------------------------------------------------------------------

describe('POST /api/v1/superadmin/plan-offer: publicar, reintentar y descartar (Postgres real)', () => {
  it('recorrido: sembrar v1 → prender → POST /preview y POST /publish con Pro mensual 79900 y Premium mensual 149900', async () => {
    // Apagado: publicar se niega sin crear nada.
    await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
    __resetInterruptorPlanesParaPruebas()
    const apagado = await publicarPorHttp(RECORRIDO)
    expect(apagado.status).toBe(409)
    expect(apagado.body.code).toBe('PLAN_EDIT_DISABLED')
    expect(await prisma.planOfferVersion.count()).toBe(1)

    // Prender por la ruta: con la v1 sembrada y el SERVIDOR listo, no falta nada.
    const prendido = await pedir.post('/interruptor', { prendido: true })
    expect(prendido.status).toBe(200)
    expect(prendido.body.data).toMatchObject({ prendido: true, actualizadoPor: superadmin.staffId, faltan: [] })
    expect(prendido.body.data.desde).toEqual(expect.any(String))

    // Vista previa: lo que cambia, qué precios nuevos pide y nada escrito.
    const estado = await pedir.get()
    expect(estado.body.data).toMatchObject({ revision: 1, vigente: { number: 1, versionId: versionUnoId }, pendiente: null })
    const entrada = estado.body.data.vigente.entrada
    entrada.PRO.monthlyNetCents = PRO_NETO
    entrada.PREMIUM.monthlyNetCents = PREMIUM_NETO
    const vista = await pedir.post('/preview', { entrada })
    expect(vista.status).toBe(200)
    expect(vista.body.data).toMatchObject({
      cambios: [
        { plan: 'PRO', campo: 'monthlyNetCents', antes: 99900, despues: PRO_NETO },
        { plan: 'PREMIUM', campo: 'monthlyNetCents', antes: 169900, despues: PREMIUM_NETO },
      ],
      preciosNuevos: ['PRO:monthly', 'PREMIUM:monthly'],
      bloqueos: { campanas: [], promociones: [] },
      problemas: [],
    })
    expect(Object.keys(vista.body.data.conservanSuPrecio).sort()).toEqual([
      'PREMIUM:annual',
      'PREMIUM:monthly',
      'PRO:annual',
      'PRO:monthly',
    ])
    expect(await prisma.planOfferVersion.count()).toBe(1)
    expect(mockAlmacen.create).not.toHaveBeenCalled()
    expect(mockListas.llamadas).toEqual([])

    // Publicar exactamente esa entrada.
    const publicado = await pedir.post('/publish', { entrada, expectedRevision: 1 })
    expect(publicado.status).toBe(200)
    const versionId = publicado.body.data.publicada.versionId as string
    expect(publicado.body.data.publicada).toEqual({ number: 2, versionId })
    expect(publicado.body.data.estado).toMatchObject({
      revision: 3,
      vigente: { number: 2, versionId, entrada: { PRO: { monthlyNetCents: PRO_NETO }, PREMIUM: { monthlyNetCents: PREMIUM_NETO } } },
      pendiente: null,
      interruptor: { prendido: true },
    })

    // En Postgres: v1 SUPERSEDED, v2 PUBLISHED con los precios nuevos, el puntero en v2 y las dos listas al mensual nuevo.
    expect((await leerVersion(versionUnoId)).status).toBe('SUPERSEDED')
    const v2 = await leerVersion(versionId)
    expect(v2).toMatchObject({ status: 'PUBLISHED', number: 2, basedOnVersionId: versionUnoId, publishedById: superadmin.staffId })
    const [proMensual] = preciosConLlave(`po_${versionId}_pro_monthly`)
    const [premiumMensual] = preciosConLlave(`po_${versionId}_premium_monthly`)
    expect(proMensual).toMatchObject({ product: productos.PRO, unit_amount: PRO_BRUTO, currency: 'mxn', tax_behavior: 'inclusive' })
    expect(premiumMensual).toMatchObject({ product: productos.PREMIUM, unit_amount: PREMIUM_BRUTO })
    expect(mockAlmacen.store).toHaveLength(2)
    expect(definicion(v2).PRO.monthly.stripePriceId).toBe(proMensual.id)
    expect(definicion(v2).PREMIUM.monthly.stripePriceId).toBe(premiumMensual.id)
    // Lo que no cambió conserva el precio de la llave.
    expect(definicion(v2).PRO.annual.stripePriceId).toBe('price_key_pro_a')
    expect(definicion(v2).PREMIUM.annual.stripePriceId).toBe('price_key_premium_a')
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionId, pendingVersionId: null, revision: 3 })
    const listas = await lasListas()
    const ligadas = ligadasDe(v2)
    expect(listas.PRO).toEqual({ currentPublicationId: ligadas.PRO, pendingPublicationId: null })
    expect(listas.PREMIUM).toEqual({ currentPublicationId: ligadas.PREMIUM, pendingPublicationId: null })
    expect(await precioDeLaPublicacion(ligadas.PRO as string)).toBe(PRO_BRUTO / 100)
    expect(await precioDeLaPublicacion(ligadas.PREMIUM as string)).toBe(PREMIUM_BRUTO / 100)
    expect(
      await prisma.activityLog.count({ where: { action: 'PLAN_OFFER_PUBLISHED', entityId: versionId, staffId: superadmin.staffId } }),
    ).toBe(1)
  })

  it('🔴 respuesta perdida del mensual de Pro: 409 PLAN_OFFER_PREPARING; reintentar lo recupera por po_<id>_pro_monthly → 200 número 2; v1 SUPERSEDED', async () => {
    mockAlmacen.loseNextCreateResponse = true

    const fallo = await publicarPorHttp(RECORRIDO)
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    expect(fallo.body).toMatchObject({
      code: 'PLAN_OFFER_PREPARING',
      details: { versionId, etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'INCIERTO' },
    })
    // Stripe sí lo creó; la versión no lo sabe todavía (y el intento no sube: fue incierto).
    const llave = `po_${versionId}_pro_monthly`
    expect(preciosConLlave(llave)).toHaveLength(1)
    let fila = await leerVersion(versionId)
    expect(definicion(fila).PRO.monthly.stripePriceId).toBeNull()
    expect(preparacionDe(fila).intentos.PRO_monthly).toBe(0)

    const reintento = await reintentar(versionId)
    expect(reintento.status).toBe(200)
    expect(reintento.body.data.publicada).toEqual({ number: 2, versionId })
    expect(reintento.body.data.estado).toMatchObject({ vigente: { number: 2, versionId }, pendiente: null })

    // Lo recuperó por su llave de búsqueda: un solo precio con esa llave y una sola creación.
    expect(preciosConLlave(llave)).toHaveLength(1)
    expect(creacionesConLlave(llave)).toBe(1)
    fila = await leerVersion(versionId)
    expect(fila).toMatchObject({ status: 'PUBLISHED', number: 2 })
    expect(definicion(fila).PRO.monthly.stripePriceId).toBe(preciosConLlave(llave)[0].id)
    expect((await leerVersion(versionUnoId)).status).toBe('SUPERSEDED')
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionId, pendingVersionId: null })
  })

  it('🔴 un 500 guardado por Stripe para la llave: reintentar repite la misma llave y vuelve a dar 409; descartar deja la vigente y la versión DISCARDED', async () => {
    mockAlmacen.failNextCreateWith = { statusCode: 500 }

    const fallo = await publicarPorHttp(RECORRIDO)
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    expect(fallo.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { ranura: 'PRO:monthly', motivo: 'INCIERTO' } })

    const otraVez = await reintentar(versionId)
    expect(otraVez.status).toBe(409)
    expect(otraVez.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { versionId, ranura: 'PRO:monthly', motivo: 'INCIERTO' } })
    // La MISMA llave de idempotencia las dos veces (el 500 es incierto: el intento no sube); Stripe repitió su 500 y no creó nada.
    const llave = `plan-offer-price:${versionId}:PRO:monthly:0`
    expect(llavesDeIdempotencia()).toEqual([llave, llave])
    expect(mockAlmacen.store).toHaveLength(0)
    expect(preparacionDe(await leerVersion(versionId)).intentos.PRO_monthly).toBe(0)

    const descartado = await descartar(versionId)
    expect(descartado.status).toBe(200)
    expect(descartado.body.data).toMatchObject({ vigente: { number: 1, versionId: versionUnoId }, pendiente: null })
    expect(await leerVersion(versionId)).toMatchObject({ status: 'DISCARDED', number: null, discardedById: superadmin.staffId })
    expect((await leerVersion(versionUnoId)).status).toBe('PUBLISHED')
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: null })
  })

  it('🔴 descartar después de ligar las listas: falla la preparación de Stripe de la lista PLAN:PRO (después de PREMIUM)', async () => {
    mockListas.falla = 'PRO'

    const fallo = await publicarPorHttp(RECORRIDO)
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    expect(fallo.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { versionId, etapa: 'LISTA', motivo: 'INCIERTO' } })
    // PREMIUM se preparó primero; PRO falló.
    expect(mockListas.llamadas.map((l: { tier: string }) => l.tier)).toEqual(['PREMIUM', 'PRO'])

    // ANTES del descarte: las dos listas tienen pendiente justo la publicación que la versión ligó; las vigentes siguen siendo las de v1.
    const ligadas = ligadasDe(await leerVersion(versionId))
    expect(ligadas.PRO).toEqual(expect.any(String))
    expect(ligadas.PREMIUM).toEqual(expect.any(String))
    const antes = await lasListas()
    expect(antes.PREMIUM).toEqual({ currentPublicationId: listasSembradas.PREMIUM.publicationId, pendingPublicationId: ligadas.PREMIUM })
    expect(antes.PRO).toEqual({ currentPublicationId: listasSembradas.PRO.publicationId, pendingPublicationId: ligadas.PRO })

    const descartado = await descartar(versionId)
    expect(descartado.status).toBe(200)
    expect(descartado.body.data).toMatchObject({ vigente: { number: 1, versionId: versionUnoId }, pendiente: null })

    // DESPUÉS: las dos pendientes sueltas, las vigentes iguales y el puntero en v1.
    const despues = await lasListas()
    expect(despues.PREMIUM).toEqual({ currentPublicationId: antes.PREMIUM.currentPublicationId, pendingPublicationId: null })
    expect(despues.PRO).toEqual({ currentPublicationId: antes.PRO.currentPublicationId, pendingPublicationId: null })
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: null })
    expect((await leerVersion(versionId)).status).toBe('DISCARDED')
  })

  it('🔴 falla la SEGUNDA lista al mover: con la preparación detenida se activa una promoción de PLAN:PRO por encima del mensual nuevo; al soltarla, finalizar PLAN:PREMIUM pasa y PLAN:PRO da 409 HYBRID_LIST_BREAKS_PROMOTIONS', async () => {
    const pausa = detenerLaLista('PRO')
    let publicacion: Promise<request.Response> | undefined
    let promocion = ''
    try {
      publicacion = enSegundoPlano(publicarPorHttp(RECORRIDO))
      await hastaQueLlegue(pausa.llego, publicacion)
      // La lista de PRO ya se ligó y revisó su regla con lo que había; ahora se activa una promoción de $1,000 (≥ $926.84).
      promocion = await promocionActivaDePro(1000)
    } finally {
      pausa.soltar()
      await asentar(publicacion)
    }

    const res = (await publicacion) as request.Response
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'HYBRID_LIST_BREAKS_PROMOTIONS',
      details: [expect.objectContaining({ campaignId: promocion, price: 1000, listPrice: PRO_BRUTO / 100 })],
    })

    // En Postgres nada se movió: las vigentes de las dos listas (también PREMIUM, que sí pasó), el puntero en v1 y la versión PREPARING.
    const versionId = await pendienteId()
    const listas = await lasListas()
    expect(listas.PREMIUM.currentPublicationId).toBe(listasSembradas.PREMIUM.publicationId)
    expect(listas.PRO.currentPublicationId).toBe(listasSembradas.PRO.publicationId)
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: versionId })
    const fila = await leerVersion(versionId)
    expect(fila.status).toBe('PREPARING')
    expect(fila.number).toBeNull()
    expect(preparacionDe(fila).ultimoError).toMatchObject({
      etapa: 'MOVIMIENTO',
      motivo: 'HYBRID_LIST_BREAKS_PROMOTIONS',
    })
  })

  it('🔴 cambiando mensual y anual de Pro, el anual se crea y su respuesta se pierde → el reintento lo recupera por su llave y no lo duplica', async () => {
    mockAlmacen.loseNextCreateResponse = (params: { lookup_key?: string }) => String(params.lookup_key).endsWith('_pro_annual')

    const fallo = await publicarPorHttp({ PRO: { monthlyNetCents: PRO_NETO, annualNetCents: 799000 } })
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    expect(fallo.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { ranura: 'PRO:annual', motivo: 'INCIERTO' } })
    const mensual = `po_${versionId}_pro_monthly`
    const anual = `po_${versionId}_pro_annual`
    // El mensual quedó guardado; el anual existe en Stripe, pero la versión no lo sabe.
    let fila = await leerVersion(versionId)
    expect(definicion(fila).PRO.monthly.stripePriceId).toBe(preciosConLlave(mensual)[0].id)
    expect(definicion(fila).PRO.annual.stripePriceId).toBeNull()
    expect(preciosConLlave(anual)).toHaveLength(1)

    const reintento = await reintentar(versionId)
    expect(reintento.status).toBe(200)
    expect(reintento.body.data.publicada).toEqual({ number: 2, versionId })

    expect(preciosConLlave(mensual)).toHaveLength(1)
    expect(preciosConLlave(anual)).toHaveLength(1)
    expect(creacionesConLlave(mensual)).toBe(1)
    expect(creacionesConLlave(anual)).toBe(1)
    fila = await leerVersion(versionId)
    expect(definicion(fila).PRO.annual.stripePriceId).toBe(preciosConLlave(anual)[0].id)
    expect(preciosConLlave(anual)[0]).toMatchObject({ unit_amount: Math.round((799000 * 116) / 100), recurring: { interval: 'year' } })
  })

  it('🔴 reintentar después de ligar las listas (falló la preparación de Stripe de PLAN:PRO): el reintento vuelve a preparar esa publicación y, antes de moverla, en Postgres tiene stripePriceId y stripeProductId; luego 200', async () => {
    mockListas.falla = 'PRO'
    const fallo = await publicarPorHttp(RECORRIDO)
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    const ligadas = ligadasDe(await leerVersion(versionId))
    const pro = ligadas.PRO as string
    // La que falló quedó ligada sin sus ids de Stripe.
    expect(await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: pro } })).toMatchObject({
      stripePriceId: null,
      stripeProductId: null,
    })

    const pausa = detenerLaLista('PRO')
    let reintento: Promise<request.Response> | undefined
    try {
      mockListas.llamadas = []
      reintento = enSegundoPlano(reintentar(versionId).then(r => r))
      await hastaQueLlegue(pausa.llego, reintento)
      // Vuelve a preparar ESA publicación (no crea otra) y, antes del movimiento, ya trae sus ids; nada se movió todavía.
      expect(mockListas.llamadas[mockListas.llamadas.length - 1]).toEqual({ id: pro, tier: 'PRO' })
      expect(await prisma.hybridOfferPublication.findUniqueOrThrow({ where: { id: pro } })).toMatchObject({
        stripePriceId: `price_t9_${pro}`,
        stripeProductId: `prod_t9_${pro}`,
      })
      expect(ligadasDe(await leerVersion(versionId))).toEqual(ligadas)
      expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: versionId })
      expect((await lasListas()).PRO.currentPublicationId).toBe(listasSembradas.PRO.publicationId)
    } finally {
      pausa.soltar()
      await asentar(reintento)
    }

    const res = (await reintento) as request.Response
    expect(res.status).toBe(200)
    expect(res.body.data.publicada).toEqual({ number: 2, versionId })
    const listas = await lasListas()
    expect(listas.PRO).toEqual({ currentPublicationId: pro, pendingPublicationId: null })
    expect(listas.PREMIUM).toEqual({ currentPublicationId: ligadas.PREMIUM, pendingPublicationId: null })
  })

  it('🔴 un 400 definitivo de Stripe en el mensual de Pro: el siguiente reintento llama a prices.create con plan-offer-price:<id>:PRO:monthly:1 (Postgres real)', async () => {
    mockAlmacen.failNextCreateWith = { statusCode: 400, code: 'parameter_invalid' }

    const fallo = await publicarPorHttp()
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    expect(fallo.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { ranura: 'PRO:monthly', motivo: 'RECHAZADO' } })
    // El intento subió en Postgres ANTES de responder.
    expect(preparacionDe(await leerVersion(versionId)).intentos.PRO_monthly).toBe(1)

    const reintento = await reintentar(versionId)
    expect(reintento.status).toBe(200)
    expect(reintento.body.data.publicada).toEqual({ number: 2, versionId })
    expect(llavesDeIdempotencia()).toEqual([`plan-offer-price:${versionId}:PRO:monthly:0`, `plan-offer-price:${versionId}:PRO:monthly:1`])
    expect(preciosConLlave(`po_${versionId}_pro_monthly`)).toHaveLength(1)
  })

  it('una segunda publicación durante PREPARING → 409 PLAN_OFFER_PENDING', async () => {
    mockAlmacen.failNextCreateWith = { statusCode: 500 }
    const primera = await publicarPorHttp()
    expect(primera.status).toBe(409)
    const pendiente = await pendienteId()

    // Sobre la revisión actual (no es una revisión vieja): la otra sigue pendiente.
    const segunda = await publicarPorHttp({ PRO: { monthlyNetCents: 89900 } })
    expect(segunda.status).toBe(409)
    expect(segunda.body).toMatchObject({ code: 'PLAN_OFFER_PENDING', details: { pendingVersionId: pendiente } })
    expect(await prisma.planOfferVersion.count()).toBe(2)
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: pendiente })
  })

  it('apagar el interruptor a media publicación: el movimiento se niega y descartar sigue funcionando', async () => {
    const pausa = detenerLaLista('PRO')
    let publicacion: Promise<request.Response> | undefined
    try {
      publicacion = enSegundoPlano(publicarPorHttp(RECORRIDO))
      await hastaQueLlegue(pausa.llego, publicacion)
      const apagado = await pedir.post('/interruptor', { prendido: false })
      expect(apagado.status).toBe(200)
      expect(apagado.body.data).toMatchObject({ prendido: false, desde: null, actualizadoPor: superadmin.staffId })
    } finally {
      pausa.soltar()
      await asentar(publicacion)
    }

    const res = (await publicacion) as request.Response
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_EDIT_DISABLED')
    const versionId = await pendienteId()
    expect((await leerVersion(versionId)).status).toBe('PREPARING')
    const listas = await lasListas()
    expect(listas.PRO.currentPublicationId).toBe(listasSembradas.PRO.publicationId)
    expect(listas.PREMIUM.currentPublicationId).toBe(listasSembradas.PREMIUM.publicationId)

    // Descartar no pide el interruptor.
    const descartado = await descartar(versionId)
    expect(descartado.status).toBe(200)
    expect(descartado.body.data).toMatchObject({ vigente: { number: 1 }, pendiente: null, interruptor: { prendido: false } })
    expect((await leerVersion(versionId)).status).toBe('DISCARDED')
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: null })
    const sueltas = await lasListas()
    expect(sueltas.PRO.pendingPublicationId).toBeNull()
    expect(sueltas.PREMIUM.pendingPublicationId).toBeNull()
  })

  /**
   * Publica (con la falla que ya armó el caso), apaga por la ruta y reintenta: 409 `PLAN_EDIT_DISABLED`, ninguna llamada a Stripe (ni a
   * sus precios ni a la preparación de las listas) y la versión y las listas como estaban. Devuelve la versión, para lo que sigue.
   */
  async function reintentarApagadoNoTocaNada() {
    const fallo = await publicarPorHttp(RECORRIDO)
    expect(fallo.status).toBe(409)
    const versionId = await pendienteId()
    const versionAntes = await leerVersion(versionId)
    const listasAntes = await lasListas()

    const apagado = await pedir.post('/interruptor', { prendido: false })
    expect(apagado.status).toBe(200)
    mockAlmacen.list.mockClear()
    mockAlmacen.create.mockClear()
    mockListas.llamadas = []

    const reintento = await reintentar(versionId)
    expect(reintento.status).toBe(409)
    expect(reintento.body.code).toBe('PLAN_EDIT_DISABLED')

    expect(mockAlmacen.list).not.toHaveBeenCalled()
    expect(mockAlmacen.create).not.toHaveBeenCalled()
    expect(mockListas.llamadas).toEqual([])
    const versionDespues = await leerVersion(versionId)
    expect(versionDespues.status).toBe('PREPARING')
    expect(versionDespues.definition).toEqual(versionAntes.definition)
    expect(versionDespues.preparacion).toEqual(versionAntes.preparacion)
    expect(versionDespues.hybridPublicationIds).toEqual(versionAntes.hybridPublicationIds)
    expect(await lasListas()).toEqual(listasAntes)
    return { versionId, versionAntes, listasAntes }
  }

  it('🔴 POST /pending/:versionId/retry después de apagar → 409 PLAN_EDIT_DISABLED; el almacén de Stripe no recibió ninguna llamada y en Postgres la versión, sus ranuras, hybridPublicationIds y las pendientes de las listas siguen iguales', async () => {
    // Falló la preparación de Stripe de la lista de PRO: los cuatro precios ya existen. Aquí lo que muerde es `mockListas.llamadas`
    // (con el interruptor prendido, el reintento volvería a preparar las dos listas); el almacén de precios no se tocaría de todos modos.
    // La variante de abajo es la que hace morder al almacén.
    mockListas.falla = 'PRO'
    const { listasAntes } = await reintentarApagadoNoTocaNada()
    expect(listasAntes.PRO.pendingPublicationId).not.toBeNull()
  })

  it('🔴 la misma negativa con un precio sin crear (Stripe guardó un 500 en el mensual de Pro): ni prices.list ni prices.create; al prender, el mismo reintento sí llega a Stripe', async () => {
    mockAlmacen.failNextCreateWith = { statusCode: 500 }
    const { versionId, versionAntes } = await reintentarApagadoNoTocaNada()
    // Falta un precio: con el interruptor prendido, el reintento lo buscaría y lo pediría. Apagado, el almacén quedó en cero (arriba).
    expect(definicion(versionAntes).PRO.monthly.stripePriceId).toBeNull()

    // La prueba de que esas dos aserciones muerden: prendido, el MISMO reintento sí llama a Stripe (y le repite su 500 guardado).
    const prendido = await pedir.post('/interruptor', { prendido: true })
    expect(prendido.status).toBe(200)
    const conStripe = await reintentar(versionId)
    expect(conStripe.status).toBe(409)
    expect(conStripe.body).toMatchObject({ code: 'PLAN_OFFER_PREPARING', details: { ranura: 'PRO:monthly', motivo: 'INCIERTO' } })
    expect(mockAlmacen.list).toHaveBeenCalled()
    expect(llavesDeIdempotencia()).toEqual([`plan-offer-price:${versionId}:PRO:monthly:0`])
  })
})

describe('PUT /api/v1/superadmin/plan-offer/recipients (Postgres real)', () => {
  it('guarda la lista normalizada en PlatformSettings, con bitácora, y GET / la trae en destinatarios', async () => {
    const guardado = await pedir.put('/recipients', { correos: ['  Ventas@Example.COM ', 'ventas@example.com', 'ops@example.com'] })
    expect(guardado.status).toBe(200)
    expect(guardado.body.data).toEqual({ correos: ['ventas@example.com', 'ops@example.com'] })

    const fila = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 'default' } })
    expect(fila.avisosDelAltaCorreos).toEqual(['ventas@example.com', 'ops@example.com'])
    expect(fila.updatedById).toBe(superadmin.staffId)
    await hastaQue(
      async () => (await prisma.activityLog.count({ where: { action: 'PLATFORM_SETTINGS_UPDATED', staffId: superadmin.staffId } })) > 0,
      'la bitácora de los destinatarios',
    )

    const estado = await pedir.get()
    expect(estado.body.data.destinatarios).toEqual(['ventas@example.com', 'ops@example.com'])

    // Uno inválido: 400 y la lista no cambia. Con el interruptor apagado también se guarda.
    const invalido = await pedir.put('/recipients', { correos: ['no-es-correo'] })
    expect(invalido.status).toBe(400)
    expect(invalido.body.code).toBe('PLAN_OFFER_INVALID')
    await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
    __resetInterruptorPlanesParaPruebas()
    const conApagado = await pedir.put('/recipients', { correos: [] })
    expect(conApagado.status).toBe(200)
    expect((await prisma.platformSettings.findUniqueOrThrow({ where: { id: 'default' } })).avisosDelAltaCorreos).toEqual([])
  })
})
