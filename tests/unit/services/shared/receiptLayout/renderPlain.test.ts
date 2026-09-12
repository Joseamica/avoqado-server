import { renderPlain } from '@/services/shared/receiptLayout/renderPlain'
import type { PaperWidth } from '@/services/shared/receiptLayout/types'

describe('renderPlain — el ticket en texto para mirarlo', () => {
  it('centra, alinea, marca imágenes y códigos, y escribe las líneas grandes en mayúsculas a su ancho lógico', () => {
    const out = renderPlain(
      [
        { kind: 'image', ref: 'logo', widthPct: 60 },
        { kind: 'text', text: 'Cafe', align: 'center', bold: false, double: true },
        { kind: 'text', text: 'Orden #:  42', align: 'left', bold: false, double: false },
        { kind: 'feed', lines: 2 },
        { kind: 'qr', data: 'https://x' },
        { kind: 'text', text: 'fin', align: 'right', bold: false, double: false },
        { kind: 'cut' },
      ],
      // 16 columnas a propósito: el papel real es 48/32, pero un ancho chico deja la expectativa legible.
      16 as unknown as PaperWidth,
    )
    expect(out.split('\n')).toEqual([
      '     [LOGO]',
      '  CAFE',
      'Orden #:  42',
      '',
      '',
      // '[QR https://x]' son 14 columnas en un papel de 16 ⇒ (16-14)/2 = 1 espacio.
      // El plan escribió 2; es un desliz aritmético suyo, no del centrado.
      ' [QR https://x]',
      '             fin',
      '---------------- corte',
    ])
  })
})
