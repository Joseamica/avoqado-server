// src/services/dashboard/staffPay/cierre.porSede.ts — la vista previa del cierre POR SEDE: qué entra, qué queda fuera y qué
// devoluciones pendientes tiene cada una (fase 3, B12; diseño r3.7(3), r4.5, r5.4).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { totalesVentas } from './fuentesVenta'
import { Alcance, Barrido } from './cierre.alcance'
import { rangosCompletos } from './rangos'
import type { DevolucionesPendientes } from './devolucionesPendientes'
import { aCuenta, cero, clasesDe, Cuenta, CuentaCruda, Monto, porFuente, restar } from './participacion.vistaPrevia'
import { estadoDeSede, EstadoSede, situacionDeLasSedes } from './estadoSede'

type Db = Prisma.TransactionClient | typeof prisma

export type { EstadoSede } from './estadoSede'
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
  // B13 (revisión de B12 #3): el estado con la MISMA definición que la pantalla de sedes y el bloqueo (`estadoSede.ts`), con
  // las ventanas de la foto y el «hoy» de cada sede en `ahora`.
  const situacion = await situacionDeLasSedes(db, a.organizationId, a.sedes, o.ahora)
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
    const st = situacion.get(s.venueId)
    const p = pendientes.get(s.venueId) ?? cero()
    out.push({
      venueId: s.venueId,
      nombre: s.nombre,
      estado: estadoDeSede({ tienePlan, abierta: st?.abierta ?? false, cubreHoy: st?.cubreHoy ?? false }),
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
