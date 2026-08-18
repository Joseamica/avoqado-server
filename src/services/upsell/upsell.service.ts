/**
 * Upsell "¿Algo más?" — servicio del motor de sugerencias.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * Modelo mental: este servicio NO decide qué se le muestra a un cliente concreto.
 * Sirve la TABLA de reglas activas; el POS la cachea y la resuelve localmente
 * contra el carrito, sin red. Eso es lo que permite que el upsell funcione en un
 * apagón de WiFi igual que el resto del cobro.
 *
 *   dueño / job / IA / promos  ──►  UpsellRule (status=ACTIVE)
 *                                        │
 *                                        ▼  GET /mobile/.../upsell-rules
 *                                   el POS cachea
 *                                        │
 *                                        ▼  al dar Cobrar, SIN red
 *                                   resolver local → 3 tarjetas
 */

import { Prisma, UpsellOrigin, UpsellRuleStatus, UpsellTriggerType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import {
  validateAndResolveModifiers,
  type ProductForValidation,
  type ResolvedModifier,
  type SuggestedModifierSelection,
} from './upsellModifiers'

// ═══════════════════════════════════════════════════════════════════════════
// dedupeKey — identidad estable de una regla
// ═══════════════════════════════════════════════════════════════════════════

export interface DedupeKeyInput {
  origin: UpsellOrigin
  triggerType: UpsellTriggerType
  triggerProductIds?: string[]
  triggerCategoryIds?: string[]
  suggestedProductId: string
  linkedDiscountId?: string | null
}

/**
 * Identidad estable para que los generadores (job nocturno, IA, capa de promos)
 * hagan upsert sin duplicar y sin pisar lo que escribió el dueño.
 *
 * 🔴 Los disparadores VAN en la llave. Un `@@unique` sobre
 * (venueId, triggerType, suggestedProductId, origin) sería un bug: "si llevan café
 * → galleta" y "si llevan té → galleta" son dos reglas OWNER legítimas y
 * colisionarían.
 *
 * 🔴 El id del descuento entra SÓLO en `origin = PROMOTION`, donde dos promociones
 * distintas sobre el mismo producto sí son dos reglas. Y como la llave lo conserva
 * aunque `linkedDiscountId` quede en NULL por el `onDelete: SetNull`, el job sigue
 * sabiendo qué regla murió con qué descuento.
 *
 * Los ids se ORDENAN para que el mismo conjunto en distinto orden produzca la
 * misma llave.
 */
export function computeDedupeKey(input: DedupeKeyInput): string {
  const triggers =
    input.triggerType === UpsellTriggerType.PRODUCT
      ? [...(input.triggerProductIds ?? [])].sort()
      : input.triggerType === UpsellTriggerType.CATEGORY
        ? [...(input.triggerCategoryIds ?? [])].sort()
        : []

  const base = `${input.origin}:${input.triggerType}:${triggers.join(',')}:${input.suggestedProductId}`
  return input.origin === UpsellOrigin.PROMOTION && input.linkedDiscountId ? `${base}:${input.linkedDiscountId}` : base
}

// ═══════════════════════════════════════════════════════════════════════════
// La tabla que viaja al POS
// ═══════════════════════════════════════════════════════════════════════════

export interface PosUpsellRuleDTO {
  id: string
  triggerType: UpsellTriggerType
  triggerProductIds: string[]
  triggerCategoryIds: string[]
  suggestedProductId: string
  /**
   * Opciones obligatorias ya resueltas, con nombre y precio, para que el POS
   * pinte la tarjeta y arme la línea sin recalcular. Vacío = el producto no pide
   * nada. NUNCA null: el POS no debe tener que checar nulos.
   */
  suggestedModifiers: ResolvedModifier[]
  headline: string | null
  priority: number
  /** Sólo BASKET_DATA. El resolver local ordena por priority y luego por esto. */
  lift: number | null
  /** 0=domingo..6=sábado. Vacío = todos los días. */
  daysOfWeek: number[]
  /** "HH:mm" hora LOCAL del venue. Si timeUntil < timeFrom, la ventana cruza medianoche. */
  timeFrom: string | null
  timeUntil: string | null
  /**
   * Descuento ligado a la regla, YA formateado. Null cuando no hay, o cuando el
   * descuento no es seguro de aplicar en el POS (ver `linkedDiscountParaPos`).
   *
   * 🔴 El `badge` viaja formateado DESDE AQUÍ a propósito: dos apps formateando
   * el mismo descuento es la vía rápida a que Android diga "-20%" y iOS "20% off".
   */
  linkedDiscount: PosLinkedDiscountDTO | null
}

export interface PosLinkedDiscountDTO {
  id: string
  /** PERCENTAGE | FIXED_AMOUNT. COMP y 2x1 nunca salen de aquí. */
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  /** Porcentaje (0-100) o monto en PESOS. */
  value: number
  /** "-20%" · "-$15". */
  badge: string
}

/**
 * Select compartido para validar/resolver las opciones obligatorias de un
 * producto sugerido. Un solo `select` para los call sites que lo necesitan:
 * `assertSameVenue` (createRule), `loadProductForValidation` (updateRule),
 * `listActiveRulesForPos` y `listRules`. El tool `upsell_status` del MCP
 * (`src/mcp/tools/upsell.ts`) lo reusa también, para reflejar el mismo
 * `suggestedModifiers` resuelto que ve el POS.
 */
export const PRODUCT_VALIDATION_SELECT = {
  id: true,
  upsellEnabled: true,
  soldByWeight: true,
  modifierGroups: {
    select: {
      group: {
        select: {
          id: true,
          name: true,
          required: true,
          modifiers: { select: { id: true, name: true, price: true, active: true } },
        },
      },
    },
  },
} as const

/**
 * 🔴 NUNCA lanza. Una regla que quedó inválida porque el catálogo cambió después
 * (le pusieron un obligatorio nuevo, desactivaron la opción elegida) no puede
 * tumbar la respuesta de TODAS las demás y dejar al local sin upsell. Devuelve []
 * y el POS la descarta sola, que es exactamente el comportamiento de hoy.
 *
 * 🟡 El fail-open queda — pero degradar en TOTAL silencio es indebuggeable en un
 * local: sin esta línea, "la tarjeta del agua dejó de aparecer" no tiene rastro
 * en ningún lado.
 *
 * Exportada porque el MCP (`upsell_status`) la reusa para mostrar el mismo
 * `suggestedModifiers` resuelto que recibe el POS, en vez de reimplementar la
 * misma degradación fail-open dos veces.
 */
export function resolveForDto(
  product: ProductForValidation | undefined,
  selection: unknown,
  ruleId: string,
  venueId: string,
): ResolvedModifier[] {
  if (!product) return []
  try {
    return validateAndResolveModifiers(product, selection as SuggestedModifierSelection[] | null)
  } catch (error) {
    logger.warn('Regla de upsell con selección inválida — se sirve sin modificadores obligatorios', {
      ruleId,
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

/**
 * Reglas que el POS debe cachear. SÓLO `ACTIVE`, y sólo las que apuntan a un
 * producto que el dueño habilitó explícitamente.
 *
 * 🔴 El filtro por `upsellEnabled` va AQUÍ, del lado del server, además del que
 * haga el cliente: es el veto del dueño y no puede depender de que una versión
 * vieja del POS lo respete.
 */
export async function listActiveRulesForPos(venueId: string): Promise<PosUpsellRuleDTO[]> {
  const rules = await prisma.upsellRule.findMany({
    where: {
      venueId,
      status: UpsellRuleStatus.ACTIVE,
      suggestedProduct: { upsellEnabled: true, active: true, deletedAt: null },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      triggerType: true,
      triggerProductIds: true,
      triggerCategoryIds: true,
      suggestedProductId: true,
      suggestedModifiers: true,
      headline: true,
      priority: true,
      lift: true,
      daysOfWeek: true,
      timeFrom: true,
      timeUntil: true,
      // 🔴 Sin esto el descuento ligado NUNCA llegaba al POS: el job nocturno
      // creaba la regla a partir de una promoción del local, y este `select` la
      // tiraba. La tarjeta pintaba precio de lista y la promoción del venue no
      // se aplicaba jamás por la vía del upsell (medido 2026-08-17).
      linkedDiscount: {
        select: {
          id: true,
          type: true,
          value: true,
          active: true,
          scope: true,
          targetItemIds: true,
          minPurchaseAmount: true,
          maxDiscountAmount: true,
          maxTotalUses: true,
          buyQuantity: true,
          validFrom: true,
          validUntil: true,
        },
      },
    },
  })

  // Un solo lote por TODOS los productos sugeridos de la lista — nunca uno por
  // regla, o cada arranque de POS dispararía un N+1 contra el catálogo.
  const productos = await prisma.product.findMany({
    where: { id: { in: [...new Set(rules.map(r => r.suggestedProductId))] }, venueId },
    select: PRODUCT_VALIDATION_SELECT,
  })
  const porId = new Map(productos.map(p => [p.id, p as ProductForValidation]))

  const ahora = new Date()
  return rules.map(({ linkedDiscount, ...rule }) => ({
    ...rule,
    // Decimal → number. Es un ratio de ordenamiento, no dinero.
    lift: rule.lift === null ? null : Number(rule.lift),
    suggestedModifiers: resolveForDto(porId.get(rule.suggestedProductId), rule.suggestedModifiers, rule.id, venueId),
    linkedDiscount: linkedDiscountParaPos(linkedDiscount, rule.suggestedProductId, ahora),
  }))
}

/**
 * Los campos de un descuento que hacen falta para decidir si el POS lo puede
 * cobrar sin riesgo. Deliberadamente NO incluye `id`/`name`/`value`: esos sólo
 * hacen falta para CONSTRUIR el DTO (`linkedDiscountParaPos`, abajo), no para
 * decidir la elegibilidad.
 */
export interface LinkedDiscountEligibilityInput {
  type: string
  active: boolean
  scope: string
  targetItemIds: string[]
  minPurchaseAmount: Prisma.Decimal | null
  maxDiscountAmount: Prisma.Decimal | null
  maxTotalUses: number | null
  buyQuantity: number | null
  validFrom: Date | null
  validUntil: Date | null
}

/** `null` = el POS lo puede cobrar sin riesgo. Cualquier otro valor es el motivo por el que no. */
export type LinkedDiscountRejectReason =
  | 'DISABLED'
  | 'UNSUPPORTED_TYPE'
  | 'BUY_X_GET_Y_FREE'
  | 'HAS_MIN_PURCHASE'
  | 'HAS_MAX_DISCOUNT_CAP'
  | 'USAGE_CAP_SET'
  | 'SCOPE_NOT_ITEM'
  | 'PRODUCT_NOT_TARGETED'
  | 'NOT_YET_STARTED'
  | 'EXPIRED'

/**
 * La ÚNICA cadena de condiciones que decide si un descuento ligado a una regla
 * de upsell es seguro de cobrar en el POS.
 *
 * 🔴 Aquí conviene pasarse de conservador, porque las dos formas de equivocarse
 * cuestan dinero y una además tumba la venta:
 *
 *  - **Si mandamos un descuento que el endpoint de órdenes va a rechazar, la
 *    VENTA ENTERA falla con 400.** `validateDiscountScopeForItem` revienta con
 *    alcance ORDER o cuando el producto no está en `targetItemIds`, y
 *    `calculateDiscountPesos` revienta si la línea no llega a
 *    `minPurchaseAmount`. En un mostrador con fila, eso es peor que no ofrecer
 *    la promoción.
 *  - **Si mandamos uno cuya aritmética el POS no puede reproducir EXACTO, la
 *    tarjeta promete un precio y la orden registra otro.** Por eso quedan fuera
 *    `maxDiscountAmount` (un tope que el cliente no replica) y COMP/2x1.
 *
 * Exportada para que `linkedDiscountParaPos` (abajo, arma el DTO del POS) y el
 * MCP `upsell_status` (`src/mcp/tools/upsell.ts`, explica el motivo al dueño)
 * reusen la MISMA cadena en vez de tener cada quien su copia — que es justo
 * como se desincronizaron antes: un commit le agregó `maxTotalUses` aquí y no a
 * la copia del MCP (medido 2026-08-17). Cualquier condición nueva se agrega
 * AQUÍ una sola vez y automáticamente aplica a los dos consumidores.
 */
export function evaluateLinkedDiscountForPos(
  discount: LinkedDiscountEligibilityInput,
  suggestedProductId: string,
  ahora: Date,
): LinkedDiscountRejectReason | null {
  if (!discount.active) return 'DISABLED'
  if (discount.type !== 'PERCENTAGE' && discount.type !== 'FIXED_AMOUNT') return 'UNSUPPORTED_TYPE'
  if (discount.buyQuantity !== null) return 'BUY_X_GET_Y_FREE'
  if (discount.minPurchaseAmount !== null) return 'HAS_MIN_PURCHASE'
  if (discount.maxDiscountAmount !== null) return 'HAS_MAX_DISCOUNT_CAP'
  // 🔴 Tope de usos: `validateDiscountActive` (que corre en CADA creación de
  // orden) LANZA cuando `currentUses >= maxTotalUses`, así que un descuento
  // agotado convierte la venta en un 400. Y el POS no lo puede prever: cachea
  // las reglas, así que seguiría ofreciendo la tarjeta hasta el siguiente
  // refresco — cada aceptación tumbando una venta con el cliente enfrente.
  //
  // Se excluye CUALQUIER descuento con tope, no sólo los ya agotados: entre que
  // se sirve la regla y se cobra, el contador puede llegar al límite (lo suben
  // las demás cajas, la TPV y el dashboard). La promoción sigue existiendo y se
  // puede aplicar a mano; lo único que pierde es sugerirse sola.
  if (discount.maxTotalUses !== null) return 'USAGE_CAP_SET'
  if (discount.scope !== 'ITEM') return 'SCOPE_NOT_ITEM'
  // `targetItemIds` vacío es comodín (aplica a todo), igual que lo lee
  // `validateDiscountScopeForItem`.
  if (discount.targetItemIds.length > 0 && !discount.targetItemIds.includes(suggestedProductId)) return 'PRODUCT_NOT_TARGETED'
  if (discount.validFrom && discount.validFrom > ahora) return 'NOT_YET_STARTED'
  if (discount.validUntil && discount.validUntil < ahora) return 'EXPIRED'
  return null
}

/**
 * El descuento ligado, SÓLO si el POS lo puede aplicar sin riesgo. Null si no —
 * la tarjeta muestra precio de lista, que es exactamente el comportamiento de
 * hoy y no rompe nada. La cadena de condiciones vive en
 * `evaluateLinkedDiscountForPos`; esta función sólo arma el DTO cuando pasa.
 */
function linkedDiscountParaPos(
  discount: (LinkedDiscountEligibilityInput & { id: string; value: Prisma.Decimal }) | null,
  suggestedProductId: string,
  ahora: Date,
): PosLinkedDiscountDTO | null {
  if (!discount) return null
  if (evaluateLinkedDiscountForPos(discount, suggestedProductId, ahora) !== null) return null

  const value = Number(discount.value)
  return {
    id: discount.id,
    // TS no ve, a través de la llamada de arriba, que `type` ya quedó acotado a
    // los dos soportados — lo garantiza `evaluateLinkedDiscountForPos`.
    type: discount.type as PosLinkedDiscountDTO['type'],
    value,
    badge: discount.type === 'PERCENTAGE' ? `-${formatearValor(value)}%` : `-$${formatearValor(value)}`,
  }
}

/** 20 → "20", 12.5 → "12.5". Sin decimales de adorno en el badge. */
function formatearValor(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD del dashboard
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateRuleInput {
  venueId: string
  triggerType: UpsellTriggerType
  triggerProductIds?: string[]
  triggerCategoryIds?: string[]
  suggestedProductId: string
  suggestedModifiers?: SuggestedModifierSelection[] | null
  headline?: string | null
  priority?: number
  daysOfWeek?: number[]
  timeFrom?: string | null
  timeUntil?: string | null
}

export class UpsellValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'UpsellValidationError'
  }
}

/**
 * Valida que todo producto/categoría referido pertenezca al MISMO venue.
 * Sin esto, un venue podría disparar sugerencias con ids de otro (fuga entre
 * inquilinos, además de reglas que nunca dispararían).
 */
async function assertSameVenue(venueId: string, input: CreateRuleInput): Promise<ProductForValidation> {
  const productIds = [...(input.triggerProductIds ?? []), input.suggestedProductId]
  const found = await prisma.product.findMany({
    where: { id: { in: productIds }, venueId },
    // 🔴 soldByWeight y los grupos hacen falta para validar las opciones
    // obligatorias. Sin esto el server sería tan ciego como lo era el dashboard.
    select: PRODUCT_VALIDATION_SELECT,
  })
  const foundIds = new Set(found.map(p => p.id))
  const missing = productIds.filter(id => !foundIds.has(id))
  if (missing.length > 0) {
    throw new UpsellValidationError(`Estos productos no existen en este venue: ${missing.join(', ')}`, 'PRODUCT_NOT_IN_VENUE')
  }

  const suggested = found.find(p => p.id === input.suggestedProductId)
  if (!suggested?.upsellEnabled) {
    throw new UpsellValidationError(
      'El producto sugerido no está habilitado para promociones. Actívalo en su ficha antes de crear la regla.',
      'PRODUCT_NOT_UPSELL_ENABLED',
    )
  }

  if ((input.triggerCategoryIds ?? []).length > 0) {
    const cats = await prisma.menuCategory.findMany({
      where: { id: { in: input.triggerCategoryIds! }, venueId },
      select: { id: true },
    })
    const catIds = new Set(cats.map(c => c.id))
    const missingCats = input.triggerCategoryIds!.filter(id => !catIds.has(id))
    if (missingCats.length > 0) {
      throw new UpsellValidationError(`Estas categorías no existen en este venue: ${missingCats.join(', ')}`, 'CATEGORY_NOT_IN_VENUE')
    }
  }

  return suggested as ProductForValidation
}

/** Regla escrita a mano por el dueño. Nace ACTIVE: él ya decidió. */
export async function createRule(input: CreateRuleInput, performedBy: string) {
  const suggestedProduct = await assertSameVenue(input.venueId, input)

  // 🔴 Antes de cualquier escritura: una regla que el POS va a descartar no se
  // guarda. Lanza UpsellModifierError con el nombre del grupo que falta.
  validateAndResolveModifiers(suggestedProduct, input.suggestedModifiers)

  const dedupeKey = computeDedupeKey({
    origin: UpsellOrigin.OWNER,
    triggerType: input.triggerType,
    triggerProductIds: input.triggerProductIds,
    triggerCategoryIds: input.triggerCategoryIds,
    suggestedProductId: input.suggestedProductId,
  })

  const existing = await prisma.upsellRule.findUnique({
    where: { venueId_dedupeKey: { venueId: input.venueId, dedupeKey } },
    select: { id: true, status: true },
  })
  if (existing) {
    throw new UpsellValidationError('Ya existe una regla con ese disparador y ese producto sugerido.', 'DUPLICATE_RULE')
  }

  const rule = await prisma.upsellRule.create({
    data: {
      venueId: input.venueId,
      triggerType: input.triggerType,
      triggerProductIds: input.triggerProductIds ?? [],
      triggerCategoryIds: input.triggerCategoryIds ?? [],
      suggestedProductId: input.suggestedProductId,
      // Se guarda la SELECCIÓN (ids), no lo resuelto: los nombres y precios se
      // resuelven al leer, así un cambio de precio en el catálogo se refleja solo.
      suggestedModifiers: (input.suggestedModifiers ?? []) as unknown as Prisma.InputJsonValue,
      headline: input.headline ?? null,
      origin: UpsellOrigin.OWNER,
      status: UpsellRuleStatus.ACTIVE,
      priority: input.priority ?? 0,
      daysOfWeek: input.daysOfWeek ?? [],
      timeFrom: input.timeFrom ?? null,
      timeUntil: input.timeUntil ?? null,
      dedupeKey,
      approvedById: performedBy,
      approvedAt: new Date(),
    },
  })

  void logAction({
    action: 'UPSELL_RULE_CREATED',
    entity: 'UpsellRule',
    entityId: rule.id,
    staffId: performedBy,
    venueId: input.venueId,
    data: { origin: rule.origin, suggestedProductId: rule.suggestedProductId, triggerType: rule.triggerType },
  })

  return rule
}

/**
 * Aprueba una propuesta (`PROPOSED` → `ACTIVE`). Es lo que hace el dueño cuando
 * el job nocturno o la IA le proponen algo con su evidencia.
 *
 * 🔴 Ronda final de correcciones (2026-08-17): antes esto flipaba el status SIN
 * validar nada. El spec promete "nunca se guarda una regla que el POS va a
 * ignorar" — pero eso sólo era cierto para las reglas que el dueño escribe A
 * MANO (`createRule`/`updateRule`, que sí validan). Una propuesta del job
 * nocturno o de la IA podía activarse aunque el producto se vendiera por peso,
 * estuviera vetado, o pidiera una opción obligatoria sin resolver — el camino
 * de MAYOR volumen (son los que proponen solos, cada noche) quedaba sin la
 * misma protección que el camino manual. Reusa el MISMO validador que
 * `createRule`/`updateRule` (`loadProductForValidation` +
 * `validateAndResolveModifiers`) en vez de escribir una segunda copia de la
 * regla — y también cubre el caso en que el catálogo cambió DESPUÉS de que se
 * propuso la regla (el dueño vetó el producto, o le agregó un obligatorio,
 * entre que se propuso y que decide aprobar).
 */
export async function approveRule(venueId: string, ruleId: string, performedBy: string) {
  const rule = await prisma.upsellRule.findFirst({ where: { id: ruleId, venueId } })
  if (!rule) throw new UpsellValidationError('No encontré esa regla en este venue.', 'RULE_NOT_FOUND')
  if (rule.status === UpsellRuleStatus.ACTIVE) return rule

  const product = await loadProductForValidation(venueId, rule.suggestedProductId)
  // Lanza UpsellModifierError (o UpsellValidationError si el producto ya no
  // existe) — el controller (`upsell.dashboard.controller.ts`) ya sabe
  // traducir ambas a 400 con el código y el mensaje en español.
  validateAndResolveModifiers(product, rule.suggestedModifiers as SuggestedModifierSelection[] | null)

  const updated = await prisma.upsellRule.update({
    where: { id: ruleId },
    data: { status: UpsellRuleStatus.ACTIVE, approvedById: performedBy, approvedAt: new Date() },
  })

  void logAction({
    action: 'UPSELL_RULE_APPROVED',
    entity: 'UpsellRule',
    entityId: ruleId,
    staffId: performedBy,
    venueId,
    data: { origin: rule.origin, suggestedProductId: rule.suggestedProductId, previousStatus: rule.status },
  })

  return updated
}

/**
 * Rechazo del dueño. `DISMISSED` es TUMBA: los generadores nunca la resucitan.
 *
 * 🔴 No confundir con `INACTIVE`, que es "su fuente dejó de aplicar" (una promo
 * que venció) y sí puede revivir sola cuando la fuente vuelve.
 */
export async function dismissRule(venueId: string, ruleId: string, performedBy: string) {
  const rule = await prisma.upsellRule.findFirst({ where: { id: ruleId, venueId } })
  if (!rule) throw new UpsellValidationError('No encontré esa regla en este venue.', 'RULE_NOT_FOUND')

  const updated = await prisma.upsellRule.update({
    where: { id: ruleId },
    data: { status: UpsellRuleStatus.DISMISSED },
  })

  void logAction({
    action: 'UPSELL_RULE_DISMISSED',
    entity: 'UpsellRule',
    entityId: ruleId,
    staffId: performedBy,
    venueId,
    data: { origin: rule.origin, suggestedProductId: rule.suggestedProductId, previousStatus: rule.status },
  })

  return updated
}

/**
 * "Borrar" = escribir tumba, no borrar la fila.
 *
 * 🔴 Un DELETE real permitiría que el generador nocturno recreara la regla en la
 * siguiente corrida, y el dueño la vería reaparecer sin explicación. Además se
 * llevaría el histórico de aceptaciones (FK Restrict en UpsellAcceptance).
 */
export async function deleteRule(venueId: string, ruleId: string, performedBy: string) {
  return dismissRule(venueId, ruleId, performedBy)
}

export interface UpdateRuleInput {
  suggestedProductId?: string
  suggestedModifiers?: SuggestedModifierSelection[] | null
  headline?: string | null
  priority?: number
  daysOfWeek?: number[]
  timeFrom?: string | null
  timeUntil?: string | null
}

/**
 * Comparte `PRODUCT_VALIDATION_SELECT` con `assertSameVenue` (createRule) y
 * `listActiveRulesForPos` — un solo `select` para los tres call sites.
 */
async function loadProductForValidation(venueId: string, productId: string): Promise<ProductForValidation> {
  const product = await prisma.product.findFirst({ where: { id: productId, venueId }, select: PRODUCT_VALIDATION_SELECT })
  if (!product) throw new UpsellValidationError(`El producto ${productId} no existe en este venue`, 'PRODUCT_NOT_IN_VENUE')
  return product as ProductForValidation
}

export async function updateRule(venueId: string, ruleId: string, input: UpdateRuleInput, performedBy: string) {
  const rule = await prisma.upsellRule.findFirst({ where: { id: ruleId, venueId } })
  if (!rule) throw new UpsellValidationError('No encontré esa regla en este venue.', 'RULE_NOT_FOUND')

  // 🔴 Si cambia el producto O la selección, se revalida. Cambiar el producto de
  // una regla sin revalidar reintroduce el bug por la puerta de atrás: la regla
  // nació válida y se vuelve inválida en silencio.
  if (input.suggestedProductId !== undefined || input.suggestedModifiers !== undefined) {
    const productId = input.suggestedProductId ?? rule.suggestedProductId
    const product = await loadProductForValidation(venueId, productId)
    const selection =
      input.suggestedModifiers !== undefined ? input.suggestedModifiers : (rule.suggestedModifiers as SuggestedModifierSelection[] | null)
    validateAndResolveModifiers(product, selection)
  }

  const data: Prisma.UpsellRuleUncheckedUpdateInput = {}
  const suggestedProductChanged = input.suggestedProductId !== undefined && input.suggestedProductId !== rule.suggestedProductId
  if (input.suggestedProductId !== undefined) data.suggestedProductId = input.suggestedProductId

  if (suggestedProductChanged) {
    // 🟠 El producto entra en el dedupeKey (`computeDedupeKey`): si cambia y no se
    // recalcula, la regla miente sobre su propia identidad — deja crear un
    // duplicado real del producto nuevo y bloquea uno legítimo del viejo. Ronda 1
    // de correcciones, latente hasta ahora porque el zod de la ruta ni dejaba
    // llegar `suggestedProductId` hasta aquí.
    const newDedupeKey = computeDedupeKey({
      origin: rule.origin,
      triggerType: rule.triggerType,
      triggerProductIds: rule.triggerProductIds,
      triggerCategoryIds: rule.triggerCategoryIds,
      suggestedProductId: input.suggestedProductId!,
      linkedDiscountId: rule.linkedDiscountId,
    })
    const collision = await prisma.upsellRule.findUnique({
      where: { venueId_dedupeKey: { venueId, dedupeKey: newDedupeKey } },
      select: { id: true },
    })
    if (collision && collision.id !== ruleId) {
      throw new UpsellValidationError('Ya existe una regla con ese disparador y ese producto sugerido.', 'DUPLICATE_RULE')
    }
    data.dedupeKey = newDedupeKey

    // 🟠 El producto cambió: una selección vieja apunta a grupos de OTRO
    // producto y quedaría huérfana en la DB. Se limpia a [] salvo que esta
    // misma llamada ya traiga su propia selección para el producto nuevo (la
    // línea de abajo la sobreescribe con el valor correcto en ese caso).
    if (input.suggestedModifiers === undefined) data.suggestedModifiers = [] as unknown as Prisma.InputJsonValue
  }

  if (input.suggestedModifiers !== undefined) data.suggestedModifiers = (input.suggestedModifiers ?? []) as unknown as Prisma.InputJsonValue
  if (input.headline !== undefined) data.headline = input.headline
  if (input.priority !== undefined) data.priority = input.priority
  if (input.daysOfWeek !== undefined) data.daysOfWeek = input.daysOfWeek
  if (input.timeFrom !== undefined) data.timeFrom = input.timeFrom
  if (input.timeUntil !== undefined) data.timeUntil = input.timeUntil

  const updated = await prisma.upsellRule.update({ where: { id: ruleId }, data })

  void logAction({
    action: 'UPSELL_RULE_UPDATED',
    entity: 'UpsellRule',
    entityId: ruleId,
    staffId: performedBy,
    venueId,
    data: { changed: Object.keys(data) },
  })

  return updated
}

/**
 * 🔴 Ronda 1 de correcciones (2026-08-16): el dashboard tiene un `suggestabilityOf`
 * que espeja los mismos filtros que `UpsellResolver` del POS (upsellEnabled,
 * active, isOutOfStock, soldByWeight, modifierGroups obligatorios) para que su
 * badge de "no sugerible" diga el motivo REAL — pero este `select` sólo traía
 * `upsellEnabled`, así que ese badge sólo podía detectar el veto y mentía por
 * omisión sobre las otras razones. Reusa el shape de `PRODUCT_VALIDATION_SELECT`
 * (mismo `soldByWeight`/`modifierGroups` que usa el resto de este archivo) y le
 * suma `active`, que ese select no necesitaba para SU propósito (validar
 * modificadores) pero el dashboard sí necesita para el suyo.
 */
export async function listRules(venueId: string, status?: UpsellRuleStatus) {
  return prisma.upsellRule.findMany({
    where: { venueId, ...(status ? { status } : {}) },
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
    include: {
      suggestedProduct: {
        select: {
          ...PRODUCT_VALIDATION_SELECT,
          name: true,
          price: true,
          imageUrl: true,
          active: true,
        },
      },
    },
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Las tres perillas por venue
// ═══════════════════════════════════════════════════════════════════════════

export interface UpsellSurfaces {
  counter: boolean
  tableOrdering: boolean
  /** 🔴 Exige red: sin ella no se ofrece. Ver spec R1. */
  tablePaying: boolean
}

const DEFAULT_SURFACES: UpsellSurfaces = { counter: true, tableOrdering: true, tablePaying: true }

/** NULL en la columna = las tres prendidas (default de la función). */
export function parseUpsellSurfaces(raw: unknown): UpsellSurfaces {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SURFACES }
  const o = raw as Record<string, unknown>
  return {
    counter: typeof o.counter === 'boolean' ? o.counter : DEFAULT_SURFACES.counter,
    tableOrdering: typeof o.tableOrdering === 'boolean' ? o.tableOrdering : DEFAULT_SURFACES.tableOrdering,
    tablePaying: typeof o.tablePaying === 'boolean' ? o.tablePaying : DEFAULT_SURFACES.tablePaying,
  }
}

export async function getUpsellSurfaces(venueId: string): Promise<UpsellSurfaces> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { upsellSurfaces: true } })
  return parseUpsellSurfaces(venue?.upsellSurfaces)
}

export async function setUpsellSurfaces(venueId: string, surfaces: UpsellSurfaces, performedBy: string): Promise<UpsellSurfaces> {
  const previous = await getUpsellSurfaces(venueId)
  await prisma.venue.update({
    where: { id: venueId },
    data: { upsellSurfaces: surfaces as unknown as Prisma.InputJsonValue },
  })

  void logAction({
    action: 'UPSELL_SURFACES_UPDATED',
    entity: 'Venue',
    entityId: venueId,
    staffId: performedBy,
    venueId,
    // Aplanado a un literal JSON: una `interface` de TS no es asignable a
    // InputJsonValue (no tiene index signature implícita).
    data: {
      previous: { ...previous },
      next: { ...surfaces },
    },
  })

  return surfaces
}

// ═══════════════════════════════════════════════════════════════════════════
// Habilitar un producto para upsell (el veto del dueño)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 🔴 `false` gana sobre las CUATRO capas, incluidas IA y market basket. Apagarlo
 * NO borra las reglas: sólo deja de servirlas (ver el filtro de
 * `listActiveRulesForPos`), así que volver a prenderlo las revive intactas.
 */
export async function setProductUpsellEnabled(venueId: string, productIds: string[], enabled: boolean, performedBy: string) {
  const result = await prisma.product.updateMany({
    where: { id: { in: productIds }, venueId },
    data: { upsellEnabled: enabled },
  })

  void logAction({
    action: enabled ? 'UPSELL_PRODUCT_ENABLED' : 'UPSELL_PRODUCT_DISABLED',
    entity: 'Product',
    entityId: productIds.length === 1 ? productIds[0] : undefined,
    staffId: performedBy,
    venueId,
    data: { productIds, count: result.count },
  })

  return result.count
}
