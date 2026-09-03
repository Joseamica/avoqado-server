import { DateTime } from 'luxon'

/**
 * Aritmética del cumpleaños automático. PURO: sin base, sin reloj, sin zona implícita.
 *
 * 🔴 Todo aquí razona en fechas CIVILES (`YYYY-MM-DD`), nunca en instantes. Un cumpleaños
 * no ocurre a una hora: ocurre un día. Trabajar con fechas civiles hace el barrido inmune
 * a las horas que no existen o existen dos veces con el cambio de horario — que en México
 * siguen ocurriendo en Baja California. La zona del venue se aplica UNA vez, fuera de aquí,
 * para saber qué día es hoy allá.
 */

/** Tope de fechas que un solo barrido evalúa. Ver `fechasPendientes`. */
export const MAX_FECHAS_POR_BARRIDO = 31

const FORMATO = 'yyyy-MM-dd'

function civil(fecha: string): DateTime | null {
  const dt = DateTime.fromISO(fecha, { zone: 'utc' })
  return dt.isValid ? dt : null
}

/**
 * El día en que se celebra el cumpleaños de alguien en un año concreto.
 *
 * 🔴 El 29 de febrero se normaliza al 28 en los años NO bisiestos. Sin eso, quien nació
 * ese día se queda sin felicitación 3 de cada 4 años. Es además la convención civil
 * mexicana para efectos de aniversario.
 *
 * @param birthDate fecha de nacimiento civil (`YYYY-MM-DD`)
 * @returns la fecha civil del aniversario, o `null` si la fecha de nacimiento es ilegible
 */
export function aniversarioNormalizado(birthDate: string, año: number): string | null {
  const nacimiento = civil(birthDate)
  if (!nacimiento) return null

  const mes = nacimiento.month
  const dia = nacimiento.day

  // 29-feb en un año que no lo tiene: se celebra el 28.
  const candidato = DateTime.fromObject({ year: año, month: mes, day: dia }, { zone: 'utc' })
  if (candidato.isValid) return candidato.toFormat(FORMATO)

  if (mes === 2 && dia === 29) {
    return DateTime.fromObject({ year: año, month: 2, day: 28 }, { zone: 'utc' }).toFormat(FORMATO)
  }
  return null
}

/**
 * Evaluando la fecha civil `fechaEvaluada`, ¿a quién le toca cumplir años para que el
 * correo salga con `daysBefore` de antelación?
 */
export function cumpleanosAFelicitar(fechaEvaluada: string, daysBefore: number): string {
  const f = civil(fechaEvaluada)
  if (!f) throw new Error(`Fecha civil inválida: "${fechaEvaluada}"`)
  return f.plus({ days: daysBefore }).toFormat(FORMATO)
}

export interface FechasPendientesParams {
  /** Última fecha civil YA evaluada (`lastEvaluatedLocalDate`). `null` la primera vez. */
  desde: string | null
  /** Hoy, en la zona del VENUE — no en la del servidor. */
  hoy: string
  daysBefore: number
}

/**
 * Las fechas civiles que este barrido debe evaluar, en orden.
 *
 * Tres reglas, y las tres nacen de que el sistema puede haber estado caído:
 *
 * 1. **Sin cursor previo se evalúa SÓLO hoy.** Encender la automatización no puede
 *    disparar felicitaciones retroactivas de toda la historia del negocio.
 * 2. 🔴 **Tolerancia de atraso**: una fecha vieja produciría un correo que llega DESPUÉS
 *    del cumpleaños. Felicitar tarde es peor que no felicitar, así que se omite. Se
 *    conserva sólo lo que todavía llega a tiempo (el cumpleaños es hoy o después).
 * 3. 🔴 **Tope duro**: tras meses apagado, un barrido sin límite evaluaría miles de fechas
 *    de una sentada y llenaría la cola. Se quedan las MÁS RECIENTES, que son las únicas
 *    que la regla 2 dejaría pasar de todos modos.
 */
export function fechasPendientes({ desde, hoy, daysBefore }: FechasPendientesParams): string[] {
  const fin = civil(hoy)
  if (!fin) return []

  // Sin cursor: sólo hoy. Con cursor: desde el día siguiente al ya evaluado.
  const inicio = desde ? civil(desde)?.plus({ days: 1 }) : fin
  if (!inicio) return []
  if (inicio > fin) return [] // un reloj que va hacia atrás no produce nada

  const fechas: string[] = []
  for (let d = inicio; d <= fin; d = d.plus({ days: 1 })) {
    const fecha = d.toFormat(FORMATO)
    // Regla 2: si el cumpleaños que tocaba en esa fecha YA pasó, el correo llegaría tarde.
    const cumple = civil(cumpleanosAFelicitar(fecha, daysBefore))!
    if (cumple < fin) continue
    fechas.push(fecha)
  }

  // Regla 3: nos quedamos con la cola más reciente.
  return fechas.slice(-MAX_FECHAS_POR_BARRIDO)
}

/**
 * La relación INVERSA de `aniversarioNormalizado`: dado el día en que se celebra un
 * aniversario, qué días de nacimiento le corresponden.
 *
 * 🔴 Vive aquí, junto a su directa, porque son la MISMA regla mirada desde los dos lados.
 * Estaba escrita otra vez dentro de la consulta del barrido, y una regla en dos sitios se
 * arregla en uno solo: si algún día se decidiera celebrar el 29-feb el 1 de marzo, la
 * copia olvidada seguiría buscando el 28 y esa gente dejaría de recibir su felicitación
 * sin que ninguna prueba lo notara.
 *
 * Casi siempre es un solo día. La excepción es el 28 de febrero de un año NO bisiesto: ahí
 * cumplen también los nacidos un 29.
 */
export function diasDeNacimientoQueCumplenEl(año: number, mes: number, dia: number): number[] {
  const esFebrero28DeAñoNoBisiesto = mes === 2 && dia === 28 && !DateTime.fromObject({ year: año }, { zone: 'utc' }).isInLeapYear
  return esFebrero28DeAñoNoBisiesto ? [28, 29] : [dia]
}
