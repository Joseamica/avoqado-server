// src/services/dashboard/staffPay/participacion.vistaPrevia.ts — qué entra y qué queda fuera, con montos, ANTES de activar
// o desactivar una sede (fase 3, B11; diseño r7.3, r5.4, r4.5).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError } from '../../../errors/AppError'
import { sedesConServicePay } from './acceso'
import { AlcanceBarrido, TotalVentas, totalesVentas } from './fuentesVenta'
import { prepararSede, reglasDeSede, SedePreparada } from './participacion'
import { dbDateComoFecha, fechaComoDbDate, sumarDias, venuePeriodRange } from './periodos'
import { TOPE_VENTANAS, Ventana } from './rangos'
import { enUnaFoto } from './recibos.service'
import { Participacion, valoracionCte } from './valoracion'

type Db = Prisma.TransactionClient | typeof prisma

/** `total` NETO (devoluciones con su signo), en pesos con dos decimales. */
export type Monto = { n: number; total: string }
export type Cuenta = { clases: Monto & { pendientesDeValoracion: number }; comisiones: Monto; propinas: Monto }
interface Base {
  /** La fecha elegida (o «hoy» resuelto en la zona de la sede): la que se confirma después. */
  fecha: string
  /** Lo más atrás que se puede elegir para ESTA sede (el mínimo efectivo) y lo más adelante (hoy). */
  minimo: string
  maximo: string
  zona: string
}
export type VistaPreviaParticipacion =
  | (Base & { accion: 'activar'; entran: Cuenta; quedanFuera: Cuenta })
  | (Base & { accion: 'desactivar'; dejanDeEntrar: Cuenta; permanecen: Cuenta })

type Suma = { n: number; total: Prisma.Decimal }
type CuentaCruda = { clases: Suma & { pendientes: number }; comisiones: Suma; propinas: Suma }
const cero = (): Suma => ({ n: 0, total: new Prisma.Decimal(0) })
const restar = (x: Suma, y: Suma): Suma => ({ n: x.n - y.n, total: x.total.minus(y.total) })
const monto = (x: Suma): Monto => ({ n: x.n, total: x.total.toFixed(2) })
const aCuenta = (c: CuentaCruda): Cuenta => ({
  clases: { ...monto(c.clases), pendientesDeValoracion: c.clases.pendientes },
  comisiones: monto(c.comisiones),
  propinas: monto(c.propinas),
})

/** Las sumas de ventas de UNA sede, por fuente. */
function porFuente(filas: TotalVentas[]): { comisiones: Suma; propinas: Suma } {
  const de = (f: 'COMMISSION' | 'TIP') => filas.find(x => x.fuente === f) ?? cero()
  return { comisiones: { n: de('COMMISSION').n, total: de('COMMISSION').total }, propinas: { n: de('TIP').n, total: de('TIP').total } }
}

/**
 * Las clases de UNA sede en los días civiles `[desde, hasta]` con `participacion` ('real' = entran hoy; 'fuera' = las que la
 * ventana real deja fuera), AGREGADAS en la base sobre `valoracionCte` (r5.4: nunca las filas a memoria). Una clase que hoy
 * no se puede valuar no suma $0: va en `pendientes`. El cambio de ventana es contiguo, así que el rango de fechas hace la
 * simulación.
 */
async function clasesDe(
  db: Db,
  s: { organizationId: string; venueId: string; tz: string },
  dias: { desde: string; hasta: string },
  participacion: Participacion,
  ahora: Date,
): Promise<Suma & { pendientes: number }> {
  if (dias.desde > dias.hasta) return { ...cero(), pendientes: 0 }
  const { from, to } = venuePeriodRange({ start: dias.desde, end: dias.hasta }, s.tz)
  const f = { ...s, desde: from, hasta: to, ahora, participacion }
  const [r] = await db.$queryRaw<Array<{ n: number; total: Prisma.Decimal | null; pendientes: number }>>`
    ${valoracionCte(f)}
    SELECT COUNT(*) FILTER (WHERE estado = 'OK')::int AS n, SUM(monto) FILTER (WHERE estado = 'OK') AS total,
           COUNT(*) FILTER (WHERE estado = 'EXCEPCION')::int AS pendientes
    FROM valoradas`
  return { n: r.n, total: new Prisma.Decimal(r.total ?? 0), pendientes: r.pendientes }
}

/** Las ventanas reales de UNA sede, con el mismo tope que el barrido (nunca recorta). */
async function ventanasDe(db: Db, organizationId: string, venueId: string): Promise<Ventana[]> {
  const filas = await db.staffPayVenueWindow.findMany({
    where: { organizationId, venueId },
    select: { venueId: true, desde: true, hasta: true },
    orderBy: { desde: 'asc' },
    take: TOPE_VENTANAS + 1,
  })
  if (filas.length > TOPE_VENTANAS) throw new Error('STAFF_PAY_DEMASIADAS_VENTANAS')
  return filas.map(w => ({ venueId: w.venueId, desde: dbDateComoFecha(w.desde), hasta: w.hasta ? dbDateComoFecha(w.hasta) : null }))
}

/**
 * La vista previa CON MONTOS de activar o desactivar UNA sede (diseño r7.3, r5.4), en UNA foto (`enUnaFoto`), sobre el
 * pseudoperiodo `[mínimo de la organización, hoy]` (lo que todavía no se cierra). Las MISMAS reglas de fechas que la
 * escritura (`reglasDeSede`): una fecha que la escritura rechazaría, aquí también es 400.
 * - Activar desde `fecha`: simuladas = reales ∪ `[fecha, ∞)`; `entran` = simuladas − reales; `quedanFuera` = completa −
 *   simuladas (completa = `[inicio, ∞)`).
 * - Desactivar hasta `fecha`: simuladas = reales con la abierta cortada en `fecha` (o sin ella, si así se borra);
 *   `dejanDeEntrar` = reales − simuladas; `permanecen` = simuladas.
 * Ventas por DIFERENCIA de netos (`totalesVentas`), nunca por positivos. Exige ver pago al personal en la sede; activar,
 * además, el plan en la sede (409 SEDE_SIN_PLAN, lo mismo que rechazaría confirmar). Desactivar no pide plan (r4.7).
 */
export async function vistaPreviaParticipacion(input: {
  userId: string
  venueId: string
  sedeId: string
  accion: 'activar' | 'desactivar'
  fecha?: string
  ahora?: Date
}): Promise<VistaPreviaParticipacion> {
  if (input.fecha !== undefined) fechaComoDbDate(input.fecha) // la forma, antes de comparar como texto
  // Cliente global ANTES de la foto (Codex R4-Nuevo 1): la sede, el permiso y el plan.
  const sede = await prepararSede(input, 'staffpay:read')
  if (input.accion === 'activar' && !(await sedesConServicePay(sede.organizationId)).includes(input.sedeId)) {
    throw new ConflictError(`La sede ${sede.nombre} no tiene Pago al personal en su plan: contrátalo para activarla`, 'SEDE_SIN_PLAN')
  }
  return enUnaFoto(tx => calcular(tx, sede, input))
}

async function calcular(
  tx: Db,
  sede: SedePreparada,
  input: { sedeId: string; accion: 'activar' | 'desactivar'; fecha?: string; ahora?: Date },
): Promise<VistaPreviaParticipacion> {
  const ahora = input.ahora ?? new Date()
  const hoy = reglasDeSede.hoyBajoCandado(sede.tz, ahora, undefined)
  const s = { organizationId: sede.organizationId, venueId: input.sedeId, tz: sede.tz }
  const regla =
    input.accion === 'activar'
      ? { ...(await reglasDeSede.activar(tx, sede.organizationId, input.sedeId, sede.nombre, hoy)), borra: '' }
      : await reglasDeSede.desactivar(tx, sede.organizationId, input.sedeId, sede.nombre, hoy)
  const fecha = input.fecha ?? hoy
  reglasDeSede.validarFecha(fecha, regla.rango, regla.motivo, regla.borra)
  const reales = await ventanasDe(tx, sede.organizationId, input.sedeId)
  const a: AlcanceBarrido = {
    organizationId: sede.organizationId,
    periodo: { id: null, start: regla.minimo, end: hoy },
    sedes: [{ venueId: input.sedeId, tz: sede.tz }],
    startDate: regla.startDate,
  }
  const ventas = async (ventanas: Ventana[]) => porFuente(await totalesVentas(tx, a, { ventanas, soloElPeriodo: true }))
  const base = { fecha, minimo: regla.rango.desde, maximo: hoy, zona: sede.tz }
  const real = await ventas(reales)
  if (input.accion === 'activar') {
    const simuladas = await ventas([...reales, { venueId: input.sedeId, desde: fecha, hasta: null }])
    const completa = await ventas([{ venueId: input.sedeId, desde: regla.startDate, hasta: null }])
    return {
      accion: 'activar',
      ...base,
      entran: aCuenta({
        clases: await clasesDe(tx, s, { desde: fecha, hasta: hoy }, 'fuera', ahora),
        comisiones: restar(simuladas.comisiones, real.comisiones),
        propinas: restar(simuladas.propinas, real.propinas),
      }),
      quedanFuera: aCuenta({
        clases: await clasesDe(tx, s, { desde: regla.minimo, hasta: sumarDias(fecha, -1) }, 'fuera', ahora),
        comisiones: restar(completa.comisiones, simuladas.comisiones),
        propinas: restar(completa.propinas, simuladas.propinas),
      }),
    }
  }
  // La abierta, cortada en `fecha`; si `fecha` es el día antes de su inicio, la activación se borra.
  const cortadas = reales.flatMap(w => (w.hasta !== null ? [w] : fecha < w.desde ? [] : [{ ...w, hasta: fecha }]))
  const simuladas = await ventas(cortadas)
  return {
    accion: 'desactivar',
    ...base,
    dejanDeEntrar: aCuenta({
      clases: await clasesDe(tx, s, { desde: sumarDias(fecha, 1), hasta: hoy }, 'real', ahora),
      comisiones: restar(real.comisiones, simuladas.comisiones),
      propinas: restar(real.propinas, simuladas.propinas),
    }),
    permanecen: aCuenta({
      clases: await clasesDe(tx, s, { desde: regla.minimo, hasta: fecha }, 'real', ahora),
      comisiones: simuladas.comisiones,
      propinas: simuladas.propinas,
    }),
  }
}
