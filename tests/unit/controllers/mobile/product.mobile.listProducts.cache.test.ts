/**
 * D6 (4-nov-2026): los POS bajan el catálogo completo cada pocos minutos aunque no haya cambiado. Con La Galeterie (1,022
 * productos, ~2.5 MB de respuesta) armarlo retenía el hilo del SERVIDOR 0.2–1 s cada vez (47 avisos en 3 días), y en ese rato
 * no avanzaba ningún cobro de ningún negocio. Arreglo: si la versión del catálogo (una consulta barata en Postgres) no cambió,
 * se reutiliza lo ya armado. La respuesta debe ser EXACTAMENTE la misma que antes: ~85 aparatos viejos la leen.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listProducts } from '@/controllers/mobile/product.mobile.controller'
import { computeInventoryAvailability } from '@/services/dashboard/product.dashboard.service'
import { toLegacyProductPayload } from '@/utils/legacyProductPayload'
import { withVariantFields } from '@/services/product-variants/variantPayload'
import {
  catalogoMovilCacheado,
  guardarCatalogoMovil,
  vaciarCacheDelCatalogoMovil,
  TOPE_DE_PRODUCTOS_EN_CACHE,
  VIDA_DEL_CATALOGO_MS,
} from '@/services/mobile/catalogoMovil.cache'

const prismaMock = prisma as any

/** Un producto con lo que de verdad trae Prisma: Decimal, Date, categoría, modificadores, inventario y receta. */
function producto(id: string, precio: string) {
  return {
    id,
    venueId: 'v1',
    name: `Producto ${id}`,
    sku: `SKU-${id}`,
    price: new Prisma.Decimal(precio),
    cost: null,
    taxRate: new Prisma.Decimal('0.16'),
    ivaTratamiento: 'IVA_16',
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    soldByWeight: false,
    active: true,
    deletedAt: null,
    createdById: 'staff-interno',
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    category: { id: 'c1', name: 'Panes', displayOrder: 2, createdAt: new Date('2026-09-01T00:00:00.000Z') },
    inventory: { id: `i-${id}`, currentStock: new Prisma.Decimal('7.5') },
    productGroup: null,
    variantValues: [],
    modifierGroups: [
      { displayOrder: 0, group: { id: 'g1', name: 'Leche', modifiers: [{ id: 'm1', name: 'Avena', price: new Prisma.Decimal('12.00') }] } },
    ],
    recipe: null,
  }
}

/** Cómo armaba el cuerpo el servidor ANTES de D6 (res.json del sobre completo). */
function cuerpoDeAntes(productos: any[], catalogAt: string) {
  const data = productos.map(p => {
    const l = withVariantFields(toLegacyProductPayload(p))
    return { ...l, ...computeInventoryAvailability(l) }
  })
  return JSON.stringify({ success: true, data, catalogAt })
}

async function pedir(venueId = 'v1') {
  const res: any = { json: jest.fn() }
  const next = jest.fn()
  await listProducts({ params: { venueId } } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  return res.json.mock.calls[0][0]
}

describe('D6 — catálogo del POS: no se vuelve a armar si no cambió', () => {
  beforeEach(() => {
    vaciarCacheDelCatalogoMovil()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-11-04T18:39:51.000Z'))
  })
  afterEach(() => jest.useRealTimers())

  it('dos bajadas seguidas con la misma versión leen los productos UNA sola vez', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue([producto('p1', '45'), producto('p2', '30.5')])

    await pedir()
    await pedir()

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })

  it('la respuesta reutilizada es idéntica, byte por byte, a la de antes; sólo catalogAt es la hora nueva', async () => {
    const productos = [producto('p1', '45'), producto('p2', '30.5')]
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue(productos)

    const primera = await pedir()
    expect(JSON.stringify(primera)).toBe(cuerpoDeAntes(productos, '2026-11-04T18:39:51.000Z'))

    jest.setSystemTime(new Date('2026-11-04T18:44:51.000Z'))
    const segunda = await pedir()
    expect(JSON.stringify(segunda)).toBe(cuerpoDeAntes(productos, '2026-11-04T18:44:51.000Z'))
    expect(Object.keys(segunda)).toEqual(['success', 'data', 'catalogAt'])
    expect(segunda.data[0]).not.toHaveProperty('createdById')
  })

  it('si la versión cambió (un precio, el stock, un modificador), se vuelve a leer y sale lo nuevo', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ version: 'ver-1' }]).mockResolvedValueOnce([{ version: 'ver-2' }])
    prismaMock.product.findMany.mockResolvedValueOnce([producto('p1', '45')]).mockResolvedValueOnce([producto('p1', '50')])

    expect((await pedir()).data[0].price).toEqual(new Prisma.Decimal('45'))
    expect((await pedir()).data[0].price).toEqual(new Prisma.Decimal('50'))
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
  })

  it('cada negocio tiene su propio catálogo, aunque la versión coincida', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'misma' }])
    prismaMock.product.findMany.mockResolvedValueOnce([producto('a', '1')]).mockResolvedValueOnce([producto('b', '2')])

    expect((await pedir('venue-a')).data[0].id).toBe('a')
    expect((await pedir('venue-b')).data[0].id).toBe('b')
    expect((await pedir('venue-a')).data[0].id).toBe('a')
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
  })

  it('si la versión no se puede leer, se arma como antes y no se guarda nada (la bajada nunca falla por la caché)', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('timeout'))
    prismaMock.product.findMany.mockResolvedValue([producto('p1', '45')])

    await pedir()
    await pedir()

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
  })

  it('la versión se lee ANTES que los productos: un cambio a media lectura nunca queda guardado como «sin cambios»', async () => {
    const orden: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      orden.push('version')
      return [{ version: 'ver-1' }]
    })
    prismaMock.product.findMany.mockImplementation(async () => {
      orden.push('productos')
      return [producto('p1', '45')]
    })
    await pedir()
    expect(orden).toEqual(['version', 'productos'])
  })
})

describe('D6 — la caché tiene vida y tope', () => {
  beforeEach(() => vaciarCacheDelCatalogoMovil())

  it('vence: pasada su vida se vuelve a armar aunque la versión sea la misma', () => {
    guardarCatalogoMovil('v1', 'ver', [{ id: 'p' }], 1_000)
    expect(catalogoMovilCacheado('v1', 'ver', 1_000 + VIDA_DEL_CATALOGO_MS - 1)).toEqual([{ id: 'p' }])
    expect(catalogoMovilCacheado('v1', 'ver', 1_000 + VIDA_DEL_CATALOGO_MS)).toBeUndefined()
  })

  it('otra versión no sirve', () => {
    guardarCatalogoMovil('v1', 'ver-1', [{ id: 'p' }], 0)
    expect(catalogoMovilCacheado('v1', 'ver-2', 0)).toBeUndefined()
  })

  it('con más productos que el tope, se suelta el negocio más viejo y nunca se pasa del tope', () => {
    const mitad = Array.from({ length: TOPE_DE_PRODUCTOS_EN_CACHE / 2 }, (_, i) => ({ id: `p${i}` }))
    guardarCatalogoMovil('a', 'v', mitad, 0)
    guardarCatalogoMovil('b', 'v', mitad, 0)
    guardarCatalogoMovil('c', 'v', mitad, 0)
    expect(catalogoMovilCacheado('a', 'v', 0)).toBeUndefined()
    expect(catalogoMovilCacheado('b', 'v', 0)).toBe(mitad)
    expect(catalogoMovilCacheado('c', 'v', 0)).toBe(mitad)
  })

  it('un catálogo más grande que el tope ni se guarda', () => {
    guardarCatalogoMovil(
      'enorme',
      'v',
      Array.from({ length: TOPE_DE_PRODUCTOS_EN_CACHE + 1 }, () => ({})),
      0,
    )
    expect(catalogoMovilCacheado('enorme', 'v', 0)).toBeUndefined()
  })
})
