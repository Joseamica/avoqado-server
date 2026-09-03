/**
 * Piezas puras de los resúmenes de /payments y /orders (2026-09-01).
 *
 *  - el tope de página: un pageSize hostil cae al tope, nunca revienta;
 *  - `amountPredicate` produce el SQL con la misma aritmética que el cliente
 *    (`value || 0`, between inclusivo);
 *  - `foldRowsIntoGroups` / `paymentRowPassesClientFilters`: el camino de MindForm,
 *    cuyas filas viven en OTRA base y no pueden probarse en integración.
 */
import { Prisma } from '@prisma/client'
import {
  LIST_PAGE_SIZE_DEFAULT,
  LIST_PAGE_SIZE_MAX,
  amountFilterFromQuery,
  amountPredicate,
  andAll,
  clampPage,
  clampPageSize,
  orAny,
  parseCsv,
  passesAmountFilter,
} from '@/services/dashboard/listSummary.shared'
import { foldRowsIntoGroups, paymentRowPassesClientFilters } from '@/services/dashboard/paymentSummary.dashboard.service'

describe('clampPageSize — el tope real del listado', () => {
  it.each([
    ['10000', LIST_PAGE_SIZE_MAX],
    [10000, LIST_PAGE_SIZE_MAX],
    ['100', 100],
    ['101', LIST_PAGE_SIZE_MAX],
    ['50', 50],
    ['1', 1],
    ['0', LIST_PAGE_SIZE_DEFAULT],
    ['-3', LIST_PAGE_SIZE_DEFAULT],
    ['abc', LIST_PAGE_SIZE_DEFAULT],
    [undefined, LIST_PAGE_SIZE_DEFAULT],
    ['', LIST_PAGE_SIZE_DEFAULT],
    ['7.9', 7],
  ])('pageSize=%p → %p', (raw, esperado) => {
    expect(clampPageSize(raw)).toBe(esperado)
  })

  it('el tope es 100 y el default 10 (regla bounded-queries)', () => {
    expect(LIST_PAGE_SIZE_MAX).toBe(100)
    expect(LIST_PAGE_SIZE_DEFAULT).toBe(10)
  })

  it.each([
    ['3', 3],
    ['0', 1],
    ['-1', 1],
    ['x', 1],
    [undefined, 1],
  ])('clampPage(%p) → %p', (raw, esperado) => {
    expect(clampPage(raw)).toBe(esperado)
  })
})

describe('parseCsv', () => {
  it('parte por comas, recorta y descarta vacíos', () => {
    expect(parseCsv(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(parseCsv('')).toBeUndefined()
    expect(parseCsv(',,')).toBeUndefined()
    expect(parseCsv(undefined)).toBeUndefined()
    expect(parseCsv(['a,b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('amountPredicate — misma aritmética que el navegador', () => {
  const col = Prisma.sql`p."amount"`
  const texto = (s: Prisma.Sql) => s.sql.replace(/\s+/g, ' ').trim()

  it('gt/lt/eq/between con los valores como binds', () => {
    const gt = amountPredicate(col, { operator: 'gt', value: 100 })
    expect(texto(gt)).toBe('p."amount" > (?)::numeric')
    expect(gt.values).toEqual(['100'])

    const between = amountPredicate(col, { operator: 'between', value: 1, value2: 2 })
    expect(texto(between)).toBe('(p."amount" >= (?)::numeric AND p."amount" <= (?)::numeric)')
    expect(between.values).toEqual(['1', '2'])
  })

  it('🔴 los centavos viajan como TEXTO casteado a numeric: un float bindeado llega como 99.98999999999999', () => {
    expect(amountPredicate(col, { operator: 'eq', value: 99.99 }).values).toEqual(['99.99'])
    expect(amountPredicate(col, { operator: 'lt', value: 0.1 + 0.2 }).values).toEqual(['0.30000000000000004'])
  })

  it('un valor ausente cuenta como 0, igual que `filter.value || 0`', () => {
    expect(amountPredicate(col, { operator: 'gt' }).values).toEqual(['0'])
    expect(amountPredicate(col, { operator: 'between', value: 5 }).values).toEqual(['5', '0'])
  })

  it('sin filtro → TRUE', () => {
    expect(texto(amountPredicate(col, undefined))).toBe('TRUE')
  })

  it('passesAmountFilter es la réplica exacta', () => {
    expect(passesAmountFilter(100, { operator: 'gt', value: 100 })).toBe(false)
    expect(passesAmountFilter(100.01, { operator: 'gt', value: 100 })).toBe(true)
    expect(passesAmountFilter(2, { operator: 'between', value: 1, value2: 2 })).toBe(true)
    expect(passesAmountFilter(-50, { operator: 'gt' })).toBe(false)
    expect(passesAmountFilter(150, { operator: 'eq', value: 150 })).toBe(true)
  })
})

describe('amountFilterFromQuery', () => {
  it('lee <prefijo>Op/Value/Value2 y sin operador no hay filtro', () => {
    expect(amountFilterFromQuery({ subtotalOp: 'between', subtotalValue: '10', subtotalValue2: '20' }, 'subtotal')).toEqual({
      operator: 'between',
      value: 10,
      value2: 20,
    })
    expect(amountFilterFromQuery({ subtotalValue: '10' }, 'subtotal')).toBeUndefined()
    expect(amountFilterFromQuery({ tipOp: 'gt', tipValue: '' }, 'tip')).toEqual({ operator: 'gt', value: undefined, value2: undefined })
    expect(amountFilterFromQuery({ tipOp: 'DROP TABLE' }, 'tip')).toBeUndefined()
  })
})

describe('andAll / orAny', () => {
  const texto = (s: Prisma.Sql) => s.sql.replace(/\s+/g, ' ').trim()
  it('vacíos: AND → TRUE, OR → FALSE (como `OR: []` de Prisma, que no casa nada)', () => {
    expect(texto(andAll([]))).toBe('TRUE')
    expect(texto(orAny([]))).toBe('FALSE')
  })
  it('envuelve cada parte en paréntesis', () => {
    expect(texto(andAll([Prisma.sql`a = 1`, Prisma.sql`b = 2`]))).toBe('(a = 1) AND (b = 2)')
    expect(texto(orAny([Prisma.sql`a = 1`, Prisma.sql`b = 2`]))).toBe('((a = 1) OR (b = 2))')
  })
})

describe('foldRowsIntoGroups — las filas legacy de MindForm se suman a los grupos', () => {
  it('suma a un grupo existente y crea los que faltan, sin mutar la entrada', () => {
    const base = [{ status: 'COMPLETED', type: 'REGULAR', count: 2, amount: 100, tipAmount: 10 }]
    const out = foldRowsIntoGroups(base, [
      { status: 'COMPLETED', type: 'REGULAR', amount: '50.25', tipAmount: '5' },
      { status: 'REFUNDED', type: 'REGULAR', amount: 7, tipAmount: 0 },
      { status: 'REFUNDED', amount: 3, tipAmount: 0 },
    ])
    expect(base[0].count).toBe(2)
    expect(out).toEqual([
      { status: 'COMPLETED', type: 'REGULAR', count: 3, amount: 150.25, tipAmount: 15 },
      { status: 'REFUNDED', type: 'REGULAR', count: 1, amount: 7, tipAmount: 0 },
      { status: 'REFUNDED', type: null, count: 1, amount: 3, tipAmount: 0 },
    ])
  })

  it('sin filas devuelve una copia igual', () => {
    const base = [{ status: 'COMPLETED', type: 'REGULAR', count: 1, amount: 1, tipAmount: 0 }]
    expect(foldRowsIntoGroups(base, [])).toEqual(base)
  })
})

describe('paymentRowPassesClientFilters — la réplica en Node de los filtros del navegador', () => {
  const visa = { amount: 150, tipAmount: 15, cardBrand: 'VISA', processorData: { isInternational: true } }
  const amexFallback = {
    amount: 99.99,
    tipAmount: 0,
    cardBrand: null,
    processorData: { cardBrand: 'american_express', isInternational: 'false' },
  }
  const cash = { amount: 100.5, tipAmount: 10.25, cardBrand: null, processorData: null }

  it('sin filtros pasa todo', () => {
    expect(paymentRowPassesClientFilters(cash, undefined)).toBe(true)
    expect(paymentRowPassesClientFilters(cash, {})).toBe(true)
  })

  it('total = monto + propina', () => {
    expect(paymentRowPassesClientFilters(visa, { total: { operator: 'eq', value: 165 } })).toBe(true)
    expect(paymentRowPassesClientFilters(cash, { total: { operator: 'between', value: 110.75, value2: 110.75 } })).toBe(true)
    expect(paymentRowPassesClientFilters(cash, { total: { operator: 'gt', value: 110.75 } })).toBe(false)
  })

  it('internacional: true o "true" cuentan como sí; false, "false", null y sin processorData como no', () => {
    expect(paymentRowPassesClientFilters(visa, { international: ['yes'] })).toBe(true)
    expect(paymentRowPassesClientFilters({ ...visa, processorData: { isInternational: 'true' } }, { international: ['yes'] })).toBe(true)
    expect(paymentRowPassesClientFilters(amexFallback, { international: ['yes'] })).toBe(false)
    expect(paymentRowPassesClientFilters(cash, { international: ['no'] })).toBe(true)
    expect(paymentRowPassesClientFilters(visa, { international: ['no'] })).toBe(false)
    expect(paymentRowPassesClientFilters(visa, { international: ['yes', 'no'] })).toBe(true)
  })

  it('marca: columna primero, luego processorData, siempre en mayúsculas', () => {
    expect(paymentRowPassesClientFilters(visa, { cardBrands: ['VISA'] })).toBe(true)
    expect(paymentRowPassesClientFilters(amexFallback, { cardBrands: ['AMERICAN_EXPRESS'] })).toBe(true)
    expect(paymentRowPassesClientFilters(amexFallback, { cardBrands: ['american_express'] })).toBe(true)
    expect(paymentRowPassesClientFilters(cash, { cardBrands: ['VISA'] })).toBe(false)
  })
})
