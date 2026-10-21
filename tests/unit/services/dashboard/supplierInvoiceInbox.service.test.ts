import { prismaMock } from '@tests/__helpers__/setup'
import { getInvoiceInventoryCatalog, getSupplierInvoiceInbox } from '@/services/dashboard/supplierInvoiceInbox.service'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.purchaseOrderInvoice.findMany.mockResolvedValue([])
  prismaMock.purchaseOrderInvoice.count.mockResolvedValue(103)
  prismaMock.rawMaterial.findMany.mockResolvedValue([])
  prismaMock.rawMaterial.count.mockResolvedValue(150)
})

describe('facturas de compras: páginas y totales', () => {
  it('acota una petición hostil a 100 y permite llegar a la siguiente página', async () => {
    const first = await getSupplierInvoiceInbox('venue', 1, 10000)
    expect(first).toMatchObject({ total: 103, limit: 100, totalPages: 2 })
    await getSupplierInvoiceInbox('venue', 2, 100)
    expect(prismaMock.purchaseOrderInvoice.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100, skip: 100, orderBy: [{ fechaEmision: 'desc' }, { id: 'desc' }] }),
    )
  })
  it('mantiene facturas preparadas en la bandeja y busca en el servidor', async () => {
    await getSupplierInvoiceInbox('venue', 1, 20, 'Café')
    const where = prismaMock.purchaseOrderInvoice.findMany.mock.calls[0][0].where
    expect(where.venueId).toBe('venue')
    expect(where.AND[0].OR).toContainEqual({ inventoryPreparedAt: { not: null } })
    expect(where.AND[1].OR[0]).toEqual({ emisorNombre: { contains: 'Café', mode: 'insensitive' } })
    expect(prismaMock.purchaseOrderInvoice.count).toHaveBeenCalledWith({ where })
  })
  it('catálogo de insumos: página pequeña, total independiente y búsqueda', async () => {
    const page = await getInvoiceInventoryCatalog('venue', 'RAW', 2, 25, 'harina')
    expect(page.total).toBe(150)
    expect(prismaMock.rawMaterial.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
        skip: 25,
        where: { venueId: 'venue', active: true, deletedAt: null, name: { contains: 'harina', mode: 'insensitive' } },
      }),
    )
  })
  it('regresión: nunca ofrece mercancía sin control de inventario para una entrada', async () => {
    prismaMock.product.findMany.mockResolvedValue([])
    prismaMock.product.count.mockResolvedValue(0)
    const page = await getInvoiceInventoryCatalog('venue', 'PRODUCT')
    expect(page.total).toBe(0)
    expect(prismaMock.product.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'venue', active: true, trackInventory: true })
  })
})
