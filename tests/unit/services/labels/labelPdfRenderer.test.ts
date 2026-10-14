import { renderLabelsPdf, type LabelConfig } from '../../../../src/services/labels/labelPdfRenderer'

const countPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length

const cfg = (labelType: string): LabelConfig => ({
  labelType,
  barcodeFormat: 'SKU',
  details: { sku: true, gtin: false, variantName: false, price: true, itemName: true, unitAbbr: false },
})

const items = (n: number, labelQuantity = 1) =>
  Array.from({ length: n }, (_, i) => ({ name: `VESTIDO ${i}`, sku: `IQ-VESTIDO-${i}`, price: '100', labelQuantity }))

describe('renderLabelsPdf — paginación', () => {
  // Zebra/DYMO = 1 etiqueta por página. Con cantidad 1 por artículo, la etiqueta 2 en
  // adelante se dibujaba fuera de la hoja en vez de en una página nueva.
  it('una etiqueta por página en Zebra con cantidad 1 por artículo', async () => {
    const { pdfBuffer, totalLabels } = await renderLabelsPdf(items(3), cfg('zebra-1.2x0.85'))
    expect(totalLabels).toBe(3)
    expect(countPages(pdfBuffer)).toBe(3)
  })

  it('una etiqueta por página en Zebra con cantidad 2', async () => {
    const { pdfBuffer } = await renderLabelsPdf(items(2, 2), cfg('zebra-1.2x0.85'))
    expect(countPages(pdfBuffer)).toBe(4)
  })

  it('Avery 5160 (30 por hoja): 31 etiquetas = 2 hojas, sin hoja vacía al final', async () => {
    expect(countPages((await renderLabelsPdf(items(31), cfg('avery-5160'))).pdfBuffer)).toBe(2)
    expect(countPages((await renderLabelsPdf(items(30), cfg('avery-5160'))).pdfBuffer)).toBe(1)
  })
})
