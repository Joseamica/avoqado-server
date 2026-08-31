/**
 * Horas extra — art. 66, 67 y 68 de la LFT.
 *
 * Esto es DINERO, así que la prueba va primero. Las tres reglas que la ley fija y que aquí
 * se prueban una por una:
 *
 *   art. 66 — el tiempo extra no puede exceder de 3 h diarias NI presentarse más de 3 veces
 *             por semana (tope de 9 h semanales). Exceder eso es una INFRACCIÓN que hay que
 *             señalar; no es lo que dispara el triple.
 *   art. 67 — las primeras 9 h extraordinarias de la SEMANA se pagan al doble.
 *   art. 68 — lo que exceda ese máximo, al triple.
 *
 * 🔴 Aquí ya no se prueba ninguna tarifa ni ningún tope legal: se retiraron del módulo el
 * 31-ago-2026 (decisión del founder — la ley la cumple el patrón, no el software). Lo que
 * se guarda es la MEDICIÓN: cuántos minutos se trabajaron después de la hora de salida.
 */
import { minutosExtraDelDia, type DescansoDelDia } from '@/services/dashboard/overtime'

const TZ = 'America/Mexico_City'

/** Un instante en hora del negocio (UTC−6 sin horario de verano en 2026). */
function enMexico(fecha: string, hora: string): Date {
  return new Date(`${fecha}T${hora}:00.000-06:00`)
}

describe('minutosExtraDelDia — lo que se quedó DESPUÉS de su hora de salida', () => {
  const turnoDiurno = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' }

  it('cuenta los minutos entre la salida del cuadrante y la salida real', () => {
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(120)
  })

  it('salir a su hora no genera horas extra', () => {
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '17:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })

  it('salir ANTES no genera extra negativa', () => {
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '15:30') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })

  it('🔴 llegar temprano NO es hora extra — sólo cuenta lo de DESPUÉS de la salida', () => {
    // Decisión declarada: si contara la llegada temprana, los 20 min de café de cada mañana
    // se volverían ~1.7 h semanales al DOBLE que nadie pidió.
    //
    // 🔴 La entrada es a las 07:00, DOS HORAS antes del turno. La versión anterior de esta
    // prueba entraba a las 09:00 en punto (Codex, P2 #15): era indistinguible de una llegada
    // puntual, así que no probaba nada sobre llegar temprano.
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '07:00'), salida: enMexico('2026-08-24', '17:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })

  it('🔴 …y llegar temprano NO suma a lo que sí se quedó de más', () => {
    // Entra 2 h antes y sale 1 h después: la extra es 1 h, no 3.
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '07:00'), salida: enMexico('2026-08-24', '18:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(60)
  })

  it('sin cuadrante NO se juzga: 0, nunca un número inventado', () => {
    expect(
      minutosExtraDelDia({
        turno: { date: '2026-08-24', expectedStart: null, expectedEnd: null },
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '23:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })

  it('sin salida (sigue adentro) da 0 — no se puede saber cuánto se quedó', () => {
    expect(
      minutosExtraDelDia({
        turno: turnoDiurno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: null }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })

  describe('descansos', () => {
    it('🔴 un descanso DENTRO de la hora extra se descuenta', () => {
      const descansos: DescansoDelDia[] = [{ startTime: enMexico('2026-08-24', '17:30'), endTime: enMexico('2026-08-24', '18:00') }]
      // 17:00 → 19:00 son 120, menos 30 de descanso = 90.
      expect(
        minutosExtraDelDia({
          turno: turnoDiurno,
          intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
          descansos,
          timezone: TZ,
        }),
      ).toBe(90)
    })

    it('un descanso DENTRO de la jornada ordinaria NO toca la hora extra', () => {
      const descansos: DescansoDelDia[] = [{ startTime: enMexico('2026-08-24', '14:00'), endTime: enMexico('2026-08-24', '15:00') }]
      expect(
        minutosExtraDelDia({
          turno: turnoDiurno,
          intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
          descansos,
          timezone: TZ,
        }),
      ).toBe(120)
    })

    it('un descanso a caballo sólo descuenta la parte que cae en la hora extra', () => {
      const descansos: DescansoDelDia[] = [{ startTime: enMexico('2026-08-24', '16:45'), endTime: enMexico('2026-08-24', '17:15') }]
      // Sólo los 15 min posteriores a las 17:00 son hora extra descontable.
      expect(
        minutosExtraDelDia({
          turno: turnoDiurno,
          intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
          descansos,
          timezone: TZ,
        }),
      ).toBe(105)
    })

    it('🔴 un descanso ABIERTO se cuenta hasta la salida — no se paga lo que no se puede probar', () => {
      const descansos: DescansoDelDia[] = [{ startTime: enMexico('2026-08-24', '18:00'), endTime: null }]
      // 17:00 → 19:00 = 120, menos los 60 del descanso que nunca cerró = 60.
      expect(
        minutosExtraDelDia({
          turno: turnoDiurno,
          intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
          descansos,
          timezone: TZ,
        }),
      ).toBe(60)
    })

    it('varios descansos se suman', () => {
      const descansos: DescansoDelDia[] = [
        { startTime: enMexico('2026-08-24', '17:10'), endTime: enMexico('2026-08-24', '17:25') },
        { startTime: enMexico('2026-08-24', '18:00'), endTime: enMexico('2026-08-24', '18:20') },
      ]
      expect(
        minutosExtraDelDia({
          turno: turnoDiurno,
          intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: enMexico('2026-08-24', '19:00') }],
          descansos,
          timezone: TZ,
        }),
      ).toBe(120 - 15 - 20)
    })
  })

  describe('turno nocturno', () => {
    const nocturno = { date: '2026-08-24', expectedStart: '22:00', expectedEnd: '06:00' }

    it('🔴 la salida esperada se ancla al día SIGUIENTE cuando el turno cruza la medianoche', () => {
      // Sin esto, 06:00 se compararía contra el MISMO día 24 y toda la noche saldría como extra.
      expect(
        minutosExtraDelDia({
          turno: nocturno,
          intervalos: [{ entrada: enMexico('2026-08-24', '22:00'), salida: enMexico('2026-08-25', '07:30') }],
          descansos: [],
          timezone: TZ,
        }),
      ).toBe(90)
    })

    it('salir a su hora en un nocturno no genera extra', () => {
      expect(
        minutosExtraDelDia({
          turno: nocturno,
          intervalos: [{ entrada: enMexico('2026-08-24', '22:00'), salida: enMexico('2026-08-25', '06:00') }],
          descansos: [],
          timezone: TZ,
        }),
      ).toBe(0)
    })
  })

  it('la zona horaria manda: el mismo instante da distinto en México y en Madrid', () => {
    const turno = { date: '2026-08-24', expectedStart: '09:00', expectedEnd: '17:00' }
    const salida = enMexico('2026-08-24', '19:00') // 2026-08-25 01:00 en Madrid
    expect(
      minutosExtraDelDia({
        turno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: salida }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(120)
    expect(
      minutosExtraDelDia({
        turno,
        intervalos: [{ entrada: enMexico('2026-08-24', '09:00'), salida: salida }],
        descansos: [],
        timezone: 'Europe/Madrid',
      }),
    ).not.toBe(120)
  })
})


