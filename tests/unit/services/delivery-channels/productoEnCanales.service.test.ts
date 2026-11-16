/**
 * Poner o quitar UN producto en varios canales de delivery (D1, 16-nov-2026): la casilla «Vender en: ☑ Rappi ☐ Uber Eats»
 * del producto y el MCP. Cada canal se cambia con su fila bloqueada; la lista se guarda por producto (id) con su copia por código.
 */
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { NotFoundError, ValidationError } from '@/errors/AppError'
import { MAX_PRODUCTOS } from '@/services/delivery-channels/core/productosDelCanal'
import { ponerProductoEnCanales } from '@/services/delivery-channels/core/productoEnCanales.service'

/** Los productos del negocio `v1`. `p3` está apagado (sigue en el catálogo); `pX`, archivado. */
const CATALOGO = [
  { id: 'p1', sku: 'LATTE', deletedAt: null as Date | null },
  { id: 'p2', sku: 'CAP', deletedAt: null as Date | null },
  { id: 'p3', sku: 'TE', deletedAt: null as Date | null },
  { id: 'pX', sku: 'VIEJO', deletedAt: new Date('2026-11-01T00:00:00Z') as Date | null },
]

/** La base de mentira filtra como las consultas reales (las de `normalizarSeleccion`, la de códigos y la de todo el catálogo). */
function catalogo(filas = CATALOGO) {
  ;(prisma.product.findFirst as jest.Mock).mockImplementation(
    async ({ where }: any) => (where.venueId === 'v1' && filas.find(p => p.id === where.id)) || null,
  )
  ;(prisma.product.findMany as jest.Mock).mockImplementation(async ({ where, take }: any) => {
    if (where.venueId !== 'v1') return []
    const r = filas.filter(p =>
      where.OR
        ? where.OR.some((c: any) => c.id?.in.includes(p.id) || c.sku?.in.includes(p.sku))
        : where.sku
          ? where.sku.in.includes(p.sku)
          : where.id
            ? where.id.in.includes(p.id)
            : where.deletedAt === null && p.deletedAt === null,
    )
    return r.slice(0, take)
  })
  // Los extras del negocio `v1` (su código en el menú es `MOD-<id>`).
  ;(prisma.modifier.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
    where.group.venueId === 'v1' ? ['m1'].filter(id => where.id.in.includes(id)).map(id => ({ id })) : [],
  )
}

/** Las filas que devuelve el candado (`SELECT … FOR UPDATE`). */
function canales(...filas: Array<{ id: string; config: unknown; provider?: string }>) {
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(filas.map(f => ({ provider: 'RAPPI', ...f })))
}

const escritos = () => (prisma.deliveryChannelLink.updateMany as jest.Mock).mock.calls.map(c => c[0])
const escrito = () => escritos()[0].data.config

beforeEach(() => {
  catalogo()
  ;(prisma.deliveryChannelLink.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
})

describe('ponerProductoEnCanales — marcar (true)', () => {
  it('canal con lista: agrega el id, rehace la copia por código y lo quita de revisados', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'], productos: ['LATTE'], productosRevisados: ['p2', 'p9'] } })
    const r = await ponerProductoEnCanales('v1', 'p2', { l1: true }, 'u1')
    expect(r).toEqual([{ linkId: 'l1', dentro: true }])
    expect(escritos()[0].where).toEqual({ id: 'l1', venueId: 'v1' })
    expect(escrito()).toEqual({ productoIds: ['p1', 'p2'], productos: ['LATTE', 'CAP'], productosRevisados: ['p9'] })
  })

  it('un id guardado que ya no es de ningún producto se quita sin error (el archivado se queda) y la bitácora lo nombra', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1', 'pX', 'pBorrado'], productos: ['LATTE', 'VIEJO'] } })
    expect(await ponerProductoEnCanales('v1', 'p2', { l1: true }, 'u1')).toEqual([{ linkId: 'l1', dentro: true }])
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', id: { in: ['p1', 'pX', 'pBorrado'] } }, take: 3 }),
    )
    expect(escrito()).toEqual({ productoIds: ['p1', 'pX', 'p2'], productos: ['LATTE', 'VIEJO', 'CAP'], productosRevisados: [] })
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual({
      productId: 'p2',
      canales: { l1: true },
      idsDescartados: { l1: ['pBorrado'] },
    })
  })

  it('ya dentro ⇒ no escribe', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1', 'p2'], productos: ['LATTE', 'CAP'] } })
    expect(await ponerProductoEnCanales('v1', 'p2', { l1: true })).toEqual([{ linkId: 'l1', dentro: true }])
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })

  it('canal sin lista (todo el catálogo) ⇒ no escribe y queda dentro', async () => {
    canales({ id: 'l1', config: null })
    expect(await ponerProductoEnCanales('v1', 'p2', { l1: true })).toEqual([{ linkId: 'l1', dentro: true }])
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })

  it('lista vieja por código: se convierte (sin los códigos de nadie, con sus precios) y se agrega', async () => {
    canales({ id: 'l1', config: { productos: ['LATTE', 'NADIE'], precios: { overrides: { LATTE: 60, 'MOD-m1': 5 } } } })
    await ponerProductoEnCanales('v1', 'p2', { l1: true }, 'u1')
    expect(escrito()).toEqual({
      productoIds: ['p1', 'p2'],
      productos: ['LATTE', 'CAP'],
      precios: { porProducto: { p1: 60 }, overrides: { LATTE: 60, 'MOD-m1': 5 } },
      productosRevisados: [],
    })
    // El código que no es de nadie se queda fuera sin error, y la bitácora lo nombra.
    expect((logAction as jest.Mock).mock.calls[0][0].data).toEqual({
      productId: 'p2',
      canales: { l1: true },
      codigosDescartados: { l1: ['NADIE'] },
    })
  })
})

describe('ponerProductoEnCanales — desmarcar (false)', () => {
  it('canal con lista: quita el id y lo suma a revisados', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1', 'p2'], productos: ['LATTE', 'CAP'] } })
    expect(await ponerProductoEnCanales('v1', 'p2', { l1: false })).toEqual([{ linkId: 'l1', dentro: false }])
    expect(escrito()).toEqual({ productoIds: ['p1'], productos: ['LATTE'], productosRevisados: ['p2'] })
  })

  it('la lista quedaría vacía ⇒ ValidationError con el texto exacto, y no escribe', async () => {
    canales({ id: 'l1', config: { productoIds: ['p2'], productos: ['CAP'] } })
    const p = ponerProductoEnCanales('v1', 'p2', { l1: false })
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow('Un canal necesita al menos un producto; pausa el canal si no quieres vender ahí')
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('ya fuera de la lista (alta con la casilla sin marcar) ⇒ la lista queda y el producto pasa a revisados', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'], productos: ['LATTE'] } })
    await ponerProductoEnCanales('v1', 'p2', { l1: false })
    expect(escrito()).toEqual({ productoIds: ['p1'], productos: ['LATTE'], productosRevisados: ['p2'] })
    // Sin cambio de lista no se consulta nada para rehacer la copia.
    expect(prisma.product.findMany).not.toHaveBeenCalled()
  })

  it('ya fuera y ya revisado ⇒ no escribe (idempotente)', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'], productos: ['LATTE'], productosRevisados: ['p2'] } })
    await ponerProductoEnCanales('v1', 'p2', { l1: false })
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })

  it('canal sin lista: la vuelve explícita con todo lo no archivado (apagados incluidos) menos éste', async () => {
    canales({ id: 'l1', config: { precios: { markupPercent: 30 } } })
    await ponerProductoEnCanales('v1', 'p2', { l1: false })
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', deletedAt: null }, take: MAX_PRODUCTOS + 1 }),
    )
    expect(escrito()).toEqual({
      precios: { markupPercent: 30 },
      productoIds: ['p1', 'p3'],
      productos: ['LATTE', 'TE'],
      productosRevisados: ['p2'],
    })
  })

  it('canal sin lista y más de 5000 productos ⇒ ValidationError en español, y no escribe', async () => {
    const muchos = Array.from({ length: MAX_PRODUCTOS + 1 }, (_, i) => ({ id: `q${i}`, sku: `Q${i}`, deletedAt: null as Date | null }))
    catalogo([...CATALOGO, ...muchos])
    canales({ id: 'l1', config: null })
    await expect(ponerProductoEnCanales('v1', 'p2', { l1: false })).rejects.toThrow(/5,000 productos/)
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })
})

describe('ponerProductoEnCanales — candado, negocio y listas dañadas', () => {
  it('bloquea los canales pedidos, del negocio y en orden de id (FOR UPDATE + ORDER BY)', async () => {
    canales({ id: 'l1', config: null }, { id: 'l2', config: null })
    await ponerProductoEnCanales('v1', 'p2', { l2: true, l1: true })
    const [strings, ...valores] = (prisma.$queryRaw as jest.Mock).mock.calls[0]
    const sql = strings.join('?')
    expect(sql).toMatch(/"venueId" = \?/)
    expect(sql).toMatch(/ORDER BY "id" FOR UPDATE/)
    expect(valores[0]).toBe('v1')
    expect(valores[1].values).toEqual(['l1', 'l2'])
  })

  it('un canal de otro negocio (o inexistente) ⇒ NotFoundError, nada escrito', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'] } })
    await expect(ponerProductoEnCanales('v1', 'p2', { l1: true, lAjeno: true })).rejects.toThrow(NotFoundError)
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('producto de otro negocio o inexistente ⇒ NotFoundError; archivado ⇒ ValidationError; sin tocar canales', async () => {
    canales({ id: 'l1', config: null })
    await expect(ponerProductoEnCanales('v2', 'p2', { l1: true })).rejects.toThrow(NotFoundError)
    await expect(ponerProductoEnCanales('v1', 'pNada', { l1: true })).rejects.toThrow(NotFoundError)
    await expect(ponerProductoEnCanales('v1', 'pX', { l1: true })).rejects.toThrow(ValidationError)
    await expect(ponerProductoEnCanales('v1', 'pX', { l1: true })).rejects.toThrow(/Este producto está archivado/)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 Review Focus 1: una lista guardada dañada (por id o por código) ⇒ ValidationError que nombra el canal, nunca «todo»', async () => {
    canales({ id: 'l1', config: { productoIds: 'x' } })
    const p = ponerProductoEnCanales('v1', 'p2', { l1: true })
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/Rappi/)

    canales({ id: 'l1', provider: 'UBER_EATS', config: { productos: [42] } })
    const q = ponerProductoEnCanales('v1', 'p2', { l1: false })
    await expect(q).rejects.toThrow(ValidationError)
    await expect(q).rejects.toThrow(/Uber Eats/)
    expect(prisma.deliveryChannelLink.updateMany).not.toHaveBeenCalled()
  })

  it('varios canales: cada uno según el suyo, sólo escribe los que cambian', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'] } }, { id: 'l2', config: null })
    const r = await ponerProductoEnCanales('v1', 'p2', { l1: true, l2: true })
    expect(r).toEqual([
      { linkId: 'l1', dentro: true },
      { linkId: 'l2', dentro: true },
    ])
    expect(escritos().map(e => e.where.id)).toEqual(['l1'])
  })

  it('la bitácora DELIVERY_CHANNEL_PRODUCT_SET con { productId, canales }, después de la transacción', async () => {
    canales({ id: 'l1', config: { productoIds: ['p1'] } })
    ;(prisma.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => {
      const r = await fn(prisma)
      expect(logAction).not.toHaveBeenCalled()
      return r
    })
    await ponerProductoEnCanales('v1', 'p2', { l1: true }, 'u1')
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      staffId: 'u1',
      venueId: 'v1',
      action: 'DELIVERY_CHANNEL_PRODUCT_SET',
      entity: 'Product',
      entityId: 'p2',
      data: { productId: 'p2', canales: { l1: true } },
    })
  })
})
