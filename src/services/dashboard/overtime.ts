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
import { createHash } from 'crypto'

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

/**
 * Un tramo REALMENTE trabajado: de una entrada a su salida.
 *
 * 🔴 Son los tramos, no «la última salida». Alguien que sale a las 17:00, se va a su casa y
 * vuelve a las 18:00 trabajó una hora extra, no dos — y el hueco entre dos checadas NO es un
 * `TimeEntryBreak`, así que nadie lo descontaba (hallazgo #1 de Codex, 29-ago-2026, el más
 * caro de los nueve).
 */
export interface IntervaloTrabajado {
  entrada: Date
  /** `null` = sigue adentro. No aporta: no se paga lo que no se puede probar. */
  salida: Date | null
}

export interface MinutosExtraInput {
  turno: TurnoDelDia
  /** Los tramos trabajados de ESE día del turno, en cualquier orden. */
  intervalos: IntervaloTrabajado[]
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
export function minutosExtraDelDia({ turno, intervalos, descansos, timezone }: MinutosExtraInput): number {
  // Sin cuadrante no se juzga — la misma regla que el reporte de puntualidad. Un negocio que
  // aún no armó horarios no puede empezar a deber horas extra.
  if (!turno.expectedStart || !turno.expectedEnd) return 0

  const salidaEsperada = instanteDeSalidaEsperada(turno, timezone)
  if (!salidaEsperada) return 0
  const desde = salidaEsperada.toMillis()

  // 🔴 Lo trabajado DESPUÉS del fin del turno, tramo por tramo y unidos. Antes se restaba
  // «última salida − fin del turno», que regalaba el hueco entre dos checadas.
  const trabajados: Array<[number, number]> = []
  let ultimoFin = desde
  for (const i of intervalos) {
    if (!i.salida) continue // sigue adentro: no se puede probar
    const a = DateTime.fromJSDate(i.entrada, { zone: timezone })
    const b = DateTime.fromJSDate(i.salida, { zone: timezone })
    if (!a.isValid || !b.isValid) continue
    // Una checada MALFORMADA (salida antes de la entrada) se ignora. Pasa de verdad: un script
    // dejó una así en la base durante el /full-testing y la rejilla la usó sin quejarse.
    //
    // ⚠️ Honestidad: esta línea es REDUNDANTE — el `fin > inicio` de abajo ya la descarta en
    // todos los casos, y quitarla no rompe ninguna prueba (comprobado saboteándola). Se queda
    // porque nombra la intención donde se lee, no porque sea la que protege.
    if (b.toMillis() <= a.toMillis()) continue
    const inicio = Math.max(a.toMillis(), desde)
    const fin = b.toMillis()
    if (fin > inicio) {
      trabajados.push([inicio, fin])
      if (fin > ultimoFin) ultimoFin = fin
    }
  }
  const brutos = minutosDeLaUnion(trabajados)
  if (!(brutos > 0)) return 0

  // Los descansos se acotan a la misma ventana [fin del turno, última salida real].
  const hasta = DateTime.fromMillis(ultimoFin, { zone: timezone })
  const enDescanso = minutosDeDescansoEnLaVentana(descansos, salidaEsperada, hasta, timezone)
  // 🔴 REDONDEO — política DECLARADA (hallazgo #10 de Codex, 29-ago-2026).
  //
  // Se redondea POR DÍA, al minuto más cercano. Codex propuso conservar segundos y redondear
  // una sola vez en la frontera de nómina, porque redondear a diario puede mover el cruce de
  // las 540 semanales. Es cierto, y aun así se elige declarar la política:
  //
  //   · La autorización es POR DÍA. Un gerente firma «tantos minutos del martes», no una
  //     fracción de un acumulado. Guardar segundos obligaría a enseñar y aprobar cantidades
  //     que nadie teclea.
  //   · El reparto doble/triple se calcula sobre lo AUTORIZADO, que ya son minutos enteros
  //     escritos por una persona. El redondeo de lo MEDIDO sólo afecta al tope que se enseña
  //     y a la infracción del art. 66, cuyos umbrales son de 3 y 9 HORAS.
  //   · Un reloj checador no tiene precisión de segundo que merezca la pena arrastrar.
  //
  // La consecuencia se acepta y está fijada en `overtime.redondeo.test.ts`: 29 segundos son
  // 0 minutos y 31 son 1. Si algún día se quiere granularidad de 5 o 15 minutos —lo que hacen
  // muchos sistemas de nómina— se cambia AQUÍ, en un solo sitio.
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

  // 🔴 HORARIO DE VERANO — política DECLARADA (hallazgo #8 de Codex, 29-ago-2026).
  //
  // En la noche en que el reloj se atrasa, una hora local ocurre DOS veces. Luxon resuelve la
  // ambigüedad quedándose con la PRIMERA (el offset anterior), y eso es justo lo que aquí se
  // quiere: es la ocurrencia que hace que el turno dure lo que dice el cuadrante. Un 22:00–01:30
  // dura 3 h 30 m contractuales; la segunda 01:30 daría 4 h 30 m de reloj y regalaría una hora
  // de extra que nadie pidió. Quien se queda hasta la segunda sí cobra esos 60 min, porque la
  // comparación es contra un INSTANTE, no contra la hora de pared.
  //
  // Cuando el reloj se adelanta, la hora de pared no existió y Luxon normaliza hacia delante:
  // se acepta, porque el turno terminó cuando el reloj saltó.
  //
  // No se reimplementa la elección: sería duplicar un comportamiento correcto de la librería.
  // Lo que sí hay es `overtime.horarioDeVerano.test.ts`, que la FIJA — comprobado forzando la
  // otra ocurrencia: dos pruebas fallan. Si una versión de Luxon cambiara el default, se ve.
  //
  // ⚠️ México dejó el horario de verano en 2022, pero Baja California lo conserva por su
  // frontera con California: Tijuana y Mexicali tienen estas noches dos veces al año.
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
  // 🔴 Se recortan a la ventana y después se UNEN. Sumar cada descanso por su lado descuenta
  // dos veces el tiempo compartido y paga de MENOS — hallazgo #7 de la auditoría de Codex
  // (29-ago-2026), reproducido: dos descansos anidados de 60 y 30 min sobre 2 h de extra
  // dejaban 30 min en vez de 60. Es la dirección que nadie reclama, porque el empleado no
  // sabe que le faltan.
  //
  // Un descanso enteramente dentro de la jornada ordinaria da intersección vacía y desaparece
  // aquí, que es lo que debe pasar.
  const tramos: Array<[number, number]> = []
  for (const d of descansos) {
    const inicio = DateTime.fromJSDate(d.startTime, { zone: timezone })
    const fin = d.endTime ? DateTime.fromJSDate(d.endTime, { zone: timezone }) : hasta
    if (!inicio.isValid || !fin.isValid) continue
    const a = Math.max(inicio.toMillis(), desde.toMillis())
    const b = Math.min(fin.toMillis(), hasta.toMillis())
    if (b > a) tramos.push([a, b])
  }
  return minutosDeLaUnion(tramos)
}

/**
 * Suma la UNIÓN de una lista de tramos `[inicio, fin]` en milisegundos, devuelta en minutos.
 *
 * Ordena por inicio y fusiona lo que se toca o se solapa. Es la pieza que impide contar dos
 * veces el mismo minuto.
 */
export function minutosDeLaUnion(tramos: Array<[number, number]>): number {
  if (tramos.length === 0) return 0
  const ordenados = [...tramos].sort((x, y) => x[0] - y[0])
  let total = 0
  let [inicio, fin] = ordenados[0]
  for (let i = 1; i < ordenados.length; i++) {
    const [a, b] = ordenados[i]
    if (a <= fin) {
      if (b > fin) fin = b
    } else {
      total += fin - inicio
      inicio = a
      fin = b
    }
  }
  total += fin - inicio
  return total / 60000
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
export function agruparPorSemana(
  dias: DiaConExtra[],
  rango: { startDate: string; endDate: string },
  /**
   * Minutos ya acumulados en las MISMAS semanas, en días que quedan FUERA del rango pedido
   * (`{ 'YYYY-MM-DD': minutos }`).
   *
   * 🔴 Sin esto, pedir sólo el domingo de una semana cuyo lunes ya llevaba 8 h autorizadas
   * pagaba las 3 h del domingo al DOBLE, cuando legalmente 1 h iba al doble y 2 h al TRIPLE
   * (hallazgo #2 de Codex, 29-ago-2026). El campo `parcial` avisaba del riesgo y el dinero
   * salía mal igual: avisar no es resolver.
   *
   * Los días previos SÓLO mueven el umbral; nunca se re-reportan en los totales, que siguen
   * siendo los atribuibles al rango pedido.
   */
  acumuladoPrevio: Record<string, number> = {},
): SemanaDeExtra[] {
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

  // Los días de FUERA del rango se agrupan igual, pero sólo para mover el umbral.
  const previoPorSemana = new Map<string, DiaConExtra[]>()
  for (const [date, minutos] of Object.entries(acumuladoPrevio)) {
    if (!(minutos > 0)) continue
    const d = DateTime.fromISO(date, { zone: 'utc' })
    if (!d.isValid) continue
    const lunes = d.startOf('week').toISODate()!
    const lista = previoPorSemana.get(lunes)
    if (lista) lista.push({ date, minutos })
    else previoPorSemana.set(lunes, [{ date, minutos }])
  }

  const desdeRango = DateTime.fromISO(rango.startDate, { zone: 'utc' })
  const hastaRango = DateTime.fromISO(rango.endDate, { zone: 'utc' })

  return [...porSemana.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, deLaSemana]) => {
      const lunes = DateTime.fromISO(weekStart, { zone: 'utc' })
      const domingo = lunes.plus({ days: 6 })
      const minutosTotal = deLaSemana.reduce((s, d) => s + d.minutos, 0)
      const previos = previoPorSemana.get(weekStart) ?? []
      const minutosPrevios = previos.reduce((s, d) => s + d.minutos, 0)

      // El reparto se calcula sobre el acumulado COMPLETO de la semana y luego se le resta la
      // parte de los días de fuera: así el umbral de 9 h cae donde la ley lo pone, pero lo
      // devuelto sigue siendo lo atribuible al rango pedido.
      const conPrevios = repartirDobleYTriple(minutosPrevios + minutosTotal)
      const soloPrevios = repartirDobleYTriple(minutosPrevios)
      const minutosDobles = conPrevios.minutosDobles - soloPrevios.minutosDobles
      const minutosTriples = conPrevios.minutosTriples - soloPrevios.minutosTriples

      return {
        weekStart,
        weekEnd: domingo.toISODate()!,
        minutosTotal,
        minutosDobles,
        minutosTriples,
        // La INFRACCIÓN del art. 66 mira la semana entera, días de fuera incluidos: la ley se
        // rompió aunque el rango consultado no los enseñe.
        diasSobreTopeDiario: [...previos, ...deLaSemana]
          .filter(d => d.minutos > TOPE_DIARIO_MINUTOS)
          .map(d => d.date)
          .sort(),
        diasConExtra: previos.length + deLaSemana.length,
        excedeDiasPermitidos: previos.length + deLaSemana.length > 3,
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
  /**
   * Huella de la jornada TAL COMO ESTÁ HOY. `null` si no se pudo calcular.
   *
   * 🔴 Versionar el total no basta: el mismo número puede venir de checadas distintas, y la
   * autorización vieja revivía sin que nadie la mirara (hallazgo #4 de Codex).
   */
  huellaActual?: string | null
  /** Huella de la jornada que se firmó. `null` en filas anteriores a este campo. */
  huellaAlAutorizar?: string | null
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

    // 🔴 Si la JORNADA cambió, la autorización no vale aunque el total coincida: quien firmó
    // no vio estas checadas. Y una fila SIN huella (anterior a la columna) se trata igual —
    // el lado seguro es volver a pedirla, no pagarla a ciegas.
    const huellasCoinciden =
      dia.huellaAlAutorizar != null && dia.huellaActual != null && dia.huellaAlAutorizar === dia.huellaActual
    if (!huellasCoinciden) {
      minutosPendientes += medidos
      porRevisar.push(dia.date)
      continue
    }

    // Nunca se paga más de lo que el reloj marca hoy.
    const autorizados = Math.min(Math.max(0, dia.autorizados), medidos)
    minutosAutorizados += autorizados

    const cambio = dia.medidosAlAutorizar !== null && dia.medidosAlAutorizar !== medidos
    if (cambio) porRevisar.push(dia.date)

    const resto = medidos - autorizados
    if (resto <= 0) continue

    // 🔴 Cuando la checada CRECE después de autorizar, el resto se parte en DOS: lo que ya se
    // revisó y se negó sigue negado, y sólo el crecimiento sobre el retrato está sin revisar.
    // Antes se mandaba el resto ENTERO a pendiente: con 60 medidos → 30 autorizados (⇒ 30
    // negados), subir a 120 devolvía 30 autorizados y 90 pendientes, y la decisión de negar
    // esos 30 se evaporaba como si nadie los hubiera mirado (hallazgo #5 de Codex, 29-ago).
    const retrato = dia.medidosAlAutorizar
    if (retrato !== null && medidos > retrato) {
      const negadoEntonces = Math.max(0, Math.min(retrato, medidos) - autorizados)
      minutosNegados += negadoEntonces
      minutosPendientes += resto - negadoEntonces
    } else {
      minutosNegados += resto
    }
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

// ─── La huella de la jornada (hallazgo #4 de Codex) ───────────────────────────────────────

/**
 * Identifica la JORNADA que produjo unos minutos extra: los tramos trabajados, los descansos
 * y el cuadrante de ese día.
 *
 * 🔴 Existe porque versionar el NÚMERO no basta. Una autorización se daba por vigente cuando
 * `minutesMeasured` volvía a coincidir, y eso deja un hueco: se autorizan 60 min, una
 * corrección los baja a 0, y una corrección posterior vuelve a producir 60 min con checadas
 * COMPLETAMENTE distintas. La autorización vieja revivía sin que nadie la mirara.
 *
 * No es criptografía: es un identificador estable y corto para saber si lo que hay hoy es lo
 * mismo que alguien firmó. Se ordena antes de mezclar para que el orden en que Prisma
 * devuelva las filas no cambie la huella.
 */
export function huellaDeLaJornada(input: {
  turno: TurnoDelDia
  intervalos: IntervaloTrabajado[]
  descansos: DescansoDelDia[]
}): string {
  const tramos = input.intervalos
    .map(i => `${i.entrada.getTime()}-${i.salida ? i.salida.getTime() : 'abierto'}`)
    .sort()
  const pausas = input.descansos
    .map(d => `${d.startTime.getTime()}-${d.endTime ? d.endTime.getTime() : 'abierto'}`)
    .sort()
  // El cuadrante entra porque mover la hora de salida cambia cuántos minutos son extra: la
  // decisión firmada deja de aplicar aunque las checadas no se hayan tocado.
  const cuadrante = `${input.turno.date}|${input.turno.expectedStart ?? '-'}|${input.turno.expectedEnd ?? '-'}`

  return createHash('sha256').update(`${cuadrante}#${tramos.join(',')}#${pausas.join(',')}`).digest('hex').slice(0, 32)
}
