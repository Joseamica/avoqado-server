import { combinarContratos, contratoDePagoManual } from '@/services/fiscal/contratoDePrecio'

describe('combinarContratos (fusión de cuentas)', () => {
  it.each([
    ['IVA_INCLUIDO', 'IVA_INCLUIDO', 'IVA_INCLUIDO'],
    ['IVA_APARTE', 'IVA_APARTE', 'IVA_APARTE'],
    ['DESCONOCIDO', 'DESCONOCIDO', 'DESCONOCIDO'],
    ['IVA_INCLUIDO', 'IVA_APARTE', 'DESCONOCIDO'],
    ['IVA_APARTE', 'IVA_INCLUIDO', 'DESCONOCIDO'],
    ['IVA_INCLUIDO', 'DESCONOCIDO', 'DESCONOCIDO'],
    ['DESCONOCIDO', 'IVA_INCLUIDO', 'DESCONOCIDO'],
  ] as const)('%s + %s ⇒ %s', (a, b, esperado) => {
    expect(combinarContratos(a, b)).toBe(esperado)
  })
})

describe('contratoDePagoManual (dashboard, cobro sin orden)', () => {
  it('un IVA tecleado mayor a cero ⇒ IVA_APARTE', () => {
    expect(contratoDePagoManual('16.00')).toBe('IVA_APARTE')
    expect(contratoDePagoManual(0.01)).toBe('IVA_APARTE')
  })
  it('sin IVA tecleado, cero o basura ⇒ DESCONOCIDO (no se adivina «incluido»)', () => {
    for (const v of [undefined, null, 0, '0', '0.00', '', 'abc', -5]) {
      expect(contratoDePagoManual(v)).toBe('DESCONOCIDO')
    }
  })
})
