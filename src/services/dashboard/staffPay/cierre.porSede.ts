// src/services/dashboard/staffPay/cierre.porSede.ts — la vista previa del cierre POR SEDE: qué entra, qué queda fuera y qué
// devoluciones pendientes tiene cada una (fase 3, B12; diseño r3.7(3), r4.5, r5.4).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { totalesVentas } from './fuentesVenta'
import { Alcance, Barrido } from './cierre.alcance'
import { rangosCompletos } from './rangos'
import type { DevolucionesPendientes } from './devolucionesPendientes'
import { aCuenta, cero, clasesDe, Cuenta, CuentaCruda, Monto, porFuente, restar } from './participacion.vistaPrevia'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Como r3.7(1), evaluado para ESTE cierre con su foto y el plan resuelto antes: «activa» = tiene su ventana abierta (sin
 * `hasta`), la misma que mira el bloqueo. ACTIVA_SIN_PLAN es exactamente la sede del bloqueo `SEDE_ACTIVA_SIN_PLAN`.
 */
export type EstadoSede = 'ACTIVA' | 'SIN_ACTIVAR' | 'ACTIVA_SIN_PLAN' | 'SIN_PLAN'
export interface SedeDelCierre {
  venueId: string
  nombre: string
  estado: EstadoSede
  /** Lo que el recorrido pone en el cierre (clases, comisiones —con sus anulaciones— y propinas), neto. */
  entra: Cuenta
  /** completa − reales (completa = `[startDate, ∞)`), neto: lo que la participación deja fuera de ESTE cierre. */
  fuera: Cuenta
  /** Sus devoluciones pendientes (las que NO entran como línea en este cierre). */
  pendientes: Monto
}

/**
 * `porSede` de la vista previa (r3.7(3)), en la MISMA foto que el recorrido (`db` es su `tx`). Ventas por DIFERENCIA de netos
 * (`totalesVentas` con los rangos reales del recorrido contra los completos: una devolución sale con su original, +$60/−$60 ⇒
 * $0); clases con el agregado `'fuera'` sobre P (una que no se puede valuar va en `pendientesDeValoracion`, nunca suma $0).
 * Fuera de la huella, como `propinasSinDueno`.
 */
export async function porSedeDelCierre(
  db: Db,
  a: Alcance,
  o: { ventas: Barrido | null; entra: Map<string, CuentaCruda>; activas: string[]; ahora: Date; pendientes: DevolucionesPendientes },
): Promise<SedeDelCierre[]> {
  if (!a.sedes.length) return []
  // A lo más una ventana abierta por sede (el EXCLUDE no deja dos encimadas): acotado por el alcance.
  const abiertas = new Set(
    (
      await db.staffPayVenueWindow.findMany({
        where: { organizationId: a.organizationId, hasta: null, venueId: { in: a.venueIds } },
        select: { venueId: true },
        orderBy: { venueId: 'asc' },
        take: a.venueIds.length,
      })
    ).map(w => w.venueId),
  )
  const reales = o.ventas ? await totalesVentas(db, o.ventas.a, { rangos: o.ventas.r }) : []
  const completa = o.ventas ? await totalesVentas(db, o.ventas.a, { rangos: rangosCompletos(o.ventas.r) }) : []
  const pendientes = new Map<string, { n: number; total: Prisma.Decimal }>()
  for (const d of o.pendientes.porDestino) {
    for (const x of d.porSede) {
      const p = pendientes.get(x.venueId) ?? cero()
      pendientes.set(x.venueId, { n: p.n + x.n, total: p.total.plus(x.total) })
    }
  }
  const vacia = (): CuentaCruda => ({ clases: { ...cero(), pendientes: 0 }, comisiones: cero(), propinas: cero() })
  const out: SedeDelCierre[] = []
  for (const s of a.sedes) {
    const real = porFuente(reales.filter(x => x.venueId === s.venueId))
    const comp = porFuente(completa.filter(x => x.venueId === s.venueId))
    const tienePlan = o.activas.includes(s.venueId)
    const activa = abiertas.has(s.venueId)
    const p = pendientes.get(s.venueId) ?? cero()
    out.push({
      venueId: s.venueId,
      nombre: s.nombre,
      estado: activa ? (tienePlan ? 'ACTIVA' : 'ACTIVA_SIN_PLAN') : tienePlan ? 'SIN_ACTIVAR' : 'SIN_PLAN',
      entra: aCuenta(o.entra.get(s.venueId) ?? vacia()),
      fuera: aCuenta({
        clases: await clasesDe(
          db,
          { organizationId: a.organizationId, venueId: s.venueId, tz: s.tz },
          { desde: a.periodo.start, hasta: a.periodo.end },
          'fuera',
          o.ahora,
        ),
        comisiones: restar(comp.comisiones, real.comisiones),
        propinas: restar(comp.propinas, real.propinas),
      }),
      pendientes: { n: p.n, total: p.total.toFixed(2) },
    })
  }
  return out
}
