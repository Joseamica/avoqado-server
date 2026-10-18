import { categoriaParaProductoSinCategoria } from '@/services/mobile/categoriaGeneral.service'

function txFalsa(categorias: Array<{ id: string } | null>, insertadas = 1) {
  const findFirst = jest.fn()
  for (const c of categorias) findFirst.mockResolvedValueOnce(c)
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    menuCategory: {
      findFirst,
      createMany: jest.fn().mockResolvedValue({ count: insertadas }),
      findUnique: jest.fn().mockResolvedValue({ id: 'cat-general' }),
    },
  }
}

describe('categoriaParaProductoSinCategoria — dónde cae un producto que llega sin categoría', () => {
  it('usa la primera categoría del negocio, sin crear nada ni tomar el candado', async () => {
    const tx = txFalsa([{ id: 'cat-bebidas' }])

    expect(await categoriaParaProductoSinCategoria(tx as any, 'v1')).toEqual({ id: 'cat-bebidas', creada: false })
    expect(tx.menuCategory.findFirst).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      orderBy: { displayOrder: 'asc' },
      select: { id: true },
    })
    expect(tx.menuCategory.createMany).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('en un negocio sin categorías crea «General» (una vez, bajo candado del negocio)', async () => {
    const tx = txFalsa([null, null])

    expect(await categoriaParaProductoSinCategoria(tx as any, 'v1')).toEqual({ id: 'cat-general', creada: true })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.menuCategory.createMany).toHaveBeenCalledWith({
      data: [{ venueId: 'v1', name: 'General', slug: 'general' }],
      skipDuplicates: true,
    })
    expect(tx.menuCategory.findUnique).toHaveBeenCalledWith({
      where: { venueId_slug: { venueId: 'v1', slug: 'general' } },
      select: { id: true },
    })
  })

  // Codex (14-oct): una «General» hecha a mano en el mismo instante chocaba con el único (venueId, slug) y tumbaba el alta.
  it('si alguien creó «General» a mano en el mismo instante, usa ésa sin error y sin auditar como automática', async () => {
    const tx = txFalsa([null, null], 0)

    expect(await categoriaParaProductoSinCategoria(tx as any, 'v1')).toEqual({ id: 'cat-general', creada: false })
  })

  it('si otra alta creó la categoría mientras esperaba el candado, usa ésa y no duplica', async () => {
    const tx = txFalsa([null, { id: 'cat-de-la-otra-alta' }])

    expect(await categoriaParaProductoSinCategoria(tx as any, 'v1')).toEqual({ id: 'cat-de-la-otra-alta', creada: false })
    expect(tx.menuCategory.createMany).not.toHaveBeenCalled()
  })
})
