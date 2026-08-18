import { UpsellOrigin, UpsellRuleStatus, UpsellTriggerType } from '@prisma/client'
import { prismaMock } from '../../__helpers__/setup'
import {
  proposeBasketRules,
  syncPromotionRules,
  buildRationale,
  MIN_SUPPORT,
  MIN_LIFT,
  nightlyUpsellRulesJob,
} from '../../../src/jobs/nightly-upsell-rules.job'
import * as basePlanService from '../../../src/services/access/basePlan.service'
import logger from '../../../src/config/logger'

// Make retry transparent for the run()-level tests below: just invoke the wrapped
// fn (deterministic, no backoff — same pattern as plan-renewal-reminder.test.ts).
// proposeBasketRules/syncPromotionRules never call retry directly, so this is
// inert for the rest of the file.
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: (fn: () => unknown) => fn(),
  shouldRetryDbConnectionError: jest.fn(),
}))

jest.mock('@/services/access/basePlan.service', () => ({
  __esModule: true,
  venuesWithFeatureAccess: jest.fn(),
}))

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

/** Producto sano de sobra: sin obligatorios, no se vende por peso. `canAutoPropose` lo deja pasar. */
function productoProponible(id: string, over: Partial<any> = {}) {
  return { id, upsellEnabled: true, soldByWeight: false, modifierGroups: [], ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.upsellRule.findUnique.mockResolvedValue(null)
  prismaMock.upsellRule.upsert.mockResolvedValue({} as any)
  prismaMock.upsellRule.updateMany.mockResolvedValue({ count: 0 } as any)
  // 🔴 Ronda final de correcciones (2026-08-17): `proposeBasketRules` ahora
  // hace un segundo `product.findMany` para `canAutoPropose` (soldByWeight +
  // obligatorios). Default sano para 'galleta', el `suggestedProductId` que
  // usa el helper `pair()` de abajo — los tests que necesitan un producto NO
  // proponible sobreescriben esto explícitamente.
  prismaMock.product.findMany.mockResolvedValue([productoProponible('galleta')] as any)
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

    const resultado = await proposeBasketRules(venueId, since)

    // Volver a proponer cada noche lo ya rechazado convierte la bandeja en ruido
    // y enseña al dueño a ignorarla.
    expect(resultado.written).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    // 🔴 Esto NO es "omitido" en el sentido que le interesa al dueño: es una
    // decisión que ÉL YA TOMÓ (rechazó la regla). No debe aparecer como discarded
    // —eso mezclaría "el dueño dijo no" con "el producto no se puede sugerir".
    expect(resultado.discarded).toEqual([])
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

// ═══════════════════════════════════════════════════════════════════════════
// Ronda final de correcciones (2026-08-17): el SQL de arriba ya filtra el veto
// y el catálogo, pero no sabe de obligatorios ni de venta por peso — eso lo
// checa `canAutoPropose` en JS, con el producto YA cargado. Sin esto el dueño
// veía la propuesta en su bandeja, daba "Activar", y el server la rechazaba.
// ═══════════════════════════════════════════════════════════════════════════

describe('Capa 2 — no propone lo que approveRule va a rechazar de todos modos', () => {
  it('🔴 NO propone un producto que se vende por peso', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([productoProponible('galleta', { soldByWeight: true })] as any)

    const resultado = await proposeBasketRules(venueId, since)

    expect(resultado.written).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    // 🔴 P2 (2026-08-17): lo omitido se cuenta y se explica — "apagado se VE y se
    // EXPLICA, nunca desaparece en silencio". El dueño lee "Galleta" y el motivo
    // real, no un número pelón.
    expect(resultado.discarded).toEqual([{ suggestedName: 'Galleta', reason: expect.stringMatching(/peso/) }])
  })

  it('🔴 NO propone un producto que pide una opción obligatoria (nadie elige "Chico o Grande" por el dueño)', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([
      productoProponible('galleta', {
        modifierGroups: [{ group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm', name: 'Chico', price: 0 }] } }],
      }),
    ] as any)

    const resultado = await proposeBasketRules(venueId, since)

    expect(resultado.written).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    expect(resultado.discarded).toEqual([{ suggestedName: 'Galleta', reason: expect.stringContaining('Tamaño') }])
  })

  it('sí propone un producto con SÓLO grupos opcionales', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([
      productoProponible('galleta', {
        modifierGroups: [{ group: { id: 'g_op', name: 'Extras', required: false, modifiers: [] } }],
      }),
    ] as any)

    const resultado = await proposeBasketRules(venueId, since)

    expect(resultado.written).toBe(1)
    expect(prismaMock.upsellRule.upsert).toHaveBeenCalled()
    expect(resultado.discarded).toEqual([])
  })

  it('un producto huérfano (no vino en el findMany) tampoco se propone — y también se explica', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([] as any)

    const resultado = await proposeBasketRules(venueId, since)

    expect(resultado.written).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    expect(resultado.discarded).toEqual([{ suggestedName: 'Galleta', reason: expect.stringContaining('catálogo') }])
  })
})

describe('Capa 4 — el espejo de los descuentos', () => {
  const now = new Date('2026-08-04T12:00:00Z')

  it('un descuento por producto produce una regla ACTIVE (el dueño ya decidió)', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd1', targetItemIds: ['galleta'], daysOfWeek: [1, 2], timeFrom: '10:00', timeUntil: '18:00' },
    ] as any)
    prismaMock.product.findMany.mockResolvedValue([productoProponible('galleta')] as any)

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

  // ─────────────────────────────────────────────────────────────────────────
  // Ronda final de correcciones (2026-08-17): esta capa es la MÁS delicada de
  // las tres — nace ACTIVE directo, sin pasar por `approveRule`. Sin este
  // filtro, un producto por peso o con un obligatorio sin resolver se
  // guardaría ACTIVE y el POS lo ignoraría para siempre, en silencio.
  // ─────────────────────────────────────────────────────────────────────────

  it('🔴 NO activa una regla para un producto que se vende por peso — y explica por qué', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd1', targetItemIds: ['jamon'], daysOfWeek: [], timeFrom: null, timeUntil: null },
    ] as any)
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'jamon', name: 'Jamón Serrano', upsellEnabled: true, soldByWeight: true, modifierGroups: [] },
    ] as any)

    const r = await syncPromotionRules(venueId, now)

    expect(r.activated).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    // 🔴 P2 (2026-08-17): esta capa nace ACTIVE directo, sin pasar por
    // approveRule — es la más delicada de las tres. Antes el rechazo era mudo.
    expect(r.discarded).toEqual([{ suggestedName: 'Jamón Serrano', reason: expect.stringMatching(/peso/) }])
  })

  it('🔴 NO activa una regla para un producto que pide una opción obligatoria sin resolver — y explica por qué', async () => {
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd1', targetItemIds: ['agua'], daysOfWeek: [], timeFrom: null, timeUntil: null },
    ] as any)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'agua',
        name: 'Agua Mineral',
        upsellEnabled: true,
        soldByWeight: false,
        modifierGroups: [{ group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm', name: 'Chico', price: 0 }] } }],
      },
    ] as any)

    const r = await syncPromotionRules(venueId, now)

    expect(r.activated).toBe(0)
    expect(prismaMock.upsellRule.upsert).not.toHaveBeenCalled()
    expect(r.discarded).toEqual([{ suggestedName: 'Agua Mineral', reason: expect.stringContaining('Tamaño') }])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P2 (2026-08-17): "apagado se VE y se EXPLICA, nunca desaparece en silencio"
// (regla del workspace). Antes de la ronda de correcciones de arriba, un
// producto rechazado por canAutoPropose igual generaba una regla ROTA pero
// VISIBLE — el dashboard la pintaba con badge rojo "Pide elegir opciones".
// Ahora no se escribe nada, así que run() tiene que dejar rastro POR VENUE,
// con nombre y motivo — no sólo un contador ciego.
// ═══════════════════════════════════════════════════════════════════════════

// 🔴 `winston`'s `LeveledLogMethod` es una función SOBRECARGADA cuya ÚLTIMA
// firma es `(infoObject: object): Logger` — un solo argumento. `Parameters<>`
// (y por tanto el tipo de `jest.spyOn(logger, 'info').mock.calls`) resuelve a
// ESA firma, una tupla de longitud 1, aunque en tiempo de ejecución el job
// SIEMPRE llama `logger.info(mensaje, meta)` con dos. Sin este cast, indexar
// `call[1]` no compila (`TS2493`) pese a ser válido en la práctica.
type LoggerInfoCall = [string, Record<string, unknown>?]

describe('run() — el rastro de lo omitido es por venue, con nombre y motivo', () => {
  const venue = { id: 'venue-1', name: 'Testarudo Cafe' }

  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([venue] as any)
    ;(basePlanService.venuesWithFeatureAccess as jest.Mock).mockResolvedValue(new Set([venue.id]))
  })

  it('🔴 cuando algo se omite, el log trae el NOMBRE del venue y el MOTIVO — no un número pelón', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([productoProponible('galleta', { soldByWeight: true })] as any)
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger as any)

    const result = await nightlyUpsellRulesJob.run()

    // Al resultado del job también llega el conteo — hoy sólo reportaba
    // activated/retired; esto es lo que "agrega las omitidas al resultado" pide.
    expect(result.discarded).toBe(1)

    // 🔴 Identificado por la METADATA estructurada (trae `omitidas`), no por un
    // substring del mensaje: el resumen final de la corrida también dice
    // "...omitidas" en texto plano y un match por substring lo confundiría con
    // el log por-venue que este test busca.
    const calls = infoSpy.mock.calls as unknown as LoggerInfoCall[]
    const perVenueCall = calls.find(call => call[1] && typeof call[1] === 'object' && 'omitidas' in call[1])
    expect(perVenueCall).toBeDefined()
    // El nombre, no el id pelón, es lo que el dueño reconoce al leer el log.
    expect(perVenueCall![0]).toContain(venue.name)

    const meta = perVenueCall![1] as unknown as {
      venueId: string
      venueName: string
      omitidas: Array<{ suggestedName: string; reason: string }>
    }
    expect(meta.venueName).toBe(venue.name)
    expect(meta.venueId).toBe(venue.id)
    expect(meta.omitidas).toEqual([{ suggestedName: 'Galleta', reason: expect.stringMatching(/peso/) }])

    infoSpy.mockRestore()
  })

  it('sin omisiones no hay log por venue ni ruido — la corrida normal se queda callada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([pair()])
    prismaMock.product.findMany.mockResolvedValue([productoProponible('galleta')] as any)
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger as any)

    const result = await nightlyUpsellRulesJob.run()

    expect(result.discarded).toBe(0)
    // El resumen final SIEMPRE loguea (con "0 omitidas"); lo que NO debe existir
    // es el log estructurado por-venue, que sólo se emite cuando hay algo que
    // explicar — si no, sería ruido en la corrida normal, todas las noches.
    const calls = infoSpy.mock.calls as unknown as LoggerInfoCall[]
    const perVenueCall = calls.find(call => call[1] && typeof call[1] === 'object' && 'omitidas' in call[1])
    expect(perVenueCall).toBeUndefined()

    infoSpy.mockRestore()
  })
})
