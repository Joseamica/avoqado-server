import { Prisma } from '@prisma/client'
import logger from '../../../config/logger'
import { utcTs } from '../../../utils/sqlDates'

export type EstadoValoracion = 'OK' | 'EXCLUIDA' | 'EXCEPCION'
export type MotivoExcepcion = 'SIN_COACH' | 'COACH_SIN_NIVEL' | 'SIN_TABLA' | 'SIN_MONTO_PARA_ESE_CONTEO'
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>

/** Tope de horas de las dos reglas de clase: el CHECK de `ServicePayTableVersion` (spec fase 3 §7.3). */
export const MAX_HORAS_REGLA = 168

/** La regla de clase que movió el pago (spec fase 3 §6.6). La calcula `valoracionCte`; el cierre la congela en el descriptor. */
export type ReglaDeClase = { tipo: 'SUPLENCIA'; horas: number; bono: string } | { tipo: 'CANCELACION_TARDIA'; horas: number }

const horasAntes = (h: number) => (h < 1 ? 'menos de 1 h antes' : `${h} h antes`)
/** «$100» si es entero, «$1,250.50» si no. */
export const pesosCortos = (s: string) => {
  const d = new Prisma.Decimal(s)
  return `$${d.toNumber().toLocaleString('es-MX', { minimumFractionDigits: d.isInteger() ? 0 : 2, maximumFractionDigits: 2 })}`
}
/** La regla en palabras (spec fase 3 §6.6). El recibo, su PDF/Excel y el MCP la dicen igual; el dashboard la traduce con `t()`. */
export function textoDeRegla(r: ReglaDeClase): string {
  return r.tipo === 'SUPLENCIA'
    ? `Suplencia avisada ${horasAntes(r.horas)}: +${pesosCortos(r.bono)}`
    : `Cancelada ${horasAntes(r.horas)}: se paga el sueldo base`
}

export interface FiltroValoracion {
  venueId: string
  organizationId: string
  tz: string
  desde: Date
  hasta: Date
  ahora: Date
  claseIds?: string[]
  staffId?: string
  /**
   * 'vivo' (default): clases terminadas SIN ancla del rango (la fase 1, intacta). Una cancelada está terminada desde que se
   * canceló (D5-fix).
   * 'periodo': candidatas de un periodo (spec §6.4) — las ancladas en `periodId` por id, sin importar fecha ni estado,
   * más las sin ancla del rango ya terminadas. Se valoran con su ancla; una cancelada que no se paga vale $0 (EXCLUIDA).
   */
  modo?: 'vivo' | 'periodo'
  periodId?: string
  /**
   * Participación por sede (fase 3, B10-B11; diseño r6.1, r4.1). Filtra SÓLO las clases sin ancla (la rama de anclas no se
   * toca: una clase congelada sigue corrigiéndose aunque su sede ya no esté activa).
   * 'real' (default desde B11, para TODO llamador: cierre, `contarPorEstado`, diferencias, liquidación, tarjeta, efecto,
   * reporte y recibo): antes de `staffPayStartDate` (o sin activar) la regla D2 de la fase 2; desde el inicio, la sede activa
   * (`StaffPayVenueWindow`) en la fecha local de la clase.
   * 'fuera': exactamente las que 'real' deja fuera; sólo en modo vivo (las ancladas siempre entran). La usan la tarjeta
   * (`FUERA_DEL_SOBRE`) y la vista previa de una sede. (B14-fix F6: ya no hay un modo sin filtro; las pruebas contrastan
   * 'real' y 'fuera' contra los montos conocidos de su fixture.)
   */
  participacion?: Participacion
}

export type Participacion = 'real' | 'fuera'

export interface ClaseValorada {
  classSessionId: string
  venueId: string
  productId: string
  productName: string
  startsAt: Date
  fechaLocal: string
  fechaValoracion: string
  periodoOrigen: string | null
  cancelada: boolean
  payCountOverride: number | null
  payAmountOverride: Prisma.Decimal | null
  excluida: boolean
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
  /** Bono sumado por suplencia con poco aviso (spec fase 3 §6.6), «100.00»; null si no se sumó. */
  bonoSuplencia: string | null
  /** Cancelada con aviso tardío: se valora con conteo 0 (la celda del sueldo base de su nivel). */
  canceladaTarde: boolean
  /** La regla que movió el pago, con sus horas de aviso, para decir POR QUÉ; null si ninguna. */
  regla: ReglaDeClase | null
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
  if (f.modo === 'periodo' && !f.periodId) throw new Error('valoracionCte: el modo periodo exige periodId')
  if (f.participacion === 'fuera' && f.modo === 'periodo') throw new Error("valoracionCte: 'fuera' sólo se usa en modo vivo")
  // UN arreglo como parámetro, no `IN ($1…$500)`: Prisma reusa la sentencia preparada y, a la sexta, Postgres pasa al plan
  // genérico. Con la lista suelta, desde el 6.º lote cada uno pasaba de ~15 ms a 275 ms con 20,000 clases (~800 con 50,000),
  // y volvía a 15 con `plan_cache_mode = force_custom_plan` (A13). Con `= ANY($1)` se queda en ~15-20 ms sin forzar nada.
  const porClases = f.claseIds?.length ? Prisma.sql`AND cs.id = ANY(${f.claseIds}::text[])` : Prisma.empty
  const porCoach = f.staffId ? Prisma.sql`AND cs."assignedStaffId" = ${f.staffId}` : Prisma.empty
  // En modo vivo sólo entran clases SIN ancla, y por construcción ésas no tienen versión anclada ni líneas SERVICE/RECONCILE
  // (las tres nacen con el ancla: en el cierre y en la liquidación). `AND false` deja `va` y `lp` en NULL sin consultar (A13:
  // con la tabla de devengos sin estadísticas, `lp` recorría todos los devengos de la persona por cada clase).
  const soloConAncla = f.modo === 'periodo' ? Prisma.empty : Prisma.sql`AND false`
  const columnas = Prisma.sql`
      cs.id, cs."venueId", cs."productId", cs."startsAt", cs."assignedStaffId",
      (((cs."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${f.tz}))::date AS fecha_local,
      COALESCE(ps."valuationDate", (((cs."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${f.tz}))::date) AS fecha_valoracion,
      ps."valuationVersionId" AS version_anclada,
      ps."originPeriodId" AS periodo_origen,
      (cs.status = 'CANCELLED') AS cancelada,
      cs."cancelledAt" AS cancelada_en, cs."originalStaffId" AS coach_original, cs."staffAssignedAt" AS asignada_en,
      ps."payCountOverride", ps."payAmountOverride", COALESCE(ps."payExcluded", false) AS excluida`
  // Participación por sede (B10-B11, r4.1), sobre la fecha civil LOCAL de la clase (la de `fecha_local`): antes del inicio de
  // pago al personal (o sin activar) entra como en la fase 2 (regla D2); desde el inicio, sólo si su sede está activa ESE día
  // en ESTA organización. 'fuera' es la negación exacta. `fl` es una EXPRESIÓN de SQL
  // (columna de la clase), no un `Date` atado: va a la izquierda para que la guarda de binds de fecha no la confunda con uno.
  const fl = Prisma.sql`(((cs."startsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${f.tz}))::date`
  const participa = Prisma.sql`(
          NOT EXISTS (SELECT 1 FROM "Organization" og WHERE og.id = ${f.organizationId}
                      AND og."staffPayStartDate" IS NOT NULL AND ${fl} >= og."staffPayStartDate")
          OR EXISTS (SELECT 1 FROM "StaffPayVenueWindow" w WHERE w."organizationId" = ${f.organizationId}
                     AND w."venueId" = cs."venueId" AND w.desde <= ${fl} AND (w.hasta IS NULL OR w.hasta >= ${fl})))`
  const porParticipacion = f.participacion === 'fuera' ? Prisma.sql`AND NOT ${participa}` : Prisma.sql`AND ${participa}`
  // Sin ancla, del rango de la sede ya terminadas (índice por sede + startsAt). Terminada = su horario pasó o está CANCELADA:
  // una cancelada terminó al cancelarse, lo que paga ya no cambia (D5-fix, Codex D-1: una cancelada tarde que terminaba
  // después del cierre quedaba fuera de él, sin devengo ni ancla). La misma regla en `origenDeClase` y en la tarjeta.
  const sinAnclaEnRango = (porEstado: Prisma.Sql) => Prisma.sql`
      SELECT ${columnas}
      FROM "ClassSession" cs
      LEFT JOIN "ClassSessionPayState" ps ON ps."classSessionId" = cs.id
      WHERE cs."venueId" = ${f.venueId}
        AND cs."startsAt" >= ${utcTs(f.desde)} AND cs."startsAt" < ${utcTs(f.hasta)}
        AND (cs."endsAt" <= ${utcTs(f.ahora)} OR cs.status = 'CANCELLED')
        ${porEstado}
        AND ps."originPeriodId" IS NULL
        ${porParticipacion}
        ${porClases}
        ${porCoach}`
  // Fase 3 (§6.6): en modo vivo una cancelada sólo vale si su versión tiene la regla de cancelación tardía. Aquí entran las
  // canceladas dentro del tope de CUALQUIER regla (MAX_HORAS_REGLA, el CHECK); `valoradas` saca las que su versión no paga.
  const vivas = Prisma.sql`AND (cs.status <> 'CANCELLED'
        OR (cs."cancelledAt" IS NOT NULL AND cs."cancelledAt" > cs."startsAt" - ${Prisma.raw(`interval '${MAX_HORAS_REGLA} hours'`)}))`
  // Modo periodo: dos SELECT completos y no un OR (un OR entre ps y el rango de cs recorre toda la sede). La rama de
  // anclas entra por el índice de originPeriodId; la otra, sin filtro de estado: una cancelada sin ancla sale EXCLUIDA.
  const clases =
    f.modo === 'periodo'
      ? Prisma.sql`
      SELECT ${columnas}
      FROM "ClassSessionPayState" ps
      JOIN "ClassSession" cs ON cs.id = ps."classSessionId"
      WHERE ps."originPeriodId" = ${f.periodId}
        AND cs."venueId" = ${f.venueId}
        ${porClases}
        ${porCoach}
      UNION ALL
      ${sinAnclaEnRango(Prisma.empty)}`
      : sinAnclaEnRango(vivas)
  // Fase 3: en modo vivo una cancelada que su versión no paga no aparece (como en las fases 1 y 2).
  const sinCanceladasQueNoSePagan = f.modo === 'periodo' ? Prisma.empty : Prisma.sql`WHERE NOT (cc.cancelada AND NOT cc.cancelada_tarde)`
  return Prisma.sql`
    WITH clases AS (${clases}
    ),
    con_regla AS (
      SELECT c.*,
             COALESCE(va.id, tv.version_id) AS version_id,
             COALESCE(va."countMode", tv."countMode") AS "countMode",
             COALESCE(va."maxCount", tv."maxCount") AS "maxCount",
             -- Fase 3 (§6.6): las reglas de la MISMA versión que da las celdas — la anclada si hay ancla, si no la vigente.
             COALESCE(va."coverBonusHours", tv."coverBonusHours") AS cover_horas,
             COALESCE(va."coverBonusAmount", tv."coverBonusAmount") AS cover_monto,
             COALESCE(va."lateCancelHours", tv."lateCancelHours") AS cancel_horas,
             -- Si la persona YA tiene una línea, manda la PRIMERA aunque su nivel fuera NULL (Codex R1-5): un cierre por
             -- monto ajustado sin nivel no se convierte después en tarifa por una asignación retroactiva.
             CASE WHEN lp.existe THEN lp."payLevelId" ELSE lv."payLevelId" END AS "payLevelId",
             CASE WHEN lp.existe THEN lp.level_name ELSE lv.level_name END AS level_name
      FROM clases c
      LEFT JOIN "ServicePayTableVersion" va ON va.id = c.version_anclada ${soloConAncla}
      LEFT JOIN LATERAL (
        SELECT v.id AS version_id, v."countMode", v."maxCount", v."coverBonusHours", v."coverBonusAmount", v."lateCancelHours"
        FROM "ServicePayTable" t
        JOIN LATERAL (
          SELECT v2.id, v2."countMode", v2."maxCount", v2."coverBonusHours", v2."coverBonusAmount", v2."lateCancelHours"
          FROM "ServicePayTableVersion" v2
          WHERE v2."tableId" = t.id AND v2."effectiveFrom" <= c.fecha_valoracion
          ORDER BY v2."effectiveFrom" DESC, v2.revision DESC
          LIMIT 1
        ) v ON true
        WHERE c.version_anclada IS NULL
          AND t."venueId" = c."venueId"
          AND (t."archivedFrom" IS NULL OR t."archivedFrom" > c.fecha_valoracion)
          AND (c."productId" = ANY(t."productIds") OR cardinality(t."productIds") = 0)
        ORDER BY (cardinality(t."productIds") > 0) DESC
        LIMIT 1
      ) tv ON true
      LEFT JOIN LATERAL (
        SELECT true AS existe, e."payLevelId", e."payLevelName" AS level_name
        FROM "ServiceEarning" e
        WHERE e."sourceType" = 'CLASS_SESSION' AND e."sourceId" = c.id AND e."staffId" = c."assignedStaffId"
          AND e."organizationId" = ${f.organizationId}
          AND e.concept IN ('SERVICE', 'RECONCILE') ${soloConAncla}
        ORDER BY e."createdAt" ASC, e.id ASC
        LIMIT 1
      ) lp ON true
      LEFT JOIN LATERAL (
        SELECT a."payLevelId", l.name AS level_name
        FROM "StaffPayLevelAssignment" a
        JOIN "StaffPayLevel" l ON l.id = a."payLevelId"
        WHERE a."organizationId" = ${f.organizationId}
          AND a."staffId" = c."assignedStaffId"
          AND a."effectiveFrom" <= c.fecha_valoracion
        ORDER BY a."effectiveFrom" DESC, a.revision DESC
        LIMIT 1
      ) lv ON true
    ),
    -- Fase 3 (§6.6), límites estrictos: exactamente N horas antes NO cuenta. Suplencia: la coach de hoy no es la original
    -- (sin original no cuenta) y se le asignó con menos de N horas. Una cancelada no es suplencia: cobra sólo el sueldo base.
    -- Cancelación tardía sólo con coach (D3a r1): sin coach no hay a quién pagarle; queda EXCLUIDA en $0 y no bloquea.
    con_flags AS (
      SELECT r.*,
             (r.cancelada AND r."assignedStaffId" IS NOT NULL AND r.cancelada_en IS NOT NULL AND r.cancel_horas IS NOT NULL
              AND r."startsAt" - r.cancelada_en < make_interval(hours => r.cancel_horas)) AS cancelada_tarde,
             (NOT r.cancelada AND r."assignedStaffId" IS NOT NULL AND r.coach_original IS NOT NULL
              AND r."assignedStaffId" <> r.coach_original AND r.asignada_en IS NOT NULL AND r.cover_horas IS NOT NULL
              AND r."startsAt" - r.asignada_en < make_interval(hours => r.cover_horas)) AS suplencia_tarde
      FROM con_regla r
    ),
    con_conteo AS (
      -- Fase 3: una cancelada tarde se paga como clase de 0 lugares (la celda del sueldo base), con o sin conteo corregido.
      SELECT r0.*,
             CASE WHEN r0.cancelada_tarde THEN 0 ELSE cnt.n END AS conteo_calculado,
             CASE WHEN r0.cancelada_tarde THEN 0 ELSE COALESCE(r0."payCountOverride", cnt.n) END AS conteo
      FROM con_flags r0
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
             to_char(cc.fecha_valoracion, 'YYYY-MM-DD') AS "fechaValoracion",
             cc.periodo_origen AS "periodoOrigen", cc.cancelada,
             cc."payCountOverride", cc."payAmountOverride", cc.excluida,
             cc."assignedStaffId" AS "staffId", NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), '') AS "staffName",
             cc."payLevelId", cc.level_name AS "payLevelName", cc.version_id AS "tableVersionId",
             cc."countMode"::text AS "countMode", cc."maxCount",
             cc.conteo_calculado AS "conteoCalculado", cc.conteo,
             (cc."payCountOverride" IS NOT NULL OR cc."payAmountOverride" IS NOT NULL OR cc.excluida) AS "tieneAjuste",
             CASE
               WHEN (cc.cancelada AND NOT cc.cancelada_tarde) OR cc.excluida THEN 'EXCLUIDA'
               WHEN cc."assignedStaffId" IS NULL THEN 'EXCEPCION'
               WHEN cc."payAmountOverride" IS NOT NULL THEN 'OK'
               WHEN cc."payLevelId" IS NULL THEN 'EXCEPCION'
               WHEN cc.version_id IS NULL THEN 'EXCEPCION'
               WHEN cell.amount IS NULL THEN 'EXCEPCION'
               ELSE 'OK'
             END AS estado,
             CASE
               WHEN (cc.cancelada AND NOT cc.cancelada_tarde) OR cc.excluida THEN NULL
               WHEN cc."assignedStaffId" IS NULL THEN 'SIN_COACH'
               WHEN cc."payAmountOverride" IS NOT NULL THEN NULL
               WHEN cc."payLevelId" IS NULL THEN 'COACH_SIN_NIVEL'
               WHEN cc.version_id IS NULL THEN 'SIN_TABLA'
               WHEN cell.amount IS NULL THEN 'SIN_MONTO_PARA_ESE_CONTEO'
               ELSE NULL
             END AS motivo,
             CASE
               WHEN (cc.cancelada AND NOT cc.cancelada_tarde) OR cc.excluida OR cc."assignedStaffId" IS NULL THEN NULL
               WHEN cc."payAmountOverride" IS NOT NULL THEN cc."payAmountOverride"
               WHEN cc.suplencia_tarde THEN cell.amount + cc.cover_monto
               ELSE cell.amount
             END AS monto,
             -- Fase 3: el bono sólo cuando de verdad se sumó (sin monto acordado, sin excluir y con celda).
             CASE
               WHEN cc.suplencia_tarde AND NOT cc.excluida AND cc."payAmountOverride" IS NULL AND cell.amount IS NOT NULL
                 THEN cc.cover_monto::text
             END AS "bonoSuplencia",
             cc.cancelada_tarde AS "canceladaTarde",
             -- regla dice sólo lo que la regla decidió (D3a r2): el monto acordado manda y sin celda no hay sueldo base.
             CASE
               WHEN cc.excluida THEN NULL
               WHEN cc.cancelada_tarde AND cc."payAmountOverride" IS NULL AND cell.amount IS NOT NULL
                 THEN jsonb_build_object('tipo', 'CANCELACION_TARDIA',
                        'horas', GREATEST(0, floor(extract(epoch FROM cc."startsAt" - cc.cancelada_en) / 3600))::int)
               WHEN cc.suplencia_tarde AND cc."payAmountOverride" IS NULL AND cell.amount IS NOT NULL
                 THEN jsonb_build_object('tipo', 'SUPLENCIA',
                        'horas', GREATEST(0, floor(extract(epoch FROM cc."startsAt" - cc.asignada_en) / 3600))::int,
                        'bono', cc.cover_monto::text)
             END AS regla
      FROM con_conteo cc
      JOIN "Product" p ON p.id = cc."productId"
      LEFT JOIN "Staff" s ON s.id = cc."assignedStaffId"
      LEFT JOIN "ServicePayTableCell" cell
        ON cell."versionId" = cc.version_id
       AND cell."payLevelId" = cc."payLevelId"
       AND cell.count = LEAST(cc.conteo, cc."maxCount")
      ${sinCanceladasQueNoSePagan}
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
export const TOPE_PERSONAS_POR_SEDE = 2000
/** «Nada se trunca» (spec §6.2): si una sede devolvió el tope, el reporte lo DICE (`truncado`). */
export const llegoAlTopePersonas = (filas: number): boolean => filas >= TOPE_PERSONAS_POR_SEDE

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
  if (llegoAlTopePersonas(rows.length)) {
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
