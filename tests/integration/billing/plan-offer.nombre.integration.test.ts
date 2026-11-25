/**
 * Planes editables B1, Task 8: el nombre del producto de Stripe de un plan, contra Postgres REAL (los candados son de verdad).
 *
 * Todos los escritores del nombre (el job, el intento inmediato del publicador y `syncFeaturesToStripe`) se forman en
 * `plan-offer-nombre` y calculan el nombre de la vigente JUSTO antes de escribir: el que llega tarde escribe lo más nuevo. La puerta
 * del checkout de «Tu plan» (por HTTP, con un JWT real) responde 503 `PLAN_RENAME_PENDING` mientras Stripe diga otro nombre.
 *
 * Stripe se simula con un almacén en memoria que guarda el nombre de cada producto y deja detener a mano el siguiente
 * `products.update` de un producto. La preparación de las listas híbridas sólo estampa ids falsos (como en `plan-offer.candado`),
 * `planesEditablesListos` se simula listo y la regla común de compra (`autorizarObligacionNueva`, probada en su suite) corre su
 * callback sin más. Las listas `PLAN:*` de otras suites se aparcan y se restauran; las filas de la oferta (puntero, versiones e
 * interruptor) se borran antes y después; las Features de los planes vuelven a como estaban.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Stripe simulado: productos con nombre, precios de las llaves y sesiones; el siguiente update de un producto se puede detener
// ---------------------------------------------------------------------------------------------------------------------

interface MockPausa {
  llego: Promise<void>
  avisar: () => void
  soltar: () => void
  promesa: Promise<void>
  /** El cuerpo con que llegó el update detenido. */
  cuerpo: Record<string, any> | null
}
function mockNuevaPausa(): MockPausa {
  let avisar!: () => void
  let soltar!: () => void
  const llego = new Promise<void>(r => (avisar = r))
  const promesa = new Promise<void>(r => (soltar = r))
  return { llego, avisar, soltar, promesa, cuerpo: null }
}

const mockStripe = {
  productos: new Map<string, { id: string; name: string; description?: string | null }>(),
  precios: new Map<string, Record<string, any>>(),
  /** Cada `products.update` aplicado, en orden: producto, nombre y quién lo escribió (por sus opciones). */
  escrituras: [] as Array<{ producto: string; nombre: string; origen: 'JOB' | 'SYNC' }>,
  /** El siguiente `products.update` de ese producto espera esta pausa. */
  pausas: new Map<string, MockPausa>(),
  sesiones: [] as Array<Record<string, any>>,
}

const mockNoExiste = (que: string) =>
  Object.assign(new Error(`No such ${que}`), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' })

const mockCliente = {
  products: {
    retrieve: async (id: string) => {
      const p = mockStripe.productos.get(id)
      if (!p) throw mockNoExiste('product')
      return { ...p }
    },
    update: async (id: string, cuerpo: Record<string, any>, opciones: { maxNetworkRetries?: number } = {}) => {
      const pausa = mockStripe.pausas.get(id)
      if (pausa) {
        mockStripe.pausas.delete(id)
        pausa.cuerpo = { ...cuerpo }
        pausa.avisar()
        await pausa.promesa
      }
      const p = mockStripe.productos.get(id)
      if (!p) throw mockNoExiste('product')
      if (typeof cuerpo.name === 'string') p.name = cuerpo.name
      if ('description' in cuerpo) p.description = cuerpo.description ?? null
      mockStripe.escrituras.push({ producto: id, nombre: p.name, origen: opciones.maxNetworkRetries === 0 ? 'JOB' : 'SYNC' })
      return { ...p }
    },
    create: async () => {
      throw new Error('Esta suite no crea productos: las otras funciones quedan aparcadas durante la sincronización')
    },
  },
  prices: {
    retrieve: async (id: string) => {
      const p = mockStripe.precios.get(id)
      if (!p) throw mockNoExiste('price')
      return { ...p }
    },
    list: async (params: { lookup_keys: string[] }) => ({
      object: 'list',
      has_more: false,
      data: [...mockStripe.precios.values()].filter(p => params.lookup_keys.includes(p.lookup_key)).map(p => ({ ...p })),
    }),
    create: async () => {
      throw new Error('Esta suite no crea precios: sólo cambian nombres')
    },
  },
  checkout: {
    sessions: {
      create: async (cuerpo: Record<string, any>) => {
        const id = `cs_t8_${mockStripe.sesiones.length + 1}`
        mockStripe.sesiones.push({ ...cuerpo, id })
        return { id, url: `https://checkout.stripe.test/${id}` }
      },
    },
  },
}
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockCliente))

jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) =>
    require('@/utils/prismaClient').default.hybridOfferPublication.update({
      where: { id },
      data: { stripeProductId: `prod_t8_${id}`, stripePriceId: `price_t8_${id}` },
    }),
  ),
}))
jest.mock('@/services/billing/planesEditablesListos', () => ({
  SERVIDOR_LISTO_PARA_PLANES_EDITABLES: true,
  cuponDeIntroduccionRetirado: () => true,
}))
// La regla común de compra (vence sesiones abiertas, lee lo vivo en Stripe) tiene su propia suite: aquí corre lo que se le pide crear.
jest.mock('@/services/access/autorizarObligacionNueva', () => ({
  ...jest.requireActual('@/services/access/autorizarObligacionNueva'),
  autorizarObligacionNueva: async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) =>
    crear(require('@/utils/prismaClient').default),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { planOfferRenameJob } from '@/jobs/plan-offer-rename.job'
import { escribirNombreDelPlan } from '@/services/billing/nombreDelPlanEnStripe'
import { publicarVersion } from '@/services/billing/planOfferPublisher'
import { entradaDesdeDefinicion, ofertaDeRespaldo, ofertaVigente, type PlanOfferDefinition } from '@/services/billing/planOffer'
import { __resetInterruptorPlanesParaPruebas } from '@/services/billing/interruptorPlanesEditables'
import { syncFeaturesToStripe } from '@/services/stripe.service'

jest.setTimeout(120_000)

const stamp = `${Date.now().toString(36)}${process.pid}`.toUpperCase()
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const CODIGOS_DE_LISTA = ['L_PLAN_PRO', 'L_PLAN_PREMIUM']
const SLUGS_DE_LISTA = ['lista-plan-pro', 'lista-plan-premium']
const CANDADO = 'plan-offer-nombre'

const productos = { PRO: `prod_t8_pro_${stamp}`, PREMIUM: `prod_t8_premium_${stamp}` }
const CATALOGO = {
  PLAN_PRO: {
    name: 'Plan Pro',
    description: 'Plan Pro de prueba',
    stripeProductId: productos.PRO,
    stripePriceId: `price_t8_f_pro_${stamp}`,
  },
  PLAN_PREMIUM: {
    name: 'Plan Premium',
    description: 'Plan Premium de prueba',
    stripeProductId: productos.PREMIUM,
    stripePriceId: `price_t8_f_premium_${stamp}`,
  },
} as const
const PRO_PLUS = 'Plan Avoqado Pro Plus'
const PRO_MAX = 'Plan Avoqado Pro Max'

let staffId: string
let versionUnoId: string
const featuresOriginales: Array<{
  code: string
  existia: boolean
  name: string
  description: string | null
  stripeProductId: string | null
  stripePriceId: string | null
  active: boolean
}> = []
let listasAparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []
let campanasAparcadas: string[] = []
const negocio = { orgId: '', venueId: '', duenoId: '' }

// ---------------------------------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------------------------------

const borrarLaOferta = async () => {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
}

/** La v1 de hoy, con los priceId de las llaves. */
function definicionUno(): PlanOfferDefinition {
  const d = ofertaDeRespaldo()
  d.PRO.monthly.stripePriceId = 'price_key_pro_m'
  d.PRO.annual.stripePriceId = 'price_key_pro_a'
  d.PREMIUM.monthly.stripePriceId = 'price_key_premium_m'
  d.PREMIUM.annual.stripePriceId = 'price_key_premium_a'
  return d
}

/** La v1 sembrada y el interruptor prendido. */
async function reiniciarLaOferta() {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  const v1 = await prisma.planOfferVersion.create({
    data: {
      status: 'PUBLISHED',
      number: 1,
      definition: definicionUno() as never,
      createdById: staffId,
      publishedById: staffId,
      publishedAt: new Date(),
    },
  })
  versionUnoId = v1.id
  await prisma.planOfferPointer.create({ data: { id: 'vigente', currentVersionId: v1.id, revision: 1 } })
  await prisma.interruptorDePlataforma.upsert({
    where: { clave: 'PLANES_EDITABLES' },
    create: { clave: 'PLANES_EDITABLES', desde: new Date(), actualizadoPor: staffId },
    update: { desde: new Date(), actualizadoPor: staffId },
  })
  __resetInterruptorPlanesParaPruebas()
}

/**
 * La v2 «Pro Plus» puesta directo en la base (sin pasar por el publicador): así ningún intento inmediato del publicador la renombra
 * y Stripe sigue diciendo «Plan Avoqado Pro».
 */
async function sembrarProPlus() {
  const d = definicionUno()
  d.PRO.displayName = 'Pro Plus'
  d.PRO.stripeProductName = PRO_PLUS
  const v2 = await prisma.planOfferVersion.create({
    data: {
      status: 'PUBLISHED',
      number: 2,
      definition: d as never,
      basedOnVersionId: versionUnoId,
      createdById: staffId,
      publishedById: staffId,
      publishedAt: new Date(),
    },
  })
  await prisma.planOfferVersion.update({ where: { id: versionUnoId }, data: { status: 'SUPERSEDED' } })
  await prisma.planOfferPointer.update({ where: { id: 'vigente' }, data: { currentVersionId: v2.id, revision: { increment: 1 } } })
}

/** Publicar (por el publicador real) la vigente con otro nombre de Pro. */
async function publicarConNombre(displayName: string) {
  const vigente = await ofertaVigente()
  const entrada = entradaDesdeDefinicion(vigente.definition)
  entrada.PRO.displayName = displayName
  const { revision } = await prisma.planOfferPointer.findUniqueOrThrow({ where: { id: 'vigente' } })
  return publicarVersion(entrada, revision, staffId)
}

function sembrarStripe() {
  mockStripe.productos.clear()
  mockStripe.precios.clear()
  mockStripe.escrituras = []
  mockStripe.pausas.clear()
  mockStripe.sesiones = []
  mockStripe.productos.set(productos.PRO, { id: productos.PRO, name: 'Plan Avoqado Pro', description: null })
  mockStripe.productos.set(productos.PREMIUM, { id: productos.PREMIUM, name: 'Plan Avoqado Premium', description: null })
  const llave = (id: string, lookup: string, product: string, unit: number, interval: 'month' | 'year') =>
    mockStripe.precios.set(id, {
      id,
      object: 'price',
      active: true,
      product,
      currency: 'mxn',
      unit_amount: unit,
      tax_behavior: 'inclusive',
      recurring: { interval, interval_count: 1 },
      lookup_key: lookup,
      metadata: {},
    })
  llave('price_key_pro_m', 'plan_pro_monthly', productos.PRO, 115884, 'month')
  llave('price_key_pro_a', 'plan_pro_annual', productos.PRO, 1158840, 'year')
  llave('price_key_premium_m', 'plan_premium_monthly', productos.PREMIUM, 197084, 'month')
  llave('price_key_premium_a', 'plan_premium_annual', productos.PREMIUM, 1970840, 'year')
}

/** Detiene el siguiente `products.update` de ese producto hasta `soltar()`. */
function detenerElSiguienteNombre(producto: string): MockPausa {
  const pausa = mockNuevaPausa()
  mockStripe.pausas.set(producto, pausa)
  return pausa
}

const nombresEscritos = (producto: string) => mockStripe.escrituras.filter(e => e.producto === producto)

/** Las sesiones de Postgres que ESPERAN el candado del nombre (un advisory de bigint sale partido en classid/objid). */
async function esperandoElCandado(): Promise<number> {
  const [fila] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM pg_locks l
    WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
      AND l.classid::bigint = ((hashtext(${CANDADO})::bigint >> 32) & 4294967295)
      AND l.objid::bigint = (hashtext(${CANDADO})::bigint & 4294967295)`
  return Number(fila.n)
}
async function hastaQueEsperen(n: number) {
  for (let i = 0; i < 400; i++) {
    if ((await esperandoElCandado()) >= n) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`No llegaron ${n} sesiones a esperar el candado del nombre`)
}

async function hastaQue(condicion: () => boolean | Promise<boolean>, que: string) {
  for (let i = 0; i < 400; i++) {
    if (await condicion()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`No se cumplió: ${que}`)
}
const renombreCorriendo = () => Reflect.get(planOfferRenameJob, 'corriendo') === true

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

/** «Tu plan» → Pro mensual, por la ruta real con el JWT del dueño. */
const pedirCheckout = () =>
  request(app)
    .post(`/api/v1/dashboard/venues/${negocio.venueId}/plan/checkout`)
    .set(
      'Authorization',
      `Bearer ${jwt.sign(
        { sub: negocio.duenoId, orgId: negocio.orgId, venueId: negocio.venueId, role: 'OWNER' },
        process.env.ACCESS_TOKEN_SECRET as string,
        { expiresIn: '15m' },
      )}`,
    )
    .send({ tier: 'PRO', interval: 'monthly' })

/**
 * Durante la sincronización sólo los dos planes están activos: así `syncFeaturesToStripe` no le pide nada a Stripe por funciones de
 * otras suites ni les escribe ids. Se devuelven en el `finally`.
 */
async function conSoloLosPlanes<T>(fn: () => Promise<T>): Promise<T> {
  const otras = await prisma.feature.findMany({
    where: { active: true, code: { notIn: ['PLAN_PRO', 'PLAN_PREMIUM'] } },
    select: { id: true },
    take: 1000,
  })
  const ids = otras.map(f => f.id)
  if (ids.length) await prisma.feature.updateMany({ where: { id: { in: ids } }, data: { active: false } })
  try {
    return await fn()
  } finally {
    if (ids.length) await prisma.feature.updateMany({ where: { id: { in: ids } }, data: { active: true } })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Antes y después
// ---------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  await borrarLaOferta()
  staffId = (
    await prisma.staff.create({
      data: { email: `plan-nombre-${stamp.toLowerCase()}@example.com`, firstName: 'Oferta', lastName: 'Nombre' },
    })
  ).id
  // El producto de Stripe de cada plan y su nombre del catálogo, sin perder lo que había.
  for (const code of ['PLAN_PRO', 'PLAN_PREMIUM'] as const) {
    const antes = await prisma.feature.findUnique({ where: { code } })
    featuresOriginales.push({
      code,
      existia: !!antes,
      name: antes?.name ?? CATALOGO[code].name,
      description: antes?.description ?? null,
      stripeProductId: antes?.stripeProductId ?? null,
      stripePriceId: antes?.stripePriceId ?? null,
      active: antes?.active ?? true,
    })
    await prisma.feature.upsert({
      where: { code },
      create: { code, category: 'OPERATIONS', monthlyPrice: 999, ...CATALOGO[code] },
      update: { ...CATALOGO[code], active: true },
    })
  }
  // Las listas de los planes que dejaron otras suites: aparcadas durante la corrida.
  listasAparcadas = await prisma.hybridCampaign.findMany({
    where: {
      purpose: 'LIST',
      OR: [{ listProductKey: { in: KEYS } }, { code: { in: CODIGOS_DE_LISTA } }, { slug: { in: SLUGS_DE_LISTA } }],
    },
    select: { id: true, listProductKey: true, code: true, slug: true },
    take: 10,
  })
  for (const { id } of listasAparcadas)
    await prisma.hybridCampaign.update({
      where: { id },
      data: { listProductKey: `FEATURE:PARKED_${id}`, code: `PARKED_${id}`, slug: `parked-${id}` },
    })
  campanasAparcadas = (await prisma.launchCampaign.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 100 })).map(
    c => c.id,
  )
  if (campanasAparcadas.length)
    await prisma.launchCampaign.updateMany({ where: { id: { in: campanasAparcadas } }, data: { status: 'PAUSED' } })
  // El negocio que compra su plan en «Tu plan»: ya tiene su cliente de Stripe.
  const org = await prisma.organization.create({
    data: { name: `Nombre ${stamp}`, email: `nombre-${stamp.toLowerCase()}@example.com`, phone: '5555555555' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Nombre ${stamp}`, slug: `nombre-${stamp.toLowerCase()}`, stripeCustomerId: `cus_t8_${stamp}` },
  })
  const dueno = await prisma.staff.create({
    data: { email: `dueno-${stamp.toLowerCase()}@example.com`, firstName: 'Dueña', lastName: 'Prueba' },
  })
  await prisma.staffVenue.create({ data: { staffId: dueno.id, venueId: venue.id, role: 'OWNER', active: true } })
  Object.assign(negocio, { orgId: org.id, venueId: venue.id, duenoId: dueno.id })
})

afterAll(async () => {
  await hastaQue(() => !renombreCorriendo(), 'el renombre en segundo plano terminó').catch(() => undefined)
  await borrarLaOferta()
  __resetInterruptorPlanesParaPruebas()
  if (campanasAparcadas.length)
    await prisma.launchCampaign.updateMany({ where: { id: { in: campanasAparcadas } }, data: { status: 'ACTIVE' } })
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
  for (const { id, listProductKey, code, slug } of listasAparcadas)
    await prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } })
  for (const f of featuresOriginales) {
    if (f.existia)
      await prisma.feature.update({
        where: { code: f.code },
        data: {
          name: f.name,
          description: f.description,
          stripeProductId: f.stripeProductId,
          stripePriceId: f.stripePriceId,
          active: f.active,
        },
      })
    else await prisma.feature.deleteMany({ where: { code: f.code } })
  }
  if (negocio.venueId) {
    await prisma.staffVenue.deleteMany({ where: { venueId: negocio.venueId } })
    await prisma.venue.deleteMany({ where: { id: negocio.venueId } })
    await prisma.organization.deleteMany({ where: { id: negocio.orgId } })
    await prisma.staff.deleteMany({ where: { id: negocio.duenoId } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

beforeEach(async () => {
  sembrarStripe()
  await reiniciarLaOferta()
})

afterEach(async () => {
  // Una pausa que quedó armada no detiene a la siguiente prueba, y lo que corre en segundo plano termina antes de borrar la oferta.
  for (const pausa of mockStripe.pausas.values()) pausa.soltar()
  mockStripe.pausas.clear()
  await hastaQue(() => !renombreCorriendo(), 'el renombre en segundo plano terminó')
})

// ---------------------------------------------------------------------------------------------------------------------
// Los tres órdenes
// ---------------------------------------------------------------------------------------------------------------------

describe('el nombre de un plan en Stripe: un solo escritor y la puerta del checkout (Postgres real)', () => {
  it('🔴 un escritor que ya tomó el nombre de v2 se detiene a media escritura; se publica v3 (otro nombre); un POST /api/v1/dashboard/venues/:venueId/plan/checkout que llega después → 503 mientras Stripe no diga el de v3; al soltarlo, el publicador escribe el de v3 después y el siguiente POST abre la sesión', async () => {
    await sembrarProPlus()
    const pausa = detenerElSiguienteNombre(productos.PRO)
    let escritor: Promise<unknown> | undefined
    try {
      escritor = enSegundoPlano(escribirNombreDelPlan('PRO', 'JOB'))
      await hastaQueLlegue(pausa.llego, escritor)
      // Tomó el candado y leyó la v2: va a escribir «Pro Plus».
      expect(pausa.cuerpo).toEqual({ name: PRO_PLUS })

      await expect(publicarConNombre('Pro Max')).resolves.toMatchObject({ number: 3 })
      expect((await ofertaVigente()).definition.PRO.stripeProductName).toBe(PRO_MAX)
      // El intento inmediato del publicador espera su turno en el candado del nombre.
      await hastaQueEsperen(1)

      const cerrado = await pedirCheckout()
      expect(cerrado.status).toBe(503)
      expect(cerrado.body).toMatchObject({
        code: 'PLAN_RENAME_PENDING',
        message: 'Estamos actualizando el nombre de tu plan. Intenta en un minuto. No se te cobró nada.',
      })
      expect(mockStripe.sesiones).toHaveLength(0)
    } finally {
      pausa.soltar()
      await asentar(escritor)
    }

    await expect(escritor).resolves.toBe('RENOMBRADO')
    await hastaQue(() => mockStripe.productos.get(productos.PRO)?.name === PRO_MAX && !renombreCorriendo(), 'Stripe dice «Pro Max»')
    // El detenido escribió primero lo que había leído; el publicador, después, lo más nuevo.
    expect(nombresEscritos(productos.PRO)).toEqual([
      { producto: productos.PRO, nombre: PRO_PLUS, origen: 'JOB' },
      { producto: productos.PRO, nombre: PRO_MAX, origen: 'JOB' },
    ])
    const puntero = await prisma.planOfferPointer.findUniqueOrThrow({ where: { id: 'vigente' } })
    expect(puntero.nombresEnStripe).toMatchObject({ PRO: { esperado: PRO_MAX, enStripe: PRO_MAX } })

    const abierto = await pedirCheckout()
    expect(abierto.status).toBe(200)
    expect(abierto.body).toMatchObject({ success: true, url: 'https://checkout.stripe.test/cs_t8_1' })
    expect(mockStripe.sesiones).toHaveLength(1)
    expect(mockStripe.sesiones[0].line_items).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
  })

  it('🔴 syncFeaturesToStripe que arranca durante esa escritura detenida espera el candado y escribe el nombre de v3, no Feature.name', async () => {
    await conSoloLosPlanes(async () => {
      await sembrarProPlus()
      const pausa = detenerElSiguienteNombre(productos.PRO)
      let escritor: Promise<unknown> | undefined
      let sincronizacion: Promise<unknown> | undefined
      try {
        escritor = enSegundoPlano(escribirNombreDelPlan('PRO', 'JOB'))
        await hastaQueLlegue(pausa.llego, escritor)
        // Arranca con la v2 vigente; espera el candado (en Pro, o en Premium y luego en Pro).
        sincronizacion = enSegundoPlano(syncFeaturesToStripe())
        await hastaQueEsperen(1)
        await expect(publicarConNombre('Pro Max')).resolves.toMatchObject({ number: 3 })
        await hastaQueEsperen(2)
      } finally {
        pausa.soltar()
        await asentar(escritor, sincronizacion)
      }

      await expect(sincronizacion).resolves.toBeDefined()
      await hastaQue(() => !renombreCorriendo(), 'el renombre del publicador terminó')
      // La sincronización calculó el nombre DESPUÉS de tomar el candado: el de la v3, nunca el del catálogo.
      const deLaSincronizacion = nombresEscritos(productos.PRO).filter(e => e.origen === 'SYNC')
      expect(deLaSincronizacion).toEqual([{ producto: productos.PRO, nombre: PRO_MAX, origen: 'SYNC' }])
      expect(nombresEscritos(productos.PRO).some(e => e.nombre === CATALOGO.PLAN_PRO.name)).toBe(false)
      expect(mockStripe.productos.get(productos.PRO)).toMatchObject({ name: PRO_MAX, description: CATALOGO.PLAN_PRO.description })
      // Premium no cambió de nombre: la sincronización le escribe el del catálogo, como hoy.
      expect(mockStripe.productos.get(productos.PREMIUM)?.name).toBe(CATALOGO.PLAN_PREMIUM.name)
    })
  })

  it('🔴 una sincronización que empezó en v1 (detenida en su products.update con Feature.name) y la PRIMERA publicación con otro nombre: el renombre del publicador espera el candado y escribe después; el nombre final en Stripe es el de v2', async () => {
    await conSoloLosPlanes(async () => {
      const pausa = detenerElSiguienteNombre(productos.PRO)
      let sincronizacion: Promise<unknown> | undefined
      try {
        sincronizacion = enSegundoPlano(syncFeaturesToStripe())
        await hastaQueLlegue(pausa.llego, sincronizacion)
        // Con la v1 la oferta no es dueña del nombre: la sincronización escribe el del catálogo, como hoy.
        expect(pausa.cuerpo).toEqual({ name: CATALOGO.PLAN_PRO.name, description: CATALOGO.PLAN_PRO.description })

        await expect(publicarConNombre('Pro Plus')).resolves.toMatchObject({ number: 2 })
        await hastaQueEsperen(1)
      } finally {
        pausa.soltar()
        await asentar(sincronizacion)
      }

      await expect(sincronizacion).resolves.toBeDefined()
      await hastaQue(() => mockStripe.productos.get(productos.PRO)?.name === PRO_PLUS && !renombreCorriendo(), 'Stripe dice «Pro Plus»')
      expect(nombresEscritos(productos.PRO).map(e => [e.nombre, e.origen])).toEqual([
        [CATALOGO.PLAN_PRO.name, 'SYNC'],
        [PRO_PLUS, 'JOB'],
      ])
      // Con el nombre al día, el checkout abre.
      const abierto = await pedirCheckout()
      expect(abierto.status).toBe(200)
    })
  })
})
