import type { Block } from '@/services/shared/receiptLayout/schema'
import { MANDATORY_BLOCK_TYPES, validateLayout } from '@/services/shared/receiptLayout/validateLayout'

const obligatorios = (): Block[] => [
  { type: 'fiscal', align: 'center' },
  { type: 'orderInfo', showOrderType: true },
  { type: 'items', showModifiers: true, showNotes: true },
  { type: 'totals', showSubtotal: true, showTax: true, showDiscount: true, showTip: true },
  { type: 'payment', showChange: true, showCardLastFour: true },
  { type: 'areaDelivery' },
  { type: 'signature' },
]

describe('validateLayout', () => {
  it('el conjunto de obligatorios es exactamente el del spec y está cerrado', () => {
    expect([...MANDATORY_BLOCK_TYPES]).toEqual(['fiscal', 'orderInfo', 'items', 'totals', 'payment', 'areaDelivery', 'signature'])
  })

  it('un layout con los siete obligatorios, en cualquier orden, es íntegro', () => {
    const blocks = obligatorios()
    const [fiscal, ...resto] = blocks
    const signature = resto.pop()!
    // fiscal al final del cuerpo (antes de la firma): mover un obligatorio es válido
    expect(validateLayout([...resto, fiscal, signature])).toEqual([])
  })

  it('🔴 falta un obligatorio → RECEIPT_LAYOUT_MISSING_BLOCK con el tipo', () => {
    const sin = obligatorios().filter(b => b.type !== 'fiscal')
    expect(validateLayout(sin)).toEqual([expect.objectContaining({ code: 'RECEIPT_LAYOUT_MISSING_BLOCK', blockType: 'fiscal' })])
  })

  it('🔴 un obligatorio repetido → RECEIPT_LAYOUT_DUPLICATE_BLOCK', () => {
    const dup = [{ type: 'items', showModifiers: true, showNotes: true } as Block, ...obligatorios()]
    expect(validateLayout(dup)).toEqual([expect.objectContaining({ code: 'RECEIPT_LAYOUT_DUPLICATE_BLOCK', blockType: 'items' })])
  })

  it('🔴 la firma que no es el último bloque → RECEIPT_LAYOUT_SIGNATURE_NOT_LAST', () => {
    const blocks = obligatorios()
    const signature = blocks.pop()!
    expect(validateLayout([signature, ...blocks])).toEqual([expect.objectContaining({ code: 'RECEIPT_LAYOUT_SIGNATURE_NOT_LAST' })])
  })

  it('topes por tipo: 9 textos o 11 separadores se rechazan; 8 y 10 pasan', () => {
    const texto = (i: number): Block => ({ type: 'text', lines: [`t${i}`], align: 'center', emphasis: 'normal' })
    const sep = (): Block => ({ type: 'separator', style: 'line' })
    expect(validateLayout([...Array.from({ length: 8 }, (_, i) => texto(i)), ...obligatorios()])).toEqual([])
    expect(validateLayout([...Array.from({ length: 9 }, (_, i) => texto(i)), ...obligatorios()])).toEqual([
      expect.objectContaining({ code: 'RECEIPT_LAYOUT_TOO_MANY_BLOCKS', blockType: 'text' }),
    ])
    expect(validateLayout([...Array.from({ length: 11 }, sep), ...obligatorios()])).toEqual([
      expect.objectContaining({ code: 'RECEIPT_LAYOUT_TOO_MANY_BLOCKS', blockType: 'separator' }),
    ])
  })

  it('🔴 un texto con ESC adentro → RECEIPT_LAYOUT_TEXT_FORBIDDEN_CHARS con el índice del bloque', () => {
    const malo: Block = { type: 'text', lines: ['hola\u001Bm'], align: 'center', emphasis: 'normal' }
    expect(validateLayout([malo, ...obligatorios()])).toEqual([
      expect.objectContaining({ code: 'RECEIPT_LAYOUT_TEXT_FORBIDDEN_CHARS', index: 0 }),
    ])
  })
})
