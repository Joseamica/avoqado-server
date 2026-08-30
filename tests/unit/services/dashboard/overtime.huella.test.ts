/**
 * P1 #4 de la auditoría de Codex — **la autorización versionaba el NÚMERO, no la checada**.
 *
 * Una autorización se daba por vigente cuando `minutesMeasured` volvía a coincidir. El hueco:
 * se autorizan 60 min, una corrección los baja a 0 (el día desaparece de la consulta y la
 * autorización queda huérfana), y después otra corrección vuelve a producir 60 min con
 * checadas COMPLETAMENTE DISTINTAS. La autorización vieja revivía sin que nadie la mirara.
 *
 * La huella resuelve eso: identifica la jornada que produjo los minutos, no su total.
 */
import { huellaDeLaJornada, type DescansoDelDia, type IntervaloTrabajado } from '@/services/dashboard/overtime'

const t = (h: string) => new Date(`2026-08-24T${h}:00.000-06:00`)
const TURNO = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' }

const jornada = (intervalos: IntervaloTrabajado[], descansos: DescansoDelDia[] = [], turno = TURNO) =>
  huellaDeLaJornada({ turno, intervalos, descansos })

describe('huellaDeLaJornada', () => {
  it('la misma jornada da la misma huella', () => {
    const a = jornada([{ entrada: t('09:00'), salida: t('19:00') }])
    const b = jornada([{ entrada: t('09:00'), salida: t('19:00') }])
    expect(a).toBe(b)
  })

  it('🔴 el MISMO total con checadas DISTINTAS da huella distinta', () => {
    // Éste es el defecto entero: los dos casos miden 120 min de extra, pero no son la misma
    // jornada y la autorización de uno no puede valer para el otro.
    const unaChecada = jornada([{ entrada: t('09:00'), salida: t('19:00') }])
    const dosChecadas = jornada([
      { entrada: t('09:00'), salida: t('17:00') },
      { entrada: t('17:00'), salida: t('19:00') },
    ])
    expect(unaChecada).not.toBe(dosChecadas)
  })

  it('cambiar la hora de salida cambia la huella', () => {
    expect(jornada([{ entrada: t('09:00'), salida: t('19:00') }])).not.toBe(
      jornada([{ entrada: t('09:00'), salida: t('19:01') }]),
    )
  })

  it('cambiar la hora de ENTRADA también', () => {
    expect(jornada([{ entrada: t('09:00'), salida: t('19:00') }])).not.toBe(
      jornada([{ entrada: t('08:00'), salida: t('19:00') }]),
    )
  })

  it('🔴 añadir un descanso cambia la huella aunque el total de extra no cambie', () => {
    // Un descanso DENTRO de la jornada ordinaria no mueve los minutos extra, pero sí cambia
    // la jornada. Quien autorizó no vio ese descanso.
    const sin = jornada([{ entrada: t('09:00'), salida: t('19:00') }])
    const con = jornada([{ entrada: t('09:00'), salida: t('19:00') }], [{ startTime: t('14:00'), endTime: t('15:00') }])
    expect(sin).not.toBe(con)
  })

  it('🔴 cambiar el CUADRANTE cambia la huella', () => {
    // Mover la hora de salida del turno cambia cuántos minutos son extra: la decisión que se
    // firmó ya no aplica.
    const a = jornada([{ entrada: t('09:00'), salida: t('19:00') }])
    const b = jornada([{ entrada: t('09:00'), salida: t('19:00') }], [], { ...TURNO, expectedEnd: '18:00' })
    expect(a).not.toBe(b)
  })

  it('el ORDEN en que llegan los tramos no cambia la huella', () => {
    const a = { entrada: t('09:00'), salida: t('17:00') }
    const b = { entrada: t('18:00'), salida: t('19:00') }
    expect(jornada([a, b])).toBe(jornada([b, a]))
  })

  it('el orden de los descansos tampoco', () => {
    const x: DescansoDelDia = { startTime: t('17:10'), endTime: t('17:25') }
    const y: DescansoDelDia = { startTime: t('18:00'), endTime: t('18:20') }
    const uno = jornada([{ entrada: t('09:00'), salida: t('19:00') }], [x, y])
    const dos = jornada([{ entrada: t('09:00'), salida: t('19:00') }], [y, x])
    expect(uno).toBe(dos)
  })

  it('un tramo ABIERTO se distingue de uno cerrado', () => {
    expect(jornada([{ entrada: t('09:00'), salida: null }])).not.toBe(
      jornada([{ entrada: t('09:00'), salida: t('19:00') }]),
    )
  })

  it('una jornada sin nada da una huella estable, no vacía', () => {
    expect(jornada([])).toBe(jornada([]))
    expect(jornada([]).length).toBeGreaterThan(0)
  })

  it('la huella es corta: se guarda en cada fila, no se lee a ojo', () => {
    expect(jornada([{ entrada: t('09:00'), salida: t('19:00') }]).length).toBeLessThanOrEqual(32)
  })
})
