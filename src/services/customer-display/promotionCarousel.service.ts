// src/services/customer-display/promotionCarousel.service.ts
import { Prisma, TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import { fingerprintOf } from './canonicalHash'
import { SingleFlightCache, esperarTodas, type PollWorkLimiter } from './pollWork'
import { configuredStorageBucket, recognizeStorageUrl } from './storageOrigins'
import {
  centavosDeLista,
  displayBadge,
  displayPriceCents,
  presentationRanks,
  proximaApertura,
  vigenteEn,
  zonaUtilizable,
  type PromocionParaAnuncio,
} from './promotionDisplay'

/**
 * El carrusel de promociones de la pantalla del cliente (spec §5.7.3): qué se DESCARGA primero y qué dice cada
 * tarjeta. La tablet decide el orden de PRESENTACIÓN con `presentationRank` (§8.4); aquí se decide la entrega.
 *
 * Presupuesto (§5.7.4): la zona del negocio y DOS consultas ligeras (sólo id, orden, nombre, fechas y horario), y
 * después UNA completa de las ≤ 50 elegidas. Se calcula a lo más una vez cada 60 s por venue para el poll.
 */

export const CAROUSEL_MAX_ITEMS = 50
export const CAROUSEL_ACTIVE_SCAN_MAX = 1_000
export const CAROUSEL_FUTURE_SCAN_MAX = 200
export const CAROUSEL_HORIZON_MS = 24 * 60 * 60 * 1000
const CAROUSEL_TTL_MS = 60_000
/** Topes de la lectura completa. Con más, la tarjeta sale sin precio ni insignia (`incompleta`): nunca se adivina. */
const MAX_GRUPOS = 20
const MAX_OPCIONES = 50

export interface CarouselCard {
  id: string
  name: string
  displayOrder: number
  presentationRank: number
  schedule: { daysOfWeek: number[]; timeFrom: string | null; timeUntil: string | null; validFrom: string | null; validUntil: string | null }
  displayPriceCents: number | null
  displayBadge: string | null
  photo: { url: string; version: string } | null
}

export interface CarouselResult {
  /** La zona CRUDA del negocio: la tablet la valida y, si es inválida, oculta las tarjetas (spec §8.5). */
  timezone: string
  carousel: CarouselCard[]
  truncated: boolean
  evaluated: number
  fingerprint: string
}

const LIGERO = {
  id: true,
  name: true,
  displayOrder: true,
  validFrom: true,
  validUntil: true,
  daysOfWeek: true,
  timeFrom: true,
  timeUntil: true,
} satisfies Prisma.PromotionSelect

const COMPLETO = {
  ...LIGERO,
  type: true,
  pricingMode: true,
  priceCents: true,
  imageUrl: true,
  updatedAt: true,
  groups: {
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: MAX_GRUPOS + 1,
    select: {
      minSelect: true,
      maxSelect: true,
      options: {
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        // ponytail: sin `relationJoins`, este `take` y el de grupos salen como `IN (…)` SIN `LIMIT` y Prisma recorta en
        // memoria (medido en la Task 13: 220 opciones leídas para usar ≤ 51 por grupo), y el editor no topa grupos ni
        // opciones (`promotion.schema.ts`). Techo: ≤ 50 promociones × TODAS sus opciones, filas diminutas. Si D3 mide grupos
        // enormes: topar en la escritura (decisión de producto) o leer las opciones con una ventana por grupo.
        take: MAX_OPCIONES + 1,
        // «Vendible» lo revisa la BASE en el `where` (Codex r1 #7): aquí sólo hace falta el precio de lista.
        select: { quantity: true, chargedQuantity: true, priceDeltaCents: true, product: { select: { price: true } } },
      },
    },
  },
} satisfies Prisma.PromotionSelect

type Completa = Prisma.PromotionGetPayload<{ select: typeof COMPLETO }>

/**
 * 🔴 «Vendible», EN LA BASE: toda opción con producto activo, sin borrar y de ESTE negocio (D8). Va en las DOS lecturas: en
 * las ligeras, antes del tope; en la completa, porque entre las dos algo pudo desactivarse y la completa sólo DESCARGA hasta
 * 51 opciones por grupo, pero la base revisa todas (Codex r1 #7).
 */
const vendible = (venueId: string): Prisma.PromotionWhereInput => ({
  groups: { every: { options: { every: { product: { venueId, active: true, deletedAt: null } } } } },
})

export async function buildPromotionCarousel(venueId: string, ahora: Date = new Date()): Promise<CarouselResult> {
  const horizonte = new Date(ahora.getTime() + CAROUSEL_HORIZON_MS)
  const noVencida: Prisma.PromotionWhereInput = { OR: [{ validUntil: null }, { validUntil: { gte: ahora } }] }
  const base: Prisma.PromotionWhereInput = { venueId, status: 'PUBLISHED', ...vendible(venueId) }

  // `esperarTodas`: dentro del lugar del poll, una lectura que falla no puede soltarlo con las otras vivas (Codex r1 #2).
  const [venue, porFecha, futuras] = await esperarTodas([
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
    // Paso ligero 1: vigentes por fecha, en el orden de entrega.
    prisma.promotion.findMany({
      where: { ...base, AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: ahora } }] }, noVencida] },
      select: LIGERO,
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      take: CAROUSEL_ACTIVE_SCAN_MAX + 1,
    }),
    // Paso ligero 2: las que abren por fecha dentro de 24 h. Consulta APARTE: nunca ocupan el tope de las vigentes (E4).
    prisma.promotion.findMany({
      where: { ...base, AND: [{ validFrom: { gt: ahora, lte: horizonte } }, noVencida] },
      select: LIGERO,
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      take: CAROUSEL_FUTURE_SCAN_MAX + 1,
    }),
  ])

  const truncated = porFecha.length > CAROUSEL_ACTIVE_SCAN_MAX || futuras.length > CAROUSEL_FUTURE_SCAN_MAX
  const candidatasPorFecha = porFecha.slice(0, CAROUSEL_ACTIVE_SCAN_MAX)
  const candidatasFuturas = futuras.slice(0, CAROUSEL_FUTURE_SCAN_MAX)
  const zonaCruda = venue?.timezone || DEFAULT_TIMEZONE
  const zona = zonaUtilizable(zonaCruda)

  // En memoria: el horario del día decide la entrega (1: vigentes ahora; 2: las que abren, por su próxima apertura).
  const vigentes: typeof porFecha = []
  const porAbrir: Array<{ p: (typeof porFecha)[number]; abre: number }> = []
  for (const p of candidatasPorFecha) {
    if (vigenteEn(p, ahora, zona)) vigentes.push(p)
    else {
      const abre = proximaApertura(p, ahora, zona, CAROUSEL_HORIZON_MS)
      if (abre) porAbrir.push({ p, abre: abre.getTime() })
    }
  }
  for (const p of candidatasFuturas) {
    const abre = proximaApertura(p, ahora, zona, CAROUSEL_HORIZON_MS)
    if (abre) porAbrir.push({ p, abre: abre.getTime() })
  }
  porAbrir.sort((x, y) => x.abre - y.abre || (x.p.id < y.p.id ? -1 : x.p.id > y.p.id ? 1 : 0))
  const elegidas = [...vigentes, ...porAbrir.map(x => x.p)].slice(0, CAROUSEL_MAX_ITEMS)

  // Paso completo: opciones, productos y foto, sólo de las elegidas.
  const completas = elegidas.length
    ? await prisma.promotion.findMany({
        where: { id: { in: elegidas.map(p => p.id) }, venueId, status: 'PUBLISHED', ...vendible(venueId) },
        select: COMPLETO,
        take: CAROUSEL_MAX_ITEMS,
      })
    : []
  const porId = new Map(completas.map(c => [c.id, c]))
  const armables = elegidas.map(p => porId.get(p.id)).filter((c): c is Completa => !!c)
  const rangos = presentationRanks(armables)
  const bucket = configuredStorageBucket()
  const carousel = armables.map(c => aTarjeta(c, rangos.get(c.id) ?? 0, bucket))

  return {
    timezone: zonaCruda,
    carousel,
    truncated,
    evaluated: candidatasPorFecha.length + candidatasFuturas.length,
    fingerprint: fingerprintOf({ timezone: zonaCruda, carousel }),
  }
}

function aTarjeta(c: Completa, presentationRank: number, bucket: string | null): CarouselCard {
  const incompleta = c.groups.length > MAX_GRUPOS || c.groups.some(g => g.options.length > MAX_OPCIONES)
  const paraAnuncio: PromocionParaAnuncio = {
    type: c.type,
    pricingMode: c.pricingMode,
    priceCents: c.priceCents,
    incompleta,
    groups: c.groups.slice(0, MAX_GRUPOS).map(g => ({
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.slice(0, MAX_OPCIONES).map(o => ({
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        priceDeltaCents: o.priceDeltaCents,
        listPriceCents: centavosDeLista(o.product.price),
      })),
    })),
  }
  return {
    id: c.id,
    name: c.name,
    displayOrder: c.displayOrder,
    presentationRank,
    schedule: {
      daysOfWeek: [...c.daysOfWeek].sort((a, b) => a - b), // mismo significado, misma huella
      timeFrom: c.timeFrom,
      timeUntil: c.timeUntil,
      validFrom: c.validFrom ? c.validFrom.toISOString() : null,
      validUntil: c.validUntil ? c.validUntil.toISOString() : null,
    },
    displayPriceCents: displayPriceCents(paraAnuncio),
    displayBadge: displayBadge(paraAnuncio),
    // La foto es un objeto MUTABLE (storage.rules deja escribir ahí): viaja su versión y la tablet la revalida (§8.1).
    photo: c.imageUrl && recognizeStorageUrl(c.imageUrl, bucket) ? { url: c.imageUrl, version: c.updatedAt.toISOString() } : null,
  }
}

const cache = new SingleFlightCache<CarouselResult>({ ttlMs: CAROUSEL_TTL_MS, maxEntradas: 5_000 })

/**
 * DD2 y R9: sin `PROMOTIONS` no hay catálogo que bajar. La huella es este LITERAL —la tablet lo reconoce sin calcular nada y
 * no pide `/promotions` mientras lo vea (protocolo en el plan, «Sin acceso a promociones»)—. Un sha256 recortado en ceros
 * es 1 en 2^128: una probabilidad despreciable, no una imposibilidad (Codex r2).
 */
export const NO_PROMOTIONS_FINGERPRINT = '00000000000000000000000000000000'

export function readCarouselCached(venueId: string, o: { limiter?: PollWorkLimiter } = {}): Promise<CarouselResult> {
  return cache.get(venueId, () => buildPromotionCarousel(venueId), { limiter: o.limiter })
}

/**
 * Lo pide una tablet que ya vio una huella calculada DESPUÉS del cambio. 🔴 Nunca lo uses para invalidar tras una
 * escritura (un hook al editar una promoción): con la ventana de `REFRESH_COALESCE_MS` se uniría a un refresh iniciado
 * ANTES de la escritura y guardaría lo viejo como fresco por 60 s (revisión de la Task 6, menor 6).
 */
export function refreshCarousel(venueId: string): Promise<CarouselResult> {
  return cache.refresh(venueId, () => buildPromotionCarousel(venueId))
}

export function peekCarouselFingerprint(venueId: string): string | undefined {
  return cache.peek(venueId)?.fingerprint
}

export function resetCarouselCacheForTests(): void {
  cache.clearForTests()
}

export type CarouselForDevice =
  | {
      /** La zona con que se calculó la huella: la ruta la entrega en lugar de la del catálogo (Codex r1 #6). */
      timezone: string
      carousel: CarouselCard[]
      carouselTruncated: boolean
      carouselEvaluated: number
      carouselStatus: 'ok'
      fingerprints: { promotions: string }
    }
  | { carouselStatus: 'failed' }

/**
 * El carrusel que `/promotions` agrega SÓLO para el aparato que lo entiende: POS_ANDROID con binding exacto y versión
 * de diseño ≥ 2 (decisión 1). iOS, las apps viejas y las llamadas sin cabecera reciben el contrato de siempre.
 * Fresco (`refresh`) y escrito a través de la caché: la huella que ve la tablet aquí es la que verá en el poll. Tras una
 * edición, las N tablets del venue llegan casi a la vez: `refresh` reusa la construcción que otra ARRANCÓ hace ≤ 2 s
 * (`REFRESH_COALESCE_MS`, ruling de la Task 6 y F2 de la Task 13) —se une a ella si sigue en vuelo, o entrega lo que ya
 * guardó—, así que esta ruta arranca a lo más 1 construcción por venue cada 2 s, no N (salvo que la anterior haya fallado:
 * un error no se guarda). Las que arranca el poll por su caché (`readCarouselCached`) van aparte.
 * 🔴 Contrato para F2: si esta función truena ANTES de su `try` (la búsqueda del aparato), el controlador responde la
 * forma de siempre, SIN `carouselStatus`. Una tablet v2 trata un `carouselStatus` ausente como «no sé» y conserva su
 * último carrusel —igual que contra un servidor viejo—, nunca como «no hay promociones» (revisión de la Task 6, menor 1).
 */
export async function carouselForDevice(venueId: string, deviceUid: string | null): Promise<CarouselForDevice | null> {
  if (!deviceUid) return null
  const aparato = await prisma.terminal.findFirst({
    where: { venueId, deviceUid, type: TerminalType.POS_ANDROID },
    select: { customerDisplayDesignVersion: true },
  })
  if (!aparato || (aparato.customerDisplayDesignVersion ?? 0) < 2) return null
  try {
    const r = await refreshCarousel(venueId)
    return {
      timezone: r.timezone,
      carousel: r.carousel,
      carouselTruncated: r.truncated,
      carouselEvaluated: r.evaluated,
      carouselStatus: 'ok',
      fingerprints: { promotions: r.fingerprint },
    }
  } catch (error) {
    logger.warn('[pantalla-del-cliente] no se pudo armar el carrusel; /promotions sale sin él', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { carouselStatus: 'failed' }
  }
}
