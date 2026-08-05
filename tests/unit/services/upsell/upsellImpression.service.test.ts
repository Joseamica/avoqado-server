/**
 * Unit tests de la parte de DINERO del upsell: impresiones y conversión.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md (C4, C5, C15)
 *
 * Lo que protegen, y por qué duele si se rompe:
 *  1. Un POS alterado NO puede atribuirse reglas de otro venue (fuga entre inquilinos
 *     y métrica envenenada).
 *  2. Reenviar el mismo momento NO duplica filas — el POS reintenta cuando hay red mala.
 *  3. Convertir a una orden de OTRO venue responde 404, nunca marca nada.
 *  4. Convertir dos veces a la MISMA orden es no-op; a una DISTINTA es 409. Sin esto,
 *     un momento se podría atribuir a dos ventas.
 *  5. El PATCH funciona aunque el POST nunca haya llegado (carrera real: el POST es
 *     fuego-y-olvido y el pago puede cerrar antes, o desde otro dispositivo).
 */

import { prismaMock } from '@tests/__helpers__/setup'
import { UpsellSurface } from '@prisma/client'
import { recordImpression, convertImpression, UpsellConversionError } from '../../../../src/services/upsell/upsellImpression.service'

const VENUE = 'venue-mio'
const OTRO_VENUE = 'venue-ajeno'

describe('Upsell — registrar un momento', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // El servicio corre sus escrituras en una transacción; el mock la ejecuta
    // pasando el mismo cliente.
    ;(prismaMock as any).$transaction = jest.fn(async (fn: any) => fn(prismaMock))
  })

  it('🔴 descarta ruleIds que NO son de este venue', async () => {
    // Sólo una de las dos reglas pertenece al venue.
    prismaMock.upsellRule.findMany.mockResolvedValue([{ id: 'regla-mia' }] as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-1' } as any)
    prismaMock.upsellAcceptance.deleteMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.upsellAcceptance.createMany.mockResolvedValue({ count: 0 } as any)

    await recordImpression({
      impressionId: 'imp-1',
      venueId: VENUE,
      shownRuleIds: ['regla-mia', 'regla-de-otro'],
      accepted: [{ ruleId: 'regla-de-otro', productId: 'p1', orderItemExternalId: 'upsell:imp-1:0' }],
      reportedAmount: 999999,
      cartSubtotalBefore: 100,
      surface: UpsellSurface.CUSTOMER_DISPLAY,
      context: 'counter',
    })

    const guardado = prismaMock.upsellImpression.upsert.mock.calls[0][0] as any
    expect(guardado.create.shownRuleIds).toEqual(['regla-mia'])

    // La aceptación era de una regla ajena: no se escribe ninguna.
    expect(prismaMock.upsellAcceptance.createMany).not.toHaveBeenCalled()
  })

  it('es idempotente: usa upsert con el id que mandó el cliente', async () => {
    prismaMock.upsellRule.findMany.mockResolvedValue([{ id: 'r1' }] as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-fijo' } as any)
    prismaMock.upsellAcceptance.deleteMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.upsellAcceptance.createMany.mockResolvedValue({ count: 1 } as any)

    await recordImpression({
      impressionId: 'imp-fijo',
      venueId: VENUE,
      shownRuleIds: ['r1'],
      accepted: [{ ruleId: 'r1', productId: 'p1', orderItemExternalId: 'upsell:imp-fijo:0' }],
      reportedAmount: 35,
      cartSubtotalBefore: 150,
      surface: UpsellSurface.CUSTOMER_DISPLAY,
      context: 'counter',
    })

    const call = prismaMock.upsellImpression.upsert.mock.calls[0][0] as any
    expect(call.where).toEqual({ id: 'imp-fijo' })
    expect(call.create.id).toBe('imp-fijo')
  })

  it('un reenvío reescribe las aceptaciones completas, no las acumula', async () => {
    prismaMock.upsellRule.findMany.mockResolvedValue([{ id: 'r1' }] as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-1' } as any)
    prismaMock.upsellAcceptance.deleteMany.mockResolvedValue({ count: 2 } as any)
    prismaMock.upsellAcceptance.createMany.mockResolvedValue({ count: 1 } as any)

    await recordImpression({
      impressionId: 'imp-1',
      venueId: VENUE,
      shownRuleIds: ['r1'],
      accepted: [{ ruleId: 'r1', productId: 'p1', orderItemExternalId: 'upsell:imp-1:0' }],
      reportedAmount: 35,
      cartSubtotalBefore: 150,
      surface: UpsellSurface.CASHIER,
      context: 'tableOrdering',
    })

    // Primero borra lo viejo del MISMO momento, luego escribe lo nuevo.
    expect(prismaMock.upsellAcceptance.deleteMany).toHaveBeenCalledWith({ where: { impressionId: 'imp-1' } })
    expect(prismaMock.upsellAcceptance.createMany).toHaveBeenCalled()
  })

  it('el grupo de control se registra como momento, sin aceptaciones', async () => {
    prismaMock.upsellRule.findMany.mockResolvedValue([] as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-holdout' } as any)
    prismaMock.upsellAcceptance.deleteMany.mockResolvedValue({ count: 0 } as any)

    await recordImpression({
      impressionId: 'imp-holdout',
      venueId: VENUE,
      shownRuleIds: [],
      accepted: [],
      reportedAmount: 0,
      cartSubtotalBefore: 150,
      surface: UpsellSurface.HOLDOUT,
      context: 'counter',
    })

    const call = prismaMock.upsellImpression.upsert.mock.calls[0][0] as any
    expect(call.create.surface).toBe(UpsellSurface.HOLDOUT)
    expect(prismaMock.upsellAcceptance.createMany).not.toHaveBeenCalled()
  })
})

describe('Upsell — conversión (el momento terminó en venta pagada)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 una orden de OTRO venue responde 404 y no marca nada', async () => {
    prismaMock.order.findFirst.mockResolvedValue(null as any)

    await expect(convertImpression(VENUE, 'imp-1', 'orden-ajena')).rejects.toMatchObject({
      code: 'ORDER_NOT_IN_VENUE',
      httpStatus: 404,
    })
    expect(prismaMock.upsellImpression.upsert).not.toHaveBeenCalled()
  })

  it('🔴 convertir a una orden DISTINTA de la ya registrada responde 409', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-nueva' } as any)
    prismaMock.upsellImpression.findUnique.mockResolvedValue({
      id: 'imp-1',
      venueId: VENUE,
      orderId: 'orden-vieja',
    } as any)

    await expect(convertImpression(VENUE, 'imp-1', 'orden-nueva')).rejects.toMatchObject({
      code: 'ALREADY_CONVERTED_TO_OTHER_ORDER',
      httpStatus: 409,
    })
    expect(prismaMock.upsellImpression.upsert).not.toHaveBeenCalled()
  })

  it('convertir dos veces a la MISMA orden es no-op idempotente', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1' } as any)
    prismaMock.upsellImpression.findUnique.mockResolvedValue({
      id: 'imp-1',
      venueId: VENUE,
      orderId: 'orden-1',
    } as any)

    await convertImpression(VENUE, 'imp-1', 'orden-1')

    expect(prismaMock.upsellImpression.upsert).not.toHaveBeenCalled()
  })

  it('🔴 funciona aunque el POST nunca haya llegado (la carrera real)', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1' } as any)
    // La impresión NO existe todavía: el pago cerró antes de que llegara el POST,
    // o el cobro se hizo desde otro dispositivo en mesa.
    prismaMock.upsellImpression.findUnique.mockResolvedValue(null as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-1' } as any)

    await convertImpression(VENUE, 'imp-1', 'orden-1')

    // Upsert, no update: si exigiéramos que existiera, se perdería la conversión.
    const call = prismaMock.upsellImpression.upsert.mock.calls[0][0] as any
    expect(call.create.id).toBe('imp-1')
    expect(call.create.orderId).toBe('orden-1')
    expect(call.create.venueId).toBe(VENUE)
  })

  it('el venueId sale del token, no del cuerpo: la orden se busca acotada al venue', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1' } as any)
    prismaMock.upsellImpression.findUnique.mockResolvedValue(null as any)
    prismaMock.upsellImpression.upsert.mockResolvedValue({ id: 'imp-1' } as any)

    await convertImpression(VENUE, 'imp-1', 'orden-1')

    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'orden-1', venueId: VENUE } }))
    expect(VENUE).not.toBe(OTRO_VENUE)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// El número de la portada: "aumento real del ticket"
// ═══════════════════════════════════════════════════════════════════════════

import { getPerformance } from '../../../../src/services/upsell/upsellImpression.service'

/**
 * 🔴 Éste es el test que faltaba, y su ausencia dejó pasar el peor bug de la función.
 *
 * `measuredLift` = ticket promedio de quienes VIERON tarjetas − ticket promedio del
 * grupo de control. Los promedios salen de `Order.total` vía `orderId`, así que una
 * impresión sin convertir NO aporta al promedio (SQL: AVG salta los NULL).
 *
 * El bug: el POS nunca convertía las impresiones del grupo de control (no tenían nada
 * aceptado que reportar). Su promedio quedaba en 0 y la resta devolvía el ticket
 * ENTERO del otro grupo disfrazado de aumento. Medido contra la base real: una orden
 * de $647.40 producía "measuredLift: 647.4".
 *
 * No truena nada. Sólo miente, con un número perfectamente creíble.
 */
describe('Upsell — desempeño: el aumento sólo se reporta si AMBOS lados tienen ventas', () => {
  const row = (surface: string, over: Partial<Record<string, unknown>> = {}) => ({
    surface,
    impressions: BigInt(10),
    converted: BigInt(10),
    accepted: BigInt(3),
    attributed: null,
    avg_ticket: surface === 'SHOWN' ? 500 : 450,
    ...over,
  })

  it('🔴 sin ventas convertidas en el grupo de control, el aumento es null (NO el ticket entero)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([
      row('SHOWN'),
      // El control registró momentos pero ninguno dijo en qué venta terminó.
      row('HOLDOUT', { converted: BigInt(0), avg_ticket: null }),
    ])

    const r = await getPerformance('venue-1', new Date(), new Date())

    expect(r.measuredLift).toBeNull()
    // Los demás números SÍ se siguen reportando: lo único que se calla es la
    // comparación que no se puede hacer.
    expect(r.shownCount).toBe(10)
    expect(r.holdoutCount).toBe(10)
  })

  it('🔴 tampoco al revés: sin ventas convertidas en el grupo mostrado', async () => {
    prismaMock.$queryRaw.mockResolvedValue([row('SHOWN', { converted: BigInt(0), avg_ticket: null }), row('HOLDOUT')])

    expect((await getPerformance('venue-1', new Date(), new Date())).measuredLift).toBeNull()
  })

  it('con ventas en ambos lados sí se reporta, y es la DIFERENCIA', async () => {
    prismaMock.$queryRaw.mockResolvedValue([row('SHOWN'), row('HOLDOUT')])

    const r = await getPerformance('venue-1', new Date(), new Date())

    // 500 − 450 = 50. No 500.
    expect(r.measuredLift).toBeCloseTo(50)
  })

  it('un rango sin nada no truena ni divide entre cero', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])

    const r = await getPerformance('venue-1', new Date(), new Date())

    expect(r.hasData).toBe(false)
    expect(r.measuredLift).toBeNull()
    expect(r.acceptanceRate).toBe(0)
    expect(Number.isNaN(r.acceptanceRate)).toBe(false)
  })

  it('la consulta cuenta convertidas por `orderId`, no por aceptaciones', async () => {
    prismaMock.$queryRaw.mockResolvedValue([])
    await getPerformance('venue-1', new Date(), new Date())

    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as any).join(' ')
    // Si alguien cambia esto a contar aceptaciones, el grupo de control —que por
    // definición no acepta nada— volvería a quedar en cero y el bug renace.
    expect(sql).toMatch(/FILTER \(WHERE imp\."orderId" IS NOT NULL\)/)
  })
})
