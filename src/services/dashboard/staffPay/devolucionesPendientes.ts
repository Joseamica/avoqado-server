// src/services/dashboard/staffPay/devolucionesPendientes.ts — lo que el sobre ya pagó y se descontará solo (fase 3, B12; r6.2).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError } from '../../../errors/AppError'
import { utcTs } from '../../../utils/sqlDates'
import { enRangos, nombreGuardadoSql, PERSONA_DADA_DE_BAJA, reversoDeLoCongelado } from './fuentesVenta'
import { dbDateComoFecha, venuePeriodRange } from './periodos'
import { periodoBarrido } from './rangos'

type Db = Prisma.TransactionClient | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'
/** Renglones que se devuelven (se piden 51: el 51.º sólo dice `truncado`). Los totales son del conjunto ENTERO. */
export const TOPE_PENDIENTES = 50
/** ponytail: grupos destino × sede (los periodos con pendientes por las sedes autorizadas). Pasado el tope truena, nunca recorta. */
const TOPE_GRUPOS = 5000

/** Cuándo se descontará una pendiente (r6.2). */
export type Destino =
  /** El periodo canónico de su fecha sigue abierto: se descuenta al cerrarlo. */
  | { tipo: 'AL_CERRAR'; periodo: { start: string; end: string } }
  /** Ese periodo ya cerró: se descuenta al cerrar un periodo POSTERIOR a él (cerrar fuera de orden uno anterior no la toma). */
  | { tipo: 'PERIODO_POSTERIOR_A'; origen: { start: string; end: string } }
export interface Pendiente {
  fuente: 'TIP' | 'COMMISSION'
  sourceId: string
  venueId: string
  sede: string
  staffId: string
  persona: string
  /** YYYY-MM-DD en la zona de su sede. */
  fecha: string
  /** Negativo, pesos con 2 decimales. */
  monto: string
  seDescuenta: Destino
}
export interface DevolucionesPendientes {
  n: number
  total: string
  porDestino: Array<{ seDescuenta: Destino; n: number; total: string; porSede: Array<{ venueId: string; n: number; total: string }> }>
  items: Pendiente[]
  truncado: boolean
}

export const sinPendientes = (): DevolucionesPendientes => ({ n: 0, total: '0.00', porDestino: [], items: [], truncado: false })

/**
 * Las DEVOLUCIONES PENDIENTES (diseño r6.2, r5.1): devoluciones de propina y reversos de comisión de algo que el sobre YA pagó
 * (su original congelada) y que todavía no tienen su propio `SERVICE`, desde `startDate`. Es EXACTAMENTE la rama de reversos del
 * barrido, con el MISMO constructor (`reversoDeLoCongelado`): lo que se ve como pendiente es lo que un cierre descontará. Una
 * anulación en cascada (A4) anula el reverso: ya no aparece (la anulación devuelve el monto completo, §6.4).
 * - `sedes`: las AUTORIZADAS, resueltas antes de la transacción; se filtran DENTRO del SQL, antes de contar, sumar y paginar.
 * - `excluirPeriodo` = P: quita las que ya entran como línea en el cierre de P (fecha en P o en un cerrado anterior a P desde
 *   el inicio: el `periodo` de los rangos del barrido, `periodoBarrido`).
 * - Fechas civiles en la zona de cada sede; totales exactos en la base (`GROUPING SETS`), nunca la suma de los renglones.
 * Corre con `db` (la foto o la transacción de quien llama); no consulta el cliente global.
 */
export async function devolucionesPendientes(
  db: Db,
  input: { organizationId: string; sedes: string[]; staffId?: string; excluirPeriodo?: { start: string; end: string } },
): Promise<DevolucionesPendientes> {
  const ids = [...new Set(input.sedes)].sort()
  if (!ids.length) return sinPendientes()
  const org = await db.organization.findUnique({
    where: { id: input.organizationId },
    select: { staffPayStartDate: true, servicePayPeriodicity: true },
  })
  if (!org?.staffPayStartDate) return sinPendientes()
  const startDate = dbDateComoFecha(org.staffPayStartDate)
  // Sólo sedes de ESTA organización (aislamiento), con su zona.
  const vs = await db.venue.findMany({
    where: { id: { in: ids }, organizationId: input.organizationId },
    select: { id: true, timezone: true },
    orderBy: { id: 'asc' },
    take: ids.length,
  })
  if (!vs.length) return sinPendientes()
  const sedes = vs.map(v => ({ venueId: v.id, tz: v.timezone || TZ_DEFAULT }))
  const rp = input.excluirPeriodo
    ? await periodoBarrido(db, {
        organizationId: input.organizationId,
        periodo: { id: null, start: input.excluirPeriodo.start, end: input.excluirPeriodo.end },
        sedes,
        startDate,
      })
    : null
  const desde = (alias: 'cc' | 'p', col: 'calculatedAt' | 'createdAt') =>
    Prisma.sql`(${Prisma.join(
      sedes.map(
        s =>
          Prisma.sql`(${Prisma.raw(`${alias}."venueId"`)} = ${s.venueId} AND ${Prisma.raw(`${alias}."${col}"`)} >= ${utcTs(venuePeriodRange({ start: startDate, end: startDate }, s.tz).from)})`,
      ),
      ' OR ',
    )})`
  const sinP = (alias: 'cc' | 'p', col: 'calculatedAt' | 'createdAt') =>
    rp ? Prisma.sql`AND NOT ${enRangos(alias, col, rp)}` : Prisma.empty
  const venueIds = sedes.map(s => s.venueId)
  const mes = Prisma.sql`date_trunc('month', f.fecha::timestamp)::date`
  const finDeMes = Prisma.sql`((date_trunc('month', f.fecha::timestamp) + interval '1 month')::date - 1)`
  const quincena = Prisma.sql`EXTRACT(DAY FROM f.fecha) <= 15`
  const [ini, fin] =
    org.servicePayPeriodicity === 'SEMIMONTHLY'
      ? [
          Prisma.sql`CASE WHEN ${quincena} THEN ${mes} ELSE ${mes} + 15 END`,
          Prisma.sql`CASE WHEN ${quincena} THEN ${mes} + 14 ELSE ${finDeMes} END`,
        ]
      : [mes, finDeMes]
  const cte = Prisma.sql`
    WITH base AS (
      SELECT 'COMMISSION'::text AS fuente, cc.id AS "sourceId", cc."venueId", cc."staffId", cc."netCommission" AS monto,
             cc."calculatedAt" AS instante
      FROM "CommissionCalculation" cc
      WHERE cc."venueId" = ANY(${venueIds}::text[]) AND ${desde('cc', 'calculatedAt')}
        AND ${reversoDeLoCongelado('COMMISSION', 'cc')} ${sinP('cc', 'calculatedAt')}
        ${input.staffId ? Prisma.sql`AND cc."staffId" = ${input.staffId}` : Prisma.empty}
      UNION ALL
      SELECT 'TIP'::text, p.id, p."venueId", congelada."staffId", p."tipAmount", p."createdAt"
      FROM "Payment" p
      -- La persona de una devolución de propina es la de su propina ORIGINAL congelada (la misma que en el barrido).
      JOIN LATERAL (
        SELECT ef."staffId" FROM "ServiceEarning" ef
        WHERE ef."sourceType" = 'TIP' AND ef.concept = 'SERVICE' AND ef."sourceId" = p."processorData"->>'originalPaymentId'
        ORDER BY ef."createdAt" ASC, ef.id ASC
        LIMIT 1
      ) congelada ON true
      WHERE p."venueId" = ANY(${venueIds}::text[]) AND ${desde('p', 'createdAt')}
        AND ${reversoDeLoCongelado('TIP', 'p')} ${sinP('p', 'createdAt')}
        ${input.staffId ? Prisma.sql`AND congelada."staffId" = ${input.staffId}` : Prisma.empty}
    ),
    fechadas AS (
      SELECT b.*, ((b.instante AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(NULLIF(v.timezone, ''), ${TZ_DEFAULT}))::date AS fecha,
             v.name AS sede
      FROM base b JOIN "Venue" v ON v.id = b."venueId"
    ),
    d AS (
      -- El periodo de su fecha: el guardado si existe (con su estado), si no el canónico (abierto).
      SELECT f.*, COALESCE(sp.status::text, 'OPEN') AS estado, COALESCE(sp."periodStart", ${ini}) AS ini,
             COALESCE(sp."periodEnd", ${fin}) AS fin
      FROM fechadas f
      LEFT JOIN LATERAL (
        SELECT s.status, s."periodStart", s."periodEnd" FROM "ServicePayPeriod" s
        WHERE s."organizationId" = ${input.organizationId} AND s."periodStart" <= f.fecha AND s."periodEnd" >= f.fecha
        ORDER BY s."periodStart" ASC
        LIMIT 1
      ) sp ON true
    )`
  const grupos = await db.$queryRaw<
    Array<{
      gd: number
      gs: number
      estado: string | null
      ini: string | null
      fin: string | null
      venueId: string | null
      n: number
      total: Prisma.Decimal | null
    }>
  >`
    ${cte}
    SELECT GROUPING(d.estado, d.ini, d.fin)::int AS gd, GROUPING(d."venueId")::int AS gs, d.estado,
           to_char(d.ini, 'YYYY-MM-DD') AS ini, to_char(d.fin, 'YYYY-MM-DD') AS fin, d."venueId", COUNT(*)::int AS n, SUM(d.monto) AS total
    FROM d
    GROUP BY GROUPING SETS ((), (d.estado, d.ini, d.fin), (d.estado, d.ini, d.fin, d."venueId"))
    ORDER BY d.ini ASC NULLS FIRST, d.fin ASC, d.estado ASC, d."venueId" ASC NULLS FIRST
    LIMIT ${TOPE_GRUPOS + 2}`
  if (grupos.length > TOPE_GRUPOS + 1) {
    throw new BadRequestError(
      'Hay demasiadas devoluciones pendientes para mostrarlas por periodo y sede; pide ayuda a Avoqado.',
      'DEMASIADAS_PENDIENTES',
    )
  }
  const top = grupos.find(g => g.gd !== 0)
  if (!top || top.n === 0) return sinPendientes()
  const filas = await db.$queryRaw<
    Array<{
      fuente: 'TIP' | 'COMMISSION'
      sourceId: string
      venueId: string
      sede: string
      staffId: string
      persona: string
      fecha: string
      monto: Prisma.Decimal
      estado: string
      ini: string
      fin: string
    }>
  >`
    ${cte}
    SELECT d.fuente, d."sourceId", d."venueId", d.sede, d."staffId",
           COALESCE(NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''), ${nombreGuardadoSql(input.organizationId, Prisma.sql`d."staffId"`)}, ${PERSONA_DADA_DE_BAJA}) AS persona,
           to_char(d.fecha, 'YYYY-MM-DD') AS fecha, d.monto, d.estado, to_char(d.ini, 'YYYY-MM-DD') AS ini, to_char(d.fin, 'YYYY-MM-DD') AS fin
    FROM d
    LEFT JOIN "Staff" s ON s.id = d."staffId"
    ORDER BY d.fecha ASC, d.fuente COLLATE "C" ASC, d."sourceId" COLLATE "C" ASC
    LIMIT ${TOPE_PENDIENTES + 1}`
  const destino = (g: { estado: string | null; ini: string | null; fin: string | null }): Destino => {
    const p = { start: g.ini as string, end: g.fin as string }
    return g.estado === 'CLOSED' ? { tipo: 'PERIODO_POSTERIOR_A', origen: p } : { tipo: 'AL_CERRAR', periodo: p }
  }
  const pesos = (x: Prisma.Decimal | null) => new Prisma.Decimal(x ?? 0).toFixed(2)
  const mismo = (a: { estado: string | null; ini: string | null; fin: string | null }, b: typeof a) =>
    a.estado === b.estado && a.ini === b.ini && a.fin === b.fin
  return {
    n: top.n,
    total: pesos(top.total),
    porDestino: grupos
      .filter(g => g.gd === 0 && g.gs !== 0)
      .map(g => ({
        seDescuenta: destino(g),
        n: g.n,
        total: pesos(g.total),
        porSede: grupos
          .filter(x => x.gd === 0 && x.gs === 0 && mismo(x, g))
          .map(x => ({ venueId: x.venueId as string, n: x.n, total: pesos(x.total) })),
      })),
    items: filas.slice(0, TOPE_PENDIENTES).map(f => ({
      fuente: f.fuente,
      sourceId: f.sourceId,
      venueId: f.venueId,
      sede: f.sede,
      staffId: f.staffId,
      persona: f.persona,
      fecha: f.fecha,
      monto: pesos(f.monto),
      seDescuenta: destino(f),
    })),
    truncado: filas.length > TOPE_PENDIENTES,
  }
}
