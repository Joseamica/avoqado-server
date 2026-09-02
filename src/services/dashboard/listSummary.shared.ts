/**
 * Piezas compartidas por los resúmenes de /payments y /orders del dashboard
 * (2026-09-01, incidente del query-guard: el dashboard bajaba 10,000 filas por venue
 * para contar pestañas y sumar tarjetas en el navegador).
 *
 * Aquí viven: el tope de página de los listados, el filtro de monto que hoy aplica el
 * cliente (subtotal/propina/total) traducido a SQL, y el parseo de listas CSV.
 */
import { Prisma } from '@prisma/client'

/**
 * Tope REAL de `pageSize` en los listados de pagos y órdenes. Regla del workspace
 * (`bounded-queries-and-server-load.md`): el backend impone el máximo, nunca confía en
 * el `limit` del cliente, y lo DECLARA en la respuesta (`meta.pageSize` efectivo +
 * `meta.maxPageSize`) para que ningún cliente pueda creer que recibió el total.
 */
export const LIST_PAGE_SIZE_MAX = 100
export const LIST_PAGE_SIZE_DEFAULT = 10

/** Un `pageSize` hostil (10000, -3, 'abc') cae al tope o al default. Nunca revienta. */
export function clampPageSize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return LIST_PAGE_SIZE_DEFAULT
  return Math.min(Math.trunc(n), LIST_PAGE_SIZE_MAX)
}

export function clampPage(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.trunc(n)
}

/** Lista separada por comas → arreglo sin vacíos, o undefined si no queda nada. */
export function parseCsv(raw?: string | string[]): string[] | undefined {
  if (!raw) return undefined
  const joined = Array.isArray(raw) ? raw.join(',') : raw
  const list = joined
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : undefined
}

/**
 * El mismo `AmountFilter` que usa el dashboard (`@/components/filters`): operador y
 * uno o dos valores. La aritmética de abajo replica al pie de la letra
 * `Payments.tsx`/`Orders.tsx`: un valor ausente cuenta como 0 (`filter.value || 0`)
 * y `between` es inclusivo en los dos extremos.
 */
export type AmountOperator = 'gt' | 'lt' | 'eq' | 'between'
export interface AmountFilter {
  operator: AmountOperator
  value?: number
  value2?: number
}

export const AMOUNT_OPERATORS: readonly AmountOperator[] = ['gt', 'lt', 'eq', 'between']

/**
 * 🔴 Un número de JS bindeado en `$queryRaw` llega como `numeric` PERO serializado con 16
 * dígitos (`99.99` → `99.98999999999999`, medido el 2026-09-01), así que `amount = 99.99`
 * nunca casa y `amount > 99.99` casa de más. Se manda como TEXTO y se castea: `'99.99'::numeric`
 * es el decimal exacto — lo que compara `Number(p.amount) === 99.99` en el navegador y lo que
 * Prisma manda en un `where` normal.
 */
export const decimalBind = (v: number): Prisma.Sql => Prisma.sql`(${String(v)})::numeric`

/** `expr` es la columna o expresión numérica ya escapada (p.ej. `p."amount"`). */
export function amountPredicate(expr: Prisma.Sql, filter: AmountFilter | undefined): Prisma.Sql {
  if (!filter) return Prisma.sql`TRUE`
  const v = Number(filter.value) || 0
  const v2 = Number(filter.value2) || 0
  switch (filter.operator) {
    case 'gt':
      return Prisma.sql`${expr} > ${decimalBind(v)}`
    case 'lt':
      return Prisma.sql`${expr} < ${decimalBind(v)}`
    case 'eq':
      return Prisma.sql`${expr} = ${decimalBind(v)}`
    case 'between':
      return Prisma.sql`(${expr} >= ${decimalBind(v)} AND ${expr} <= ${decimalBind(v2)})`
    default:
      return Prisma.sql`TRUE`
  }
}

/** Réplica en Node del mismo filtro — para las filas que no viven en Postgres (QR legacy). */
export function passesAmountFilter(value: number, filter: AmountFilter | undefined): boolean {
  if (!filter) return true
  const v = Number(filter.value) || 0
  const v2 = Number(filter.value2) || 0
  switch (filter.operator) {
    case 'gt':
      return value > v
    case 'lt':
      return value < v
    case 'eq':
      return value === v
    case 'between':
      return value >= v && value <= v2
    default:
      return true
  }
}

/**
 * Lee `<prefix>Op` / `<prefix>Value` / `<prefix>Value2` de la query ya validada.
 * Sin operador no hay filtro (igual que un `AmountFilter | null` en el cliente).
 */
export function amountFilterFromQuery(q: Record<string, unknown>, prefix: string): AmountFilter | undefined {
  const op = q[`${prefix}Op`]
  if (typeof op !== 'string' || !(AMOUNT_OPERATORS as readonly string[]).includes(op)) return undefined
  const value = q[`${prefix}Value`]
  const value2 = q[`${prefix}Value2`]
  return {
    operator: op as AmountOperator,
    value: value === undefined || value === '' ? undefined : Number(value),
    value2: value2 === undefined || value2 === '' ? undefined : Number(value2),
  }
}

/** `WHERE a AND b AND c` a partir de fragmentos; sin fragmentos, `TRUE`. */
export function andAll(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return Prisma.sql`TRUE`
  return Prisma.join(
    parts.map(p => Prisma.sql`(${p})`),
    ' AND ',
  )
}

/** `(a OR b OR c)`; sin fragmentos, `FALSE` — igual que un `OR: []` de Prisma, que no casa nada. */
export function orAny(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return Prisma.sql`FALSE`
  return Prisma.sql`(${Prisma.join(
    parts.map(p => Prisma.sql`(${p})`),
    ' OR ',
  )})`
}

/** `contains` + `mode: 'insensitive'` de Prisma → `ILIKE '%term%'`. */
export function ilikeContains(col: Prisma.Sql, term: string): Prisma.Sql {
  return Prisma.sql`${col} ILIKE ${`%${term}%`}`
}
