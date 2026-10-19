/**
 * TEST_DATABASE_URL='postgresql://localhost:5432/avoqado_variantes_test_20261014' \
 *   npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/schema.integration.test.ts
 */
import prisma from '@/utils/prismaClient'

describe('Variantes: modelo de datos', () => {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let organizationId: string
  let venueId: string
  let categoryId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `Var ${s}`, email: `var-${s}@example.com`, phone: '5555555555' } })
    organizationId = org.id
    const venue = await prisma.venue.create({ data: { organizationId, name: `Var ${s}`, slug: `var-${s}`, seatCapExempt: true } })
    venueId = venue.id
    const cat = await prisma.menuCategory.create({ data: { venueId, name: `Ropa ${s}`, slug: `ropa-${s}` } as any })
    categoryId = cat.id
  })

  afterAll(async () => {
    if (!venueId) return
    await prisma.product.deleteMany({ where: { venueId } })
    await prisma.productGroup.deleteMany({ where: { venueId } })
    await prisma.menuCategory.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  it('un producto suelto sigue naciendo sin padre (nada cambia para quien no usa variantes)', async () => {
    const p = await prisma.product.create({ data: { venueId, categoryId, sku: `S-${s}`, name: 'Suelto', price: 10 } as any })
    expect(p.productGroupId).toBeNull()
    expect(p.variantKey).toBeNull()
  })

  it('no se puede borrar un padre que todavía tiene productos (RESTRICT)', async () => {
    const g = await prisma.productGroup.create({ data: { venueId, name: 'Playera', categoryId } })
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('avoqado.product_group_writer', 'on', true)`
      await tx.product.create({
        data: { venueId, categoryId, sku: `P-${s}`, name: 'Playera · M', price: 10, productGroupId: g.id, variantKey: 'k1' } as any,
      })
    })
    // Postgres 16 lo reporta como llave foránea (P2003); el 18 de producción como RESTRICT (23001, sin código de Prisma).
    await expect(prisma.productGroup.delete({ where: { id: g.id } })).rejects.toThrow(/Product_productGroupId_fkey|Foreign key constraint/)
  })
})
