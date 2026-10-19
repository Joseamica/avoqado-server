/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/createProductWithVariants.integration.test.ts */
import prisma from '@/utils/prismaClient'
import { archiveProductGroup, createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

describe('createProductWithVariants', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('crear')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  const base = () => ({
    name: 'Playera básica',
    categoryId: n.categoryId,
    options: [
      { name: 'Talla', values: ['S', 'M'] },
      { name: 'Color', values: ['Azul', 'Rojo'] },
    ],
    variants: [
      { values: ['S', 'Azul'], price: 299 },
      { values: ['M', 'Azul'], price: 299, gtin: `750${Date.now()}`.slice(0, 13) },
      { values: ['M', 'Rojo'], price: 329, sku: `ROJA-M-${Date.now()}` },
    ],
  })

  it('crea el padre y una variante por combinación, con nombre, SKU y llave', async () => {
    const r = await createProductWithVariants(n.venueId, base(), n.actor)
    expect(r.productIds).toHaveLength(3)
    const productos = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(productos.map(p => p.name)).toEqual(['Playera básica · S · Azul', 'Playera básica · M · Azul', 'Playera básica · M · Rojo'])
    expect(productos[0].sku).toBe('PLAYERA-BASICA-S-AZUL')
    expect(productos.every(p => p.variantKey && p.categoryId === n.categoryId && p.type === 'REGULAR')).toBe(true)
    expect(Number(productos[2].price)).toBe(329)
  })

  it('🔴 Review Focus 4: un SKU sugerido que ya existe toma sufijo libre; uno pedido que ya existe da 409', async () => {
    await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.categoryId, sku: 'GORRA-UNICA', name: 'Suelto', price: 1 } as any,
    })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Gorra',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['Única'] }],
        variants: [{ values: ['Única'], price: 100 }],
      },
      n.actor,
    )
    const v = await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })
    expect(v.sku).toBe('GORRA-UNICA-2')
    await expect(
      createProductWithVariants(
        n.venueId,
        {
          name: 'Gorra 2',
          categoryId: n.categoryId,
          options: [{ name: 'T', values: ['U'] }],
          variants: [{ values: ['U'], price: 1, sku: 'GORRA-UNICA' }],
        },
        n.actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('🔴 Review Focus 4: un código de barras que ya tiene otro producto da 409 con su nombre', async () => {
    const gtin = `${Date.now()}`.slice(-12)
    await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.categoryId, sku: `X-${gtin}`, gtin, name: 'Tenis', price: 1 } as any,
    })
    await expect(
      createProductWithVariants(
        n.venueId,
        {
          name: 'Calcetín',
          categoryId: n.categoryId,
          options: [{ name: 'T', values: ['U'] }],
          variants: [{ values: ['U'], price: 1, gtin }],
        },
        n.actor,
      ),
    ).rejects.toThrow(/ya lo tiene «Tenis»/)
  })

  it('con inventario: crea la ficha y deja el saldo inicial con su movimiento en el kardex', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Sudadera',
        categoryId: n.categoryId,
        trackInventory: true,
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 500, initialStock: 7 }],
      },
      n.actor,
    )
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { productId: r.productIds[0] } })
    expect(Number(inv.currentStock)).toBe(7)
    const mov = await prisma.inventoryMovement.findMany({ where: { inventoryId: inv.id }, take: 5 })
    expect(mov).toHaveLength(1)
    expect(mov[0]).toMatchObject({ type: 'ADJUSTMENT', reason: 'Saldo inicial (producto con variantes)' })
  })

  it('una combinación con un valor que no existe se rechaza y no deja nada a medias', async () => {
    const antes = await prisma.productGroup.count({ where: { venueId: n.venueId } })
    await expect(
      createProductWithVariants(
        n.venueId,
        { name: 'Falda', categoryId: n.categoryId, options: [{ name: 'Talla', values: ['S'] }], variants: [{ values: ['XL'], price: 1 }] },
        n.actor,
      ),
    ).rejects.toThrow(/no es un valor de Talla/)
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId } })).toBe(antes)
  })

  it('una categoría de otro negocio se rechaza (404)', async () => {
    const ajeno = await crearNegocio('ajeno')
    try {
      await expect(
        createProductWithVariants(n.venueId, { ...base(), name: 'X', categoryId: ajeno.categoryId }, n.actor),
      ).rejects.toMatchObject({
        statusCode: 404,
      })
    } finally {
      await ajeno.limpiar()
    }
  })

  // ── Ronda 1 de la revisión ────────────────────────────────────────────────────────────────────────────────────────

  it('un grupo de extras de otro negocio se rechaza (404)', async () => {
    const ajeno = await crearNegocio('ajeno-extras')
    try {
      const mg = await prisma.modifierGroup.create({ data: { venueId: ajeno.venueId, name: 'Extras ajenos' } })
      await expect(
        createProductWithVariants(
          n.venueId,
          {
            name: 'Gorro',
            categoryId: n.categoryId,
            modifierGroupIds: [mg.id],
            options: [{ name: 'Talla', values: ['U'] }],
            variants: [{ values: ['U'], price: 1 }],
          },
          n.actor,
        ),
      ).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await ajeno.limpiar()
    }
  })

  it('guarda SKU pedido, código de barras, valores de cada variante y extras del padre (copiados a cada variante)', async () => {
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Bordado' } })
    const sku = `CAMISA-ROJA-M-${Date.now()}`
    const gtin = `9${Date.now()}`
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Camisa',
        categoryId: n.categoryId,
        modifierGroupIds: [mg.id],
        options: [
          { name: 'Talla', values: ['S', 'M'] },
          { name: 'Color', values: ['Azul', 'Rojo'] },
        ],
        variants: [
          { values: ['S', 'Azul'], price: 299, gtin },
          { values: ['M', 'Rojo'], price: 329, sku },
          { values: ['M', 'Azul'], price: 299 },
        ],
      },
      n.actor,
    )
    const productos = await prisma.product.findMany({ where: { productGroupId: r.groupId }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(productos[0].gtin).toBe(gtin)
    expect(productos[1].sku).toBe(sku)
    expect(await prisma.productVariantValue.count({ where: { productId: { in: r.productIds } } })).toBe(6)
    const mgDelPadre = await prisma.productGroupModifierGroup.findMany({ where: { groupId: r.groupId }, take: 10 })
    expect(mgDelPadre.map(x => x.modifierGroupId)).toEqual([mg.id])
    expect(await prisma.productModifierGroup.count({ where: { productId: { in: r.productIds }, groupId: mg.id } })).toBe(3)
  })

  it('dos valores con el mismo SKU sugerido en la misma alta: el segundo toma -2, sin 409', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Pantalón corto',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S M', 'S-M'] }],
        variants: [
          { values: ['S M'], price: 1 },
          { values: ['S-M'], price: 1 },
        ],
      },
      n.actor,
    )
    const productos = await prisma.product.findMany({ where: { id: { in: r.productIds } }, orderBy: { displayOrder: 'asc' }, take: 10 })
    expect(productos.map(p => p.sku)).toEqual(['PANTALON-CORTO-S-M', 'PANTALON-CORTO-S-M-2'])
  })

  it('un SKU pedido «1» no choca con otros que sólo empiezan con «1» («10», «1-ABC»)', async () => {
    const otro = await crearNegocio('sku-1')
    try {
      for (const s of ['10', '1-ABC'])
        await prisma.product.create({
          data: { venueId: otro.venueId, categoryId: otro.categoryId, sku: s, name: `Suelto ${s}`, price: 1 } as any,
        })
      const r = await createProductWithVariants(
        otro.venueId,
        {
          name: 'Llavero',
          categoryId: otro.categoryId,
          options: [{ name: 'T', values: ['U'] }],
          variants: [{ values: ['U'], price: 1, sku: '1' }],
        },
        otro.actor,
      )
      expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).sku).toBe('1')
    } finally {
      await otro.limpiar()
    }
  })

  it('un SKU sugerido salta los sufijos numéricos ya usados («-2»), no los de texto («-X»)', async () => {
    for (const s of ['BUFANDA-U', 'BUFANDA-U-2', 'BUFANDA-U-X'])
      await prisma.product.create({ data: { venueId: n.venueId, categoryId: n.categoryId, sku: s, name: `Suelto ${s}`, price: 1 } as any })
    const r = await createProductWithVariants(
      n.venueId,
      { name: 'Bufanda', categoryId: n.categoryId, options: [{ name: 'T', values: ['U'] }], variants: [{ values: ['U'], price: 1 }] },
      n.actor,
    )
    expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).sku).toBe('BUFANDA-U-3')
  })

  it('un SKU sugerido recortado no termina en guion', async () => {
    // suggestSku = 57 «A» + «-X» (59); el recorte a 58 dejaba «AAA…A-».
    const r = await createProductWithVariants(
      n.venueId,
      { name: 'A'.repeat(57), categoryId: n.categoryId, options: [{ name: 'T', values: ['X'] }], variants: [{ values: ['X'], price: 1 }] },
      n.actor,
    )
    expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).sku).toBe('A'.repeat(57))
  })

  it('precio arriba de 10,000,000 → 400 nombrando la combinación, sin dejar el padre', async () => {
    const antes = await prisma.productGroup.count({ where: { venueId: n.venueId } })
    await expect(
      createProductWithVariants(
        n.venueId,
        {
          name: 'Reloj',
          categoryId: n.categoryId,
          options: [
            { name: 'Talla', values: ['S'] },
            { name: 'Color', values: ['Azul'] },
          ],
          variants: [{ values: ['S', 'Azul'], price: 10_000_001 }],
        },
        n.actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: 'El precio de «S · Azul» debe ser mayor a 0 y de hasta 10,000,000.' })
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId } })).toBe(antes)
  })

  it('inventario inicial negativo → 400, sin dejar el padre', async () => {
    const antes = await prisma.productGroup.count({ where: { venueId: n.venueId } })
    await expect(
      createProductWithVariants(
        n.venueId,
        {
          name: 'Chamarra',
          categoryId: n.categoryId,
          trackInventory: true,
          options: [{ name: 'Talla', values: ['M'] }],
          variants: [{ values: ['M'], price: 1, initialStock: -1 }],
        },
        n.actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId } })).toBe(antes)
  })

  // ── /full-testing 14-oct ────────────────────────────────────────────────────────────────────────────────────────────
  const simple = (name: string, variante: Record<string, unknown> = {}) => ({
    name,
    categoryId: n.categoryId,
    options: [{ name: 'Talla', values: ['S', 'M'] }],
    variants: [
      { values: ['S'], price: 10, ...variante },
      { values: ['M'], price: 10 },
    ],
  })

  it('🔴 I-1: dos altas iguales a la vez (doble clic) dejan UNA familia; la otra recibe 409 en español', async () => {
    const res = await Promise.allSettled([
      createProductWithVariants(n.venueId, simple('Doble Clic'), n.actor),
      createProductWithVariants(n.venueId, simple('Doble Clic'), n.actor),
    ])
    expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const [perdida] = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(perdida.reason).toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_NAME_TAKEN',
      message: 'Ya existe la familia «Doble Clic». Ábrela para agregarle variantes.',
    })
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId, name: 'Doble Clic' } })).toBe(1)
    expect(await prisma.product.count({ where: { venueId: n.venueId, sku: { startsWith: 'DOBLE-CLIC' } } })).toBe(2)
  })

  it('🔴 I-1: el nombre choca sin importar mayúsculas, acentos en mayúscula ni espacios; una familia ARCHIVADA no lo aparta', async () => {
    const r = await createProductWithVariants(n.venueId, simple('Taza Térmica'), n.actor)
    await expect(createProductWithVariants(n.venueId, simple('  taza TÉRMICA '), n.actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_NAME_TAKEN',
      message: 'Ya existe la familia «Taza Térmica». Ábrela para agregarle variantes.',
    })
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    await expect(createProductWithVariants(n.venueId, simple('Taza térmica'), n.actor)).resolves.toMatchObject({
      groupId: expect.any(String),
    })
  })

  it('🔴 I-1: el mismo nombre en OTRO negocio no choca', async () => {
    const otro = await crearNegocio('nombre-otro')
    try {
      await createProductWithVariants(n.venueId, simple('Termo'), n.actor)
      await expect(
        createProductWithVariants(otro.venueId, { ...simple('Termo'), categoryId: otro.categoryId }, otro.actor),
      ).resolves.toMatchObject({ groupId: expect.any(String) })
    } finally {
      await otro.limpiar()
    }
  })

  it('🔴 I-3: el motor no redondea en silencio: más de 2 decimales o precio 0 → 400 nombrando la combinación', async () => {
    const antes = await prisma.productGroup.count({ where: { venueId: n.venueId } })
    await expect(createProductWithVariants(n.venueId, simple('Precio raro', { price: 19.999 }), n.actor)).rejects.toMatchObject({
      statusCode: 400,
      message: 'El precio de «S» admite hasta 2 decimales.',
    })
    await expect(createProductWithVariants(n.venueId, simple('Precio cero', { price: 0 }), n.actor)).rejects.toMatchObject({
      statusCode: 400,
      message: 'El precio de «S» debe ser mayor a 0 y de hasta 10,000,000.',
    })
    await expect(createProductWithVariants(n.venueId, simple('Costo raro', { cost: 0.0000001 }), n.actor)).rejects.toMatchObject({
      statusCode: 400,
      message: 'El costo de «S» admite hasta 2 decimales.',
    })
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId } })).toBe(antes)
  })
})
