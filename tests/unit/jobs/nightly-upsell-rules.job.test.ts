import { UpsellOrigin, UpsellRuleStatus, UpsellTriggerType } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'
import { proposeBasketRules, syncPromotionRules, buildRationale, MIN_SUPPORT, MIN_LIFT } from '../../../src/jobs/nightly-upsell-rules.job'

/**
 * Upsell — job nocturno (capas 2 y 4).
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md (C13)
 *
 * 🔴 El fallo que más importa de este archivo NO truena nada. Si el job usara
 * CONFIANZA en vez de LIFT, propondría los tres productos más vendidos del local y
 * los presentaría como descubrimientos: el dueño los aprueba, no vende ni un peso
 * más, y concluye que la función no sirve. Todo verde, todo inútil.
 *
 * Por eso el SQL vive en el job y aquí se verifica su FORMA, no un resultado
 * inventado: que la métrica sea lift, que el veto del dueño esté en la consulta, y
 * que nada se prenda ni se resucite solo.
 */

const venueId = 'venue-1'
const since = new Date('2026-05-06T00:00:00Z')

function pair(over: Partial<any> = {}) {
  return {
    triggerProductId: 'cafe',
    suggestedProductId: 'galleta',
    triggerName: 'Café',
    suggestedName: 'Galleta',
    supportCount: 40,
    confidence: 0.4,
    lift: 2.5,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.upsellRule.findUnique.mockResolvedValue(null)
  prismaMock.upsellRule.upsert.mockResolvedValue({} as any)
  prismaMock.upsellRule.updateMany.mockResolvedValue({ count: 0 } as any)
})

describe('Capa 2 — la consulta agregada', () => {
  it('🔴 la métrica es LIFT, no confianza, y el umbral se aplica sobre ella', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await proposeBasketRules(venueId, since)

    // El template literal llega como array de fragmentos + los valores.
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as any).join(' ')
    const valores = (prismaMock.$queryRaw.mock.calls[0] as any[]).slice(1)

    // lift = confianza ÷ soporte del sugerido. Si alguien "simplifica" esto a
    // confianza sola, el job empieza a proponer lo más vendido como hallazgo.
    expect(sql).toMatch(/cb\.cnt::numeric \/ t\.n/)
    expect(sql).toContain('AS "lift"')
    expect(valores).toContain(MIN_LIFT)
    expect(valores).toContain(MIN_SUPPORT)
  })

  it('🔴 el veto del dueño va DENTRO del SQL', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await proposeBasketRules(venueId, since)
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as any).join(' ')

    // Filtrarlo después en JS produciría propuestas que nacen muertas.
    expect(sql).toMatch(/pb\."upsellEnabled" = true/)
    expect(sql).toMatch(/pb\.active = true/)
  })

  it('🔴 dos cafés en el MISMO ticket cuentan como un ticket, no dos', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await proposeBasketRules(venueId, since)
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as any).join(' ')

    // Sin el DISTINCT, un local que vende rondas infla su propio soporte y todo
    // par supera el umbral.
    expect(sql).toMatch(/SELECT DISTINCT oi\."orderId", oi\."productId"/)
  })

  it('sólo mira órdenes PAGADAS', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await proposeBasketRules(venueId, since)
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as any).join(' ')
    expect(sql).toMatch(/paymentStatus" = 'PAID'/)
  })

  it('🔴 nunca hace findMany sobre 90 días de OrderItem (ese patrón ya tumbó prod)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await proposeBasketRules(venueId, since)
    expect(prismaMock.orderItem.findMany).not.toHaveBeenCalled()
  })
})

describe('Capa 2 — qué se escribe', () => {
  it('las propuestas nacen PROPOSED, jamás ACTIVE', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    await proposeBasketRules(venueId, since)

    expect(prismaMock.upsellRule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: UpsellRuleStatus.PROPOSED,
          origin: UpsellOrigin.BASKET_DATA,
          triggerType: UpsellTriggerType.PRODUCT,
        }),
      }),
    )
  })

  it('🔴 NO resucita lo que el dueño descartó', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.upsellRule.findUnique.mockResolvedValue({ status: UpsellRuleStatus.DISMISSED } as any)

    const escritas = await proposeBasketRules(venueId, since)

    // Volver a proponer cada noche lo ya rechazado convierte la bandeja en ruido
    // y enseña al dueño a ignorarla.
    expect(escritas).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
  })

  it('🔴 una regla YA aprobada no se apaga porque bajó el lift', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair({ lift: 1.3 })])
    prismaMock.upsellRule.findUnique.mockResolvedValue({ status: UpsellRuleStatus.ACTIVE } as any)

    await proposeBasketRules(venueId, since)

    // El update refresca EVIDENCIA, nunca el estado.
    const call = prismaMock.upsellRule.upsert.mock.calls[0][0] as any
    expect(Object.keys(call.update).sort()).toEqual(['lift', 'rationale', 'supportCount'])
    expect(call.update).not.toHaveProperty('status')
  })

  it('la razón que lee el dueño trae números, no jerga', () => {
    const texto = buildRationale(pair() as any)
    expect(texto).toContain('Café')
    expect(texto).toContain('Galleta')
    expect(texto).toContain('2.5×')
    expect(texto).not.toMatch(/lift|confidence|support/i)
  })

  it('🔴 el conteo de cuentas NO se presenta como base del porcentaje', () => {
    // Primer intento decía "26% de 6 cuentas", que invita a leer 6 como el total
    // analizado. Es falso: 6 son las cuentas que llevaron LOS DOS productos.
    const texto = buildRationale(pair({ supportCount: 6, confidence: 0.26, lift: 5 }) as any)

    expect(texto).toMatch(/Pas[óo] en 6 cuentas/)
    expect(texto).not.toMatch(/% de \d+ cuentas/)
  })

  it('el singular no queda como "1 cuentas"', () => {
    expect(buildRationale(pair({ supportCount: 1 }) as any)).toContain('1 cuenta ')
  })
})

describe('Capa 4 — el espejo de los descuentos', () => {
  const now = new Date('2026-08-04T12:00:00Z')

  it('un descuento por producto produce una regla ACTIVE (el dueño ya decidió)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd1', targetItemIds: ['galleta'], daysOfWeek: [1, 2], timeFrom: '10:00', timeUntil: '18:00' },
    ] as any)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'galleta' }] as any)

    const r = await syncPromotionRules(venueId, now)

    expect(r.activated).toBe(1)
    expect(prismaMock.upsellRule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: UpsellRuleStatus.ACTIVE,
          origin: UpsellOrigin.PROMOTION,
          linkedDiscountId: 'd1',
          daysOfWeek: [1, 2],
          timeFrom: '10:00',
        }),
      }),
    )
  })

  it('🔴 se saltan COMP y 2x1: no se pueden pintar como un precio sin mentir', async () => {
    prismaMock.discount.findMany.mockResolvedValue([] as any)
    await syncPromotionRules(venueId, now)

    const where = (prismaMock.discount.findMany.mock.calls[0][0] as any).where
    expect(where.type).toEqual({ in: ['PERCENTAGE', 'FIXED_AMOUNT'] })
    expect(where.buyQuantity).toBeNull()
    expect(where.scope).toBe('ITEM')
    expect(where.active).toBe(true)
  })

  it('el veto del dueño también manda aquí', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd1', targetItemIds: ['sopa'], daysOfWeek: [], timeFrom: null, timeUntil: null },
    ] as any)
    prismaMock.product.findMany.mockResolvedValue([] as any) // sopa no está marcada

    const r = await syncPromotionRules(venueId, now)
    expect(r.activated).toBe(0)
  })

  it('🔴 al retirar SÓLO toca reglas PROMOTION', async () => {
    prismaMock.discount.findMany.mockResolvedValue([] as any)
    await syncPromotionRules(venueId, now)

    // Apagar el trabajo del dueño porque venció un descuento ajeno sería el bug
    // que nadie relaciona nunca con su causa.
    const where = (prismaMock.upsellRule.updateMany.mock.calls[0][0] as any).where
    expect(where.origin).toBe(UpsellOrigin.PROMOTION)
    expect(where.venueId).toBe(venueId)
  })

  it('un descuento vencido retira su regla', async () => {
    prismaMock.discount.findMany.mockResolvedValue([] as any)
    prismaMock.upsellRule.updateMany.mockResolvedValue({ count: 3 } as any)

    const r = await syncPromotionRules(venueId, now)
    expect(r.retired).toBe(3)
  })

  it('la ventana de fechas se evalúa contra AHORA, no se copia a la regla', async () => {
    prismaMock.discount.findMany.mockResolvedValue([] as any)
    await syncPromotionRules(venueId, now)

    const where = (prismaMock.discount.findMany.mock.calls[0][0] as any).where
    expect(where.OR).toEqual([{ validFrom: null }, { validFrom: { lte: now } }])
    expect(where.AND).toEqual([{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }])
  })
})
