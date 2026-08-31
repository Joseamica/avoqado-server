/**
 * P1 #1 de la auditoría de Codex — el más caro: **se pagaba el HUECO entre dos checadas**.
 *
 * El cálculo era `última salida − fin del turno − descansos`. Si alguien sale a las 17:00, se
 * va a su casa y vuelve a las 18:00 para salir a las 19:00, eso daba 2 h de extra cuando
 * trabajó 1. El hueco entre dos `TimeEntry` distintos no es un `TimeEntryBreak`, así que nadie
 * lo descontaba.
 *
 * El arreglo: intersectar los INTERVALOS REALMENTE TRABAJADOS con la ventana posterior al fin
 * del turno. Para una sola checada da exactamente el mismo número que antes — por eso las
 * pruebas viejas siguen valiendo.
 */
import { minutosExtraDelDia, type DescansoDelDia, type IntervaloTrabajado } from '@/services/dashboard/overtime'

const TZ = 'America/Mexico_City'
const t = (f: string, h: string) => new Date(`${f}T${h}:00.000-06:00`)
const DIA = '2026-08-24'
const TURNO = { date: DIA, expectedStart: '09:00', expectedEnd: '17:00' }

function extra(intervalos: IntervaloTrabajado[], descansos: DescansoDelDia[] = []) {
  return minutosExtraDelDia({ turno: TURNO, intervalos, descansos, timezone: TZ })
}

describe('🔴 el hueco entre dos checadas NO se paga', () => {
  it('sale 17:00, vuelve 18:00, sale 19:00 → 60 min, no 120', () => {
    expect(
      extra([
        { entrada: t(DIA, '09:00'), salida: t(DIA, '17:00') },
        { entrada: t(DIA, '18:00'), salida: t(DIA, '19:00') },
      ]),
    ).toBe(60)
  })

  it('tres tramos con dos huecos sólo cuentan lo trabajado', () => {
    expect(
      extra([
        { entrada: t(DIA, '09:00'), salida: t(DIA, '17:00') },
        { entrada: t(DIA, '17:30'), salida: t(DIA, '18:00') }, // 30
        { entrada: t(DIA, '19:00'), salida: t(DIA, '19:45') }, // 45
      ]),
    ).toBe(75)
  })

  it('un tramo que EMPIEZA antes del fin del turno sólo aporta su parte posterior', () => {
    expect(extra([{ entrada: t(DIA, '16:00'), salida: t(DIA, '18:00') }])).toBe(60)
  })

  it('tramos que se SOLAPAN entre sí cuentan una vez', () => {
    // Dos checadas mal capturadas que se pisan: 17:00–19:00 y 18:00–19:30 → unión 2h30.
    expect(
      extra([
        { entrada: t(DIA, '17:00'), salida: t(DIA, '19:00') },
        { entrada: t(DIA, '18:00'), salida: t(DIA, '19:30') },
      ]),
    ).toBe(150)
  })

  it('el orden en que llegan no cambia el resultado', () => {
    const a = { entrada: t(DIA, '18:00'), salida: t(DIA, '19:00') }
    const b = { entrada: t(DIA, '09:00'), salida: t(DIA, '17:00') }
    expect(extra([a, b])).toBe(extra([b, a]))
  })
})

describe('regresión: una sola checada da lo MISMO que antes', () => {
  it('sale 2 h tarde → 120', () => {
    expect(extra([{ entrada: t(DIA, '09:00'), salida: t(DIA, '19:00') }])).toBe(120)
  })

  it('sale a su hora → 0', () => {
    expect(extra([{ entrada: t(DIA, '09:00'), salida: t(DIA, '17:00') }])).toBe(0)
  })

  it('sale antes → 0, nunca negativo', () => {
    expect(extra([{ entrada: t(DIA, '09:00'), salida: t(DIA, '15:30') }])).toBe(0)
  })

  it('llegar temprano sigue sin contar', () => {
    expect(extra([{ entrada: t(DIA, '07:00'), salida: t(DIA, '17:00') }])).toBe(0)
  })

  it('un descanso dentro de la hora extra se sigue descontando', () => {
    expect(extra([{ entrada: t(DIA, '09:00'), salida: t(DIA, '19:00') }], [{ startTime: t(DIA, '17:30'), endTime: t(DIA, '18:00') }])).toBe(
      90,
    )
  })

  it('un descanso dentro de la jornada ordinaria no toca la extra', () => {
    expect(extra([{ entrada: t(DIA, '09:00'), salida: t(DIA, '19:00') }], [{ startTime: t(DIA, '14:00'), endTime: t(DIA, '15:00') }])).toBe(
      120,
    )
  })

  it('descansos solapados siguen contando una vez', () => {
    expect(
      extra(
        [{ entrada: t(DIA, '09:00'), salida: t(DIA, '19:00') }],
        [
          { startTime: t(DIA, '17:30'), endTime: t(DIA, '18:30') },
          { startTime: t(DIA, '18:00'), endTime: t(DIA, '18:30') },
        ],
      ),
    ).toBe(60)
  })
})

describe('bordes', () => {
  it('sin intervalos → 0', () => {
    expect(extra([])).toBe(0)
  })

  it('🔴 un intervalo ABIERTO (sin salida) no aporta: no se paga lo que no se puede probar', () => {
    expect(extra([{ entrada: t(DIA, '18:00'), salida: null }])).toBe(0)
  })

  it('un intervalo abierto NO anula los cerrados que sí hay', () => {
    expect(
      extra([
        { entrada: t(DIA, '18:00'), salida: t(DIA, '19:00') },
        { entrada: t(DIA, '19:30'), salida: null },
      ]),
    ).toBe(60)
  })

  it('🔴 una checada MALFORMADA (salida antes de la entrada) se ignora, no resta', () => {
    // Salió del propio /full-testing: un script dejó una así en la base y la rejilla la usó
    // sin quejarse.
    expect(
      extra([
        { entrada: t(DIA, '18:00'), salida: t(DIA, '19:00') },
        { entrada: t(DIA, '20:00'), salida: t(DIA, '15:00') },
      ]),
    ).toBe(60)
  })

  it('sin cuadrante no se juzga', () => {
    expect(
      minutosExtraDelDia({
        turno: { date: DIA, expectedStart: null, expectedEnd: null },
        intervalos: [{ entrada: t(DIA, '09:00'), salida: t(DIA, '23:00') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(0)
  })
})

describe('turno nocturno', () => {
  const NOCTURNO = { date: DIA, expectedStart: '22:00', expectedEnd: '06:00' }

  it('la salida esperada sigue anclada al día SIGUIENTE', () => {
    expect(
      minutosExtraDelDia({
        turno: NOCTURNO,
        intervalos: [{ entrada: t(DIA, '22:00'), salida: t('2026-08-25', '07:30') }],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(90)
  })

  it('y el hueco también se descuenta en el nocturno', () => {
    expect(
      minutosExtraDelDia({
        turno: NOCTURNO,
        intervalos: [
          { entrada: t(DIA, '22:00'), salida: t('2026-08-25', '06:00') },
          { entrada: t('2026-08-25', '07:00'), salida: t('2026-08-25', '07:30') },
        ],
        descansos: [],
        timezone: TZ,
      }),
    ).toBe(30)
  })
})
