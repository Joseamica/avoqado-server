/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/groupWriterTx.integration.test.ts */
import prisma from '@/utils/prismaClient'
import {
  addVariants,
  archiveProductGroup,
  createProductWithVariants,
  lockGroup,
  type GroupContext,
} from '@/services/product-variants/productGroup.service'
import {
  attachProductsTx,
  checkVariantRowsAgainstDb,
  createGroupTx,
  ensureOptionValuesTx,
  loadGroupContextTx,
  lockGroupForCleanup,
  optionValuesCapacity,
  reviveGroupTx,
  validateVariantRow,
} from '@/services/product-variants/groupWriterTx'
import { assertLegacyCatalogGovernanceForVenue } from '@/services/master-catalog/catalogGovernance.service'
import { bloquearParaCambiarIva } from '@/services/fiscal/exclusionContable'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: jest.fn() }) },
}))

describe('escritores de la familia con tx (bloque 5, Tarea 2)', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('writer-tx')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  const t = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const contexto = (groupId: string) =>
    prisma.$transaction(tx => loadGroupContextTx(tx, groupId, { trackInventory: false, createdById: null }))
  const gorra = (s: string, valores = ['S', 'M', 'L'], vivas = ['S', 'M'], extra: Record<string, unknown> = {}) =>
    createProductWithVariants(
      n.venueId,
      {
        name: `Gorra ${s}`,
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: valores }],
        variants: vivas.map(v => ({ values: [v], price: 100 })),
        ...extra,
      },
      n.actor,
    )
  const suelto = (sku: string, data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.otraCategoriaId, sku, name: `Suelto ${sku}`, price: 250, ...data } as any,
    })
  /** El orden de candados del encabezado: organización (IVA) → cerco del negocio → familia → productos por id. */
  const conCandados = <T>(groupId: string, productIds: string[], fn: (tx: any) => Promise<T>) =>
    prisma.$transaction(
      async tx => {
        await bloquearParaCambiarIva(tx, { venueId: n.venueId })
        await assertLegacyCatalogGovernanceForVenue(tx, { venueId: n.venueId, operation: 'CREATE', willBeVendable: true, actor: n.actor })
        await lockGroup(tx, n.venueId, groupId)
        if (productIds.length) await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${productIds}::text[]) ORDER BY id FOR UPDATE`
        return fn(tx)
      },
      { timeout: 30_000, maxWait: 10_000 },
    )

  it('validateVariantRow rechaza costo 0, precio con 3 decimales y stock 1.5 con el mismo texto que createVariantRows', async () => {
    const r = await gorra(t())
    const ctx = await contexto(r.groupId)
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ cost: 0 }, 'El costo de «L» debe ser mayor a 0 y hasta 10,000,000.'],
      [{ price: 10.001 }, 'El precio de «L» admite hasta 2 decimales.'],
      [{ initialStock: 1.5 }, 'El inventario inicial de «L» debe ser un número entero entre 0 y 1,000,000.'],
    ]
    for (const [cambio, texto] of casos) {
      const fila = { values: ['L'], price: 100, ...cambio } as any
      expect(validateVariantRow(fila, ctx)).toBe(texto)
      // createVariantRows (por addVariants) responde exactamente lo mismo.
      await expect(addVariants(n.venueId, r.groupId, { variants: [fila] }, n.actor)).rejects.toMatchObject({
        statusCode: 400,
        message: texto,
      })
    }
    expect(validateVariantRow({ values: ['l'], price: 100 }, ctx)).toBeNull()
    expect(validateVariantRow({ values: ['XL'], price: 100 }, ctx)).toBe('«XL» no es un valor de Talla.')
  })

  it('trackInventory por fila: S sin inventario y M con inventario en la misma familia', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Playera ${t()}`,
        categoryId: n.categoryId,
        trackInventory: true,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 100, trackInventory: false, initialStock: 9 },
          { values: ['M'], price: 100, initialStock: 4 },
        ],
      },
      n.actor,
    )
    const [m, s] = await prisma.product.findMany({
      // «… · M» antes que «… · S»
      where: { id: { in: r.productIds } },
      orderBy: { name: 'asc' },
      select: { trackInventory: true, inventoryMethod: true, inventory: { select: { currentStock: true } } },
      take: 2,
    })
    expect(s.trackInventory).toBe(false)
    expect(Number(s.inventory?.currentStock ?? 0)).toBe(0) // sin seguimiento, el saldo inicial no se pone
    expect(m).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY' })
    expect(Number(m.inventory!.currentStock)).toBe(4)
  })

  it('checkVariantRowsAgainstDb marca la combinación archivada', async () => {
    const r = await gorra(t(), ['S', 'M', 'L', 'XL'])
    const archivada = await prisma.product.findFirstOrThrow({ where: { productGroupId: r.groupId, name: { endsWith: '· S' } } })
    const viva = await prisma.product.findFirstOrThrow({ where: { productGroupId: r.groupId, name: { endsWith: '· M' } } })
    await prisma.product.update({ where: { id: archivada.id }, data: { deletedAt: new Date(), active: false } })
    const ctx = await contexto(r.groupId)
    const res = await prisma.$transaction(tx =>
      checkVariantRowsAgainstDb(tx, ctx, [
        { values: ['S'], price: 100 },
        { values: ['M'], price: 100 },
        { values: ['L'], price: 100, sku: viva.sku },
        { values: ['XL'], price: 100 },
      ]),
    )
    expect(res).toEqual([
      'La combinación «S» ya existe, archivada.',
      `Esa combinación ya existe: «${viva.name}».`,
      `El SKU «${viva.sku}» ya lo usa otro producto de esta sucursal.`,
      null,
    ])
    // El SKU también se compara contra las otras filas.
    const dup = await prisma.$transaction(tx =>
      checkVariantRowsAgainstDb(tx, ctx, [
        { values: ['L'], price: 100, sku: `DUP-${t()}` },
        { values: ['XL'], price: 100, sku: 'MAL SKU' },
      ]),
    )
    expect(dup).toEqual([null, 'El SKU «MAL SKU» sólo puede llevar letras, números, guion y guion bajo.'])
  })

  it('checkVariantRowsAgainstDb: un SKU repetido entre filas, y un código repetido entre filas que además ya es de otro producto', async () => {
    const r = await gorra(t(), ['S', 'M', 'L', 'XL'], ['S'])
    const ctx = await contexto(r.groupId)
    const sku = `REP-${t()}`
    expect(
      await prisma.$transaction(tx =>
        checkVariantRowsAgainstDb(tx, ctx, [
          { values: ['M'], price: 100, sku },
          { values: ['L'], price: 100, sku },
        ]),
      ),
    ).toEqual([null, 'Hay SKUs repetidos en las variantes.'])

    const gtin = `75${Date.now()}`.slice(0, 14)
    const ocupado = await suelto(`GTIN-${t()}`, { gtin })
    // La segunda repite el código de la primera; la primera choca con el negocio: cada fila dice lo suyo.
    expect(
      await prisma.$transaction(tx =>
        checkVariantRowsAgainstDb(tx, ctx, [
          { values: ['M'], price: 100, gtin },
          { values: ['L'], price: 100, gtin },
          { values: ['XL'], price: 100 },
        ]),
      ),
    ).toEqual([`El código ${gtin} ya lo tiene «${ocupado.name}».`, 'Hay códigos de barras repetidos en las variantes.', null])
  })

  it('attachProductsTx conserva id, SKU, precio e Inventory y copia categoría e IVA del padre', async () => {
    await encenderIvaPorProducto(n.venueId)
    const r = await gorra(t(), ['S', 'M', 'L'], ['S'], { ivaTratamiento: 'EXENTO' })
    const sku = `SUELTO-${t()}`
    const p = await suelto(sku, { imageUrl: 'https://img.test/suelto.png' })
    const inv = await prisma.inventory.create({ data: { productId: p.id, venueId: n.venueId, currentStock: 7 } })
    const movimientos = await prisma.inventoryMovement.count({ where: { inventoryId: inv.id } })
    const grupo = await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })

    await conCandados(r.groupId, [p.id], async tx => {
      const ctx = await loadGroupContextTx(tx, r.groupId, { trackInventory: false, createdById: null })
      await attachProductsTx(tx, ctx, [{ productId: p.id, values: ['M'], ownImage: 'https://img.test/suelto.png' }])
    })

    const despues = await prisma.product.findUniqueOrThrow({ where: { id: p.id }, include: { variantValues: true } })
    expect(despues).toMatchObject({
      id: p.id,
      sku,
      productGroupId: r.groupId,
      categoryId: n.categoryId,
      ivaTratamiento: 'EXENTO',
      name: `${grupo.name} · M`,
      variantImageUrl: 'https://img.test/suelto.png',
      imageUrl: 'https://img.test/suelto.png',
    })
    expect(Number(despues.price)).toBe(250)
    expect(despues.variantValues).toHaveLength(1)
    expect(Number((await prisma.inventory.findUniqueOrThrow({ where: { id: inv.id } })).currentStock)).toBe(7)
    expect(await prisma.inventoryMovement.count({ where: { inventoryId: inv.id } })).toBe(movimientos)
  })

  it('attachProductsTx rechaza combinación archivada y la 251 sin escribir nada', async () => {
    // Combinación archivada: una fila buena (L) y otra que choca (S, archivada) ⇒ ninguna se escribe.
    const r = await gorra(t())
    const s = await prisma.product.findFirstOrThrow({ where: { productGroupId: r.groupId, name: { endsWith: '· S' } } })
    await prisma.product.update({ where: { id: s.id }, data: { deletedAt: new Date(), active: false } })
    const a = await suelto(`ATT-A-${t()}`)
    const b = await suelto(`ATT-B-${t()}`)
    await conCandados(r.groupId, [a.id, b.id], async tx => {
      const ctx = await loadGroupContextTx(tx, r.groupId, { trackInventory: false, createdById: null })
      await expect(
        attachProductsTx(tx, ctx, [
          { productId: a.id, values: ['L'], ownImage: null },
          { productId: b.id, values: ['S'], ownImage: null },
        ]),
      ).rejects.toMatchObject({ statusCode: 409, message: 'La combinación «S» ya existe, archivada.' })
      // Dentro de la misma transacción: nada quedó escrito antes de lanzar.
      const filas = await tx.product.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { productGroupId: true, name: true },
        take: 2,
      })
      expect(filas.every((f: any) => f.productGroupId === null && f.name.startsWith('Suelto'))).toBe(true)
    })

    // La 251: familia con 250 vivas.
    const letras = Array.from({ length: 25 }, (_, i) => `L${i}`)
    const colores = Array.from({ length: 10 }, (_, i) => `C${i}`)
    const llena = await createProductWithVariants(
      n.venueId,
      {
        name: `Calcetín ${t()}`,
        categoryId: n.categoryId,
        options: [
          { name: 'Talla', values: letras },
          { name: 'Color', values: [...colores, 'C10'] },
        ],
        variants: letras.flatMap(l => colores.map(c => ({ values: [l, c], price: 1 }))),
      },
      n.actor,
    )
    const c = await suelto(`ATT-C-${t()}`)
    await conCandados(llena.groupId, [c.id], async tx => {
      const ctx = await loadGroupContextTx(tx, llena.groupId, { trackInventory: false, createdById: null })
      await expect(attachProductsTx(tx, ctx, [{ productId: c.id, values: ['L0', 'C10'], ownImage: null }])).rejects.toMatchObject({
        statusCode: 409,
        message: 'Un producto puede tener hasta 250 variantes.',
      })
      expect((await tx.product.findUniqueOrThrow({ where: { id: c.id } })).productGroupId).toBeNull()
    })
  })

  it('optionValuesCapacity marca el valor 101', () => {
    const cien = Array.from({ length: 100 }, (_, i) => ({ id: `v${i}`, value: `V${i}`, position: i }))
    const ctx = { options: [{ id: 'o1', name: 'Talla', position: 0, values: cien }] } as unknown as GroupContext
    expect(optionValuesCapacity(ctx, [['v0', 'V99']])).toBeNull() // ya existen (sin importar mayúsculas)
    expect(optionValuesCapacity(ctx, [['Nuevo', 'nuevo']])).toBe('La opción «Talla» puede tener hasta 100 valores.')
    expect(optionValuesCapacity(ctx, [['V1'], ['Rojo']])).toBe('Cada variante necesita un valor por opción (Talla).')
    expect(optionValuesCapacity(ctx, [[' ']])).toBe('Un valor de «Talla» está vacío.')
  })

  it('lockGroupForCleanup bloquea una archivada', async () => {
    const r = await gorra(t())
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    await prisma.$transaction(async tx => {
      await expect(lockGroup(tx, n.venueId, r.groupId)).rejects.toMatchObject({ statusCode: 404 })
      const g = await lockGroupForCleanup(tx, n.venueId, r.groupId)
      expect(g).toMatchObject({ deletedBy: n.staffId, source: 'MANUAL', externalId: null })
      expect(g.deletedAt).toBeInstanceOf(Date)
      // Otra conexión no puede tomar la familia mientras esta transacción la tiene.
      await expect(prisma.$queryRaw`SELECT id FROM "ProductGroup" WHERE id = ${r.groupId} FOR UPDATE NOWAIT`).rejects.toThrow(/55P03|lock/)
      await expect(lockGroupForCleanup(tx, n.venueId, 'cnoexiste0000000000000000')).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  it('ensureOptionValuesTx agrega sólo lo que falta; reviveGroupTx revive; createGroupTx SHOPIFY no aparta el nombre MANUAL', async () => {
    const r = await gorra(t(), ['S'], ['S'])
    const ctx = await conCandados(r.groupId, [], async tx => {
      const c0 = await loadGroupContextTx(tx, r.groupId, { trackInventory: false, createdById: null })
      const c1 = await ensureOptionValuesTx(tx, c0, ['s'])
      const c2 = await ensureOptionValuesTx(tx, c1, ['XL'])
      return c2
    })
    expect(ctx.options[0].values.map(v => [v.value, v.position])).toEqual([
      ['S', 0],
      ['XL', 1],
    ])
    expect(await prisma.productGroupOptionValue.count({ where: { option: { groupId: r.groupId } } })).toBe(2)

    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    await prisma.$transaction(async tx => {
      await lockGroupForCleanup(tx, n.venueId, r.groupId)
      await reviveGroupTx(tx, r.groupId)
    })
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: null, deletedBy: null })

    const nombre = (await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).name
    const { groupId } = await prisma.$transaction(tx =>
      createGroupTx(tx, n.venueId, {
        name: nombre,
        categoryId: n.categoryId,
        type: 'REGULAR',
        imageUrl: null,
        ivaTratamiento: 'IVA_16',
        source: 'SHOPIFY',
        externalId: `gid://shopify/Product/${Date.now()}`,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
      }),
    )
    const creada = await prisma.productGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: { options: { include: { values: true } } },
    })
    expect(creada).toMatchObject({ source: 'SHOPIFY', name: nombre })
    expect(creada.options[0].values).toHaveLength(2)
    // MANUAL con el mismo nombre sí choca.
    await expect(
      prisma.$transaction(tx =>
        createGroupTx(tx, n.venueId, {
          name: nombre,
          categoryId: n.categoryId,
          type: 'REGULAR',
          imageUrl: null,
          ivaTratamiento: 'IVA_16',
          source: 'MANUAL',
          options: [{ name: 'Talla', values: ['S'] }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_NAME_TAKEN' })
  })
})
