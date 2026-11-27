/**
 * Planes editables B1, Task 7: activar una campaña y publicar una versión de los planes, contra Postgres REAL.
 *
 * Las dos operaciones toman el mismo candado (`plan-offer-publish`). Cada caso fija un orden con pausas controladas: promesas
 * que el doble de Stripe suelta a mano, o el propio candado sostenido por la prueba. En TODOS se comprueba lo mismo: una
 * campaña ACTIVE tiene `listPriceCentsSnapshot` === el mensual de la versión vigente al confirmar su CAS, y su cupón guardado
 * tiene `amount_off` === snapshot − anunciado.
 *
 * Además (revisión de Task 6, M3): los cuatro `UPDATE … jsonb_set` del publicador corren aquí contra Postgres de verdad (el
 * `::text[]` de la ruta, `to_jsonb(…::int)`, el `->>` del CAS de intentos y `'…'::jsonb`), y después de cada paso se lee la
 * fila de la versión.
 *
 * Stripe se simula entero (`jest.mock('stripe')`) y la preparación de las listas híbridas sólo estampa ids falsos (como
 * `hybrid-plan-list-seed`). `planesEditablesListos` se simula listo. Las listas `PLAN:*` de otras suites se aparcan y se
 * restauran, y las filas de la oferta (puntero, versiones e interruptor) se borran antes y después: si quedaran, el sembrado
 * de las listas de otra suite respondería 409 `PLAN_OFFER_OWNS_PLAN_LISTS`.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Stripe simulado: precios y cupones en memoria, con pausas que la prueba suelta a mano
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

const mockStripe = {
  precios: new Map<string, Record<string, any>>(),
  cupones: new Map<string, Record<string, any>>(),
  /** La siguiente `coupons.create` espera esta pausa. */
  pausaDelCupon: null as MockPausa | null,
  /** La siguiente `prices.create` espera esta pausa. */
  pausaDelPrecio: null as MockPausa | null,
  /** Cuántas `prices.create` siguientes se rechazan con un 400 (rechazo definitivo). */
  rechazosDePrecio: 0,
  /** Las llaves de idempotencia de cada `prices.create`. */
  llavesDePrecio: [] as string[],
}

const mockNoExiste = (que: string) =>
  Object.assign(new Error(`No such ${que}`), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' })

const mockCliente = {
  prices: {
    list: async (params: { lookup_keys: string[] }) => ({
      object: 'list',
      has_more: false,
      data: [...mockStripe.precios.values()].filter(p => params.lookup_keys.includes(p.lookup_key)).map(p => ({ ...p })),
    }),
    retrieve: async (id: string) => {
      const p = mockStripe.precios.get(id)
      if (!p) throw mockNoExiste('price')
      return { ...p }
    },
    create: async (body: Record<string, any>, opciones: { idempotencyKey?: string } = {}) => {
      const pausa = mockStripe.pausaDelPrecio
      if (pausa) {
        mockStripe.pausaDelPrecio = null
        pausa.avisar()
        await pausa.promesa
      }
      mockStripe.llavesDePrecio.push(opciones.idempotencyKey ?? '')
      if (mockStripe.rechazosDePrecio > 0) {
        mockStripe.rechazosDePrecio -= 1
        throw Object.assign(new Error('Invalid request'), { type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid' })
      }
      const price = {
        id: `price_${body.lookup_key}`,
        object: 'price',
        active: true,
        product: body.product,
        currency: body.currency,
        unit_amount: body.unit_amount,
        tax_behavior: body.tax_behavior,
        recurring: { ...body.recurring },
        lookup_key: body.lookup_key,
        metadata: { ...body.metadata },
      }
      mockStripe.precios.set(price.id, price)
      return { ...price }
    },
  },
  coupons: {
    retrieve: async (id: string) => {
      const c = mockStripe.cupones.get(id)
      if (!c) throw mockNoExiste('coupon')
      return { ...c }
    },
    create: async (body: Record<string, any>) => {
      const pausa = mockStripe.pausaDelCupon
      if (pausa) {
        mockStripe.pausaDelCupon = null
        pausa.avisar()
        await pausa.promesa
      }
      const c = { ...body, object: 'coupon', valid: true }
      mockStripe.cupones.set(body.id, c)
      return { ...c }
    },
    del: async () => {
      throw new Error('Un cupón de campaña nunca se borra')
    },
  },
}
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockCliente))

// Stripe de las listas híbridas no es lo que se mide: «preparar» una publicación sólo le estampa ids falsos.
jest.mock('@/services/launchCampaigns/hybridPrices', () => ({
  ensureHybridPublicationPrices: jest.fn(async (id: string) =>
    require('@/utils/prismaClient').default.hybridOfferPublication.update({
      where: { id },
      data: { stripeProductId: `prod_t7_${id}`, stripePriceId: `price_t7_${id}` },
    }),
  ),
}))
// Los requisitos de código para prender el interruptor: listos (el renglón del interruptor lo pone la prueba).
jest.mock('@/services/billing/planesEditablesListos', () => ({
  SERVIDOR_LISTO_PARA_PLANES_EDITABLES: true,
  cuponDeIntroduccionExcluidoConVersion: () => true,
}))

import prisma from '@/utils/prismaClient'
import { ensureHybridPublicationPrices } from '@/services/launchCampaigns/hybridPrices'
import { activateLaunchCampaign } from '@/services/launchCampaigns/launchCampaignStripe.service'
import { descartarPublicacion, publicarVersion, reintentarPublicacion } from '@/services/billing/planOfferPublisher'
import { entradaDesdeDefinicion, ofertaDeRespaldo, ofertaVigente } from '@/services/billing/planOffer'
import { __resetInterruptorPlanesParaPruebas } from '@/services/billing/interruptorPlanesEditables'

const stamp = `${Date.now().toString(36)}${process.pid}`.toUpperCase()
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const CODIGOS_DE_LISTA = ['L_PLAN_PRO', 'L_PLAN_PREMIUM']
const SLUGS_DE_LISTA = ['lista-plan-pro', 'lista-plan-premium']
const CANDADO = 'plan-offer-publish'
const ANUNCIADO = 2200
const LISTA_V1 = 115884
const NETO_V2 = 129900
const LISTA_V2 = Math.round((NETO_V2 * 116) / 100) // 150684

let staffId: string
let versionUnoId: string
const productos = { PRO: `prod_t7_pro_${stamp}`, PREMIUM: `prod_t7_premium_${stamp}` }
const featuresOriginales: Array<{ code: string; existia: boolean; stripeProductId: string | null; active: boolean }> = []
let listasAparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []
let campanasAparcadas: string[] = []
const misCampanas: string[] = []

// ---------------------------------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------------------------------

const borrarLaOferta = async () => {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
}

/** La v1 sembrada (lo de hoy, con los priceId de las llaves) y el interruptor prendido. */
async function reiniciarLaOferta() {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
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

/** Los precios de las llaves en Stripe (los que cobra la v1), en el producto de cada plan. */
function sembrarStripe() {
  mockStripe.precios.clear()
  mockStripe.cupones.clear()
  mockStripe.pausaDelCupon = null
  mockStripe.pausaDelPrecio = null
  mockStripe.rechazosDePrecio = 0
  mockStripe.llavesDePrecio = []
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
  llave('price_key_pro_m', 'plan_pro_monthly', productos.PRO, LISTA_V1, 'month')
  llave('price_key_pro_a', 'plan_pro_annual', productos.PRO, 1158840, 'year')
  llave('price_key_premium_m', 'plan_premium_monthly', productos.PREMIUM, 197084, 'month')
  llave('price_key_premium_a', 'plan_premium_annual', productos.PREMIUM, 1970840, 'year')
}

/** Una campaña de Pro en borrador, como la crea el SUPERADMIN. */
async function campanaEnBorrador(): Promise<{ id: string; code: string }> {
  const code = `PO${stamp}${misCampanas.length + 1}`
  const c = await prisma.launchCampaign.create({
    data: {
      code,
      name: `Campaña de prueba ${misCampanas.length + 1}`,
      landingSlug: `po-${stamp.toLowerCase()}-${misCampanas.length + 1}`,
      planTier: 'PRO',
      advertisedPriceCents: ANUNCIADO,
      discountMonths: 3,
      validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 30 * 86_400_000),
      redemptionCap: 10,
      createdById: staffId,
    },
    select: { id: true, code: true },
  })
  misCampanas.push(c.id)
  return c
}

/** Publicar la oferta de hoy con el mensual de Pro en `netoPro` (sin IVA), sobre la revisión actual. */
async function publicar(netoPro = NETO_V2) {
  const vigente = await ofertaVigente()
  const entrada = entradaDesdeDefinicion(vigente.definition)
  entrada.PRO.monthlyNetCents = netoPro
  const { revision } = await prisma.planOfferPointer.findUniqueOrThrow({ where: { id: 'vigente' } })
  return publicarVersion(entrada, revision, staffId)
}

const activar = (id: string) => activateLaunchCampaign(id, staffId, 'prueba de la carrera')

/** Lo que se comprueba en TODOS los casos sobre una campaña ACTIVE. */
async function comprobarCampana(id: string, listaEsperada: number) {
  const c = await prisma.launchCampaign.findUniqueOrThrow({ where: { id } })
  expect(c.status).toBe('ACTIVE')
  const vigente = await ofertaVigente()
  expect(c.listPriceCentsSnapshot).toBe(vigente.definition.PRO.monthly.grossCents)
  expect(c.listPriceCentsSnapshot).toBe(listaEsperada)
  const cupon = mockStripe.cupones.get(c.stripeCouponId as string)
  expect(cupon).toBeDefined()
  expect(cupon!.amount_off).toBe((c.listPriceCentsSnapshot as number) - c.advertisedPriceCents)
  return c
}

/** Las sesiones de Postgres que ESPERAN el candado de la oferta (un advisory de bigint sale partido en classid/objid). */
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
  throw new Error(`No llegaron ${n} sesiones a esperar el candado de la oferta`)
}

/** La prueba sostiene el candado de la oferta hasta que llame a `soltar`. */
async function sostenerElCandado() {
  let tomado!: () => void
  const listo = new Promise<void>(r => (tomado = r))
  let soltar!: () => void
  const suelto = new Promise<void>(r => (soltar = r))
  const tx = prisma.$transaction(
    async t => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO}))`
      tomado()
      await suelto
    },
    { timeout: 30_000, maxWait: 10_000 },
  )
  await listo
  return {
    soltar: async () => {
      soltar()
      await tx
    },
  }
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

/** En el `finally` de cada caso con pausas: lo que quedó corriendo termina antes de que `afterEach` toque la base. */
const asentar = (...operaciones: Array<Promise<unknown> | undefined>) =>
  Promise.allSettled(operaciones.filter((o): o is Promise<unknown> => o !== undefined))

const leerVersion = (id: string) => prisma.planOfferVersion.findUniqueOrThrow({ where: { id } })
const elPuntero = () => prisma.planOfferPointer.findUniqueOrThrow({ where: { id: 'vigente' } })

// ---------------------------------------------------------------------------------------------------------------------
// Antes y después
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `true` sólo cuando la guarda de la base desechable pasó. Si la guarda lanzó, Jest igual corre `afterEach` y `afterAll`: su limpieza
 * (borrar toda la oferta, retirar las listas `PLAN:*`…) no debe tocar una base que no es la de pruebas.
 */
let preparada = false

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  preparada = true
  await borrarLaOferta()
  staffId = (
    await prisma.staff.create({ data: { email: `plan-offer-${stamp.toLowerCase()}@example.com`, firstName: 'Oferta', lastName: 'Prueba' } })
  ).id
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
  // Una campaña ACTIVE de otra suite bloquearía publicar: se pausa durante la corrida.
  campanasAparcadas = (await prisma.launchCampaign.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 100 })).map(
    c => c.id,
  )
  if (campanasAparcadas.length)
    await prisma.launchCampaign.updateMany({ where: { id: { in: campanasAparcadas } }, data: { status: 'PAUSED' } })
})

afterAll(async () => {
  if (!preparada) return
  await borrarLaOferta()
  __resetInterruptorPlanesParaPruebas()
  if (misCampanas.length) await prisma.launchCampaign.deleteMany({ where: { id: { in: misCampanas } } })
  if (campanasAparcadas.length)
    await prisma.launchCampaign.updateMany({ where: { id: { in: campanasAparcadas } }, data: { status: 'ACTIVE' } })
  // Las listas que creó esta suite no se pueden borrar (sus publicaciones tampoco): se retiran y se devuelven las aparcadas.
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
  // Las Features que ya existían vuelven a como estaban; las que creó esta suite se borran.
  for (const f of featuresOriginales) {
    if (f.existia) await prisma.feature.update({ where: { code: f.code }, data: { stripeProductId: f.stripeProductId, active: f.active } })
    else await prisma.feature.deleteMany({ where: { code: f.code } })
  }
  // Su bitácora queda (sin actor: `staffId` es SET NULL); el renglón de la persona de prueba se va.
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
})

beforeEach(async () => {
  if (!preparada) return
  sembrarStripe()
  await reiniciarLaOferta()
})

afterEach(async () => {
  if (!preparada) return
  // Una campaña ACTIVE de un caso bloquearía publicar en el siguiente.
  if (misCampanas.length) await prisma.launchCampaign.updateMany({ where: { id: { in: misCampanas } }, data: { status: 'ENDED' } })
  jest.mocked(ensureHybridPublicationPrices).mockClear()
})

// ---------------------------------------------------------------------------------------------------------------------
// Los cuatro órdenes
// ---------------------------------------------------------------------------------------------------------------------

describe('activar una campaña y publicar los planes: un solo candado (Postgres real)', () => {
  it('publicar termina y después se activa: la campaña queda ACTIVE con el mensual nuevo y LC_<code>_V1_P2; las dos operaciones terminan bien', async () => {
    const { id, code } = await campanaEnBorrador()

    await expect(publicar()).resolves.toMatchObject({ number: 2 })
    await expect(activar(id)).resolves.toMatchObject({ status: 'ACTIVE' })

    const c = await comprobarCampana(id, LISTA_V2)
    expect(c.stripeCouponId).toBe(`LC_${code}_V1_P2`)
  })

  it('🔴 la activación confirma primero: la publicación (rápida o dentro de su candado) recibe PLAN_PRICE_BLOCKED_BY_CAMPAIGNS y el puntero no se mueve', async () => {
    const { id, code } = await campanaEnBorrador()

    // Dentro del candado: la prueba lo sostiene; la activación llega a esperarlo (ya con su cupón) y DESPUÉS la publicación,
    // que pasa su revisión rápida (la campaña sigue en borrador) y se forma detrás.
    const candado = await sostenerElCandado()
    let activacion: Promise<unknown> | undefined
    let publicacion: Promise<unknown> | undefined
    try {
      activacion = enSegundoPlano(activar(id))
      await hastaQueEsperen(1)
      publicacion = enSegundoPlano(publicar())
      await hastaQueEsperen(2)
    } finally {
      // Pase lo que pase, el candado se suelta y las dos terminan antes de seguir (o de que `afterEach` cierre la campaña).
      await candado.soltar().catch(() => undefined)
      await asentar(activacion, publicacion)
    }

    await expect(activacion).resolves.toMatchObject({ status: 'ACTIVE' })
    await expect(publicacion).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS' })

    // La rápida: con la campaña ya ACTIVE, publicar se niega antes de crear nada.
    await expect(publicar()).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_BLOCKED_BY_CAMPAIGNS' })

    const puntero = await elPuntero()
    expect(puntero).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: null })
    expect(await prisma.planOfferVersion.count()).toBe(1)
    expect(mockStripe.llavesDePrecio).toEqual([])
    const c = await comprobarCampana(id, LISTA_V1)
    expect(c.stripeCouponId).toBe(`LC_${code}_V1`)
  })

  it('con la publicación PREPARING, el CAS de la activación → 409 PLAN_OFFER_PENDING; al terminar la publicación, el segundo intento activa con el mensual nuevo', async () => {
    const { id, code } = await campanaEnBorrador()

    const pausaDelCupon = mockNuevaPausa()
    const pausaDelPrecio = mockNuevaPausa()
    let activacion: Promise<unknown> | undefined
    let publicacion: Promise<unknown> | undefined
    try {
      // La activación pasa su revisión (nada pendiente) y se detiene en Stripe, creando su cupón.
      mockStripe.pausaDelCupon = pausaDelCupon
      activacion = enSegundoPlano(activar(id))
      await hastaQueLlegue(pausaDelCupon.llego, activacion)
      // La publicación deja su versión PREPARING y se detiene en Stripe, creando el precio nuevo.
      mockStripe.pausaDelPrecio = pausaDelPrecio
      publicacion = enSegundoPlano(publicar())
      await hastaQueLlegue(pausaDelPrecio.llego, publicacion)
      expect((await elPuntero()).pendingVersionId).not.toBeNull()

      pausaDelCupon.soltar()
      await expect(activacion).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_OFFER_PENDING' })
      expect((await prisma.launchCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT')

      pausaDelPrecio.soltar()
      await expect(publicacion).resolves.toMatchObject({ number: 2 })
    } finally {
      pausaDelCupon.soltar()
      pausaDelPrecio.soltar()
      mockStripe.pausaDelCupon = null
      mockStripe.pausaDelPrecio = null
      await asentar(activacion, publicacion)
    }

    await expect(activar(id)).resolves.toMatchObject({ status: 'ACTIVE' })
    const c = await comprobarCampana(id, LISTA_V2)
    expect(c.stripeCouponId).toBe(`LC_${code}_V1_P2`)
    // El cupón del intento perdido queda sin usar: nadie lo guarda.
    expect(mockStripe.cupones.get(`LC_${code}_V1`)).toMatchObject({ amount_off: LISTA_V1 - ANUNCIADO })
  })

  it('🔴 la activación lee v1 y crea su cupón; la publicación mueve a v2 antes del candado de la activación → 409 PLAN_OFFER_STALE; el segundo intento crea LC_<code>_V1_P2 y queda ACTIVE', async () => {
    const { id, code } = await campanaEnBorrador()

    const pausaDelCupon = mockNuevaPausa()
    let activacion: Promise<unknown> | undefined
    try {
      mockStripe.pausaDelCupon = pausaDelCupon
      activacion = enSegundoPlano(activar(id))
      await hastaQueLlegue(pausaDelCupon.llego, activacion)

      // Mientras Stripe crea el cupón de la v1, la publicación termina completa.
      await expect(publicar()).resolves.toMatchObject({ number: 2 })

      pausaDelCupon.soltar()
      await expect(activacion).rejects.toMatchObject({
        statusCode: 409,
        code: 'PLAN_OFFER_STALE',
        details: { leida: 1, vigente: 2 },
      })
      expect((await prisma.launchCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT')
    } finally {
      pausaDelCupon.soltar()
      mockStripe.pausaDelCupon = null
      await asentar(activacion)
    }

    await expect(activar(id)).resolves.toMatchObject({ status: 'ACTIVE' })
    const c = await comprobarCampana(id, LISTA_V2)
    expect(c.stripeCouponId).toBe(`LC_${code}_V1_P2`)
    expect(mockStripe.cupones.get(`LC_${code}_V1`)).toMatchObject({ amount_off: LISTA_V1 - ANUNCIADO })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// M3 (revisión de Task 6): los cuatro jsonb_set del publicador contra Postgres real
// ---------------------------------------------------------------------------------------------------------------------

describe('M3: las escrituras de la preparación sobre la fila de la versión (Postgres real)', () => {
  it('publicar → Stripe RECHAZA el precio → reintentar → falla la LISTA → descartar: la fila cuenta lo que pasó en cada paso', async () => {
    const NETO = 139900
    const BRUTO = Math.round((NETO * 116) / 100) // 162284

    // 1. Publicar: Stripe rechaza (400) el precio mensual de Pro. Sube el intento (CAS con `->>`) y queda el último error (::jsonb).
    mockStripe.rechazosDePrecio = 1
    await expect(publicar(NETO)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_PREPARING',
      details: { etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'RECHAZADO' },
    })
    const { pendingVersionId } = await elPuntero()
    expect(pendingVersionId).not.toBeNull()
    const versionId = pendingVersionId as string
    let fila = await leerVersion(versionId)
    expect(fila.status).toBe('PREPARING')
    expect((fila.definition as any).PRO.monthly).toEqual({ netCents: NETO, grossCents: BRUTO, stripePriceId: null })
    expect(fila.preparacion).toEqual({
      intentos: { PRO_monthly: 1, PRO_annual: 0, PREMIUM_monthly: 0, PREMIUM_annual: 0 },
      ultimoError: { etapa: 'PRECIO', ranura: 'PRO:monthly', motivo: 'RECHAZADO', at: expect.any(String) },
    })
    expect(fila.hybridPublicationIds).toEqual({ PRO: null, PREMIUM: null })
    expect(mockStripe.llavesDePrecio).toEqual([`plan-offer-price:${versionId}:PRO:monthly:0`])

    // 2. Reintentar: el precio sale con el intento 1 (::text[] + to_jsonb(::text)), el último error se limpia ('null'::jsonb)
    //    y la lista se liga (to_jsonb(::text)). Stripe de la lista se detiene: ahí se lee la fila.
    let avisar!: () => void
    const llegoALaLista = new Promise<void>(r => (avisar = r))
    let soltar!: () => void
    const listaSuelta = new Promise<void>(r => (soltar = r))
    jest.mocked(ensureHybridPublicationPrices).mockImplementationOnce(async () => {
      avisar()
      await listaSuelta
      throw new Error('Stripe no contestó')
    })
    const reintento = enSegundoPlano(reintentarPublicacion(versionId, staffId))
    try {
      await hastaQueLlegue(llegoALaLista, reintento)
      fila = await leerVersion(versionId)
      expect((fila.definition as any).PRO.monthly).toEqual({
        netCents: NETO,
        grossCents: BRUTO,
        stripePriceId: `price_po_${versionId}_pro_monthly`,
      })
      expect((fila.preparacion as any).ultimoError).toBeNull()
      expect((fila.preparacion as any).intentos.PRO_monthly).toBe(1)
      expect(typeof (fila.hybridPublicationIds as any).PREMIUM).toBe('string')
      expect(mockStripe.llavesDePrecio).toEqual([
        `plan-offer-price:${versionId}:PRO:monthly:0`,
        `plan-offer-price:${versionId}:PRO:monthly:1`,
      ])
    } finally {
      // …y la lista falla (también si una comprobación de arriba falló: el reintento termina antes de seguir).
      soltar()
      await asentar(reintento)
    }

    // Queda PREPARING con su último error de LISTA (el intento no sube: es incierto).
    await expect(reintento).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_OFFER_PREPARING',
      details: { etapa: 'LISTA', motivo: 'INCIERTO' },
    })
    fila = await leerVersion(versionId)
    expect(fila.status).toBe('PREPARING')
    expect((fila.definition as any).PRO.monthly.stripePriceId).toBe(`price_po_${versionId}_pro_monthly`)
    expect(fila.preparacion).toEqual({
      intentos: { PRO_monthly: 1, PRO_annual: 0, PREMIUM_monthly: 0, PREMIUM_annual: 0 },
      ultimoError: { etapa: 'LISTA', ranura: null, motivo: 'INCIERTO', at: expect.any(String) },
    })
    const ligadas = fila.hybridPublicationIds as { PRO: string | null; PREMIUM: string | null }
    expect(typeof ligadas.PREMIUM).toBe('string')
    // La que falló quedó ligada como la pendiente de su lista.
    const pendientes = await prisma.hybridCampaign.findMany({
      where: { purpose: 'LIST', listProductKey: { in: KEYS }, pendingPublicationId: { not: null } },
      select: { listProductKey: true, pendingPublicationId: true },
      take: 2,
    })
    expect(pendientes.length).toBeGreaterThan(0)
    for (const p of pendientes) expect([ligadas.PRO, ligadas.PREMIUM]).toContain(p.pendingPublicationId)

    // 3. Descartar: la versión queda DISCARDED con su JSON tal cual, el puntero sin pendiente y las listas pendientes sueltas.
    await descartarPublicacion(versionId, staffId)
    const descartada = await leerVersion(versionId)
    expect(descartada.status).toBe('DISCARDED')
    expect(descartada.discardedAt).not.toBeNull()
    expect(descartada.number).toBeNull()
    expect(descartada.definition).toEqual(fila.definition)
    expect(descartada.preparacion).toEqual(fila.preparacion)
    expect(descartada.hybridPublicationIds).toEqual(fila.hybridPublicationIds)
    expect(await elPuntero()).toMatchObject({ currentVersionId: versionUnoId, pendingVersionId: null })
    const sueltas = await prisma.hybridCampaign.findMany({
      where: { purpose: 'LIST', listProductKey: { in: KEYS } },
      select: { pendingPublicationId: true },
      take: 2,
    })
    const ligadasDeLaVersion = [ligadas.PRO, ligadas.PREMIUM].filter((x): x is string => x !== null)
    expect(sueltas.filter(l => l.pendingPublicationId !== null && ligadasDeLaVersion.includes(l.pendingPublicationId))).toEqual([])
  })
})
