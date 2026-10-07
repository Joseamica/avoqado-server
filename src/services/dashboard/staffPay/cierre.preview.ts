// src/services/dashboard/staffPay/cierre.preview.ts — la vista previa del cierre, en UNA foto (fases 2-3; B12 la saca de
// `cierre.service.ts` y le suma las sedes y las devoluciones pendientes).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { sedesConServicePay, tienePermisoEn } from './acceso'
import { periodoQueContieneFecha } from './periodosGuardados'
import { sedesConVentana } from './participacion'
import { enUnaFoto } from './foto'
import { Alcance, alcanceDelPreview, alcanceDeVentas, Bloqueo, bloqueosDe } from './cierre.alcance'
import {
  ajustesDelPeriodo,
  comisionesPorRevisar,
  idsHuerfanas,
  LOTE_CIERRE,
  organizacionDe,
  recibosGuardados,
  recorrer,
  sinDuenoDe,
  TIMEOUT_CIERRE_MS,
} from './cierre.recorrido'
import { porSedeDelCierre, SedeDelCierre } from './cierre.porSede'
import { DevolucionesPendientes, devolucionesPendientes, sinPendientes } from './devolucionesPendientes'

type Db = Prisma.TransactionClient | typeof prisma
/** B13 (revisión de B12 #4): una fábrica, nunca un objeto de módulo compartido entre respuestas. */
const sinPendientesDelCierre = (): PreviewCierre['pendientes'] => {
  const { n, total, porDestino } = sinPendientes()
  return { n, total, porDestino }
}

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
  /**
   * B12 (r3.7(3), r4.5, r5.4): cada sede del alcance —en el orden de `periodo.venueIds`— con su estado, lo que entra al cierre,
   * lo que la participación deja fuera y sus devoluciones pendientes. Vacío en uno cerrado o sin permiso. Fuera de la huella.
   */
  porSede: SedeDelCierre[]
  /** B12 (r6.2): devoluciones pendientes de las sedes del alcance que NO entran como línea en este cierre. Fuera de la huella. */
  pendientes: Pick<DevolucionesPendientes, 'n' | 'total' | 'porDestino'>
}

/**
 * La vista previa del cierre: el MISMO recorrido que el cierre (misma huella), sin escribir. B12 (r4.5): corre ENTERA en UNA
 * foto (`enUnaFoto`, REPEATABLE READ de sólo lectura): el periodo y su alcance, los bloqueos, el recorrido, las sedes y las
 * pendientes salen del mismo instante. Lo que usa el cliente global —módulos, sedes con ventana y permisos de TODAS las
 * candidatas— se resuelve ANTES y entra como datos (Codex R4-Nuevo 1). `trasPreparar` y `entreLecturas`: SÓLO pruebas
 * (la foto entre la preparación y la instantánea, y entre dos lecturas internas).
 */
export async function previewCierre(input: {
  userId: string
  venueId: string
  fecha: string
  ahora?: Date
  tamLote?: number
  trasPreparar?: () => Promise<void>
  entreLecturas?: () => Promise<void>
}): Promise<PreviewCierre> {
  const ahora = input.ahora ?? new Date()
  const organizationId = await organizacionDe(input.venueId)
  const activas = await sedesConServicePay(organizationId)
  const conVentana = await sedesConVentana(prisma, organizationId)
  const filaAntes = await periodoQueContieneFecha(prisma, organizationId, input.fecha)
  // Candidatas: el alcance del periodo como está ahora ∪ con el plan ∪ con ventana. Una sede que entra al alcance entre esto y
  // la foto no tiene permiso resuelto y se niega (conservador; la siguiente vista previa ya la incluye).
  const permitidas = new Set<string>()
  for (const v of [...new Set([...(filaAntes?.venueIds ?? []), ...activas, ...conVentana])].sort())
    if (await tienePermisoEn(input.userId, v, 'staffpay:close')) permitidas.add(v)
  await input.trasPreparar?.()
  return enUnaFoto(
    async tx => {
      const a = await alcanceDelPreview(tx, organizationId, input.fecha, { activas, conVentana })
      // Permiso ANTES de calcular nada (Codex R1-8): quien no puede cerrar todo el alcance no recibe ni un número de él.
      if (a.venueIds.some(v => !permitidas.has(v))) return sinPermiso(a)
      if (a.estado === 'CLOSED' && a.periodId) return previewCerrado(tx, { ...a, periodId: a.periodId })
      const bloqueos = await bloqueosDe(tx, a, ahora, activas)
      const ajustes = await ajustesDelPeriodo(tx, a.organizationId, a.periodId)
      const huerfanas = await idsHuerfanas(tx, a, ahora)
      const ventas = await alcanceDeVentas(tx, a)
      const r = await recorrer(tx, a, ahora, { tamLote: input.tamLote ?? LOTE_CIERRE, ajustes, huerfanas, ventas })
      await input.entreLecturas?.()
      const sinDueno = await sinDuenoDe(tx, ventas)
      // r6.2: las del alcance que NO entran como línea en este cierre (con `excluirPeriodo` = P).
      const pend = await devolucionesPendientes(tx, { organizationId, sedes: a.venueIds, excluirPeriodo: a.periodo })
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
        comisionesPorRevisar: await comisionesPorRevisar(tx, ventas),
        total: r.totalServicios.plus(r.totalVentas).plus(r.totalAjustes).toFixed(2),
        huerfanas: huerfanas.length,
        huella: r.huella,
        sedesConDinero: a.venueIds.filter(v => r.sedesConDinero.has(v)),
        porSede: await porSedeDelCierre(tx, a, { ventas, entra: r.porSede, activas, ahora, pendientes: pend }),
        pendientes: { n: pend.n, total: pend.total, porDestino: pend.porDestino },
      }
    },
    // B13 (revisión de B12 #1): el timeout de su cierre (corre el mismo recorrido); si vence, 409 LECTURA_VENCIDA.
    { planPersonalizado: true, timeoutMs: TIMEOUT_CIERRE_MS },
  )
}

/** Sin `staffpay:close` en todo el alcance: ni un número (Codex R1-8). */
const sinPermiso = (a: Alcance): PreviewCierre => ({
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
  porSede: [],
  pendientes: sinPendientesDelCierre(),
})

/**
 * Preview de un periodo CERRADO: lo guardado, nunca el recorrido en vivo (que sólo vería lo que llegó tarde y
 * mostraría otro total). Clases, comisiones, propinas y reversos salen de lo congelado, por concepto × fuente (desde la
 * fase 3 un SERVICE ya no es siempre una clase); `excluidas` no se reconstruye (0): el detalle se lee en el recibo.
 */
async function previewCerrado(db: Db, a: Alcance & { periodId: string }): Promise<PreviewCierre> {
  const [g, porTipo, porSede] = await Promise.all([
    recibosGuardados(db, a.organizationId, a.periodId),
    // A lo más una fila por concepto × fuente.
    db.serviceEarning.groupBy({
      by: ['concept', 'sourceType'],
      where: { organizationId: a.organizationId, periodId: a.periodId },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    // Una fila por sede (GROUP BY): acotado por el número de sedes del alcance.
    db.serviceEarning.groupBy({ by: ['venueId'], where: { organizationId: a.organizationId, periodId: a.periodId } }),
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
    porSede: [],
    pendientes: sinPendientesDelCierre(),
  }
}
