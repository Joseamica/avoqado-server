import {
  CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
  esRechazoPorTopeEnVales,
  rechazarSiAlgunoTieneTope,
  textoDescuentoConTopeEnLaCaja,
  textoDescuentoConTopeEnElVale,
} from '@/services/shared/descuentoConTopeEnVales'

/**
 * D11 (pizarrón hz:e82938e1:D11, 18-nov; founder: «no puede haber un hueco»): en una venta con vales no se usa un descuento con tope de
 * usos (total o por clienta). `buildOrderItemsData` lo revisa con la MISMA lectura que calcula la rebaja (Codex D11 r4 #1), antes de
 * `validateDiscountActive` y de escribir nada: así el contador de usos no tiene nada que contar por los vales.
 */
describe('rechazarSiAlgunoTieneTope (D11)', () => {
  it('🔴 un descuento con tope total en el VALE ⇒ 400 con el texto del área', () => {
    expect(() => rechazarSiAlgunoTieneTope([{ name: 'Primeros 100', maxTotalUses: 100, maxUsesPerCustomer: null }], 'VALE')).toThrow(
      expect.objectContaining({ statusCode: 400, code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES, message: textoDescuentoConTopeEnElVale('Primeros 100') }),
    )
  })

  it('🔴 un descuento con tope por clienta en la CAJA ⇒ 400 con el texto de la caja; con varios, el primero por nombre', () => {
    expect(() =>
      rechazarSiAlgunoTieneTope(
        [
          { name: 'Sin tope', maxTotalUses: null, maxUsesPerCustomer: null },
          { name: 'Z promo', maxTotalUses: 5 },
          { name: '1 por clienta', maxTotalUses: null, maxUsesPerCustomer: 1 },
        ],
        'CAJA',
      ),
    ).toThrow(expect.objectContaining({ code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES, message: textoDescuentoConTopeEnLaCaja('1 por clienta') }))
  })

  it('sin tope (o sin descuentos) ⇒ pasa', () => {
    expect(() => rechazarSiAlgunoTieneTope([{ name: 'Sin tope', maxTotalUses: null, maxUsesPerCustomer: null }], 'VALE')).not.toThrow()
    expect(() => rechazarSiAlgunoTieneTope([], 'CAJA')).not.toThrow()
  })

  it('esRechazoPorTopeEnVales reconoce sólo el 400 de D11', () => {
    let error: unknown
    try {
      rechazarSiAlgunoTieneTope([{ name: 'X', maxTotalUses: 1 }], 'VALE')
    } catch (e) {
      error = e
    }
    expect(esRechazoPorTopeEnVales(error)).toBe(true)
    expect(esRechazoPorTopeEnVales(new Error('otro'))).toBe(false)
    expect(esRechazoPorTopeEnVales(null)).toBe(false)
  })

  it('los textos dan una salida que el aparato tiene (Codex r3 #5)', () => {
    expect(textoDescuentoConTopeEnElVale('X')).toBe('El descuento «X» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.')
    expect(textoDescuentoConTopeEnLaCaja('X')).toBe(
      'El descuento «X» tiene tope de usos y no se puede usar en una venta con vales: quítalo de ese producto para cobrar.',
    )
  })
})
