import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { buildMenuSnapshot } from '../../../../src/services/delivery-channels/core/menuSnapshot.service'

describe('buildMenuSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ============================================================
  // 1. Snapshot completo: categorías → productos → modifier groups → modifiers
  // ============================================================
  it('arma el snapshot completo con categorías → productos → modifier groups → modifiers, precios numéricos en pesos', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      {
        id: 'cat1',
        name: 'Tacos',
        products: [
          {
            id: 'prod1',
            sku: 'TACO',
            name: 'Taco',
            description: 'Taco de asada',
            price: new Decimal(45.5),
            imageUrl: 'https://cdn.avoqado.io/taco.jpg',
            modifierGroups: [
              {
                displayOrder: 0,
                group: {
                  id: 'grp1',
                  name: 'Extras',
                  required: true,
                  allowMultiple: false,
                  minSelections: 1,
                  maxSelections: 2,
                  modifiers: [{ id: 'mod1', name: 'Extra queso', price: new Decimal(10) }],
                },
              },
            ],
          },
        ],
      },
    ] as any)

    const snapshot = await buildMenuSnapshot('venue1')

    expect(snapshot.venueId).toBe('venue1')
    expect(typeof snapshot.generatedAt).toBe('string')
    expect(snapshot.categories).toEqual([
      {
        name: 'Tacos',
        products: [
          {
            plu: 'TACO',
            name: 'Taco',
            description: 'Taco de asada',
            price: 45.5,
            imageUrl: 'https://cdn.avoqado.io/taco.jpg',
            modifierGroups: [
              {
                id: 'grp1',
                name: 'Extras',
                required: true,
                allowMultiple: false,
                minSelections: 1,
                maxSelections: 2,
                modifiers: [{ plu: 'MOD-mod1', name: 'Extra queso', price: 10 }],
              },
            ],
          },
        ],
      },
    ])
  })

  it('el precio es Number (no Decimal) para producto y modifier', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      {
        id: 'cat1',
        name: 'Bebidas',
        products: [
          {
            id: 'prod2',
            sku: 'REFRESCO',
            name: 'Refresco',
            description: null,
            price: new Decimal(30),
            imageUrl: null,
            modifierGroups: [
              {
                displayOrder: 0,
                group: {
                  id: 'grp2',
                  name: 'Tamaño',
                  required: false,
                  allowMultiple: false,
                  minSelections: 0,
                  maxSelections: null,
                  modifiers: [{ id: 'mod2', name: 'Grande', price: new Decimal(5.25) }],
                },
              },
            ],
          },
        ],
      },
    ] as any)

    const snapshot = await buildMenuSnapshot('venue1')
    const product = snapshot.categories[0].products[0]

    expect(typeof product.price).toBe('number')
    expect(product.price).toBe(30)
    expect(typeof product.modifierGroups[0].modifiers[0].price).toBe('number')
    expect(product.modifierGroups[0].modifiers[0].price).toBe(5.25)
  })

  // ============================================================
  // 2. Forma de la query: where active + orderBy displayOrder anidados
  // ============================================================
  it('consulta categorías activas del venue ordenadas por displayOrder, con productos/modifierGroups/modifiers activos y ordenados anidados', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([])

    await buildMenuSnapshot('venue1')

    expect(prismaMock.menuCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue1', active: true },
        orderBy: { displayOrder: 'asc' },
        include: expect.objectContaining({
          products: expect.objectContaining({
            where: { active: true, deletedAt: null },
            orderBy: { displayOrder: 'asc' },
            include: expect.objectContaining({
              modifierGroups: expect.objectContaining({
                orderBy: { displayOrder: 'asc' },
                include: expect.objectContaining({
                  group: expect.objectContaining({
                    include: expect.objectContaining({
                      modifiers: expect.objectContaining({ where: { active: true } }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    )
  })

  // ============================================================
  // 2b. Productos soft-deleted (deletedAt) NO se publican al canal
  // ============================================================
  it('excluye productos soft-deleted: el where de products exige deletedAt: null (deleteProduct solo marca deletedAt, no toca active)', async () => {
    // El mock simula que Prisma ya filtró — la garantía vive en la FORMA del where:
    // sin deletedAt: null, un producto "borrado" por el dueño (active sigue true)
    // se publicaría a Uber/Rappi/DiDi.
    prismaMock.menuCategory.findMany.mockResolvedValue([])

    await buildMenuSnapshot('venue1')

    const callArg = prismaMock.menuCategory.findMany.mock.calls[0][0]
    expect(callArg.include.products.where).toEqual({ active: true, deletedAt: null })
  })

  // ============================================================
  // 3. Categorías sin productos activos se omiten del snapshot
  // ============================================================
  it('categorías sin productos activos (Prisma ya filtró y la relación queda vacía) se omiten del snapshot', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      { id: 'cat1', name: 'Vacía (solo tenía productos inactivos)', products: [] },
      {
        id: 'cat2',
        name: 'Con productos',
        products: [
          {
            id: 'prod3',
            sku: 'SKU3',
            name: 'Producto 3',
            description: null,
            price: new Decimal(20),
            imageUrl: null,
            modifierGroups: [],
          },
        ],
      },
    ] as any)

    const snapshot = await buildMenuSnapshot('venue1')

    expect(snapshot.categories).toHaveLength(1)
    expect(snapshot.categories[0].name).toBe('Con productos')
  })

  // ============================================================
  // 4. Venue sin menú → snapshot vacío, no truena
  // ============================================================
  it('venue sin menú → snapshot con categories: [] sin lanzar', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([])

    await expect(buildMenuSnapshot('venue-sin-menu')).resolves.toEqual({
      venueId: 'venue-sin-menu',
      generatedAt: expect.any(String),
      categories: [],
    })
  })

  // ============================================================
  // 5. Producto sin modifier groups
  // ============================================================
  it('producto sin modifier groups → modifierGroups: [] en el snapshot', async () => {
    prismaMock.menuCategory.findMany.mockResolvedValue([
      {
        id: 'cat1',
        name: 'Postres',
        products: [
          {
            id: 'prod4',
            sku: 'FLAN',
            name: 'Flan',
            description: null,
            price: new Decimal(35),
            imageUrl: null,
            modifierGroups: [],
          },
        ],
      },
    ] as any)

    const snapshot = await buildMenuSnapshot('venue1')

    expect(snapshot.categories[0].products[0].modifierGroups).toEqual([])
  })
})
