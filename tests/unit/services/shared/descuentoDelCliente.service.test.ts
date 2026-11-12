import { Prisma } from '@prisma/client'
import { descuentosDeLosClientes, llaveDelDescuentoDelCliente } from '@/services/shared/descuentoDelCliente.service'

/**
 * La regla completa vive en la consulta (un ganador por cliente con `DISTINCT ON`): aquí se fija su forma y el mapeo; lo que
 * elige la base se prueba contra Postgres en `tests/integration/tpv/descuentoDelCliente.integration.test.ts`.
 */
// `$queryRaw` se llama como plantilla: (cadenas, ...valores). Se rearma para leer el SQL y sus valores ya aplanados.
const sqlDe = (llamada: any[]) => {
  const consulta = Prisma.sql(llamada[0], ...llamada.slice(1))
  return { texto: consulta.sql.replace(/\s+/g, ' '), valores: consulta.values }
}

describe('descuentosDeLosClientes', () => {
  it('sin ids no consulta', async () => {
    const $queryRaw = jest.fn()
    const mapa = await descuentosDeLosClientes('v1', [], { $queryRaw } as any)
    expect(mapa.size).toBe(0)
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('UNA consulta, un renglón por cliente, con la regla completa y el desempate fijo', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([])
    await descuentosDeLosClientes('v1', ['c1', 'c2'], { $queryRaw } as any)

    expect($queryRaw).toHaveBeenCalledTimes(1)
    const { texto, valores } = sqlDe($queryRaw.mock.calls[0])
    expect(texto).toContain('SELECT DISTINCT ON (cd."customerId")')
    expect(texto).toContain('ORDER BY cd."customerId", d.priority DESC, d.value DESC, d."createdAt" ASC, d.id ASC')
    expect(texto).toContain('COALESCE(cardinality(d."daysOfWeek"), 0) = 0')
    expect(texto).toContain(`d.type IN ('PERCENTAGE', 'FIXED_AMOUNT') AND d.scope = 'ORDER' AND NOT d."requiresApproval"`)
    expect(texto).toContain('d."customerGroupId" IS NULL')
    expect(texto).toContain('cd."maxUses" IS NULL')
    // Fechas como `timestamp` en UTC, nunca un Date pelado (regla de binds de fechas).
    expect(texto.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(4)
    expect(valores).toEqual(expect.arrayContaining(['c1', 'c2', 'v1']))
    expect(texto.trim()).toMatch(/LIMIT \?$/)
    expect(valores[valores.length - 1]).toBe(2)
  })

  it('los ids repetidos cuentan una vez (lista y LIMIT)', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([])
    await descuentosDeLosClientes('v1', ['c1', 'c1', 'c2'], { $queryRaw } as any)

    const { valores } = sqlDe($queryRaw.mock.calls[0])
    expect(valores.filter(v => v === 'c1')).toHaveLength(1)
    expect(valores[valores.length - 1]).toBe(2)
  })

  it('traduce cada ganador a pesos 1:1 (Decimal → número), sin tope = null', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([
      {
        customerId: 'c1',
        discountId: 'd1',
        name: 'Cliente 10 %',
        type: 'PERCENTAGE',
        value: new Prisma.Decimal('10'),
        maxDiscountAmount: null,
      },
      {
        customerId: 'c2',
        discountId: 'd2',
        name: 'Cliente $80',
        type: 'FIXED_AMOUNT',
        value: new Prisma.Decimal('80.50'),
        maxDiscountAmount: new Prisma.Decimal('20'),
      },
    ])
    const mapa = await descuentosDeLosClientes('v1', ['c1', 'c2', 'c3'], { $queryRaw } as any)

    expect(mapa.get('c1')).toEqual({ discountId: 'd1', name: 'Cliente 10 %', type: 'PERCENTAGE', value: 10, maxDiscountAmount: null })
    expect(mapa.get('c2')).toEqual({ discountId: 'd2', name: 'Cliente $80', type: 'FIXED_AMOUNT', value: 80.5, maxDiscountAmount: 20 })
    expect(mapa.has('c3')).toBe(false)
  })
})

describe('llaveDelDescuentoDelCliente', () => {
  it('arma la llave', () => {
    expect(llaveDelDescuentoDelCliente('c1', 'd1')).toBe('descuento-cliente:c1:d1')
  })
})
