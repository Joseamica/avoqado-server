import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'

const prismaMock = prisma as any

const promoWithOption = (option: Record<string, unknown>) => ({
  id: 'promo-1',
  name: '2x1 Cerveza',
  description: null,
  imageUrl: null,
  type: 'BUNDLE',
  pricingMode: 'PER_UNIT',
  priceCents: 0,
  displayOrder: 0,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [
    {
      id: 'g1',
      name: 'Bebida',
      displayOrder: 0,
      options: [option],
    },
  ],
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

// El POS pinta la tarjeta con ESTO. Sin quantity/chargedQuantity no hay forma
// de escribir "2x1"; sin nombre/precio la tarjeta sale vacía cuando el producto
// no está en la página del catálogo que el POS tiene cacheada.
describe('listPromotionsForPos — la tarjeta trae lo necesario para pintarse', () => {
  it('incluye cantidades y datos del producto en cada opción', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([
      promoWithOption({
        id: 'o1',
        productId: 'p1',
        priceDeltaCents: 0,
        quantity: 2,
        chargedQuantity: 1,
        product: { name: 'Cerveza Corona', price: new Prisma.Decimal('65.00'), venueId: 'venue-1' },
      }),
    ])

    const { active } = await listPromotionsForPos('venue-1')

    expect(active[0].groups[0].options[0]).toEqual({
      id: 'o1',
      productId: 'p1',
      priceDeltaCents: 0,
      quantity: 2,
      chargedQuantity: 1,
      productName: 'Cerveza Corona',
      productPriceCents: 6500, // Decimal de PESOS -> centavos, al centavo
    })
  })

  it('🔴 un producto de OTRO venue se trata como borrado: no se filtra su nombre ni su precio', async () => {
    // Promotion→Venue y PromotionOption→Product son FKs independientes, así que
    // el schema NO garantiza que el producto de una opción sea de este venue.
    // La escritura lo valida; esta es la verificación del lado de LECTURA, que
    // es la regla dura del repo (toda query se verifica contra el tenant).
    prismaMock.promotion.findMany.mockResolvedValue([
      promoWithOption({
        id: 'o1',
        productId: 'p1',
        priceDeltaCents: 0,
        quantity: 2,
        chargedQuantity: 1,
        product: { name: 'Producto ajeno', price: new Prisma.Decimal('999.00'), venueId: 'venue-DE-OTRO' },
      }),
    ])

    const { active } = await listPromotionsForPos('venue-1')

    expect(active[0].groups[0].options[0].productName).toBe('')
    expect(active[0].groups[0].options[0].productPriceCents).toBe(0)
  })

  it('no se cae si la opción viene sin producto cargado', async () => {
    // Un producto borrado no puede dejar al cajero sin panel: la tarjeta se
    // pinta con lo que hay.
    prismaMock.promotion.findMany.mockResolvedValue([
      promoWithOption({
        id: 'o1',
        productId: 'p1',
        priceDeltaCents: 0,
        quantity: 2,
        chargedQuantity: 1,
        product: null,
      }),
    ])

    const { active } = await listPromotionsForPos('venue-1')
    expect(active[0].groups[0].options[0].productName).toBe('')
    expect(active[0].groups[0].options[0].productPriceCents).toBe(0)
  })
})
