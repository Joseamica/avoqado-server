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
  TOPE_DE_BYTES_EN_CACHE,
  COSTO_FIJO_POR_NEGOCIO,
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

/** El cuerpo EXACTO que sale por la red: `res.json` lo convierte con JSON.stringify; `res.send` ya lo trae en texto. */
async function pedirTexto(venueId = 'v1'): Promise<string> {
  const res: any = { json: jest.fn(), send: jest.fn(), type: jest.fn() }
  res.type.mockReturnValue(res)
  const next = jest.fn()
  await listProducts({ params: { venueId } } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  if (res.json.mock.calls.length) return JSON.stringify(res.json.mock.calls[0][0])
  expect(res.type).toHaveBeenCalledWith('json')
  return res.send.mock.calls[0][0]
}

async function pedir(venueId = 'v1') {
  return JSON.parse(await pedirTexto(venueId))
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

    expect(await pedirTexto()).toBe(cuerpoDeAntes(productos, '2026-11-04T18:39:51.000Z'))

    jest.setSystemTime(new Date('2026-11-04T18:44:51.000Z'))
    const texto = await pedirTexto()
    expect(texto).toBe(cuerpoDeAntes(productos, '2026-11-04T18:44:51.000Z'))
    const segunda = JSON.parse(texto)
    expect(Object.keys(segunda)).toEqual(['success', 'data', 'catalogAt'])
    expect(segunda.data[0]).not.toHaveProperty('createdById')
  })

  it('si la versión cambió (un precio, el stock, un modificador), se vuelve a leer y sale lo nuevo', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ version: 'ver-1' }]).mockResolvedValueOnce([{ version: 'ver-2' }])
    prismaMock.product.findMany.mockResolvedValueOnce([producto('p1', '45')]).mockResolvedValueOnce([producto('p1', '50')])

    expect((await pedir()).data[0].price).toBe('45')
    expect((await pedir()).data[0].price).toBe('50')
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

  it('guarda el JSON (texto), no los objetos de Prisma: los Decimal ocupaban hasta 30× su JSON (Codex r2 P2)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue([producto('p1', '45')])
    await pedir()
    const guardado = catalogoMovilCacheado('v1', 'ver-1')
    expect(typeof guardado).toBe('string')
    expect(JSON.parse(guardado as string)[0].price).toBe('45')
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

  it('D8: un POS que pide cada 5 min toda una noche sin cambios lo arma UNA vez (con vida de 30 min lo armaba cada 35)', async () => {
    // Medido en producción el 9-nov (Better Stack): La Galeterie pide cada 5 min; con vida de 30 min, la 7.ª bajada
    // volvía a armar todo (420–760 ms con el hilo retenido) aunque nada hubiera cambiado. La versión es la que manda.
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue([producto('p1', '45')])
    const inicio = new Date('2026-11-09T02:03:22.000Z').getTime()
    for (let i = 0; i < 12 * 8; i++) {
      jest.setSystemTime(new Date(inicio + i * 5 * 60_000))
      await pedir()
    }
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('D6 — la caché tiene vida y tope', () => {
  beforeEach(() => vaciarCacheDelCatalogoMovil())

  it('vence: pasada su vida se vuelve a armar aunque la versión sea la misma', () => {
    guardarCatalogoMovil('v1', 'ver', '[{"id":"p"}]', 1_000)
    expect(catalogoMovilCacheado('v1', 'ver', 1_000 + VIDA_DEL_CATALOGO_MS - 1)).toBe('[{"id":"p"}]')
    expect(catalogoMovilCacheado('v1', 'ver', 1_000 + VIDA_DEL_CATALOGO_MS)).toBeUndefined()
  })

  it('otra versión no sirve', () => {
    guardarCatalogoMovil('v1', 'ver-1', '[]', 0)
    expect(catalogoMovilCacheado('v1', 'ver-2', 0)).toBeUndefined()
  })

  /** Un catálogo cuyo JSON pesa casi exactamente `bytes` (un solo producto con descripción larga). */
  /** Un catálogo en JSON que cuenta `bytes` (2 por carácter, el peor caso de V8, más el costo fijo). */
  const catalogoDe = (bytes: number) => `[{"description":"${'x'.repeat(Math.ceil((bytes - COSTO_FIJO_POR_NEGOCIO) / 2) - 20)}"}]`

  it('el tope cuenta BYTES del JSON guardado: un solo producto con una descripción enorme cuenta lo que pesa (Codex r1 P2)', () => {
    const tercio = catalogoDe(Math.floor(TOPE_DE_BYTES_EN_CACHE / 3) + 1)
    guardarCatalogoMovil('a', 'v', tercio, 0)
    guardarCatalogoMovil('b', 'v', tercio, 0)
    guardarCatalogoMovil('c', 'v', tercio, 0)
    expect(catalogoMovilCacheado('a', 'v', 0)).toBeUndefined()
    expect(catalogoMovilCacheado('b', 'v', 0)).toBe(tercio)
    expect(catalogoMovilCacheado('c', 'v', 0)).toBe(tercio)
  })

  it('un catálogo más pesado que el tope ni se guarda', () => {
    guardarCatalogoMovil('enorme', 'v', catalogoDe(TOPE_DE_BYTES_EN_CACHE + 100), 0)
    expect(catalogoMovilCacheado('enorme', 'v', 0)).toBeUndefined()
  })

  it('los catálogos vacíos también cuentan: el número de negocios guardados tiene tope (Codex r1 P2)', () => {
    const cuantos = Math.floor(TOPE_DE_BYTES_EN_CACHE / COSTO_FIJO_POR_NEGOCIO) + 5
    for (let i = 0; i < cuantos; i++) guardarCatalogoMovil(`n${i}`, 'v', '[]', 0)
    expect(catalogoMovilCacheado('n0', 'v', 0)).toBeUndefined()
    expect(catalogoMovilCacheado(`n${cuantos - 1}`, 'v', 0)).toBe('[]')
  })

  it('al guardar, se sueltan los vencidos de OTROS negocios aunque ya no pregunten (Codex r1 P2)', () => {
    guardarCatalogoMovil('abandonado', 'v', '[]', 0)
    guardarCatalogoMovil('activo', 'v', '[]', VIDA_DEL_CATALOGO_MS)
    // Se pregunta con la hora vieja a propósito: si sigue ahí, nadie lo soltó al guardar el otro.
    expect(catalogoMovilCacheado('abandonado', 'v', 0)).toBeUndefined()
    expect(catalogoMovilCacheado('activo', 'v', VIDA_DEL_CATALOGO_MS)).toBe('[]')
  })
})
