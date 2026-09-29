/**
 * IVA por producto, plan 5 — «Reemplazar menú» (D2, D4) y restaurar por SKU (D3), con la base simulada. La base real vive
 * en tests/integration/dashboard/reemplazarMenu.integration.test.ts.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import {
  assertLegacyCatalogGovernanceComputedForVenue,
  assertLegacyCatalogGovernanceForVenue,
} from '@/services/master-catalog/catalogGovernance.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceComputedForVenue: jest.fn(),
  assertLegacyCatalogGovernanceForVenue: jest.fn(), // la restauración lo vuelve a llamar (Tarea 4, P5-R16)
  writeLegacyServiceProductCreationAuditForVenue: jest.fn(),
}))

const V = 'venue-1'
const HUMANO = { type: 'HUMAN' as const, staffId: 'staff-1', impersonating: false }
const archivo = (mode: 'merge' | 'replace', categorias: Array<{ name: string; slug: string; skus: string[] }>) => ({
  mode,
  categories: categorias.map(c => ({ name: c.name, slug: c.slug, products: c.skus.map(sku => ({ name: sku, sku, price: 10 })) })),
})

beforeEach(() => {
  jest.mocked(assertLegacyCatalogGovernanceComputedForVenue).mockReset()
  jest.mocked(assertLegacyCatalogGovernanceForVenue).mockReset()
  prismaMock.$transaction.mockImplementation((async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)) as never)
  prismaMock.product.findMany.mockResolvedValue([])
  prismaMock.product.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.product.findFirst.mockResolvedValue(null)
  prismaMock.product.create.mockResolvedValue({ id: 'prod-nuevo' } as never)
  prismaMock.product.update.mockResolvedValue({ id: 'prod-1' } as never)
  prismaMock.menu.findFirst.mockResolvedValue({ id: 'menu-1' } as never)
  prismaMock.menuCategory.findFirst.mockResolvedValue(null)
  prismaMock.menuCategory.create.mockResolvedValue({ id: 'cat-nueva' } as never)
})

describe('D2 · «Reemplazar» nunca borra un producto: archiva los que el archivo no trae', () => {
  it('no llama product.deleteMany; archiva los SKU ausentes y no archivados, y lo cuenta en el resumen y en MENU_IMPORTED', async () => {
    prismaMock.product.updateMany.mockResolvedValue({ count: 3 })

    const r = await importMenu(V, archivo('replace', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A', 'B'] }]), HUMANO)

    expect(prismaMock.product.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.product.updateMany).toHaveBeenCalledWith({
      where: { venueId: V, sku: { notIn: ['A', 'B'] }, deletedAt: null },
      data: { deletedAt: expect.any(Date), deletedBy: 'staff-1', active: false },
    })
    expect(r.stats).toMatchObject({ productsArchived: 3 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MENU_IMPORTED', data: expect.objectContaining({ mode: 'replace', productsArchived: 3 }) }),
    )
  })

  it('D4 · borra las categorías sin NINGÚN producto y apaga las demás, DESPUÉS de archivar', async () => {
    await importMenu(V, archivo('replace', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(prismaMock.menuCategory.deleteMany).toHaveBeenCalledWith({ where: { venueId: V, products: { none: {} } } })
    expect(prismaMock.menuCategory.updateMany).toHaveBeenCalledWith({ where: { venueId: V }, data: { active: false } })
    expect(prismaMock.product.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.menuCategory.deleteMany.mock.invocationCallOrder[0],
    )
  })

  it('D4 · la categoría se busca por nombre y, si no, por slug; la reutilizada se enciende y vuelve al menú principal (upsert)', async () => {
    prismaMock.menuCategory.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'cat-vieja', active: false } as never)

    await importMenu(V, archivo('replace', [{ name: 'BEBIDAS', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(prismaMock.menuCategory.findFirst).toHaveBeenNthCalledWith(1, { where: { venueId: V, name: 'BEBIDAS' } })
    expect(prismaMock.menuCategory.findFirst).toHaveBeenNthCalledWith(2, { where: { venueId: V, slug: 'bebidas' } })
    expect(prismaMock.menuCategory.create).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.update).toHaveBeenCalledWith({ where: { id: 'cat-vieja' }, data: { active: true } })
    expect(prismaMock.menuCategoryAssignment.upsert).toHaveBeenCalledWith({
      where: { menuId_categoryId: { menuId: 'menu-1', categoryId: 'cat-vieja' } },
      create: { menuId: 'menu-1', categoryId: 'cat-vieja', displayOrder: 0 },
      update: {},
    })
  })

  it('P5-R15 · conserva APAGADOS los grupos de extras que usa una liga viva o una receta variable; borra los demás y los vínculos como hoy', async () => {
    await importMenu(V, archivo('replace', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    const extrasEnUso = {
      OR: [{ linkedRecipeLines: { some: {} } }, { modifiers: { some: { paymentLinkItems: { some: {} } } } }],
    }
    expect(prismaMock.productModifierGroup.deleteMany).toHaveBeenCalledWith({ where: { product: { venueId: V } } })
    expect(prismaMock.modifier.deleteMany).toHaveBeenCalledWith({ where: { group: { venueId: V, NOT: extrasEnUso } } })
    expect(prismaMock.modifierGroup.deleteMany).toHaveBeenCalledWith({ where: { venueId: V, NOT: extrasEnUso } })
    expect(prismaMock.modifier.updateMany).toHaveBeenCalledWith({ where: { group: { venueId: V } }, data: { active: false } })
    expect(prismaMock.modifierGroup.updateMany).toHaveBeenCalledWith({ where: { venueId: V }, data: { active: false } })
    // Se apaga lo que queda DESPUÉS de borrar lo demás: sólo sobreviven los que algo usa.
    expect(prismaMock.modifierGroup.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.modifierGroup.updateMany.mock.invocationCallOrder[0],
    )
  })

  /** Un archivo con un Latte cuyo grupo «Leche» trae reglas y precio NUEVOS: opcional, hasta 2, «Avena» a $30. */
  const conLeche = (mode: 'merge' | 'replace') => ({
    mode,
    categories: [
      {
        name: 'Bebidas',
        slug: 'bebidas',
        products: [
          {
            name: 'Latte',
            sku: 'LATTE',
            price: 60,
            modifierGroups: [
              {
                name: 'Leche',
                required: false,
                allowMultiple: true,
                minSelections: 0,
                maxSelections: 2,
                modifiers: [{ name: 'Avena', price: 30 }],
              },
            ],
          },
        ],
      },
    ],
  })
  /** El grupo y el extra que «Reemplazar» conservó apagados: obligatorio, uno solo, «Avena» a $20. */
  const conservados = () => {
    prismaMock.modifierGroup.findFirst.mockResolvedValueOnce({
      id: 'grupo-leche',
      active: false,
      required: true,
      allowMultiple: false,
      minSelections: 1,
      maxSelections: 1,
    } as never)
    prismaMock.modifier.findFirst.mockResolvedValueOnce({ id: 'extra-avena', active: false, price: 20 } as never)
  }

  it('P5-R15 · «Reemplazar» reutiliza el grupo y el extra conservados (mismo id), los enciende y les pone las reglas y el PRECIO del archivo', async () => {
    conservados()

    await importMenu(V, conLeche('replace'), HUMANO)

    expect(prismaMock.modifierGroup.create).not.toHaveBeenCalled()
    expect(prismaMock.modifierGroup.update).toHaveBeenCalledWith({
      where: { id: 'grupo-leche' },
      data: { active: true, required: false, allowMultiple: true, minSelections: 0, maxSelections: 2 },
    })
    expect(prismaMock.modifier.create).not.toHaveBeenCalled()
    // $20 → $30: sin esto todo POS seguiría cobrando $20 (el servidor cobra Modifier.price).
    expect(prismaMock.modifier.update).toHaveBeenCalledWith({ where: { id: 'extra-avena' }, data: { active: true, price: 30 } })
  })

  it('REGRESIÓN · «Combinar» no sobrescribe precio ni reglas de un grupo o extra existente: sólo enciende el que estaba apagado', async () => {
    conservados()

    await importMenu(V, conLeche('merge'), HUMANO)

    expect(prismaMock.modifierGroup.update).toHaveBeenCalledWith({ where: { id: 'grupo-leche' }, data: { active: true } })
    expect(prismaMock.modifier.update).toHaveBeenCalledWith({ where: { id: 'extra-avena' }, data: { active: true } })
  })

  it('REGRESIÓN · «Combinar» no archiva ni toca categorías ajenas al archivo; la nueva se asigna como hoy', async () => {
    await importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(prismaMock.product.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.create).toHaveBeenCalledTimes(1)
  })

  it('REGRESIÓN · «Combinar» con una categoría vigente encontrada por nombre: ni la toca ni la reasigna', async () => {
    prismaMock.menuCategory.findFirst.mockResolvedValueOnce({ id: 'cat-1', active: true } as never)

    await importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.upsert).not.toHaveBeenCalled()
  })
})
