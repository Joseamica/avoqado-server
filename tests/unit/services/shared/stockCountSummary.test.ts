import { Prisma } from '@prisma/client'
import { resumirConteo, estadoParaClientes, UNIDAD_DE_PRODUCTO } from '@/services/shared/stockCountSummary'

/**
 * La regla única de «qué resume un conteo». Nació del conteo de Mindform del
 * 2026-09-03: 138 líneas, NINGUNA contada, y el dashboard reportaba
 * «110 con diferencia · −6968054.083999999» porque sumaba counted−expected
 * de líneas que nadie tocó, mezclando gramos con piezas, en flotantes.
 */
describe('resumirConteo — sólo cuenta lo que se contó', () => {
  const linea = (o: Partial<LineaLike>): LineaLike => ({ expected: 0, counted: 0, countedAt: null, unit: null, ...o })
  type LineaLike = { expected: number | string; counted: number | string; countedAt: Date | string | null; unit: string | null }

  it('un conteo sin una sola línea contada resume 0 contadas y SIN diferencias', () => {
    const r = resumirConteo([linea({ expected: 20 }), linea({ expected: 6729329, unit: 'GRAM' }), linea({ expected: 0 })])
    expect(r).toEqual({ itemCount: 3, countedCount: 0, matchedCount: 0, mismatchedCount: 0, differenceByUnit: [] })
  })

  it('una línea con expected 0 y counted 0 SIN countedAt no «coincide»: no se contó', () => {
    const r = resumirConteo([linea({ expected: 0, counted: 0, countedAt: null })])
    expect(r.matchedCount).toBe(0)
    expect(r.countedCount).toBe(0)
  })

  it('separa la diferencia POR UNIDAD y los productos van en PIECE', () => {
    const r = resumirConteo([
      linea({ expected: 20, counted: 18, countedAt: new Date(), unit: null }),
      linea({ expected: 500, counted: 350, countedAt: new Date(), unit: 'GRAM' }),
      linea({ expected: 2, counted: 2, countedAt: new Date(), unit: 'LITER' }),
    ])
    expect(r.countedCount).toBe(3)
    expect(r.matchedCount).toBe(1)
    expect(r.mismatchedCount).toBe(2)
    expect(r.differenceByUnit).toEqual([
      { unit: 'GRAM', difference: -150 },
      { unit: 'LITER', difference: 0 },
      { unit: UNIDAD_DE_PRODUCTO, difference: -2 },
    ])
  })

  it('suma con Decimal, no con flotantes: 0.1 + 0.2 da 0.3, no 0.30000000000000004', () => {
    const r = resumirConteo([
      linea({ expected: 0, counted: 0.1, countedAt: new Date(), unit: 'KILOGRAM' }),
      linea({ expected: 0, counted: 0.2, countedAt: new Date(), unit: 'KILOGRAM' }),
    ])
    expect(r.differenceByUnit).toEqual([{ unit: 'KILOGRAM', difference: 0.3 }])
  })

  it('acepta Prisma.Decimal y strings tal como salen de la base', () => {
    const r = resumirConteo([
      {
        expected: new Prisma.Decimal('6729329.000'),
        counted: new Prisma.Decimal('0.000'),
        countedAt: '2026-09-07T22:51:00.000Z',
        unit: 'GRAM',
      },
      { expected: '24.000', counted: '24.000', countedAt: '2026-09-07T22:51:00.000Z', unit: null },
    ])
    expect(r.differenceByUnit).toEqual([
      { unit: 'GRAM', difference: -6729329 },
      { unit: 'PIECE', difference: 0 },
    ])
    expect(r.matchedCount).toBe(1)
  })

  // Ésta es la prueba que de verdad guarda «Decimal y no flotantes»: la de «0.1 + 0.2» también pasa con flotantes, porque el redondeo le esconde el ruido.
  it('redondea a 3 decimales (la columna es Decimal(12,3))', () => {
    const r = resumirConteo([linea({ expected: '1.0005', counted: '1.0', countedAt: new Date(), unit: 'LITER' })])
    expect(r.differenceByUnit[0].difference).toBe(-0.001)
  })
})

describe('estadoParaClientes', () => {
  it('APPLYING se enseña como IN_PROGRESS (las apps no conocen APPLYING)', () => {
    expect(estadoParaClientes('APPLYING')).toBe('IN_PROGRESS')
  })
  it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'])('%s pasa tal cual', s => {
    expect(estadoParaClientes(s)).toBe(s)
  })
})
