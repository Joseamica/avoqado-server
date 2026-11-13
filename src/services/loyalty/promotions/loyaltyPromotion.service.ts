import { LoyaltyPromotion, Prisma } from '@prisma/client'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { zonaValida } from '@/utils/datetime'

/**
 * Promociones de lealtad desde el panel (y el MCP): listar, crear, editar y terminar. Spec 2026-11-12 §4.1 y §4.3.
 *
 * - Fechas: el panel manda días del negocio (`YYYY-MM-DD`); se guardan instantes UTC. Regla 15 (ruling 4): el inicio no puede ser
 *   antes de hoy y `startsAt = max(inicio del día, ahora)`, al crear y al editar una programada.
 * - Estado: PROGRAMADA (aún no empieza), ACTIVA, TERMINADA (`endedAt` o `endsAt` ya pasó). Una ACTIVA sólo cambia su fecha de fin o
 *   se termina: lo ya otorgado nunca cambia de significado. Terminar guarda `endedAt = ahora`; no hay borrar.
 * - Tope: 10 activas + programadas por negocio, contado bajo un candado consultivo del negocio (dos altas a la vez no pasan las dos).
 */

export const MAX_PROMOS_VIVAS = 10
const PAGINA_DEFAULT = 50
const PAGINA_MAX = 100
const MAX_IDS = 200
/** Tope de la foto de productos de las categorías (Codex código r1 #2). */
const MAX_PRODUCTOS_DE_CATEGORIAS = 5_000
/** Cabe en `Decimal(12,2)`; el zod del panel tiene la misma cota. */
const GASTO_MINIMO_MAX = 9_999_999.99
/** Tope de página: `(page - 1) × pageSize` no desborda y nadie pagina 1,000,000 de promos. */
const PAGINA_NUM_MAX = 10_000

export const ESTADOS_DE_PROMO = ['ACTIVE', 'SCHEDULED', 'ENDED'] as const
export type EstadoDePromo = (typeof ESTADOS_DE_PROMO)[number]
const TIPOS = ['MULTIPLY', 'ADD'] as const
const LIMITES = ['NONE', 'ONCE_PER_DAY', 'ONCE_PER_PROMOTION'] as const

/** Lo que manda el panel. En una edición, cada campo ausente (`undefined`) se queda como está; `null` o `[]` lo limpia. */
export interface LoyaltyPromotionInput {
  name?: string
  kind?: (typeof TIPOS)[number]
  multiplier?: number | null
  extraStamps?: number | null
  extraPoints?: number | null
  /** Día del negocio `YYYY-MM-DD`. */
  startDate?: string
  /** Día del negocio `YYYY-MM-DD`, inclusive; `null` = sin fin. */
  endDate?: string | null
  /** 0 = domingo … 6 = sábado; vacío = todos. */
  daysOfWeek?: number[]
  /** `HH:mm` del negocio; los dos o ninguno. */
  timeFrom?: string | null
  timeUntil?: string | null
  productIds?: string[]
  categoryIds?: string[]
  /** Pesos. */
  minSpend?: number | null
  limit?: (typeof LIMITES)[number]
}

export type NewLoyaltyPromotionInput = LoyaltyPromotionInput & Required<Pick<LoyaltyPromotionInput, 'name' | 'kind' | 'startDate'>>

export interface ListLoyaltyPromotionsQuery {
  status?: EstadoDePromo
  page?: number
  pageSize?: number
}

export interface LoyaltyPromotionView {
  id: string
  name: string
  kind: string
  multiplier: number | null
  extraStamps: number | null
  extraPoints: number | null
  status: EstadoDePromo
  startsAt: Date
  endsAt: Date | null
  endedAt: Date | null
  /** Días del negocio, para mostrar y editar. */
  startDate: string
  endDate: string | null
  daysOfWeek: number[]
  timeFrom: string | null
  timeUntil: string | null
  productIds: string[]
  categoryIds: string[]
  /** Sólo los que siguen existiendo en el negocio, con su nombre actual. */
  products: { id: string; name: string }[]
  categories: { id: string; name: string }[]
  minSpend: number | null
  limit: string
  createdAt: Date
  updatedAt: Date
}

type Valores = Required<Omit<LoyaltyPromotionInput, 'startDate' | 'endDate'>>

export function estadoDePromo(p: Pick<LoyaltyPromotion, 'startsAt' | 'endsAt' | 'endedAt'>, ahora: Date): EstadoDePromo {
  if (p.endedAt || (p.endsAt && p.endsAt < ahora)) return 'ENDED'
  return ahora < p.startsAt ? 'SCHEDULED' : 'ACTIVE'
}

/** El mismo corte que `estadoDePromo`, en la base. `undefined` = todas; 'VIVA' = activas + programadas. */
function whereDeEstado(estado: EstadoDePromo | 'VIVA' | undefined, ahora: Date): Prisma.LoyaltyPromotionWhereInput {
  if (estado === undefined) return {}
  if (estado === 'ENDED') return { OR: [{ endedAt: { not: null } }, { endsAt: { lt: ahora } }] }
  const viva = { endedAt: null, OR: [{ endsAt: null }, { endsAt: { gte: ahora } }] }
  if (estado === 'SCHEDULED') return { ...viva, startsAt: { gt: ahora } }
  if (estado === 'ACTIVE') return { ...viva, startsAt: { lte: ahora } }
  return viva
}

const mal = (m: string) => new BadRequestError(m)
const enteroEntre = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max
const hastaDosDecimales = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
const sinRepetir = <T>(xs: T[]) => [...new Set(xs)]
const definidos = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

const diaDe = (d: Date, tz: string) => formatInTimeZone(d, tz, 'yyyy-MM-dd')

function diaValido(fecha: unknown, tz: string, campo: string): string {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw mal(`${campo} debe tener formato AAAA-MM-DD`)
  const mediodia = fromZonedTime(`${fecha}T12:00:00.000`, tz)
  if (isNaN(mediodia.getTime()) || diaDe(mediodia, tz) !== fecha) throw mal(`${campo} no es una fecha válida`)
  return fecha
}

function finDe(endDate: string | null, startDate: string, tz: string): Date | null {
  if (endDate === null) return null
  diaValido(endDate, tz, 'La fecha de fin')
  if (endDate < startDate) throw mal('La fecha de fin no puede ser antes del inicio')
  return fromZonedTime(`${endDate}T23:59:59.999`, tz)
}

/** Regla 15: nunca antes de hoy (del negocio) y nunca antes de este instante. */
function inicioDe(startDate: string, tz: string, ahora: Date): Date {
  diaValido(startDate, tz, 'La fecha de inicio')
  if (startDate < diaDe(ahora, tz)) throw mal('La promoción no puede empezar antes de hoy')
  const inicio = fromZonedTime(`${startDate}T00:00:00.000`, tz)
  return inicio > ahora ? inicio : ahora
}

function validar(v: Valores): Valores {
  const name = typeof v.name === 'string' ? v.name.trim() : ''
  if (!name) throw mal('El nombre de la promoción es obligatorio')
  if (name.length > 80) throw mal('El nombre admite hasta 80 caracteres')
  if (!TIPOS.includes(v.kind)) throw mal('El tipo debe ser «multiplica» (MULTIPLY) o «suma» (ADD)')
  if (v.kind === 'MULTIPLY') {
    if (!enteroEntre(v.multiplier, 2, 10)) throw mal('El multiplicador va de 2 a 10')
    if (v.extraStamps !== null || v.extraPoints !== null) throw mal('Una promoción que multiplica no lleva sellos ni puntos extra')
  } else {
    if (v.multiplier !== null) throw mal('Una promoción que suma no lleva multiplicador')
    if (v.extraStamps === null && v.extraPoints === null) throw mal('Indica cuántos sellos o puntos extra da la promoción')
    if (v.extraStamps !== null && !enteroEntre(v.extraStamps, 1, 9)) throw mal('Los sellos extra van de 1 a 9')
    if (v.extraPoints !== null && !enteroEntre(v.extraPoints, 1, 10_000)) throw mal('Los puntos extra van de 1 a 10,000')
  }
  if (!Array.isArray(v.daysOfWeek) || !v.daysOfWeek.every(d => enteroEntre(d, 0, 6))) throw mal('Los días van de 0 (domingo) a 6 (sábado)')
  if ((v.timeFrom === null) !== (v.timeUntil === null)) throw mal('Indica la hora de inicio y la de fin, o ninguna')
  const hora = /^([01]\d|2[0-3]):[0-5]\d$/
  if (v.timeFrom !== null && (!hora.test(v.timeFrom) || !hora.test(v.timeUntil!)))
    throw mal('La hora debe tener formato HH:mm (00:00 a 23:59)')
  for (const [ids, que] of [
    [v.productIds, 'productos'],
    [v.categoryIds, 'categorías'],
  ] as const) {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.length > 0)) throw mal(`La lista de ${que} no es válida`)
    if (ids.length > MAX_IDS) throw mal(`Una promoción admite hasta ${MAX_IDS} ${que}`)
  }
  if (v.productIds.length > 0 && v.categoryIds.length > 0) throw mal('Elige productos o categorías, no los dos')
  if (v.minSpend !== null && !(Number.isFinite(v.minSpend) && v.minSpend >= 0)) throw mal('El gasto mínimo no puede ser negativo')
  if (v.minSpend !== null && (v.minSpend > GASTO_MINIMO_MAX || !hastaDosDecimales(v.minSpend)))
    throw mal('El gasto mínimo va hasta $9,999,999.99, con hasta 2 decimales')
  if (!LIMITES.includes(v.limit)) throw mal('El límite por clienta debe ser NONE, ONCE_PER_DAY u ONCE_PER_PROMOTION')
  return {
    ...v,
    name,
    daysOfWeek: sinRepetir(v.daysOfWeek).sort((a, b) => a - b),
    productIds: sinRepetir(v.productIds),
    categoryIds: sinRepetir(v.categoryIds),
  }
}

const NUEVA: Omit<Valores, 'name' | 'kind'> = {
  multiplier: null,
  extraStamps: null,
  extraPoints: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  productIds: [],
  categoryIds: [],
  minSpend: null,
  limit: 'NONE',
}

const valoresDe = (p: LoyaltyPromotion): Valores => ({
  name: p.name,
  kind: p.kind,
  multiplier: p.multiplier,
  extraStamps: p.extraStamps,
  extraPoints: p.extraPoints,
  daysOfWeek: p.daysOfWeek,
  timeFrom: p.timeFrom,
  timeUntil: p.timeUntil,
  productIds: p.productIds,
  categoryIds: p.categoryIds,
  minSpend: p.minSpend === null ? null : Number(p.minSpend),
  limit: p.limit,
})

const columnas = (v: Valores) => ({
  name: v.name,
  kind: v.kind,
  multiplier: v.multiplier,
  extraStamps: v.extraStamps,
  extraPoints: v.extraPoints,
  daysOfWeek: v.daysOfWeek,
  timeFrom: v.timeFrom,
  timeUntil: v.timeUntil,
  productIds: v.productIds,
  categoryIds: v.categoryIds,
  minSpend: v.minSpend === null ? null : new Prisma.Decimal(v.minSpend),
  limit: v.limit,
})

/** Cada id debe ser de este negocio: una consulta acotada por lista. */
async function delNegocio(db: Prisma.TransactionClient, venueId: string, productIds: string[], categoryIds: string[]) {
  if (productIds.length && (await db.product.count({ where: { venueId, id: { in: productIds } } })) !== productIds.length)
    throw mal('Algún producto no existe o no es de este negocio')
  if (categoryIds.length && (await db.menuCategory.count({ where: { venueId, id: { in: categoryIds } } })) !== categoryIds.length)
    throw mal('Alguna categoría no existe o no es de este negocio')
}

/**
 * Codex código r1 #2 (ruling): foto de los productos que HOY están en esas categorías. Una venta sin red de un producto que cambió de
 * categoría antes de sincronizar nace con la categoría nueva; con la foto sigue calificando. Si alguien lo saca a propósito, sigue
 * calificando: bono de más, nunca de menos. Acotada: los primeros 5,000 por id.
 */
async function productosDeCategorias(db: Prisma.TransactionClient, venueId: string, categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return []
  const filas = await db.product.findMany({
    where: { venueId, categoryId: { in: categoryIds } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_PRODUCTOS_DE_CATEGORIAS + 1,
  })
  if (filas.length > MAX_PRODUCTOS_DE_CATEGORIAS)
    logger.warn('Promo de lealtad: las categorías tienen más de 5,000 productos; la foto guarda sólo los primeros 5,000 por id', {
      venueId,
      categoryIds,
    })
  return filas.slice(0, MAX_PRODUCTOS_DE_CATEGORIAS).map(f => f.id)
}

async function zonaDelNegocio(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return zonaValida(venue.timezone)
}

/** Un candado por negocio para las escrituras de promos (llave de 64 bits: no se cruza con los de clienta, que son de dos llaves). */
const candado = (tx: Prisma.TransactionClient, venueId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`loyalty-promotions:${venueId}`}, 0))`

async function buscar(tx: Prisma.TransactionClient, venueId: string, id: string) {
  const p = await tx.loyaltyPromotion.findFirst({ where: { id, venueId } })
  if (!p) throw new NotFoundError('Promoción de lealtad no encontrada')
  return p
}

/** Nombres actuales de productos y categorías de toda la página: dos consultas acotadas, sin N+1. */
async function aVista(promos: Omit<LoyaltyPromotion, 'categoryProductIds'>[], venueId: string, tz: string, ahora = new Date()): Promise<LoyaltyPromotionView[]> {
  const pIds = sinRepetir(promos.flatMap(p => p.productIds))
  const cIds = sinRepetir(promos.flatMap(p => p.categoryIds))
  const [productos, categorias] = await Promise.all([
    pIds.length
      ? prisma.product.findMany({ where: { venueId, id: { in: pIds } }, select: { id: true, name: true }, take: pIds.length })
      : [],
    cIds.length
      ? prisma.menuCategory.findMany({ where: { venueId, id: { in: cIds } }, select: { id: true, name: true }, take: cIds.length })
      : [],
  ])
  const nombres = (filas: { id: string; name: string }[], ids: string[]) => {
    const m = new Map(filas.map(f => [f.id, f.name]))
    return ids.filter(id => m.has(id)).map(id => ({ id, name: m.get(id)! }))
  }
  return promos.map(p => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    multiplier: p.multiplier,
    extraStamps: p.extraStamps,
    extraPoints: p.extraPoints,
    status: estadoDePromo(p, ahora),
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    endedAt: p.endedAt,
    startDate: diaDe(p.startsAt, tz),
    endDate: p.endsAt ? diaDe(p.endsAt, tz) : null,
    daysOfWeek: p.daysOfWeek,
    timeFrom: p.timeFrom,
    timeUntil: p.timeUntil,
    productIds: p.productIds,
    categoryIds: p.categoryIds,
    products: nombres(productos, p.productIds),
    categories: nombres(categorias, p.categoryIds),
    minSpend: p.minSpend === null ? null : Number(p.minSpend),
    limit: p.limit,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }))
}

const paraBitacora = (v: Valores, startsAt: Date, endsAt: Date | null) => ({
  ...v,
  startsAt: startsAt.toISOString(),
  endsAt: endsAt?.toISOString() ?? null,
})

/**
 * Orden estable: `startsAt desc, id desc` en los tres estados (usa el índice `[venueId, startsAt]`). En «Terminadas» queda primero la
 * que empezó más tarde; ordenar por «cuándo terminó» (`coalesce(endedAt, endsAt)`) pediría SQL crudo — se agrega si el panel lo pide.
 */
export async function listLoyaltyPromotions(venueId: string, query: ListLoyaltyPromotionsQuery = {}) {
  if (query.status !== undefined && !ESTADOS_DE_PROMO.includes(query.status)) throw mal('El estado debe ser ACTIVE, SCHEDULED o ENDED')
  const entero = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : d)
  const pageSize = Math.min(PAGINA_MAX, Math.max(1, entero(query.pageSize, PAGINA_DEFAULT)))
  const page = Math.min(PAGINA_NUM_MAX, Math.max(1, entero(query.page, 1)))
  const tz = await zonaDelNegocio(venueId)
  const ahora = new Date()
  const where = { venueId, ...whereDeEstado(query.status, ahora) }
  const [total, filas] = await Promise.all([
    prisma.loyaltyPromotion.count({ where }),
    prisma.loyaltyPromotion.findMany({
      where,
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      omit: { categoryProductIds: true }, // columna interna (hasta 5000 ids por promo): el panel no la usa
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return { items: await aVista(filas, venueId, tz, ahora), total, page, pageSize }
}

const topeLleno = () =>
  new ConflictError(`Ya hay ${MAX_PROMOS_VIVAS} promociones de lealtad activas o programadas: termina una para crear otra`)

/**
 * Las reglas de un alta, SIN escribir: zona del negocio, valores, fechas (regla 15), productos/categorías del negocio y el tope vivo
 * (sin candado). `createLoyaltyPromotion` la usa y vuelve a contar el tope bajo el candado; el MCP la usa para la vista previa.
 */
export async function validarNuevaPromocion(venueId: string, input: NewLoyaltyPromotionInput, opts: { contarTope?: boolean } = {}) {
  const tz = await zonaDelNegocio(venueId)
  const ahora = new Date()
  const v = validar({ ...NUEVA, ...definidos(input) } as Valores)
  const startsAt = inicioDe(input.startDate, tz, ahora)
  const endsAt = finDe(input.endDate ?? null, input.startDate, tz)
  await delNegocio(prisma, venueId, v.productIds, v.categoryIds)
  // El alta real no cuenta aquí: lo hace bajo el candado, que es la autoridad. La vista previa sí (`contarTope`, por default).
  if (
    opts.contarTope !== false &&
    (await prisma.loyaltyPromotion.count({ where: { venueId, ...whereDeEstado('VIVA', ahora) } })) >= MAX_PROMOS_VIVAS
  )
    throw topeLleno()
  return { tz, v, startsAt, endsAt }
}

export async function createLoyaltyPromotion(
  venueId: string,
  input: NewLoyaltyPromotionInput,
  staffId: string | null,
): Promise<LoyaltyPromotionView> {
  const { tz, v, startsAt, endsAt } = await validarNuevaPromocion(venueId, input, { contarTope: false })
  const createdById = staffId
    ? ((await prisma.staffVenue.findUnique({ where: { staffId_venueId: { staffId, venueId } }, select: { id: true } }))?.id ?? null)
    : null

  const p = await prisma.$transaction(async tx => {
    await candado(tx, venueId)
    // Regla 15 otra vez tras el candado: si otra alta lo tuvo, `startsAt` precalculado ya quedó en el pasado.
    const ahoraEnTx = new Date()
    const vivas = await tx.loyaltyPromotion.count({ where: { venueId, ...whereDeEstado('VIVA', ahoraEnTx) } })
    if (vivas >= MAX_PROMOS_VIVAS) throw topeLleno()
    const categoryProductIds = await productosDeCategorias(tx, venueId, v.categoryIds)
    return tx.loyaltyPromotion.create({
      data: { venueId, ...columnas(v), categoryProductIds, startsAt: startsAt > ahoraEnTx ? startsAt : ahoraEnTx, endsAt, createdById },
    })
  })

  void logAction({
    staffId,
    venueId,
    action: 'LOYALTY_PROMOTION_CREATED',
    entity: 'LoyaltyPromotion',
    entityId: p.id,
    data: paraBitacora(v, p.startsAt, endsAt),
  })
  return (await aVista([p], venueId, tz))[0]
}

/** Programada: cualquier campo. Activa: sólo `endDate` (≥ hoy del negocio). Terminada: nada. */
export async function updateLoyaltyPromotion(
  venueId: string,
  id: string,
  input: LoyaltyPromotionInput,
  staffId: string | null,
): Promise<LoyaltyPromotionView> {
  const tz = await zonaDelNegocio(venueId)
  const cambios = definidos(input)

  const r = await prisma.$transaction(async tx => {
    await candado(tx, venueId)
    const ahora = new Date()
    const actual = await buscar(tx, venueId, id)
    const estado = estadoDePromo(actual, ahora)
    if (estado === 'ENDED') throw new ConflictError('La promoción ya terminó: ya no se puede editar')
    if (Object.keys(cambios).length === 0) return { p: actual, estado, cambio: false }

    let data: Prisma.LoyaltyPromotionUpdateInput
    if (estado === 'ACTIVE') {
      if (Object.keys(cambios).some(k => k !== 'endDate'))
        throw new ConflictError('Una promoción activa sólo puede cambiar su fecha de fin o terminarse')
      const endDate = cambios.endDate as string | null
      if (endDate !== null && diaValido(endDate, tz, 'La fecha de fin') < diaDe(ahora, tz))
        throw mal('La fecha de fin no puede ser antes de hoy')
      data = { endsAt: finDe(endDate, diaDe(actual.startsAt, tz), tz) }
    } else {
      const v = validar({ ...valoresDe(actual), ...cambios } as Valores)
      await delNegocio(tx, venueId, cambios.productIds ? v.productIds : [], cambios.categoryIds ? v.categoryIds : [])
      const startsAt = cambios.startDate !== undefined ? inicioDe(cambios.startDate, tz, ahora) : actual.startsAt
      const endDate = cambios.endDate !== undefined ? cambios.endDate : actual.endsAt ? diaDe(actual.endsAt, tz) : null
      data = { ...columnas(v), startsAt, endsAt: finDe(endDate, diaDe(startsAt, tz), tz) }
      // Editar las categorías vuelve a tomar la foto (vacía si ya no hay categorías); otro campo no la toca.
      if (cambios.categoryIds !== undefined) data.categoryProductIds = await productosDeCategorias(tx, venueId, v.categoryIds)
    }
    return { p: await tx.loyaltyPromotion.update({ where: { id, venueId }, data }), estado, cambio: true }
  })

  if (r.cambio)
    void logAction({
      staffId,
      venueId,
      action: 'LOYALTY_PROMOTION_UPDATED',
      entity: 'LoyaltyPromotion',
      entityId: id,
      data: { estadoAntes: r.estado, cambios } as Prisma.InputJsonValue,
    })
  return (await aVista([r.p], venueId, tz))[0]
}

/** Guarda `endedAt = ahora`. Una ya terminada se devuelve igual (doble clic), sin volver a auditar. */
export async function endLoyaltyPromotion(venueId: string, id: string, staffId: string | null): Promise<LoyaltyPromotionView> {
  const tz = await zonaDelNegocio(venueId)

  const r = await prisma.$transaction(async tx => {
    await candado(tx, venueId)
    const ahora = new Date()
    const actual = await buscar(tx, venueId, id)
    if (estadoDePromo(actual, ahora) === 'ENDED') return { p: actual, cambio: false }
    return { p: await tx.loyaltyPromotion.update({ where: { id, venueId }, data: { endedAt: ahora } }), cambio: true }
  })

  if (r.cambio)
    void logAction({
      staffId,
      venueId,
      action: 'LOYALTY_PROMOTION_ENDED',
      entity: 'LoyaltyPromotion',
      entityId: id,
      data: { name: r.p.name, endedAt: r.p.endedAt?.toISOString() ?? null },
    })
  return (await aVista([r.p], venueId, tz))[0]
}
