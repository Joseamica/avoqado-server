import prisma from '../../../utils/prismaClient'

export interface MenuSnapshotModifier {
  plu: string
  name: string
  price: number
}

export interface MenuSnapshotModifierGroup {
  id: string
  name: string
  required: boolean
  allowMultiple: boolean
  minSelections: number
  maxSelections: number | null
  modifiers: MenuSnapshotModifier[]
}

export interface MenuSnapshotProduct {
  plu: string
  name: string
  description: string | null
  price: number
  imageUrl: string | null
  modifierGroups: MenuSnapshotModifierGroup[]
}

export interface MenuSnapshotCategory {
  name: string
  products: MenuSnapshotProduct[]
}

export interface MenuSnapshot {
  venueId: string
  generatedAt: string
  categories: MenuSnapshotCategory[]
}

/** Menú completo del venue en PESOS — fuente de verdad para publicar a cualquier canal. */
export async function buildMenuSnapshot(venueId: string): Promise<MenuSnapshot> {
  const categories = await prisma.menuCategory.findMany({
    where: { venueId, active: true },
    orderBy: { displayOrder: 'asc' },
    include: {
      products: {
        // deletedAt: null — deleteProduct() del dashboard solo marca deletedAt (no toca
        // active); sin este filtro, productos "borrados" se publicarían al canal.
        where: { active: true, deletedAt: null },
        orderBy: { displayOrder: 'asc' },
        include: {
          modifierGroups: {
            orderBy: { displayOrder: 'asc' },
            include: { group: { include: { modifiers: { where: { active: true } } } } },
          },
        },
      },
    },
  })

  return {
    venueId,
    generatedAt: new Date().toISOString(),
    categories: categories
      .filter(c => c.products.length > 0)
      .map(c => ({
        name: c.name,
        products: c.products.map(p => ({
          plu: p.sku,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          imageUrl: p.imageUrl,
          modifierGroups: p.modifierGroups.map(pmg => ({
            id: pmg.group.id,
            name: pmg.group.name,
            required: pmg.group.required,
            allowMultiple: pmg.group.allowMultiple,
            minSelections: pmg.group.minSelections,
            maxSelections: pmg.group.maxSelections,
            modifiers: pmg.group.modifiers.map(m => ({ plu: `MOD-${m.id}`, name: m.name, price: Number(m.price) })),
          })),
        })),
      })),
  }
}
