/**
 * Los casos dorados (spec § 6): para cada caso y cada ancho, las líneas lógicas EXACTAS del
 * intérprete de referencia. Android, iOS y la PAX leen estos mismos archivos y comparan.
 * Regenerar A PROPÓSITO: UPDATE_GOLDEN=1 npx jest --selectProjects unit --testPathPattern receiptLayout/golden
 * — y después revisar cada ticket a ojo. Un golden que cambia sin que nadie lo mire no es un golden.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, resolve } from 'path'
import {
  effectiveLayout,
  interpret,
  layoutBlocksSchema,
  PAPER_WIDTHS,
  SAMPLE_SALES,
  TEMPLATES,
  type Block,
  type ReceiptInput,
  type ReceiptSale,
  type ReceiptVenueInfo,
  type TemplateId,
} from '@/services/shared/receiptLayout'

const ROOT = resolve(__dirname, '../../../../fixtures/receipt-layout')
const UPDATE = process.env.UPDATE_GOLDEN === '1'
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

interface CaseFile {
  layout: TemplateId | { raw: unknown } | { blocks: unknown[] }
  sale: string
  saleOverride?: Partial<ReceiptSale>
  venue: string
  venueOverride?: Partial<ReceiptVenueInfo>
}

function resolveLayout(layout: CaseFile['layout']): Block[] {
  if (typeof layout === 'string') return TEMPLATES[layout].blocks
  if ('raw' in layout) return effectiveLayout(layout.raw).blocks
  return layoutBlocksSchema.parse(layout.blocks)
}

const caseFiles = readdirSync(resolve(ROOT, 'cases'))
  .filter(f => f.endsWith('.json'))
  .sort()

describe('casos dorados — el intérprete de referencia', () => {
  it('hay al menos 25 casos', () => expect(caseFiles.length).toBeGreaterThanOrEqual(25))

  describe.each(caseFiles)('%s', file => {
    const c: CaseFile = read(resolve(ROOT, 'cases', file))
    const name = basename(file, '.json')
    const input: ReceiptInput = {
      sale: { ...read(resolve(ROOT, 'samples', `${c.sale}.json`)), ...(c.saleOverride ?? {}) },
      venue: { ...read(resolve(ROOT, 'venues', `${c.venue}.json`)), ...(c.venueOverride ?? {}) },
    }
    const blocks = resolveLayout(c.layout)

    it.each(PAPER_WIDTHS)('coincide con el golden a %i columnas', width => {
      const lines = interpret(blocks, input, width)
      for (const l of lines) if (l.kind === 'text') expect(l.double ? l.text.length * 2 : l.text.length).toBeLessThanOrEqual(width)
      const goldenPath = resolve(ROOT, 'golden', `${name}.${width}.json`)
      if (UPDATE) {
        mkdirSync(resolve(ROOT, 'golden'), { recursive: true })
        writeFileSync(goldenPath, `${JSON.stringify({ case: name, width, blocks, input, lines }, null, 2)}\n`)
      }
      expect(existsSync(goldenPath)).toBe(true)
      expect(lines).toEqual(read(goldenPath).lines)
    })
  })
})

describe('regla de cuadre del ticket (IVA por producto, plan 7: Codex r2 N10 y r3 R3-4)', () => {
  /** subtotal − descuento + cargo por servicio + IVA agregado + propina = TOTAL. Un IVA ≤ 0 no se suma (sale la leyenda). */
  const cuadra = (s: ReceiptSale) =>
    s.subtotalCents - (s.discountCents ?? 0) + (s.serviceChargeCents ?? 0) + Math.max(0, s.taxCents) + (s.tipCents ?? 0) === s.totalCents

  it.each(caseFiles)('%s cuadra', file => {
    const c: CaseFile = read(resolve(ROOT, 'cases', file))
    const sale: ReceiptSale = { ...read(resolve(ROOT, 'samples', `${c.sale}.json`)), ...(c.saleOverride ?? {}) }
    expect(cuadra(sale)).toBe(true)
  })

  it.each(Object.keys(SAMPLE_SALES) as (keyof typeof SAMPLE_SALES)[])(
    'la venta de muestra del diseñador «%s» cuadra y no trae IVA agregado',
    k => {
      expect(cuadra(SAMPLE_SALES[k])).toBe(true)
      expect(SAMPLE_SALES[k].taxCents).toBe(0)
    },
  )

  it('sólo los dos casos de una venta con IVA aparte imprimen «IVA agregado»', () => {
    const conIva = readdirSync(resolve(ROOT, 'golden')).filter(f =>
      readFileSync(resolve(ROOT, 'golden', f), 'utf8').includes('IVA agregado:'),
    )
    expect(conIva.sort()).toEqual([
      'iva-agregado-con-leyenda-apagada.32.json',
      'iva-agregado-con-leyenda-apagada.48.json',
      'reimpresion-con-iva-agregado-y-cargo.32.json',
      'reimpresion-con-iva-agregado-y-cargo.48.json',
    ])
  })
})
