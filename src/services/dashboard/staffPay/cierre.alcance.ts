// src/services/dashboard/staffPay/cierre.alcance.ts — el alcance de un cierre, sus ventas y sus bloqueos (fases 2-3; B11).
import { Prisma, ServicePayPeriod } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { sedesConServicePay } from './acceso'
import { alcanceDelPeriodo, sedesConVentana } from './participacion'
import { periodoQueContieneFecha } from './periodosGuardados'
import { dbDateComoFecha, PeriodoCanonico, periodoQueContiene, venuePeriodRange } from './periodos'
import { contarPorEstado, FiltroValoracion } from './valoracion'
import { estadoActivacion } from './activacion.service'
import type { AlcanceBarrido } from './fuentesVenta'
import { Rangos, rangosConParticipacion } from './rangos'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma
const TZ_DEFAULT = 'America/Mexico_City'

export type Bloqueo =
  | { codigo: 'NO_HA_TERMINADO'; hasta: string }
  | { codigo: 'CLASES_EN_CURSO'; n: number }
  | { codigo: 'EXCEPCIONES'; n: number }
  | { codigo: 'SIN_PERMISO' }
  | { codigo: 'YA_CERRADO' }
  /**
   * B11 (diseño r3.4, r4.7): sedes del alcance ACTIVAS en pago al personal (ventana sin fin) que hoy no tienen el plan.
   * `otrasConPlan`: si otra sede de la organización lo tiene (desactivarlas con su último día libera el cierre); si ninguna,
   * sólo renovar el plan lo libera.
   */
  | { codigo: 'SEDE_ACTIVA_SIN_PLAN'; venueIds: string[]; otrasConPlan: boolean }

export interface Sede {
  venueId: string
  tz: string
  nombre: string
}
export interface Alcance {
  organizationId: string
  periodo: PeriodoCanonico
  periodId: string | null
  estado: 'OPEN' | 'CLOSED'
  venueIds: string[]
  sedes: Sede[]
}
/** Lo que barren las ventas de UNA operación: el alcance y sus rangos, calculados una vez (B11, r4.5). */
export type Barrido = { a: AlcanceBarrido; r: Rangos }

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

/**
 * Alcance de un periodo sin tomar candados (preview). Anticipa el crecimiento del cierre para que la huella coincida: la
 * MISMA regla (`alcanceDelPeriodo`, B11): cerrado = su alcance; abierto = guardadas ∪ con plan (D2) y, desde el inicio de
 * pago al personal, ∪ las sedes con alguna ventana (su historia). `activas`: las sedes con el plan, para los bloqueos.
 */
export async function alcanceSinCandado(organizationId: string, fecha: string): Promise<{ a: Alcance; activas: string[] }> {
  const fila = await periodoQueContieneFecha(prisma, organizationId, fecha)
  const activas = await sedesConServicePay(organizationId)
  const conVentana = await sedesConVentana(prisma, organizationId)
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { servicePayPeriodicity: true, staffPayStartDate: true },
  })
  const periodo = fila
    ? { start: dbDateComoFecha(fila.periodStart), end: dbDateComoFecha(fila.periodEnd) }
    : periodoQueContiene(fecha, org.servicePayPeriodicity)
  const estado = fila?.status ?? 'OPEN'
  const venueIds = alcanceDelPeriodo({
    periodo: { ...periodo, estado },
    guardadas: fila?.venueIds ?? [],
    activas,
    conVentana,
    startDate: org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null,
  })
  return {
    a: { organizationId, periodo, periodId: fila?.id ?? null, estado, venueIds, sedes: await sedesDe(prisma, organizationId, venueIds) },
    activas,
  }
}

/**
 * El alcance de las ventas y sus rangos —periodo y participación, calculados UNA vez por operación (B11)—, o null si el
 * negocio no ha activado pago al personal: entonces no se barre nada (B-D5).
 */
export async function alcanceDeVentas(db: Db, a: Alcance): Promise<Barrido | null> {
  const { startDate } = await estadoActivacion(db, a.organizationId)
  if (!startDate) return null
  const ab: AlcanceBarrido = {
    organizationId: a.organizationId,
    periodo: { id: a.periodId, start: a.periodo.start, end: a.periodo.end },
    sedes: a.sedes.map(s => ({ venueId: s.venueId, tz: s.tz })),
    startDate,
  }
  return { a: ab, r: await rangosConParticipacion(db, ab) }
}

export async function alcanceDe(tx: Tx, p: ServicePayPeriod): Promise<Alcance> {
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
 * cerrar o al liquidar contra un periodo ya cerrado), y el preview puede no tener `periodId`. Una clase CANCELADA que no se
 * paga no se valora ni se ancla: si después se reactiva, aparece como diferencia de su periodo (spec §6.4). Una cancelada
 * tarde sí, aunque su horario termine después del cierre: terminó al cancelarse (D5-fix, Codex D-1). Participación real
 * por default (B11): una clase sin ancla de una sede que no estaba activa ese día no se valora, no se ancla y no bloquea.
 */
export const filtroDe = (a: Alcance, s: Sede, ahora: Date): FiltroValoracion => {
  const { from, to } = venuePeriodRange(a.periodo, s.tz)
  return { venueId: s.venueId, organizationId: a.organizationId, tz: s.tz, desde: from, hasta: to, ahora }
}

/**
 * Los bloqueos del cierre. `activas`: las sedes con el plan, resueltas ANTES (preview) o antes de la transacción (cierre);
 * las ventanas abiertas se leen con `db` (la misma foto). `SEDE_ACTIVA_SIN_PLAN` (B11) también bloquea un periodo viejo.
 */
export async function bloqueosDe(db: Db, a: Alcance, ahora: Date, activas: string[]): Promise<Bloqueo[]> {
  const bloqueos: Bloqueo[] = []
  if (a.estado === 'CLOSED') return [{ codigo: 'YA_CERRADO' }]
  if (a.sedes.some(s => ahora < venuePeriodRange(a.periodo, s.tz).to)) bloqueos.push({ codigo: 'NO_HA_TERMINADO', hasta: a.periodo.end })
  let enCurso = 0
  let excepciones = 0
  for (const s of a.sedes) {
    const f = filtroDe(a, s, ahora)
    // Sin canceladas: una cancelada ya terminó (lo que paga no cambia), así que no hay que esperar su horario (D5-fix).
    enCurso += await db.classSession.count({
      where: { venueId: s.venueId, startsAt: { gte: f.desde, lt: f.hasta }, endsAt: { gt: ahora }, status: { not: 'CANCELLED' } },
    })
    excepciones += (await contarPorEstado(db, f)).excepciones
  }
  if (enCurso) bloqueos.push({ codigo: 'CLASES_EN_CURSO', n: enCurso })
  if (excepciones) bloqueos.push({ codigo: 'EXCEPCIONES', n: excepciones })
  // A lo más una ventana abierta por sede (el EXCLUDE no deja dos encimadas): acotado por el alcance.
  const abiertas = a.venueIds.length
    ? await db.staffPayVenueWindow.findMany({
        where: { organizationId: a.organizationId, hasta: null, venueId: { in: a.venueIds } },
        select: { venueId: true },
        orderBy: { venueId: 'asc' },
        take: a.venueIds.length,
      })
    : []
  const sinPlan = [...new Set(abiertas.map(w => w.venueId))].filter(v => !activas.includes(v)).sort()
  if (sinPlan.length) bloqueos.push({ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: sinPlan, otrasConPlan: activas.length > 0 })
  return bloqueos
}

/** El texto del bloqueo `SEDE_ACTIVA_SIN_PLAN` (r4.7): qué hacer, según haya o no otra sede con el plan. */
export function textoSedeActivaSinPlan(nombres: string[], otrasConPlan: boolean): string {
  const lista = nombres.length < 2 ? nombres.join('') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`
  const quien = nombres.length === 1 ? `la sede ${lista}` : `las sedes ${lista}`
  return otrasConPlan
    ? `Desactiva ${quien} indicando su último día: ${nombres.length === 1 ? 'está activa' : 'están activas'} en pago al personal sin el plan`
    : `Renueva el plan para cerrar; desactivar ${quien} no lo libera`
}
