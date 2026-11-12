import {
  cuentaComoDescuentoDelCliente,
  elegirDescuentoDelCliente,
  descuentosDeLosClientes,
  llaveDelDescuentoDelCliente,
} from '../../../../src/services/shared/descuentoDelCliente.service'

const AHORA = new Date('2026-11-11T18:00:00Z')
const AYER = new Date('2026-11-10T18:00:00Z')
const MANANA = new Date('2026-11-12T18:00:00Z')

const base = (o: Record<string, any> = {}): any => ({
  id: 'd1',
  venueId: 'v1',
  name: 'Cliente 10 %',
  type: 'PERCENTAGE',
  value: 10,
  scope: 'ORDER',
  active: true,
  priority: 0,
  validFrom: null,
  validUntil: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  maxTotalUses: null,
  maxUsesPerCustomer: null,
  requiresApproval: false,
  customerGroupId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
})
const asig = (o: Record<string, any> = {}) => ({ active: true, validFrom: null, validUntil: null, maxUses: null, ...o })

describe('cuentaComoDescuentoDelCliente', () => {
  it('el descuento base cuenta', () => {
    expect(cuentaComoDescuentoDelCliente(asig(), base(), 'v1', AHORA)).toBe(true)
  })
  it('FIXED_AMOUNT cuenta', () => {
    expect(cuentaComoDescuentoDelCliente(asig(), base({ type: 'FIXED_AMOUNT' }), 'v1', AHORA)).toBe(true)
  })

  const noCuenta: Array<[string, Record<string, any>, Record<string, any>, string?]> = [
    ['type COMP', { type: 'COMP' }, {}],
    ['scope ITEM', { scope: 'ITEM' }, {}],
    ['catálogo inactivo', { active: false }, {}],
    ['catálogo vencido', { validUntil: AYER }, {}],
    ['catálogo aún no vigente', { validFrom: MANANA }, {}],
    ['mínimo de compra', { minPurchaseAmount: 100 }, {}],
    ['días de la semana', { daysOfWeek: [1] }, {}],
    ['hora desde', { timeFrom: '09:00' }, {}],
    ['tope total', { maxTotalUses: 5 }, {}],
    ['tope por cliente', { maxUsesPerCustomer: 1 }, {}],
    ['asignación con maxUses', {}, { maxUses: 2 }],
    ['asignación inactiva', {}, { active: false }],
    ['asignación vencida', {}, { validUntil: AYER }],
    ['asignación aún no vigente', {}, { validFrom: MANANA }],
    ['requiere aprobación', { requiresApproval: true }, {}],
    ['de un grupo de clientes', { customerGroupId: 'g1' }, {}],
    ['otro venue', { venueId: 'v2' }, {}],
  ]
  it.each(noCuenta)('no cuenta: %s', (_n, d, a) => {
    expect(cuentaComoDescuentoDelCliente(asig(a), base(d), 'v1', AHORA)).toBe(false)
  })
})

describe('elegirDescuentoDelCliente', () => {
  it('gana el de mayor valor con igual prioridad', () => {
    const r = elegirDescuentoDelCliente([base({ id: 'a', value: 10 }), base({ id: 'b', value: 30 })])
    expect(r?.id).toBe('b')
  })
  it('la prioridad manda sobre el valor', () => {
    const r = elegirDescuentoDelCliente([base({ id: 'a', value: 30 }), base({ id: 'b', value: 10, priority: 5 })])
    expect(r?.id).toBe('b')
  })
  it('empate total: el más viejo', () => {
    const r = elegirDescuentoDelCliente([
      base({ id: 'nuevo', createdAt: new Date('2026-06-01T00:00:00Z') }),
      base({ id: 'viejo', createdAt: new Date('2026-02-01T00:00:00Z') }),
    ])
    expect(r?.id).toBe('viejo')
  })
  it('sin candidatos: null', () => {
    expect(elegirDescuentoDelCliente([])).toBeNull()
  })
})

describe('descuentosDeLosClientes', () => {
  it('una consulta para varios clientes; sólo entra quien tiene uno válido', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { customerId: 'c1', discountId: 'a', ...asig(), discount: base({ id: 'a', name: 'Cliente 10 %', value: 10 }) },
      { customerId: 'c1', discountId: 'b', ...asig(), discount: base({ id: 'b', name: 'Cliente 30 %', value: 30 }) },
      { customerId: 'c2', discountId: 'a', ...asig({ maxUses: 1 }), discount: base({ id: 'a' }) },
    ])
    const db: any = { customerDiscount: { findMany } }
    const mapa = await descuentosDeLosClientes('v1', ['c1', 'c2'], db)
    expect(findMany).toHaveBeenCalledTimes(1)
    const arg = findMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({
      customerId: { in: ['c1', 'c2'] },
      active: true,
      maxUses: null,
      discount: {
        venueId: 'v1',
        active: true,
        type: { in: ['PERCENTAGE', 'FIXED_AMOUNT'] },
        scope: 'ORDER',
        requiresApproval: false,
        minPurchaseAmount: null,
        timeFrom: null,
        timeUntil: null,
        maxTotalUses: null,
        maxUsesPerCustomer: null,
        customerGroupId: null,
      },
    })
    expect(arg.where.AND).toHaveLength(2)
    // Una lista NULL en la base (descuentos de referidos, cargas por SQL) Prisma la lee como []: se aceptan las dos.
    expect(arg.where.discount.daysOfWeek).toBeUndefined()
    expect(arg.where.discount.AND).toHaveLength(3)
    expect(arg.where.discount.AND).toContainEqual({ OR: [{ daysOfWeek: { isEmpty: true } }, { daysOfWeek: { equals: null } }] })
    expect(arg.orderBy).toEqual([{ discount: { priority: 'desc' } }, { discount: { value: 'desc' } }, { discount: { createdAt: 'asc' } }])
    expect(arg.take).toBe(20)
    expect(mapa.size).toBe(1)
    expect(mapa.get('c1')).toEqual({ discountId: 'b', name: 'Cliente 30 %', type: 'PERCENTAGE', value: 30, maxDiscountAmount: null })
  })
  it('sin ids no consulta', async () => {
    const findMany = jest.fn()
    const mapa = await descuentosDeLosClientes('v1', [], { customerDiscount: { findMany } } as any)
    expect(mapa.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('llaveDelDescuentoDelCliente', () => {
  it('arma la llave', () => {
    expect(llaveDelDescuentoDelCliente('c1', 'd1')).toBe('descuento-cliente:c1:d1')
  })
})
