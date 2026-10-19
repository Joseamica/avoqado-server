import { prismaMock } from '@tests/__helpers__/setup'
import { previewGroupExisting, proposalsFromShopifyCsv } from '@/services/product-variants/groupExisting.service'

const base = {
  id: 'p1',
  name: 'Tenis - Talla 26',
  sku: 'TN-26',
  categoryId: 'c1',
  type: 'REGULAR',
  ivaTratamiento: 'IVA_16',
  description: null,
  imageUrl: null,
  printStationId: null,
  satProductKey: null,
  satUnitKey: null,
  deletedAt: null,
  productGroupId: null,
  originSystem: 'SHOPIFY',
  updatedAt: new Date(),
  ajusteDeliveryAlgunaVez: false,
  modifierGroups: [],
}

// El chequeo de nombre de familia repetido pregunta por SQL: sin familias con ese nombre.
beforeEach(() => prismaMock.$queryRaw.mockResolvedValue([]))

it('🔴 un producto enlazado a Shopify no se agrupa en este bloque (quién manda llega en el bloque 5)', async () => {
  prismaMock.product.findMany.mockResolvedValueOnce([{ ...base, shopifyVariantLink: { id: 'l1' } }])
  await expect(
    previewGroupExisting('v1', {
      name: 'Tenis',
      options: [{ name: 'Talla', values: ['26'] }],
      members: [{ productId: 'p1', values: ['26'] }],
    }),
  ).rejects.toThrow(/ligado a Shopify/)
})

it('el mismo producto sin enlace sí pasa a la vista previa', async () => {
  prismaMock.product.findMany.mockResolvedValueOnce([{ ...base, shopifyVariantLink: null }])
  prismaMock.menuCategory.findFirst.mockResolvedValueOnce({ id: 'c1' }) // la categoría heredada es del negocio
  await expect(
    previewGroupExisting('v1', {
      name: 'Tenis',
      options: [{ name: 'Talla', values: ['26'] }],
      members: [{ productId: 'p1', values: ['26'] }],
    }),
  ).resolves.toMatchObject({ members: [{ newName: 'Tenis · 26' }] })
})

it('un IVA que no existe responde 400', async () => {
  prismaMock.product.findMany.mockResolvedValueOnce([{ ...base, shopifyVariantLink: null }])
  await expect(
    previewGroupExisting('v1', {
      name: 'Tenis',
      ivaTratamiento: 'IVA_99',
      options: [{ name: 'Talla', values: ['26'] }],
      members: [{ productId: 'p1', values: ['26'] }],
    }),
  ).rejects.toMatchObject({ statusCode: 400 })
})

it('🔴 Codex #11: «a|b»+«c» y «a»+«b|c» son combinaciones distintas (el separador no las confunde)', async () => {
  prismaMock.product.findMany.mockResolvedValueOnce([
    { ...base, shopifyVariantLink: null },
    { ...base, id: 'p2', sku: 'TN-27', shopifyVariantLink: null },
  ])
  prismaMock.menuCategory.findFirst.mockResolvedValueOnce({ id: 'c1' })
  await expect(
    previewGroupExisting('v1', {
      name: 'Tenis',
      options: [
        { name: 'A', values: ['a|b', 'a'] },
        { name: 'B', values: ['c', 'b|c'] },
      ],
      members: [
        { productId: 'p1', values: ['a|b', 'c'] },
        { productId: 'p2', values: ['a', 'b|c'] },
      ],
    }),
  ).resolves.toMatchObject({ members: [{ newName: 'Tenis · a|b · c' }, { newName: 'Tenis · a · b|c' }] })
})

it('Codex #6: la vista previa trae las opciones normalizadas y la huella cambia si cambian (mismo valor «M»)', async () => {
  const vista = (options: Array<{ name: string; values: string[] }>) => {
    prismaMock.product.findMany.mockResolvedValueOnce([{ ...base, shopifyVariantLink: null }])
    prismaMock.menuCategory.findFirst.mockResolvedValueOnce({ id: 'c1' })
    return previewGroupExisting('v1', { name: 'Tenis', options, members: [{ productId: 'p1', values: ['M'] }] })
  }
  const talla = await vista([{ name: ' Talla ', values: [' M '] }])
  expect(talla.options).toEqual([{ name: 'Talla', values: ['M'] }])
  const color = await vista([{ name: 'Color', values: ['M', 'L'] }])
  expect(color.fingerprint).not.toBe(talla.fingerprint)
})

describe('propuestas del CSV de Shopify', () => {
  const producto = (id: string, sku: string) => ({
    id,
    sku,
    gtin: null,
    name: `Prenda ${sku}`,
    deletedAt: null,
    productGroupId: null,
    isDemo: false,
    shopifyVariantLink: null,
  })
  const csv = (...filas: string[]) =>
    ['Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Variant Barcode', ...filas].join('\n')

  it('🔴 Codex #11: «a|b»+«c» y «a»+«b|c» no chocan en el CSV', async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([producto('p1', 'S1'), producto('p2', 'S2')])
    const r = await proposalsFromShopifyCsv('v1', csv('h,Prenda,A,a|b,B,c,S1,', 'h,,,a,,b|c,S2,'))
    expect(r.proposals[0]).toMatchObject({ handle: 'h', conflicts: [], members: [{ productId: 'p1' }, { productId: 'p2' }] })
  })

  it('🔴 Codex #12: un handle con menos de dos miembros válidos se devuelve con sus conflictos y no encontrados', async () => {
    prismaMock.product.findMany.mockResolvedValueOnce([producto('p1', 'S1')])
    const r = await proposalsFromShopifyCsv('v1', csv('h,Prenda,Talla,M,,,S1,', 'h,,,L,,,S1,', 'h,,,XL,,,NOEXISTE,'))
    expect(r.proposals).toEqual([])
    expect(r.skippedHandles).toBe(1)
    expect(r.skipped).toEqual([{ handle: 'h', conflicts: [expect.stringContaining('aparece en 2 filas')], unmatched: ['NOEXISTE'] }])
  })
})
