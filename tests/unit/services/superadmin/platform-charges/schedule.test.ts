import type { PlatformChargeFrequency } from '@prisma/client'
import {
  addDays,
  calendarDayToDb,
  dbToCalendarDay,
  isSamePeriodAsMarked,
  monthBoundsInMexico,
  occurrenceDatesBetween,
  todayInMexico,
} from '@/services/superadmin/platform-charges/schedule'

/**
 * «Por cobrar» — fechas de calendario de CDMX (spec 2026-11-02-por-cobrar-superadmin §3.1).
 * Todo es 'YYYY-MM-DD' sin hora; la aritmética es de calendario sobre UTC y NO depende de la zona del proceso.
 * Esta suite se corre también con `TZ=UTC` y con `TZ=America/Mexico_City` (la zona se fija ANTES de que arranque Jest:
 * un `process.env.TZ` asignado dentro de una prueba no llega al proceso real).
 */

interface CasoDePeriodicidad {
  nombre: string
  frecuencia: PlatformChargeFrequency
  ancla: string
  desde: string
  hasta: string
  esperado: string[]
}

describe('platform-charges/schedule — occurrenceDatesBetween (NEW)', () => {
  // Cada renglón es un caso de la tabla de la tarea 1 / §3.1 de la spec.
  const TABLA: CasoDePeriodicidad[] = [
    {
      nombre: 'semanal: cruza de año contando de 7 en 7 desde el ancla',
      frecuencia: 'WEEKLY',
      ancla: '2026-12-28',
      desde: '2026-12-28',
      hasta: '2027-01-11',
      esperado: ['2026-12-28', '2027-01-04', '2027-01-11'],
    },
    {
      nombre: 'semanal: nunca antes del ancla',
      frecuencia: 'WEEKLY',
      ancla: '2026-11-10',
      desde: '2026-11-01',
      hasta: '2026-11-09',
      esperado: [],
    },
    {
      nombre: 'mensual: el día 31 cae al último día de cada mes (31 ene, 28 feb, 31 mar, 30 abr)',
      frecuencia: 'MONTHLY',
      ancla: '2027-01-31',
      desde: '2027-01-31',
      hasta: '2027-04-30',
      esperado: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'],
    },
    {
      nombre: 'mensual: febrero bisiesto',
      frecuencia: 'MONTHLY',
      ancla: '2028-01-31',
      desde: '2028-02-01',
      hasta: '2028-02-29',
      esperado: ['2028-02-29'],
    },
    {
      nombre: 'quincenal: ancla 1 da el 1 y el 16',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-11-01',
      desde: '2026-11-01',
      hasta: '2026-12-01',
      esperado: ['2026-11-01', '2026-11-16', '2026-12-01'],
    },
    {
      nombre: 'quincenal: ancla 15 da el 15 y el 30 (en febrero, el 28)',
      frecuencia: 'BIWEEKLY',
      ancla: '2027-02-15',
      desde: '2027-02-15',
      hasta: '2027-03-15',
      esperado: ['2027-02-15', '2027-02-28', '2027-03-15'],
    },
    {
      nombre: 'quincenal: ancla 20 da el 5 y el 20',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-11-20',
      desde: '2026-11-20',
      hasta: '2026-12-20',
      esperado: ['2026-11-20', '2026-12-05', '2026-12-20'],
    },
    {
      nombre: 'quincenal: el 5 de nov es antes del ancla (20 nov), no cuenta',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-11-20',
      desde: '2026-11-01',
      hasta: '2026-11-19',
      esperado: [],
    },
    {
      nombre: 'quincenal: ancla 31 da el 16 y el 31 (noviembre tiene 30)',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-10-31',
      desde: '2026-10-31',
      hasta: '2026-11-30',
      esperado: ['2026-10-31', '2026-11-16', '2026-11-30'],
    },
  ]

  it.each(TABLA)('$nombre', ({ frecuencia, ancla, desde, hasta, esperado }) => {
    expect(occurrenceDatesBetween(frecuencia, ancla, desde, hasta)).toEqual(esperado)
  })

  // Casos que la tabla no cubre y que un error de calendario sí rompería.
  const EXTRAS: CasoDePeriodicidad[] = [
    {
      nombre: 'semanal: un rango que arranca a media semana toma la primera fecha de la serie dentro del rango',
      frecuencia: 'WEEKLY',
      ancla: '2026-11-02',
      desde: '2026-11-10',
      hasta: '2026-11-24',
      esperado: ['2026-11-16', '2026-11-23'],
    },
    {
      nombre: 'semanal: los dos extremos del rango son inclusivos',
      frecuencia: 'WEEKLY',
      ancla: '2026-11-02',
      desde: '2026-11-09',
      hasta: '2026-11-16',
      esperado: ['2026-11-09', '2026-11-16'],
    },
    {
      nombre: 'mensual: se cuenta desde el día del ancla, no desde el mes anterior (30 → 28 feb → 30 mar)',
      frecuencia: 'MONTHLY',
      ancla: '2026-11-30',
      desde: '2026-11-30',
      hasta: '2027-03-31',
      esperado: ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28', '2027-03-30'],
    },
    {
      nombre: 'mensual: cruza de año',
      frecuencia: 'MONTHLY',
      ancla: '2026-12-15',
      desde: '2026-12-01',
      hasta: '2027-02-15',
      esperado: ['2026-12-15', '2027-01-15', '2027-02-15'],
    },
    {
      nombre: 'mensual: el rango arranca después del día del mes y salta ese mes',
      frecuencia: 'MONTHLY',
      ancla: '2026-01-10',
      desde: '2026-03-11',
      hasta: '2026-05-09',
      esperado: ['2026-04-10'],
    },
    {
      nombre: 'quincenal: un rango a media quincena sólo trae las fechas de adentro',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-11-01',
      desde: '2026-12-02',
      hasta: '2026-12-20',
      esperado: ['2026-12-16'],
    },
    {
      nombre: 'quincenal: ancla 15 en febrero bisiesto da el 15 y el 29',
      frecuencia: 'BIWEEKLY',
      ancla: '2028-01-15',
      desde: '2028-02-01',
      hasta: '2028-02-29',
      esperado: ['2028-02-15', '2028-02-29'],
    },
    {
      nombre: 'quincenal: ancla 31 en febrero da el 16 y el 28',
      frecuencia: 'BIWEEKLY',
      ancla: '2027-01-31',
      desde: '2027-02-01',
      hasta: '2027-02-28',
      esperado: ['2027-02-16', '2027-02-28'],
    },
    {
      nombre: 'quincenal: cruza de año con ancla 16 (1 y 16)',
      frecuencia: 'BIWEEKLY',
      ancla: '2026-12-16',
      desde: '2026-12-16',
      hasta: '2027-01-16',
      esperado: ['2026-12-16', '2027-01-01', '2027-01-16'],
    },
    {
      nombre: 'un rango al revés (desde > hasta) no trae nada',
      frecuencia: 'WEEKLY',
      ancla: '2026-11-02',
      desde: '2026-11-30',
      hasta: '2026-11-02',
      esperado: [],
    },
    {
      nombre: 'un rango de un solo día que cae en la serie trae ese día',
      frecuencia: 'MONTHLY',
      ancla: '2026-11-15',
      desde: '2027-02-15',
      hasta: '2027-02-15',
      esperado: ['2027-02-15'],
    },
  ]

  it.each(EXTRAS)('$nombre', ({ frecuencia, ancla, desde, hasta, esperado }) => {
    expect(occurrenceDatesBetween(frecuencia, ancla, desde, hasta)).toEqual(esperado)
  })

  it.each([
    ['2026-02-30', 'un día que no existe'],
    ['2026-13-01', 'un mes que no existe'],
    ['2026-1-5', 'sin ceros a la izquierda'],
    ['2026-11-02T00:00:00Z', 'un instante en vez de un día'],
    ['', 'vacío'],
  ])('rechaza el ancla %j (%s) en vez de inventar fechas', ancla => {
    expect(() => occurrenceDatesBetween('WEEKLY', ancla, '2026-11-01', '2026-12-01')).toThrow(/Día de calendario inválido/)
  })

  it('rechaza un extremo del rango que no es un día de calendario', () => {
    expect(() => occurrenceDatesBetween('WEEKLY', '2026-11-02', '2026-11-31', '2026-12-01')).toThrow(/Día de calendario inválido/)
    expect(() => occurrenceDatesBetween('WEEKLY', '2026-11-02', '2026-11-01', 'mañana')).toThrow(/Día de calendario inválido/)
  })
})

describe('platform-charges/schedule — propiedades que no se pueden romper (REGRESSION)', () => {
  const FRECUENCIAS: PlatformChargeFrequency[] = ['WEEKLY', 'BIWEEKLY', 'MONTHLY']
  // Un ancla por cada día del mes (también los que febrero no tiene) y por dos años distintos (uno bisiesto).
  const ANCLAS = [...Array.from({ length: 31 }, (_, i) => `2027-01-${String(i + 1).padStart(2, '0')}`), '2028-01-31', '2028-02-29']
  const ultimoDia = (dia: string) => {
    const [y, m] = dia.split('-').map(Number)
    return new Date(Date.UTC(y, m, 0)).getUTCDate()
  }

  it.each(FRECUENCIAS)('%s: ascendente, sin repetidos, nunca antes del ancla y siempre dentro del rango', frecuencia => {
    for (const ancla of ANCLAS) {
      const desde = addDays(ancla, -40)
      const hasta = addDays(ancla, 800)
      const fechas = occurrenceDatesBetween(frecuencia, ancla, desde, hasta)
      expect(fechas.length).toBeGreaterThan(0)
      expect(fechas[0]).toBe(ancla) // la primera ocurrencia cae en el ancla
      for (let i = 0; i < fechas.length; i++) {
        expect(fechas[i] >= ancla).toBe(true)
        expect(fechas[i] >= desde && fechas[i] <= hasta).toBe(true)
        if (i > 0) expect(fechas[i] > fechas[i - 1]).toBe(true)
      }
    }
  })

  it('MONTHLY: cada fecha es el día del ancla, o el último del mes si el mes no lo tiene', () => {
    for (const ancla of ANCLAS) {
      const diaAncla = Number(ancla.slice(8))
      for (const fecha of occurrenceDatesBetween('MONTHLY', ancla, ancla, addDays(ancla, 800))) {
        expect(Number(fecha.slice(8))).toBe(Math.min(diaAncla, ultimoDia(fecha)))
      }
    }
  })

  it('BIWEEKLY: dos fechas por mes como máximo, separadas por 15 días de calendario (con el tope al último día)', () => {
    for (const ancla of ANCLAS) {
      const diaAncla = Number(ancla.slice(8))
      const fijos = diaAncla <= 15 ? [diaAncla, diaAncla + 15] : [diaAncla - 15, diaAncla]
      const porMes = new Map<string, number[]>()
      for (const fecha of occurrenceDatesBetween('BIWEEKLY', ancla, ancla, addDays(ancla, 800))) {
        const mes = fecha.slice(0, 7)
        porMes.set(mes, [...(porMes.get(mes) ?? []), Number(fecha.slice(8))])
      }
      for (const [mes, dias] of porMes) {
        expect(dias.length).toBeLessThanOrEqual(2)
        const permitidos = fijos.map(d => Math.min(d, ultimoDia(`${mes}-01`)))
        for (const dia of dias) expect(permitidos).toContain(dia)
      }
    }
  })

  it('WEEKLY: toda fecha está a un múltiplo de 7 días del ancla', () => {
    const msPorDia = 86_400_000
    for (const ancla of ANCLAS) {
      for (const fecha of occurrenceDatesBetween('WEEKLY', ancla, ancla, addDays(ancla, 400))) {
        const dias = (Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${ancla}T00:00:00Z`)) / msPorDia
        expect(dias % 7).toBe(0)
      }
    }
  })
})

describe('platform-charges/schedule — addDays (NEW)', () => {
  it.each<[string, number, string]>([
    ['2026-11-02', 0, '2026-11-02'],
    ['2026-11-02', 1, '2026-11-03'],
    ['2026-02-28', 1, '2026-03-01'], // febrero sin bisiesto
    ['2028-02-28', 1, '2028-02-29'], // febrero bisiesto
    ['2028-02-29', 1, '2028-03-01'],
    ['2026-12-31', 1, '2027-01-01'], // cruza de año
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-11-02', 7, '2026-11-09'],
    ['2026-11-02', -366, '2025-11-01'], // el límite de la validación del ancla (hoy − 366)
    ['2026-11-02', 366, '2027-11-03'], // y hoy + 366
  ])('addDays(%s, %i) = %s', (dia, n, esperado) => {
    expect(addDays(dia, n)).toBe(esperado)
  })

  it('rechaza algo que no es un día de calendario', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(/Día de calendario inválido/)
  })
})

describe('platform-charges/schedule — todayInMexico (NEW)', () => {
  it.each([
    ['2026-11-03T05:30:00Z', '2026-11-02'], // 23:30 en CDMX: todavía es el día 2 aunque en UTC ya sea el 3
    ['2026-11-03T05:59:59.999Z', '2026-11-02'], // el último milisegundo del día 2
    ['2026-11-03T06:00:00Z', '2026-11-03'], // la medianoche de CDMX
    ['2026-11-02T12:00:00Z', '2026-11-02'],
    ['2026-01-01T00:00:00Z', '2025-12-31'], // el año todavía no cambia en CDMX
    ['2026-07-01T05:30:00Z', '2026-06-30'], // sin horario de verano (México lo quitó en 2022): sigue siendo UTC−6
  ])('%s → %s', (instante, esperado) => {
    expect(todayInMexico(new Date(instante))).toBe(esperado)
  })
})

describe('platform-charges/schedule — calendarDayToDb / dbToCalendarDay (NEW)', () => {
  it('calendarDayToDb es la medianoche UTC, como Prisma lee un @db.Date', () => {
    expect(calendarDayToDb('2026-11-02').toISOString()).toBe('2026-11-02T00:00:00.000Z')
  })

  it('dbToCalendarDay lee esa medianoche UTC como el mismo día', () => {
    expect(dbToCalendarDay(new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02')
  })

  it.each(['2026-11-02', '2026-01-01', '2026-12-31', '2028-02-29', '2027-03-01'])('ida y vuelta de %s', dia => {
    expect(dbToCalendarDay(calendarDayToDb(dia))).toBe(dia)
  })

  it('calendarDayToDb rechaza algo que no es un día de calendario', () => {
    expect(() => calendarDayToDb('2026-02-30')).toThrow(/Día de calendario inválido/)
  })
})

describe('platform-charges/schedule — monthBoundsInMexico (NEW)', () => {
  it('noviembre de 2026: de la medianoche de CDMX del 1-nov (06:00 UTC) a la del 1-dic', () => {
    const { from, to } = monthBoundsInMexico('2026-11-17')

    expect(from.toISOString()).toBe('2026-11-01T06:00:00.000Z')
    expect(to.toISOString()).toBe('2026-12-01T06:00:00.000Z')
  })

  it('diciembre cruza de año: el fin es el 1-ene del año siguiente', () => {
    const { from, to } = monthBoundsInMexico('2026-12-31')

    expect(from.toISOString()).toBe('2026-12-01T06:00:00.000Z')
    expect(to.toISOString()).toBe('2027-01-01T06:00:00.000Z')
  })

  it('el primero y el último día del mes caen en el mismo mes', () => {
    expect(monthBoundsInMexico('2026-02-01')).toEqual(monthBoundsInMexico('2026-02-28'))
  })

  it('un 31 de octubre a las 23:30 de CDMX (ya es 1-nov en UTC) todavía es octubre: el mes se saca del día de CDMX, no del instante', () => {
    const hoy = todayInMexico(new Date('2026-11-01T05:30:00Z'))
    const { from, to } = monthBoundsInMexico(hoy)

    expect(hoy).toBe('2026-10-31')
    expect(from.toISOString()).toBe('2026-10-01T06:00:00.000Z')
    expect(to.toISOString()).toBe('2026-11-01T06:00:00.000Z')
  })

  it('rechaza algo que no es un día de calendario', () => {
    expect(() => monthBoundsInMexico('2026-13-01')).toThrow(/Día de calendario inválido/)
  })
})

describe('platform-charges/schedule — isSamePeriodAsMarked (NEW)', () => {
  it.each<[PlatformChargeFrequency, string, string, boolean, string]>([
    ['MONTHLY', '2026-11-03', '2026-11-04', true, 'se movió a mañana'],
    ['MONTHLY', '2026-11-03', '2026-11-20', true, 'se movió más tarde, en el mismo mes'],
    ['MONTHLY', '2026-11-03', '2026-12-01', false, 'se movió a antes: el mes que viene sí toca'],
    ['MONTHLY', '2026-10-31', '2026-11-01', true, 'cruza de mes, pero es un día después de lo pagado'],
    ['BIWEEKLY', '2026-11-03', '2026-11-05', true, 'dos días después'],
    ['BIWEEKLY', '2026-11-03', '2026-11-15', false, 'ya es la otra quincena'],
    ['WEEKLY', '2026-11-03', '2026-11-05', true, 'dos días después'],
    ['WEEKLY', '2026-11-03', '2026-11-09', false, 'ya es la otra semana'],
    ['MONTHLY', '2026-11-03', '2026-11-03', false, 'la misma fecha la cuida la llave única'],
    ['MONTHLY', '2026-11-03', '2026-10-20', false, 'lo anterior a lo marcado no se toca'],
  ])('%s: marcado el %s, ¿el %s es del mismo periodo? %s (%s)', (frecuencia, marcado, dia, esperado) => {
    expect(isSamePeriodAsMarked(frecuencia, marcado, dia)).toBe(esperado)
  })

  it('🔴 el calendario normal nunca se salta: con cualquier ancla y durante 3 años, dos fechas seguidas jamás cuentan como el mismo periodo', () => {
    const frecuencias: PlatformChargeFrequency[] = ['WEEKLY', 'BIWEEKLY', 'MONTHLY']
    for (const frecuencia of frecuencias) {
      for (let d = 1; d <= 31; d++) {
        const ancla = `2026-01-${String(d).padStart(2, '0')}`
        const fechas = occurrenceDatesBetween(frecuencia, ancla, ancla, '2028-12-31')
        expect(fechas.length).toBeGreaterThan(30)
        fechas.slice(1).forEach((fecha, i) => {
          expect([frecuencia, ancla, fechas[i], fecha, isSamePeriodAsMarked(frecuencia, fechas[i], fecha)]).toEqual([
            frecuencia,
            ancla,
            fechas[i],
            fecha,
            false,
          ])
        })
      }
    }
  })
})
