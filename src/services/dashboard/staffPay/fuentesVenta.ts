// src/services/dashboard/staffPay/fuentesVenta.ts — qué comisiones, propinas y anulaciones barre un cierre (fase 3, spec §6.2–§6.4).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { utcTs } from '../../../utils/sqlDates'
import { dbDateComoFecha, diaCivilSiguiente, fechaComoDbDate, PeriodoCanonico, venuePeriodRange } from './periodos'

type Db = Prisma.TransactionClient | typeof prisma

/** El cierre (o la vista en vivo) que barre: el periodo P, sus sedes con su zona y el inicio de pago al personal. */
export interface AlcanceBarrido {
  organizationId: string
  periodo: { id: string | null; start: string; end: string } // fechas civiles YYYY-MM-DD
  sedes: { venueId: string; tz: string }[]
  startDate: string // Organization.staffPayStartDate
}
export type FuenteVenta = 'COMMISSION' | 'TIP'
/** Lo que el renglón guarda para mostrarse igual aunque después se borre la venta o la persona (spec fase 3 §6.1). */
export interface DescriptorVenta {
  fecha: string
  hora: string
  sede: string
  persona: string
  orden: string | null
  esquema: string | null
  base: string | null
  motivo: 'VENTA' | 'DEVOLUCION' | 'ANULACION'
}
export interface LineaBarrible {
  fuente: FuenteVenta
  concepto: 'SERVICE' | 'RECONCILE'
  sourceId: string // CommissionCalculation.id o Payment.id
  staffId: string
  venueId: string
  fechaLocal: string // YYYY-MM-DD en la zona de su sede
  /** El instante de la venta (o de la anulación): el `occurredAt` del renglón, que ordena el recibo. */
  instante: Date
  monto: Prisma.Decimal // con signo
  descriptor: DescriptorVenta
}

const TZ_DEFAULT = 'America/Mexico_City'
/** ponytail: periodos cerrados que se leen para los rangos (1,000 quincenas ≈ 41 años); paginar si algún día se acerca. */
const TOPE_PERIODOS_CERRADOS = 1000
const acotar = (n: number) => Math.min(Math.max(Math.trunc(n) || 1, 1), 1000)

interface RangoSede {
  venueId: string
  desde: Date
  hasta: Date
}

/** Un periodo que termina antes del inicio de pago al personal no barre nada: ni ventas ni anulaciones (B-D5). */
const fueraDelSobre = (a: AlcanceBarrido) => !a.sedes.length || a.periodo.end < a.startDate

/**
 * Spec §6.2 puntos 3 y 4 (B-D1): una venta «ya cae» en este cierre si su fecha civil —en la zona de SU sede— está en P o en
 * un periodo anterior GUARDADO como CLOSED, y nunca antes de `startDate`. Un canónico sin fila no aparece aquí: cuenta
 * como abierto y lo suyo espera a su propio cierre (Codex r1-10). Los rangos civiles contiguos se juntan en uno.
 */
export async function rangosBarribles(db: Db, a: AlcanceBarrido): Promise<RangoSede[]> {
  if (fueraDelSobre(a)) return []
  const cerrados = await db.servicePayPeriod.findMany({
    where: {
      organizationId: a.organizationId,
      status: 'CLOSED',
      periodEnd: { gte: fechaComoDbDate(a.startDate), lt: fechaComoDbDate(a.periodo.start) },
    },
    select: { periodStart: true, periodEnd: true },
    orderBy: { periodStart: 'asc' },
    take: TOPE_PERIODOS_CERRADOS,
  })
  const civiles: PeriodoCanonico[] = []
  const todos = [...cerrados.map(x => ({ start: dbDateComoFecha(x.periodStart), end: dbDateComoFecha(x.periodEnd) })), a.periodo]
  for (const c of todos) {
    const start = c.start < a.startDate ? a.startDate : c.start
    const u = civiles[civiles.length - 1]
    if (u && diaCivilSiguiente(u.end) === start) u.end = c.end
    else civiles.push({ start, end: c.end })
  }
  return a.sedes.flatMap(s =>
    civiles.map(c => {
      const { from, to } = venuePeriodRange(c, s.tz)
      return { venueId: s.venueId, desde: from, hasta: to }
    }),
  )
}

/** `(sede = X AND col en [desde, hasta)) OR …` sobre las columnas de `alias` (alias fijos del código, nunca del usuario). */
function enRangos(alias: 'cc' | 'o' | 'p' | 'op', columna: 'calculatedAt' | 'createdAt', r: RangoSede[]): Prisma.Sql {
  if (!r.length) return Prisma.sql`false`
  const venue = Prisma.raw(`${alias}."venueId"`)
  const t = Prisma.raw(`${alias}."${columna}"`)
  return Prisma.sql`(${Prisma.join(
    r.map(x => Prisma.sql`(${venue} = ${x.venueId} AND ${t} >= ${utcTs(x.desde)} AND ${t} < ${utcTs(x.hasta)})`),
    ' OR ',
  )})`
}

const venueIdsDe = (a: AlcanceBarrido) => a.sedes.map(s => s.venueId)
const tzSede = Prisma.sql`COALESCE(NULLIF(v.timezone, ''), ${TZ_DEFAULT})`
const local = (instante: Prisma.Sql, formato: string) =>
  Prisma.sql`to_char(((${instante} AT TIME ZONE 'UTC') AT TIME ZONE ${tzSede}), ${formato})`
const personaSql = Prisma.sql`COALESCE(NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''), 'Persona dada de baja')`

// ── Comisiones (spec §6.2) ──

/**
 * Puntos 1-6 sobre `cc`. «Ya congelada» por FUENTE, no por persona (B-D2). Un reverso de devolución (su pago es un
 * REFUND) sólo entra si la comisión que revierte —misma llave que `createRefundCommission`: `originalPaymentId` + esquema +
 * persona— ya está congelada o entra en este mismo cierre (Codex r1-18): nunca se descuenta lo que el sobre no pagó.
 */
function comisionBarrible(r: RangoSede[]): Prisma.Sql {
  return Prisma.sql`
    cc.status <> 'VOIDED'
    AND ${enRangos('cc', 'calculatedAt', r)}
    AND NOT EXISTS (
      SELECT 1 FROM "ServiceEarning" e WHERE e."sourceType" = 'COMMISSION' AND e."sourceId" = cc.id AND e.concept = 'SERVICE')
    AND (
      NOT EXISTS (SELECT 1 FROM "Payment" rp WHERE rp.id = cc."paymentId" AND rp.type = 'REFUND')
      OR EXISTS (
        SELECT 1
        FROM "Payment" rp
        JOIN "CommissionCalculation" o
          ON o."paymentId" = rp."processorData"->>'originalPaymentId' AND o."configId" = cc."configId" AND o."staffId" = cc."staffId"
        WHERE rp.id = cc."paymentId" AND rp.type = 'REFUND'
          AND (
            EXISTS (
              SELECT 1 FROM "ServiceEarning" eo WHERE eo."sourceType" = 'COMMISSION' AND eo."sourceId" = o.id AND eo.concept = 'SERVICE')
            OR (o.status <> 'VOIDED' AND ${enRangos('o', 'calculatedAt', r)})
          )
      )
    )`
}

function detalleComisiones(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT 'COMMISSION'::text AS fuente, 'SERVICE'::text AS concepto, cc.id AS "sourceId", cc."staffId", cc."venueId",
           cc."calculatedAt" AS instante, ${local(Prisma.sql`cc."calculatedAt"`, 'YYYY-MM-DD')} AS "fechaLocal",
           ${local(Prisma.sql`cc."calculatedAt"`, 'HH24:MI')} AS hora, cc."netCommission" AS monto, v.name AS sede,
           ${personaSql} AS persona, ord."orderNumber" AS orden, cfg.name AS esquema, cc."baseAmount" AS base,
           CASE WHEN rp.id IS NULL THEN 'VENTA' ELSE 'DEVOLUCION' END AS motivo
    FROM "CommissionCalculation" cc
    JOIN "Venue" v ON v.id = cc."venueId"
    LEFT JOIN "Staff" s ON s.id = cc."staffId"
    LEFT JOIN "Order" ord ON ord.id = cc."orderId"
    LEFT JOIN "CommissionConfig" cfg ON cfg.id = cc."configId"
    LEFT JOIN "Payment" rp ON rp.id = cc."paymentId" AND rp.type = 'REFUND'
    WHERE ${where}`
}

const idsComisiones = (a: AlcanceBarrido, r: RangoSede[], despuesDe: string | undefined, n: number) => Prisma.sql`
  SELECT cc.id FROM "CommissionCalculation" cc
  WHERE cc."venueId" = ANY(${venueIdsDe(a)}::text[]) AND ${comisionBarrible(r)}
    ${despuesDe ? Prisma.sql`AND cc.id > ${despuesDe}` : Prisma.empty}
  ORDER BY cc.id ASC
  LIMIT ${n}`

// ── Propinas (spec §6.3) ──

/** Un cobro cuya propina entra al sobre (alias `p` o `op`): tipo, estado, fecha, ventana [startsAt, endsAt) y sin congelar. */
function cobroConPropina(alias: 'p' | 'op', a: AlcanceBarrido, r: RangoSede[]): Prisma.Sql {
  const c = (col: string) => Prisma.raw(`${alias}.${col}`)
  return Prisma.sql`
    ${c('status')} = 'COMPLETED' AND COALESCE(${c('type')}, 'REGULAR') IN ('REGULAR', 'FAST') AND ${c('"tipAmount"')} > 0
    AND ${enRangos(alias, 'createdAt', r)}
    AND EXISTS (
      SELECT 1 FROM "StaffPayTipWindow" w
      WHERE w."organizationId" = ${a.organizationId} AND ${c('"createdAt"')} >= w."startsAt"
        AND (w."endsAt" IS NULL OR ${c('"createdAt"')} < w."endsAt"))
    AND NOT EXISTS (
      SELECT 1 FROM "ServiceEarning" et WHERE et."sourceType" = 'TIP' AND et."sourceId" = ${c('id')} AND et.concept = 'SERVICE')`
}

/**
 * Cobros con propina y reembolsos de propina del alcance, con su dueño (`staffId`, NULL = sin dueño o reembolso que no
 * entra). Cobro: `Order.servedById`, si no `Payment.processedById`. Reembolso: la persona de la propina ORIGINAL ya
 * congelada, o —si la original entra en este mismo cierre— la que le toca hoy a la original; nunca quien reembolsó ni
 * quien atiende hoy la orden (Codex r1-18). Un reembolso no necesita ventana: lo que el sobre pagó siempre se descuenta.
 */
function propinasBase(a: AlcanceBarrido, r: RangoSede[]): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id, p."venueId", p."orderId", p."createdAt" AS instante, p."tipAmount" AS monto,
           CASE WHEN p.type = 'REFUND' THEN 'DEVOLUCION' ELSE 'VENTA' END AS motivo,
           CASE WHEN p.type = 'REFUND' THEN COALESCE(congelada."staffId", en_este."staffId")
                ELSE COALESCE(ord."servedById", p."processedById") END AS "staffId"
    FROM "Payment" p
    LEFT JOIN "Order" ord ON ord.id = p."orderId"
    LEFT JOIN LATERAL (
      SELECT ef."staffId" FROM "ServiceEarning" ef
      WHERE p.type = 'REFUND' AND ef."sourceType" = 'TIP' AND ef.concept = 'SERVICE'
        AND ef."sourceId" = p."processorData"->>'originalPaymentId'
      ORDER BY ef."createdAt" ASC, ef.id ASC
      LIMIT 1
    ) congelada ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(oo."servedById", op."processedById") AS "staffId"
      FROM "Payment" op
      LEFT JOIN "Order" oo ON oo.id = op."orderId"
      WHERE p.type = 'REFUND' AND congelada."staffId" IS NULL
        AND op.id = p."processorData"->>'originalPaymentId' AND op."venueId" = p."venueId"
        AND ${cobroConPropina('op', a, r)}
    ) en_este ON true
    WHERE p."venueId" = ANY(${venueIdsDe(a)}::text[])
      AND (
        (${cobroConPropina('p', a, r)})
        OR (p.type = 'REFUND' AND p.status = 'COMPLETED' AND p."tipAmount" < 0
            AND ${enRangos('p', 'createdAt', r)}
            AND NOT EXISTS (
              SELECT 1 FROM "ServiceEarning" er WHERE er."sourceType" = 'TIP' AND er."sourceId" = p.id AND er.concept = 'SERVICE'))
      )`
}

function detallePropinas(a: AlcanceBarrido, r: RangoSede[], where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT 'TIP'::text AS fuente, 'SERVICE'::text AS concepto, b.id AS "sourceId", b."staffId", b."venueId", b.instante,
           ${local(Prisma.sql`b.instante`, 'YYYY-MM-DD')} AS "fechaLocal", ${local(Prisma.sql`b.instante`, 'HH24:MI')} AS hora,
           b.monto, v.name AS sede, ${personaSql} AS persona, ord."orderNumber" AS orden, NULL::text AS esquema,
           NULL::numeric AS base, b.motivo
    FROM (${propinasBase(a, r)}) b
    JOIN "Venue" v ON v.id = b."venueId"
    LEFT JOIN "Staff" s ON s.id = b."staffId"
    LEFT JOIN "Order" ord ON ord.id = b."orderId"
    WHERE b."staffId" IS NOT NULL AND ${where}`
}

const idsPropinas = (a: AlcanceBarrido, r: RangoSede[], despuesDe: string | undefined, n: number) => Prisma.sql`
  SELECT b.id FROM (${propinasBase(a, r)}) b
  WHERE b."staffId" IS NOT NULL ${despuesDe ? Prisma.sql`AND b.id > ${despuesDe}` : Prisma.empty}
  ORDER BY b.id ASC
  LIMIT ${n}`

// ── Reversos por anulación (spec §6.4) ──

/** Comisiones CONGELADAS del alcance que hoy están anuladas y todavía no tienen su RECONCILE: −(su monto congelado). */
function detalleReversos(a: AlcanceBarrido, where: Prisma.Sql): Prisma.Sql {
  const cuando = Prisma.sql`COALESCE(cc."voidedAt", cc."calculatedAt")`
  return Prisma.sql`
    SELECT 'COMMISSION'::text AS fuente, 'RECONCILE'::text AS concepto, e."sourceId", e."staffId", e."venueId",
           ${cuando} AS instante, ${local(cuando, 'YYYY-MM-DD')} AS "fechaLocal", ${local(cuando, 'HH24:MI')} AS hora,
           -e.amount AS monto, COALESCE(e.descriptor->>'sede', v.name) AS sede,
           COALESCE(e.descriptor->>'persona', ${personaSql}) AS persona, e.descriptor->>'orden' AS orden,
           e.descriptor->>'esquema' AS esquema, (e.descriptor->>'base')::numeric AS base, 'ANULACION'::text AS motivo
    FROM "ServiceEarning" e
    JOIN "CommissionCalculation" cc ON cc.id = e."sourceId"
    JOIN "Venue" v ON v.id = e."venueId"
    LEFT JOIN "Staff" s ON s.id = e."staffId"
    WHERE e."organizationId" = ${a.organizationId} AND e.concept = 'SERVICE' AND e."sourceType" = 'COMMISSION'
      AND e."venueId" = ANY(${venueIdsDe(a)}::text[]) AND cc.status = 'VOIDED'
      AND NOT EXISTS (
        SELECT 1 FROM "ServiceEarning" x
        WHERE x.concept = 'RECONCILE' AND x."sourceType" = 'COMMISSION' AND x."sourceId" = e."sourceId" AND x."staffId" = e."staffId")
      AND ${where}`
}

// ── Lectura ──

interface FilaVenta {
  fuente: FuenteVenta
  concepto: 'SERVICE' | 'RECONCILE'
  sourceId: string
  staffId: string
  venueId: string
  instante: Date
  fechaLocal: string
  hora: string
  monto: Prisma.Decimal
  sede: string
  persona: string
  orden: string | null
  esquema: string | null
  base: Prisma.Decimal | null
  motivo: DescriptorVenta['motivo']
}

const aLinea = (f: FilaVenta): LineaBarrible => ({
  fuente: f.fuente,
  concepto: f.concepto,
  sourceId: f.sourceId,
  staffId: f.staffId,
  venueId: f.venueId,
  fechaLocal: f.fechaLocal,
  instante: f.instante,
  monto: new Prisma.Decimal(f.monto),
  descriptor: {
    fecha: f.fechaLocal,
    hora: f.hora,
    sede: f.sede,
    persona: f.persona,
    orden: f.orden,
    esquema: f.esquema,
    base: f.base === null ? null : new Prisma.Decimal(f.base).toFixed(2),
    motivo: f.motivo,
  },
})

/** Un lote de comisiones barribles en orden de id: primero los ids (por llave), después el detalle de SÓLO ésos (§6.5). */
export async function comisionesBarribles(db: Db, a: AlcanceBarrido, o: { despuesDe?: string; limite: number }): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const r = await rangosBarribles(db, a)
  const ids = (await db.$queryRaw<Array<{ id: string }>>(idsComisiones(a, r, o.despuesDe, acotar(o.limite)))).map(x => x.id)
  if (!ids.length) return []
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detalleComisiones(Prisma.sql`cc.id = ANY(${ids}::text[])`)} ORDER BY cc.id ASC`
  return filas.map(aLinea)
}

export async function propinasBarribles(db: Db, a: AlcanceBarrido, o: { despuesDe?: string; limite: number }): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const r = await rangosBarribles(db, a)
  const ids = (await db.$queryRaw<Array<{ id: string }>>(idsPropinas(a, r, o.despuesDe, acotar(o.limite)))).map(x => x.id)
  if (!ids.length) return []
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detallePropinas(a, r, Prisma.sql`b.id = ANY(${ids}::text[])`)} ORDER BY b.id ASC`
  return filas.map(aLinea)
}

export async function reversosPorAnulacion(db: Db, a: AlcanceBarrido, o: { despuesDe?: string; limite: number }): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const cursor = o.despuesDe ? Prisma.sql`e."sourceId" > ${o.despuesDe}` : Prisma.sql`true`
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detalleReversos(a, cursor)} ORDER BY e."sourceId" ASC LIMIT ${acotar(o.limite)}`
  return filas.map(aLinea)
}

/** Propinas que entrarían pero no tienen persona (spec §6.3): no bloquean el cierre; el preview las dice. */
export async function propinasSinDueno(db: Db, a: AlcanceBarrido): Promise<{ n: number; total: Prisma.Decimal }> {
  if (fueraDelSobre(a)) return { n: 0, total: new Prisma.Decimal(0) }
  const r = await rangosBarribles(db, a)
  const [x] = await db.$queryRaw<Array<{ n: number; total: Prisma.Decimal | null }>>`
    SELECT COUNT(*)::int AS n, SUM(b.monto) AS total
    FROM (${propinasBase(a, r)}) b
    WHERE b."staffId" IS NULL AND b.motivo = 'VENTA'`
  return { n: x.n, total: x.total ?? new Prisma.Decimal(0) }
}

/**
 * Las tres fuentes como UNA consulta (sin paginar), para la vista EN VIVO del periodo abierto: el recibo y el reporte la
 * envuelven en su propio `UNION ALL` (B5). Mismas reglas y mismas columnas que las líneas del cierre. null si no barre.
 */
export async function sqlVentasDelPeriodo(db: Db, a: AlcanceBarrido, o: { staffId?: string } = {}): Promise<Prisma.Sql | null> {
  if (fueraDelSobre(a)) return null
  const r = await rangosBarribles(db, a)
  const dePersona = (col: string) => (o.staffId ? Prisma.sql`AND ${Prisma.raw(col)} = ${o.staffId}` : Prisma.empty)
  return Prisma.sql`
    ${detalleComisiones(Prisma.sql`cc."venueId" = ANY(${venueIdsDe(a)}::text[]) AND ${comisionBarrible(r)} ${dePersona('cc."staffId"')}`)}
    UNION ALL
    ${detallePropinas(a, r, Prisma.sql`true ${dePersona('b."staffId"')}`)}
    UNION ALL
    ${detalleReversos(a, Prisma.sql`true ${dePersona('e."staffId"')}`)}`
}

/** El primer lote de ids de cada fuente tal como lo pide el cierre, SÓLO para su `EXPLAIN` en la prueba de carga (B7). */
export async function consultasDeVentas(db: Db, a: AlcanceBarrido, n = 500) {
  const r = await rangosBarribles(db, a)
  return {
    comisiones: idsComisiones(a, r, undefined, n),
    propinas: idsPropinas(a, r, undefined, n),
    reversos: Prisma.sql`${detalleReversos(a, Prisma.sql`true`)} ORDER BY e."sourceId" ASC LIMIT ${n}`,
  }
}
