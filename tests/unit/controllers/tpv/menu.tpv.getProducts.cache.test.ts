/**
 * D20 (10-nov-2026): la TPV baja su catálogo (`GET /tpv/venues/:venueId/products`) y el SERVIDOR lo armaba completo cada vez:
 * retuvo el hilo único 206–699 ms, 7 veces en ~2.6 días (Better Stack, 8 al 10-nov), y en ese rato no avanzaba ningún cobro.
 * Arreglo, igual que D6 en el POS: si la versión del catálogo no cambió, se reutiliza el `data` ya armado.
 * La respuesta debe salir EXACTAMENTE igual que antes, byte por byte: la leen las TPV desde 2.10.
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getProducts } from '@/controllers/tpv/menu.tpv.controller'
import { buildProductsListResponse, getProductsHandler } from '@/controllers/dashboard/product.dashboard.controller'
import { computeInventoryAvailability } from '@/services/dashboard/product.dashboard.service'
import { toLegacyProductPayload } from '@/utils/legacyProductPayload'
import { withVariantFields } from '@/services/product-variants/variantPayload'
import {
  vaciarCacheDelCatalogoMovil,
  catalogoMovilCacheado,
  guardarCatalogoMovil,
  TOPE_DE_BYTES_EN_CACHE,
  COSTO_FIJO_POR_NEGOCIO,
} from '@/services/mobile/catalogoMovil.cache'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const prismaMock = prisma as any
const AHORA = new Date('2026-11-10T15:30:00.123Z')

/** Un producto con lo que de verdad trae Prisma: Decimal, Date, categoría, inventario, modificadores, receta y precio especial. */
function producto(id: string, o: { precio?: string; stock?: string; modificador?: string; precioEspecial?: string; insumo?: string } = {}) {
  return {
    id,
    venueId: 'v1',
    name: `Producto ${id}`,
    sku: `SKU-${id}`,
    gtin: '7501234567890',
    price: new Prisma.Decimal(o.precio ?? '45'),
    cost: null,
    taxRate: new Prisma.Decimal('0.16'),
    ivaTratamiento: 'IVA_16',
    trackInventory: true,
    inventoryMethod: 'RECIPE',
    soldByWeight: false,
    active: true,
    deletedAt: null,
    createdById: 'staff-interno',
    productGroupId: null,
    angelpayWebhookSecret: 'no-debe-salir',
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    category: { id: 'c1', name: 'Panes «de muerto»', displayOrder: 2, createdAt: new Date('2026-09-01T00:00:00.000Z') },
    inventory: { id: `i-${id}`, currentStock: new Prisma.Decimal(o.stock ?? '7.5') },
    productGroup: null,
    variantValues: [],
    modifierGroups: [
      {
        displayOrder: 0,
        group: { id: 'g1', name: 'Leche', modifiers: [{ id: 'm1', name: 'Avena', price: new Prisma.Decimal(o.modificador ?? '12.00') }] },
      },
    ],
    recipe: {
      id: `r-${id}`,
      lines: [
        {
          quantity: new Prisma.Decimal('0.5'),
          unit: 'KILOGRAM',
          rawMaterial: {
            id: 'rm1',
            name: 'Harina $& $1 $$',
            sku: 'HAR',
            unit: 'KILOGRAM',
            currentStock: new Prisma.Decimal(o.insumo ?? '10'),
            minimumStock: new Prisma.Decimal('1'),
            avgCostPerUnit: new Prisma.Decimal('20'),
            active: true,
          },
        },
      ],
    },
    pricingPolicy: { id: `pp-${id}`, currentPrice: new Prisma.Decimal(o.precioEspecial ?? '44.00'), pricingStrategy: 'MANUAL' },
  }
}

/** El replacer de src/app.ts: la llave de firma de AngelPay nunca sale por HTTP. */
const replacer = (key: string, value: unknown) => (key === 'angelpayWebhookSecret' ? undefined : value)

function app(correlationId: string | null = 'corr-1') {
  const a = express()
  a.set('json replacer', replacer)
  a.use((req, _res, next) => {
    if (correlationId !== null) (req as any).correlationId = correlationId
    next()
  })
  a.get('/tpv/venues/:venueId/products', getProducts)
  a.get('/dashboard/venues/:venueId/products', getProductsHandler)
  // El handler de la TPV tal cual estaba ANTES de D20.
  a.get('/antes/venues/:venueId/products', async (req, res, next) => {
    try {
      const catalogAt = new Date().toISOString()
      const body = await buildProductsListResponse(req)
      res.status(200).json({ ...body, catalogAt })
    } catch (e) {
      next(e)
    }
  })
  return a
}

/** Cómo armaba el cuerpo el servidor antes de D20, sin pasar por el código nuevo. */
function cuerpoDeAntes(productos: any[], catalogAt: string, venueId = 'v1', correlationId: string | null = 'corr-1') {
  const data = productos.map(p => withVariantFields({ ...p, ...computeInventoryAvailability(p) })).map(toLegacyProductPayload)
  return JSON.stringify({ message: `Products for venue ${venueId}`, data, correlationId: correlationId ?? undefined, catalogAt }, replacer)
}

const pedir = (a: express.Express, ruta = '/tpv/venues/v1/products') => request(a).get(ruta)

describe('D20 — catálogo de la TPV: no se vuelve a armar si no cambió', () => {
  beforeEach(() => {
    vaciarCacheDelCatalogoMovil()
    // Sólo la fecha: supertest necesita los relojes de verdad.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'],
    })
    jest.setSystemTime(AHORA)
  })
  afterEach(() => jest.useRealTimers())

  it('primera y segunda bajada: idénticas byte por byte a la de antes (status, Content-Type y cuerpo); sólo catalogAt es nuevo', async () => {
    const productos = [producto('p1'), producto('p2', { precio: '30.5' })]
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue(productos)
    const a = app()

    const antes = await pedir(a, '/antes/venues/v1/products')
    const primera = await pedir(a)
    expect(primera.status).toBe(antes.status)
    expect(primera.headers['content-type']).toBe(antes.headers['content-type'])
    expect(primera.text).toBe(antes.text)
    expect(primera.text).toBe(cuerpoDeAntes(productos, AHORA.toISOString()))

    jest.setSystemTime(new Date('2026-11-10T15:35:00.456Z'))
    const antes2 = await pedir(a, '/antes/venues/v1/products')
    const segunda = await pedir(a)
    expect(segunda.status).toBe(200)
    expect(segunda.headers['content-type']).toBe(antes2.headers['content-type'])
    expect(segunda.text).toBe(antes2.text)
    expect(segunda.text).toBe(cuerpoDeAntes(productos, '2026-11-10T15:35:00.456Z'))
    // Mismo cuerpo ⇒ misma ETag (Codex r2: HEAD y 304 no estaban cubiertos).
    expect(segunda.headers.etag).toBe(antes2.headers.etag)
    const cabeza = await request(a).head('/tpv/venues/v1/products')
    expect(cabeza.status).toBe(200)
    expect(cabeza.headers.etag).toBe(antes2.headers.etag)
    expect((await request(a).get('/tpv/venues/v1/products').set('If-None-Match', antes2.headers.etag)).status).toBe(304)

    const cuerpo = JSON.parse(segunda.text)
    expect(Object.keys(cuerpo)).toEqual(['message', 'data', 'correlationId', 'catalogAt'])
    expect(cuerpo.data[0]).not.toHaveProperty('createdById')
    expect(cuerpo.data[0]).not.toHaveProperty('angelpayWebhookSecret')
    // `/antes` llamó 2 veces; la TPV, sólo en la primera.
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(3)
  })

  it('el correlationId y la hora son de CADA petición, nunca de la guardada; sin correlationId la llave no sale (como res.json)', async () => {
    const productos = [producto('p1')]
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue(productos)

    await pedir(app('corr-A'))
    jest.setSystemTime(new Date('2026-11-10T16:00:00.000Z'))
    const otra = await pedir(app('corr-B'))
    expect(otra.text).toBe(cuerpoDeAntes(productos, '2026-11-10T16:00:00.000Z', 'v1', 'corr-B'))

    const sin = await pedir(app(null))
    expect(sin.text).toBe(cuerpoDeAntes(productos, '2026-11-10T16:00:00.000Z', 'v1', null))
    expect(JSON.parse(sin.text)).not.toHaveProperty('correlationId')
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['el precio', { precio: '50' }, (b: any) => b.data[0].price, '50'],
    ['la existencia', { stock: '3' }, (b: any) => b.data[0].inventory.currentStock, '3'],
    ['un modificador', { modificador: '15' }, (b: any) => b.data[0].modifierGroups[0].group.modifiers[0].price, '15'],
    ['el precio especial', { precioEspecial: '39.9' }, (b: any) => b.data[0].pricingPolicy.currentPrice, '39.9'],
    ['la receta (existencia del insumo)', { insumo: '1' }, (b: any) => b.data[0].availableQuantity, 2],
  ])('si cambia %s, la versión cambia y la bajada sale con lo nuevo', async (_n, cambio, leer, esperado) => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ version: 'ver-1' }]).mockResolvedValueOnce([{ version: 'ver-2' }])
    prismaMock.product.findMany.mockResolvedValueOnce([producto('p1')]).mockResolvedValueOnce([producto('p1', cambio)])
    const a = app()

    const primera = JSON.parse((await pedir(a, '/tpv/venues/v1/products?includePricingPolicy=true')).text)
    const segunda = JSON.parse((await pedir(a, '/tpv/venues/v1/products?includePricingPolicy=true')).text)

    expect(leer(segunda)).toBe(esperado)
    expect(leer(segunda)).not.toBe(leer(primera))
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
  })

  it('cada combinación de la query tiene su propia copia, aunque la versión sea la misma', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'misma' }])
    const rutas = [
      '/tpv/venues/v1/products',
      '/tpv/venues/v1/products?includeRecipe=false',
      '/tpv/venues/v1/products?includeModifiers=false',
      '/tpv/venues/v1/products?includePricingPolicy=true',
      '/tpv/venues/v1/products?categoryId=c1',
      '/tpv/venues/v1/products?categoryId=c2',
      '/tpv/venues/v1/products?orderBy=name',
    ]
    rutas.forEach((_r, i) => prismaMock.product.findMany.mockResolvedValueOnce([producto(`q${i}`)]))
    const a = app()

    for (const [i, ruta] of rutas.entries()) expect(JSON.parse((await pedir(a, ruta)).text).data[0].id).toBe(`q${i}`)
    for (const [i, ruta] of rutas.entries()) expect(JSON.parse((await pedir(a, ruta)).text).data[0].id).toBe(`q${i}`)
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(rutas.length)
    // Lo que pidió Prisma la primera vez sigue siendo lo de cada query (no se mezclan).
    expect(prismaMock.product.findMany.mock.calls[4][0].where).toEqual({ venueId: 'v1', deletedAt: null, categoryId: 'c1' })
    expect(prismaMock.product.findMany.mock.calls[6][0].orderBy).toEqual({ name: 'asc' })
  })

  it('las queries que se leen igual comparten copia (normalizadas como buildProductsListResponse)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'misma' }])
    prismaMock.product.findMany.mockResolvedValue([producto('p1')])
    const a = app()

    await pedir(a, '/tpv/venues/v1/products')
    await pedir(a, '/tpv/venues/v1/products?includeRecipe=true&includeModifiers=si&includePricingPolicy=false&orderBy=displayOrder')
    await pedir(a, '/tpv/venues/v1/products?orderBy=otra')
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })

  it('cada negocio tiene su propia copia, y nunca comparte con la del POS (/mobile)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'misma' }])
    prismaMock.product.findMany.mockResolvedValueOnce([producto('a')]).mockResolvedValueOnce([producto('b')])
    const a = app()

    expect(JSON.parse((await pedir(a, '/tpv/venues/venue-a/products')).text).data[0].id).toBe('a')
    expect(JSON.parse((await pedir(a, '/tpv/venues/venue-b/products')).text).data[0].id).toBe('b')
    expect(JSON.parse((await pedir(a, '/tpv/venues/venue-a/products')).text).data[0].id).toBe('a')
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
    // La llave del POS es el venueId suelto: la TPV no la ocupa.
    expect(catalogoMovilCacheado('venue-a', 'misma')).toBeUndefined()
  })

  it('si la versión no se puede leer, se arma como antes y no se guarda nada', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('timeout'))
    prismaMock.product.findMany.mockResolvedValue([producto('p1')])
    const a = app()

    const antes = await pedir(a, '/antes/venues/v1/products')
    const r1 = await pedir(a)
    const r2 = await pedir(a)
    expect(r1.text).toBe(antes.text)
    expect(r2.text).toBe(antes.text)
    expect(r1.headers['content-type']).toBe(antes.headers['content-type'])
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(3)
  })

  it('si armar falla, el error va a next como hoy y no se guarda nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce([producto('p1')])
    const a = app()
    a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message })
    })

    expect((await pedir(a)).status).toBe(500)
    expect((await pedir(a)).status).toBe(200)
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
  })

  it('orden: catalogAt se sella antes de leer la versión, y la versión antes que los productos', async () => {
    const orden: string[] = []
    prismaMock.$queryRaw.mockImplementation(async () => {
      orden.push('version')
      jest.setSystemTime(new Date(AHORA.getTime() + 1_000))
      return [{ version: 'ver-1' }]
    })
    prismaMock.product.findMany.mockImplementation(async () => {
      orden.push('productos')
      jest.setSystemTime(new Date(AHORA.getTime() + 5_000))
      return [producto('p1')]
    })

    const r = await pedir(app())
    expect(orden).toEqual(['version', 'productos'])
    expect(JSON.parse(r.text).catalogAt).toBe(AHORA.toISOString())
  })

  it('Codex r1: la llave (que trae la query) también cuenta en el tope de memoria, no sólo el JSON', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'v' }])
    prismaMock.product.findMany.mockResolvedValue([])
    const a = app()
    // Cada llave pesa ~8 KB (un categoryId de 4,000 caracteres) y su `data` es `[]`. Sin contar la llave, 13 mil de éstas
    // ocupaban 55 MB «invisibles» con el contador en 13 MB.
    const categoria = (i: number) => `${i}-`.padEnd(4_000, 'x')
    const llave = (i: number) =>
      JSON.stringify([
        'tpv',
        'v1',
        { includeRecipe: true, includeModifiers: true, includePricingPolicy: false, categoryId: categoria(i), orderBy: 'displayOrder' },
      ])
    await pedir(a, `/tpv/venues/v1/products?categoryId=${categoria(0)}`)
    expect(catalogoMovilCacheado(llave(0), 'v')).toBe('[]')
    const porEntrada = (llave(1).length + 2) * 2 + COSTO_FIJO_POR_NEGOCIO
    const caben = Math.floor(TOPE_DE_BYTES_EN_CACHE / porEntrada)
    for (let i = 1; i <= caben + 1; i++) guardarCatalogoMovil(llave(i), 'v', '[]')
    // La primera ya se soltó: el tope contó las llaves.
    expect(catalogoMovilCacheado(llave(0), 'v')).toBeUndefined()
    expect(catalogoMovilCacheado(llave(1), 'v')).toBeUndefined()
    expect(catalogoMovilCacheado(llave(caben + 1), 'v')).toBe('[]')
  })

  it('el panel (DASHBOARD) no recibe caché: cada bajada arma y ni siquiera lee la versión', async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ version: 'ver-1' }])
    prismaMock.product.findMany.mockResolvedValue([producto('p1')])
    const a = app()

    await pedir(a, '/dashboard/venues/v1/products')
    await pedir(a, '/dashboard/venues/v1/products')
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
