/**
 * Se cobra el precio que vio el cliente, Task 5: el catálogo móvil trae su hora (`catalogAt`) en la RAÍZ de la respuesta.
 * La sella el servidor ANTES de leer los productos (si no, un cambio de precio ocurrido durante la lectura quedaría
 * "antes" del catálogo que la tablet ya trae). Aditivo: `data` queda igual para las apps viejas.
 */
import prisma from '@/utils/prismaClient'
import { listProducts } from '@/controllers/mobile/product.mobile.controller'

const prismaMock = prisma as any

const PRODUCTO = { id: 'p1', name: 'Café', price: 45, trackInventory: false, inventory: null, recipe: null }

describe('GET /mobile/venues/:venueId/products — catalogAt', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-17T18:00:00.000Z'))
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('catalogAt es la hora de ANTES del findMany, aunque la lectura tarde 5 s', async () => {
    prismaMock.product.findMany.mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-10-17T18:00:05.000Z')) // la lectura tarda 5 s
      return [PRODUCTO]
    })
    const res: any = { json: jest.fn() }
    await listProducts({ params: { venueId: 'v1' } } as any, res, jest.fn())

    const body = res.json.mock.calls[0][0]
    expect(body.catalogAt).toBe('2026-10-17T18:00:00.000Z')
  })

  it('formato fijo: 24 caracteres, UTC, con milisegundos (iOS lo parsea con fracciones)', async () => {
    jest.setSystemTime(new Date('2026-10-17T18:00:00.007Z'))
    prismaMock.product.findMany.mockResolvedValue([PRODUCTO])
    const res: any = { json: jest.fn() }
    await listProducts({ params: { venueId: 'v1' } } as any, res, jest.fn())

    const { catalogAt } = res.json.mock.calls[0][0]
    expect(catalogAt).toHaveLength(24)
    expect(catalogAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(catalogAt).toBe('2026-10-17T18:00:00.007Z')
  })

  it('aditivo: success y data quedan idénticos y catalogAt sólo vive en la raíz', async () => {
    prismaMock.product.findMany.mockResolvedValue([PRODUCTO])
    const res: any = { json: jest.fn() }
    await listProducts({ params: { venueId: 'v1' } } as any, res, jest.fn())

    const body = res.json.mock.calls[0][0]
    expect(Object.keys(body).sort()).toEqual(['catalogAt', 'data', 'success'])
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toEqual(expect.objectContaining({ id: 'p1', name: 'Café', price: 45 }))
    expect(body.data[0]).not.toHaveProperty('catalogAt')
  })
})
