import { clasificarOrden, hayBloqueados, impuestosSatDe, resolverTratamiento } from '@/services/fiscal/ivaDeRenglon'

describe('resolverTratamiento', () => {
  it('el sello manda sobre el producto', () => {
    expect(resolverTratamiento({ selladoIva: 'IVA_16', productoIva: 'IVA_0', tieneProducto: true })).toBe('IVA_16')
  })
  it('sin sello, el tratamiento ACTUAL del producto', () => {
    expect(resolverTratamiento({ selladoIva: null, productoIva: 'EXENTO', tieneProducto: true })).toBe('EXENTO')
  })
  it('sin producto (importe libre) ⇒ IVA_16', () => {
    expect(resolverTratamiento({ selladoIva: null, productoIva: null, tieneProducto: false })).toBe('IVA_16')
  })
  it('producto sin tratamiento (fila vieja antes del backfill) ⇒ IVA_16', () => {
    expect(resolverTratamiento({ selladoIva: undefined, productoIva: null, tieneProducto: true })).toBe('IVA_16')
  })
})

describe('impuestosSatDe', () => {
  it('IVA_16 ⇒ 02 + Tasa 0.16', () => {
    expect(impuestosSatDe('IVA_16')).toEqual({
      objetoImp: '02',
      rate: 0.16,
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
    })
  })
  it('IVA_8 ⇒ 02 + Tasa 0.08', () => {
    expect(impuestosSatDe('IVA_8')).toEqual({
      objetoImp: '02',
      rate: 0.08,
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.08, withholding: false }],
    })
  })
  it('IVA_0 ⇒ 02 + Tasa 0 (traslado con importe 0, NO exento)', () => {
    expect(impuestosSatDe('IVA_0')).toEqual({
      objetoImp: '02',
      rate: 0,
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0, withholding: false }],
    })
  })
  it('EXENTO ⇒ 02 + factor Exento', () => {
    expect(impuestosSatDe('EXENTO')).toEqual({
      objetoImp: '02',
      rate: 0,
      taxes: [{ type: 'IVA', factor: 'Exento', rate: 0, withholding: false }],
    })
  })
  it('NO_OBJETO ⇒ 01 sin traslados', () => {
    expect(impuestosSatDe('NO_OBJETO')).toEqual({
      objetoImp: '01',
      rate: 0,
      taxes: [],
    })
  })
  it.each(['BLOQUEADO_03', 'BLOQUEADO_04'] as const)('%s ⇒ bloqueado con motivo en español', t => {
    const r = impuestosSatDe(t)
    expect(r).toMatchObject({ bloqueado: true })
    expect((r as { motivo: string }).motivo).toMatch(/objeto de impuesto/)
  })
})

describe('clasificarOrden / hayBloqueados', () => {
  it('todo 16 (o sin renglones) ⇒ TODO_16', () => {
    expect(clasificarOrden(['IVA_16', 'IVA_16'])).toBe('TODO_16')
    expect(clasificarOrden([])).toBe('TODO_16')
  })
  it('cualquier renglón distinto ⇒ MIXTA', () => {
    expect(clasificarOrden(['IVA_16', 'IVA_0'])).toBe('MIXTA')
    expect(clasificarOrden(['EXENTO'])).toBe('MIXTA')
  })
  it('detecta bloqueados', () => {
    expect(hayBloqueados(['IVA_16', 'BLOQUEADO_04'])).toBe(true)
    expect(hayBloqueados(['IVA_16', 'IVA_0'])).toBe(false)
  })
})
