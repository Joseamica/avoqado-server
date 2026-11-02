/**
 * Cobrar sin red, S1: `GET /tpv/venues/:venueId/products/barcode/:barcode` también trae `catalogAt` en la raíz, para que
 * un producto escaneado CON red lleve a la terminal la fecha de su precio (la terminal vende sin red con precio visto).
 * Misma regla que el listado: la hora la pone el servidor ANTES de leer el producto. Aditivo: message/data/correlationId igual.
 */
import * as productService from '@/services/dashboard/product.dashboard.service'
import { getTpvProductByBarcodeHandler } from '@/routes/tpv.routes'

const PRODUCTO = { id: 'p1', name: 'Coca-Cola 600', price: 25, gtin: '7501055300075', sku: null, createdById: 'staff-1' }

async function escanear(barcode = '7501055300075') {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  const next = jest.fn()
  await getTpvProductByBarcodeHandler({ params: { venueId: 'v1', barcode }, correlationId: 'c1' } as any, res, next)
  return { res, next, body: res.json.mock.calls[0]?.[0] }
}

describe('GET /tpv/venues/:venueId/products/barcode/:barcode — catalogAt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-20T18:00:00.000Z'))
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('catalogAt es la hora de ANTES de leer el producto, aunque la lectura tarde 5 s; 24 caracteres UTC', async () => {
    jest.spyOn(productService, 'getProductByBarcode').mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-10-20T18:00:05.000Z'))
      return PRODUCTO
    })

    const { body } = await escanear()

    expect(body.catalogAt).toBe('2026-10-20T18:00:00.000Z')
    expect(body.catalogAt).toHaveLength(24)
  })

  it('aditivo: message/data/correlationId igual (data sin createdById, con gtin) y catalogAt sólo en la raíz', async () => {
    jest.spyOn(productService, 'getProductByBarcode').mockResolvedValue(PRODUCTO)

    const { res, body } = await escanear()

    expect(res.status).toHaveBeenCalledWith(200)
    expect(Object.keys(body).sort()).toEqual(['catalogAt', 'correlationId', 'data', 'message'])
    expect(body.message).toBe('Product found for barcode 7501055300075')
    expect(body.correlationId).toBe('c1')
    expect(body.data.gtin).toBe('7501055300075')
    expect(body.data).not.toHaveProperty('createdById')
    expect(body.data).not.toHaveProperty('catalogAt')
  })

  it('regresión: código desconocido sigue siendo 404 (sin catalogAt)', async () => {
    jest.spyOn(productService, 'getProductByBarcode').mockResolvedValue(null)

    const { res, next } = await escanear('0000')

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(res.json).not.toHaveBeenCalled()
  })
})
