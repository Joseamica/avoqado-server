import { renderItems, renderOrderInfo, renderStaff } from '@/services/shared/receiptLayout/blocks/body'
import { input } from './helpers'

const left = (text: string, bold = false) => ({ kind: 'text', text, align: 'left', bold, double: false })
const texts = (lines: unknown[]) => lines.map(l => (l as { text: string }).text)
const W = 32

describe('renderOrderInfo — folio y fecha de la VENTA', () => {
  it('folio, fecha en la zona del venue y tipo', () => {
    expect(texts(renderOrderInfo({ type: 'orderInfo', showOrderType: true }, input(), W))).toEqual([
      'Orden #:                      42',
      'Fecha:          02/09/2026 12:05',
      'Tipo:                  En tienda',
    ])
  })
  it('🔴 una reimpresión conserva la fecha de la venta y añade la de reimpresión', () => {
    const r = renderOrderInfo({ type: 'orderInfo', showOrderType: false }, input({ reprint: { printedAt: '2026-09-03T15:00:00.000Z' } }), W)
    expect(texts(r)).toEqual(['Orden #:                      42', 'Fecha:          02/09/2026 12:05', 'Reimpresión:    03/09/2026 09:00'])
  })
  it('una devolución lleva título y etiqueta propios', () => {
    const r = renderOrderInfo({ type: 'orderInfo', showOrderType: false }, input({ kind: 'REFUND', orderNumber: 'D-7' }), W)
    expect(r[0]).toEqual({ kind: 'text', text: 'DEVOLUCIÓN', align: 'center', bold: true, double: false })
    expect(texts(r)[1]).toBe('Devolución #:                D-7')
  })
})

describe('renderStaff', () => {
  it('con nombre; sin nombre, nada', () => {
    expect(renderStaff({ type: 'staff' }, input(), W)).toEqual([left('Atendió:                     Ana')])
    expect(renderStaff({ type: 'staff' }, input({ staffName: null }), W)).toEqual([])
  })
})

describe('renderItems', () => {
  it('encabezado en negritas, divisor y renglones como el ticket de hoy', () => {
    const r = renderItems(
      { type: 'items', showModifiers: true, showNotes: true },
      input({
        items: [
          { name: 'Galleta', quantity: 2, unitPriceCents: 4500, totalPriceCents: 9000, modifiers: ['Sin azúcar'], note: 'Para llevar' },
          { name: 'Café de cortesía', quantity: 1, unitPriceCents: 0, totalPriceCents: 0, isCortesia: true },
        ],
      }),
      W,
    )
    expect(r).toEqual([
      left('Cant Artículo             Precio', true),
      left('-'.repeat(32)),
      left('2    Galleta              $90.00'),
      left('  + Sin azúcar'),
      left('  Nota: Para llevar'),
      left('1    Café de cortesía   CORTESÍA'),
    ])
  })
  it('combos: el encabezado en negritas con su precio; el componente indentado y SIN precio', () => {
    const r = renderItems(
      { type: 'items', showModifiers: false, showNotes: false },
      input({
        items: [
          { name: 'Combo desayuno', quantity: 1, unitPriceCents: 12000, totalPriceCents: 12000, isComboHeader: true },
          { name: 'Café', quantity: 1, unitPriceCents: 0, totalPriceCents: 0, isComboComponent: true },
        ],
      }),
      W,
    )
    expect(r[2]).toEqual(left('1    Combo desayuno      $120.00', true))
    expect(r[3]).toEqual(left('       1x Café                  '))
  })
  it('peso y origen por área salen bajo el nombre; modificadores y notas se apagan con sus interruptores', () => {
    const r = renderItems(
      { type: 'items', showModifiers: false, showNotes: false },
      input({
        items: [
          {
            name: 'Queso',
            quantity: 1,
            unitPriceCents: 18270,
            totalPriceCents: 18270,
            weightSummary: '0.435 kg × $420.00/kg',
            areaSourceLabel: 'Cremería · Vale 9016719357',
            modifiers: ['x'],
            note: 'y',
          },
        ],
      }),
      W,
    )
    expect(texts(r.slice(2))).toEqual(['1    Queso               $182.70', '  0.435 kg × $420.00/kg', '  Cremería · Vale 9016719357'])
  })

  it('P1 ningún renglón de artículos se pasa del ancho, ni con nombres, modificadores y notas largos', () => {
    const r = renderItems(
      { type: 'items', showModifiers: true, showNotes: true },
      input({
        items: [
          {
            name: 'Chilaquiles verdes con pollo deshebrado y crema',
            quantity: 1,
            unitPriceCents: 16500,
            totalPriceCents: 16500,
            modifiers: ['Leche de almendra orgánica sin azúcar añadida'],
            note: 'Sin cebolla y la salsa aparte por favor, alergia',
          },
        ],
      }),
      W,
    )
    for (const l of texts(r)) expect(l.length).toBeLessThanOrEqual(W)
    expect(texts(r).join(' ')).toContain('deshebrado')
  })
})
