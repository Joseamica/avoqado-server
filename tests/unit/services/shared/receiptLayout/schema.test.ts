import { blockSchema, layoutBlocksSchema, MAX_TEXT_LINES } from '@/services/shared/receiptLayout/schema'

describe('blockSchema', () => {
  it('rellena los defaults de cada bloque', () => {
    expect(blockSchema.parse({ type: 'logo' })).toEqual({ type: 'logo', size: 'M', align: 'center' })
    expect(blockSchema.parse({ type: 'totals' })).toEqual({
      type: 'totals',
      showSubtotal: true,
      showTax: true,
      showDiscount: true,
      showTip: true,
    })
    expect(blockSchema.parse({ type: 'reference' })).toEqual({ type: 'reference', showTransactionId: true, showAppVersion: false })
    expect(blockSchema.parse({ type: 'qr' })).toEqual({ type: 'qr', caption: 'Escanea para tu recibo y factura' })
  })

  it('🔴 rechaza un tipo desconocido con mensaje en español', () => {
    const r = blockSchema.safeParse({ type: 'hologram' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('Tipo de bloque desconocido')
  })

  it('un bloque de texto tiene tope de renglones y de caracteres', () => {
    const largo = blockSchema.safeParse({ type: 'text', lines: Array(MAX_TEXT_LINES + 1).fill('hola') })
    expect(largo.success).toBe(false)
    const ancho = blockSchema.safeParse({ type: 'text', lines: ['x'.repeat(49)] })
    expect(ancho.success).toBe(false)
    expect(blockSchema.parse({ type: 'text', lines: ['Gracias'] })).toEqual({
      type: 'text',
      lines: ['Gracias'],
      align: 'center',
      emphasis: 'normal',
    })
  })

  it('layoutBlocksSchema acota el número de bloques', () => {
    expect(layoutBlocksSchema.safeParse([]).success).toBe(false)
    expect(layoutBlocksSchema.safeParse(Array(41).fill({ type: 'separator' })).success).toBe(false)
  })
})
