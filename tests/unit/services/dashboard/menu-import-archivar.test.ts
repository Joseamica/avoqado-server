/**
 * IVA por producto, plan 5 — «Reemplazar menú» (D2, D4) y restaurar por SKU (D3), con la base simulada. La base real vive
 * en tests/integration/dashboard/reemplazarMenu.integration.test.ts.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import AppError from '@/errors/AppError'
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

describe('D3 · el SKU de un archivado regresa el MISMO producto', () => {
  it('lo restaura por el MISMO update de hoy: deletedAt y deletedBy a null y active=true; cuenta en el resumen y en MENU_IMPORTED', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-1', sku: 'A', deletedAt: new Date('2026-09-01'), active: false } as never)

    const r = await importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(prismaMock.product.create).not.toHaveBeenCalled()
    expect(prismaMock.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: expect.objectContaining({ name: 'A', price: 10, deletedAt: null, deletedBy: null, active: true }),
    })
    expect(r.stats).toMatchObject({ products: 1, productsRestored: 1 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MENU_IMPORTED', data: expect.objectContaining({ productsRestored: 1 }) }),
    )
  })

  it('P5-R16 · restaurar vuelve a preguntar al cerco como ACTIVACIÓN, en la misma transacción y ANTES del update', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-1', sku: 'A', deletedAt: new Date('2026-09-01'), active: false } as never)

    await importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(assertLegacyCatalogGovernanceForVenue).toHaveBeenCalledWith(prismaMock, {
      venueId: V,
      operation: 'ACTIVATE',
      willBeVendable: true,
      actor: HUMANO,
    })
    expect(jest.mocked(assertLegacyCatalogGovernanceForVenue).mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.product.update.mock.invocationCallOrder[0],
    )
  })

  it('REGRESIÓN (Review Focus 5) · un vigente, aunque esté en «86», se actualiza sin tocar active, deletedAt ni deletedBy', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-1', sku: 'A', deletedAt: null, active: false } as never)

    await importMenu(V, archivo('replace', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    const data = (prismaMock.product.update.mock.calls[0][0] as { data: Record<string, unknown> }).data
    expect(data).not.toHaveProperty('active')
    expect(data).not.toHaveProperty('deletedAt')
    expect(data).not.toHaveProperty('deletedBy')
    expect(assertLegacyCatalogGovernanceForVenue).not.toHaveBeenCalled() // un vigente no se activa: sin segunda consulta
  })

  it('gobierno ENFORCED · restaurar cuenta como CREACIÓN: la precuenta ya no ve archivados y el cerco responde 422 antes de escribir', async () => {
    // «La base»: la fila del SKU existe pero está ARCHIVADA; sólo aparece si la consulta no excluye archivados.
    prismaMock.product.findMany.mockImplementation((async (args: { where: { deletedAt?: null } }) =>
      args.where.deletedAt === null ? [] : [{ sku: 'A' }]) as never)
    jest.mocked(assertLegacyCatalogGovernanceComputedForVenue).mockImplementation(async (_tx, _input, inspect) => {
      if (await inspect()) {
        throw new AppError('Este producto debe crearse o activarse desde el Catálogo maestro.', 422, true, 'CATALOG_GOVERNANCE_REQUIRED')
      }
    })

    await expect(importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)).rejects.toMatchObject({
      statusCode: 422,
      code: 'CATALOG_GOVERNANCE_REQUIRED',
    })
    expect(prismaMock.product.update).not.toHaveBeenCalled()
  })

  it('REGRESIÓN (P5-R3) · «Reemplazar» sigue contando TODO lo que llega como creación, sin consultar', async () => {
    let decision: boolean | undefined
    jest.mocked(assertLegacyCatalogGovernanceComputedForVenue).mockImplementation(async (_tx, _input, inspect) => {
      decision = await inspect()
    })

    await importMenu(V, archivo('replace', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(decision).toBe(true)
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
  })
})

describe('MENU_IMPORTED registra quién importó (revisión de la Tarea 3)', () => {
  it('lleva el staffId del actor humano', async () => {
    await importMenu(V, archivo('merge', [{ name: 'Bebidas', slug: 'bebidas', skus: ['A'] }]), HUMANO)

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'MENU_IMPORTED', staffId: 'staff-1' }))
  })
})
