/**
 * El umbral doble/triple es SEMANAL (art. 67 y 68), así que agrupar bien es la mitad del
 * cálculo. Dos semanas mezcladas producen triples que no existen; una semana partida en dos
 * los esconde.
 */
import { agruparPorSemana } from '@/services/dashboard/overtime'

// Lunes 2026-08-24 … domingo 2026-08-30.
const SEMANA_COMPLETA = { startDate: '2026-08-24', endDate: '2026-08-30' }

describe('agruparPorSemana', () => {
  it('agrupa por semana sobre el TOTAL, no día por día', () => {
    // 4 días de 3 h caen en la misma semana y suman 12 h en un solo renglón.
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
  })

  it('🔴 dos semanas NO se mezclan: cada una lleva su propio total', () => {
    // 8 h el domingo 30 y 8 h el lunes 31: son semanas DISTINTAS. Juntarlas daría un solo
    // renglón de 16 h y quien calcule la nómina aplicaría el tope una sola vez.
    const semanas = agruparPorSemana(
      [
        { date: '2026-08-30', minutos: 480 },
        { date: '2026-08-31', minutos: 480 },
      ],
      { startDate: '2026-08-24', endDate: '2026-09-06' },
    )
    expect(semanas).toHaveLength(2)
    expect(semanas.map(s => s.minutosTotal)).toEqual([480, 480])
    expect(semanas.map(s => s.weekStart)).toEqual(['2026-08-24', '2026-08-31'])
  })

  it('la semana empieza en LUNES y termina en domingo', () => {
    const semanas = agruparPorSemana([{ date: '2026-08-26', minutos: 60 }], SEMANA_COMPLETA)
    expect(semanas[0].weekStart).toBe('2026-08-24')
    expect(semanas[0].weekEnd).toBe('2026-08-30')
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
