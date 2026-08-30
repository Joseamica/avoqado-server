/**
 * Horas extra — la aritmética de los artículos 66, 67 y 68 de la LFT.
 *
 * PURA a propósito: sin base de datos, sin reloj propio, sin efectos. Es lo que permite
 * ejercitar un turno nocturno, un descanso a caballo o una semana de 12 horas sin sembrar
 * nada — y es la regla del repo para toda pieza que se quiera probar de verdad.
 *
 * Las tres reglas de la ley:
 *
 *   art. 66 — el tiempo extra no puede exceder de 3 h diarias ni presentarse más de 3 veces
 *             por semana. De ahí el tope de 9 h semanales.
 *   art. 67 — las primeras 9 h extraordinarias de la SEMANA se pagan al doble.
 *   art. 68 — el tiempo que exceda ese máximo, al triple.
 *
 * 🔴 Lo que decide doble contra triple es el ACUMULADO SEMANAL, no el tope diario
 * (verificado en vivo el 29-ago-2026). Quien hace 4 h un lunes viola el tope del art. 66,
 * pero esas 4 h siguen siendo DOBLES si la semana todavía no llega a 9. El tope diario se
 * reporta como infracción; no cambia la tarifa.
 *
 * 🔴 Y lo que NO calcula, declarado: aquí no se convierte a pesos. Salen MINUTOS repartidos
 * en dobles y triples, igual que el resumen de nómina de la fase 3 entrega números y no
 * dinero. El salario por hora vive en el sistema de nómina del negocio, no aquí.
 */
import { DateTime } from 'luxon'

/** Art. 66: 3 horas diarias. Es la LEY, no un ajuste del negocio. */
export const TOPE_DIARIO_MINUTOS = 180

/** Art. 66/67: 9 horas semanales. Hasta aquí es doble; de aquí en adelante, triple. */
export const TOPE_SEMANAL_MINUTOS = 540

/** El turno que le tocaba ese día, tal como lo resuelve la rejilla de asistencia. */
export interface TurnoDelDia {
  /** Día civil del TURNO (YYYY-MM-DD) en hora del negocio — no el día del reloj de la checada. */
  date: string
  /** 'HH:mm' en hora del negocio. null = sin cuadrante ese día. */
  expectedStart: string | null
  expectedEnd: string | null
}

/** Un descanso con sus dos extremos. `endTime` nulo = quedó abierto. */
export interface DescansoDelDia {
  startTime: Date
  endTime: Date | null
}

export interface MinutosExtraInput {
  turno: TurnoDelDia
  clockOutTime: Date | null
  descansos: DescansoDelDia[]
  /** Zona del NEGOCIO. Sin default a propósito: olvidarla debe romper la llamada, no producir números corridos. */
  timezone: string
}

/**
 * Minutos que alguien se quedó DESPUÉS de la hora de salida de su cuadrante, ya descontados
 * los descansos que caen dentro de esa ventana.
 *
 * 🔴 Llegar temprano NO cuenta. Es una decisión declarada, no un olvido: contar la llegada
 * temprana convertiría los 20 minutos de café de cada mañana en ~1.7 h semanales pagadas al
 * DOBLE que nadie pidió. La hora extra es la que el negocio pide, y eso se ve al final del
 * turno. (Si algún día se quiere lo contrario, es un ajuste por venue — no un cambio aquí.)
 */
export function minutosExtraDelDia({ turno, clockOutTime, descansos, timezone }: MinutosExtraInput): number {
  // Sin cuadrante no se juzga — la misma regla que el reporte de puntualidad. Un negocio que
  // aún no armó horarios no puede empezar a deber horas extra.
  if (!turno.expectedStart || !turno.expectedEnd) return 0
  // Sigue adentro: no se sabe cuánto se quedó, y suponerlo sería inventar dinero.
  if (!clockOutTime) return 0

  const salidaEsperada = instanteDeSalidaEsperada(turno, timezone)
  if (!salidaEsperada) return 0

  const salidaReal = DateTime.fromJSDate(clockOutTime, { zone: timezone })
  const brutos = salidaReal.diff(salidaEsperada, 'minutes').minutes
  if (!(brutos > 0)) return 0

  const enDescanso = minutosDeDescansoEnLaVentana(descansos, salidaEsperada, salidaReal, timezone)
  return Math.max(0, Math.round(brutos - enDescanso))
}

/**
 * Reparte un total semanal entre dobles y triples (art. 67 y 68).
 *
 * Se recibe el total YA acumulado de la semana: quien llama es responsable de agrupar por
 * semana, porque el umbral es semanal y no diario.
 */
export function repartirDobleYTriple(minutosTotales: number): { minutosDobles: number; minutosTriples: number } {
  if (!(minutosTotales > 0)) return { minutosDobles: 0, minutosTriples: 0 }
  const dobles = Math.min(minutosTotales, TOPE_SEMANAL_MINUTOS)
  return { minutosDobles: dobles, minutosTriples: minutosTotales - dobles }
}

/**
 * El instante exacto en que le tocaba salir.
 *
 * 🔴 Si el turno cruza la medianoche (`expectedEnd <= expectedStart`), la salida es del día
 * SIGUIENTE. Sin este anclaje, un 22:00–06:00 compararía las 06:00 contra el MISMO día y la
 * noche entera saldría como hora extra — el mismo error que ya costó caro en el evaluador de
 * retardos, anclado al día del TURNO y no al del reloj.
 */
function instanteDeSalidaEsperada(turno: TurnoDelDia, timezone: string): DateTime | null {
  const cruzaMedianoche = turno.expectedEnd! <= turno.expectedStart!
  const dia = cruzaMedianoche
    ? DateTime.fromISO(turno.date, { zone: timezone }).plus({ days: 1 })
    : DateTime.fromISO(turno.date, { zone: timezone })
  if (!dia.isValid) return null

  const [h, m] = turno.expectedEnd!.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null

  const salida = dia.set({ hour: h, minute: m, second: 0, millisecond: 0 })
  return salida.isValid ? salida : null
}

/**
 * Minutos de descanso que se solapan con la ventana de hora extra.
 *
 * 🔴 Un descanso ABIERTO (`endTime` nulo) se cuenta hasta la salida. Es la elección
 * conservadora y es deliberada: no contarlo pagaría al doble un tiempo que nadie puede
 * probar que se trabajó. Un descanso que quedó abierto es además una checada malformada —
 * mejor que se note bajando la extra que que se pague en silencio.
 */
function minutosDeDescansoEnLaVentana(descansos: DescansoDelDia[], desde: DateTime, hasta: DateTime, timezone: string): number {
  let total = 0
  for (const d of descansos) {
    const inicio = DateTime.fromJSDate(d.startTime, { zone: timezone })
    const fin = d.endTime ? DateTime.fromJSDate(d.endTime, { zone: timezone }) : hasta
    if (!inicio.isValid || !fin.isValid) continue

    // Intersección con [desde, hasta]. Un descanso enteramente dentro de la jornada
    // ordinaria da intersección vacía y no toca nada.
    const desdeMs = Math.max(inicio.toMillis(), desde.toMillis())
    const hastaMs = Math.min(fin.toMillis(), hasta.toMillis())
    if (hastaMs > desdeMs) total += (hastaMs - desdeMs) / 60000
  }
  return total
}

/** Un día del periodo con sus minutos extra ya calculados. */
export interface DiaConExtra {
  /** Día civil del TURNO (YYYY-MM-DD). */
  date: string
  minutos: number
}

export interface SemanaDeExtra {
  /** Lunes de la semana, día civil. */
  weekStart: string
  /** Domingo de la semana, día civil. */
  weekEnd: string
  minutosTotal: number
  minutosDobles: number
  minutosTriples: number
  /** Días de esa semana que pasaron de 3 h (art. 66). Es infracción; no cambia la tarifa. */
  diasSobreTopeDiario: string[]
  /** Cuántos días de la semana tuvieron algo de extra. */
  diasConExtra: number
  /** Más de 3 días con extra en la semana (art. 66). */
  excedeDiasPermitidos: boolean
  /**
   * El rango consultado no cubre la semana entera, así que el reparto doble/triple de ESTA
   * semana no es afirmable: los días de fuera pudieron traer horas que mueven el umbral.
   */
  parcial: boolean
}

/**
 * Agrupa los días por semana natural (lunes a domingo) y aplica el art. 67/68 sobre el total
 * de CADA semana.
 *
 * 🔴 Agrupar bien es la mitad del cálculo. Dos semanas mezcladas inventan triples que no
 * existen —8 h el domingo más 8 h el lunes parecerían 16 h de una sola semana—; una semana
 * partida en dos los esconde.
 *
 * 🔴 Y una semana que el rango no cubre entera sale marcada `parcial`. Pedir "del miércoles al
 * viernes" no permite afirmar el reparto: el lunes y el martes quedaron fuera y pudieron traer
 * horas que empujan la tarifa al triple. Marcarlo es preferible a entregar un número que se ve
 * exacto y no lo es.
 */
export function agruparPorSemana(dias: DiaConExtra[], rango: { startDate: string; endDate: string }): SemanaDeExtra[] {
  const porSemana = new Map<string, DiaConExtra[]>()

  for (const dia of dias) {
    if (!(dia.minutos > 0)) continue
    const d = DateTime.fromISO(dia.date, { zone: 'utc' })
    if (!d.isValid) continue
    // `startOf('week')` de Luxon arranca en LUNES, que es la semana laboral mexicana.
    const lunes = d.startOf('week').toISODate()!
    const lista = porSemana.get(lunes)
    if (lista) lista.push(dia)
    else porSemana.set(lunes, [dia])
  }

  const desdeRango = DateTime.fromISO(rango.startDate, { zone: 'utc' })
  const hastaRango = DateTime.fromISO(rango.endDate, { zone: 'utc' })

  return [...porSemana.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, deLaSemana]) => {
      const lunes = DateTime.fromISO(weekStart, { zone: 'utc' })
      const domingo = lunes.plus({ days: 6 })
      const minutosTotal = deLaSemana.reduce((s, d) => s + d.minutos, 0)
      const { minutosDobles, minutosTriples } = repartirDobleYTriple(minutosTotal)

      return {
        weekStart,
        weekEnd: domingo.toISODate()!,
        minutosTotal,
        minutosDobles,
        minutosTriples,
        diasSobreTopeDiario: deLaSemana
          .filter(d => d.minutos > TOPE_DIARIO_MINUTOS)
          .map(d => d.date)
          .sort(),
        diasConExtra: deLaSemana.length,
        excedeDiasPermitidos: deLaSemana.length > 3,
        parcial: !desdeRango.isValid || !hastaRango.isValid || desdeRango > lunes || hastaRango < domingo,
      }
    })
}

// ─── Autorización (decisión del founder, 29-ago-2026: «autorizarse») ──────────────────────
//
// Lo MEDIDO se guarda siempre: es lo que marcó el reloj y nadie lo puede borrar. Lo AUTORIZADO
// es lo que entra al reparto doble/triple, porque es lo que se paga.
//
// 🔴 El riesgo de exigir autorización es que no pagar se vuelva INVISIBLE. Por eso lo pendiente
// se reporta aparte y bien visible, en vez de quedar en cero y desaparecer.

/** Un día con lo que midió el reloj y lo que alguien autorizó. */
export interface DiaAutorizado {
  date: string
  /** Lo que mide el reloj HOY. */
  medidos: number
  /** Minutos autorizados. `null` = SIN REVISAR (no hay fila), que NO es lo mismo que 0 = negado. */
  autorizados: number | null
  /** Lo que se medía cuando se autorizó. Si ya no coincide, la checada cambió después. */
  medidosAlAutorizar: number | null
}

export interface ResumenDeAutorizacion {
  minutosMedidos: number
  minutosAutorizados: number
  /** Medidos en días que NADIE ha revisado. Lo que el negocio tiene que mirar. */
  minutosPendientes: number
  /** Medidos que sí se revisaron y NO se autorizaron. */
  minutosNegados: number
  /** Días donde la checada cambió después de autorizar: hay que volver a mirarlos. */
  diasPorRevisar: string[]
}

/**
 * Reparte lo medido en autorizado / pendiente / negado.
 *
 * 🔴 El caso que cuesta dinero es que la checada CAMBIE después de autorizar. Dos direcciones:
 *
 *  - Ahora se mide MÁS (alguien editó la salida hacia adelante): el excedente NO hereda la
 *    autorización — sale como pendiente. Si lo heredara, editar una salida sería una forma de
 *    autorizarse horas a sí mismo.
 *  - Ahora se mide MENOS: se paga lo trabajado, no lo autorizado. Pagar 4 h autorizadas sobre
 *    1 h trabajada es pagar aire.
 *
 * En las dos, el día queda marcado en `diasPorRevisar` para que alguien lo mire de nuevo.
 */
export function resumirAutorizacion(dias: DiaAutorizado[]): ResumenDeAutorizacion {
  let minutosMedidos = 0
  let minutosAutorizados = 0
  let minutosPendientes = 0
  let minutosNegados = 0
  const porRevisar: string[] = []

  for (const dia of dias) {
    const medidos = Math.max(0, dia.medidos)
    minutosMedidos += medidos
    if (medidos === 0) continue

    if (dia.autorizados === null) {
      // Nadie lo ha mirado.
      minutosPendientes += medidos
      continue
    }

    // Nunca se paga más de lo que el reloj marca hoy.
    const autorizados = Math.min(Math.max(0, dia.autorizados), medidos)
    minutosAutorizados += autorizados

    const cambio = dia.medidosAlAutorizar !== null && dia.medidosAlAutorizar !== medidos
    if (cambio) porRevisar.push(dia.date)

    const resto = medidos - autorizados
    if (resto <= 0) continue
    // Si la checada creció después de autorizar, lo NUEVO está sin revisar; si no, es que se
    // revisó y se negó.
    const creció = dia.medidosAlAutorizar !== null && medidos > dia.medidosAlAutorizar
    if (creció) minutosPendientes += resto
    else minutosNegados += resto
  }

  return {
    minutosMedidos,
    minutosAutorizados,
    minutosPendientes,
    minutosNegados,
    diasPorRevisar: porRevisar.sort(),
  }
}

/**
 * Los días que entran al reparto doble/triple: SÓLO lo autorizado.
 *
 * Se separa de `resumirAutorizacion` porque `agruparPorSemana` necesita los días uno por uno
 * (el umbral de 9 h es semanal) y el resumen ya viene sumado.
 */
export function diasAutorizadosParaReparto(dias: DiaAutorizado[]): DiaConExtra[] {
  const salida: DiaConExtra[] = []
  for (const dia of dias) {
    if (dia.autorizados === null) continue
    const minutos = Math.min(Math.max(0, dia.autorizados), Math.max(0, dia.medidos))
    if (minutos > 0) salida.push({ date: dia.date, minutos })
  }
  return salida
}
