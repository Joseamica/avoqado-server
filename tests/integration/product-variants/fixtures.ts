import prisma from '@/utils/prismaClient'
import type { CatalogActor } from '@/types/master-catalog'
import { applyGroupExisting, previewGroupExisting } from '@/services/product-variants/groupExisting.service'
import type { ProductGroupWriteResult } from '@/services/product-variants/productGroup.service'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'

export interface NegocioDePrueba {
  organizationId: string
  venueId: string
  categoryId: string
  otraCategoriaId: string
  staffId: string
  actor: CatalogActor
  limpiar: () => Promise<void>
}

/** Org → venue → 2 categorías → staff. Ids generados por Prisma (cuid v1). */
export async function crearNegocio(etiqueta: string): Promise<NegocioDePrueba> {
  const s = `${etiqueta}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const org = await prisma.organization.create({ data: { name: `Var ${s}`, email: `var-${s}@example.com`, phone: '5555555555' } })
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: `Var ${s}`, slug: `var-${s}`, seatCapExempt: true } })
  const cat = await prisma.menuCategory.create({ data: { venueId: venue.id, name: `Ropa ${s}`, slug: `ropa-${s}` } as any })
  const otra = await prisma.menuCategory.create({ data: { venueId: venue.id, name: `Blusas ${s}`, slug: `blusas-${s}` } as any })
  const staff = await prisma.staff.create({ data: { email: `staff-${s}@example.test`, firstName: 'Var', lastName: 'Prueba' } })
  const venueId = venue.id
  return {
    organizationId: org.id,
    venueId,
    categoryId: cat.id,
    otraCategoriaId: otra.id,
    staffId: staff.id,
    actor: { type: 'HUMAN', staffId: staff.id, impersonating: false },
    limpiar: async () => {
      if (!venueId) return
      const inv = await prisma.inventory.findMany({ where: { venueId }, select: { id: true }, take: 5000 })
      await prisma.inventoryMovement.deleteMany({ where: { inventoryId: { in: inv.map(i => i.id) } } })
      await prisma.inventory.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.productGroup.deleteMany({ where: { venueId } })
      await prisma.modifierGroup.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.staff.deleteMany({ where: { id: staff.id } })
      await prisma.organization.deleteMany({ where: { id: org.id } })
    },
  }
}

/**
 * Familia con IVA 8 % (como un negocio de la frontera que ya lo tenía): dos sueltos al 8 % agrupados. Sembrar el 8 % pide la
 * bandera del IVA por producto, que se queda ENCENDIDA; la prueba la apaga si necesita el caso heredado.
 */
export async function familiaAl8(n: NegocioDePrueba, nombre: string): Promise<ProductGroupWriteResult> {
  const t = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await encenderIvaPorProducto(n.venueId)
  const sueltos = []
  for (const v of ['S', 'M'])
    sueltos.push(
      await prisma.product.create({
        data: {
          venueId: n.venueId,
          categoryId: n.categoryId,
          sku: `IVA8-${v}-${t}`,
          name: `${nombre} - Talla ${v}`,
          price: 10,
          ivaTratamiento: 'IVA_8',
        } as any,
      }),
    )
  const input = {
    name: nombre,
    options: [{ name: 'Talla', values: ['S', 'M'] }],
    members: sueltos.map((p, i) => ({ productId: p.id, values: [['S', 'M'][i]] })),
  }
  const pv = await previewGroupExisting(n.venueId, input)
  return applyGroupExisting(n.venueId, { ...input, expectedFingerprint: pv.fingerprint }, n.actor)
}
