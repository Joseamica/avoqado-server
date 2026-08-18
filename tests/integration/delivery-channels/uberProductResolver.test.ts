import prisma from '@/utils/prismaClient'
import { resolveUberProduct, UBER_EXTERNAL_ID_PREFIX } from '@/services/delivery-channels/providers/uber-eats/uber.productResolver'

// Spec §4.ter: un item de Uber trae SUS ids. La cascada es determinista y
// NUNCA resuelve por nombre — "Chilaquiles" existe 3 veces en un menú real y
// un match por texto descontaría el stock del producto equivocado.
describe('resolución item de Uber → Product (durable)', () => {
  let venueId: string, orgId: string, otroVenueId: string
  let porExternalId: string, porSku: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: `Org res ${Date.now()}`, email: `r${Date.now()}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    const v = await prisma.venue.create({ data: { organizationId: orgId, name: `V res ${Date.now()}`, slug: `vr-${Date.now()}` } })
    venueId = v.id
    const v2 = await prisma.venue.create({ data: { organizationId: orgId, name: `V otro ${Date.now()}`, slug: `vo-${Date.now()}` } })
    otroVenueId = v2.id

    const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cat', slug: `cat-${Date.now()}` } })
    const p1 = await prisma.product.create({
      data: {
        venueId,
        categoryId: cat.id,
        name: 'Cochinita',
        sku: `SKU-COCH-${Date.now()}`,
        externalId: `${UBER_EXTERNAL_ID_PREFIX}Cochinita_de_Doña_Si`,
        price: '304.00',
      },
    })
    porExternalId = p1.id
    const p2 = await prisma.product.create({
      data: { venueId, categoryId: cat.id, name: 'Capuchino', sku: 'CAPU-01', price: '70.00' },
    })
    porSku = p2.id
    // Trampa: mismo NOMBRE en otro producto — si alguien resolviera por texto, elegiría mal
    await prisma.product.create({
      data: { venueId, categoryId: cat.id, name: 'Capuchino', sku: 'CAPU-DUP', price: '75.00' },
    })
    // Trampa multi-tenant: mismo sku en OTRO venue
    const cat2 = await prisma.menuCategory.create({ data: { venueId: otroVenueId, name: 'Cat2', slug: `cat2-${Date.now()}` } })
    await prisma.product.create({
      data: { venueId: otroVenueId, categoryId: cat2.id, name: 'Ajeno', sku: 'CAPU-01', price: '999.00' },
    })
  })

  afterAll(async () => {
    try {
      await prisma.product.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
      await prisma.menuCategory.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
      await prisma.shift.deleteMany({ where: { venueId: { in: [venueId, otroVenueId] } } })
      await prisma.venue.deleteMany({ where: { id: { in: [venueId, otroVenueId] } } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
    } catch {
      /* fixtures */
    }
  })

  it('1º por externalId (UBER_EATS:{item_id}) — el camino cuando Avoqado publicó el menú', async () => {
    const r = await resolveUberProduct(venueId, { id: 'Cochinita_de_Doña_Si' })
    expect(r.productId).toBe(porExternalId)
    expect(r.matchedBy).toBe('externalId')
  })

  it('2º por sku = external_data del item', async () => {
    const r = await resolveUberProduct(venueId, { id: 'Capuchino', externalData: 'CAPU-01' })
    expect(r.productId).toBe(porSku)
    expect(r.matchedBy).toBe('sku')
  })

  it('🔴 NUNCA por nombre: item sin externalId ni sku ⇒ NO resuelve aunque el nombre exista', async () => {
    const r = await resolveUberProduct(venueId, { id: 'no-existe', title: 'Capuchino' })
    expect(r.productId).toBeNull()
    expect(r.matchedBy).toBe('unresolved')
  })

  it('no cruza tenants: un sku de otro venue no resuelve aquí', async () => {
    const r = await resolveUberProduct(otroVenueId, { id: 'Cochinita_de_Doña_Si' })
    expect(r.productId).toBeNull() // ese externalId es del primer venue
  })

  it('externalId gana sobre sku cuando ambos podrían resolver', async () => {
    const r = await resolveUberProduct(venueId, { id: 'Cochinita_de_Doña_Si', externalData: 'CAPU-01' })
    expect(r.productId).toBe(porExternalId)
    expect(r.matchedBy).toBe('externalId')
  })
})
