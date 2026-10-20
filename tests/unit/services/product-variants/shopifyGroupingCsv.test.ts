import { prismaMock } from '@tests/__helpers__/setup'
import { groupShopifyRowsByHandle, proposalsFromShopifyCsv } from '@/services/product-variants/groupExisting.service'

const csv = [
  'Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Variant Barcodes',
  "body-harbor,BODY HARBOR,Talla,34,Color,Negro,IQ-BH-34-N,'8435732763015",
  'body-harbor,,,36,,Negro,IQ-BH-36-N,',
  'gorra,Gorra,Title,Default Title,,,IQ-GORRA,',
].join('\n')

describe('groupShopifyRowsByHandle', () => {
  it('agrupa por Handle, toma los nombres de opción de la primera fila y limpia el apóstrofo del código', () => {
    const g = groupShopifyRowsByHandle(csv)
    expect(g).toEqual([
      {
        handle: 'body-harbor',
        parentName: 'BODY HARBOR',
        optionNames: ['Talla', 'Color'],
        rows: [
          { sku: 'IQ-BH-34-N', barcode: '8435732763015', values: ['34', 'Negro'] },
          { sku: 'IQ-BH-36-N', barcode: null, values: ['36', 'Negro'] },
        ],
      },
    ])
  })
  it('un producto sin variantes («Default Title») no se propone', () => {
    expect(groupShopifyRowsByHandle(csv).some(x => x.handle === 'gorra')).toBe(false)
  })
})

describe('proposalsFromShopifyCsv', () => {
  it('🔴 un archivo de más de 900 KB se rechaza antes de tocar la base (el cuerpo JSON del servidor topa en 1 MB)', async () => {
    await expect(proposalsFromShopifyCsv('v1', 'x'.repeat(900 * 1024 + 1))).rejects.toMatchObject({
      statusCode: 400,
      message: 'El archivo pasa de 900 KB; divídelo en partes.',
    })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })
})
