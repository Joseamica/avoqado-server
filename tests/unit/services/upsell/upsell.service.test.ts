/**
 * Unit tests del motor de upsell — la lógica PURA y los candados de negocio.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * Lo que estos tests protegen, en orden de cuánto duele si se rompe:
 *  1. Dos reglas OWNER del mismo producto con disparadores distintos COEXISTEN
 *     (un @@unique mal puesto las colapsaría — spec dedupeKey).
 *  2. El veto del dueño (`upsellEnabled=false`) gana sobre TODO, incluida la IA.
 *  3. El sorteo del grupo de control es DETERMINISTA y auditable, no aleatorio.
 *  4. Las tres perillas tienen default seguro cuando la columna está en NULL.
 */

import { UpsellOrigin, UpsellRuleStatus, UpsellTriggerType } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import logger from '../../../../src/config/logger'
import {
  computeDedupeKey,
  parseUpsellSurfaces,
  createRule,
  updateRule,
  listRules,
  listActiveRulesForPos,
} from '../../../../src/services/upsell/upsell.service'
import { isHoldout, HOLDOUT_PERCENT } from '../../../../src/services/upsell/upsellImpression.service'

describe('Upsell — dedupeKey (identidad de una regla)', () => {
  const base = {
    origin: UpsellOrigin.OWNER,
    triggerType: UpsellTriggerType.PRODUCT,
    suggestedProductId: 'galleta',
  }

  // ── EL caso que motivó el diseño ──────────────────────────────────────────
  it('🔴 "café → galleta" y "té → galleta" son reglas DISTINTAS', () => {
    const cafe = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })
    const te = computeDedupeKey({ ...base, triggerProductIds: ['te'] })

    expect(cafe).not.toEqual(te)
  })

  it('el mismo conjunto de disparadores en distinto orden da la MISMA llave', () => {
    const a = computeDedupeKey({ ...base, triggerProductIds: ['cafe', 'te'] })
    const b = computeDedupeKey({ ...base, triggerProductIds: ['te', 'cafe'] })

    expect(a).toEqual(b)
  })

  it('el origen separa las capas: el job no puede pisar una regla del dueño', () => {
    const owner = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })
    const data = computeDedupeKey({ ...base, origin: UpsellOrigin.BASKET_DATA, triggerProductIds: ['cafe'] })

    expect(owner).not.toEqual(data)
  })

  it('en PROMOTION el id del descuento entra en la llave (dos promos del mismo producto)', () => {
    const promoA = computeDedupeKey({
      origin: UpsellOrigin.PROMOTION,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      linkedDiscountId: 'desc-a',
    })
    const promoB = computeDedupeKey({
      origin: UpsellOrigin.PROMOTION,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      linkedDiscountId: 'desc-b',
    })

    expect(promoA).not.toEqual(promoB)
    // Y la llave CONSERVA el id aunque el FK quede en NULL por el onDelete: SetNull,
    // que es lo que permite al job saber qué regla murió con qué descuento.
    expect(promoA).toContain('desc-a')
  })

  it('en OWNER el descuento NO entra en la llave (sólo PROMOTION lo lleva)', () => {
    const conDescuento = computeDedupeKey({ ...base, triggerProductIds: ['cafe'], linkedDiscountId: 'desc-a' })
    const sinDescuento = computeDedupeKey({ ...base, triggerProductIds: ['cafe'] })

    expect(conDescuento).toEqual(sinDescuento)
  })

  it('ALWAYS ignora los disparadores: no hay nada que dispare', () => {
    const a = computeDedupeKey({
      origin: UpsellOrigin.OWNER,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
      triggerProductIds: ['cafe'],
    })
    const b = computeDedupeKey({
      origin: UpsellOrigin.OWNER,
      triggerType: UpsellTriggerType.ALWAYS,
      suggestedProductId: 'galleta',
    })

    expect(a).toEqual(b)
  })
})

describe('Upsell — las tres perillas', () => {
  it('columna en NULL = las tres prendidas (default de la función)', () => {
    expect(parseUpsellSurfaces(null)).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
  })

  it('respeta lo que el dueño apagó', () => {
    expect(parseUpsellSurfaces({ counter: true, tableOrdering: false, tablePaying: false })).toEqual({
      counter: true,
      tableOrdering: false,
      tablePaying: false,
    })
  })

  it('un JSON a medias completa con los defaults en vez de tronar', () => {
    expect(parseUpsellSurfaces({ counter: false })).toEqual({
      counter: false,
      tableOrdering: true,
      tablePaying: true,
    })
  })

  it('basura en la columna no tumba el cobro', () => {
    expect(parseUpsellSurfaces('no soy json')).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
    expect(parseUpsellSurfaces(undefined)).toEqual({ counter: true, tableOrdering: true, tablePaying: true })
  })
})

describe('Upsell — grupo de control (holdout)', () => {
  it('🔴 es DETERMINISTA: el mismo id siempre cae del mismo lado', () => {
    const id = 'a3f1c8e2-0000-4444-8888-abcdefabcdef'
    const primera = isHoldout(id)

    for (let i = 0; i < 50; i++) {
      expect(isHoldout(id)).toBe(primera)
    }
  })

  it('reparte cerca del porcentaje pedido sobre una muestra grande', () => {
    let holdouts = 0
    const N = 20_000
    for (let i = 0; i < N; i++) {
      if (isHoldout(`impression-${i}`)) holdouts++
    }

    const pct = (holdouts / N) * 100
    // Margen amplio: lo que importa es que no sea 0% (nadie en control, métrica
    // imposible) ni 100% (nadie ve tarjetas, función apagada de facto).
    expect(pct).toBeGreaterThan(HOLDOUT_PERCENT - 3)
    expect(pct).toBeLessThan(HOLDOUT_PERCENT + 3)
  })

  it('con 0% nadie queda en control, con 100% todos', () => {
    expect(isHoldout('cualquier-id', 0)).toBe(false)
    expect(isHoldout('cualquier-id', 100)).toBe(true)
  })

  it('ids distintos no caen todos del mismo lado', () => {
    const resultados = new Set(Array.from({ length: 200 }, (_, i) => isHoldout(`id-${i}`)))
    expect(resultados.size).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Opciones obligatorias (spec 2026-08-16, B3) — Tarea 3
//
// 🔴 Nota de implementación respecto al brief: `assertSameVenue` (usada por
// `createRule`) valida el producto sugerido Y los triggerProductIds en UNA
// sola consulta por lote — siempre fue `prisma.product.findMany`, nunca
// `findFirst` (así ya estaba ANTES de esta tarea). Los tests de `createRule`
// de abajo mockean `product.findMany` devolviendo un arreglo, no `findFirst`
// con un objeto suelto — con `findFirst` sin mockear, `found.map(...)` explota
// sobre `undefined` y el reject nunca llega al mensaje "Tamaño" que se afirma.
// `listActiveRulesForPos` sí usa `findMany` tal cual el brief lo escribió, así
// que esos dos tests son un calco literal.
// ═══════════════════════════════════════════════════════════════════════════

describe('createRule — opciones obligatorias (spec B3)', () => {
  it('rechaza guardar una regla cuyo producto pide opciones y no las trae', async () => {
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'prod_agua',
        soldByWeight: false,
        upsellEnabled: true,
        modifierGroups: [
          { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_ch', name: 'Chico', price: 0, active: true }] } },
        ],
      },
    ])

    await expect(
      createRule({ venueId: 'v1', triggerType: UpsellTriggerType.ALWAYS, suggestedProductId: 'prod_agua' }, 'staff_1'),
    ).rejects.toThrow(/Tamaño/)

    // 🔴 Lo importante: NO se guardó. El bug original era justo que sí se guardaba.
    expect(prisma.upsellRule.create).not.toHaveBeenCalled()
  })

  it('guarda la selección cuando está completa', async () => {
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'prod_agua',
        soldByWeight: false,
        upsellEnabled: true,
        modifierGroups: [
          { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
        ],
      },
    ])
    ;(prisma.upsellRule.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'r1', ...data }))

    await createRule(
      {
        venueId: 'v1',
        triggerType: UpsellTriggerType.ALWAYS,
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
      },
      'staff_1',
    )

    expect(prisma.upsellRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] }),
      }),
    )
  })

  it('un producto sin obligatorios sigue guardándose sin selección (no rompe lo de hoy)', async () => {
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      { id: 'prod_coca', soldByWeight: false, upsellEnabled: true, modifierGroups: [] },
    ])
    ;(prisma.upsellRule.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'r2', ...data }))

    await createRule({ venueId: 'v1', triggerType: UpsellTriggerType.ALWAYS, suggestedProductId: 'prod_coca' }, 'staff_1')

    expect(prisma.upsellRule.create).toHaveBeenCalled()
  })
})

describe('updateRule — revalida si cambia el producto o la selección (spec B3)', () => {
  // 🔴 El caso que motiva la regla: editar una regla para cambiarle el
  // producto (o su selección) sin revalidar la dejaría inválida en silencio —
  // el bug por la puerta de atrás que el resto de esta tarea existe para evitar.

  it('cambiar sólo la selección revalida contra el producto actual: rechaza si falta un obligatorio', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      suggestedProductId: 'prod_agua',
      suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [
        { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_ch', name: 'Chico', price: 0, active: true }] } },
      ],
    })

    await expect(updateRule('v1', 'r1', { suggestedModifiers: [] }, 'staff_1')).rejects.toThrow(/Tamaño/)
    expect(prisma.upsellRule.update).not.toHaveBeenCalled()
  })

  it('cambiar el producto revalida contra el NUEVO, no el viejo', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      suggestedProductId: 'prod_coca',
      // Válida para coca (sin obligatorios) — pero eso ya no importa: al cambiar
      // de producto se revalida contra AGUA, que sí tiene un grupo obligatorio.
      suggestedModifiers: [],
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [
        { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
      ],
    })

    await expect(updateRule('v1', 'r1', { suggestedProductId: 'prod_agua' }, 'staff_1')).rejects.toThrow(/Tamaño/)
    expect(prisma.upsellRule.update).not.toHaveBeenCalled()
    // Y contra el producto correcto: prod_agua, no el que ya tenía la regla.
    expect(prisma.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'prod_agua', venueId: 'v1' } }))
  })

  it('sin tocar producto ni selección, NO revalida ni consulta el catálogo (headline-only sigue funcionando)', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      suggestedProductId: 'prod_agua',
      suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
    })
    ;(prisma.upsellRule.update as jest.Mock).mockResolvedValue({ id: 'r1', headline: 'nuevo texto' })

    await updateRule('v1', 'r1', { headline: 'nuevo texto' }, 'staff_1')

    expect(prisma.product.findFirst).not.toHaveBeenCalled()
    expect(prisma.upsellRule.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ headline: 'nuevo texto' }) }),
    )
  })

  it('selección nueva válida: revalida, resuelve y persiste la selección (ids, no lo resuelto)', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      suggestedProductId: 'prod_agua',
      suggestedModifiers: null,
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [
        {
          group: {
            id: 'g_tam',
            name: 'Tamaño',
            required: true,
            modifiers: [
              { id: 'm_ch', name: 'Chico', price: 0, active: true },
              { id: 'm_gr', name: 'Grande', price: 15, active: true },
            ],
          },
        },
      ],
    })
    ;(prisma.upsellRule.update as jest.Mock).mockResolvedValue({ id: 'r1' })

    await updateRule('v1', 'r1', { suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] }, 'staff_1')

    expect(prisma.upsellRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] }),
      }),
    )
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Ronda 1 de correcciones (2026-08-16): dedupeKey y selección huérfana.
  // Ambos bugs estaban latentes porque el zod de la ruta ni dejaba llegar
  // `suggestedProductId` a `updateRule` — con ese hueco cerrado, se vuelven
  // reales en el mismo commit.
  // ─────────────────────────────────────────────────────────────────────────

  it('🟠 cambiar el producto recalcula el dedupeKey (si no, la regla miente sobre su propia identidad)', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      origin: 'OWNER',
      triggerType: 'ALWAYS',
      triggerProductIds: [],
      triggerCategoryIds: [],
      suggestedProductId: 'prod_coca',
      suggestedModifiers: [],
      linkedDiscountId: null,
      dedupeKey: 'OWNER:ALWAYS::prod_coca',
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [],
    })
    ;(prisma.upsellRule.findUnique as jest.Mock).mockResolvedValue(null) // sin colisión
    ;(prisma.upsellRule.update as jest.Mock).mockResolvedValue({ id: 'r1' })

    await updateRule('v1', 'r1', { suggestedProductId: 'prod_agua' }, 'staff_1')

    expect(prisma.upsellRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedProductId: 'prod_agua', dedupeKey: 'OWNER:ALWAYS::prod_agua' }),
      }),
    )
  })

  it('🟠 cambiar el producto a uno que ya tiene una regla con el mismo disparador rechaza como duplicado', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      origin: 'OWNER',
      triggerType: 'ALWAYS',
      triggerProductIds: [],
      triggerCategoryIds: [],
      suggestedProductId: 'prod_coca',
      suggestedModifiers: [],
      linkedDiscountId: null,
      dedupeKey: 'OWNER:ALWAYS::prod_coca',
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [],
    })
    // OTRA regla ya ocupa la identidad "OWNER:ALWAYS::prod_agua".
    ;(prisma.upsellRule.findUnique as jest.Mock).mockResolvedValue({ id: 'r_otra' })

    await expect(updateRule('v1', 'r1', { suggestedProductId: 'prod_agua' }, 'staff_1')).rejects.toThrow(/Ya existe una regla/)
    expect(prisma.upsellRule.update).not.toHaveBeenCalled()
  })

  it('🟠 cambiar el producto SIN traer una selección nueva limpia la selección vieja (huérfana)', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      origin: 'OWNER',
      triggerType: 'ALWAYS',
      triggerProductIds: [],
      triggerCategoryIds: [],
      suggestedProductId: 'prod_agua',
      // Selección vigente para AGUA ("Tamaño") — apuntaría a un grupo AJENO si se
      // queda así tras cambiar el producto sugerido.
      suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
      linkedDiscountId: null,
      dedupeKey: 'OWNER:ALWAYS::prod_agua',
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      // Leche no tiene obligatorios: la validación pasa SIN mirar la selección vieja.
      id: 'prod_leche',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [],
    })
    ;(prisma.upsellRule.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.upsellRule.update as jest.Mock).mockResolvedValue({ id: 'r1' })

    await updateRule('v1', 'r1', { suggestedProductId: 'prod_leche' }, 'staff_1')

    expect(prisma.upsellRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ suggestedProductId: 'prod_leche', suggestedModifiers: [] }),
      }),
    )
  })

  it('cambiar el producto CON una selección nueva usa esa selección — no la limpia', async () => {
    ;(prisma.upsellRule.findFirst as jest.Mock).mockResolvedValue({
      id: 'r1',
      origin: 'OWNER',
      triggerType: 'ALWAYS',
      triggerProductIds: [],
      triggerCategoryIds: [],
      suggestedProductId: 'prod_coca',
      suggestedModifiers: [],
      linkedDiscountId: null,
      dedupeKey: 'OWNER:ALWAYS::prod_coca',
    })
    ;(prisma.product.findFirst as jest.Mock).mockResolvedValue({
      id: 'prod_agua',
      soldByWeight: false,
      upsellEnabled: true,
      modifierGroups: [
        { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
      ],
    })
    ;(prisma.upsellRule.findUnique as jest.Mock).mockResolvedValue(null)
    ;(prisma.upsellRule.update as jest.Mock).mockResolvedValue({ id: 'r1' })

    await updateRule(
      'v1',
      'r1',
      { suggestedProductId: 'prod_agua', suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] },
      'staff_1',
    )

    expect(prisma.upsellRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          suggestedProductId: 'prod_agua',
          suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
          dedupeKey: 'OWNER:ALWAYS::prod_agua',
        }),
      }),
    )
  })
})

describe('listActiveRulesForPos — el POS recibe la selección RESUELTA', () => {
  it('devuelve nombre y precio de cada modificador, no sólo ids', async () => {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'r1',
        triggerType: 'ALWAYS',
        triggerProductIds: [],
        triggerCategoryIds: [],
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
        headline: '¿Le agregamos un agua bien fría?',
        priority: 0,
        lift: null,
        daysOfWeek: [],
        timeFrom: null,
        timeUntil: null,
      },
    ])
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'prod_agua',
        soldByWeight: false,
        upsellEnabled: true,
        modifierGroups: [
          { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
        ],
      },
    ])

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].suggestedModifiers).toEqual([{ groupId: 'g_tam', modifierId: 'm_gr', name: 'Grande', price: 15 }])
  })

  it('una regla sin selección devuelve array VACÍO, nunca null (el POS no debe checar nulos)', async () => {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'r2',
        triggerType: 'ALWAYS',
        triggerProductIds: [],
        triggerCategoryIds: [],
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        headline: null,
        priority: 0,
        lift: null,
        daysOfWeek: [],
        timeFrom: null,
        timeUntil: null,
      },
    ])
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      { id: 'prod_coca', soldByWeight: false, upsellEnabled: true, modifierGroups: [] },
    ])

    const dtos = await listActiveRulesForPos('v1')
    expect(dtos[0].suggestedModifiers).toEqual([])
  })

  it('🔴 una regla inválida por un cambio de catálogo no tumba a las demás: sólo ELLA vuelve con []', async () => {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'r_ok',
        triggerType: 'ALWAYS',
        triggerProductIds: [],
        triggerCategoryIds: [],
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
        headline: null,
        priority: 0,
        lift: null,
        daysOfWeek: [],
        timeFrom: null,
        timeUntil: null,
      },
      {
        id: 'r_stale',
        triggerType: 'ALWAYS',
        triggerProductIds: [],
        triggerCategoryIds: [],
        suggestedProductId: 'prod_leche',
        // Válida cuando se guardó; el catálogo le agregó un obligatorio después.
        suggestedModifiers: [],
        headline: null,
        priority: 0,
        lift: null,
        daysOfWeek: [],
        timeFrom: null,
        timeUntil: null,
      },
    ])
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'prod_agua',
        soldByWeight: false,
        upsellEnabled: true,
        modifierGroups: [
          { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
        ],
      },
      {
        id: 'prod_leche',
        soldByWeight: false,
        upsellEnabled: true,
        modifierGroups: [
          { group: { id: 'g_tipo', name: 'Tipo', required: true, modifiers: [{ id: 'm_ent', name: 'Entera', price: 0, active: true }] } },
        ],
      },
    ])

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos).toHaveLength(2)
    expect(dtos.find(d => d.id === 'r_ok')!.suggestedModifiers).toEqual([
      { groupId: 'g_tam', modifierId: 'm_gr', name: 'Grande', price: 15 },
    ])
    expect(dtos.find(d => d.id === 'r_stale')!.suggestedModifiers).toEqual([])
    // 🟡 Degradar en silencio es indebuggeable en un local: el fail-open queda,
    // pero deja línea con qué regla y qué venue.
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ruleId: 'r_stale', venueId: 'v1' }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Ronda 1 de correcciones (2026-08-16): el select de `listRules` sólo traía
// `upsellEnabled` en `suggestedProduct` — el badge del dashboard (`suggestabilityOf`,
// avoqado-web-dashboard) sólo podía detectar el veto y mentía por omisión sobre
// las otras 4 razones (desactivado, sin existencias, por peso, pide opciones).
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 EL descuento ligado. El defecto que estos tests impiden (medido 2026-08-17):
// este `select` NO traía `linkedDiscount`, así que el descuento que el job
// nocturno le ata a la regla —nacido de una promoción REAL del local— nunca
// llegaba al POS. La tarjeta pintaba precio de lista y la promoción del negocio
// no se aplicaba jamás por la vía del upsell.
//
// Y el filtro de abajo importa igual de fuerte por la razón contraria: mandar un
// descuento que el endpoint de órdenes va a rechazar tumba la VENTA ENTERA con
// 400. Lo que no se puede aplicar sin riesgo se sirve como null, y la tarjeta
// queda a precio de lista — que es lo de hoy y no rompe nada.
// ═══════════════════════════════════════════════════════════════════════════

describe('listActiveRulesForPos — el descuento ligado', () => {
  function reglaCon(linkedDiscount: any, suggestedProductId = 'prod_agua') {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'r1',
        triggerType: 'ALWAYS',
        triggerProductIds: [],
        triggerCategoryIds: [],
        suggestedProductId,
        suggestedModifiers: null,
        headline: null,
        priority: 0,
        lift: null,
        daysOfWeek: [],
        timeFrom: null,
        timeUntil: null,
        linkedDiscount,
      },
    ])
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      { id: suggestedProductId, soldByWeight: false, upsellEnabled: true, modifierGroups: [] },
    ])
  }

  const descuentoSano = {
    id: 'd1',
    type: 'PERCENTAGE',
    value: 20,
    active: true,
    scope: 'ITEM',
    targetItemIds: ['prod_agua'],
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    buyQuantity: null,
    validFrom: null,
    validUntil: null,
  }

  it('🔴 un descuento vigente SÍ llega al POS, con su badge ya formateado', async () => {
    reglaCon(descuentoSano)

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toEqual({ id: 'd1', type: 'PERCENTAGE', value: 20, badge: '-20%' })
  })

  it('un monto fijo trae el badge en pesos', async () => {
    reglaCon({ ...descuentoSano, type: 'FIXED_AMOUNT', value: 15 })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toMatchObject({ type: 'FIXED_AMOUNT', value: 15, badge: '-$15' })
  })

  it('una regla sin descuento devuelve null, no undefined', async () => {
    reglaCon(null)

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  // ── Lo que NO se sirve, y por qué ────────────────────────────────────────

  it('🔴 un descuento de alcance ORDER no se sirve: tumbaría la venta con 400', async () => {
    // `validateDiscountScopeForItem` revienta con alcance de orden aplicado a un
    // artículo. Servirlo convertiría cada venta con esa tarjeta en un error.
    reglaCon({ ...descuentoSano, scope: 'ORDER', targetItemIds: [] })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('🔴 un descuento que no cubre al producto sugerido no se sirve', async () => {
    reglaCon({ ...descuentoSano, targetItemIds: ['otro_producto'] })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('targetItemIds vacío es comodín y SÍ se sirve', async () => {
    reglaCon({ ...descuentoSano, targetItemIds: [] })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toMatchObject({ id: 'd1' })
  })

  it('🔴 un descuento con compra mínima no se sirve: reventaría al cobrar la línea', async () => {
    // `calculateDiscountPesos` lanza si la línea no llega al mínimo — y una
    // sugerencia suelta casi nunca llega.
    reglaCon({ ...descuentoSano, minPurchaseAmount: 200 })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('🔴 un descuento con tope no se sirve: el POS no puede reproducir el tope', async () => {
    // La tarjeta prometería más descuento del que el server va a aplicar.
    reglaCon({ ...descuentoSano, maxDiscountAmount: 50 })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('un descuento desactivado no se sirve', async () => {
    reglaCon({ ...descuentoSano, active: false })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('un 2x1 no se sirve (el POS no lo sabe pintar ni cobrar)', async () => {
    reglaCon({ ...descuentoSano, buyQuantity: 2 })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('un COMP no se sirve', async () => {
    reglaCon({ ...descuentoSano, type: 'COMP', value: 100 })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('🔴 un descuento vencido no se sirve aunque la regla siga ACTIVE', async () => {
    // El job nocturno retira la regla, pero puede pasar hasta un día entre que
    // el descuento vence y el job corre.
    reglaCon({ ...descuentoSano, validUntil: new Date('2020-01-01T00:00:00Z') })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  it('un descuento que todavía no empieza no se sirve', async () => {
    reglaCon({ ...descuentoSano, validFrom: new Date('2999-01-01T00:00:00Z') })

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0].linkedDiscount).toBeNull()
  })

  // ── Regresión: lo que ya funcionaba sigue igual ──────────────────────────

  it('el resto del DTO no cambia por traer el descuento', async () => {
    reglaCon(descuentoSano)

    const dtos = await listActiveRulesForPos('v1')

    expect(dtos[0]).toMatchObject({
      id: 'r1',
      suggestedProductId: 'prod_agua',
      suggestedModifiers: [],
      priority: 0,
      lift: null,
    })
    // El objeto de Prisma no se filtra crudo al POS: sólo el DTO formateado.
    expect((dtos[0] as any).linkedDiscount).not.toHaveProperty('targetItemIds')
  })
})

describe('listRules — el select de `suggestedProduct` trae lo que necesita el badge del dashboard', () => {
  it('🟠 incluye active, soldByWeight y modifierGroups — no sólo upsellEnabled', async () => {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([])

    await listRules('v1')

    expect(prisma.upsellRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'v1' },
        include: {
          suggestedProduct: {
            select: expect.objectContaining({
              id: true,
              name: true,
              price: true,
              imageUrl: true,
              upsellEnabled: true,
              active: true,
              soldByWeight: true,
              modifierGroups: expect.objectContaining({
                select: expect.objectContaining({
                  group: expect.objectContaining({
                    select: expect.objectContaining({ required: true }),
                  }),
                }),
              }),
            }),
          },
        },
      }),
    )
  })

  it('con status filtra por ese status además del venue (no rompe lo de hoy)', async () => {
    ;(prisma.upsellRule.findMany as jest.Mock).mockResolvedValue([])

    await listRules('v1', UpsellRuleStatus.ACTIVE)

    expect(prisma.upsellRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', status: UpsellRuleStatus.ACTIVE } }),
    )
  })
})
