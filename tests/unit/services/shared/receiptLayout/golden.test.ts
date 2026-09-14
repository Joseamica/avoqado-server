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
