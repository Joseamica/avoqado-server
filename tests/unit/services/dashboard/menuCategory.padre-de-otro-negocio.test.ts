/**
 * na7522fd (2) · encargo 1df453 (18-nov-2026): una categoría se podía colgar de una categoría de OTRO negocio.
 *
 * `createMenuCategory` / `updateMenuCategory` (panel, y las apps por `/dashboard`) y `createCategory` / `updateCategory` de
 * `/mobile` conectaban `parentId` sólo por id. Quien conociera el id de una categoría ajena le colgaba una hija activa, y su
 * dueño ya no podía borrarla. Ahora el padre tiene que ser del MISMO negocio, al crear y al editar, y el rechazo no dice si
 * la categoría existe en otro lado.
 */
import { prismaMock } from '../../../__helpers__/setup'
import * as menuService from '../../../../src/services/dashboard/menu.dashboard.service'
import { createCategory, updateCategory } from '../../../../src/controllers/mobile/category.mobile.controller'

jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('../../../../src/utils/slugify', () => ({
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

const MIO = 'venue-mio'
const AJENA = 'cat-de-otro-negocio'
const PROPIA = 'cat-propia'

/** El padre sólo «existe» si se busca con su id Y con el negocio de quien escribe. */
function padresDelNegocio() {
  prismaMock.menuCategory.findFirst.mockImplementation(((args: any) => {
    const where = args?.where ?? {}
    if (where.id === PROPIA && where.venueId === MIO) return Promise.resolve({ id: PROPIA } as any)
    return Promise.resolve(null)
  }) as any)
}

function categoria(overrides: Record<string, unknown> = {}) {
  return { id: 'cat-nueva', venueId: MIO, name: 'Postres', slug: 'postres', parentId: null, ...overrides } as any
}

function respuesta() {
  const res: any = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
  padresDelNegocio()
  prismaMock.menuCategory.findUnique.mockResolvedValue(null)
  prismaMock.menuCategory.create.mockResolvedValue(categoria())
  prismaMock.menuCategory.update.mockResolvedValue(categoria())
  prismaMock.product.count.mockResolvedValue(0)
})

describe('Panel · el padre de una categoría es del mismo negocio', () => {
  it('P1 crear con el padre de OTRO negocio se rechaza y no escribe nada', async () => {
    await expect(menuService.createMenuCategory(MIO, { name: 'Postres', parentId: AJENA } as any)).rejects.toThrow(/categoría padre/i)
    expect(prismaMock.menuCategory.create).not.toHaveBeenCalled()
  })

  it('P1 editar para colgarla de una categoría de OTRO negocio se rechaza y no escribe nada', async () => {
    prismaMock.menuCategory.findUnique.mockResolvedValue(categoria({ id: 'cat-001' }))
    await expect(menuService.updateMenuCategory(MIO, 'cat-001', { parentId: AJENA } as any)).rejects.toThrow(/categoría padre/i)
    expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
  })

  it('el rechazo no dice si la categoría existe en otro negocio (mismo texto que un id inexistente)', async () => {
    const ajena = await menuService.createMenuCategory(MIO, { name: 'A', parentId: AJENA } as any).then(
      () => 'no rechazó',
      e => e.message,
    )
    const inexistente = await menuService.createMenuCategory(MIO, { name: 'B', parentId: 'cat-que-no-existe' } as any).then(
      () => 'no rechazó',
      e => e.message,
    )
    // Codex mac r1 #1: los dos tienen que RECHAZAR (sin rechazo, los dos daban lo mismo y la prueba pasaba).
    expect(ajena).toMatch(/categoría padre/i)
    expect(ajena).toBe(inexistente)
    expect(prismaMock.menuCategory.create).not.toHaveBeenCalled()
  })

  it('control: con un padre del mismo negocio crea y lo conecta', async () => {
    await menuService.createMenuCategory(MIO, { name: 'Postres', parentId: PROPIA } as any)
    expect(prismaMock.menuCategory.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.menuCategory.create.mock.calls[0][0].data.parent).toEqual({ connect: { id: PROPIA } })
  })

  it('control: editar con un padre del mismo negocio lo conecta, y quitar el padre no pregunta por nadie', async () => {
    prismaMock.menuCategory.findUnique.mockResolvedValue(categoria({ id: 'cat-001' }))
    await menuService.updateMenuCategory(MIO, 'cat-001', { parentId: PROPIA } as any)
    expect(prismaMock.menuCategory.update.mock.calls[0][0].data.parent).toEqual({ connect: { id: PROPIA } })

    prismaMock.menuCategory.findFirst.mockClear()
    await menuService.updateMenuCategory(MIO, 'cat-001', { parentId: null } as any)
    expect(prismaMock.menuCategory.update.mock.calls[1][0].data.parent).toEqual({ disconnect: true })
  })

  it('control: crear sin padre no busca padre', async () => {
    await menuService.createMenuCategory(MIO, { name: 'Postres' } as any)
    expect(prismaMock.menuCategory.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.create).toHaveBeenCalledTimes(1)
  })
})

describe('App (/mobile) · el padre de una categoría es del mismo negocio', () => {
  it('P1 crear con el padre de OTRO negocio responde 400 y no escribe nada', async () => {
    const res = respuesta()
    const next = jest.fn()
    await createCategory({ params: { venueId: MIO }, body: { name: 'Postres', parentId: AJENA } } as any, res, next)
    expect(prismaMock.menuCategory.create).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('P1 editar para colgarla de una categoría de OTRO negocio responde 400 y no escribe nada', async () => {
    prismaMock.menuCategory.findFirst.mockImplementation(((args: any) => {
      const where = args?.where ?? {}
      if (where.id === 'cat-001' && where.venueId === MIO) return Promise.resolve({ id: 'cat-001' } as any)
      return Promise.resolve(null)
    }) as any)
    const res = respuesta()
    const next = jest.fn()
    await updateCategory({ params: { venueId: MIO, categoryId: 'cat-001' }, body: { parentId: AJENA } } as any, res, next)
    expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
  })

  it('P1 Codex r1 #7: editar no escribe otras columnas ni relaciones (venueId, parent anidado)', async () => {
    prismaMock.menuCategory.findFirst.mockImplementation(((args: any) => {
      const where = args?.where ?? {}
      if (where.id === 'cat-001' && where.venueId === MIO) return Promise.resolve({ id: 'cat-001' } as any)
      return Promise.resolve(null)
    }) as any)
    const res = respuesta()
    await updateCategory(
      {
        params: { venueId: MIO, categoryId: 'cat-001' },
        body: { name: 'Bebidas', color: '#fff', venueId: 'otro-negocio', parent: { connect: { id: AJENA } }, createdAt: '2020-01-01' },
      } as any,
      res,
      jest.fn(),
    )
    expect(prismaMock.menuCategory.update).toHaveBeenCalledTimes(1)
    const data = prismaMock.menuCategory.update.mock.calls[0][0].data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual(['color', 'name', 'slug'])
  })

  it('control: lo que mandan las apps (nombre, descripción, color) se sigue guardando, y quitar el padre también', async () => {
    prismaMock.menuCategory.findFirst.mockImplementation(((args: any) => {
      const where = args?.where ?? {}
      if (where.id === 'cat-001' && where.venueId === MIO) return Promise.resolve({ id: 'cat-001' } as any)
      return Promise.resolve(null)
    }) as any)
    const res = respuesta()
    await updateCategory(
      {
        params: { venueId: MIO, categoryId: 'cat-001' },
        body: { name: 'Bebidas', description: 'Frías', color: '#fff', parentId: null },
      } as any,
      res,
      jest.fn(),
    )
    const data = prismaMock.menuCategory.update.mock.calls[0][0].data as Record<string, unknown>
    expect(data).toMatchObject({ name: 'Bebidas', description: 'Frías', color: '#fff', parentId: null })
  })

  it('control (Codex mac r1 #1): editar desde la app para moverla a un padre del MISMO negocio se guarda', async () => {
    prismaMock.menuCategory.findFirst.mockImplementation(((args: any) => {
      const where = args?.where ?? {}
      if ((where.id === 'cat-001' || where.id === PROPIA) && where.venueId === MIO) return Promise.resolve({ id: where.id } as any)
      return Promise.resolve(null)
    }) as any)
    const res = respuesta()
    await updateCategory({ params: { venueId: MIO, categoryId: 'cat-001' }, body: { parentId: PROPIA } } as any, res, jest.fn())
    expect(res.status).not.toHaveBeenCalledWith(400)
    expect(prismaMock.menuCategory.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.menuCategory.update.mock.calls[0][0].data).toEqual({ parentId: PROPIA })
  })

  it('control: con un padre del mismo negocio crea con ese padre', async () => {
    const res = respuesta()
    await createCategory({ params: { venueId: MIO }, body: { name: 'Postres', parentId: PROPIA } } as any, res, jest.fn())
    expect(prismaMock.menuCategory.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.menuCategory.create.mock.calls[0][0].data.parentId).toBe(PROPIA)
    expect(res.status).toHaveBeenCalledWith(201)
  })
})
