/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/addArchiveDetach.integration.test.ts */
import prisma from '@/utils/prismaClient'
import {
  addVariants,
  archiveProductGroup,
  createProductWithVariants,
  detachVariant,
  renameOptionValue,
  setVariantImage,
  ungroupProductGroup,
} from '@/services/product-variants/productGroup.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { crearNegocio, familiaAl8, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

describe('agregar, archivar y separar variantes', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('agregar')
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
          { values: ['S'], price: 10 },
          { values: ['M'], price: 10 },
        ],
      },
      n.actor,
    )

  it('agregar la XL crea sólo la variante nueva, con el valor nuevo al final', async () => {
    const r = await crear('Vestido')
    const a = await addVariants(
      n.venueId,
      r.groupId,
      { newValues: [{ optionName: 'talla', values: ['XL'] }], variants: [{ values: ['XL'], price: 12 }] },
      n.actor,
    )
    expect(a.productIds).toHaveLength(1)
    const v = await prisma.product.findUniqueOrThrow({ where: { id: a.productIds[0] } })
    expect(v.name).toBe('Vestido · XL')
    const valores = await prisma.productGroupOptionValue.findMany({
      where: { option: { groupId: r.groupId } },
      orderBy: { position: 'asc' },
      take: 10,
    })
    expect(valores.map(x => x.value)).toEqual(['S', 'M', 'XL'])
  })

  it('la variante nueva lleva inventario como sus hermanas, con su saldo inicial', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Tenis',
        categoryId: n.categoryId,
        trackInventory: true,
        options: [{ name: 'Talla', values: ['25'] }],
        variants: [{ values: ['25'], price: 900 }],
      },
      n.actor,
    )
    const a = await addVariants(
      n.venueId,
      r.groupId,
      { newValues: [{ optionName: 'Talla', values: ['26'] }], variants: [{ values: ['26'], price: 900, initialStock: 4 }] },
      n.actor,
    )
    expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productIds[0] } })).toMatchObject({ trackInventory: true })
    expect(Number((await prisma.inventory.findUniqueOrThrow({ where: { productId: a.productIds[0] } })).currentStock)).toBe(4)
  })

  it('una hermana ARCHIVADA con otro inventario no es la muestra: manda la viva', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Botas',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['25', '26'] }],
        variants: [
          { values: ['25'], price: 900 },
          { values: ['26'], price: 900 },
        ],
      },
      n.actor,
    )
    const [archivada, viva] = r.productIds // la primera creada, sin inventario, queda archivada
    await prisma.product.update({ where: { id: archivada }, data: { deletedAt: new Date(), active: false } })
    await prisma.product.update({ where: { id: viva }, data: { trackInventory: true, inventoryMethod: 'QUANTITY' } })
    const a = await addVariants(
      n.venueId,
      r.groupId,
      { newValues: [{ optionName: 'Talla', values: ['27'] }], variants: [{ values: ['27'], price: 900 }] },
      n.actor,
    )
    expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productIds[0] } })).toMatchObject({ trackInventory: true })
  })

  it('agregar un eje nuevo: las existentes toman el valor por defecto en su nombre y su llave; luego se crea la combinación nueva', async () => {
    const r = await crear('Chamarra')
    await addVariants(
      n.venueId,
      r.groupId,
      {
        newOptions: [{ name: 'Material', values: ['Mezclilla', 'Piel'], defaultValueForExisting: 'Mezclilla' }],
        variants: [{ values: ['M', 'Piel'], price: 50 }],
      },
      n.actor,
    )
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { name: 'asc' }, take: 10 })
    expect(vs.map(v => v.name)).toEqual(['Chamarra · M · Mezclilla', 'Chamarra · M · Piel', 'Chamarra · S · Mezclilla'])
    expect(new Set(vs.map(v => v.variantKey)).size).toBe(3)
  })

  it('un valor que no existe en una opción existente sin declararlo se rechaza', async () => {
    const r = await crear('Abrigo')
    await expect(
      addVariants(n.venueId, r.groupId, { newValues: [{ optionName: 'Material', values: ['Piel'] }], variants: [] }, n.actor),
    ).rejects.toThrow(/no existe/)
  })

  it('un eje nuevo cuyo valor por defecto no es uno de sus valores se rechaza (400)', async () => {
    const r = await crear('Falda')
    await expect(
      addVariants(
        n.venueId,
        r.groupId,
        { newOptions: [{ name: 'Material', values: ['Lino'], defaultValueForExisting: 'Seda' }], variants: [] },
        n.actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('sin valores, opciones ni variantes no hay nada que guardar (400)', async () => {
    const r = await crear('Sombrero')
    await expect(addVariants(n.venueId, r.groupId, { variants: [] }, n.actor)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('renombrar un valor regenera el nombre de sus variantes', async () => {
    const r = await crear('Mochila')
    const valor = await prisma.productGroupOptionValue.findFirstOrThrow({ where: { option: { groupId: r.groupId }, value: 'M' } })
    await renameOptionValue(n.venueId, r.groupId, valor.id, 'Mediana', n.actor)
    expect(
      (await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { name: 'asc' }, take: 5 })).map(p => p.name),
    ).toEqual(['Mochila · Mediana', 'Mochila · S'])
  })

  it('renombrar a un valor que ya existe en la opción responde 409', async () => {
    const r = await crear('Cartera')
    const valor = await prisma.productGroupOptionValue.findFirstOrThrow({ where: { option: { groupId: r.groupId }, value: 'M' } })
    await expect(renameOptionValue(n.venueId, r.groupId, valor.id, ' s ', n.actor)).rejects.toMatchObject({ statusCode: 409 })
  })

  it('renombrar un valor de OTRO padre responde 404', async () => {
    const a = await crear('Cojín')
    const b = await crear('Almohada')
    const ajeno = await prisma.productGroupOptionValue.findFirstOrThrow({ where: { option: { groupId: b.groupId }, value: 'M' } })
    await expect(renameOptionValue(n.venueId, a.groupId, ajeno.id, 'Mediana', n.actor)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('las archivadas también toman el eje nuevo y el valor renombrado', async () => {
    const r = await crear('Sudadera')
    const [archivadaId] = r.productIds // la de «S»
    await prisma.product.update({ where: { id: archivadaId }, data: { deletedAt: new Date(), active: false } })
    await addVariants(
      n.venueId,
      r.groupId,
      { newOptions: [{ name: 'Color', values: ['Gris'], defaultValueForExisting: 'Gris' }], variants: [] },
      n.actor,
    )
    const s = await prisma.productGroupOptionValue.findFirstOrThrow({ where: { option: { groupId: r.groupId }, value: 'S' } })
    await renameOptionValue(n.venueId, r.groupId, s.id, 'Chica', n.actor)
    const archivada = await prisma.product.findUniqueOrThrow({ where: { id: archivadaId }, include: { variantValues: true } })
    expect(archivada.name).toBe('Sudadera · Chica · Gris')
    expect(archivada.variantValues).toHaveLength(2)
  })

  it('la foto propia se pone y se quita por el motor; al quitarla vuelve la del padre', async () => {
    const r = await crear('Lentes')
    await setVariantImage(n.venueId, r.groupId, r.productIds[0], 'https://img/roja.png', n.actor)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).toMatchObject({
      variantImageUrl: 'https://img/roja.png',
      imageUrl: 'https://img/roja.png',
    })
    await setVariantImage(n.venueId, r.groupId, r.productIds[0], null, n.actor)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).toMatchObject({
      variantImageUrl: null,
      imageUrl: null,
    })
  })

  it('🔴 Review Focus 1: dos personas agregan la misma combinación a la vez → una gana y la otra recibe 409, nunca 500', async () => {
    const r = await crear('Pantalón')
    const intento = () =>
      addVariants(
        n.venueId,
        r.groupId,
        { newValues: [{ optionName: 'Talla', values: ['L'] }], variants: [{ values: ['L'], price: 15 }] },
        n.actor,
      )
    const res = await Promise.allSettled([intento(), intento()])
    expect(res.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    const fallo = res.find(x => x.status === 'rejected') as PromiseRejectedResult
    expect(fallo.reason).toMatchObject({ statusCode: 409 })
    expect(await prisma.product.count({ where: { productGroupId: r.groupId, deletedAt: null } })).toBe(3)
    const valores = await prisma.productGroupOptionValue.findMany({
      where: { option: { groupId: r.groupId } },
      orderBy: { position: 'asc' },
      take: 10,
    })
    expect(valores.map(v => v.value)).toEqual(['S', 'M', 'L'])
  })

  it('🔴 una familia con un IVA que ya no se ofrece (8 %) no recibe variantes nuevas: 409 y nada se crea', async () => {
    const v = await crearNegocio('agregar-iva8')
    try {
      // La bandera queda encendida: el trigger dejaría insertar el 8 %; lo que lo impide es la regla de la familia.
      const r = await familiaAl8(v, 'Gorro')
      await expect(
        addVariants(
          v.venueId,
          r.groupId,
          { newValues: [{ optionName: 'Talla', values: ['L'] }], variants: [{ values: ['L'], price: 10 }] },
          v.actor,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRODUCT_GROUP_IVA_NOT_OFFERED',
        message: 'Esta familia tiene IVA «8 %», que ya no se ofrece; cámbialo a 16 %, tasa 0 % o exento antes de agregar variantes.',
      })
      expect(await prisma.product.count({ where: { productGroupId: r.groupId } })).toBe(2)
      expect(await prisma.productGroupOptionValue.count({ where: { option: { groupId: r.groupId } } })).toBe(2)
    } finally {
      await v.limpiar()
    }
  })

  it('archivar el padre archiva todas sus variantes sin borrarlas', async () => {
    const r = await crear('Calcetas')
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    const vs = await prisma.product.findMany({ where: { productGroupId: r.groupId }, take: 10 })
    expect(vs.every(v => v.deletedAt && v.active === false)).toBe(true)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).not.toBeNull()
  })

  it('separar una variante la deja como producto suelto, con su nombre, precio y stock', async () => {
    const r = await crear('Bufanda')
    const antes = await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })
    await detachVariant(n.venueId, r.groupId, r.productIds[0], n.actor)
    const p = await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })
    expect(p).toMatchObject({ productGroupId: null, variantKey: null, name: 'Bufanda · S', price: antes.price, sku: 'BUFANDA-S' })
    expect(await prisma.productVariantValue.count({ where: { productId: p.id } })).toBe(0)
  })

  it('separar la ÚLTIMA viva archiva el padre; antes de eso sigue vivo', async () => {
    const r = await crear('Corbata')
    const [s, m] = r.productIds
    const bitacora = (productId: string, groupArchived: boolean) =>
      expect(logAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'PRODUCT_GROUP_VARIANT_DETACHED',
          entity: 'ProductGroup',
          entityId: r.groupId,
          staffId: n.staffId,
          data: { productId, groupArchived },
        }),
      )
    ;(logAction as jest.Mock).mockClear()
    await detachVariant(n.venueId, r.groupId, s, n.actor)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).toBeNull()
    bitacora(s, false)
    await detachVariant(n.venueId, r.groupId, m, n.actor)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({
      deletedAt: expect.any(Date),
      deletedBy: n.staffId,
    })
    // La bitácora dice que el padre se archivó con la última (el renglón de separar lo lleva en `groupArchived`).
    bitacora(m, true)
    expect(await prisma.product.count({ where: { id: { in: [s, m] }, productGroupId: null } })).toBe(2)
  })

  it('con una archivada, separar la única viva archiva el padre', async () => {
    const r = await crear('Cinturón')
    const [archivada, viva] = r.productIds
    await prisma.product.update({ where: { id: archivada }, data: { deletedAt: new Date(), active: false } })
    await detachVariant(n.venueId, r.groupId, viva, n.actor)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).not.toBeNull()
  })

  it('separar una variante de otro padre responde 404', async () => {
    const a = await crear('Gorra')
    const b = await crear('Visera')
    await expect(detachVariant(n.venueId, a.groupId, b.productIds[0], n.actor)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('separar todo deja todas sueltas y archiva el padre', async () => {
    const r = await crear('Guantes')
    await ungroupProductGroup(n.venueId, r.groupId, n.actor)
    expect(await prisma.product.count({ where: { id: { in: r.productIds }, productGroupId: null } })).toBe(2)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).not.toBeNull()
  })

  // ── /full-testing 14-oct ────────────────────────────────────────────────────────────────────────────────────────────
  it('🔴 I-9: agregar una combinación que existe sólo ARCHIVADA lo dice; una viva sigue con su mensaje', async () => {
    const r = await crear('Rebozo')
    const [s] = r.productIds
    await prisma.product.update({ where: { id: s }, data: { deletedAt: new Date(), active: false } })
    await expect(addVariants(n.venueId, r.groupId, { variants: [{ values: ['s'], price: 10 }] }, n.actor)).rejects.toMatchObject({
      statusCode: 409,
      message: 'La combinación «S» ya existe, archivada.',
    })
    await expect(addVariants(n.venueId, r.groupId, { variants: [{ values: ['M'], price: 10 }] }, n.actor)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Esa combinación ya existe: «Rebozo · M».',
    })
  })

  it('🔴 I-6: renombrar un valor deja en la bitácora el valor anterior y el nuevo', async () => {
    const r = await crear('Mandil')
    const valor = await prisma.productGroupOptionValue.findFirstOrThrow({ where: { option: { groupId: r.groupId }, value: 'M' } })
    ;(logAction as jest.Mock).mockClear()
    await renameOptionValue(n.venueId, r.groupId, valor.id, ' Mediana ', n.actor)
    expect(logAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'PRODUCT_GROUP_VALUE_RENAMED',
        entityId: r.groupId,
        data: { optionValueId: valor.id, antes: 'M', despues: 'Mediana' },
      }),
    )
  })
})
