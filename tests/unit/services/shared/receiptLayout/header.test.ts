import {
  renderAddress,
  renderBusinessName,
  renderFiscal,
  renderLogo,
  renderPhone,
  renderSeparator,
  renderText,
} from '@/services/shared/receiptLayout/blocks/header'
import { input } from './helpers'

const t = (text: string, align = 'center', bold = false, double = false) => ({ kind: 'text', text, align, bold, double })

describe('renderLogo', () => {
  it('con logo: imagen al 60 % (M) y un salto; sin logo: nada, ni hueco', () => {
    expect(renderLogo({ type: 'logo', size: 'M', align: 'center' }, input(), 48)).toEqual([
      { kind: 'image', ref: 'logo', widthPct: 60 },
      { kind: 'feed', lines: 1 },
    ])
    expect(renderLogo({ type: 'logo', size: 'L', align: 'center' }, input({}, { hasLogo: false }), 48)).toEqual([])
  })
})

describe('renderBusinessName — la regla de printTitle', () => {
  it('cabe a doble ancho (14 × 2 ≤ 48) → una sola línea double', () => {
    expect(renderBusinessName({ type: 'businessName', align: 'center', emphasis: 'double' }, input(), 48)).toEqual([
      t('Testarudo Cafe', 'center', false, true),
    ])
  })
  it('🔴 18 caracteres no caben a doble ancho en 32 → cae a negritas entero, no se parte', () => {
    const r = renderBusinessName(
      { type: 'businessName', align: 'center', emphasis: 'double' },
      input({}, { name: 'Estética Amaena SA' }),
      32,
    )
    expect(r).toEqual([t('Estética Amaena SA', 'center', true, false)])
  })
})

describe('renderFiscal — el emisor resuelto por venta', () => {
  it('imprime razón social, RFC y CP', () => {
    expect(renderFiscal({ type: 'fiscal', align: 'center' }, input(), 48)).toEqual([
      t('TESTARUDO CAFE S.A.P.I. DE C.V.'),
      t('RFC: TCA2501231A6'),
      t('Lugar de expedición: CP 06600'),
    ])
  })
  it('🔴 sin emisor ni legacy no imprime NADA (ni "RFC:" vacíos)', () => {
    expect(renderFiscal({ type: 'fiscal', align: 'center' }, input({}, { fiscalEmisors: [], principalEmisorId: null }), 48)).toEqual([])
  })
  it('legacy: sin lugar de expedición', () => {
    const i = input({}, { fiscalEmisors: [], principalEmisorId: null, legacy: { legalName: 'VIEJO SA', rfc: 'VIE900101AAA' } })
    expect(renderFiscal({ type: 'fiscal', align: 'center' }, i, 48)).toEqual([t('VIEJO SA'), t('RFC: VIE900101AAA')])
  })
})

describe('renderAddress y renderPhone', () => {
  it('compone dirección, ciudad, estado y CP, y la envuelve al ancho', () => {
    expect(renderAddress({ type: 'address', align: 'center' }, input(), 32)).toEqual([
      t('Nápoles 47, Cuauhtémoc, Ciudad'),
      t('de México CP 06600'),
    ])
    expect(
      renderAddress({ type: 'address', align: 'center' }, input({}, { address: null, city: null, state: null, zipCode: null }), 32),
    ).toEqual([])
  })
  it('teléfono con etiqueta; sin teléfono, nada', () => {
    expect(renderPhone({ type: 'phone', align: 'left' }, input(), 48)).toEqual([t('Tel: 55 1234 5678', 'left')])
    expect(renderPhone({ type: 'phone', align: 'left' }, input({}, { phone: null }), 48)).toEqual([])
  })
})

describe('renderText — texto libre', () => {
  it('envuelve cada renglón; en double envuelve a la mitad; vuelve a sanear', () => {
    const b = { type: 'text' as const, lines: ['Gracias por su compra vuelva pronto'], align: 'center' as const, emphasis: 'double' as const }
    expect(renderText(b, input(), 32)).toEqual([
      t('Gracias por su', 'center', false, true),
      t('compra vuelva', 'center', false, true),
      t('pronto', 'center', false, true),
    ])
    const sucio = { type: 'text' as const, lines: ['Hola mundo 🙏'], align: 'left' as const, emphasis: 'normal' as const }
    expect(renderText(sucio, input(), 48)).toEqual([t('Hola mundo ?', 'left')])
  })
})

describe('renderSeparator', () => {
  it('line, double y blank', () => {
    expect(renderSeparator({ type: 'separator', style: 'line' }, input(), 32)).toEqual([t('-'.repeat(32), 'left')])
    expect(renderSeparator({ type: 'separator', style: 'double' }, input(), 32)).toEqual([t('='.repeat(32), 'left')])
    expect(renderSeparator({ type: 'separator', style: 'blank' }, input(), 32)).toEqual([{ kind: 'feed', lines: 1 }])
  })
})
