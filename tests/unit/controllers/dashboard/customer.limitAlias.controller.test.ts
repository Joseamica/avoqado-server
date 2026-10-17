import type { NextFunction, Request, Response } from 'express'

const mockGetCustomers = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ getCustomers: (...a: unknown[]) => mockGetCustomers(...a) }))

import { getCustomers } from '@/controllers/dashboard/customer.dashboard.controller'

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response
const llamar = (query: Record<string, string>) =>
  getCustomers({ params: { venueId: 'v1' }, query } as unknown as Request, res(), jest.fn() as NextFunction)

describe('GET customers — `limit` es alias de `pageSize` (las tablets mandan ?limit=50)', () => {
  beforeEach(() => mockGetCustomers.mockResolvedValue({ data: [], meta: {} }))

  it('🔴 ?limit=50 llega como pageSize 50 (antes se ignoraba y salían 20)', async () => {
    await llamar({ limit: '50' })
    expect(mockGetCustomers.mock.calls[0][2]).toBe(50)
  })
  it('pageSize gana si vienen los dos', async () => {
    await llamar({ pageSize: '30', limit: '50' })
    expect(mockGetCustomers.mock.calls[0][2]).toBe(30)
  })
  it('regresión: sin ninguno, el default del servicio (undefined)', async () => {
    await llamar({})
    expect(mockGetCustomers.mock.calls[0][2]).toBeUndefined()
  })
  it('regresión: el resto de los parámetros llega en su lugar (búsqueda y orden de la tablet)', async () => {
    await llamar({ pageSize: '50', search: 'dany', sortBy: 'createdAt', sortOrder: 'desc' })
    const args = mockGetCustomers.mock.calls[0]
    expect(args[0]).toBe('v1')
    expect(args[3]).toBe('dany')
    expect(args[7]).toBe('createdAt')
    expect(args[8]).toBe('desc')
  })
})
