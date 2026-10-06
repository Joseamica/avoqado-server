import { Prisma, ServicePayPeriod } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { utcTs } from '../../../utils/sqlDates'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { exigirPermisoEnSedes, sedesConPermiso, sedesConServicePay, tienePermisoEn } from './acceso'
import { ampliarAlcance, asegurarPeriodo, bloquearPeriodo, lockPeriodosDeOrganizacion, periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, PeriodoCanonico, periodoQueContiene, venuePeriodRange } from './periodos'
import { ClaseValorada, contarPorEstado, FiltroValoracion, valorarClases } from './valoracion'
import { Huella } from './huella'
import { estadoActivacion } from './activacion.service'
import {
  AlcanceBarrido,
  comisionesBarribles,
  LineaBarrible,
  propinasBarribles,
  propinasSinDueno,
  reversosPorAnulacion,
} from './fuentesVenta'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/**
 * Medido 2026-10-03 (A13, ronda 1), 50,000 clases: 9.0 s EN FRÍO (primer cierre: devengos y anclas vacíos y sin
 * estadísticas) y 9.2 s CON HISTORIAL. Antes del arreglo (lectura de todo el resto en cada lote y escrituras entre lotes):
 * 66 s con historial y en frío no terminaba. Fase 3 (B7, 2026-10-06, Mac con carga 13-20 en 10 núcleos): 50,000 clases +
 * 50,000 comisiones + 50,000 propinas: 43.2 s EN FRÍO y 42.0 s CON HISTORIAL (julio cerrado con otras 50,000 ventas) —
 * ~3 s las clases, ~15 s leer las ventas y ~24 s escribir 150,000 devengos y 50,000 anclas. El presupuesto es el doble del
 * peor, al minuto y con el mínimo de 60 s: 120 s. Mientras dura, activar, propinas, periodicidad y lo que cree un periodo
 * esperan su candado de la organización con tope (`ESPERA_CANDADO_ORGANIZACION_MS`) y contestan 409 CIERRE_EN_CURSO
 * (B7 r1). No se baja sin volver a medir (spec §6.3 punto 3; fase 3 §6.5): `tests/integration/staffPay/cierre.carga.test.ts`,
 * con y sin MEDIR_EN_FRIO=1.
 */
export const TIMEOUT_CIERRE_MS = 120_000
export const LOTE_CIERRE = 500
const BLOQUE_ESCRITURA = 1000
const TZ_DEFAULT = 'America/Mexico_City'

export type Bloqueo =
  | { codigo: 'NO_HA_TERMINADO'; hasta: string }
  | { codigo: 'CLASES_EN_CURSO'; n: number }
  | { codigo: 'EXCEPCIONES'; n: number }
  | { codigo: 'SIN_PERMISO' }
  | { codigo: 'YA_CERRADO' }

export interface PreviewCierre {
  periodo: { id: string | null; start: string; end: string; venueIds: string[] }
  puedeCerrar: boolean
  bloqueos: Bloqueo[]
  clases: number
  excluidas: number
  personas: number
  /** Sólo clases. */
  totalServicios: string
  totalAjustes: string
  /** Spec fase 3 §6.2-§6.4: lo que el cierre congela además de las clases (las devoluciones cuentan en su fuente). */
  comisiones: number
  propinas: number
  /** Comisiones ya congeladas que hoy están anuladas: se descuentan UNA vez (RECONCILE). */
  reversos: number
  /** Comisiones + propinas + reversos. `total = totalServicios + totalVentas + totalAjustes`. */
  totalVentas: string
  /** Propinas que no entran por no tener persona (no bloquean el cierre). Fuera de la huella. */
  propinasSinDueno: { n: number; total: string }
  /**
   * Resolución 16: cobros o devoluciones de las sedes del periodo cuya comisión no se pudo calcular (efecto en revisión
   * sin resolver). Un aviso: no bloquea el cierre y no entra en la huella.
   */
  comisionesPorRevisar: number
  total: string
  huerfanas: number
  huella: string
  /** Las sedes de `periodo.venueIds` con clases pagables, ventas o ajustes, en su mismo orden (QA 2026-10-03, defecto 8: el
   *  modal nombraba sedes sin una sola clase). No entra en la huella. */
  sedesConDinero: string[]
}

export interface ResultadoCierre {
  periodId: string
  start: string
  end: string
  venueIds: string[]
  personas: number
  total: string
  huella: string
  yaCerrado: boolean
}

interface Sede {
  venueId: string
  tz: string
  nombre: string
}
interface Alcance {
  organizationId: string
  periodo: PeriodoCanonico
  periodId: string | null
  estado: 'OPEN' | 'CLOSED'
  venueIds: string[]
  sedes: Sede[]
}

/** Sedes en el orden de `[...venueIds].sort()`: el mismo para la cabecera de la huella y para el recorrido. */
async function sedesDe(db: Db, organizationId: string, venueIds: string[]): Promise<Sede[]> {
  if (!venueIds.length) return []
  const vs = await db.venue.findMany({
    where: { id: { in: venueIds }, organizationId },
    select: { id: true, timezone: true, name: true },
    take: venueIds.length,
  })
  const porId = new Map(vs.map(v => [v.id, v]))
  return [...venueIds].sort().flatMap(id => {
    const v = porId.get(id)
    return v ? [{ venueId: v.id, tz: v.timezone || TZ_DEFAULT, nombre: v.name }] : []
  })
}

/** Alcance de un periodo sin tomar candados (preview). Anticipa el crecimiento de D2 para que la huella coincida. */
async function alcanceSinCandado(organizationId: string, fecha: string): Promise<Alcance> {
  const fila = await periodoQueContieneFecha(prisma, organizationId, fecha)
  const activas = await sedesConServicePay(organizationId)
  if (fila) {
    const venueIds = fila.status === 'OPEN' ? [...new Set([...fila.venueIds, ...activas])].sort() : [...fila.venueIds].sort()
    return {
      organizationId,
      periodo: { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) },
      periodId: fila.id,
      estado: fila.status,
      venueIds,
      sedes: await sedesDe(prisma, organizationId, venueIds),
    }
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const venueIds = [...activas].sort()
  return {
    organizationId,
    periodo: periodoQueContiene(fecha, org.servicePayPeriodicity),
    periodId: null,
    estado: 'OPEN',
    venueIds,
    sedes: await sedesDe(prisma, organizationId, venueIds),
  }
}

/** El alcance de las ventas, o null si el negocio no ha activado pago al personal: entonces no se barre nada (B-D5). */
async function alcanceDeVentas(db: Db, a: Alcance): Promise<AlcanceBarrido | null> {
  const { startDate } = await estadoActivacion(db, a.organizationId)
  if (!startDate) return null
  return {
    organizationId: a.organizationId,
    periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end },
    sedes: a.sedes.map(s => ({ venueId: s.venueId, tz: s.tz })),
    startDate,
  }
}

const sinDuenoDe = async (db: Db, v: AlcanceBarrido | null) => (v ? propinasSinDueno(db, v) : { n: 0, total: new Prisma.Decimal(0) })

/**
 * Resolución 16: efectos de comisión en revisión (`…:policy-error:v1`) sin resolver de las sedes del alcance. Sólo de cobros
 * desde el inicio de pago al personal en la zona de SU sede (B4 r1): lo de antes nunca entra al sobre, y su aviso sería
 * falso para siempre.
 */
const comisionesPorRevisar = (db: Db, v: AlcanceBarrido | null) =>
  v
    ? db.paymentEffect.count({
        where: {
          kind: 'COMMISSION',
          dedupeKey: { endsWith: ':policy-error:v1' },
          status: { not: 'DONE' },
          OR: v.sedes.map(s => ({
            venueId: s.venueId,
            payment: { createdAt: { gte: venuePeriodRange({ start: v.startDate, end: v.startDate }, s.tz).from } },
          })),
        },
      })
    : Promise.resolve(0)

async function alcanceDe(tx: Tx, p: ServicePayPeriod): Promise<Alcance> {
  const venueIds = [...p.venueIds].sort()
  return {
    organizationId: p.organizationId,
    periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd) },
    periodId: p.id,
    estado: p.status,
    venueIds,
    sedes: await sedesDe(tx, p.organizationId, venueIds),
  }
}

/**
 * Modo 'vivo' a propósito, en el preview y en el cierre: un periodo OPEN no tiene clases ancladas (sólo se ancla al
 * cerrar o al liquidar contra un periodo ya cerrado), y el preview puede no tener `periodId`. Una clase CANCELADA no se
 * valora ni se ancla: si después se reactiva, aparece como diferencia de su periodo (spec §6.4).
 */
const filtroDe = (a: Alcance, s: Sede, ahora: Date): FiltroValoracion => {
  const { from, to } = venuePeriodRange(a.periodo, s.tz)
  return { venueId: s.venueId, organizationId: a.organizationId, tz: s.tz, desde: from, hasta: to, ahora }
}

async function bloqueosDe(db: Db, a: Alcance, ahora: Date): Promise<Bloqueo[]> {
  const bloqueos: Bloqueo[] = []
  if (a.estado === 'CLOSED') return [{ codigo: 'YA_CERRADO' }]
  if (a.sedes.some(s => ahora < venuePeriodRange(a.periodo, s.tz).to)) bloqueos.push({ codigo: 'NO_HA_TERMINADO', hasta: a.periodo.end })
  let enCurso = 0
  let excepciones = 0
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    enCurso += await db.classSession.count({
      where: { venueId: s.venueId, startsAt: { gte: f.desde, lt: f.hasta }, endsAt: { gt: ahora }, status: { not: 'CANCELLED' } },
    })
    excepciones += (await contarPorEstado(db, f)).excepciones
  }
  if (enCurso) bloqueos.push({ codigo: 'CLASES_EN_CURSO', n: enCurso })
  if (excepciones) bloqueos.push({ codigo: 'EXCEPCIONES', n: excepciones })
  return bloqueos
}

/** IDs de las reservas de clase sin horario del periodo (spec §5.5), en orden fijo: sede → id. */
async function idsHuerfanas(db: Db, a: Alcance, ahora: Date): Promise<string[]> {
  const ids: string[] = []
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    let despuesDe: string | undefined
    for (;;) {
      const page = await db.reservation.findMany({
        where: {
          venueId: s.venueId,
          startsAt: { gte: f.desde, lt: f.hasta },
          classSessionId: null,
          status: { notIn: ['CANCELLED', 'PENDING'] },
          product: { type: 'CLASS' },
          ...(despuesDe ? { id: { gt: despuesDe } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 1000,
      })
      if (!page.length) break
      ids.push(...page.map(r => r.id))
      despuesDe = page[page.length - 1].id
    }
  }
  return ids
}

type AjusteGuardado = { id: string; staffId: string; venueId: string; amount: Prisma.Decimal }

/** TODOS los ajustes del periodo, por páginas con cursor: un tope de página nunca es un tope contable (Codex R1-3). */
async function ajustesDelPeriodo(db: Db, organizationId: string, periodId: string | null): Promise<AjusteGuardado[]> {
  if (!periodId) return []
  const todos: AjusteGuardado[] = []
  let despuesDe: string | undefined
  for (;;) {
    const page = await db.serviceEarning.findMany({
      where: { organizationId, periodId, concept: { in: ['RECONCILE', 'MANUAL'] }, ...(despuesDe ? { id: { gt: despuesDe } } : {}) },
      select: { id: true, staffId: true, venueId: true, amount: true },
      orderBy: { id: 'asc' },
      take: 1000,
    })
    if (!page.length) return todos
    todos.push(...page)
    despuesDe = page[page.length - 1].id
  }
}

export function descriptorDeClase(
  c: Pick<ClaseValorada, 'productName' | 'fechaLocal' | 'startsAt' | 'staffName'>,
  sede: { nombre: string; tz: string },
): Prisma.InputJsonObject {
  return {
    clase: c.productName,
    fecha: c.fechaLocal,
    hora: formatInTimeZone(c.startsAt, sede.tz, 'HH:mm'),
    sede: sede.nombre,
    coach: c.staffName,
  }
}

/**
 * Ancla de una vez (spec §5.4): nunca pisa un ancla existente. `updatedAt` en UTC, como lo escribe Prisma. Devuelve cuántas
 * clases quedaron ancladas (las que ya lo estaban no cuentan).
 */
export async function anclarClases(
  tx: Tx,
  periodId: string,
  filas: Array<{ classSessionId: string; fechaValoracion: string; tableVersionId: string | null }>,
): Promise<number> {
  if (!filas.length) return 0
  return tx.$executeRaw`
    INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "valuationVersionId", "payExcluded", "updatedAt")
    SELECT x.cid, ${periodId}, x.fecha::date, x.ver, false, (NOW() AT TIME ZONE 'UTC')
    FROM unnest(${filas.map(f => f.classSessionId)}::text[], ${filas.map(f => f.fechaValoracion)}::text[],
                ${filas.map(f => f.tableVersionId)}::text[]) AS x(cid, fecha, ver)
    ON CONFLICT ("classSessionId") DO UPDATE SET
      "originPeriodId" = EXCLUDED."originPeriodId",
      "valuationDate" = EXCLUDED."valuationDate",
      "valuationVersionId" = EXCLUDED."valuationVersionId",
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "ClassSessionPayState"."originPeriodId" IS NULL`
}

/**
 * Los siguientes `n` ids de clase de la sede en el rango, por llave (A13): se pagina ANTES de los joins pesados y sólo
 * esos ids se valoran. Sin los demás filtros de la valoración (terminada, no cancelada, sin ancla): ésos los aplica la
 * valoración, así que un lote puede valorar menos de `n` clases, nunca otras.
 */
export const consultaIdsDelLote = (f: FiltroValoracion, despuesDe: string | undefined, n: number): Prisma.Sql => Prisma.sql`
  SELECT cs.id FROM "ClassSession" cs
  WHERE cs."venueId" = ${f.venueId} AND cs."startsAt" >= ${utcTs(f.desde)} AND cs."startsAt" < ${utcTs(f.hasta)}
    ${despuesDe ? Prisma.sql`AND cs.id > ${despuesDe}` : Prisma.empty}
  ORDER BY cs.id ASC
  LIMIT ${n}`

interface Recorrido {
  clases: number
  excluidas: number
  comisiones: number
  propinas: number
  reversos: number
  personas: Set<string>
  sedesConDinero: Set<string>
  totalServicios: Prisma.Decimal
  totalVentas: Prisma.Decimal
  totalAjustes: Prisma.Decimal
  huella: string
}

/**
 * El ÚNICO recorrido de la huella (spec §6.3 puntos 2 y 4; fase 3 §6.5), el mismo para el preview y el cierre: cabecera →
 * clases (sede → clase, por lotes con cursor `classSessionId > último`) → comisiones (M) → propinas (T) → reversos por
 * anulación (X), cada fuente por lotes ordenados por id → ajustes por id → huérfanas por id. Cada lote pasa por la huella
 * ANTES de `alLote` / `alVentas`. No escribe nada: el cierre guarda lo de cada lote y escribe al terminar (A13). Todo nace
 * dentro de cada llamada: un reintento de `withSerializableRetry` empieza de cero. `digest()` se llama una sola vez.
 */
async function recorrer(
  db: Db,
  a: Alcance,
  ahora: Date,
  o: {
    tamLote: number
    ajustes: AjusteGuardado[]
    huerfanas: string[]
    /** null: sin activar, no se barren ventas (B-D5). */
    ventas: AlcanceBarrido | null
    alLote?: (lote: ClaseValorada[], sede: Sede) => Promise<void>
    alVentas?: (lote: LineaBarrible[]) => void
  },
): Promise<Recorrido> {
  const huella = new Huella()
  huella.cabecera({ organizationId: a.organizationId, ...a.periodo, venueIds: a.venueIds })
  const r = {
    clases: 0,
    excluidas: 0,
    comisiones: 0,
    propinas: 0,
    reversos: 0,
    personas: new Set<string>(),
    sedesConDinero: new Set<string>(),
    totalServicios: new Prisma.Decimal(0),
    totalVentas: new Prisma.Decimal(0),
    totalAjustes: new Prisma.Decimal(0),
  }
  // El mismo tope que `valorarClases`: con más ids que su LIMIT se perderían clases del lote.
  const tam = Math.min(Math.max(o.tamLote, 1), 1000)
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    let despuesDe: string | undefined
    for (;;) {
      // A13: primero los ids del lote (por llave), luego la valoración de SÓLO esos ids. Antes cada lote valoraba todo lo
      // que quedaba del periodo para quedarse con 500 (O(N²/lote)). El orden sigue siendo por classSessionId.
      const ids = (await db.$queryRaw<Array<{ id: string }>>(consultaIdsDelLote(f, despuesDe, tam))).map(x => x.id)
      if (!ids.length) break
      const lote = await valorarClases(db, { ...f, claseIds: ids }, { limite: tam })
      for (const c of lote) {
        huella.clase(c)
        if (c.estado === 'OK' && c.staffId && c.monto !== null) {
          r.clases++
          r.personas.add(c.staffId)
          r.sedesConDinero.add(s.venueId)
          r.totalServicios = r.totalServicios.plus(c.monto)
        } else if (c.estado === 'EXCLUIDA') r.excluidas++
      }
      if (o.alLote) await o.alLote(lote, s)
      despuesDe = ids[ids.length - 1]
    }
  }
  if (o.ventas) {
    const fuentes = [
      { leer: comisionesBarribles, hashear: (l: LineaBarrible) => huella.comision(l), contar: () => r.comisiones++ },
      { leer: propinasBarribles, hashear: (l: LineaBarrible) => huella.propina(l), contar: () => r.propinas++ },
      { leer: reversosPorAnulacion, hashear: (l: LineaBarrible) => huella.reverso(l), contar: () => r.reversos++ },
    ]
    for (const f of fuentes) {
      let despuesDe: string | undefined
      for (;;) {
        const lote = await f.leer(db, o.ventas, { despuesDe, limite: tam })
        if (!lote.length) break
        for (const l of lote) {
          f.hashear(l)
          f.contar()
          r.totalVentas = r.totalVentas.plus(l.monto)
          r.personas.add(l.staffId)
          r.sedesConDinero.add(l.venueId)
        }
        o.alVentas?.(lote)
        despuesDe = lote[lote.length - 1].sourceId
      }
    }
  }
  for (const aj of o.ajustes) {
    huella.ajuste(aj)
    r.totalAjustes = r.totalAjustes.plus(aj.amount)
    r.personas.add(aj.staffId)
    r.sedesConDinero.add(aj.venueId)
  }
  for (const id of o.huerfanas) huella.huerfana(id)
  return { ...r, huella: huella.digest() }
}

async function organizacionDe(venueId: string): Promise<string> {
  return (await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })).organizationId
}

export async function previewCierre(input: {
  userId: string
  venueId: string
  fecha: string
  ahora?: Date
  tamLote?: number
}): Promise<PreviewCierre> {
  const ahora = input.ahora ?? new Date()
  const a = await alcanceSinCandado(await organizacionDe(input.venueId), input.fecha)
  // Permiso ANTES de calcular nada (Codex R1-8): quien no puede cerrar todo el alcance no recibe ni un número de él.
  for (const v of a.venueIds) {
    if (!(await tienePermisoEn(input.userId, v, 'staffpay:close'))) {
      return {
        periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end, venueIds: [] },
        puedeCerrar: false,
        bloqueos: [{ codigo: 'SIN_PERMISO' }],
        clases: 0,
        excluidas: 0,
        comisiones: 0,
        propinas: 0,
        reversos: 0,
        personas: 0,
        totalServicios: '0.00',
        totalVentas: '0.00',
        totalAjustes: '0.00',
        propinasSinDueno: { n: 0, total: '0.00' },
        comisionesPorRevisar: 0,
        total: '0.00',
        huerfanas: 0,
        huella: '',
        sedesConDinero: [],
      }
    }
  }
  if (a.estado === 'CLOSED' && a.periodId) return previewCerrado({ ...a, periodId: a.periodId })
  const bloqueos = await bloqueosDe(prisma, a, ahora)
  const ajustes = await ajustesDelPeriodo(prisma, a.organizationId, a.periodId)
  const huerfanas = await idsHuerfanas(prisma, a, ahora)
  const ventas = await alcanceDeVentas(prisma, a)
  const r = await recorrer(prisma, a, ahora, { tamLote: input.tamLote ?? LOTE_CIERRE, ajustes, huerfanas, ventas })
  const sinDueno = await sinDuenoDe(prisma, ventas)
  return {
    periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end, venueIds: a.venueIds },
    puedeCerrar: bloqueos.length === 0,
    bloqueos,
    clases: r.clases,
    excluidas: r.excluidas,
    comisiones: r.comisiones,
    propinas: r.propinas,
    reversos: r.reversos,
    personas: r.personas.size,
    totalServicios: r.totalServicios.toFixed(2),
    totalVentas: r.totalVentas.toFixed(2),
    totalAjustes: r.totalAjustes.toFixed(2),
    propinasSinDueno: { n: sinDueno.n, total: sinDueno.total.toFixed(2) },
    comisionesPorRevisar: await comisionesPorRevisar(prisma, ventas),
    total: r.totalServicios.plus(r.totalVentas).plus(r.totalAjustes).toFixed(2),
    huerfanas: huerfanas.length,
    huella: r.huella,
    sedesConDinero: a.venueIds.filter(v => r.sedesConDinero.has(v)),
  }
}

/** Lo GUARDADO de un periodo cerrado: personas y total de los recibos (lo mismo que el retorno idempotente). */
async function recibosGuardados(db: Db, organizationId: string, periodId: string) {
  const agg = await db.staffPayStatement.aggregate({
    where: { periodId, period: { organizationId } },
    _count: { _all: true },
    _sum: { total: true },
  })
  return { personas: agg._count._all, total: agg._sum.total ?? new Prisma.Decimal(0) }
}

async function resultadoGuardado(db: Db, p: ServicePayPeriod, yaCerrado: boolean): Promise<ResultadoCierre> {
  const g = await recibosGuardados(db, p.organizationId, p.id)
  return {
    periodId: p.id,
    start: dbDateComoFecha(p.periodStart),
    end: dbDateComoFecha(p.periodEnd),
    venueIds: p.venueIds,
    personas: g.personas,
    total: g.total.toFixed(2),
    huella: p.closeFingerprint ?? '',
    yaCerrado,
  }
}

/**
 * Preview de un periodo CERRADO: lo guardado, nunca el recorrido en vivo (que sólo vería lo que llegó tarde y
 * mostraría otro total). Clases, comisiones, propinas y reversos salen de lo congelado, por concepto × fuente (desde la
 * fase 3 un SERVICE ya no es siempre una clase); `excluidas` no se reconstruye (0): el detalle se lee en el recibo.
 */
async function previewCerrado(a: Alcance & { periodId: string }): Promise<PreviewCierre> {
  const [g, porTipo, porSede] = await Promise.all([
    recibosGuardados(prisma, a.organizationId, a.periodId),
    // A lo más una fila por concepto × fuente.
    prisma.serviceEarning.groupBy({
      by: ['concept', 'sourceType'],
      where: { organizationId: a.organizationId, periodId: a.periodId },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    // Una fila por sede (GROUP BY): acotado por el número de sedes del alcance.
    prisma.serviceEarning.groupBy({ by: ['venueId'], where: { organizationId: a.organizationId, periodId: a.periodId } }),
  ])
  const de = (concept: string, sourceType: string) => porTipo.find(x => x.concept === concept && x.sourceType === sourceType)
  const clases = de('SERVICE', 'CLASS_SESSION')
  const totalServicios = clases?._sum.amount ?? new Prisma.Decimal(0)
  const totalVentas = porTipo
    .filter(x => x.sourceType === 'COMMISSION' || x.sourceType === 'TIP')
    .reduce((acc, x) => acc.plus(x._sum.amount ?? 0), new Prisma.Decimal(0))
  const conDinero = new Set(porSede.map(x => x.venueId))
  return {
    periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end, venueIds: a.venueIds },
    puedeCerrar: false,
    bloqueos: [{ codigo: 'YA_CERRADO' }],
    clases: clases?._count._all ?? 0,
    excluidas: 0,
    comisiones: de('SERVICE', 'COMMISSION')?._count._all ?? 0,
    propinas: de('SERVICE', 'TIP')?._count._all ?? 0,
    reversos: de('RECONCILE', 'COMMISSION')?._count._all ?? 0,
    personas: g.personas,
    totalServicios: totalServicios.toFixed(2),
    totalVentas: totalVentas.toFixed(2),
    totalAjustes: g.total.minus(totalServicios).minus(totalVentas).toFixed(2),
    propinasSinDueno: { n: 0, total: '0.00' },
    comisionesPorRevisar: 0,
    total: g.total.toFixed(2),
    huerfanas: 0,
    huella: '',
    sedesConDinero: a.venueIds.filter(v => conDinero.has(v)),
  }
}

/** Centinela: la huella cambió. Se convierte en `ConflictError HUELLA_CAMBIO` FUERA de la transacción (ya revertida). */
class HuellaCambio extends Error {}

export async function cerrarPeriodo(input: {
  userId: string
  venueId: string
  fecha: string
  huellaEsperada: string
  confirmarHuerfanas: boolean
  ahora?: Date
  tamLote?: number
  alTerminarLote?: (n: number) => void
}): Promise<ResultadoCierre> {
  const organizationId = await organizacionDe(input.venueId)
  const ahora = input.ahora ?? new Date()
  const tamLote = input.tamLote ?? LOTE_CIERRE
  // Módulos y permisos con el cliente GLOBAL, ANTES de la transacción: dentro retendrían su conexión mientras piden otra
  // (la familia de Codex R4-Nuevo 1). Candidatas: el alcance del periodo como está ahora ∪ las sedes con el módulo. Dentro
  // sólo se COMPARA contra lo resuelto; una sede que entró al alcance entretanto no tiene permiso resuelto y se niega.
  const activas = await sedesConServicePay(organizationId)
  const filaAntes = await periodoQueContieneFecha(prisma, organizationId, input.fecha)
  const permitidas = new Set(await sedesConPermiso(input.userId, [...(filaAntes?.venueIds ?? []), ...activas], 'staffpay:close'))
  try {
    return await withSerializableRetry(
      async tx => {
        // B-D3: el candado de la ORGANIZACIÓN primero (mismo orden que `asegurarPeriodo`: organización → periodo). Dos
        // cierres de periodos DISTINTOS pueden barrer la MISMA venta tardía de un periodo ya cerrado: con el candado el
        // segundo espera al primero. Lo que lo hace correcto es SSI, no el candado: SERIALIZABLE toma la foto en la primera
        // sentencia —ésta, ANTES de esperar—, así que el segundo, al congelar lo que el primero ya congeló, aborta con 40001
        // y el reintento ve la huella nueva (HUELLA_CAMBIO). También ordena el cierre con activar y con las propinas.
        // Sin tope (B7 r1): el cierre sí espera a quien tenga el candado; las operaciones cortas son las que no lo esperan a él.
        await lockPeriodosDeOrganizacion(tx, organizationId, { sinTope: true })
        const fila = await asegurarPeriodo(tx, organizationId, input.fecha, activas)
        let p = await bloquearPeriodo(tx, fila.id)
        const sinPermiso = 'Para cerrar necesitas el permiso de cerrar periodos en todas las sedes del periodo'
        // Permiso también ANTES del retorno idempotente (Codex R1-8): un «ya estaba cerrado» no regala los totales.
        if (p.status === 'CLOSED') {
          exigirPermisoEnSedes(permitidas, p.venueIds, sinPermiso)
          return resultadoGuardado(tx, p, true)
        }
        // D2: el cierre suma las sedes que hoy tienen el módulo, con permiso en cada una (`ampliarAlcance`).
        p = await ampliarAlcance(tx, p, activas, input.userId, { activas, permitidas })
        exigirPermisoEnSedes(permitidas, p.venueIds, sinPermiso)
        const a = await alcanceDe(tx, p)
        const bloqueos = await bloqueosDe(tx, a, ahora)
        const b = (codigo: Bloqueo['codigo']) => bloqueos.find(x => x.codigo === codigo)
        if (b('NO_HA_TERMINADO'))
          throw new BadRequestError(`El periodo termina el ${a.periodo.end}: todavía no se puede cerrar`, 'PERIODO_NO_TERMINA')
        const enCurso = b('CLASES_EN_CURSO') as { n: number } | undefined
        if (enCurso) throw new BadRequestError(`Hay ${enCurso.n} clase(s) en curso: espera a que terminen`, 'CLASES_EN_CURSO')
        const exc = b('EXCEPCIONES') as { n: number } | undefined
        if (exc)
          throw new BadRequestError(
            `Quedan ${exc.n} clase(s) que no se pueden pagar todavía: resuélvelas antes de cerrar`,
            'HAY_EXCEPCIONES',
          )
        const huerfanas = await idsHuerfanas(tx, a, ahora)
        if (huerfanas.length && !input.confirmarHuerfanas) {
          throw new BadRequestError(
            `Confirma que las ${huerfanas.length} reserva(s) de clase sin horario no cuentan para ningún pago`,
            'HUERFANAS_SIN_CONFIRMAR',
          )
        }

        // Los ajustes se LEEN antes de escribir los SERVICE y se hashean después de las clases, igual que en el preview.
        const ajustes = await ajustesDelPeriodo(tx, organizationId, p.id)
        // A13: LEER todo y DESPUÉS escribir. Si cada lote escribiera sus SERVICE y sus anclas, la lectura del siguiente
        // tocaría filas sin confirmar que nadie puede analizar, y en el primer cierre (tablas vacías) el plan se degrada lote
        // tras lote. Aquí se guarda sólo lo que se va a escribir.
        // ponytail: memoria O(clases), ~1-2 KB por clase (pico +78/+103 MB con 50,000). Si hiciera falta bajarla, los SERVICE
        // pueden escribirse por lote (la lectura en vivo ya no toca ServiceEarning) y dejar sólo las anclas para el final.
        const alcanceVentas = await alcanceDeVentas(tx, a)
        const servicios: Prisma.ServiceEarningCreateManyInput[] = []
        const ventas: Prisma.ServiceEarningCreateManyInput[] = []
        const anclas: Parameters<typeof anclarClases>[2] = []
        let lotes = 0
        const r = await recorrer(tx, a, ahora, {
          tamLote,
          ajustes,
          huerfanas,
          ventas: alcanceVentas,
          // ponytail: memoria O(ventas), ~1.5 KB por línea medido en B7 (pico del cierre +224/+263 MB con 50,000 clases y 100,000
          // líneas, contra +78/+103 MB sólo con las clases). Si hiciera falta, escribir por lote.
          alVentas: lote => {
            for (const l of lote) {
              ventas.push({
                organizationId,
                venueId: l.venueId,
                periodId: p.id,
                staffId: l.staffId,
                concept: l.concepto,
                sourceType: l.fuente,
                sourceId: l.sourceId,
                occurredAt: l.instante,
                amount: l.monto,
                descriptor: { ...l.descriptor },
                createdById: input.userId,
              })
            }
          },
          alLote: async (lote, sede) => {
            for (const c of lote) {
              anclas.push({ classSessionId: c.classSessionId, fechaValoracion: c.fechaValoracion, tableVersionId: c.tableVersionId })
              if (c.estado !== 'OK' || !c.staffId || c.monto === null) continue
              servicios.push({
                organizationId,
                venueId: c.venueId,
                periodId: p.id,
                staffId: c.staffId,
                concept: 'SERVICE',
                sourceType: 'CLASS_SESSION',
                sourceId: c.classSessionId,
                occurredAt: c.startsAt,
                payLevelId: c.payLevelId,
                payLevelName: c.payLevelName,
                tableVersionId: c.tableVersionId,
                countMode: c.countMode,
                count: c.conteo,
                amount: new Prisma.Decimal(c.monto),
                descriptor: descriptorDeClase(c, sede),
                createdById: input.userId,
              })
            }
            input.alTerminarLote?.(++lotes)
          },
        })
        // Antes de escribir: si la huella cambió, se aborta sin haber tocado nada (el resultado es el mismo que abortar después).
        if (r.huella !== input.huellaEsperada) throw new HuellaCambio()
        // Ningún índice impide congelar una venta dos veces: `ServiceEarning_service_unico` (y el de RECONCILE de venta)
        // incluyen `staffId`, así que la misma propina a otra persona (la orden cambió de quien la atiende) sí entraría. Lo
        // que lo impide es el anti-join por fuente + `sourceId` de fuentesVenta, más SSI: un cierre concurrente que ya la
        // congeló hace abortar a éste con 40001 y su reintento ya no la ve.
        for (const filas of [servicios, ventas])
          for (let i = 0; i < filas.length; i += BLOQUE_ESCRITURA)
            await tx.serviceEarning.createMany({ data: filas.slice(i, i + BLOQUE_ESCRITURA) })
        for (let i = 0; i < anclas.length; i += BLOQUE_ESCRITURA) await anclarClases(tx, p.id, anclas.slice(i, i + BLOQUE_ESCRITURA))

        // Recibos: suma de lo YA ESCRITO del periodo (clases, ventas y ajustes), uno por persona — quien sólo tiene un bono o sólo
        // vende también.
        const sumas = await tx.serviceEarning.groupBy({
          by: ['staffId'],
          where: { organizationId, periodId: p.id },
          _sum: { amount: true },
        })
        if (sumas.length) {
          await tx.staffPayStatement.createMany({
            data: sumas.map(s => ({ periodId: p.id, staffId: s.staffId, total: s._sum.amount ?? new Prisma.Decimal(0) })),
          })
        }
        const cerrado = await tx.servicePayPeriod.updateMany({
          where: { id: p.id, status: 'OPEN' },
          data: { status: 'CLOSED', closedAt: new Date(), closedById: input.userId, closeFingerprint: r.huella },
        })
        if (cerrado.count !== 1) throw new ConflictError('El periodo cambió mientras se cerraba: revisa de nuevo')
        const total = sumas.reduce((acc, s) => acc.plus(s._sum.amount ?? 0), new Prisma.Decimal(0))
        const sinDueno = await sinDuenoDe(tx, alcanceVentas)
        await writeLegacyActivityAuditTx(tx, {
          staffId: input.userId,
          venueId: input.venueId,
          action: 'SERVICE_PAY_PERIOD_CLOSED',
          entity: 'ServicePayPeriod',
          entityId: p.id,
          data: {
            periodo: { start: a.periodo.start, end: a.periodo.end },
            venueIds: a.venueIds,
            clases: r.clases,
            excluidas: r.excluidas,
            comisiones: r.comisiones,
            propinas: r.propinas,
            reversos: r.reversos,
            totalVentas: r.totalVentas.toFixed(2),
            propinasSinDueno: { n: sinDueno.n, total: sinDueno.total.toFixed(2) },
            comisionesPorRevisar: await comisionesPorRevisar(tx, alcanceVentas),
            personas: sumas.length,
            total: total.toFixed(2),
            huella: r.huella,
            huerfanas,
          },
        })
        return {
          periodId: p.id,
          start: a.periodo.start,
          end: a.periodo.end,
          venueIds: a.venueIds,
          personas: sumas.length,
          total: total.toFixed(2),
          huella: r.huella,
          yaCerrado: false,
        }
      },
      { timeoutMs: TIMEOUT_CIERRE_MS },
    )
  } catch (e) {
    if (!(e instanceof HuellaCambio)) throw e
    // Fuera de la transacción (ya revertida y sin el candado del periodo): el preview nuevo muestra el estado real de la
    // base, que es lo que el usuario tiene que volver a revisar.
    throw new ConflictError('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo', 'HUELLA_CAMBIO', {
      preview: await previewCierre({ userId: input.userId, venueId: input.venueId, fecha: input.fecha, ahora, tamLote }),
    })
  }
}
