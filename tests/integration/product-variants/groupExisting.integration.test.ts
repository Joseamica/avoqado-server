/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/groupExisting.integration.test.ts */
import prisma from '@/utils/prismaClient'
import {
  applyGroupExisting,
  previewGroupExisting,
  proposalsFromShopifyCsv,
  suggestGroups,
} from '@/services/product-variants/groupExisting.service'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { crearNegocio, NegocioDePrueba } from './fixtures'

const mockBroadcastMenuUpdated = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: mockBroadcastMenuUpdated }) },
}))

describe('agrupar productos existentes', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('agrupar')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  const suelto = (name: string, sku: string, data: Record<string, unknown> = {}, venueId = n.venueId, categoryId = n.categoryId) =>
    prisma.product.create({ data: { venueId, categoryId, sku, name, price: 499, ...data } as any })
  // 14 dígitos (GTIN_MAX_LENGTH), únicos por corrida.
  const gtin = (k: string) => `${String(Date.now()).slice(-12)}${k}`

  it('el caso IQ: «BODY HARBOR - Talla 34/36» se sugiere, se agrupa y conserva id, SKU, código, precio y stock', async () => {
    const skuA = `IQ-BH-34-${Date.now()}`
    const codigoA = gtin('01')
    const a = await suelto('BODY HARBOR - Talla 34', skuA, { gtin: codigoA })
    await prisma.inventory.create({ data: { productId: a.id, venueId: n.venueId, currentStock: 7 } })
    const b = await suelto('BODY HARBOR - Talla 36', `IQ-BH-36-${Date.now()}`, { categoryId: n.otraCategoriaId, satProductKey: '53101600' })
    const sug = await suggestGroups(n.venueId, { page: 1, pageSize: 20 })
    const s = sug.items.find(x => x.parentName === 'BODY HARBOR')!
    expect(s.optionNames).toEqual(['Talla'])
    expect(s.members.map(m => m.values)).toEqual([['34'], ['36']])

    const input = {
      name: 'BODY HARBOR',
      options: [{ name: 'Talla', values: ['34', '36'] }],
      members: [
        { productId: a.id, values: ['34'] },
        { productId: b.id, values: ['36'] },
      ],
    }
    const pv = await previewGroupExisting(n.venueId, input)
    const cambiosA = pv.members.find(m => m.productId === a.id)!.changes
    const cambiosB = pv.members.find(m => m.productId === b.id)!.changes
    expect(cambiosB).toContain('Categoría: toma la del producto padre')
    // La clave SAT del padre es la primera NO nula entre los miembros (como la foto): «36» la trae, «34» la toma.
    expect(pv.parent.satProductKey).toBe('53101600')
    expect(cambiosA).toContain('Clave SAT: toma la del producto padre')
    expect(cambiosB).not.toContain('Clave SAT: toma la del producto padre')
    mockBroadcastMenuUpdated.mockClear()
    const r = await applyGroupExisting(n.venueId, { ...input, expectedFingerprint: pv.fingerprint }, n.actor)

    const despues = await prisma.product.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { name: 'asc' }, take: 5 })
    expect(despues.map(p => [p.id, p.name, p.productGroupId, p.categoryId, Number(p.price), p.satProductKey])).toEqual([
      [a.id, 'BODY HARBOR · 34', r.groupId, n.categoryId, 499, '53101600'],
      [b.id, 'BODY HARBOR · 36', r.groupId, n.categoryId, 499, '53101600'],
    ])
    expect([despues[0].sku, despues[0].gtin, despues[1].sku, despues[1].gtin]).toEqual([skuA, codigoA, b.sku, null])
    expect(Number((await prisma.inventory.findUniqueOrThrow({ where: { productId: a.id } })).currentStock)).toBe(7)

    const valores = await prisma.productGroupOptionValue.findMany({
      where: { option: { groupId: r.groupId } },
      orderBy: { position: 'asc' },
      take: 10,
    })
    expect(valores.map(v => v.value)).toEqual(['34', '36'])
    expect(despues.map(p => p.variantKey)).toEqual([valores[0].id, valores[1].id])
    const filas = await prisma.productVariantValue.findMany({ where: { productId: { in: [a.id, b.id] } }, take: 10 })
    expect(filas.map(f => [f.productId, f.optionValueId]).sort()).toEqual(
      [
        [a.id, valores[0].id],
        [b.id, valores[1].id],
      ].sort(),
    )
    // Los aparatos recargan la categoría de donde salió «36» y la del padre.
    expect(mockBroadcastMenuUpdated).toHaveBeenCalledWith(
      n.venueId,
      expect.objectContaining({ categoryIds: expect.arrayContaining([n.categoryId, n.otraCategoriaId]) }),
    )
  })

  it('las claves SAT que manda el dueño ganan (también null); sin ellas, la primera no nula de los miembros', async () => {
    const s = Date.now()
    const a = await suelto(`TENIS RUN - Talla 25 ${s}`, `SAT-25-${s}`, { satProductKey: '53101600', satUnitKey: 'H87' })
    const b = await suelto(`TENIS RUN - Talla 26 ${s}`, `SAT-26-${s}`)
    const base = {
      name: `TENIS RUN ${s}`,
      options: [{ name: 'Talla', values: ['25', '26'] }],
      members: [
        { productId: a.id, values: ['25'] },
        { productId: b.id, values: ['26'] },
      ],
    }
    // Sin claves en la entrada: la primera no nula (las de «25»).
    expect((await previewGroupExisting(n.venueId, base)).parent).toMatchObject({ satProductKey: '53101600', satUnitKey: 'H87' })

    const input = { ...base, satProductKey: '53111600', satUnitKey: null }
    const pv = await previewGroupExisting(n.venueId, input)
    expect(pv.parent).toMatchObject({ satProductKey: '53111600', satUnitKey: null })
    expect(pv.members.find(m => m.productId === a.id)!.changes).toContain('Clave SAT: toma la del producto padre')
    expect(pv.members.find(m => m.productId === b.id)!.changes).toContain('Clave SAT: toma la del producto padre')
    const r = await applyGroupExisting(n.venueId, { ...input, expectedFingerprint: pv.fingerprint }, n.actor)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({
      satProductKey: '53111600',
      satUnitKey: null,
    })
    const despues = await prisma.product.findMany({ where: { id: { in: [a.id, b.id] } }, take: 5 })
    expect(despues.map(p => [p.satProductKey, p.satUnitKey])).toEqual([
      ['53111600', null],
      ['53111600', null],
    ])
  })

  it('🔴 Review Focus 2: un producto de OTRO negocio, archivado o ya agrupado se rechaza sin tocar nada', async () => {
    const ajeno = await crearNegocio('agrupar-ajeno')
    try {
      const mio = await suelto('Falda - Talla 1', `F1-${Date.now()}`)
      const deOtro = await prisma.product.create({
        data: { venueId: ajeno.venueId, categoryId: ajeno.categoryId, sku: `F2-${Date.now()}`, name: 'Falda - Talla 2', price: 1 } as any,
      })
      const input = {
        name: 'Falda',
        options: [{ name: 'Talla', values: ['1', '2'] }],
        members: [
          { productId: mio.id, values: ['1'] },
          { productId: deOtro.id, values: ['2'] },
        ],
      }
      await expect(previewGroupExisting(n.venueId, input)).rejects.toMatchObject({ statusCode: 404 })
      expect((await prisma.product.findUniqueOrThrow({ where: { id: deOtro.id } })).productGroupId).toBeNull()

      // Extras de otro negocio: la vista previa también los rechaza (antes sólo aplicar).
      const extrasAjenos = await prisma.modifierGroup.create({ data: { venueId: ajeno.venueId, name: 'Extras ajenos' } })
      await expect(
        previewGroupExisting(n.venueId, {
          name: 'Falda',
          modifierGroupIds: [extrasAjenos.id],
          options: [{ name: 'Talla', values: ['1'] }],
          members: [{ productId: mio.id, values: ['1'] }],
        }),
      ).rejects.toMatchObject({ statusCode: 404 })

      // La categoría HEREDADA del primer miembro también debe ser del negocio: la FK sola no lo garantiza.
      const conCategoriaAjena = await suelto('Bota - Talla 1', `B1-${Date.now()}`, {}, n.venueId, ajeno.categoryId)
      await expect(
        previewGroupExisting(n.venueId, {
          name: 'Bota',
          options: [{ name: 'Talla', values: ['1'] }],
          members: [{ productId: conCategoriaAjena.id, values: ['1'] }],
        }),
      ).rejects.toMatchObject({ statusCode: 404 })
      await prisma.product.delete({ where: { id: conCategoriaAjena.id } })

      const archivado = await suelto('Top - Talla 1', `T1-${Date.now()}`, { deletedAt: new Date(), active: false })
      await expect(
        previewGroupExisting(n.venueId, {
          name: 'Top',
          options: [{ name: 'Talla', values: ['1'] }],
          members: [{ productId: archivado.id, values: ['1'] }],
        }),
      ).rejects.toThrow(/archivado/)

      const g = await createProductWithVariants(
        n.venueId,
        { name: 'Saco', categoryId: n.categoryId, options: [{ name: 'T', values: ['U'] }], variants: [{ values: ['U'], price: 1 }] },
        n.actor,
      )
      await expect(
        previewGroupExisting(n.venueId, {
          name: 'Otro',
          options: [{ name: 'T', values: ['U'] }],
          members: [{ productId: g.productIds[0], values: ['U'] }],
        }),
      ).rejects.toThrow(/ya es variante/)
    } finally {
      await ajeno.limpiar()
    }
  })

  it('si los productos cambiaron después de la vista previa, aplicar responde 409 y no agrupa', async () => {
    const a = await suelto('Polo - Talla S', `P-S-${Date.now()}`)
    const input = { name: 'Polo', options: [{ name: 'Talla', values: ['S'] }], members: [{ productId: a.id, values: ['S'] }] }
    const pv = await previewGroupExisting(n.venueId, input)
    await prisma.product.update({ where: { id: a.id }, data: { name: 'Polo editado - Talla S' } })
    await expect(applyGroupExisting(n.venueId, { ...input, expectedFingerprint: pv.fingerprint }, n.actor)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).productGroupId).toBeNull()
  })

  it('🔴 I-1: agrupar con el nombre de OTRA familia viva → 409 en la vista previa y al aplicar; nada se agrupa', async () => {
    await createProductWithVariants(
      n.venueId,
      { name: 'Huarache', categoryId: n.categoryId, options: [{ name: 'T', values: ['U'] }], variants: [{ values: ['U'], price: 1 }] },
      n.actor,
    )
    const a = await suelto('Huarache - Talla 25', `HU-25-${Date.now()}`)
    const input = { name: 'huarache', options: [{ name: 'Talla', values: ['25'] }], members: [{ productId: a.id, values: ['25'] }] }
    const conflicto = {
      statusCode: 409,
      code: 'PRODUCT_GROUP_NAME_TAKEN',
      message: 'Ya existe la familia «Huarache». Ábrela para agregarle variantes.',
    }
    await expect(previewGroupExisting(n.venueId, input)).rejects.toMatchObject(conflicto)
    await expect(applyGroupExisting(n.venueId, { ...input, expectedFingerprint: 'x' }, n.actor)).rejects.toMatchObject(conflicto)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).productGroupId).toBeNull()
  })

  it('🔴 Codex #6: confirmar con OTRAS opciones (mismo valor «M») y la huella de la vista previa responde 409 y no agrupa', async () => {
    const a = await suelto('Blusa - M', `BL-M-${Date.now()}`)
    const vista = { name: 'Blusa', options: [{ name: 'Talla', values: ['M'] }], members: [{ productId: a.id, values: ['M'] }] }
    const pv = await previewGroupExisting(n.venueId, vista)
    const otra = { ...vista, options: [{ name: 'Color', values: ['M', 'L'] }] }
    await expect(applyGroupExisting(n.venueId, { ...otra, expectedFingerprint: pv.fingerprint }, n.actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_PREVIEW_STALE',
    })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: a.id } })).productGroupId).toBeNull()
  })

  it('🔴 dos agrupaciones a la vez con un producto en común: una gana, la otra recibe 409 y nada queda a medias', async () => {
    const t = Date.now()
    const x = await suelto('Chamarra - Talla M', `CH-M-${t}`)
    const y = await suelto('Chamarra - Talla L', `CH-L-${t}`)
    const z = await suelto('Chamarra - Talla XL', `CH-XL-${t}`)
    const conjunto = (nombre: string, otro: { id: string }, valor: string) => ({
      name: nombre,
      options: [{ name: 'Talla', values: ['M', valor] }],
      members: [
        { productId: x.id, values: ['M'] },
        { productId: otro.id, values: [valor] },
      ],
    })
    const uno = conjunto(`Chamarra A ${t}`, y, 'L')
    const dos = conjunto(`Chamarra B ${t}`, z, 'XL')
    const [pv1, pv2] = await Promise.all([previewGroupExisting(n.venueId, uno), previewGroupExisting(n.venueId, dos)])
    const res = await Promise.allSettled([
      applyGroupExisting(n.venueId, { ...uno, expectedFingerprint: pv1.fingerprint }, n.actor),
      applyGroupExisting(n.venueId, { ...dos, expectedFingerprint: pv2.fingerprint }, n.actor),
    ])
    const ganadoras = res.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applyGroupExisting>>> => r.status === 'fulfilled',
    )
    const perdedoras = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ganadoras).toHaveLength(1)
    expect(perdedoras).toHaveLength(1)
    expect(perdedoras[0].reason).toMatchObject({ statusCode: 409 })

    const gano = res[0].status === 'fulfilled' ? 0 : 1
    const [ganador, perdedor] = gano === 0 ? [uno, dos] : [dos, uno]
    const suyo = gano === 0 ? z : y // el producto exclusivo de la que perdió
    expect((await prisma.product.findUniqueOrThrow({ where: { id: x.id } })).productGroupId).toBe(ganadoras[0].value.groupId)
    const intacto = await prisma.product.findUniqueOrThrow({ where: { id: suyo.id } })
    expect([intacto.productGroupId, intacto.variantKey, intacto.name]).toEqual([null, null, suyo.name])
    expect(await prisma.productVariantValue.count({ where: { productId: suyo.id } })).toBe(0)
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId, name: perdedor.name } })).toBe(0)
    expect(await prisma.productGroup.count({ where: { venueId: n.venueId, name: ganador.name } })).toBe(1)
  })

  // El enum OriginSystem no tiene SOFTRESTAURANT: el valor real de un producto sincronizado desde ese POS es POS_SOFTRESTAURANT.
  it('un producto que viene de SoftRestaurant (originSystem distinto) no se agrupa', async () => {
    const pos = await suelto('Refresco - Talla Ch', `POS-${Date.now()}`, { originSystem: 'POS_SOFTRESTAURANT' })
    await expect(
      previewGroupExisting(n.venueId, {
        name: 'Refresco',
        options: [{ name: 'Talla', values: ['Ch'] }],
        members: [{ productId: pos.id, values: ['Ch'] }],
      }),
    ).rejects.toThrow(/otro sistema/)
  })

  describe('IVA heredado que ya no se ofrece (8 %)', () => {
    let iva: NegocioDePrueba
    let t: number
    beforeAll(async () => {
      iva = await crearNegocio('agrupar-iva')
      t = Date.now()
      // Sembrar un IVA 8 % pide la bandera; luego se apaga: así queda un 8 % HEREDADO, como en un negocio de la frontera.
      await prisma.venueIvaPorProducto.create({ data: { venueId: iva.venueId } })
      for (const [k, tasa] of [
        ['a', 'IVA_8'],
        ['b', 'IVA_8'],
        ['c', 'IVA_8'],
        ['d', 'IVA_16'],
        ['e', 'IVA_16'],
        ['f', 'IVA_8'],
      ])
        await suelto(`Gorra - Talla ${k}`, `IVA-${k}-${t}`, { ivaTratamiento: tasa }, iva.venueId, iva.categoryId)
      await prisma.venueIvaPorProducto.delete({ where: { venueId: iva.venueId } })
    })
    afterAll(async () => {
      await iva?.limpiar()
    })
    const id = async (k: string) => (await prisma.product.findFirstOrThrow({ where: { venueId: iva.venueId, sku: `IVA-${k}-${t}` } })).id
    const entrada = async (nombre: string, k1: string, k2: string) => ({
      name: nombre,
      options: [{ name: 'Talla', values: [k1, k2] }],
      members: [
        { productId: await id(k1), values: [k1] },
        { productId: await id(k2), values: [k2] },
      ],
    })

    it('dos miembros con 8 %: se agrupan y nadie cambia de IVA', async () => {
      const input = await entrada('Gorra A', 'a', 'b')
      const pv = await previewGroupExisting(iva.venueId, input)
      expect(pv.parent.ivaTratamiento).toBe('IVA_8')
      expect(pv.members.flatMap(m => m.changes).some(c => c.startsWith('IVA'))).toBe(false)
      const r = await applyGroupExisting(iva.venueId, { ...input, expectedFingerprint: pv.fingerprint }, iva.actor)
      const filas = await prisma.product.findMany({ where: { id: { in: r.productIds } }, select: { ivaTratamiento: true }, take: 5 })
      expect(filas.map(f => f.ivaTratamiento)).toEqual(['IVA_8', 'IVA_8'])
      expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).ivaTratamiento).toBe('IVA_8')
    })

    it('8 % primero y 16 % después: 409, porque el 8 % ya no se ofrece para quien cambiaría', async () => {
      await expect(previewGroupExisting(iva.venueId, await entrada('Gorra B', 'c', 'd'))).rejects.toMatchObject({
        statusCode: 409,
        code: 'PRODUCT_GROUP_IVA_NOT_OFFERED',
        message: 'El IVA «8 %» ya no se ofrece; elige 16 %, tasa 0 % o exento.',
      })
    })

    it('16 % primero y 8 % después: se permite y el cambio de IVA aparece en la vista previa', async () => {
      const input = await entrada('Gorra C', 'e', 'f')
      const pv = await previewGroupExisting(iva.venueId, input)
      expect(pv.members[1].changes).toContain('IVA: 8 % → 16 %')
      expect(pv.warnings).toEqual(['Cambia el IVA de 1 producto(s).'])
      const r = await applyGroupExisting(iva.venueId, { ...input, expectedFingerprint: pv.fingerprint }, iva.actor)
      expect((await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[1] } })).ivaTratamiento).toBe('IVA_16')
    })
  })

  describe('propuestas desde el CSV de Shopify', () => {
    it('empata por SKU o por código, y reporta conflictos sin adivinar', async () => {
      const t = Date.now()
      const s = (k: string) => `CSV${k}${t}`
      const [cB, cD] = [gtin('11'), gtin('22')]
      const p: Record<string, { id: string }> = {}
      for (const k of ['A', 'C', 'E', 'F', 'G', 'H', 'I', 'J']) p[k] = await suelto(`Prenda ${k}`, s(k))
      p.B = await suelto('Prenda B', s('B'), { gtin: cB })
      p.D = await suelto('Prenda D', s('D'), { gtin: cD })
      const csv = [
        'Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Barcode',
        `camisa-${t},Camisa,Talla,S,${s('A')},`,
        `camisa-${t},,,M,NOEXISTE${t},'${cB}`, // por código
        `camisa-${t},,,L,${s('C')},${cD}`, // el SKU y el código son de productos distintos
        `camisa-${t},,,m,${s('J')},`, // «m» y «M» son el mismo valor de la opción
        `pantalon-${t},Pantalón,Talla,30,${s('E')},`,
        `pantalon-${t},,,32,${s('F')},`,
        `pantalon-${t},,,34,${s('H')},`,
        `short-${t},Short,Talla,28,${s('E')},`, // el mismo producto en otra fila (otro handle)
        `short-${t},,,30,${s('G')},`,
        `short-${t},,,32,${s('I')},`,
      ].join('\n')
      const { proposals, skippedHandles } = await proposalsFromShopifyCsv(n.venueId, csv)
      expect(skippedHandles).toBe(0)
      const de = (h: string) => proposals.find(x => x.handle === `${h}-${t}`)!

      expect(de('camisa').members.map(m => [m.productId, m.values])).toEqual([
        [p.A.id, ['S']],
        [p.B.id, ['M']],
      ])
      expect(de('camisa').options).toEqual([{ name: 'Talla', values: ['S', 'M'] }])
      // «m» es la misma combinación que «M»: la segunda fila no entra como miembro, se reporta.
      expect(de('camisa').conflicts).toHaveLength(2)
      expect(de('camisa').conflicts[0]).toContain(s('C'))
      expect(de('camisa').conflicts[1]).toContain(s('J'))
      expect(de('camisa').conflicts[1]).toContain('ya la tiene «Prenda B»')

      for (const [h, miembros] of [
        ['pantalon', [p.F.id, p.H.id]],
        ['short', [p.G.id, p.I.id]],
      ] as const) {
        expect(de(h).members.map(m => m.productId)).toEqual(miembros)
        expect(de(h).conflicts).toHaveLength(1)
        expect(de(h).conflicts[0]).toContain(`pantalon-${t}`)
        expect(de(h).conflicts[0]).toContain(`short-${t}`)
      }
      expect(proposals.flatMap(x => x.members).some(m => m.productId === p.E.id)).toBe(false)
    })

    it('🔴 capacidad: 2,000 filas que pegan al mismo producto dan UN conflicto corto (no uno por fila que lista todas)', async () => {
      const t = Date.now()
      const s = (k: string) => `CAP${k}${t}`
      const [e, f, h] = [await suelto('Cap E', s('E')), await suelto('Cap F', s('F')), await suelto('Cap H', s('H'))]
      const filas = [`cap-${t},Cap,Talla,1,${s('F')},`, `cap-${t},,,2,${s('H')},`]
      for (let i = 0; i < 2000; i++) filas.push(`cap-${t},,,x${i},${s('E')},`)
      const csv = ['Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Barcode', ...filas].join('\n')
      const { proposals } = await proposalsFromShopifyCsv(n.venueId, csv)
      const pr = proposals.find(x => x.handle === `cap-${t}`)!
      expect(pr.members.map(m => m.productId)).toEqual([f.id, h.id])
      expect(pr.conflicts).toHaveLength(1)
      expect(pr.conflicts[0]).toContain('«Cap E» aparece en 2000 filas')
      expect(pr.conflicts[0].length).toBeLessThan(300)
      expect(proposals.flatMap(x => x.members).some(m => m.productId === e.id)).toBe(false)
    })

    it('un archivo sin columna Handle responde 400', async () => {
      await expect(proposalsFromShopifyCsv(n.venueId, 'Title,Variant SKU\nCamisa,X1')).rejects.toMatchObject({ statusCode: 400 })
    })
  })
})
