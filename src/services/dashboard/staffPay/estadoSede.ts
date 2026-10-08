// src/services/dashboard/staffPay/estadoSede.ts — la ÚNICA definición de «sede activa» y de su estado (fase 3, B13; diseño r3.7(1),
// ruling de la revisión de B12 #3). La usan la pantalla de sedes (`sedes.service.ts`), la vista previa del cierre por sede
// (`cierre.porSede.ts`) y el bloqueo SEDE_ACTIVA_SIN_PLAN (`cierre.alcance.ts`): una sede no puede decir «activa» en una
// pantalla y otra cosa en la de al lado.
import type { Prisma } from '@prisma/client'
import type prisma from '../../../utils/prismaClient'
import { hoyLocal } from './periodos'
import { Ventana, ventanasDeSedes } from './rangos'

type Db = Prisma.TransactionClient | typeof prisma

export type EstadoSede = 'ACTIVA' | 'SIN_ACTIVAR' | 'ACTIVA_SIN_PLAN' | 'SIN_PLAN'

/**
 * El estado de una sede (ruling de B12 #3), PURO:
 * - `ACTIVA_SIN_PLAN` ⇔ ventana ABIERTA (sin `hasta`) y sin plan: exactamente la sede del bloqueo del cierre (va en rojo);
 * - `ACTIVA` ⇔ con plan y una ventana que cubre hoy (también la que termina hoy: hoy todavía entra);
 * - `SIN_ACTIVAR` ⇔ con plan y sin ventana que cubra hoy;
 * - `SIN_PLAN` ⇔ sin plan y sin ventana abierta.
 */
export function estadoDeSede(s: { tienePlan: boolean; abierta: boolean; cubreHoy: boolean }): EstadoSede {
  if (s.abierta && !s.tienePlan) return 'ACTIVA_SIN_PLAN'
  if (s.tienePlan) return s.cubreHoy ? 'ACTIVA' : 'SIN_ACTIVAR'
  return 'SIN_PLAN'
}

/**
 * E6a-fix F10 (QA E6a H5): el estado de una sede para un periodo YA TERMINADO, PURO. Dice si la sede participó EN ESE periodo
 * —alguna de sus ventanas toca `[start, end]`— y no su estado de hoy: participó ⇒ `ACTIVA`; no participó ⇒ `SIN_ACTIVAR` (o
 * `SIN_PLAN`, si hoy tampoco tiene el plan). `ACTIVA_SIN_PLAN` se conserva: es el bloqueo del cierre (también de un periodo
 * viejo) y lo que la pantalla deja desactivar desde ahí. Un periodo en curso usa `estadoDeSede` (el de hoy).
 */
export function estadoEnElPeriodo(hoy: EstadoSede, ventanas: Ventana[], periodo: { start: string; end: string }): EstadoSede {
  if (hoy === 'ACTIVA_SIN_PLAN') return hoy
  if (ventanas.some(w => w.desde <= periodo.end && (w.hasta === null || w.hasta >= periodo.start))) return 'ACTIVA'
  return hoy === 'ACTIVA' ? 'SIN_ACTIVAR' : hoy
}

export interface SituacionDeSede {
  /** Tiene una ventana ABIERTA (sin `hasta`): la que mira el bloqueo SEDE_ACTIVA_SIN_PLAN. A lo más una (el EXCLUDE). */
  abierta: boolean
  /** Alguna ventana cubre `hoy` (civil, en la zona de la sede), también la que termina hoy. */
  cubreHoy: boolean
  /** La ventana que cubre hoy o, si ninguna, la última por inicio (la que la pantalla enseña con su desde/hasta). */
  vigente: Ventana | null
  /** El último día de su ventana CERRADA más reciente (lo que sube el mínimo efectivo de activar), o null. */
  ultimoDiaCerrado: string | null
}

/** Lo que dicen las ventanas de UNA sede el día `hoy` (YYYY-MM-DD en su zona). Pura. */
export function situacionDe(ventanas: Ventana[], hoy: string): SituacionDeSede {
  const porInicio = [...ventanas].sort((x, y) => (x.desde < y.desde ? -1 : x.desde > y.desde ? 1 : 0))
  const deHoy = porInicio.find(w => w.desde <= hoy && (w.hasta === null || w.hasta >= hoy)) ?? null
  const cerradas = porInicio.flatMap(w => (w.hasta !== null ? [w.hasta] : [])).sort()
  return {
    abierta: porInicio.some(w => w.hasta === null),
    cubreHoy: deHoy !== null,
    vigente: deHoy ?? porInicio[porInicio.length - 1] ?? null,
    ultimoDiaCerrado: cerradas.length ? cerradas[cerradas.length - 1] : null,
  }
}

/**
 * La situación de esas sedes hoy, con sus ventanas leídas en UNA consulta y con el tope del barrido (`ventanasDeSedes`: truena,
 * nunca recorta). Con `db` = la foto o la transacción de quien llama. Toda sede pedida sale en el mapa (sin ventanas: todo falso).
 */
export async function situacionDeLasSedes(
  db: Db,
  organizationId: string,
  sedes: Array<{ venueId: string; tz: string }>,
  ahora: Date,
): Promise<Map<string, SituacionDeSede & { ventanas: Ventana[] }>> {
  const ventanas = sedes.length
    ? await ventanasDeSedes(
        db,
        organizationId,
        sedes.map(s => s.venueId),
      )
    : []
  return new Map(
    sedes.map(s => {
      const suyas = ventanas.filter(w => w.venueId === s.venueId)
      return [s.venueId, { ...situacionDe(suyas, hoyLocal(s.tz, ahora)), ventanas: suyas }]
    }),
  )
}
