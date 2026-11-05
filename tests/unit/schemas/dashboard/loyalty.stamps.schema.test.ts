import { UpdateLoyaltyConfigSchema, AdjustStampsSchema } from '@/schemas/dashboard/loyalty.schema'

/**
 * El zod del programa de sellos.
 *
 * Esto NO es ceremonia: `validateRequest` reemplaza el body por el resultado del
 * parseo, así que un campo que no esté declarado aquí se BORRA en silencio antes de
 * llegar al servicio — la pantalla mandaría "prende los sellos" y el servidor
 * respondería 200 sin haber prendido nada. Ya pasó en este repo con `migrateMerchant`.
 */
describe('UpdateLoyaltyConfigSchema — bono por visita (D7)', () => {
  const parse = (body: Record<string, unknown>) => UpdateLoyaltyConfigSchema.safeParse({ body, params: { venueId: 'v1' }, query: {} })

  it('deja pasar el bono: el panel lo manda al guardar', () => {
    const r = parse({ pointsPerVisit: 10, pointsPerDollar: 1 })
    expect(r.success && r.data.body).toEqual({ pointsPerVisit: 10, pointsPerDollar: 1 })
  })

  it('rechaza un bono negativo o con decimales', () => {
    expect(parse({ pointsPerVisit: -1 }).success).toBe(false)
    expect(parse({ pointsPerVisit: 1.5 }).success).toBe(false)
  })

  it('deja pasar lo demás que manda el panel: prender o apagar, el mínimo y la caducidad (o sin caducidad)', () => {
    const r = parse({ active: false, minPointsRedeem: 50, pointsExpireDays: null })
    expect(r.success && r.data.body).toEqual({ active: false, minPointsRedeem: 50, pointsExpireDays: null })
    expect(parse({ pointsExpireDays: 365 }).success).toBe(true)
  })

  it('rechaza, en español, un mínimo o una caducidad negativos o con decimales', () => {
    for (const malo of [{ minPointsRedeem: -1 }, { minPointsRedeem: 1.5 }, { pointsExpireDays: -5 }, { pointsExpireDays: 2.5 }]) {
      const r = parse(malo)
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).toMatch(/[áéíóúñ]|no puede|enteros/)
    }
  })
})

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

describe('AdjustStampsSchema — ajuste manual de sellos', () => {
  const cuid = 'cmabcdefghijklmnopqrstuvw'
  const body = {
    stampsEarned: 7,
    expectedStampCardId: cuid,
    expectedStampsEarned: 3,
    expectedVersion: 0,
    expectedStampsRequired: 10,
    reason: 'Migración de cartón',
  }
  const parse = (b: Record<string, unknown>) => AdjustStampsSchema.safeParse({ params: { venueId: cuid, customerId: cuid }, body: b })

  it('🔴 F1: sin expectedStampsRequired lo rechaza (la meta es parte de lo que se vio)', () => {
    const { expectedStampsRequired: _meta, ...sinMeta } = body
    expect(parse(sinMeta).success).toBe(false)
  })
  it('acepta el cuerpo válido, también sin cartilla (null)', () => {
    expect(parse(body).success).toBe(true)
    expect(parse({ ...body, expectedStampCardId: null }).success).toBe(true)
  })
  it.each([
    ['decimal', { stampsEarned: 7.5 }],
    ['negativo', { stampsEarned: -1 }],
    ['más de 100', { stampsEarned: 101 }],
    ['motivo de 4 caracteres', { reason: 'abcd' }],
    ['motivo sólo espacios', { reason: '      ' }],
    ['cartilla que no es cuid', { expectedStampCardId: 'abc' }],
    ['campo extra', { venueId: cuid }],
    ['meta 0', { expectedStampsRequired: 0 }],
  ])('rechaza %s', (_n, extra) => {
    expect(parse({ ...body, ...extra }).success).toBe(false)
  })
})
