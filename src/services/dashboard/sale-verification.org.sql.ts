/**
 * Expresiones SQL compartidas por las agregaciones de ventas de la organización.
 *
 * POR QUÉ EXISTE (incidente 2026-08-04): antes cada agregación se traía las 5,446 filas y
 * las agrupaba en JS, convirtiendo zona horaria fila por fila. Node corre en un solo hilo,
 * así que esos ~9 s de CPU por endpoint dejaban al servidor entero sin atender a nadie.
 * Postgres hace ese mismo trabajo en C y devuelve ~20 renglones ya sumados. Aquí viven las
 * expresiones para que el bucket sea idéntico en las 12 agregaciones y para poder probarlas
 * sin base de datos.
 *
 * 🔴 Los formatos DEBEN coincidir carácter por carácter con `src/utils/venueDateKeys.ts`:
 *   'YYYY-MM'      ↔ venueMonthKey
 *   'YYYY-MM-DD'   ↔ venueDayKey
 *   'IYYY-"W"IW'   ↔ venueIsoWeekKey   (IYYY = año ISO, NO el calendario)
 *   '"W"IW'        ↔ venueWeekLabel
 * La paridad está probada contra Postgres real en
 * `tests/api-tests/sale-verification.org.week-parity.test.ts`.
 *
 * 🔴 Sobre el doble `AT TIME ZONE`: `createdAt` es `timestamp without time zone` guardando
 * UTC real (ver `.claude/rules/critical-warnings.md`). El primero lo marca como UTC, el
 * segundo lo lleva a hora de pared del venue. Precedente:
 * `src/services/command-center/commandCenter.service.ts:590`.
 */
import { Prisma } from '@prisma/client'
import { sanitizeTimezone } from '../../utils/sanitizeTimezone'

export interface AggregationRange {
  fromDate?: Date
  toDate?: Date
}

/**
 * Instante almacenado (UTC) → hora de pared del venue.
 *
 * `timezone` se valida con `sanitizeTimezone`, que lanza si no es una zona IANA real.
 * `column` SIEMPRE es un literal del código (nunca entrada de usuario) — si algún día eso
 * cambia, hay que validarlo también.
 */
export function venueLocalExpr(column: string, timezone: string): string {
  const tz = sanitizeTimezone(timezone)
  return `(${column} AT TIME ZONE 'UTC' AT TIME ZONE '${tz}')`
}

/** "2026-08" */
export function monthBucketSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'YYYY-MM')`
}

/** "2026-08-04" */
export function dayBucketSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'YYYY-MM-DD')`
}

/**
 * "2026-W32" — ordenable entre años porque usa el año ISO.
 *
 * 🔴 IYYY, no YYYY. Con YYYY el 3-ene-2027 saldría "2027-W53" en vez de "2026-W53": la
 * semana correcta pero el año equivocado. Sólo se nota en los bordes de año, que es justo
 * cuando más duele.
 */
export function isoWeekKeySql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, 'IYYY-"W"IW')`
}

/** "W32" — sin año. */
export function weekLabelSql(column: string, timezone: string): string {
  return `to_char(${venueLocalExpr(column, timezone)}, '"W"IW')`
}

/**
 * Condiciones de rango como SQL PARAMETRIZADO.
 *
 * Las fechas nunca se interpolan como texto: viajan en `values` de Prisma. `column` es un
 * literal del código, por eso va con `Prisma.raw` (los identificadores no se pueden
 * parametrizar en SQL).
 *
 * 🔴 EL `AT TIME ZONE 'UTC'` DE AQUÍ NO ES DECORATIVO — SIN ÉL EL RANGO SE CORRE 6 HORAS.
 *
 * `createdAt` es `timestamp without time zone` guardando UTC, pero Prisma manda un `Date`
 * de JS como `timestamp WITH time zone`. Al comparar los dos, Postgres convierte la
 * columna usando la zona de la SESIÓN — que en esta base es `America/Mexico_City`. O sea
 * que lee un valor UTC como si fuera hora de México y lo adelanta 6 horas.
 *
 * Medido el 2026-08-04 contra la base real:
 *   '2026-08-04 05:00:00'::timestamp >= <2026-08-04T06:00:00Z>                  → true  🔴
 *   ('2026-08-04 05:00:00'::timestamp AT TIME ZONE 'UTC') >= <…T06:00:00Z>      → false ✅
 * (05:00Z es ANTERIOR a 06:00Z, así que la respuesta correcta es false.)
 *
 * Marcar la columna como UTC la convierte a timestamptz y la comparación pasa a ser entre
 * dos instantes reales. Es la misma familia del bug de dinero del estado de resultados
 * (`c41b03d6`, `a8aa70a0`) descrito en `.claude/rules/critical-warnings.md`.
 */
export function buildRangeConditions(range: AggregationRange, column: string): Prisma.Sql {
  const asInstant = Prisma.raw(`${column} AT TIME ZONE 'UTC'`)
  const parts: Prisma.Sql[] = []
  if (range.fromDate) parts.push(Prisma.sql`AND ${asInstant} >= ${range.fromDate}`)
  if (range.toDate) parts.push(Prisma.sql`AND ${asInstant} <= ${range.toDate}`)
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty
}
