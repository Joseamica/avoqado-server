import { Prisma } from '@prisma/client'
import logger from '../../../config/logger'
import { utcTs } from '../../../utils/sqlDates'

export type EstadoValoracion = 'OK' | 'EXCLUIDA' | 'EXCEPCION'
export type MotivoExcepcion = 'SIN_COACH' | 'COACH_SIN_NIVEL' | 'SIN_TABLA' | 'SIN_MONTO_PARA_ESE_CONTEO'
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>

export interface FiltroValoracion {
  venueId: string
  organizationId: string
  tz: string
  desde: Date
  hasta: Date
  ahora: Date
  claseIds?: string[]
  staffId?: string
}

export interface ClaseValorada {
  classSessionId: string
  venueId: string
  productId: string
  productName: string
  startsAt: Date
  fechaLocal: string
  staffId: string | null
  staffName: string | null
  payLevelId: string | null
  payLevelName: string | null
  tableVersionId: string | null
  countMode: 'BOOKED' | 'ATTENDED' | null
  maxCount: number | null
  conteoCalculado: number
  conteo: number
  tieneAjuste: boolean
  estado: EstadoValoracion
  motivo: MotivoExcepcion | null
  monto: Prisma.Decimal | null
}

export interface ResumenSede {
  staffId: string
  staffName: string
  clases: number
  total: Prisma.Decimal
  sumaLugares: number
}

/**
 * LA valoración (spec §6.1). Única implementación: el resumen, el detalle, la tarjeta, la simulación de efecto y
 * (en la fase 2) el cierre y las diferencias envuelven este CTE. Reservas correlacionadas por sede + clase para usar
 * el índice Reservation(venueId, classSessionId).
 */
export function valoracionCte(f: FiltroValoracion): Prisma.Sql {
  const porClases = f.claseIds?.length ? Prisma.sql`AND cs.id IN (${Prisma.join(f.claseIds)})` : Prisma.empty
  const porCoach = f.staffId ? Prisma.sql`AND cs."assignedStaffId" = ${f.staffId}` : Prisma.empty
  return Prisma.sql`
    WITH clases AS (
      SELECT cs.id, cs."venueId", cs."productId", cs."startsAt", cs."assignedStaffId",
             (((cs."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${f.tz}))::date AS fecha_local,
             ps."payCountOverride", ps."payAmountOverride", COALESCE(ps."payExcluded", false) AS excluida
      FROM "ClassSession" cs
      LEFT JOIN "ClassSessionPayState" ps ON ps."classSessionId" = cs.id
      WHERE cs."venueId" = ${f.venueId}
        AND cs."startsAt" >= ${utcTs(f.desde)}
        AND cs."startsAt" < ${utcTs(f.hasta)}
        AND cs."endsAt" <= ${utcTs(f.ahora)}
        AND cs.status <> 'CANCELLED'
        AND ps."originPeriodId" IS NULL
        ${porClases}
        ${porCoach}
    ),
    con_regla AS (
      SELECT c.*, tv.version_id, tv."countMode", tv."maxCount", lv."payLevelId", lv.level_name
      FROM clases c
      LEFT JOIN LATERAL (
        SELECT v.id AS version_id, v."countMode", v."maxCount"
        FROM "ServicePayTable" t
        JOIN LATERAL (
          SELECT v2.id, v2."countMode", v2."maxCount"
          FROM "ServicePayTableVersion" v2
          WHERE v2."tableId" = t.id AND v2."effectiveFrom" <= c.fecha_local
          ORDER BY v2."effectiveFrom" DESC, v2.revision DESC
          LIMIT 1
        ) v ON true
        WHERE t."venueId" = c."venueId"
          AND (t."archivedFrom" IS NULL OR t."archivedFrom" > c.fecha_local)
          AND (c."productId" = ANY(t."productIds") OR cardinality(t."productIds") = 0)
        ORDER BY (cardinality(t."productIds") > 0) DESC
        LIMIT 1
      ) tv ON true
      LEFT JOIN LATERAL (
        SELECT a."payLevelId", l.name AS level_name
        FROM "StaffPayLevelAssignment" a
        JOIN "StaffPayLevel" l ON l.id = a."payLevelId"
        WHERE a."organizationId" = ${f.organizationId}
          AND a."staffId" = c."assignedStaffId"
          AND a."effectiveFrom" <= c.fecha_local
        ORDER BY a."effectiveFrom" DESC, a.revision DESC
        LIMIT 1
      ) lv ON true
    ),
    con_conteo AS (
      SELECT r0.*, cnt.n AS conteo_calculado, COALESCE(r0."payCountOverride", cnt.n) AS conteo
      FROM con_regla r0
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(r."partySize"), 0)::int AS n
        FROM "Reservation" r
        WHERE r."venueId" = r0."venueId" AND r."classSessionId" = r0.id
          AND (
            (r0."countMode" = 'ATTENDED' AND r.status IN ('CHECKED_IN', 'COMPLETED'))
            OR (COALESCE(r0."countMode", 'BOOKED') = 'BOOKED'
                AND (r.status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETED')
                     OR (r.status = 'NO_SHOW' AND r."confirmedAt" IS NOT NULL)))
          )
      ) cnt ON true
    ),
    valoradas AS (
      SELECT cc.id AS "classSessionId", cc."venueId", cc."productId", p.name AS "productName", cc."startsAt",
             to_char(cc.fecha_local, 'YYYY-MM-DD') AS "fechaLocal",
             cc."assignedStaffId" AS "staffId", NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), '') AS "staffName",
             cc."payLevelId", cc.level_name AS "payLevelName", cc.version_id AS "tableVersionId",
             cc."countMode"::text AS "countMode", cc."maxCount",
             cc.conteo_calculado AS "conteoCalculado", cc.conteo,
             (cc."payCountOverride" IS NOT NULL OR cc."payAmountOverride" IS NOT NULL OR cc.excluida) AS "tieneAjuste",
             CASE
               WHEN cc.excluida THEN 'EXCLUIDA'
               WHEN cc."assignedStaffId" IS NULL THEN 'EXCEPCION'
               WHEN cc."payAmountOverride" IS NOT NULL THEN 'OK'
               WHEN cc."payLevelId" IS NULL THEN 'EXCEPCION'
               WHEN cc.version_id IS NULL THEN 'EXCEPCION'
               WHEN cell.amount IS NULL THEN 'EXCEPCION'
               ELSE 'OK'
             END AS estado,
             CASE
               WHEN cc.excluida THEN NULL
               WHEN cc."assignedStaffId" IS NULL THEN 'SIN_COACH'
               WHEN cc."payAmountOverride" IS NOT NULL THEN NULL
               WHEN cc."payLevelId" IS NULL THEN 'COACH_SIN_NIVEL'
               WHEN cc.version_id IS NULL THEN 'SIN_TABLA'
               WHEN cell.amount IS NULL THEN 'SIN_MONTO_PARA_ESE_CONTEO'
               ELSE NULL
             END AS motivo,
             CASE
               WHEN cc.excluida OR cc."assignedStaffId" IS NULL THEN NULL
               WHEN cc."payAmountOverride" IS NOT NULL THEN cc."payAmountOverride"
               ELSE cell.amount
             END AS monto
      FROM con_conteo cc
      JOIN "Product" p ON p.id = cc."productId"
      LEFT JOIN "Staff" s ON s.id = cc."assignedStaffId"
      LEFT JOIN "ServicePayTableCell" cell
        ON cell."versionId" = cc.version_id
       AND cell."payLevelId" = cc."payLevelId"
       AND cell.count = LEAST(cc.conteo, cc."maxCount")
    )`
}

export async function valorarClases(
  db: Db,
  f: FiltroValoracion,
  page: { despuesDe?: string; limite: number; soloExcepciones?: boolean },
): Promise<ClaseValorada[]> {
  const limite = Math.min(Math.max(page.limite, 1), 1000)
  const cursor = page.despuesDe ? Prisma.sql`AND "classSessionId" > ${page.despuesDe}` : Prisma.empty
  const exc = page.soloExcepciones ? Prisma.sql`AND estado = 'EXCEPCION'` : Prisma.empty
  return db.$queryRaw<ClaseValorada[]>`
    ${valoracionCte(f)}
    SELECT * FROM valoradas WHERE true ${cursor} ${exc}
    ORDER BY "classSessionId" ASC
    LIMIT ${limite}`
}

/** Tope de PERSONAS por sede (no de clases): las clases se agregan en la base, nunca se truncan. */
const TOPE_PERSONAS_POR_SEDE = 2000

export async function resumenPorPersona(db: Db, f: FiltroValoracion): Promise<ResumenSede[]> {
  const rows = await db.$queryRaw<
    Array<{ staffId: string; staffName: string | null; clases: number; total: Prisma.Decimal | null; sumaLugares: number }>
  >`
    ${valoracionCte(f)}
    SELECT "staffId", MAX("staffName") AS "staffName",
           COUNT(*)::int AS clases, SUM(monto) AS total, COALESCE(SUM(conteo), 0)::int AS "sumaLugares"
    FROM valoradas
    WHERE estado = 'OK' AND "staffId" IS NOT NULL
    GROUP BY "staffId"
    ORDER BY "staffId" ASC
    LIMIT ${TOPE_PERSONAS_POR_SEDE}`
  if (rows.length >= TOPE_PERSONAS_POR_SEDE) {
    logger.warn('staffPay.resumenPorPersona: la sede llegó al tope de personas con pago', {
      venueId: f.venueId,
      tope: TOPE_PERSONAS_POR_SEDE,
    })
  }
  return rows.map(r => ({ ...r, staffName: r.staffName ?? '—', total: r.total ?? new Prisma.Decimal(0) }))
}

export async function contarPorEstado(db: Db, f: FiltroValoracion) {
  const [r] = await db.$queryRaw<Array<{ ok: number; excluidas: number; excepciones: number; total: Prisma.Decimal | null }>>`
    ${valoracionCte(f)}
    SELECT COUNT(*) FILTER (WHERE estado = 'OK')::int AS ok,
           COUNT(*) FILTER (WHERE estado = 'EXCLUIDA')::int AS excluidas,
           COUNT(*) FILTER (WHERE estado = 'EXCEPCION')::int AS excepciones,
           SUM(monto) FILTER (WHERE estado = 'OK') AS total
    FROM valoradas`
  return { ...r, total: r.total ?? new Prisma.Decimal(0) }
}
