/**
 * Planes editables (B1): sembrar la VERSIÓN 1 de la oferta de los planes, una foto de lo de hoy.
 *
 * La v1 es `ofertaDeRespaldo()` (lo de hoy) con los cuatro `priceId` de las llaves (`plan_pro_monthly`…) y las dos
 * publicaciones híbridas que venden `PLAN:PRO` y `PLAN:PREMIUM`. Con ella se sigue cobrando por la llave, como B0
 * (`versionQueCobra()` sólo devuelve una versión del editor); lo que cambia es que desde entonces los escritores viejos de los
 * planes se niegan (`exigirSinVersionDeLaOferta`) y el precio de un plan sólo cambia publicando (diseño «Planes editables», §15).
 *
 * Dos pasos:
 * - `revisarSembradoDeLaVersionUno()` SÓLO LEE (la base y Stripe) y dice si se puede sembrar: las cuatro llaves en el producto
 *   de su plan (`Feature.stripeProductId`) con el monto, la moneda, el IVA incluido y la periodicidad de hoy; las dos listas
 *   en venta a su precio y con la composición del código. Informa también los productos y cuántas suscripciones vivas de plan
 *   reconoce cada uno (el catálogo, sólo la llave o nadie).
 * - `sembrarVersionUno()` escribe la v1 SÓLO si la revisión dio `CREATE`, en una transacción con el candado de la oferta y
 *   luego los de producto, y releyendo ahí las dos listas.
 *
 * 🔴 Ninguna llamada a Stripe ocurre con el candado de la oferta tomado: la revisión corre antes de la transacción.
 * 🔴 La v1 no trae nombre propio del producto (`stripeProductName: null`): conserva el que tenga Stripe y nadie lo renombra.
 * 🔴 La v1 que se escribe se valida con `planOfferDefinition` ANTES de escribirla: una v1 rota convertiría cada compra en un
 *    503 `PLAN_NOT_CONFIGURED`.
 *
 * Dinero: centavos enteros CON IVA (excepción declarada de `critical-warnings.md`); las listas híbridas, en pesos.
 */
import type Stripe from 'stripe'
import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { STANDARD_PLAN_GROSS_CENTS } from '../access/planPricing.constants'
import { stripe, planLookupKey, type PlanTierCode } from '../stripe.service'
import { planListCompositionGap } from '../launchCampaigns/hybridListPrice.service'
import { hybridOfferDefinition } from '../launchCampaigns/hybridOffer.schema'
import { lockProducts, priceTransaction } from '../launchCampaigns/hybridProduct'
import {
  existeVersionDeLaOferta,
  ofertaDeRespaldo,
  planOfferDefinition,
  tomarCandadoDeLaOferta,
  type Periodicidad,
  type PlanPagado,
  type Ranura,
} from './planOffer'

export type ResultadoDelSembrado = 'CREATE' | 'EXISTS' | 'MISMATCH' | 'WRONG_PRODUCT' | 'MISSING'

export interface RanuraDelSembrado {
  ranura: Ranura
  lookupKey: string
  priceId: string | null
  productId: string | null
  /** `Feature.stripeProductId` del plan: donde debe vivir el precio. */
  productoEsperado: string | null
  unitAmount: number | null
  /** El monto de hoy, con IVA, en centavos. */
  esperado: number
  resultado: ResultadoDelSembrado
  motivo: string | null
}

export interface ListaDelSembrado {
  tier: PlanPagado
  /** La publicación en venta de la lista `PLAN:<tier>` (la que guarda la v1). */
  publicationId: string | null
  /** Su precio mensual, en PESOS con IVA. */
  price: number | null
  resultado: ResultadoDelSembrado
  motivo: string | null
}

export type ReconocidoPor = 'PRODUCTO' | 'LLAVE' | 'NINGUNO'

export interface ReporteDelSembrado {
  resultado: ResultadoDelSembrado
  /**
   * La base todavía no tiene las tablas de B1 (Prisma `P2021` al leer el puntero): se revisa como «sin versión». Sólo la
   * simulación lo tolera; sembrar exige primero la migración.
   */
  sinTablasDeB1: boolean
  ranuras: RanuraDelSembrado[]
  listas: ListaDelSembrado[]
  productos: Array<{ tier: PlanPagado; productId: string | null; nombre: string | null }>
  suscripcionesVivas: {
    revisadas: number
    /** Se detuvo en `TOPE_DE_SUSCRIPCIONES` y quedaban más por leer. */
    truncado: boolean
    porProducto: Array<{ productId: string; reconocidoPor: ReconocidoPor; cuantas: number }>
  }
}

const PLANES: readonly PlanPagado[] = ['PRO', 'PREMIUM']
const CODIGO_DEL_PLAN: Record<PlanPagado, PlanTierCode> = { PRO: 'PLAN_PRO', PREMIUM: 'PLAN_PREMIUM' }
const RANURAS: ReadonlyArray<{ ranura: Ranura; tier: PlanPagado; periodicidad: Periodicidad; intervalo: 'month' | 'year' }> = [
  { ranura: 'PRO:monthly', tier: 'PRO', periodicidad: 'monthly', intervalo: 'month' },
  { ranura: 'PRO:annual', tier: 'PRO', periodicidad: 'annual', intervalo: 'year' },
  { ranura: 'PREMIUM:monthly', tier: 'PREMIUM', periodicidad: 'monthly', intervalo: 'month' },
  { ranura: 'PREMIUM:annual', tier: 'PREMIUM', periodicidad: 'annual', intervalo: 'year' },
]
const LLAVE_DE_LISTA = (tier: PlanPagado) => `PLAN:${tier}` as const

/** Los estados de una suscripción que todavía puede cobrar (los que el reporte cuenta). */
const ESTADOS_VIVOS = ['active', 'trialing', 'past_due', 'unpaid'] as const
/** Tope de suscripciones revisadas: el reporte es informativo y no recorre un catálogo sin fin. */
export const TOPE_DE_SUSCRIPCIONES = 2000
/** La misma regla que reconoce un plan por la llave de su precio (`obligacionesDeCobro.ts`). */
const PLAN_POR_LLAVE = /^plan_(pro|premium)_/

const PRIORIDAD: readonly ResultadoDelSembrado[] = ['MISSING', 'WRONG_PRODUCT', 'MISMATCH']
const MOTIVO_LISTA_CAMBIO = 'la lista cambió durante el sembrado; vuelve a correrlo'

/**
 * El resultado de todo el sembrado (pura): `EXISTS` (ya hay vigente) > `MISSING` > `WRONG_PRODUCT` > `MISMATCH` > `CREATE`.
 */
export function resultadoDelSembrado(
  ranuras: ReadonlyArray<Pick<RanuraDelSembrado, 'resultado'>>,
  listas: ReadonlyArray<Pick<ListaDelSembrado, 'resultado'>>,
  yaExiste: boolean,
): ResultadoDelSembrado {
  if (yaExiste) return 'EXISTS'
  const todos = [...ranuras, ...listas].map(x => x.resultado)
  return PRIORIDAD.find(r => todos.includes(r)) ?? 'CREATE'
}

/**
 * ¿Ya hay una versión vigente? Una base sin las tablas de B1 (`P2021`: la simulación corre contra producción antes de unir)
 * es «sin versión», y lo dice. Cualquier otro error sube: no se confunde con «sin versión».
 */
export async function versionExistente(db: Prisma.TransactionClient | typeof prisma = prisma): Promise<{
  existe: boolean
  sinTablasDeB1: boolean
}> {
  try {
    return { existe: await existeVersionDeLaOferta(db), sinTablasDeB1: false }
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'P2021') return { existe: false, sinTablasDeB1: true }
    throw error
  }
}

const productoDe = (price: Pick<Stripe.Price, 'product'>): string | null =>
  !price.product ? null : typeof price.product === 'string' ? price.product : price.product.id

const pesos = (cents: number | null) => (cents === null ? 'sin monto' : `$${(cents / 100).toFixed(2)}`)

/** Una ranura: el precio de su llave contra el producto y el monto de hoy. */
async function revisarRanura(
  r: (typeof RANURAS)[number],
  feature: { active: boolean; stripeProductId: string | null } | undefined,
): Promise<RanuraDelSembrado> {
  const lookupKey = planLookupKey(CODIGO_DEL_PLAN[r.tier], r.periodicidad)
  const esperado = STANDARD_PLAN_GROSS_CENTS[r.tier][r.periodicidad]
  // 🔴 La lista de Stripe por llave es consistente (no la búsqueda): se lee la llave, sin recorrer el catálogo.
  const lista = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 2 })
  const price = lista.data[0] ?? null
  const base = {
    ranura: r.ranura,
    lookupKey,
    priceId: price?.id ?? null,
    productId: price ? productoDe(price) : null,
    productoEsperado: feature?.stripeProductId ?? null,
    unitAmount: price?.unit_amount ?? null,
    esperado,
  }
  const con = (resultado: ResultadoDelSembrado, motivo: string | null): RanuraDelSembrado => ({ ...base, resultado, motivo })
  const codigo = CODIGO_DEL_PLAN[r.tier]

  if (!feature || !feature.active) return con('MISSING', `no hay una Feature ${codigo} activa`)
  if (!feature.stripeProductId) return con('MISSING', `la Feature ${codigo} no tiene producto de Stripe`)
  if (!price) return con('MISSING', `no hay precio con la llave ${lookupKey}`)
  if (base.productId !== feature.stripeProductId)
    return con('WRONG_PRODUCT', `el precio vive en ${base.productId ?? 'ningún producto'} y el plan es ${feature.stripeProductId}`)
  if (lista.data.length > 1 || lista.has_more) return con('MISMATCH', `hay más de un precio con la llave ${lookupKey}`)
  if (!price.active) return con('MISMATCH', 'el precio de la llave está archivado')
  if (price.unit_amount !== esperado) return con('MISMATCH', `cobra ${pesos(price.unit_amount)} y el plan ${pesos(esperado)}`)
  if (price.currency !== 'mxn') return con('MISMATCH', `está en ${price.currency}, no en mxn`)
  if (price.tax_behavior !== 'inclusive') return con('MISMATCH', `su IVA es ${price.tax_behavior ?? 'sin definir'}, no incluido`)
  if (price.recurring?.interval !== r.intervalo || price.recurring?.interval_count !== 1)
    return con(
      'MISMATCH',
      `se cobra cada ${price.recurring?.interval_count ?? '?'} ${price.recurring?.interval ?? 'sin periodicidad'}, no cada 1 ${r.intervalo}`,
    )
  return con('CREATE', null)
}

type ListaLeida = {
  id: string
  listProductKey: string | null
  status: string
  currentPublicationId: string | null
  pendingPublicationId: string | null
}

async function leerListas(db: Prisma.TransactionClient | typeof prisma): Promise<ListaLeida[]> {
  return db.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: PLANES.map(LLAVE_DE_LISTA) } },
    select: { id: true, listProductKey: true, status: true, currentPublicationId: true, pendingPublicationId: true },
    take: PLANES.length,
  })
}

/** Una lista `PLAN:<tier>`: en venta, sin pendiente, a su precio y con la composición del código. */
async function revisarLista(
  tier: PlanPagado,
  list: ListaLeida | undefined,
  precios: Map<string, number | null>,
): Promise<ListaDelSembrado> {
  const publicationId = list?.currentPublicationId ?? null
  const price = publicationId ? (precios.get(publicationId) ?? null) : null
  const con = (resultado: ResultadoDelSembrado, motivo: string | null): ListaDelSembrado => ({
    tier,
    publicationId,
    price,
    resultado,
    motivo,
  })
  const llave = LLAVE_DE_LISTA(tier)
  const esperado = STANDARD_PLAN_GROSS_CENTS[tier].monthly

  if (!list || !publicationId) return con('MISSING', `no hay lista ${llave} con precio en venta: corre seed-plan-list-prices.ts --apply`)
  if (list.pendingPublicationId)
    return con('MISMATCH', `la lista ${llave} tiene un precio pendiente: termínalo con seed-plan-list-prices.ts --apply`)
  if (list.status !== 'ACTIVE') return con('MISMATCH', `la lista ${llave} no está en venta (${list.status})`)
  if (price === null) return con('MISMATCH', `no se pudo leer el precio de la publicación ${publicationId}`)
  // La lista guarda pesos con IVA; se compara al centavo contra el monto de hoy.
  if (Math.round(price * 100) !== esperado) return con('MISMATCH', `la lista vende a $${price.toFixed(2)} y el plan a ${pesos(esperado)}`)
  const gap = await planListCompositionGap(tier)
  if (gap.missing.length || gap.extra.length) {
    const partes = [
      gap.missing.length ? `le falta ${gap.missing.join(', ')}` : '',
      gap.extra.length ? `le sobra ${gap.extra.join(', ')}` : '',
    ]
    return con(
      'MISMATCH',
      `la lista ${llave} vende otra composición (${partes.filter(Boolean).join(' y ')}): corre \`seed-plan-list-prices.ts --apply\` antes de sembrar`,
    )
  }
  return con('CREATE', null)
}

async function nombreDelProducto(productId: string | null): Promise<string | null> {
  if (!productId) return null
  try {
    return (await stripe.products.retrieve(productId)).name ?? null
  } catch (error) {
    // Sólo es para el reporte: el nombre no decide nada.
    logger.warn('planOfferSeed: no se pudo leer el nombre del producto del plan', {
      productId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Cuántas suscripciones vivas de plan reconoce cada producto, con tope. Una suscripción es de plan si su producto es el de un
 * plan (`PRODUCTO`), si sólo la llave de su precio lo dice (`LLAVE`: el catálogo no conoce ese producto) o si sólo su
 * metadata lo dice (`NINGUNO`: ni el catálogo ni la llave la reconocen). Lo demás (funciones sueltas) no se cuenta.
 */
async function revisarSuscripcionesVivas(productosDelPlan: Set<string>): Promise<ReporteDelSembrado['suscripcionesVivas']> {
  const cuenta = new Map<string, { productId: string; reconocidoPor: ReconocidoPor; cuantas: number }>()
  const sumar = (productId: string, reconocidoPor: ReconocidoPor) => {
    const clave = `${productId}|${reconocidoPor}`
    const actual = cuenta.get(clave) ?? { productId, reconocidoPor, cuantas: 0 }
    actual.cuantas += 1
    cuenta.set(clave, actual)
  }
  let revisadas = 0
  let truncado = false

  recorrido: for (const status of ESTADOS_VIVOS) {
    let despuesDe: string | undefined
    for (;;) {
      if (revisadas >= TOPE_DE_SUSCRIPCIONES) {
        truncado = true
        break recorrido
      }
      const pagina = await stripe.subscriptions.list({
        status,
        limit: Math.min(100, TOPE_DE_SUSCRIPCIONES - revisadas),
        ...(despuesDe ? { starting_after: despuesDe } : {}),
      })
      for (const sub of pagina.data) {
        revisadas += 1
        const items = sub.items?.data ?? []
        const porProducto = items.find(item => productosDelPlan.has(productoDe(item.price) ?? ''))
        if (porProducto) {
          sumar(productoDe(porProducto.price)!, 'PRODUCTO')
          continue
        }
        const porLlave = items.find(item => PLAN_POR_LLAVE.test(item.price?.lookup_key ?? ''))
        if (porLlave) {
          sumar(productoDe(porLlave.price) ?? '(sin producto)', 'LLAVE')
          continue
        }
        const codigo = sub.metadata?.featureCode ?? sub.metadata?.tierCode
        if (codigo === 'PLAN_PRO' || codigo === 'PLAN_PREMIUM')
          sumar((items[0] && productoDe(items[0].price)) ?? '(sin producto)', 'NINGUNO')
      }
      if (!pagina.has_more || pagina.data.length === 0) break
      despuesDe = pagina.data[pagina.data.length - 1].id
    }
  }

  const porProducto = [...cuenta.values()].sort(
    (a, b) => a.productId.localeCompare(b.productId) || a.reconocidoPor.localeCompare(b.reconocidoPor),
  )
  return { revisadas, truncado, porProducto }
}

const REPORTE_VACIO = (resultado: ResultadoDelSembrado, sinTablasDeB1: boolean): ReporteDelSembrado => ({
  resultado,
  sinTablasDeB1,
  ranuras: [],
  listas: [],
  productos: [],
  suscripcionesVivas: { revisadas: 0, truncado: false, porProducto: [] },
})

/**
 * ¿Se puede sembrar la v1? SÓLO LEE. Con una vigente responde `EXISTS` sin revisar nada más. Ver la cabecera del archivo.
 */
export async function revisarSembradoDeLaVersionUno(): Promise<ReporteDelSembrado> {
  const { existe, sinTablasDeB1 } = await versionExistente()
  if (existe) return REPORTE_VACIO('EXISTS', sinTablasDeB1)

  const features = await prisma.feature.findMany({
    where: { code: { in: PLANES.map(t => CODIGO_DEL_PLAN[t]) } },
    select: { code: true, active: true, stripeProductId: true },
    take: PLANES.length,
  })
  const featureDe = (tier: PlanPagado) => features.find(f => f.code === CODIGO_DEL_PLAN[tier])

  const ranuras: RanuraDelSembrado[] = []
  for (const r of RANURAS) ranuras.push(await revisarRanura(r, featureDe(r.tier)))

  const leidas = await leerListas(prisma)
  const ids = leidas.flatMap(l => (l.currentPublicationId ? [l.currentPublicationId] : []))
  const publicaciones = ids.length
    ? await prisma.hybridOfferPublication.findMany({ where: { id: { in: ids } }, select: { id: true, definition: true }, take: ids.length })
    : []
  const precios = new Map<string, number | null>(
    publicaciones.map(p => {
      const parsed = hybridOfferDefinition.safeParse(p.definition)
      return [p.id, parsed.success ? parsed.data.terms.price : null]
    }),
  )
  const listas: ListaDelSembrado[] = []
  for (const tier of PLANES)
    listas.push(
      await revisarLista(
        tier,
        leidas.find(l => l.listProductKey === LLAVE_DE_LISTA(tier)),
        precios,
      ),
    )

  const productos: ReporteDelSembrado['productos'] = []
  for (const tier of PLANES) {
    const productId = featureDe(tier)?.stripeProductId ?? null
    productos.push({ tier, productId, nombre: await nombreDelProducto(productId) })
  }

  const productosDelPlan = new Set(features.flatMap(f => (f.stripeProductId ? [f.stripeProductId] : [])))
  const suscripcionesVivas = await revisarSuscripcionesVivas(productosDelPlan)

  return { resultado: resultadoDelSembrado(ranuras, listas, false), sinTablasDeB1, ranuras, listas, productos, suscripcionesVivas }
}

type DentroDeLaTransaccion =
  | { resultado: 'EXISTS' }
  | { resultado: 'MISMATCH'; cambiaron: PlanPagado[] }
  | { resultado: 'CREATE'; versionId: string }

/**
 * Siembra la v1 si la revisión dio `CREATE`; con cualquier otro resultado no escribe nada. Dentro de `priceTransaction`:
 * candado de la oferta, luego los de producto (`precio:PLAN:PREMIUM`, `precio:PLAN:PRO`); con una vigente ya → `EXISTS`; relee
 * las dos listas y, si su vigente no es la del reporte o tienen pendiente, `MISMATCH` sin escribir. Si cuadran: la versión
 * `number: 1` `PUBLISHED`, el puntero `{ currentVersionId, revision: 1 }` y la bitácora `PLAN_OFFER_SEEDED`.
 */
export async function sembrarVersionUno(
  staffId: string,
): Promise<{ resultado: ResultadoDelSembrado; versionId: string | null; reporte: ReporteDelSembrado }> {
  const reporte = await revisarSembradoDeLaVersionUno()
  if (reporte.resultado !== 'CREATE') return { resultado: reporte.resultado, versionId: null, reporte }

  const publicacionDe = (tier: PlanPagado) => reporte.listas.find(l => l.tier === tier)!.publicationId!
  const definition = ofertaDeRespaldo()
  for (const r of reporte.ranuras) {
    const [tier, periodicidad] = r.ranura.split(':') as [PlanPagado, Periodicidad]
    definition[tier][periodicidad].stripePriceId = r.priceId
  }
  // 🔴 Antes de escribir: la v1 tiene que poder leerse (`ofertaVigente`) o cada compra sería un 503.
  const valida = planOfferDefinition.safeParse(definition)
  if (!valida.success) throw new Error(`planOfferSeed: la v1 armada no pasa su esquema: ${valida.error.message}`)
  const hybridPublicationIds = { PRO: publicacionDe('PRO'), PREMIUM: publicacionDe('PREMIUM') }

  const hecho = await priceTransaction<DentroDeLaTransaccion>(async tx => {
    // 🔴 Orden fijo de los candados: primero el de la oferta y luego los de producto (lockProducts los ordena: PREMIUM, PRO).
    await tomarCandadoDeLaOferta(tx)
    await lockProducts(tx, PLANES.map(LLAVE_DE_LISTA))
    if (await existeVersionDeLaOferta(tx)) return { resultado: 'EXISTS' }

    const releidas = await leerListas(tx)
    const cambiaron = PLANES.filter(tier => {
      const l = releidas.find(x => x.listProductKey === LLAVE_DE_LISTA(tier))
      return !l || l.currentPublicationId !== hybridPublicationIds[tier] || l.pendingPublicationId !== null || l.status !== 'ACTIVE'
    })
    if (cambiaron.length) return { resultado: 'MISMATCH', cambiaron }

    const now = new Date()
    const version = await tx.planOfferVersion.create({
      data: {
        number: 1,
        status: 'PUBLISHED',
        definition: valida.data as unknown as Prisma.InputJsonValue,
        hybridPublicationIds,
        createdById: staffId,
        publishedById: staffId,
        publishedAt: now,
      },
      select: { id: true },
    })
    await tx.planOfferPointer.upsert({
      where: { id: 'vigente' },
      create: { id: 'vigente', currentVersionId: version.id, revision: 1 },
      update: { currentVersionId: version.id, revision: 1 },
    })
    await tx.activityLog.create({
      data: {
        staffId,
        action: 'PLAN_OFFER_SEEDED',
        entity: 'PlanOfferVersion',
        entityId: version.id,
        data: {
          number: 1,
          priceIds: Object.fromEntries(reporte.ranuras.map(r => [r.ranura, r.priceId])),
          hybridPublicationIds,
        },
      },
    })
    return { resultado: 'CREATE', versionId: version.id }
  })

  if (hecho.resultado === 'EXISTS') return { resultado: 'EXISTS', versionId: null, reporte: { ...reporte, resultado: 'EXISTS' } }
  if (hecho.resultado === 'MISMATCH') {
    const listas = reporte.listas.map(l =>
      hecho.cambiaron.includes(l.tier) ? { ...l, resultado: 'MISMATCH' as const, motivo: MOTIVO_LISTA_CAMBIO } : l,
    )
    return { resultado: 'MISMATCH', versionId: null, reporte: { ...reporte, resultado: 'MISMATCH', listas } }
  }
  logger.info('planOfferSeed: sembrada la versión 1 de la oferta de los planes', { versionId: hecho.versionId, hybridPublicationIds })
  return { resultado: 'CREATE', versionId: hecho.versionId, reporte }
}
