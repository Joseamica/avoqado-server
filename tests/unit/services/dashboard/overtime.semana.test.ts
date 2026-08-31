/**
 * El umbral doble/triple es SEMANAL (art. 67 y 68), así que agrupar bien es la mitad del
 * cálculo. Dos semanas mezcladas producen triples que no existen; una semana partida en dos
 * los esconde.
 */
import { agruparPorSemana } from '@/services/dashboard/overtime'

// Lunes 2026-08-24 … domingo 2026-08-30.
const SEMANA_COMPLETA = { startDate: '2026-08-24', endDate: '2026-08-30' }

describe('agruparPorSemana', () => {
  it('reparte doble y triple sobre el TOTAL de la semana, no día por día', () => {
    // 4 días de 3 h = 12 h. Día por día ninguno pasa de 9; juntos sí.
    const semanas = agruparPorSemana(
      [
        { date: '2026-08-24', minutos: 180 },
        { date: '2026-08-25', minutos: 180 },
        { date: '2026-08-26', minutos: 180 },
        { date: '2026-08-27', minutos: 180 },
      ],
      SEMANA_COMPLETA,
    )
    expect(semanas).toHaveLength(1)
    expect(semanas[0].minutosTotal).toBe(720)
    expect(semanas[0].minutosDobles).toBe(540)
    expect(semanas[0].minutosTriples).toBe(180)
  })

  it('🔴 dos semanas NO se mezclan: cada una tiene su propio umbral de 9 h', () => {
    // 8 h el domingo 30 y 8 h el lunes 31. Mezcladas serían 16 h → 9 dobles + 7 triples.
    // Separadas, las dos están debajo del tope y TODO es doble.
    const semanas = agruparPorSemana(
      [
        { date: '2026-08-30', minutos: 480 },
        { date: '2026-08-31', minutos: 480 },
      ],
      { startDate: '2026-08-24', endDate: '2026-09-06' },
    )
    expect(semanas).toHaveLength(2)
    expect(semanas.every(s => s.minutosTriples === 0)).toBe(true)
    expect(semanas.map(s => s.weekStart)).toEqual(['2026-08-24', '2026-08-31'])
  })

  it('la semana empieza en LUNES y termina en domingo', () => {
    const semanas = agruparPorSemana([{ date: '2026-08-26', minutos: 60 }], SEMANA_COMPLETA)
    expect(semanas[0].weekStart).toBe('2026-08-24')
    expect(semanas[0].weekEnd).toBe('2026-08-30')
  })

  describe('infracciones del art. 66 — se señalan, NO cambian la tarifa', () => {
    // 🔴 Reforma del 1-MAY-2026: el art. 66 pasó de 3 h/3 días a 4 h/4 días. Las versiones
    // anteriores de estas pruebas eran CORRECTAS con la ley de entonces.
    it('un día de más de 4 h queda marcado', () => {
      const semanas = agruparPorSemana([{ date: '2026-08-24', minutos: 300 }], SEMANA_COMPLETA)
      expect(semanas[0].diasSobreTopeDiario).toEqual(['2026-08-24'])
    })

    it('🔴 pero esas 5 h siguen siendo DOBLES si la semana no llegó a 9', () => {
      const semanas = agruparPorSemana([{ date: '2026-08-24', minutos: 300 }], SEMANA_COMPLETA)
      expect(semanas[0].minutosDobles).toBe(300)
      expect(semanas[0].minutosTriples).toBe(0)
    })

    it('exactamente 4 h no es infracción', () => {
      const semanas = agruparPorSemana([{ date: '2026-08-24', minutos: 240 }], SEMANA_COMPLETA)
      expect(semanas[0].diasSobreTopeDiario).toEqual([])
    })

    it('hacer extra más de 4 veces en la semana queda marcado', () => {
      const semanas = agruparPorSemana(
        [
          { date: '2026-08-24', minutos: 30 },
          { date: '2026-08-25', minutos: 30 },
          { date: '2026-08-26', minutos: 30 },
          { date: '2026-08-27', minutos: 30 },
          { date: '2026-08-28', minutos: 30 },
        ],
        SEMANA_COMPLETA,
      )
      expect(semanas[0].diasConExtra).toBe(5)
      expect(semanas[0].excedeDiasPermitidos).toBe(true)
    })

    it('exactamente 3 días no es infracción', () => {
      const semanas = agruparPorSemana(
        [
          { date: '2026-08-24', minutos: 30 },
          { date: '2026-08-25', minutos: 30 },
          { date: '2026-08-26', minutos: 30 },
        ],
        SEMANA_COMPLETA,
      )
      expect(semanas[0].excedeDiasPermitidos).toBe(false)
    })
  })

  it('🔴 una semana que el rango no cubre entera se marca PARCIAL', () => {
    // Pedir del miércoles al viernes no puede afirmar el reparto doble/triple de esa semana:
    // el lunes y el martes quedaron fuera y pudieron traer horas.
    const semanas = agruparPorSemana([{ date: '2026-08-26', minutos: 600 }], {
      startDate: '2026-08-26',
      endDate: '2026-08-28',
    })
    expect(semanas[0].parcial).toBe(true)
  })

  it('una semana cubierta entera NO es parcial', () => {
    const semanas = agruparPorSemana([{ date: '2026-08-26', minutos: 60 }], SEMANA_COMPLETA)
    expect(semanas[0].parcial).toBe(false)
  })

  it('los días sin extra no crean semanas', () => {
    expect(agruparPorSemana([{ date: '2026-08-24', minutos: 0 }], SEMANA_COMPLETA)).toEqual([])
  })

  it('sin días no hay semanas', () => {
    expect(agruparPorSemana([], SEMANA_COMPLETA)).toEqual([])
  })

  it('las semanas salen en orden cronológico', () => {
    const semanas = agruparPorSemana(
      [
        { date: '2026-09-01', minutos: 60 },
        { date: '2026-08-24', minutos: 60 },
      ],
      { startDate: '2026-08-24', endDate: '2026-09-06' },
    )
    expect(semanas.map(s => s.weekStart)).toEqual(['2026-08-24', '2026-08-31'])
  })
})
