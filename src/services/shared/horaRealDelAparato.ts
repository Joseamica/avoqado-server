/**
 * La hora REAL de una venta o un cobro hecho sin internet (encargo 18cc7f, hz:8024bc1c:D93, founder 16-nov «B», como Square).
 *
 * `Order.createdAt` y `Payment.createdAt` siguen siendo la hora de LLEGADA al servidor: ~25 reglas de dinero la leen así (corte de
 * efectivo, turnos, terminales, pago al personal, factura global; lista en
 * `docs/audit/2026-11-16-hora-real-sin-red/lectores-de-la-hora-de-llegada.md` del workspace) y NO se tocan. La hora del aparato va
 * aparte, en `clientCreatedAt` (Square: `Payment.created_at` = llegada y `offline_payment_details.client_created_at`), y sólo la
 * leen los REPORTES elegidos, con «hora real ?? llegada».
 *
 * 🔴 Invariante que los lectores necesitan: `llegada − 24 h < clientCreatedAt < llegada`, y `createdAt` a lo más una hora de la
 * llegada. Por eso un lector puede filtrar por la hora real con el índice de siempre (`venueId, createdAt`), ensanchado
 * `MARGEN_DE_LECTURA_ANTES_MS` hacia atrás y `MARGEN_DE_LECTURA_MS` hacia adelante.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '@/utils/sqlDates'
import { getContext } from '@/observability/executionContext'

/** Hasta cuánto antes de su llegada se acepta la hora del aparato (Square también da 24 h para subir un cobro sin red). */
export const VENTANA_HORA_DEL_APARATO_MS = 24 * 60 * 60 * 1000

/**
 * Cuánto ensancha un lector el rango de `createdAt` hacia ADELANTE: la ventana más una hora para lo que tarda la petición entre que
 * entra (`llegada`) y que se inserta la fila (`createdAt`).
 */
export const MARGEN_DE_LECTURA_MS = VENTANA_HORA_DEL_APARATO_MS + 60 * 60 * 1000

/**
 * Y hacia ATRÁS: una hora. Quien no tiene la llegada del controlador la toma dentro de la transacción, y `createdAt` puede salir unos
 * milisegundos ANTES que ella; sin este margen, un cobro cuyo reloj iba apenas adelantado podría quedar fuera de los dos días.
 */
export const MARGEN_DE_LECTURA_ANTES_MS = 60 * 60 * 1000

/** Epoch ms (número o texto de sólo dígitos), ISO o `Date` ⇒ `Date`; lo ilegible ⇒ `null`. */
function leerHora(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v) : null
  if (typeof v === 'string' && v.trim() !== '') {
    const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * La hora del aparato que se guarda en `clientCreatedAt`, o `null` (= la hora de llegada, como hoy).
 *
 * Sólo de la cola (`isOfflineReplay === true`); con una hora legible ESTRICTAMENTE antes de `llegada` y estrictamente después de
 * `llegada − 24 h`. Un reloj adelantado (hora ≥ llegada) o una hora más vieja que la ventana NO se recorta a la orilla: se descarta,
 * porque una orilla inventada también miente en el reporte. `llegada` es cuando ENTRÓ la petición.
 */
export function horaRealDelAparato(input: { isOfflineReplay?: boolean | null; createdAtLocal?: unknown }, llegada: Date): Date | null {
  if (input.isOfflineReplay !== true) return null
  const hora = leerHora(input.createdAtLocal)
  if (!hora) return null
  const t = hora.getTime()
  const l = llegada.getTime()
  if (!(t < l)) return null
  if (!(t > l - VENTANA_HORA_DEL_APARATO_MS)) return null
  return hora
}

/**
 * La LLEGADA de la petición: cuando entró al servidor (la estampa `requestLogger` en el contexto, antes de middlewares, candados o
 * colas). Todos los escritores la usan, para que la ventana de 24 h no dependa de cuánto tardó el procesamiento (Codex D93 r2 #2 y
 * r3: la pasada exhaustiva de esa familia). Fuera de una petición (un job, una prueba), la que dé quien llama, o ahora.
 */
export function llegadaDeLaPeticion(siNoHay?: Date): Date {
  const t = getContext()?.llegadaAt
  return typeof t === 'number' && Number.isFinite(t) ? new Date(t) : (siNoHay ?? new Date())
}

/** `{ clientCreatedAt }` para un `create`, o `{}` (la llamada queda idéntica a la de hoy). */
export function conHoraRealDelAparato(
  input: { isOfflineReplay?: boolean | null; createdAtLocal?: unknown },
  llegada: Date,
): { clientCreatedAt?: Date } {
  const hora = horaRealDelAparato(input, llegada)
  return hora ? { clientCreatedAt: hora } : {}
}

/**
 * Filtro Prisma «la hora real cae en [desde, hasta]», ENVOLVIENDO el `where` que ya tenías en un `AND` (nunca se mezcla con sus
 * propias llaves `OR`/`AND`, como las del filtro por tipo de tarjeta). El `createdAt` ensanchado deja que Postgres use el índice
 * `(venueId, createdAt)`; la condición exacta es la del `OR`.
 */
export function dondeHoraRealEntre<W extends object>(where: W, desde: Date, hasta: Date): { AND: [W, RangoDeHoraReal] } {
  return {
    AND: [
      where,
      {
        createdAt: { gte: new Date(desde.getTime() - MARGEN_DE_LECTURA_ANTES_MS), lte: new Date(hasta.getTime() + MARGEN_DE_LECTURA_MS) },
        OR: [{ clientCreatedAt: { gte: desde, lte: hasta } }, { clientCreatedAt: null, createdAt: { gte: desde, lte: hasta } }],
      },
    ],
  }
}

/** Para un rango con un solo extremo: el otro, tan lejos que no recorta nada (ni lo fechado a futuro a mano). */
export const SIN_TOPE_ANTES = new Date('2000-01-01T00:00:00.000Z')
export const SIN_TOPE_DESPUES = new Date('9999-01-01T00:00:00.000Z')

/** La forma del filtro de `dondeHoraRealEntre`: sólo `createdAt` y `clientCreatedAt`, que tienen `Order` y `Payment` (D4: también órdenes). */
type RangoDeHoraReal = {
  createdAt: { gte: Date; lte: Date }
  OR: [{ clientCreatedAt: { gte: Date; lte: Date } }, { clientCreatedAt: null; createdAt: { gte: Date; lte: Date } }]
}

/** Texto SQL de la hora real de la fila (`alias` vacío = columnas sin calificar). */
export function sqlHoraReal(alias = ''): string {
  const a = alias ? `${alias}.` : ''
  return `COALESCE(${a}"clientCreatedAt", ${a}"createdAt")`
}

/**
 * Texto SQL «la hora real cae en [desde, hasta]» para `$queryRawUnsafe`. `desde` y `hasta` son expresiones `timestamp` sin zona
 * en UTC ya armadas por quien llama (p. ej. `utcTsParam(2)` o `$2::timestamp`): este texto no interpola valores, sólo las repite.
 */
export function sqlRangoHoraReal(alias: string, desde: string, hasta: string): string {
  const a = alias ? `${alias}.` : ''
  const horas = MARGEN_DE_LECTURA_MS / (60 * 60 * 1000)
  const horasAntes = MARGEN_DE_LECTURA_ANTES_MS / (60 * 60 * 1000)
  return (
    `${a}"createdAt" >= (${desde}) - INTERVAL '${horasAntes} hours' AND ${a}"createdAt" <= (${hasta}) + INTERVAL '${horas} hours'` +
    ` AND ${sqlHoraReal(alias)} >= ${desde} AND ${sqlHoraReal(alias)} <= ${hasta}`
  )
}

/** Lo mismo que `sqlRangoHoraReal`, para `$queryRaw` con plantilla: las fechas viajan como parámetros con `utcTs`. */
export function sqlRangoHoraRealSql(alias: string, desde: Date, hasta: Date): Prisma.Sql {
  const a = alias ? `${alias}.` : ''
  const llegada = Prisma.raw(`${a}"createdAt"`)
  const real = Prisma.raw(sqlHoraReal(alias))
  const antes = Prisma.raw(`INTERVAL '${MARGEN_DE_LECTURA_ANTES_MS / (60 * 60 * 1000)} hours'`)
  const despues = Prisma.raw(`INTERVAL '${MARGEN_DE_LECTURA_MS / (60 * 60 * 1000)} hours'`)
  return Prisma.sql`${llegada} >= ${utcTs(desde)} - ${antes} AND ${llegada} <= ${utcTs(hasta)} + ${despues} AND ${real} >= ${utcTs(desde)} AND ${real} <= ${utcTs(hasta)}`
}
