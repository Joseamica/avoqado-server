// src/services/dashboard/staffPay/fuentesVenta.ts — qué comisiones, propinas y anulaciones barre un cierre (fase 3, spec §6.2–§6.4).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { utcTs } from '../../../utils/sqlDates'
import { fueraDelSobre, RangoSede, Rangos, rangosConParticipacion, Ventana } from './rangos'

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
const acotar = (n: number) => Math.min(Math.max(Math.trunc(n) || 1, 1), 1000)

/** `(sede = X AND col en [desde, hasta)) OR …` sobre las columnas de `alias` (alias fijos del código, nunca del usuario). */
export function enRangos(alias: 'cc' | 'o' | 'p' | 'op', columna: 'calculatedAt' | 'createdAt', r: RangoSede[]): Prisma.Sql {
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
/** Lo que dice el nombre de alguien borrado físicamente sin ningún nombre guardado (spec fase 3 §6.1). */
export const PERSONA_DADA_DE_BAJA = 'Persona dada de baja'
const personaSql = Prisma.sql`COALESCE(NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''), ${PERSONA_DADA_DE_BAJA})`

/**
 * El nombre que guardó una persona en la organización, para cuando ya no tiene fila de `Staff` (B5 r1): el de su devengo MÁS
 * RECIENTE que lo traiga, sin contar «Persona dada de baja» (lo que escribe una venta congelada después de borrarla, que si
 * no le ganaría a su nombre real). NULL si no hay ninguno. La MISMA regla en el recibo y en los dos reportes; usa el índice
 * (organizationId, staffId) y, dentro de un COALESCE, sólo corre para quien no tiene nombre vivo.
 */
export const nombreGuardadoSql = (organizationId: string, staffId: Prisma.Sql) => Prisma.sql`(
  SELECT COALESCE(g.descriptor->>'persona', g.descriptor->>'coach') FROM "ServiceEarning" g
  WHERE g."organizationId" = ${organizationId} AND g."staffId" = ${staffId}
    AND COALESCE(g.descriptor->>'persona', g.descriptor->>'coach') <> ${PERSONA_DADA_DE_BAJA}
  ORDER BY g."createdAt" DESC, g.id DESC
  LIMIT 1)`

// ── Comisiones (spec §6.2) ──

/** Una comisión que no está anulada ni congelada (sin su propio `SERVICE`): «ya congelada» por FUENTE, no por persona (B-D2). */
const comisionViva = (a: 'cc') => Prisma.sql`
  ${Prisma.raw(a)}.status <> 'VOIDED'
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceEarning" e WHERE e."sourceType" = 'COMMISSION' AND e."sourceId" = ${Prisma.raw(a)}.id AND e.concept = 'SERVICE')`

/** La comisión original `o` —no anulada— de un reverso de devolución: la llave de `createRefundCommission` (`originalPaymentId` + esquema + persona). */
const originalDelReverso = (a: 'cc') => Prisma.sql`
  FROM "Payment" rf
  JOIN "CommissionCalculation" o
    ON o."paymentId" = rf."processorData"->>'originalPaymentId' AND o."configId" = ${Prisma.raw(a)}."configId"
   AND o."staffId" = ${Prisma.raw(a)}."staffId"
  WHERE rf.id = ${Prisma.raw(a)}."paymentId" AND rf.type = 'REFUND' AND o.status <> 'VOIDED'`

/** Una devolución de propina (alias `p`) que todavía no tiene su propio `SERVICE`. */
const reembolsoDePropina = (a: 'p') => Prisma.sql`(
  ${Prisma.raw(a)}.type = 'REFUND' AND ${Prisma.raw(a)}.status = 'COMPLETED' AND ${Prisma.raw(a)}."tipAmount" < 0
  AND NOT EXISTS (
    SELECT 1 FROM "ServiceEarning" er WHERE er."sourceType" = 'TIP' AND er."sourceId" = ${Prisma.raw(a)}.id AND er.concept = 'SERVICE'))`

/** La propina ORIGINAL de la devolución `a` ya está congelada (`SERVICE`). */
const propinaOriginalCongelada = (a: 'p') => Prisma.sql`EXISTS (
  SELECT 1 FROM "ServiceEarning" ef
  WHERE ef."sourceType" = 'TIP' AND ef.concept = 'SERVICE' AND ef."sourceId" = ${Prisma.raw(a)}."processorData"->>'originalPaymentId')`

/**
 * El reverso de algo que el sobre YA pagó (B10; r6.2): no anulado y sin su propio `SERVICE`, con su original congelada
 * (`SERVICE`) y no anulada. La rama de reversos del barrido: sin ventana, sólo su fecha en `rp`. B12 lo reusa para las
 * pendientes. `'COMMISSION'` sobre `CommissionCalculation` (alias `cc`); `'TIP'` sobre `Payment` (alias `p`).
 */
export function reversoDeLoCongelado(fuente: 'COMMISSION', a: 'cc'): Prisma.Sql
export function reversoDeLoCongelado(fuente: 'TIP', a: 'p'): Prisma.Sql
export function reversoDeLoCongelado(fuente: FuenteVenta, a: 'cc' | 'p'): Prisma.Sql {
  if (fuente === 'TIP') return Prisma.sql`(${reembolsoDePropina(a as 'p')} AND ${propinaOriginalCongelada(a as 'p')})`
  return Prisma.sql`(
    ${comisionViva(a as 'cc')}
    AND EXISTS (
      SELECT 1 ${originalDelReverso(a as 'cc')}
        AND EXISTS (
          SELECT 1 FROM "ServiceEarning" eo WHERE eo."sourceType" = 'COMMISSION' AND eo."sourceId" = o.id AND eo.concept = 'SERVICE')))`
}

/**
 * Puntos 1-6 sobre `cc` (r2 §6; `rp` = periodo, `rv` = participación, de `rangosConParticipacion`). Toda fila cae en
 * `rp` (factor común del índice venueId + fecha); una VENTA exige además `rv`. Un reverso de devolución (su pago es un
 * REFUND) sólo entra si la comisión que revierte ya está congelada (`reversoDeLoCongelado`) o entra en este mismo cierre
 * (su original en `rv`) (Codex r1-18): nunca se descuenta lo que el sobre no pagó. Una original ANULADA no ampara a nadie:
 * si estaba congelada, su anulación ya devuelve su monto completo (§6.4) y el reverso descontaría otra vez.
 */
export function comisionBarrible(rp: RangoSede[], rv: RangoSede[]): Prisma.Sql {
  return Prisma.sql`
    ${comisionViva('cc')}
    AND ${enRangos('cc', 'calculatedAt', rp)}
    AND (
      (NOT EXISTS (SELECT 1 FROM "Payment" rf WHERE rf.id = cc."paymentId" AND rf.type = 'REFUND')
       AND ${enRangos('cc', 'calculatedAt', rv)})
      OR ${reversoDeLoCongelado('COMMISSION', 'cc')}
      OR EXISTS (SELECT 1 ${originalDelReverso('cc')} AND ${enRangos('o', 'calculatedAt', rv)})
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

const idsComisiones = (a: AlcanceBarrido, rp: RangoSede[], rv: RangoSede[], despuesDe: string | undefined, n: number) => Prisma.sql`
  SELECT cc.id FROM "CommissionCalculation" cc
  WHERE cc."venueId" = ANY(${venueIdsDe(a)}::text[]) AND ${comisionBarrible(rp, rv)}
    ${despuesDe ? Prisma.sql`AND cc.id > ${despuesDe}` : Prisma.empty}
  ORDER BY cc.id ASC
  LIMIT ${n}`

// ── Propinas (spec §6.3) ──

/**
 * Un cobro cuya propina entra al sobre (alias `p` o `op`): tipo, estado, ventana [startsAt, endsAt) y sin congelar. La
 * FECHA (`enRangos`) va aparte: `propinasBase` la saca como factor común de cobros y reembolsos (índice venueId+createdAt).
 */
function reglaDelCobro(alias: 'p' | 'op', a: AlcanceBarrido): Prisma.Sql {
  const c = (col: string) => Prisma.raw(`${alias}.${col}`)
  return Prisma.sql`
    ${c('status')} = 'COMPLETED' AND COALESCE(${c('type')}, 'REGULAR') IN ('REGULAR', 'FAST') AND ${c('"tipAmount"')} > 0
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
 * B10 (r2 §6): toda fila cae en `rp`; un COBRO, y la original de un reembolso que entra en este cierre (`en_este`), exigen
 * además `rv` (la participación de su sede). Reembolsos en dos ramas disjuntas: de una propina ya congelada (`reversoDeLoCongelado`,
 * dueño de `congelada`) y de una que no (dueño de `en_este`; si no entra, NULL y ningún consumidor la toma).
 */
export function propinasBase(a: AlcanceBarrido, rp: RangoSede[], rv: RangoSede[]): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id, p."venueId", p."orderId", p."createdAt" AS instante, p."tipAmount" AS monto,
           CASE WHEN p.type = 'REFUND' THEN 'DEVOLUCION' ELSE 'VENTA' END AS motivo,
           CASE WHEN p.type = 'REFUND' THEN COALESCE(congelada."staffId", en_este."staffId")
                ELSE COALESCE(ord."servedById", p."processedById") END AS "staffId"
    FROM "Payment" p
    -- B7 r1: LATERAL con LIMIT 1 y no LEFT JOIN (misma fila: Order.id es la llave). Con un join, el planeador estimaba 1 cobro
    -- donde había 50,000 y unía con un Seq Scan de TODAS las órdenes por cobro: propinasSinDueno tardaba 132 s; así, 0.4 s.
    LEFT JOIN LATERAL (SELECT o."servedById" FROM "Order" o WHERE o.id = p."orderId" LIMIT 1) ord ON true
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
        AND ${enRangos('op', 'createdAt', rv)} AND ${reglaDelCobro('op', a)}
    ) en_este ON true
    WHERE p."venueId" = ANY(${venueIdsDe(a)}::text[])
      AND ${enRangos('p', 'createdAt', rp)}
      AND (
        (${reglaDelCobro('p', a)} AND ${enRangos('p', 'createdAt', rv)})
        OR ${reversoDeLoCongelado('TIP', 'p')}
        OR (${reembolsoDePropina('p')} AND NOT ${propinaOriginalCongelada('p')})
      )`
}

function detallePropinas(a: AlcanceBarrido, rp: RangoSede[], rv: RangoSede[], where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT 'TIP'::text AS fuente, 'SERVICE'::text AS concepto, b.id AS "sourceId", b."staffId", b."venueId", b.instante,
           ${local(Prisma.sql`b.instante`, 'YYYY-MM-DD')} AS "fechaLocal", ${local(Prisma.sql`b.instante`, 'HH24:MI')} AS hora,
           b.monto, v.name AS sede, ${personaSql} AS persona, ord."orderNumber" AS orden, NULL::text AS esquema,
           NULL::numeric AS base, b.motivo
    FROM (${propinasBase(a, rp, rv)}) b
    JOIN "Venue" v ON v.id = b."venueId"
    LEFT JOIN "Staff" s ON s.id = b."staffId"
    LEFT JOIN "Order" ord ON ord.id = b."orderId"
    WHERE b."staffId" IS NOT NULL AND ${where}`
}

const idsPropinas = (a: AlcanceBarrido, rp: RangoSede[], rv: RangoSede[], despuesDe: string | undefined, n: number) => Prisma.sql`
  SELECT b.id FROM (${propinasBase(a, rp, rv)}) b
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

/**
 * Un lote de comisiones barribles en orden de id: primero los ids (por llave), después el detalle de SÓLO ésos (§6.5).
 * B11 (r4.5): `r` (periodo y participación) lo calcula UNA vez la operación (cierre, vista previa, recibo, reporte) y lo pasa
 * a cada lote; antes cada lote volvía a leer los cerrados.
 */
export async function comisionesBarribles(
  db: Db,
  a: AlcanceBarrido,
  r: Rangos,
  o: { despuesDe?: string; limite: number },
): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const ids = (await db.$queryRaw<Array<{ id: string }>>(idsComisiones(a, r.periodo, r.participacion, o.despuesDe, acotar(o.limite)))).map(
    x => x.id,
  )
  if (!ids.length) return []
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detalleComisiones(Prisma.sql`cc.id = ANY(${ids}::text[])`)} ORDER BY cc.id ASC`
  return filas.map(aLinea)
}

export async function propinasBarribles(
  db: Db,
  a: AlcanceBarrido,
  r: Rangos,
  o: { despuesDe?: string; limite: number },
): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const ids = (await db.$queryRaw<Array<{ id: string }>>(idsPropinas(a, r.periodo, r.participacion, o.despuesDe, acotar(o.limite)))).map(
    x => x.id,
  )
  if (!ids.length) return []
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detallePropinas(a, r.periodo, r.participacion, Prisma.sql`b.id = ANY(${ids}::text[])`)} ORDER BY b.id ASC`
  return filas.map(aLinea)
}

/** Anulaciones de comisiones congeladas (§6.4): no dependen de rangos ni de ventanas (r4.2); `r` sólo por la misma firma. */
export async function reversosPorAnulacion(
  db: Db,
  a: AlcanceBarrido,
  _r: Rangos,
  o: { despuesDe?: string; limite: number },
): Promise<LineaBarrible[]> {
  if (fueraDelSobre(a)) return []
  const cursor = o.despuesDe ? Prisma.sql`e."sourceId" > ${o.despuesDe}` : Prisma.sql`true`
  const filas = await db.$queryRaw<FilaVenta[]>`
    ${detalleReversos(a, cursor)} ORDER BY e."sourceId" ASC LIMIT ${acotar(o.limite)}`
  return filas.map(aLinea)
}

/** Propinas que entrarían pero no tienen persona (spec §6.3): no bloquean el cierre; el preview las dice. */
export async function propinasSinDueno(db: Db, a: AlcanceBarrido, r: Rangos): Promise<{ n: number; total: Prisma.Decimal }> {
  if (fueraDelSobre(a)) return { n: 0, total: new Prisma.Decimal(0) }
  const [x] = await db.$queryRaw<Array<{ n: number; total: Prisma.Decimal | null }>>(sqlPropinasSinDueno(a, r.periodo, r.participacion))
  return { n: x.n, total: x.total ?? new Prisma.Decimal(0) }
}

const sqlPropinasSinDueno = (a: AlcanceBarrido, rp: RangoSede[], rv: RangoSede[]) => Prisma.sql`
  SELECT COUNT(*)::int AS n, SUM(b.monto) AS total
  FROM (${propinasBase(a, rp, rv)}) b
  WHERE b."staffId" IS NULL AND b.motivo = 'VENTA'`

/**
 * Las tres fuentes como UNA consulta (sin paginar), para la vista EN VIVO del periodo abierto: el recibo y el reporte la
 * envuelven en su propio `UNION ALL` (B5). Mismas reglas y mismas columnas que las líneas del cierre. null si no barre.
 */
export function sqlVentasDelPeriodo(a: AlcanceBarrido, r: Rangos, o: { staffId?: string } = {}): Prisma.Sql | null {
  if (fueraDelSobre(a)) return null
  const dePersona = (col: string) => (o.staffId ? Prisma.sql`AND ${Prisma.raw(col)} = ${o.staffId}` : Prisma.empty)
  const { periodo: rp, participacion: rv } = r
  return Prisma.sql`
    ${detalleComisiones(Prisma.sql`cc."venueId" = ANY(${venueIdsDe(a)}::text[]) AND ${comisionBarrible(rp, rv)} ${dePersona('cc."staffId"')}`)}
    UNION ALL
    ${detallePropinas(a, rp, rv, Prisma.sql`true ${dePersona('b."staffId"')}`)}
    UNION ALL
    ${detalleReversos(a, Prisma.sql`true ${dePersona('e."staffId"')}`)}`
}

/** Comisiones y propinas que entran, NETAS (devoluciones con su signo), por sede y fuente: una fila por par. */
export type TotalVentas = { venueId: string; fuente: FuenteVenta; n: number; total: Prisma.Decimal }

/**
 * La suma de lo que el barrido tomaría, por sede y fuente (B11, diseño r5.4, r7.3): los MISMOS constructores
 * (`comisionBarrible`, `propinasBase` con persona) sobre las ventanas reales o SIMULADAS (`o.ventanas`). «Entran» y «quedan
 * fuera» salen por DIFERENCIA de estas sumas, nunca de los positivos: una devolución entra o sale con su original (+$60 y
 * −$60 alrededor de la fecha ⇒ $0). Las anulaciones (§6.4) no dependen de las ventanas: no van aquí. Agregado en la base:
 * nunca trae las filas a memoria. Con `o.rangos` no lee nada más (las ventanas ya van en ellos).
 */
export async function totalesVentas(
  db: Db,
  a: AlcanceBarrido,
  o: { ventanas?: Ventana[]; soloElPeriodo?: boolean; rangos?: Rangos } = {},
): Promise<TotalVentas[]> {
  if (fueraDelSobre(a)) return []
  // `o.rangos`: los que la operación ya calculó (B12: la vista previa del cierre reusa los de su recorrido, una vez).
  const { periodo: rp, participacion: rv } = o.rangos ?? (await rangosConParticipacion(db, a, o))
  const filas = await db.$queryRaw<Array<{ venueId: string; fuente: FuenteVenta; n: number; total: Prisma.Decimal | null }>>`
    SELECT x."venueId", x.fuente, COUNT(*)::int AS n, SUM(x.monto) AS total
    FROM (
      SELECT cc."venueId", 'COMMISSION'::text AS fuente, cc."netCommission" AS monto
      FROM "CommissionCalculation" cc
      WHERE cc."venueId" = ANY(${venueIdsDe(a)}::text[]) AND ${comisionBarrible(rp, rv)}
      UNION ALL
      SELECT b."venueId", 'TIP'::text AS fuente, b.monto FROM (${propinasBase(a, rp, rv)}) b WHERE b."staffId" IS NOT NULL
    ) x
    GROUP BY x."venueId", x.fuente`
  return filas.map(f => ({ ...f, total: new Prisma.Decimal(f.total ?? 0) }))
}

/**
 * Un lote de ids de cada fuente (el primero, o el que sigue a `despuesDe`) y la cuenta de propinas sin dueño, tal como las
 * pide el cierre, SÓLO para su `EXPLAIN` en la prueba de carga (B7).
 */
export async function consultasDeVentas(db: Db, a: AlcanceBarrido, n = 500, despuesDe: { comisiones?: string; propinas?: string } = {}) {
  const { periodo: rp, participacion: rv } = await rangosConParticipacion(db, a)
  return {
    comisiones: idsComisiones(a, rp, rv, despuesDe.comisiones, n),
    propinas: idsPropinas(a, rp, rv, despuesDe.propinas, n),
    reversos: Prisma.sql`${detalleReversos(a, Prisma.sql`true`)} ORDER BY e."sourceId" ASC LIMIT ${n}`,
    sinDueno: sqlPropinasSinDueno(a, rp, rv),
  }
}
