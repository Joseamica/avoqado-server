/**
 * Fase 1 del «turno de caja del negocio» — reatribución de cobros históricos, A MANO.
 *
 *   npx tsx scripts/reatribuir-cobros-al-turno.ts --venue <venueId> --desde 2026-09-01   # simulación
 *   npx tsx scripts/reatribuir-cobros-al-turno.ts --venue <venueId> --desde 2026-09-01 \
 *     --cerrar-sin-conteo --apply --confirm-host <host de DATABASE_URL>
 *
 * ## Qué repara
 *
 * Hasta el 2-sep-2026 cada cobro se ataba «al turno abierto de QUIEN cobra». El selector
 * «Vendedor» de la pantalla de Cobrar cambia ese `staffId` en cada cobro, así que quien nunca
 * abrió turno cobraba FUERA de todo turno: Testarudo, 1-sep-2026, 78 de 92 cobros ($10,337 de
 * $12,002) con `shiftId = null`, y la pantalla «Turnos» del dueño decía $1,772. La causa ya está
 * arreglada hacia adelante (`turnoAbiertoDelNegocio`); esto repara lo que quedó atrás.
 *
 * ## La regla, decidida por el founder el 2-sep-2026: UN TURNO POR DÍA
 *
 * Cada cobro COMPLETED cae en el turno del DÍA DEL NEGOCIO en que ocurrió (zona horaria del
 * venue, `Venue.timezone`). Si ese día ya tiene un turno, se usa; si no, se crea uno con las
 * horas DERIVADAS de los datos (apertura de la caja física o primer cobro del día) y se dice
 * de dónde salió cada número. Nada de este archivo sabe qué venue es: las fechas, el venue y
 * la política de cierre entran por bandera.
 *
 * ## Lo que NUNCA toca
 *
 * 🔴 Un turno cerrado CON conteo (`cashDeclared IS NOT NULL`) es un arqueo firmado por una
 * persona: no se reescribe ni se le quitan cobros. Sus cobros se listan aparte, «en turnos ya
 * contados (no se tocan)». Tampoco se tocan `Order.shiftId` ni ningún importe: reatribuir sólo
 * cambia DÓNDE cae un cobro, no cuánto vale — por eso es reversible con los ids que quedan en
 * la bitácora.
 *
 * ## Cómo se recalculan los totales del turno
 *
 * Con `aggregateShiftPayments`, la MISMA función que usa el cierre real
 * (`src/services/tpv/shift.tpv.service.ts`). Si este script tuviera su propia suma, un turno
 * reparado y un turno cerrado dirían cifras distintas del mismo dinero — que es exactamente
 * cómo nacieron las tres definiciones de «efectivo esperado» que este repo ya pagó una vez.
 *
 * ⚠️ `totalOrders` se escribe como el número de ÓRDENES DISTINTAS entre los cobros del turno.
 * El cierre real escribe ahí `orderItems.length` (renglones, no órdenes): un defecto previo que
 * esta tarea no arregla para no cambiar la regla del cierre. Si esa misma noche alguien cierra
 * el turno desde la PAX, el cierre pisará este número con el suyo.
 *
 * ## Escribir exige DOS llaves
 *
 * `--apply` **y** `--confirm-host <host exacto>`. Es la defensa contra el error que de verdad
 * pasa: un `DATABASE_URL` heredado del `.env` —o exportado en otra pestaña— apuntando a una
 * base que no era. `import 'dotenv/config'` NO pisa una variable que ya viene del entorno, así
 * que la PRIMERA línea que se imprime es a qué base se conectó, antes de leer nada.
 *
 * 🔴 A propósito NO importa `scripts/_solo-base-local.ts`: ese cortafuegos rechaza toda base que
 * no sea local, y el trabajo de este script incluye producción. Su candado es el host.
 *
 * La simulación es de sólo lectura: sin `--apply` la función que escribe ni siquiera se llama.
 *
 * ## Bitácora
 *
 * Por turno tocado: `SHIFT_PAYMENTS_REATTRIBUTED` (con `movimientos: [{paymentId, deTurnoId}]`,
 * que es lo que hace la operación reversible), `SHIFT_CREATED_BY_REATTRIBUTION` si se creó, y
 * `SHIFT_CLOSED_WITHOUT_COUNT` con el motivo. Se escriben con `logAction` DESPUÉS del commit —
 * `logAction` usa el cliente global de Prisma, no el `tx`, y nunca lanza. Consecuencia aceptada
 * y declarada: si el proceso muere entre el commit y la bitácora, la reparación queda sin su
 * renglón de auditoría (el estado sí queda bien, y volver a correr la simulación lo enseña).
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import { endOfDay as finDelDiaLocal, startOfDay as inicioDelDiaLocal } from 'date-fns'
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz'
import { logAction } from '../src/services/dashboard/activity-log.service'
import { aggregateShiftPayments, type ShiftPaymentForTotals } from '../src/services/tpv/shift.tpv.service'
import prisma from '../src/utils/prismaClient'

type Decimal = Prisma.Decimal
const D = (v: Prisma.Decimal.Value | null | undefined): Decimal => new Prisma.Decimal(v ?? 0)
const pesos = (v: Decimal | number | string): string => `$${new Prisma.Decimal(v).toFixed(2)}`

const RE_FECHA_CIVIL = /^\d{4}-\d{2}-\d{2}$/

/**
 * Rechazo de seguridad (host equivocado, bandera inválida, la realidad no cuadra con lo que el
 * operador espera). El motivo se imprime donde se detecta y esto sólo lleva el código de salida
 * hasta la cadena final.
 *
 * 🔴 Por qué no un `process.exit(2)` en el sitio: un exit seco NO drena la salida, y hacia un
 * pipe (`2>&1 | tee`) `process.stderr` es asíncrono — se perdería justo el renglón que dice qué
 * hay que corregir. Saliendo por la cadena de abajo, todo rechazo pasa por el mismo drenado que
 * el camino bueno.
 */
class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

function detener(...lineas: string[]): never {
  console.error('🔴 No se escribió NADA.')
  for (const l of lineas) console.error(l)
  throw new Rechazo(2)
}

function leerValor(bandera: string): string | undefined {
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Host de la base a la que ESTA corrida se va a conectar. Nunca se imprime la cadena completa. */
function hostDeLaBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) detener('Falta DATABASE_URL: no hay base a la que conectarse.')
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    detener('DATABASE_URL no es una URL válida (su valor no se imprime).')
  }
  // 🔴 Un DSN por socket unix (`postgres:///base`) deja el host VACÍO, y entonces `--confirm-host ""`
  // satisface la comparación: el candado se abriría solo. La comprobación va FUERA del `try` a
  // propósito — dentro, su `throw` caería en el `catch` de arriba y se leería «no es una URL
  // válida», que es mentira.
  if (!host) detener('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
  return host
}

function leerFechaCivil(bandera: string, obligatoria: boolean): string | undefined {
  const crudo = leerValor(bandera)
  if (crudo === undefined) {
    if (obligatoria) detener(`Falta ${bandera} <YYYY-MM-DD>: un script de dinero no elige solo su ventana.`)
    return undefined
  }
  if (!RE_FECHA_CIVIL.test(crudo)) detener(`${bandera} espera una fecha YYYY-MM-DD (recibí «${crudo}»).`)
  return crudo
}

// ─────────────────────────── Fechas: día del NEGOCIO, no del servidor ───────────────────────────
//
// Prisma guarda UTC real en columnas `timestamp without time zone` (ver `src/utils/datetime.ts`),
// así que un día del negocio se convierte con la zona del venue —nunca con un offset fijo ni con
// `setHours`, que daría medianoche UTC—. Se usa `date-fns-tz`, que es lo que ya usa el repo.

/** Un instante seguro dentro del día civil (mediodía local: inmune a cambios de horario). */
const mediodiaDe = (dia: string, zona: string): Date => fromZonedTime(`${dia}T12:00:00`, zona)
const inicioDelDia = (dia: string, zona: string): Date => fromZonedTime(inicioDelDiaLocal(toZonedTime(mediodiaDe(dia, zona), zona)), zona)
const finDelDia = (dia: string, zona: string): Date => fromZonedTime(finDelDiaLocal(toZonedTime(mediodiaDe(dia, zona), zona)), zona)
const diaDelNegocio = (instante: Date, zona: string): string => formatInTimeZone(instante, zona, 'yyyy-MM-dd')
const horaLocal = (instante: Date, zona: string): string => formatInTimeZone(instante, zona, 'HH:mm:ss')
const selloLocal = (instante: Date, zona: string): string => formatInTimeZone(instante, zona, 'yyyy-MM-dd HH:mm:ss')

/** Todos los días civiles de [desde, hasta], en la zona del venue. */
function diasDelRango(desde: string, hasta: string, zona: string): string[] {
  const dias: string[] = []
  for (let cursor = mediodiaDe(desde, zona); ; cursor = new Date(cursor.getTime() + 24 * 3600 * 1000)) {
    const dia = diaDelNegocio(cursor, zona)
    if (dia > hasta) break
    if (dias.at(-1) !== dia) dias.push(dia)
    if (dias.length > 400) detener('La ventana pasa de 400 días. Acótala con --desde/--hasta.')
  }
  return dias
}

// ─────────────────────────────────────── Tipos del plan ────────────────────────────────────────

const SELECT_PAGO = {
  id: true,
  createdAt: true,
  shiftId: true,
  amount: true,
  tipAmount: true,
  method: true,
  fundsFlow: true,
  tenderTypeId: true,
  tenderCountsAsCash: true,
  type: true,
  orderId: true,
  processedById: true,
  order: { select: { orderNumber: true, shiftId: true } },
  processedBy: { select: { firstName: true, lastName: true } },
} as const

type Pago = Prisma.PaymentGetPayload<{ select: typeof SELECT_PAGO }>

interface TurnoLeido {
  id: string
  staffId: string
  startTime: Date
  endTime: Date | null
  status: string
  cashDeclared: Decimal | null
  startingCash: Decimal
  totalSales: Decimal
  totalTips: Decimal
  totalOrders: number
}

interface PlanDeCreacion {
  startTime: Date
  startingCash: Decimal
  staffId: string
  origenInicio: string
  origenFondo: string
  origenStaff: string
}

interface PlanDeCierre {
  endTime: Date
  origenFin: string
  extiende: boolean
}

interface PlanDia {
  dia: string
  turno: TurnoLeido | null
  crear: PlanDeCreacion | null
  cerrar: PlanDeCierre | null
  mover: Pago[]
  yaEnElTurno: Pago[]
}

const nombreDe = (p: Pago): string => [p.processedBy?.firstName, p.processedBy?.lastName].filter(Boolean).join(' ') || '—'
const sumaDe = (pagos: Pago[]): Decimal => pagos.reduce((acc, p) => acc.add(D(p.amount)), D(0))

/** Los ocho totales + el conteo de órdenes, con la MISMA regla del cierre. */
function totalesDe(pagos: ShiftPaymentForTotals[], orderIds: string[]) {
  return { ...aggregateShiftPayments(pagos), totalOrders: new Set(orderIds).size }
}

// ───────────────────────────────────────── Lectura ──────────────────────────────────────────

async function main(): Promise<void> {
  const aplicar = process.argv.includes('--apply')
  const cerrarSinConteo = process.argv.includes('--cerrar-sin-conteo')
  const venueId = leerValor('--venue')
  if (!venueId) detener('Falta --venue <venueId>.')

  const host = hostDeLaBase()
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true, timezone: true } })
  if (!venue) detener(`No existe un venue con id «${venueId}» en esta base (${host}).`)
  const zona = venue.timezone

  const desde = leerFechaCivil('--desde', true) as string
  const hasta = leerFechaCivil('--hasta', false) ?? diaDelNegocio(new Date(), zona)
  if (hasta < desde) detener(`--hasta (${hasta}) es anterior a --desde (${desde}).`)

  console.log(
    `Base: ${host}  venue: ${venue.name} (${venueId})  zona: ${zona}  días: ${desde}…${hasta}  modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN'}` +
      `${cerrarSinConteo ? '  cierre: SIN CONTEO' : ''}\n`,
  )

  if (aplicar) {
    const confirmado = leerValor('--confirm-host')
    if (confirmado !== host) {
      detener(
        `Para escribir en esta base hay que repetir su host exacto:  --confirm-host ${host}`,
        confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`,
      )
    }
  }

  // Guardas que el operador puede exigir para que la corrida NO siga si la realidad se movió
  // desde que se midió (addendum 3 §4). Son opcionales: sin ellas el script no supone nada.
  const turnoEsperado = leerValor('--turno-esperado')
  const staffForzado = leerValor('--staff')

  const dias = diasDelRango(desde, hasta, zona)
  const ventana = { gte: inicioDelDia(desde, zona), lte: finDelDia(hasta, zona) }

  // Turnos que pueden ser «el del día»: los que ARRANCAN dentro de la ventana. Se leen también
  // los que sólo reciben o pierden cobros (por id) más abajo.
  const turnosDelRango = await prisma.shift.findMany({
    where: { venueId, startTime: ventana },
    select: {
      id: true,
      staffId: true,
      startTime: true,
      endTime: true,
      status: true,
      cashDeclared: true,
      startingCash: true,
      totalSales: true,
      totalTips: true,
      totalOrders: true,
    },
    orderBy: { startTime: 'asc' },
  })

  const abiertoDelNegocio = await prisma.shift.findFirst({
    where: { venueId, status: 'OPEN', endTime: null },
    select: { id: true, staffId: true, startTime: true, cashDeclared: true },
    orderBy: { startTime: 'desc' },
  })
  if (turnoEsperado) {
    if (!abiertoDelNegocio) detener(`--turno-esperado ${turnoEsperado}, pero este venue NO tiene ningún turno abierto ahora.`)
    if (abiertoDelNegocio.id !== turnoEsperado) {
      detener(
        `--turno-esperado ${turnoEsperado}, pero el turno abierto del venue es ${abiertoDelNegocio.id}`,
        `(abierto el ${selloLocal(abiertoDelNegocio.startTime, zona)}). La realidad se movió: vuelve a medir antes de aplicar.`,
      )
    }
    if (abiertoDelNegocio.cashDeclared != null) {
      detener(`El turno abierto ${abiertoDelNegocio.id} ya tiene un conteo declarado (${pesos(abiertoDelNegocio.cashDeclared)}): no se reescribe.`)
    }
  }

  const pagosDeLaVentana = await prisma.payment.findMany({
    where: { venueId, status: 'COMPLETED', createdAt: ventana },
    select: SELECT_PAGO,
    orderBy: { createdAt: 'asc' },
  })

  const cajasDelRango = await prisma.cashDrawerSession.findMany({
    where: { venueId, openedAt: ventana },
    select: { id: true, openedAt: true, closedAt: true, startingAmount: true, openedByStaffId: true, deviceName: true, status: true },
    orderBy: { openedAt: 'asc' },
  })

  // ─────────────────────────────────── Se arma el plan ───────────────────────────────────

  const porDia = new Map<string, Pago[]>()
  for (const p of pagosDeLaVentana) {
    const dia = diaDelNegocio(p.createdAt, zona)
    porDia.set(dia, [...(porDia.get(dia) ?? []), p])
  }

  const turnosPorId = new Map<string, TurnoLeido>(turnosDelRango.map(t => [t.id, t]))
  // Turnos de los que un cobro podría SALIR y que no arrancan en la ventana (p. ej. un nocturno
  // del día anterior). Se leen para saber si están contados y para poder recalcularlos.
  const idsAjenos = [...new Set(pagosDeLaVentana.map(p => p.shiftId).filter((id): id is string => !!id && !turnosPorId.has(id)))]
  if (idsAjenos.length > 0) {
    const ajenos = await prisma.shift.findMany({
      where: { id: { in: idsAjenos }, venueId },
      select: {
        id: true,
        staffId: true,
        startTime: true,
        endTime: true,
        status: true,
        cashDeclared: true,
        startingCash: true,
        totalSales: true,
        totalTips: true,
        totalOrders: true,
      },
    })
    for (const t of ajenos) turnosPorId.set(t.id, t)
  }

  const contado = (t: TurnoLeido | undefined): boolean => !!t && t.cashDeclared != null

  const plan: PlanDia[] = []
  const enTurnosContados: Pago[] = []

  for (const dia of dias) {
    const pagosDelDia = porDia.get(dia) ?? []
    const cajasDelDia = cajasDelRango.filter(c => diaDelNegocio(c.openedAt, zona) === dia)
    if (pagosDelDia.length === 0 && cajasDelDia.length === 0) continue

    // El turno del día: el que ARRANCA ese día y no está contado. Cero → se crea. Más de uno →
    // ambiguo, y un script de dinero no adivina.
    const candidatos = turnosDelRango.filter(t => diaDelNegocio(t.startTime, zona) === dia && !contado(t))
    if (candidatos.length > 1) {
      detener(
        `El día ${dia} tiene ${candidatos.length} turnos que arrancan en él y no están contados:`,
        candidatos.map(t => `  · ${t.id}  ${selloLocal(t.startTime, zona)}  ${t.status}`).join('\n'),
        'Un turno por día es la regla; decide cuál a mano antes de correr esto.',
      )
    }
    const turno = candidatos[0] ?? null

    const mover: Pago[] = []
    const yaEnElTurno: Pago[] = []
    for (const p of pagosDelDia) {
      if (turno && p.shiftId === turno.id) {
        yaEnElTurno.push(p)
      } else if (p.shiftId && contado(turnosPorId.get(p.shiftId))) {
        enTurnosContados.push(p)
      } else {
        mover.push(p)
      }
    }
    if (!turno && mover.length === 0) continue

    plan.push({ dia, turno, crear: null, cerrar: null, mover, yaEnElTurno })
  }

  // Creación: sólo para los días que necesitan turno y no lo tienen.
  for (const d of plan) {
    if (d.turno) continue
    const cajasDelDia = cajasDelRango.filter(c => diaDelNegocio(c.openedAt, zona) === d.dia)
    const primeraCaja = cajasDelDia[0]
    const primerCobro = (porDia.get(d.dia) ?? [])[0]

    let startTime: Date
    let origenInicio: string
    if (primeraCaja && (!primerCobro || primeraCaja.openedAt <= primerCobro.createdAt)) {
      startTime = primeraCaja.openedAt
      origenInicio = `apertura de la caja ${primeraCaja.id}${primeraCaja.deviceName ? ` (${primeraCaja.deviceName})` : ''}`
    } else if (primerCobro) {
      startTime = primerCobro.createdAt
      origenInicio = `primer cobro del día (orden ${primerCobro.order.orderNumber})`
    } else {
      detener(`El día ${d.dia} necesita un turno nuevo y no hay ni caja ni cobros de los que derivar su hora de inicio.`)
    }

    const startingCash = D(primeraCaja?.startingAmount ?? 0)
    const origenFondo = primeraCaja ? `fondo de la caja ${primeraCaja.id}` : 'sin caja ese día ⇒ 0.00'

    const staffId = staffForzado ?? abiertoDelNegocio?.staffId ?? primeraCaja?.openedByStaffId
    if (!staffId) {
      detener(
        `El día ${d.dia} necesita un turno nuevo y no hay de dónde derivar a quién pertenece.`,
        'Pásalo con --staff <staffId> (el `Shift.staffId` es obligatorio en el esquema).',
      )
    }
    const origenStaff = staffForzado
      ? '--staff'
      : abiertoDelNegocio?.staffId === staffId
        ? `mismo staff del turno abierto (${abiertoDelNegocio?.id})`
        : `quien abrió la caja ${primeraCaja?.id}`

    const membresia = await prisma.staffVenue.findFirst({ where: { staffId, venueId }, select: { id: true } })
    if (!membresia) detener(`El staff ${staffId} no pertenece a este venue: no se le puede crear un turno.`)

    d.crear = { startTime, startingCash, staffId, origenInicio, origenFondo, origenStaff }
  }

  // Cierre sin conteo, con la hora DERIVADA: el máximo entre el último cobro que quedará en el
  // turno y el cierre de la caja física de ese día — pero sólo si esa caja cerró el MISMO día del
  // negocio. Una caja que cerró de madrugada del día siguiente es el cierre AUTOMÁTICO por
  // inactividad, no el fin de la jornada, y tomarlo alargaría el turno horas de más.
  for (const d of plan) {
    if (!cerrarSinConteo) continue
    // 🔴 El último cobro se pregunta A LA BASE, no a la ventana: un turno existente puede tener
    // cobros ANTERIORES a `--desde` (y por tanto invisibles en el plan). Cerrarlo con un `endTime`
    // previo a uno de sus propios cobros dejaría un turno que dice haber terminado antes de cobrar.
    const idsQueSalen = plan.flatMap(o => o.mover.filter(p => p.shiftId === d.turno?.id).map(p => p.id))
    const enLaBase = d.turno
      ? await prisma.payment.aggregate({
          _max: { createdAt: true },
          where: { shiftId: d.turno.id, status: 'COMPLETED', ...(idsQueSalen.length > 0 ? { id: { notIn: idsQueSalen } } : {}) },
        })
      : null
    const ultimoCobro = [...d.mover.map(p => p.createdAt), ...(enLaBase?._max.createdAt ? [enLaBase._max.createdAt] : [])].reduce<Date | null>(
      (max, fecha) => (max === null || fecha > max ? fecha : max),
      null,
    )
    const cajaCerradaMismoDia = cajasDelRango.find(
      c => diaDelNegocio(c.openedAt, zona) === d.dia && c.closedAt != null && diaDelNegocio(c.closedAt, zona) === d.dia,
    )

    let endTime: Date
    let origenFin: string
    if (cajaCerradaMismoDia?.closedAt && (!ultimoCobro || cajaCerradaMismoDia.closedAt > ultimoCobro)) {
      endTime = cajaCerradaMismoDia.closedAt
      origenFin = `cierre de la caja ${cajaCerradaMismoDia.id} (mismo día)`
    } else if (ultimoCobro) {
      endTime = ultimoCobro
      origenFin = 'último cobro que queda en el turno'
    } else {
      detener(`El día ${d.dia} se pediría cerrar y no hay ni cobros ni cierre de caja de los que derivar su hora de fin.`)
    }

    const inicio = d.crear?.startTime ?? d.turno?.startTime
    if (inicio && endTime < inicio) {
      detener(`El día ${d.dia}: la hora de fin derivada (${selloLocal(endTime, zona)}) es ANTERIOR al inicio (${selloLocal(inicio, zona)}).`)
    }
    const yaCerrado = d.turno?.endTime != null
    if (yaCerrado && d.turno!.endTime! >= endTime) continue // nada que extender
    d.cerrar = { endTime, origenFin, extiende: yaCerrado }
  }

  // 🔴 `openShiftForVenue` exige UN turno abierto por venue. Crear el de un día posterior sin
  // cerrar el anterior dejaría dos abiertos y el POS ya no sabría en cuál cobra.
  const abiertosDelPlan = plan.filter(d => {
    const seCrea = d.crear !== null
    const estabaAbierto = d.turno?.endTime == null
    return (seCrea || estabaAbierto) && d.cerrar === null
  })
  // Un turno abierto del venue que NO esté en el plan (p. ej. de un día fuera de la ventana)
  // también cuenta: crear otro lo dejaría empatado con él.
  const abiertoAjeno = abiertoDelNegocio && !plan.some(d => d.turno?.id === abiertoDelNegocio.id) ? 1 : 0
  const abiertosQueQuedarian = [...abiertosDelPlan.map(d => d.dia), ...(abiertoAjeno ? [`${abiertoDelNegocio!.id} (fuera de la ventana)`] : [])]
  if (abiertosQueQuedarian.length > 1) {
    detener(
      `Esta corrida dejaría ${abiertosQueQuedarian.length} turnos ABIERTOS a la vez (${abiertosQueQuedarian.join(', ')}),`,
      'y el venue sólo puede tener uno. Vuelve a correr con --cerrar-sin-conteo, que cierra cada turno del día',
      'con la hora derivada de sus datos (último cobro, o el cierre de su caja física si fue el mismo día).',
    )
  }

  imprimirPlan({ plan, enTurnosContados, zona, turnosPorId, pagosDeLaVentana })

  if (!aplicar) {
    console.log('Simulación: no se tocó nada.')
    if (plan.some(d => d.mover.length > 0) || plan.some(d => d.crear || d.cerrar)) {
      console.log(
        `Para aplicarlo:  npx tsx scripts/reatribuir-cobros-al-turno.ts --venue ${venueId} --desde ${desde} --hasta ${hasta}` +
          `${cerrarSinConteo ? ' --cerrar-sin-conteo' : ''}${turnoEsperado ? ` --turno-esperado ${turnoEsperado}` : ''} --apply --confirm-host ${host}`,
      )
    }
    return
  }

  await aplicarPlan({ plan, venueId, zona })
}

// ──────────────────────────────────────── Impresión ────────────────────────────────────────

function imprimirPlan(ctx: {
  plan: PlanDia[]
  enTurnosContados: Pago[]
  zona: string
  turnosPorId: Map<string, TurnoLeido>
  pagosDeLaVentana: Pago[]
}): void {
  const { plan, enTurnosContados, zona, turnosPorId } = ctx

  if (plan.length === 0) {
    console.log('No hay nada que reatribuir en esta ventana.\n')
    return
  }

  // Conjunto proyectado de cobros por turno: lo que cada turno tendrá DESPUÉS.
  const proyeccion = proyectar(plan, ctx.pagosDeLaVentana)

  for (const d of plan) {
    const idTurno = d.turno?.id ?? '(NUEVO)'
    console.log(`━━ ${d.dia} — turno ${idTurno} ${d.crear ? '· SE CREA' : d.turno?.endTime == null ? '· abierto' : '· cerrado'}`)
    if (d.crear) {
      console.log(`   inicio  ${selloLocal(d.crear.startTime, zona)}   ← ${d.crear.origenInicio}`)
      console.log(`   fondo   ${pesos(d.crear.startingCash)}   ← ${d.crear.origenFondo}`)
      console.log(`   staff   ${d.crear.staffId}   ← ${d.crear.origenStaff}`)
    }

    const antes = d.turno
      ? { pagos: d.yaEnElTurno.length, monto: sumaDe(d.yaEnElTurno), ventas: d.turno.totalSales, propinas: d.turno.totalTips, ordenes: d.turno.totalOrders }
      : { pagos: 0, monto: D(0), ventas: D(0), propinas: D(0), ordenes: 0 }
    const despues = proyeccion.get(d.turno?.id ?? `NUEVO:${d.dia}`) ?? []
    const t = totalesDe(despues, despues.map(p => p.orderId))

    console.log(`   cobros  ${antes.pagos} → ${despues.length}      ${pesos(antes.monto)} → ${pesos(sumaDe(despues))}`)
    console.log(
      `   totales guardados: ventas ${pesos(antes.ventas)} → ${pesos(t.totalSales)} · propinas ${pesos(antes.propinas)} → ${pesos(t.totalTips)} · órdenes ${antes.ordenes} → ${t.totalOrders}`,
    )
    console.log(
      `                      efectivo ${pesos(t.totalCashPayments)} · tarjeta ${pesos(t.totalCardPayments)} · vales ${pesos(t.totalVoucherPayments)} · otros ${pesos(t.totalOtherPayments)} · propina en efectivo ${pesos(t.totalCashTips)}`,
    )
    if (d.cerrar) {
      console.log(`   ${d.cerrar.extiende ? 'se EXTIENDE el cierre a' : 'se CIERRA sin conteo a las'} ${selloLocal(d.cerrar.endTime, zona)}   ← ${d.cerrar.origenFin}`)
    }

    if (d.mover.length === 0) {
      console.log('   (ningún cobro cambia de turno)\n')
      continue
    }
    const huerfanos = d.mover.filter(p => p.shiftId === null)
    const deOtroTurno = d.mover.filter(p => p.shiftId !== null)
    console.log(`   se mueven ${d.mover.length} cobros (${pesos(sumaDe(d.mover))}): ${huerfanos.length} huérfanos, ${deOtroTurno.length} desde otro turno`)
    for (const p of d.mover) {
      const origen = p.shiftId ? `de ${p.shiftId}` : 'huérfano'
      console.log(
        `     ${horaLocal(p.createdAt, zona)}  folio ${String(p.order.orderNumber).padStart(6)}  ${pesos(D(p.amount)).padStart(11)}  ${String(p.method).padEnd(13)} ${nombreDe(p).padEnd(22)} ${origen}`,
      )
    }
    console.log('')
  }

  // Turnos que PIERDEN cobros y no son el turno de ningún día del plan: también se recalculan.
  const perdedores = [...new Set(plan.flatMap(d => d.mover.map(p => p.shiftId).filter((id): id is string => !!id)))].filter(
    id => !plan.some(d => d.turno?.id === id),
  )
  for (const id of perdedores) {
    const t = turnosPorId.get(id)
    const despues = proyeccion.get(id) ?? []
    const nuevos = totalesDe(despues, despues.map(p => p.orderId))
    console.log(
      `━━ turno ${id} (${t ? selloLocal(t.startTime, zona) : '?'}) PIERDE cobros → ventas ${pesos(t?.totalSales ?? 0)} → ${pesos(nuevos.totalSales)}, cobros restantes ${despues.length}\n`,
    )
  }

  if (enTurnosContados.length > 0) {
    console.log(
      `⚠️  ${enTurnosContados.length} cobros (${pesos(sumaDe(enTurnosContados))}) están en turnos ya contados (no se tocan): ` +
        [...new Set(enTurnosContados.map(p => p.shiftId))].join(', '),
    )
  }
  const conOrdenEnOtroTurno = plan.flatMap(d => d.mover.filter(p => p.order.shiftId && p.order.shiftId !== (d.turno?.id ?? null)))
  if (conOrdenEnOtroTurno.length > 0) {
    console.log(
      `ℹ️  ${conOrdenEnOtroTurno.length} de los cobros que se mueven pertenecen a órdenes que cuelgan de OTRO turno (o de ninguno).\n` +
        '    `Order.shiftId` NO se reescribe en esta tarea: el detalle del turno en el dashboard cuenta sus órdenes por ahí\n' +
        '    y seguirá mostrando el conteo viejo. Las ventas y propinas sí salen de los cobros, que es lo que se repara.',
    )
  }
  console.log('')
}

/** Qué cobros tendrá cada turno DESPUÉS del plan (para enseñar el «antes → después»). */
function proyectar(plan: PlanDia[], pagosDeLaVentana: Pago[]): Map<string, Pago[]> {
  const destino = new Map<string, string>() // paymentId → clave del turno destino
  for (const d of plan) {
    const clave = d.turno?.id ?? `NUEVO:${d.dia}`
    for (const p of [...d.yaEnElTurno, ...d.mover]) destino.set(p.id, clave)
  }
  const proyeccion = new Map<string, Pago[]>()
  for (const p of pagosDeLaVentana) {
    const clave = destino.get(p.id) ?? p.shiftId
    if (!clave) continue
    proyeccion.set(clave, [...(proyeccion.get(clave) ?? []), p])
  }
  return proyeccion
}

// ───────────────────────────────────────── Escritura ─────────────────────────────────────────

async function aplicarPlan(ctx: { plan: PlanDia[]; venueId: string; zona: string }): Promise<void> {
  const { plan, venueId, zona } = ctx
  const movimientosPorTurno = new Map<string, Array<{ paymentId: string; deTurnoId: string | null }>>()
  const creados: Array<{ dia: string; shiftId: string }> = []
  const cerrados: Array<{ dia: string; shiftId: string; endTime: Date; extiende: boolean }> = []

  await prisma.$transaction(
    async tx => {
      const idsTocados = new Set<string>()

      // El orden importa y es el del addendum: se cierra el turno viejo ANTES de crear el del día
      // siguiente, porque el venue sólo puede tener uno abierto. Los días vienen en orden.
      for (const d of plan) {
        // 1. Cerrar el anterior si lo hubiera (ya viene resuelto en el plan, día por día).
        if (d.turno && d.cerrar) {
          const cerrado = await tx.shift.updateMany({
            where: { id: d.turno.id, venueId, cashDeclared: null },
            data: { status: 'CLOSED', endTime: d.cerrar.endTime },
          })
          if (cerrado.count !== 1) {
            throw new Error(`El turno ${d.turno.id} ya no se puede cerrar sin conteo (¿alguien lo contó mientras corría esto?). Se revierte todo.`)
          }
          cerrados.push({ dia: d.dia, shiftId: d.turno.id, endTime: d.cerrar.endTime, extiende: d.cerrar.extiende })
          idsTocados.add(d.turno.id)
        }

        // 2. Crear el del día si hace falta.
        let shiftId = d.turno?.id
        if (d.crear) {
          const nuevo = await tx.shift.create({
            data: {
              venueId,
              staffId: d.crear.staffId,
              startTime: d.crear.startTime,
              startingCash: d.crear.startingCash,
              status: 'OPEN',
            },
            select: { id: true },
          })
          shiftId = nuevo.id
          creados.push({ dia: d.dia, shiftId: nuevo.id })
        }
        if (!shiftId) throw new Error(`El día ${d.dia} quedó sin turno destino: no debería poder pasar.`)
        idsTocados.add(shiftId)

        // 3. Mover los cobros del día. `shiftId: { not: shiftId }` + `cashDeclared: null` en el
        //    origen se comprobaron al leer; aquí el `updateMany` es una sola sentencia.
        if (d.mover.length > 0) {
          for (const p of d.mover) idsTocados.add(p.shiftId ?? shiftId)
          const movidos = await tx.payment.updateMany({ where: { id: { in: d.mover.map(p => p.id) }, venueId }, data: { shiftId } })
          if (movidos.count !== d.mover.length) {
            throw new Error(`Se esperaba mover ${d.mover.length} cobros del ${d.dia} y se movieron ${movidos.count}. Se revierte todo.`)
          }
          movimientosPorTurno.set(shiftId, [
            ...(movimientosPorTurno.get(shiftId) ?? []),
            ...d.mover.map(p => ({ paymentId: p.id, deTurnoId: p.shiftId })),
          ])
        }

        // 4. Cerrar el turno del día si se pidió y era NUEVO (el existente ya se cerró arriba).
        if (d.crear && d.cerrar) {
          await tx.shift.update({ where: { id: shiftId }, data: { status: 'CLOSED', endTime: d.cerrar.endTime } })
          cerrados.push({ dia: d.dia, shiftId, endTime: d.cerrar.endTime, extiende: false })
        }
      }

      // 5. Recalcular TODOS los turnos tocados, leyendo de la base (no de la proyección): lo que
      //    se guarda sale de lo que de verdad quedó, con la misma agregación que el cierre.
      for (const shiftId of idsTocados) {
        const pagos = await tx.payment.findMany({
          where: { shiftId, status: 'COMPLETED' },
          select: { amount: true, tipAmount: true, method: true, fundsFlow: true, tenderTypeId: true, tenderCountsAsCash: true, orderId: true },
        })
        const t = totalesDe(pagos, pagos.map(p => p.orderId))
        await tx.shift.update({
          where: { id: shiftId },
          data: {
            totalSales: t.totalSales,
            totalTips: t.totalTips,
            totalCashTips: t.totalCashTips,
            totalOrders: t.totalOrders,
            totalCashPayments: t.totalCashPayments,
            totalCardPayments: t.totalCardPayments,
            totalVoucherPayments: t.totalVoucherPayments,
            totalOtherPayments: t.totalOtherPayments,
          },
        })
      }
    },
    // Una corrida contra producción cruza el Atlántico en cada consulta; los 5 s por default de
    // Prisma no alcanzan y una transacción de dinero cortada a la mitad es lo que hay que evitar.
    { timeout: 180_000, maxWait: 30_000 },
  )

  // Bitácora DESPUÉS del commit (ver el docstring): `logAction` usa el cliente global y nunca lanza.
  for (const [shiftId, movimientos] of movimientosPorTurno) {
    await logAction({
      staffId: null,
      venueId,
      action: 'SHIFT_PAYMENTS_REATTRIBUTED',
      entity: 'Shift',
      entityId: shiftId,
      data: {
        script: 'reatribuir-cobros-al-turno',
        motivo: 'el turno de caja es del negocio (decisión del founder, 2-sep-2026); estos cobros quedaron fuera de todo turno',
        movimientos,
      },
    })
  }
  for (const c of creados) {
    await logAction({
      staffId: null,
      venueId,
      action: 'SHIFT_CREATED_BY_REATTRIBUTION',
      entity: 'Shift',
      entityId: c.shiftId,
      data: { script: 'reatribuir-cobros-al-turno', dia: c.dia, motivo: 'un turno por día (decisión del founder, 2-sep-2026)' },
    })
  }
  for (const c of cerrados) {
    await logAction({
      staffId: null,
      venueId,
      action: 'SHIFT_CLOSED_WITHOUT_COUNT',
      entity: 'Shift',
      entityId: c.shiftId,
      data: {
        script: 'reatribuir-cobros-al-turno',
        dia: c.dia,
        endTime: c.endTime.toISOString(),
        extiende: c.extiende,
        motivo: 'cierre sin conteo, decisión del founder 2-sep-2026',
      },
    })
  }

  for (const c of creados) console.log(`✓ ${c.dia}: turno creado ${c.shiftId}`)
  for (const [shiftId, m] of movimientosPorTurno) console.log(`✓ turno ${shiftId}: ${m.length} cobros reatribuidos`)
  for (const c of cerrados) console.log(`✓ ${c.dia}: turno ${c.shiftId} ${c.extiende ? 'extendido' : 'cerrado sin conteo'} a las ${selloLocal(c.endTime, zona)}`)
  console.log('\nTotales recalculados con la misma agregación que el cierre. Vuelve a correr la simulación para verlo.')
}

/**
 * Espera a que la salida llegue de verdad al otro lado antes de matar el proceso: hacia un pipe
 * (`| tee`, `| tail`) `process.stdout` es ASÍNCRONO, y un `process.exit` seco cortaría la tabla a
 * media línea — justo la que hay que leerle al founder. Se drenan LOS DOS flujos: los rechazos
 * van por `stderr`, que tiene su propio búfer aunque `2>&1` los mande al mismo sitio.
 */
function drenarFlujo(flujo: NodeJS.WriteStream): Promise<void> {
  if (flujo.writableLength === 0) return Promise.resolve()
  return new Promise(resolve => flujo.write('', () => resolve()))
}

main()
  .then(() => 0)
  .catch(error => {
    if (error instanceof Rechazo) return error.codigo
    console.error(error)
    return 1
  })
  .then(async codigo => {
    await prisma.$disconnect().catch(() => undefined)
    // 🔴 Salida EXPLÍCITA: este script no termina solo. `posSyncOrder.service` —que entra al grafo
    // por el servicio de turnos— deja un `setInterval` de un minuto vivo al importarse mientras
    // `NODE_ENV !== 'test'`, así que el event loop nunca se vacía y la corrida se ve COLGADA.
    await drenarFlujo(process.stdout)
    await drenarFlujo(process.stderr)
    process.exit(codigo)
  })
