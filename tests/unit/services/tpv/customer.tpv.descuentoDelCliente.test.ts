const mockDescuentos = jest.fn()
jest.mock('@/services/shared/descuentoDelCliente.service', () => ({
  descuentosDeLosClientes: (...a: unknown[]) => mockDescuentos(...a),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customer: { findMany: jest.fn(), findFirst: jest.fn() },
    referralProgramConfig: { findUnique: jest.fn() },
  },
}))
jest.mock('@/utils/serializableRetry', () => ({ withDeadlockRetry: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { searchCustomers, getCustomerForCheckout, quickCreateCustomer, getRecentCustomers } from '@/services/tpv/customer.tpv.service'

const p = prisma as any
const fila = (id: string) => ({
  id,
  firstName: id,
  lastName: null,
  email: null,
  phone: null,
  loyaltyPoints: 0,
  totalVisits: 1,
  totalSpent: { toNumber: () => 10 },
  customerGroup: null,
})
const d = { discountId: 'd1', name: 'VIP', type: 'PERCENTAGE', value: 10, maxDiscountAmount: null }

beforeEach(() => jest.clearAllMocks())

describe('descuentoDelCliente en los clientes de la TPV', () => {
  it('searchCustomers: una sola consulta para los 3 ids', async () => {
    p.customer.findMany.mockResolvedValue([fila('a'), fila('b'), fila('c')])
    mockDescuentos.mockResolvedValue(new Map([['b', d]]))
    const r = await searchCustomers('v1', 'ab')
    expect(mockDescuentos).toHaveBeenCalledTimes(1)
    expect(mockDescuentos).toHaveBeenCalledWith('v1', ['a', 'b', 'c'])
    expect(r.map(x => x.descuentoDelCliente)).toEqual([null, d, null])
    expect(r[0]).toMatchObject({ id: 'a', firstName: 'a', totalSpent: 10 })
  })

  it('getRecentCustomers lo trae', async () => {
    p.customer.findMany.mockResolvedValue([fila('a')])
    mockDescuentos.mockResolvedValue(new Map([['a', d]]))
    expect((await getRecentCustomers('v1'))[0].descuentoDelCliente).toEqual(d)
  })

  it('getCustomerForCheckout lo trae', async () => {
    p.customer.findFirst.mockResolvedValue(fila('a'))
    mockDescuentos.mockResolvedValue(new Map([['a', d]]))
    const r = await getCustomerForCheckout('v1', 'a')
    expect(mockDescuentos).toHaveBeenCalledWith('v1', ['a'])
    expect(r.descuentoDelCliente).toEqual(d)
  })

  it('quickCreateCustomer: existente por teléfono trae SU descuento', async () => {
    p.customer.findFirst.mockResolvedValue(fila('a'))
    mockDescuentos.mockResolvedValue(new Map([['a', d]]))
    const r = await quickCreateCustomer('v1', { phone: '555' })
    expect(mockDescuentos).toHaveBeenCalledWith('v1', ['a'])
    expect(r.descuentoDelCliente).toEqual(d)
    expect(r.id).toBe('a')
  })

  it('quickCreateCustomer: existente por correo trae SU descuento', async () => {
    p.customer.findFirst.mockResolvedValue(fila('a'))
    mockDescuentos.mockResolvedValue(new Map([['a', d]]))
    const r = await quickCreateCustomer('v1', { email: 'a@b.com' })
    expect(r.descuentoDelCliente).toEqual(d)
    expect(r.id).toBe('a')
  })

  it('si la consulta del descuento truena, la búsqueda sigue y avisa', async () => {
    p.customer.findMany.mockResolvedValue([fila('a'), fila('b')])
    mockDescuentos.mockRejectedValue(new Error('db caída'))
    const r = await searchCustomers('v1', 'ab')
    expect(r.map(x => x.id)).toEqual(['a', 'b'])
    expect(r.every(x => x.descuentoDelCliente === null)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ venueId: 'v1', error: 'db caída' }))
  })

  it('quickCreateCustomer: nuevo trae null', async () => {
    p.customer.findFirst.mockResolvedValue(null)
    ;(withDeadlockRetry as jest.Mock).mockResolvedValue({ ...fila('n'), referralCode: null })
    p.referralProgramConfig.findUnique.mockResolvedValue(null)
    const r = await quickCreateCustomer('v1', { phone: '555' })
    expect(r.descuentoDelCliente).toBeNull()
    expect(r.id).toBe('n')
  })
})
