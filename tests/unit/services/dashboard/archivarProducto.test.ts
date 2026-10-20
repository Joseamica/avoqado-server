/**
 * IVA por producto, plan 5 (D1): ARCHIVAR es uno solo — `deletedAt` + `deletedBy` + `active=false` — en el borrado del
 * dashboard (y con él la acción del chatbot), el del móvil y «Reemplazar menú» (Tarea 3). Antes el dashboard sólo ponía
 * `deletedAt`: el widget y la app de clientes, que filtran `active`, seguían ofreciendo el servicio borrado.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { deleteProduct as deleteProductMovil } from '@/controllers/mobile/product.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'
import { archivarProductos, deleteProduct } from '@/services/dashboard/product.dashboard.service'
import { deleteFileFromStorage } from '@/services/storage.service'

const mockBroadcaster = { broadcastMenuItemDeleted: jest.fn(), broadcastMenuUpdated: jest.fn() }
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => mockBroadcaster } }))
jest.mock('@/services/storage.service', () => ({ deleteFileFromStorage: jest.fn().mockResolvedValue(undefined) }))

const ARCHIVAR = { deletedAt: expect.any(Date), active: false }

describe('archivarProductos — la única forma de «borrar» un producto', () => {
  it('escribe deletedAt, deletedBy y active=false sólo sobre los no archivados y devuelve cuántos', async () => {
    prismaMock.product.updateMany.mockResolvedValue({ count: 2 })

    await expect(archivarProductos(prismaMock, { venueId: 'v1', sku: { notIn: ['A'] } }, 'staff-1')).resolves.toBe(2)

    expect(prismaMock.product.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', sku: { notIn: ['A'] }, deletedAt: null },
      data: { ...ARCHIVAR, deletedBy: 'staff-1' },
    })
  })
})

describe('Codex #2: archivar UN producto toma el negocio ANTES de leer si es variante', () => {
  const sqlDe = (i: number) => ((prismaMock.$queryRaw.mock.calls[i] as unknown as [TemplateStringsArray])[0] ?? []).join('?')
  beforeEach(() => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    prismaMock.product.updateMany.mockResolvedValue({ count: 0 })
  })

  it('suelto: negocio FOR SHARE primero (quien lo agrupe toma su cerco y espera); sin padre que bloquear', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ productGroupId: null } as never)
    await archivarProductos(prismaMock, { venueId: 'v1', id: 'p1' }, 'staff-1')
    expect(sqlDe(0)).toMatch(/FROM "Venue" WHERE id = \? FOR SHARE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.product.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('variante: negocio → padre FOR UPDATE → la variante (orden del motor)', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ productGroupId: 'g1' } as never)
    await archivarProductos(prismaMock, { venueId: 'v1', id: 'p1' }, 'staff-1')
    expect(sqlDe(0)).toMatch(/FROM "Venue" WHERE id = \? FOR SHARE/)
    expect(sqlDe(1)).toMatch(/FROM "ProductGroup" WHERE id = \? FOR UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.product.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(prismaMock.product.updateMany.mock.invocationCallOrder[0])
  })

  it('Shopify (ya bloqueó el producto, §10.3): no toma el negocio después — invertiría el orden', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ productGroupId: null } as never)
    await archivarProductos(prismaMock, { venueId: 'v1', id: 'p1' }, 'shopify', undefined, false)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('borrar desde el dashboard (y la acción del chatbot) ARCHIVA', () => {
  beforeEach(() => {
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'p1',
      venueId: 'v1',
      name: 'Masaje',
      sku: 'MAS',
      categoryId: 'c1',
      imageUrl: 'https://img/masaje.png',
    } as never)
    prismaMock.product.updateMany.mockResolvedValue({ count: 1 })
    // Variantes (tarea 11): antes de borrar la foto se mira que nadie más la use. Aquí nadie.
    prismaMock.product.count.mockResolvedValue(0)
    prismaMock.productGroup.count.mockResolvedValue(0)
  })

  it('pone active=false además de deletedAt y deletedBy (el widget y la app de clientes filtran active)', async () => {
    await deleteProduct('v1', 'p1', 'staff-1')

    expect(prismaMock.product.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', id: 'p1', deletedAt: null },
      data: { ...ARCHIVAR, deletedBy: 'staff-1' },
    })
    expect(prismaMock.product.update).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sigue borrando la imagen, avisando a los aparatos y registrando PRODUCT_DELETED', async () => {
    await deleteProduct('v1', 'p1', 'staff-1')

    expect(deleteFileFromStorage).toHaveBeenCalledWith('https://img/masaje.png')
    expect(mockBroadcaster.broadcastMenuItemDeleted).toHaveBeenCalledWith('v1', expect.objectContaining({ itemId: 'p1', sku: 'MAS' }))
    expect(mockBroadcaster.broadcastMenuUpdated).toHaveBeenCalledWith('v1', expect.objectContaining({ reason: 'ITEM_REMOVED' }))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_DELETED', entityId: 'p1', staffId: 'staff-1' }))
  })

  it('REGRESIÓN: inexistente o ya archivado sigue siendo 404, sin escribir', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)

    await expect(deleteProduct('v1', 'p1', 'staff-1')).rejects.toMatchObject({ statusCode: 404 })
    expect(prismaMock.product.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 una foto que todavía usa otro producto o un padre no se borra del almacenamiento', async () => {
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'p1',
      venueId: 'v1',
      name: 'Playera · M',
      imageUrl: 'https://img/padre.png',
      variantImageUrl: null,
      productGroupId: null,
    } as never)
    prismaMock.product.count.mockResolvedValue(0)
    prismaMock.productGroup.count.mockResolvedValue(1) // el padre la sigue usando (la variante ya se separó: auditoría A6)
    prismaMock.product.updateMany.mockResolvedValue({ count: 1 })
    await deleteProduct('v1', 'p1', 'staff-1')
    expect(deleteFileFromStorage).not.toHaveBeenCalled()
  })

  it('una foto que nadie más usa sí se borra (como hoy)', async () => {
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'p2',
      venueId: 'v1',
      name: 'Gorra',
      imageUrl: 'https://img/gorra.png',
      variantImageUrl: null,
      productGroupId: null,
    } as never)
    prismaMock.product.count.mockResolvedValue(0)
    prismaMock.productGroup.count.mockResolvedValue(0)
    prismaMock.product.updateMany.mockResolvedValue({ count: 1 })
    await deleteProduct('v1', 'p2', 'staff-1')
    expect(deleteFileFromStorage).toHaveBeenCalled()
  })
})

describe('borrar desde el móvil ARCHIVA con la misma función y la MISMA respuesta', () => {
  const respuesta = () => {
    const r = { status: jest.fn(), json: jest.fn() }
    r.status.mockReturnValue(r)
    r.json.mockReturnValue(r)
    return r
  }

  it('archiva y responde { success: true, data: { id } }', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'p1' } as never)
    prismaMock.product.updateMany.mockResolvedValue({ count: 1 })
    const res = respuesta()

    await deleteProductMovil(
      { params: { venueId: 'v1', productId: 'p1' }, authContext: { userId: 'staff-2' } } as never,
      res as never,
      jest.fn(),
    )

    expect(prismaMock.product.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', id: 'p1', deletedAt: null },
      data: { ...ARCHIVAR, deletedBy: 'staff-2' },
    })
    expect(prismaMock.product.update).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'p1' } })
  })

  it('REGRESIÓN: 404 con su mensaje, sin escribir', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)
    const res = respuesta()

    await deleteProductMovil(
      { params: { venueId: 'v1', productId: 'p1' }, authContext: { userId: 'staff-2' } } as never,
      res as never,
      jest.fn(),
    )

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Producto no encontrado' })
    expect(prismaMock.product.updateMany).not.toHaveBeenCalled()
  })
})
