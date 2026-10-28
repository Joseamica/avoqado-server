import { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'

/**
 * «Se cobra el precio que vio el cliente» (spec docs/superpowers/specs/2026-10-17-precio-que-vio-el-cliente-design.md).
 * Si la tablet cobró con una lista vieja, el cliente paga el MÁS BAJO entre el precio que vio —si fue real en algún momento
 * de [catalogAt − holgura, hora de la venta] y el catálogo no tiene más de 72 h— y el precio vigente (`Product.price`, que
 * siempre pasa quien llama). Aquí vive la regla pura y la búsqueda en `ProductPriceHistory`; la orden la usa en
 * `order.mobile.service.ts`.
 *
 * Relojes: `catalogAt` y la hora de la venta los sella Node; el historial, Postgres (máquinas distintas en producción).
 * Por eso la ventana se abre `HOLGURA_DE_RELOJ_MS` hacia atrás y nunca hacia adelante: jamás se reconoce un precio
 * posterior a la venta.
 */

export const VENTANA_DEL_CATALOGO_MS = 72 * 3_600_000
export const HOLGURA_DE_RELOJ_MS = 60_000
/** Tope del servidor: candidatas por consulta al historial. */
export const TAMANO_DE_BLOQUE = 100
export const CODIGO_PRECIO_CAMBIADO = 'ORDER_PRICE_CHANGED'
/**
 * Epoch ms. Un catálogo anterior no se busca: no hay historial antes de la migración (el veredicto es el mismo) y así a
 * Postgres sólo llegan horas que sabe leer (el año 0 o el extremo de `Date` truenan el `::timestamptz`).
 */
export const CATALOGO_MAS_VIEJO_POSIBLE = Date.parse('2020-01-01T00:00:00.000Z')

/**
 * Precio que usó el servidor ≠ al que mostró la tablet, por línea. Centavos (el sufijo marca la excepción a los pesos).
 * Con `modifierId`, el cambio es de ESE extra de la línea (los centavos son del extra, por unidad); sin él, del producto.
 */
export interface CambioDePrecio {
  externalId: string | null
  productId: string
  productName: string
  modifierId?: string
  catalogAt: string | null
  displayedUnitPriceCents: number
  unitPriceCents: number
}

export type VeredictoDeLinea = 'COMO_HOY' | 'BAJO' | 'BUSCAR' | 'NO_RECONOCIDO'

/** Lo más que representan las apps (Int de 32 bits). */
const MAXIMO_CENTAVOS = 2_147_483_647

/** Centavos enteros 0…2^31−1; cualquier otra cosa es basura ⇒ `null` («como hoy», nunca un 400). */
export function precioMostradoValido(x: unknown): number | null {
  return Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAXIMO_CENTAVOS ? (x as number) : null
}

/**
 * El precio de extra que mostró la tablet (`displayedModifierPrices[modifierId]`, centavos) o `null`. Lo que no sea un objeto
 * se ignora entero; cada entrada, como `precioMostradoValido`. Nunca un 400.
 */
export function precioDeExtraMostrado(mostrados: unknown, modifierId: string): number | null {
  if (mostrados === null || typeof mostrados !== 'object' || Array.isArray(mostrados)) return null
  return Object.prototype.hasOwnProperty.call(mostrados, modifierId)
    ? precioMostradoValido((mostrados as Record<string, unknown>)[modifierId])
    : null
}

/**
 * En línea, la llegada al servidor. De la cola sin red, la hora en que el aparato capturó la venta (`createdAtLocal`,
 * epoch ms, número o texto de sólo dígitos), acotada POR ARRIBA a la llegada (un reloj adelantado no la mueve al futuro).
 * Sin piso. Ilegible ⇒ la llegada.
 */
export function horaDeLaVenta(input: { isOfflineReplay?: boolean; createdAtLocal?: number | string | null }, llegada: Date): Date {
  if (input.isOfflineReplay !== true) return llegada
  const v = input.createdAtLocal
  const capturada = new Date(typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN)
  if (Number.isNaN(capturada.getTime())) return llegada
  return capturada < llegada ? capturada : llegada
}

/** `llegada` sólo de la cola: con ella, la hora de la línea es la de `horaDeLaLinea` y un catálogo posterior no se reconoce. */
export function clasificarLinea(a: {
  actualCents: number
  mostradoCents: number | null
  catalogAt: Date | null
  horaDeLaVenta: Date
  llegada?: Date
}): VeredictoDeLinea {
  if (a.mostradoCents === null || a.mostradoCents === a.actualCents) return 'COMO_HOY'
  if (a.mostradoCents > a.actualCents) return 'BAJO'
  // Una fecha inválida compararía `false` contra todo y caería en BUSCAR: se descarta antes (`NaN < piso` es `false`).
  if (a.catalogAt === null || Number.isNaN(a.catalogAt.getTime()) || a.catalogAt.getTime() < CATALOGO_MAS_VIEJO_POSIBLE)
    return 'NO_RECONOCIDO'
  // De la cola: el servidor fechó el catálogo DESPUÉS de recibir la venta; no pudo verse al venderla.
  if (a.llegada && a.catalogAt.getTime() > a.llegada.getTime()) return 'NO_RECONOCIDO'
  const edad = horaDeLaLinea(a.catalogAt, a.horaDeLaVenta, a.llegada).getTime() - a.catalogAt.getTime()
  if (edad < -HOLGURA_DE_RELOJ_MS || edad > VENTANA_DEL_CATALOGO_MS) return 'NO_RECONOCIDO'
  return 'BUSCAR'
}

/**
 * Hasta cuándo pudo venderse la línea. En línea, la hora de la venta. De la cola (con `llegada`), `catalogAt` lo selló el
 * SERVIDOR y la hora capturada el aparato, cuyo reloj puede ir atrasado o adelantado: la venta no pudo ser antes de leer ese
 * catálogo ni después de llegar ⇒ `min(llegada, max(horaDeLaVenta, catalogAt))` (Codex plan-r2 #9).
 * 🔴 Codex servidor r1 #5: una hora capturada claramente ANTES del catálogo (más que la holgura) es un reloj equivocado y no dice
 * cuándo se vendió: la única cota cierta es la llegada. Acotarla a `catalogAt` daba edad 0 y un catálogo de 96 h pasaba la regla.
 */
function horaDeLaLinea(catalogAt: Date, horaDeLaVenta: Date, llegada?: Date): Date {
  if (!llegada) return horaDeLaVenta
  if (horaDeLaVenta.getTime() < catalogAt.getTime() - HOLGURA_DE_RELOJ_MS) return llegada
  return new Date(Math.min(llegada.getTime(), Math.max(horaDeLaVenta.getTime(), catalogAt.getTime())))
}

/** La holgura sólo amplía hacia atrás; la ventana termina en la hora de la línea. */
export function ventanaDeLaLinea(catalogAt: Date, horaDeLaVenta: Date, llegada?: Date): { desde: Date; hasta: Date } {
  return { desde: new Date(catalogAt.getTime() - HOLGURA_DE_RELOJ_MS), hasta: horaDeLaLinea(catalogAt, horaDeLaVenta, llegada) }
}

// Identificadores fijos (nunca del cliente): Prisma no parametriza nombres de tabla o columna.
const HISTORIAL_DE_PRODUCTO = { tabla: Prisma.sql`"ProductPriceHistory"`, columna: Prisma.sql`"productId"` }
const HISTORIAL_DE_EXTRA = { tabla: Prisma.sql`"ModifierPriceHistory"`, columna: Prisma.sql`"modifierId"` }

/**
 * ¿Cada candidata fue el precio vigente de su producto, en ESTE negocio, en algún momento de su ventana? Alineado con
 * `candidatas`. Una consulta por bloque de `TAMANO_DE_BLOQUE`; `EXISTS` por candidata, así que un producto con mucha
 * historia nunca tapa a otro (no hay `LIMIT` sobre el historial). Intervalos `[validFrom, validTo)`; las horas se pasan
 * como texto ISO y se llevan a UTC sin zona, igual que las columnas, sin importar la zona de la sesión.
 */
export function preciosQueFueronVigentes(
  venueId: string,
  candidatas: Array<{ productId: string; mostradoCents: number; desde: Date; hasta: Date }>,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<boolean[]> {
  return fueronVigentes(
    HISTORIAL_DE_PRODUCTO,
    venueId,
    candidatas.map(c => ({ ...c, id: c.productId })),
    db,
  )
}

/** Gemela de `preciosQueFueronVigentes` para los extras, sobre `"ModifierPriceHistory"` (trae su `venueId`). */
export function preciosDeExtrasQueFueronVigentes(
  venueId: string,
  candidatas: Array<{ modifierId: string; mostradoCents: number; desde: Date; hasta: Date }>,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
): Promise<boolean[]> {
  return fueronVigentes(
    HISTORIAL_DE_EXTRA,
    venueId,
    candidatas.map(c => ({ ...c, id: c.modifierId })),
    db,
  )
}

async function fueronVigentes(
  historial: typeof HISTORIAL_DE_PRODUCTO,
  venueId: string,
  candidatas: Array<{ id: string; mostradoCents: number; desde: Date; hasta: Date }>,
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
): Promise<boolean[]> {
  const vigentes = candidatas.map(() => false)
  for (let inicio = 0; inicio < candidatas.length; inicio += TAMANO_DE_BLOQUE) {
    const filas = candidatas.slice(inicio, inicio + TAMANO_DE_BLOQUE).map(
      (c, j) =>
        Prisma.sql`(${inicio + j}::int, ${c.id}::text, ${new Prisma.Decimal(c.mostradoCents).div(100)}::numeric,
          (${c.desde.toISOString()}::timestamptz AT TIME ZONE 'UTC'), (${c.hasta.toISOString()}::timestamptz AT TIME ZONE 'UTC'))`,
    )
    const encontradas = await db.$queryRaw<Array<{ i: number }>>(Prisma.sql`
      SELECT c.i FROM (VALUES ${Prisma.join(filas)}) AS c(i, ref_id, price, desde, hasta)
      WHERE EXISTS (
        SELECT 1 FROM ${historial.tabla} h
        WHERE h."venueId" = ${venueId} AND h.${historial.columna} = c.ref_id AND h."price" = c.price
          AND h."validFrom" <= c.hasta AND (h."validTo" IS NULL OR h."validTo" > c.desde)
      )`)
    for (const { i } of encontradas) vigentes[i] = true
  }
  return vigentes
}

/** Decide por renglón y consulta el historial por bloques, con la misma conexión de la venta o del cambio. */
export async function resolverPreciosDeLineas(
  venueId: string,
  entradas: Array<{ productId: string; actualCents: number; displayedUnitPrice?: unknown; catalogAt?: unknown }>,
  horaDeLaVenta: Date,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
) {
  const lineas = entradas.map((item, k) => {
    const mostradoCents = precioMostradoValido(item.displayedUnitPrice)
    const catalogAt = typeof item.catalogAt === 'string' ? new Date(item.catalogAt) : null
    const veredicto = clasificarLinea({ actualCents: item.actualCents, mostradoCents, catalogAt, horaDeLaVenta })
    return { k, item, mostradoCents, catalogAt, veredicto, unitPriceCents: item.actualCents, respetado: false }
  })
  const buscar = lineas.filter(l => l.veredicto === 'BUSCAR')
  const vigentes = buscar.length
    ? await preciosQueFueronVigentes(
        venueId,
        buscar.map(l => ({
          productId: l.item.productId,
          mostradoCents: l.mostradoCents!,
          ...ventanaDeLaLinea(l.catalogAt!, horaDeLaVenta),
        })),
        db,
      )
    : []
  buscar.forEach((l, j) => {
    if (!vigentes[j]) return
    l.respetado = true
    l.unitPriceCents = l.mostradoCents!
  })
  return lineas
}

/**
 * Reintento de una orden que ya existe (respuesta perdida): reconstruye `priceChanges` comparando cada línea que trae precio
 * mostrado con la línea guardada del MISMO `externalId`. Sin `externalId` o sin guardada ⇒ nada; nunca adivina por
 * `productId` (el mismo producto puede venir en dos líneas con precios distintos). `catalogAt` = el de ESTE reintento. Los
 * extras, igual que en la creación: sólo con `catalogAt`, contra el `price` GUARDADO de ese extra en esa línea.
 */
export function cambiosDeOrdenExistente(
  items: Array<{
    externalId?: string | null
    productId?: string | null
    displayedUnitPrice?: unknown
    catalogAt?: unknown
    modifierIds?: string[]
    displayedModifierPrices?: unknown
  }>,
  guardados: Array<{
    externalId: string | null
    productId: string | null
    productName: string | null
    unitPrice: number /* pesos */
    modifiers?: Array<{ modifierId: string | null; price: number /* pesos */ }>
  }>,
): CambioDePrecio[] {
  const porLinea = new Map(guardados.filter(g => g.externalId).map(g => [g.externalId as string, g]))
  const cambios: CambioDePrecio[] = []
  for (const item of items) {
    const guardado = item.externalId ? porLinea.get(item.externalId) : undefined
    // Sin producto guardado (importe libre) no es línea de catálogo; el productId del cliente no cuenta.
    if (!guardado?.productId) continue
    const productId = guardado.productId
    const catalogAt = typeof item.catalogAt === 'string' ? item.catalogAt : null
    const cambio = (mostrado: number | null, pesos: number, modifierId?: string) => {
      const unitPriceCents = Math.round(pesos * 100)
      if (mostrado === null || unitPriceCents === mostrado) return
      cambios.push({
        externalId: item.externalId as string,
        productId,
        productName: guardado.productName ?? '',
        ...(modifierId ? { modifierId } : {}),
        catalogAt,
        displayedUnitPriceCents: mostrado,
        unitPriceCents,
      })
    }
    cambio(precioMostradoValido(item.displayedUnitPrice), guardado.unitPrice)
    if (catalogAt === null) continue
    for (const modifierId of new Set(Array.isArray(item.modifierIds) ? item.modifierIds : [])) {
      const extra = guardado.modifiers?.find(m => m.modifierId === modifierId)
      if (extra) cambio(precioDeExtraMostrado(item.displayedModifierPrices, modifierId), extra.price, modifierId)
    }
  }
  return cambios
}
