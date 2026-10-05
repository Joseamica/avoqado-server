import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { valorarClases } from './valoracion'
import { fechaComoDbDate, hoyLocal, Periodicidad, PeriodoCanonico, periodoQueContiene, venuePeriodRange } from './periodos'

export class FinDeSimulacion extends Error {
  constructor(public readonly resultado: EfectoDelCambio) {
    super('simulación terminada')
  }
}

/** Cuántas clases cambian de pago en UN periodo abierto. */
export interface EfectoPorPeriodo {
  start: string
  end: string
  clases: number
}
/**
 * «Cambia el pago de N clases de septiembre y M de octubre» (spec §7.1, revisión final I-2). `porPeriodo`: los periodos
 * ABIERTOS recorridos, del más viejo al más nuevo (también los que quedan en 0). `periodosSinContar`: periodos abiertos MÁS
 * VIEJOS que no se recorrieron por el tope (no contados: pueden tener 0 cambios o varios).
 */
export interface EfectoDelCambio {
  clasesQueCambian: number
  porPeriodo: EfectoPorPeriodo[]
  periodosSinContar: number
}

/** Tope de periodos abiertos que se recorren (los más recientes): la simulación valora cada clase dos veces. */
export const TOPE_PERIODOS_EFECTO = 3
const TZ_DEFAULT = 'America/Mexico_City'

/** Periodos que se enumeran uno por uno, hacia atrás desde hoy (10 años quincenales, 20 mensuales). */
const VENTANA_PERIODOS = 240

/** Posición de un periodo canónico en una cuenta continua: la resta de dos da cuántos periodos hay entre ellos. */
function indice(inicio: string, periodicidad: Periodicidad): number {
  const [y, m, d] = inicio.split('-').map(Number)
  const mes = y * 12 + (m - 1)
  return periodicidad === 'MONTHLY' ? mes : mes * 2 + (d >= 16 ? 1 : 0)
}

/** El periodo canónico anterior a `p`. */
function anterior(p: PeriodoCanonico, periodicidad: Periodicidad): PeriodoCanonico {
  const dia = new Date(`${p.start}T12:00:00Z`)
  dia.setUTCDate(dia.getUTCDate() - 1)
  return periodoQueContiene(dia.toISOString().slice(0, 10), periodicidad)
}

/**
 * Los periodos NO cerrados desde el que contiene `desde` hasta el de hoy (los cerrados conservan su pago congelado; el
 * modo vivo además ya no ve lo anclado): se cuentan los más recientes, hasta el tope. Se enumera HACIA ATRÁS desde hoy
 * (revisión final, m2: enumerar desde `desde` con un tope nunca llegaba a hoy con una vigencia muy vieja), y lo que queda
 * antes de la ventana sólo se cuenta con aritmética, menos sus cerrados.
 */
async function periodosAbiertos(
  db: Prisma.TransactionClient,
  organizationId: string,
  desde: string,
  hoy: string,
): Promise<{ contar: PeriodoCanonico[]; sinContar: number }> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { servicePayPeriodicity: true } })
  const per = org.servicePayPeriodicity
  const inicio = periodoQueContiene(desde, per)
  const ventana: PeriodoCanonico[] = []
  for (let p = periodoQueContiene(hoy, per); ventana.length < VENTANA_PERIODOS && p.start >= inicio.start; p = anterior(p, per)) {
    ventana.unshift(p)
  }
  if (!ventana.length) return { contar: [], sinContar: 0 } // la vigencia empieza después de hoy: nada ha cambiado aún
  const cerrados = await db.servicePayPeriod.findMany({
    where: {
      organizationId,
      status: 'CLOSED',
      periodStart: { lte: fechaComoDbDate(ventana[ventana.length - 1].end) },
      periodEnd: { gte: fechaComoDbDate(ventana[0].start) },
    },
    select: { periodStart: true },
    take: ventana.length,
  })
  const inicios = new Set(cerrados.map(c => c.periodStart.toISOString().slice(0, 10)))
  const abiertos = ventana.filter(p => !inicios.has(p.start))
  const contar = abiertos.slice(-TOPE_PERIODOS_EFECTO)
  // Los periodos más viejos que la ventana: cuántos hay, menos los cerrados.
  const antes = indice(ventana[0].start, per) - indice(inicio.start, per)
  const cerradosAntes = antes
    ? await db.servicePayPeriod.count({
        where: {
          organizationId,
          status: 'CLOSED',
          periodStart: { gte: fechaComoDbDate(inicio.start), lt: fechaComoDbDate(ventana[0].start) },
        },
      })
    : 0
  return { contar, sinContar: abiertos.length - contar.length + antes - cerradosAntes }
}

/** Firma de cada clase calculada en vivo de esos periodos, con el índice del periodo al que pertenece. */
async function firmas(
  db: Prisma.TransactionClient,
  organizationId: string,
  sedes: Array<{ id: string; tz: string }>,
  periodos: PeriodoCanonico[],
  ahora: Date,
): Promise<Map<string, { periodo: number; firma: string }>> {
  const out = new Map<string, { periodo: number; firma: string }>()
  for (const [i, p] of periodos.entries()) {
    for (const v of sedes) {
      const { from, to } = venuePeriodRange(p, v.tz)
      let despuesDe: string | undefined
      for (;;) {
        const page = await valorarClases(
          db,
          { venueId: v.id, organizationId, tz: v.tz, desde: from, hasta: to, ahora },
          { despuesDe, limite: 1000 },
        )
        if (!page.length) break
        for (const c of page) out.set(c.classSessionId, { periodo: i, firma: `${c.estado}|${c.motivo ?? ''}|${c.monto?.toString() ?? ''}` })
        despuesDe = page[page.length - 1].classSessionId
      }
    }
  }
  return out
}

/**
 * Qué clases cambian de pago con un cambio de tabla o de nivel que rige desde `effectiveFrom` (spec §7.1): aplica el cambio
 * en una transacción que SIEMPRE se revierte y compara la valoración en vivo antes y después, en los periodos abiertos desde
 * el que contiene `effectiveFrom` hasta el de hoy. Una fecha dentro de un periodo cerrado ya la rechazó quien llama.
 */
export async function efectoDelCambio(
  organizationId: string,
  venueIds: string[],
  effectiveFrom: string,
  aplicar: (tx: Prisma.TransactionClient) => Promise<void>,
  ahora: Date = new Date(),
): Promise<EfectoDelCambio> {
  try {
    await prisma.$transaction(
      async tx => {
        const venues = await tx.venue.findMany({
          where: { id: { in: venueIds }, organizationId },
          select: { id: true, timezone: true },
          take: venueIds.length,
        })
        const sedes = venues.map(v => ({ id: v.id, tz: v.timezone || TZ_DEFAULT }))
        const hoy = sedes.map(s => hoyLocal(s.tz, ahora)).reduce((a, b) => (b > a ? b : a), hoyLocal(TZ_DEFAULT, ahora))
        const { contar, sinContar } = await periodosAbiertos(tx, organizationId, effectiveFrom, hoy)
        const antes = await firmas(tx, organizationId, sedes, contar, ahora)
        await aplicar(tx)
        const despues = await firmas(tx, organizationId, sedes, contar, ahora)
        const porPeriodo = contar.map(p => ({ start: p.start, end: p.end, clases: 0 }))
        for (const [id, d] of despues) if (antes.get(id)?.firma !== d.firma) porPeriodo[d.periodo].clases++
        for (const [id, a] of antes) if (!despues.has(id)) porPeriodo[a.periodo].clases++
        throw new FinDeSimulacion({
          clasesQueCambian: porPeriodo.reduce((n, p) => n + p.clases, 0),
          porPeriodo,
          periodosSinContar: sinContar,
        })
      },
      { timeout: 20_000 },
    )
  } catch (e) {
    if (e instanceof FinDeSimulacion) return e.resultado
    throw e
  }
  throw new Error('efectoDelCambio: la simulación no terminó')
}
