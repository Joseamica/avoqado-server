/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/updateProductGroup.integration.test.ts */
import prisma from '@/utils/prismaClient'
import { archiveProductGroup, createProductWithVariants, updateProductGroup } from '@/services/product-variants/productGroup.service'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { logAction } from '@/services/dashboard/activity-log.service'
import { crearNegocio, familiaAl8, NegocioDePrueba } from './fixtures'

const mockBroadcastMenuUpdated = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: mockBroadcastMenuUpdated }) },
}))

/** Liga el negocio al catálogo maestro con lo mínimo que acepta la base (artículo completo + una liga). Devuelve su limpieza. */
async function ligarAlCatalogoMaestro(neg: NegocioDePrueba): Promise<() => Promise<void>> {
  const { organizationId, staffId, venueId } = neg
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
  const ref = { organizationId, status: 'ACTIVE' as const, createdById: staffId, updatedById: staffId }
  // El artículo y su SKU corporativo se validan al cerrar la transacción (trigger diferido): van juntos.
  const catalogItemId = await prisma.$transaction(async tx => {
    const brand = await tx.catalogBrand.create({ data: { ...ref, name: `MARCA-${s}`, normalizedName: `MARCA-${s}` } })
    const manufacturer = await tx.catalogManufacturer.create({ data: { ...ref, name: `FAB-${s}`, normalizedName: `FAB-${s}` } })
    const family = await tx.catalogFamily.create({ data: { ...ref, name: `FAM-${s}`, normalizedName: `FAM-${s}` } })
    const item = await tx.catalogItem.create({
      data: {
        ...ref,
        sku: `CORP-${s}`,
        normalizedSku: `CORP-${s}`,
        kind: 'RETAIL_PRODUCT',
        name: `Artículo ${s}`,
        description: 'Artículo de prueba',
        imageUrl: 'https://img/item.png',
        brandId: brand.id,
        manufacturerId: manufacturer.id,
        familyId: family.id,
        presentationLabel: '1 pieza',
        unit: 'PIECE',
        taxRate: 0.16,
        satProductKey: '50161500',
        satUnitKey: 'H87',
        objetoImp: '02',
        productType: 'REGULAR',
        iepsMode: 'NONE',
      },
    })
    await tx.catalogIdentifier.create({
      data: {
        organizationId,
        catalogItemId: item.id,
        code: `CORP-${s}`,
        normalizedCode: `CORP-${s}`,
        type: 'CORPORATE_SKU',
        status: 'ACTIVE',
        createdById: staffId,
      },
    })
    await tx.catalogItemBusinessType.create({ data: { organizationId, catalogItemId: item.id, businessType: 'RETAIL_STORE' } })
    for (const kind of ['SALE_PRICE', 'PURCHASE_COST'] as const)
      await tx.catalogItemPrice.create({
        data: {
          organizationId,
          catalogItemId: item.id,
          kind,
          amount: 10,
          currency: 'MXN',
          active: true,
          createdById: staffId,
          updatedById: staffId,
        },
      })
    return item.id
  })
  await prisma.catalogVenueBinding.create({
    data: { organizationId, catalogItemId, venueId, status: 'PENDING', createdById: staffId, updatedById: staffId },
  })
  return async () => {
    if (!venueId) return
    await prisma.catalogVenueBinding.deleteMany({ where: { venueId } })
    await prisma.catalogItem.deleteMany({ where: { organizationId } }) // sus identificadores, giros y precios caen en cascada
    await prisma.catalogFamily.deleteMany({ where: { organizationId } })
    await prisma.catalogManufacturer.deleteMany({ where: { organizationId } })
    await prisma.catalogBrand.deleteMany({ where: { organizationId } })
  }
}

/** La integración simula logAction (integration-setup.ts): se lee la llamada que recibió. */
const llamadaDeLog = (entityId: string, action: string) =>
  jest
    .mocked(logAction)
    .mock.calls.map(([p]) => p)
    .find(p => p.entityId === entityId && p.action === action)

describe('updateProductGroup', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('editar')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  const crear = (nombre: string) =>
    createProductWithVariants(
      n.venueId,
      {
        name: nombre,
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 100, variantImageUrl: 'https://img/s.png' },
          { values: ['M'], price: 100 },
        ],
        imageUrl: 'https://img/padre.png',
      },
      n.actor,
    )

  it('renombrar el padre renombra sus variantes; categoría y descripción se copian a todas', async () => {
    const r = await crear('Blusa')
    mockBroadcastMenuUpdated.mockClear()
    await updateProductGroup(n.venueId, r.groupId, { name: 'Blusa lino', categoryId: n.otraCategoriaId, description: 'Lino 100%' }, n.actor)
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(vs.map(v => v.name)).toEqual(['Blusa lino · S', 'Blusa lino · M'])
    expect(vs.every(v => v.categoryId === n.otraCategoriaId && v.description === 'Lino 100%')).toBe(true)
    // Los aparatos recargan la categoría nueva Y la vieja (de donde salió la familia), como al agrupar.
    expect(mockBroadcastMenuUpdated).toHaveBeenCalledWith(
      n.venueId,
      expect.objectContaining({ categoryIds: expect.arrayContaining([n.otraCategoriaId, n.categoryId]) }),
    )
  })

  it('la foto del padre llega a las variantes SIN foto propia; la que tiene la suya la conserva', async () => {
    const r = await crear('Short')
    await updateProductGroup(n.venueId, r.groupId, { imageUrl: 'https://img/nueva.png' }, n.actor)
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(vs.map(v => v.imageUrl)).toEqual(['https://img/s.png', 'https://img/nueva.png'])
  })

  it('🔴 IVA todo o nada: si UNA variante tuvo ajuste de delivery, no cambia ninguna y el mensaje la nombra', async () => {
    await encenderIvaPorProducto(n.venueId)
    const r = await crear('Termo')
    await prisma.$executeRawUnsafe(`UPDATE "Product" SET "ajusteDeliveryAlgunaVez" = true WHERE id = $1`, r.productIds[1])
    await expect(updateProductGroup(n.venueId, r.groupId, { ivaTratamiento: 'IVA_0' }, n.actor)).rejects.toThrow(
      /«Termo · M» ya tuvo un ajuste/,
    )
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, take: 10 })
    expect(vs.every(v => v.ivaTratamiento === 'IVA_16')).toBe(true)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).ivaTratamiento).toBe('IVA_16')
  })

  it('cambiar el IVA del padre lo cambia en todas sus variantes (el trigger del IVA deriva la tasa)', async () => {
    await encenderIvaPorProducto(n.venueId)
    const r = await crear('Libreta')
    await updateProductGroup(n.venueId, r.groupId, { ivaTratamiento: 'IVA_0' }, n.actor)
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, take: 10 })
    expect(vs.every(v => v.ivaTratamiento === 'IVA_0' && Number(v.taxRate) === 0)).toBe(true)
    expect(llamadaDeLog(r.groupId, 'PRODUCT_GROUP_UPDATED')?.data).toEqual({
      fields: ['ivaTratamiento'],
      ivaAntes: 'IVA_16',
      ivaDespues: 'IVA_0',
    })
  })

  it('🔴 negocio con el IVA por producto APAGADO: el dueño elige 0 % en la familia y se enciende, igual que en un producto suelto', async () => {
    const x = await crearNegocio('encender')
    const mesero = await prisma.staff.create({ data: { email: `mesero-${Date.now()}@example.test`, firstName: 'Me', lastName: 'Sero' } })
    try {
      await prisma.staffVenue.create({ data: { staffId: x.staffId, venueId: x.venueId, role: 'OWNER', active: true } })
      await prisma.staffVenue.create({ data: { staffId: mesero.id, venueId: x.venueId, role: 'WAITER', active: true } })
      const r = await createProductWithVariants(
        x.venueId,
        {
          name: 'Gorra',
          categoryId: x.categoryId,
          options: [{ name: 'Talla', values: ['S', 'M'] }],
          variants: [
            { values: ['S'], price: 100 },
            { values: ['M'], price: 100 },
          ],
        },
        x.actor,
      )
      // Sólo el dueño o un administrador hace el PRIMER encendido: el mesero recibe 403 y no cambia nada.
      await expect(
        updateProductGroup(x.venueId, r.groupId, { ivaTratamiento: 'IVA_0' }, { type: 'HUMAN', staffId: mesero.id, impersonating: false }),
      ).rejects.toMatchObject({ code: 'IVA_ENCENDIDO_SOLO_DUENO' })
      expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toBeNull()

      await updateProductGroup(x.venueId, r.groupId, { ivaTratamiento: 'IVA_0' }, x.actor)
      const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, take: 10 })
      expect(vs.every(v => v.ivaTratamiento === 'IVA_0' && Number(v.taxRate) === 0)).toBe(true)
      expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).ivaTratamiento).toBe('IVA_0')
      expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toMatchObject({
        habilitadoPorStaffId: x.staffId,
      })
      const activado = await prisma.activityLog.findMany({ where: { venueId: x.venueId, action: 'IVA_POR_PRODUCTO_ACTIVADO' }, take: 5 })
      expect(activado).toHaveLength(1)
      expect(activado[0]).toMatchObject({ staffId: x.staffId, data: { origen: 'DASHBOARD', productoId: null, facturasSelladas: [] } })
    } finally {
      await prisma.activityLog.deleteMany({ where: { venueId: x.venueId } })
      await prisma.venueIvaPorProducto.deleteMany({ where: { venueId: x.venueId } })
      await x.limpiar()
      await prisma.staff.deleteMany({ where: { id: mesero.id } })
    }
  })

  it('los extras del padre reemplazan los de todas sus variantes', async () => {
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Bordado ${Date.now()}` } as any })
    const r = await crear('Gorra')
    await updateProductGroup(n.venueId, r.groupId, { modifierGroupIds: [mg.id] }, n.actor)
    const links = await prisma.productModifierGroup.findMany({ where: { productId: { in: r.productIds } }, take: 10 })
    expect(links).toHaveLength(2)
    expect(links.every(l => l.groupId === mg.id)).toBe(true)
  })

  it('un padre de otro negocio da 404', async () => {
    const r = await crear('Bolsa')
    const ajeno = await crearNegocio('ajeno-editar')
    try {
      await expect(updateProductGroup(ajeno.venueId, r.groupId, { name: 'X' }, ajeno.actor)).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await ajeno.limpiar()
    }
  })

  // ── Ronda 1 ──

  it('🔴 un negocio ligado al catálogo maestro no edita familias (409, sin tocar nada)', async () => {
    const m = await crearNegocio('maestro-editar')
    let desligar: (() => Promise<void>) | undefined
    try {
      const r = await createProductWithVariants(
        m.venueId,
        { name: 'Mochila', categoryId: m.categoryId, options: [{ name: 'Talla', values: ['U'] }], variants: [{ values: ['U'], price: 1 }] },
        m.actor,
      )
      desligar = await ligarAlCatalogoMaestro(m)
      await expect(updateProductGroup(m.venueId, r.groupId, { name: 'Mochila 2' }, m.actor)).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRODUCT_VARIANTS_MASTER_CATALOG',
      })
      expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).name).toBe('Mochila')
    } finally {
      await desligar?.()
      await m.limpiar()
    }
  })

  it('una variante ARCHIVADA también recibe nombre, categoría y extras; no va en productIds', async () => {
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Grabado ${Date.now()}` } as any })
    const r = await crear('Cartera')
    const [viva, archivada] = r.productIds
    await prisma.product.update({ where: { id: archivada }, data: { deletedAt: new Date(), active: false } })
    const res = await updateProductGroup(
      n.venueId,
      r.groupId,
      { name: 'Cartera piel', categoryId: n.otraCategoriaId, modifierGroupIds: [mg.id] },
      n.actor,
    )
    expect(res.productIds).toEqual([viva])
    const a = await prisma.product.findUniqueOrThrow({ where: { id: archivada }, include: { modifierGroups: true } })
    expect(a.name).toBe('Cartera piel · M')
    expect(a.categoryId).toBe(n.otraCategoriaId)
    expect(a.modifierGroups.map(l => l.groupId)).toEqual([mg.id])
  })

  it('renombrar con DOS opciones respeta el orden de las opciones (Talla · Color)', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Playera',
        categoryId: n.categoryId,
        options: [
          { name: 'Talla', values: ['S', 'M'] },
          { name: 'Color', values: ['Azul', 'Rojo'] },
        ],
        variants: [
          { values: ['M', 'Azul'], price: 1 },
          { values: ['S', 'Rojo'], price: 1 },
        ],
      },
      n.actor,
    )
    await updateProductGroup(n.venueId, r.groupId, { name: 'Nuevo' }, n.actor)
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(vs.map(v => v.name)).toEqual(['Nuevo · M · Azul', 'Nuevo · S · Rojo'])
  })

  it('extras de OTRO negocio dan 404 y no tocan nada', async () => {
    const ajeno = await crearNegocio('ajeno-extras')
    try {
      const mg = await prisma.modifierGroup.create({ data: { venueId: ajeno.venueId, name: `Ajeno ${Date.now()}` } as any })
      const r = await crear('Cinturón')
      await expect(updateProductGroup(n.venueId, r.groupId, { modifierGroupIds: [mg.id] }, n.actor)).rejects.toMatchObject({
        statusCode: 404,
      })
      expect(await prisma.productModifierGroup.count({ where: { productId: { in: r.productIds } } })).toBe(0)
    } finally {
      await ajeno.limpiar()
    }
  })

  it('una categoría de demostración se rechaza al editar', async () => {
    const demo = await prisma.menuCategory.create({
      data: { venueId: n.venueId, name: `Demo ${Date.now()}`, slug: `demo-${Date.now()}`, isDemo: true } as any,
    })
    const r = await crear('Pulsera')
    await expect(updateProductGroup(n.venueId, r.groupId, { categoryId: demo.id }, n.actor)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/demostración/),
    })
  })

  it('mandar el MISMO IVA que ya tiene la familia (8 %, ya no se ofrece) no es un cambio: edita el nombre y el IVA se queda', async () => {
    const v = await crearNegocio('editar-iva8')
    try {
      const r = await familiaAl8(v, 'Visera')
      await updateProductGroup(v.venueId, r.groupId, { name: 'Visera sol', ivaTratamiento: 'IVA_8' }, v.actor)
      const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { name: 'asc' }, take: 5 })
      expect(vs.map(x => [x.name, x.ivaTratamiento])).toEqual([
        ['Visera sol · M', 'IVA_8'],
        ['Visera sol · S', 'IVA_8'],
      ])
      expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).ivaTratamiento).toBe('IVA_8')
    } finally {
      await v.limpiar()
    }
  })

  it('sin ningún campo responde «No hay cambios que guardar.»', async () => {
    const r = await crear('Llavero')
    await expect(updateProductGroup(n.venueId, r.groupId, {}, n.actor)).rejects.toMatchObject({
      statusCode: 400,
      message: 'No hay cambios que guardar.',
    })
    await expect(updateProductGroup(n.venueId, r.groupId, { name: undefined }, n.actor)).rejects.toMatchObject({ statusCode: 400 })
  })

  // ── /full-testing 14-oct ────────────────────────────────────────────────────────────────────────────────────────────
  it('🔴 I-1: renombrar a un nombre que ya usa OTRA familia viva → 409; a su propio nombre con otras mayúsculas, sí', async () => {
    const ocupada = await crear('Pañuelo')
    const r = await crear('Paliacate')
    await expect(updateProductGroup(n.venueId, r.groupId, { name: ' PAÑUELO ' }, n.actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_NAME_TAKEN',
      message: 'Ya existe la familia «Pañuelo». Ábrela para agregarle variantes.',
    })
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).name).toBe('Paliacate')
    await updateProductGroup(n.venueId, ocupada.groupId, { name: 'PAÑUELO' }, n.actor)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: ocupada.groupId } })).name).toBe('PAÑUELO')
  })

  it('🔴 I-1: el nombre de una familia ARCHIVADA queda libre para renombrar otra', async () => {
    const vieja = await crear('Diadema')
    await archiveProductGroup(n.venueId, vieja.groupId, n.staffId)
    const r = await crear('Tiara')
    await updateProductGroup(n.venueId, r.groupId, { name: 'Diadema' }, n.actor)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).name).toBe('Diadema')
  })

  it('I-1: el formulario que reenvía el MISMO nombre no choca con un homónimo que ya existía (sólo se revisa un cambio real)', async () => {
    await crear('Gemelo')
    const b = await crear('Gemelo B')
    await prisma.productGroup.update({ where: { id: b.groupId }, data: { name: 'Gemelo' } }) // homónimo anterior a la regla
    await updateProductGroup(n.venueId, b.groupId, { name: 'Gemelo', description: 'Algodón' }, n.actor)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: b.groupId } })).description).toBe('Algodón')
  })
})
