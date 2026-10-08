// src/services/dashboard/staffPay/participacion.vistaPrevia.ts — qué entra y qué queda fuera, con montos, ANTES de activar
// o desactivar una sede (fase 3, B11; diseño r7.3, r5.4, r4.5).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { ConflictError } from '../../../errors/AppError'
import { sedesConServicePay } from './acceso'
import { AlcanceBarrido, TotalVentas, totalesVentas } from './fuentesVenta'
import { prepararSede, reglasDeSede, SedePreparada } from './participacion'
import { fechaComoDbDate, sumarDias, venuePeriodRange } from './periodos'
import { Ventana, ventanasDeSedes } from './rangos'
import { enUnaFoto } from './foto'
import { zonasEnLaFoto } from './lectura'
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

export type Suma = { n: number; total: Prisma.Decimal }
export type CuentaCruda = { clases: Suma & { pendientes: number }; comisiones: Suma; propinas: Suma }
export const cero = (): Suma => ({ n: 0, total: new Prisma.Decimal(0) })
export const restar = (x: Suma, y: Suma): Suma => ({ n: x.n - y.n, total: x.total.minus(y.total) })
const monto = (x: Suma): Monto => ({ n: x.n, total: x.total.toFixed(2) })
export const aCuenta = (c: CuentaCruda): Cuenta => ({
  clases: { ...monto(c.clases), pendientesDeValoracion: c.clases.pendientes },
  comisiones: monto(c.comisiones),
  propinas: monto(c.propinas),
})

/** Las sumas de ventas de UNA sede, por fuente. */
export function porFuente(filas: TotalVentas[]): { comisiones: Suma; propinas: Suma } {
  const de = (f: 'COMMISSION' | 'TIP') => filas.find(x => x.fuente === f) ?? cero()
  return { comisiones: { n: de('COMMISSION').n, total: de('COMMISSION').total }, propinas: { n: de('TIP').n, total: de('TIP').total } }
}

/**
 * Las clases de UNA sede en los días civiles `[desde, hasta]` con `participacion` ('real' = entran hoy; 'fuera' = las que la
 * ventana real deja fuera), AGREGADAS en la base sobre `valoracionCte` (r5.4: nunca las filas a memoria). Una clase que hoy
 * no se puede valuar no suma $0: va en `pendientes`. El cambio de ventana es contiguo, así que el rango de fechas hace la
 * simulación. Cuenta como el recibo (revisión de B11 #1): sólo las OK CON monto; la vista previa del cierre (B12) la reusa.
 */
export async function clasesDe(
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
    SELECT COUNT(*) FILTER (WHERE estado = 'OK' AND monto IS NOT NULL)::int AS n,
           SUM(monto) FILTER (WHERE estado = 'OK' AND monto IS NOT NULL) AS total,
           COUNT(*) FILTER (WHERE estado = 'EXCEPCION')::int AS pendientes
    FROM valoradas`
  return { n: r.n, total: new Prisma.Decimal(r.total ?? 0), pendientes: r.pendientes }
}

/** Una sede que se simula activar desde `fecha`, con sus ventanas reales. */
export interface SedeQueSeActiva {
  venueId: string
  tz: string
  fecha: string
  reales: Ventana[]
}

/**
 * Lo que ENTRA al activar cada sede desde su `fecha` (r5.4, r7.3): simuladas = reales ∪ `[fecha, ∞)`; `entran` = simuladas −
 * reales en ventas (netos, por diferencia de `totalesVentas`) y las clases que hoy quedan fuera en `[fecha, hoy]` (agregadas en
 * la base). Sobre el pseudoperiodo `[mínimo de la organización, hoy]`: sólo lo que todavía no se cierra. La vista previa de
 * activar (B11) y la pantalla de sedes (B13: `fueraEstePeriodo`, desde el mínimo efectivo) usan ESTA función: el mismo número
 * en las dos. Varias sedes con el mismo «hoy» van en UNA suma de ventas por lado. Devuelve también las ventas simuladas (la
 * vista previa sigue con `quedanFuera`).
 */
export async function alActivar(
  tx: Db,
  base: { organizationId: string; startDate: string; minimo: string; hoy: string; ahora: Date },
  sedes: SedeQueSeActiva[],
): Promise<Map<string, { entran: CuentaCruda; simuladas: { comisiones: Suma; propinas: Suma } }>> {
  const out = new Map<string, { entran: CuentaCruda; simuladas: { comisiones: Suma; propinas: Suma } }>()
  if (!sedes.length) return out
  const a: AlcanceBarrido = {
    organizationId: base.organizationId,
    periodo: { id: null, start: base.minimo, end: base.hoy },
    sedes: sedes.map(s => ({ venueId: s.venueId, tz: s.tz })),
    startDate: base.startDate,
  }
  const reales = sedes.flatMap(s => s.reales)
  const desdeFecha = sedes.map(s => ({ venueId: s.venueId, desde: s.fecha, hasta: null }))
  const real = await totalesVentas(tx, a, { ventanas: reales, soloElPeriodo: true })
  const simuladas = await totalesVentas(tx, a, { ventanas: [...reales, ...desdeFecha], soloElPeriodo: true })
  for (const s of sedes) {
    const r = porFuente(real.filter(x => x.venueId === s.venueId))
    const sim = porFuente(simuladas.filter(x => x.venueId === s.venueId))
    const donde = { organizationId: base.organizationId, venueId: s.venueId, tz: s.tz }
    out.set(s.venueId, {
      entran: {
        clases: await clasesDe(tx, donde, { desde: s.fecha, hasta: base.hoy }, 'fuera', base.ahora),
        comisiones: restar(sim.comisiones, r.comisiones),
        propinas: restar(sim.propinas, r.propinas),
      },
      simuladas: sim,
    })
  }
  return out
}

/** Las ventanas reales de UNA sede, con el mismo tope (y el mismo 409) que el barrido: nunca recorta. */
const ventanasDe = (db: Db, organizationId: string, venueId: string) => ventanasDeSedes(db, organizationId, [venueId])

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
  preparada: SedePreparada,
  input: { sedeId: string; accion: 'activar' | 'desactivar'; fecha?: string; ahora?: Date },
): Promise<VistaPreviaParticipacion> {
  // B14-fix F2 (Codex participación r1 #2): la sede se preparó ANTES de la foto; si un traslado la sacó de la organización
  // entretanto, lo que vende ahora es de OTRA: «sede ajena» (409), nunca sus montos. La zona, también de la foto.
  const zona = (await zonasEnLaFoto(tx, preparada.organizationId, [input.sedeId])).get(input.sedeId)
  if (!zona) throw new ConflictError(`La sede ${preparada.nombre} ya no pertenece a esta organización`, 'SEDE_EN_OTRA_ORGANIZACION')
  const sede = { ...preparada, tz: zona }
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
  if (input.accion === 'activar') {
    const datos = { organizationId: sede.organizationId, startDate: regla.startDate, minimo: regla.minimo, hoy, ahora }
    const al = (await alActivar(tx, datos, [{ venueId: input.sedeId, tz: sede.tz, fecha, reales }])).get(input.sedeId)
    if (!al) throw new Error('STAFF_PAY_SIN_VISTA_PREVIA')
    const { entran, simuladas } = al
    const completa = await ventas([{ venueId: input.sedeId, desde: regla.startDate, hasta: null }])
    return {
      accion: 'activar',
      ...base,
      entran: aCuenta(entran),
      quedanFuera: aCuenta({
        clases: await clasesDe(tx, s, { desde: regla.minimo, hasta: sumarDias(fecha, -1) }, 'fuera', ahora),
        comisiones: restar(completa.comisiones, simuladas.comisiones),
        propinas: restar(completa.propinas, simuladas.propinas),
      }),
    }
  }
  const real = await ventas(reales)
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
