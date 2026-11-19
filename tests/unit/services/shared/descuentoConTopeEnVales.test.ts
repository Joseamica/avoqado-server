import {
  CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
  rechazarDescuentosConTopeEnVales,
  textoDescuentoConTopeEnLaCaja,
  textoDescuentoConTopeEnElVale,
} from '@/services/shared/descuentoConTopeEnVales'
import { prismaMock } from '../../../__helpers__/setup'

/**
 * D11 (pizarrón hz:e82938e1:D11, 18-nov; founder: «no puede haber un hueco»): en una venta con vales no se usa un descuento con tope de
 * usos (total o por clienta). El SERVIDOR lo rechaza ANTES de cualquier otra validación del descuento y antes de escribir nada, con su
 * propia lectura del catálogo: así el contador de usos no tiene nada que contar por los vales.
 */
describe('rechazarDescuentosConTopeEnVales (D11)', () => {
  it('🔴 un descuento con tope (total o por clienta) en el VALE ⇒ 400 con el texto del área', async () => {
    prismaMock.discount.findMany.mockResolvedValue([{ name: 'Primeros 100', maxTotalUses: 100, maxUsesPerCustomer: null }])

    await expect(rechazarDescuentosConTopeEnVales('venue-1', ['d-1', null, 'd-1'], 'VALE')).rejects.toMatchObject({
      statusCode: 400,
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
      message: textoDescuentoConTopeEnElVale('Primeros 100'),
    })
    // Una sola lectura, del negocio, de los descuentos de la petición y sólo los que tienen tope (cualquiera de los dos).
    expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId: 'venue-1',
          id: { in: ['d-1'] },
          OR: [{ maxTotalUses: { not: null } }, { maxUsesPerCustomer: { not: null } }],
        },
      }),
    )
  })

  it('🔴 en la CAJA (un suelto de la venta de vales) ⇒ 400 con el texto de la caja', async () => {
    prismaMock.discount.findMany.mockResolvedValue([{ name: '1 por clienta', maxTotalUses: null, maxUsesPerCustomer: 1 }])
    await expect(rechazarDescuentosConTopeEnVales('venue-1', ['d-2'], 'CAJA')).rejects.toMatchObject({
      code: CODIGO_DESCUENTO_CON_TOPE_EN_VALES,
      message: textoDescuentoConTopeEnLaCaja('1 por clienta'),
    })
  })

  it('sin descuentos con tope ⇒ pasa; sin descuentos ⇒ ni siquiera consulta', async () => {
    prismaMock.discount.findMany.mockResolvedValue([])
    await expect(rechazarDescuentosConTopeEnVales('venue-1', ['d-3'], 'VALE')).resolves.toBeUndefined()
    prismaMock.discount.findMany.mockClear()
    await expect(rechazarDescuentosConTopeEnVales('venue-1', [undefined, null], 'CAJA')).resolves.toBeUndefined()
    expect(prismaMock.discount.findMany).not.toHaveBeenCalled()
  })

  it('los textos dan una salida que el aparato tiene (Codex r3 #5)', () => {
    expect(textoDescuentoConTopeEnElVale('X')).toBe('El descuento «X» tiene tope de usos y no se puede poner en un vale: emite el vale sin ese descuento.')
    expect(textoDescuentoConTopeEnLaCaja('X')).toBe(
      'El descuento «X» tiene tope de usos y no se puede usar en una venta con vales: quítalo de ese producto para cobrar.',
    )
  })
})
