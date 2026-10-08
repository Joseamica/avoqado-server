// src/services/dashboard/staffPay/rangos.ts — qué días barre un cierre por sede: el periodo y la participación (fase 3, B10-B11).
import type { Prisma } from '@prisma/client'
import type prisma from '../../../utils/prismaClient'
import { dbDateComoFecha, diaCivilSiguiente, fechaComoDbDate, PeriodoCanonico, venuePeriodRange } from './periodos'
import type { AlcanceBarrido } from './fuentesVenta'
import { ConflictError } from '../../../errors/AppError'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * ponytail: periodos cerrados que se leen para los rangos (1,000 quincenas ≈ 41 años). Pasado el tope TRUENA en vez de
 * truncar: con el orden ascendente que necesita la fusión, truncar perdería los cerrados más recientes y sus ventas
 * tardías quedarían sin barrer para siempre. Paginar (o leer sólo los no contiguos) si algún día se acerca.
 */
const TOPE_PERIODOS_CERRADOS = 1000

/** Un rango de instantes [desde, hasta) de UNA sede: un tramo de días civiles ya convertido en su zona. */
export type RangoSede = { venueId: string; desde: Date; hasta: Date }
/** Una ventana de participación (`StaffPayVenueWindow`) en días civiles de la zona de su sede; `hasta` null = sin fin. */
export type Ventana = { venueId: string; desde: string; hasta: string | null }
/**
 * Los rangos de varias sedes como lo pide `enRangos` (B14-fix F4): por sede, sus tramos ordenados y unidos (los que se
 * tocan o se encimen quedan en uno: la unión es la misma que el OR de antes), en UN arreglo de límites `[d1, h1, d2, h2, …]`
 * (ISO) estrictamente creciente dentro de cada sede; `tramos[sede] = [primero, último]` (índices de PostgreSQL, desde 1) y el
 * sobre `[desde, hasta)`. PURA. null si no queda ningún rango con duración (todo `false`).
 */
export function limitesPorSede(
  r: RangoSede[],
): { limites: string[]; tramos: Record<string, [number, number]>; desde: Date; hasta: Date } | null {
  const porSede = new Map<string, Array<[number, number]>>()
  for (const x of r) {
    const d = x.desde.getTime()
    const h = x.hasta.getTime()
    if (!(h > d)) continue
    const suyos = porSede.get(x.venueId)
    if (suyos) suyos.push([d, h])
    else porSede.set(x.venueId, [[d, h]])
  }
  if (!porSede.size) return null
  const limites: string[] = []
  const tramos: Record<string, [number, number]> = {}
  let desde = Infinity
  let hasta = -Infinity
  for (const [sede, suyos] of porSede) {
    suyos.sort((a, b) => a[0] - b[0])
    const unidos: Array<[number, number]> = []
    for (const [d, h] of suyos) {
      const u = unidos[unidos.length - 1]
      if (u && d <= u[1]) u[1] = Math.max(u[1], h)
      else unidos.push([d, h])
    }
    const primero = limites.length + 1
    for (const [d, h] of unidos) limites.push(new Date(d).toISOString(), new Date(h).toISOString())
    tramos[sede] = [primero, limites.length]
    desde = Math.min(desde, unidos[0][0])
    hasta = Math.max(hasta, unidos[unidos.length - 1][1])
  }
  return { limites, tramos, desde: new Date(desde), hasta: new Date(hasta) }
}

/** Lo que barre UNA operación (cierre, vista previa, recibo, reporte): se calcula una vez y se pasa a cada lote (B11). */
export type Rangos = { periodo: RangoSede[]; participacion: RangoSede[] }
/** ponytail: ventanas que se leen por operación (500 sedes × 10). Pasado el tope TRUENA (nunca recorta); se sube la constante. */
export const TOPE_VENTANAS = 5000
/** B13 ronda 1 (R1): pasar el tope es volumen de datos, no un error de quien pregunta ⇒ 409 con texto (antes un Error crudo: 500). */
export const demasiadasVentanas = () =>
  new ConflictError(
    'Esta organización tiene demasiadas fechas de activación de sedes para leerlas; pide ayuda a Avoqado.',
    'STAFF_PAY_DEMASIADAS_VENTANAS',
  )

/** Un periodo que termina antes del inicio de pago al personal no barre nada: ni ventas ni anulaciones (B-D5). */
export const fueraDelSobre = (a: AlcanceBarrido) => !a.sedes.length || a.periodo.end < a.startDate

/** Los periodos CERRADOS ANTERIORES a P desde `startDate`, en días civiles y en orden (B-D1). Pasado el tope truena. */
async function cerradosAnteriores(db: Db, a: AlcanceBarrido): Promise<PeriodoCanonico[]> {
  const cerrados = await db.servicePayPeriod.findMany({
    where: {
      organizationId: a.organizationId,
      status: 'CLOSED',
      periodEnd: { gte: fechaComoDbDate(a.startDate), lt: fechaComoDbDate(a.periodo.start) },
    },
    select: { periodStart: true, periodEnd: true },
    orderBy: { periodStart: 'asc' },
    take: TOPE_PERIODOS_CERRADOS + 1,
  })
  if (cerrados.length > TOPE_PERIODOS_CERRADOS) throw new Error('STAFF_PAY_DEMASIADOS_PERIODOS_CERRADOS')
  return cerrados.map(x => ({ start: dbDateComoFecha(x.periodStart), end: dbDateComoFecha(x.periodEnd) }))
}

/** Tramos civiles ordenados por inicio: recorta al inicio y junta los contiguos (y los encimados de unas simuladas). */
function juntarContiguos(tramos: PeriodoCanonico[], startDate: string): PeriodoCanonico[] {
  const civiles: PeriodoCanonico[] = []
  for (const c of tramos) {
    const start = c.start < startDate ? startDate : c.start
    const u = civiles[civiles.length - 1]
    if (u && start <= diaCivilSiguiente(u.end)) u.end = c.end > u.end ? c.end : u.end
    else civiles.push({ start, end: c.end })
  }
  return civiles
}

/** Los tramos civiles de una sede como instantes, en SU zona (`venuePeriodRange`). */
const enSuZona = (s: { venueId: string; tz: string }, civiles: PeriodoCanonico[]): RangoSede[] =>
  civiles.map(c => {
    const { from, to } = venuePeriodRange(c, s.tz)
    return { venueId: s.venueId, desde: from, hasta: to }
  })

/**
 * Participación por sede (fase 3, B10-B11; diseño r3.4 + r4 + r4.5). Spec §6.2 puntos 3 y 4: una venta «ya cae» en este
 * cierre si su fecha civil —en la zona de SU sede— está en P o en un periodo anterior GUARDADO como CLOSED, y nunca antes
 * de `startDate`; un canónico sin fila cuenta como abierto y lo suyo espera a su propio cierre (Codex r1-10).
 * `periodo` (rp) = P más los CERRADOS ANTERIORES a P desde `startDate`, IGUAL para todas las sedes (B11 quitó el filtro por
 * `venueIds` de B4 r1: lo reemplaza la ventana). `participacion` (rv) = `periodo ∩ ventanas` de cada sede, intersectado en
 * DÍAS CIVILES y convertido después en su zona («desde el 1-nov» = 00:00 del 1-nov allá).
 * Ventanas: UNA consulta de las sedes del alcance, con tope (`TOPE_VENTANAS`: truena). `o.ventanas` (simuladas, para las
 * vistas previas de «entran / quedan fuera») reemplaza esa lectura; `o.soloElPeriodo` deja fuera los cerrados (la vista
 * previa de una sede mira sólo lo que todavía no se cierra).
 */
export async function rangosConParticipacion(
  db: Db,
  a: AlcanceBarrido,
  o: { ventanas?: Ventana[]; soloElPeriodo?: boolean } = {},
): Promise<Rangos> {
  if (fueraDelSobre(a)) return { periodo: [], participacion: [] }
  const civiles = await civilesDelPeriodo(db, a, o.soloElPeriodo)
  const porSede = new Map<string, Ventana[]>()
  for (const v of o.ventanas ?? (await ventanasDelAlcance(db, a))) {
    const suyas = porSede.get(v.venueId)
    if (suyas) suyas.push(v)
    else porSede.set(v.venueId, [v])
  }
  const periodo: RangoSede[] = []
  const participacion: RangoSede[] = []
  for (const s of a.sedes) {
    periodo.push(...enSuZona(s, civiles))
    const dias = civiles
      .flatMap(c =>
        (porSede.get(s.venueId) ?? []).map(v => ({
          start: v.desde > c.start ? v.desde : c.start,
          end: v.hasta !== null && v.hasta < c.end ? v.hasta : c.end,
        })),
      )
      .filter(d => d.start <= d.end)
      .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0))
    participacion.push(...enSuZona(s, juntarContiguos(dias, a.startDate)))
  }
  return { periodo, participacion }
}

/** P y los cerrados anteriores a P desde `startDate` (o sólo P), como tramos civiles contiguos. */
async function civilesDelPeriodo(db: Db, a: AlcanceBarrido, soloElPeriodo?: boolean): Promise<PeriodoCanonico[]> {
  return juntarContiguos([...(soloElPeriodo ? [] : await cerradosAnteriores(db, a)), a.periodo], a.startDate)
}

/**
 * Sólo `rp` (B12): los días que el cierre de P barre en cada sede —P y sus cerrados anteriores desde `startDate`—, sin leer
 * ventanas. Las devoluciones pendientes lo usan para quitar las que ya entran como línea en el cierre de P (r6.2).
 */
export async function periodoBarrido(db: Db, a: AlcanceBarrido): Promise<RangoSede[]> {
  if (fueraDelSobre(a)) return []
  const civiles = await civilesDelPeriodo(db, a)
  return a.sedes.flatMap(s => enSuZona(s, civiles))
}

/**
 * Los rangos con la ventana COMPLETA `[startDate, ∞)` en cada sede (B12, r5.4: «fuera» = completa − reales). Como los tramos
 * de `periodo` ya empiezan en `startDate`, intersectarlos con esa ventana los deja iguales: la participación completa ES el
 * periodo. Lo fija `rangos.completos.test.ts` contra `rangosConParticipacion` con esas ventanas simuladas.
 */
export const rangosCompletos = (r: Rangos): Rangos => ({ periodo: r.periodo, participacion: r.periodo })

/** Las ventanas de las sedes del alcance en esta organización, en una consulta y con tope (nunca recorta). */
const ventanasDelAlcance = (db: Db, a: AlcanceBarrido) =>
  ventanasDeSedes(
    db,
    a.organizationId,
    a.sedes.map(s => s.venueId),
  )

/** Las ventanas de esas sedes en la organización, en UNA consulta, por sede e inicio; con tope (truena, nunca recorta). B13. */
export async function ventanasDeSedes(db: Db, organizationId: string, venueIds: string[]): Promise<Ventana[]> {
  const filas = await db.staffPayVenueWindow.findMany({
    where: { organizationId, venueId: { in: venueIds } },
    select: { venueId: true, desde: true, hasta: true },
    orderBy: [{ venueId: 'asc' }, { desde: 'asc' }],
    take: TOPE_VENTANAS + 1,
  })
  if (filas.length > TOPE_VENTANAS) throw demasiadasVentanas()
  return filas.map(w => ({ venueId: w.venueId, desde: dbDateComoFecha(w.desde), hasta: w.hasta ? dbDateComoFecha(w.hasta) : null }))
}
