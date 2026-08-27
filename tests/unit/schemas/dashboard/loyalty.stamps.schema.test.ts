import { UpdateLoyaltyConfigSchema } from '@/schemas/dashboard/loyalty.schema'

/**
 * El zod del programa de sellos.
 *
 * Esto NO es ceremonia: `validateRequest` reemplaza el body por el resultado del
 * parseo, así que un campo que no esté declarado aquí se BORRA en silencio antes de
 * llegar al servicio — la pantalla mandaría "prende los sellos" y el servidor
 * respondería 200 sin haber prendido nada. Ya pasó en este repo con `migrateMerchant`.
 */
describe('UpdateLoyaltyConfigSchema — campos de sellos', () => {
  const parse = (body: Record<string, unknown>) => UpdateLoyaltyConfigSchema.safeParse({ body, params: { venueId: 'v1' }, query: {} })

  it('deja pasar los siete campos del programa de sellos', () => {
    const r = parse({
      stampsEnabled: true,
      stampsRequired: 8,
      maxStampsPerDay: 2,
      stampRewardType: 'PERCENTAGE',
      stampRewardValue: 15,
      stampRewardProductId: 'prod-1',
      stampRewardLabel: '15% en tu próxima visita',
    })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.body).toEqual(
      expect.objectContaining({
        stampsEnabled: true,
        stampsRequired: 8,
        maxStampsPerDay: 2,
        stampRewardType: 'PERCENTAGE',
        stampRewardValue: 15,
        stampRewardProductId: 'prod-1',
        stampRewardLabel: '15% en tu próxima visita',
      }),
    )
  })

  it('rechaza un tipo de premio inventado', () => {
    expect(parse({ stampRewardType: 'CAFE_GRATIS_LOS_MARTES' }).success).toBe(false)
  })

  it('rechaza medio sello', () => {
    expect(parse({ stampsRequired: 7.5 }).success).toBe(false)
  })

  it('rechaza un porcentaje imposible', () => {
    expect(parse({ stampRewardValue: -5 }).success).toBe(false)
  })

  it('acepta quitar el producto del premio mandando null', () => {
    expect(parse({ stampRewardProductId: null }).success).toBe(true)
  })
})
