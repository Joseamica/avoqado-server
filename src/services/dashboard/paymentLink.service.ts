/**
 * Payment Link Service
 *
 * Manages payment link CRUD operations for the dashboard.
 * Payment links allow venues to generate shareable URLs for collecting payments.
 *
 * @module services/dashboard/paymentLink
 */

import prisma from '@/utils/prismaClient'
import { createHash } from 'node:crypto'
import { canonicalJson } from '@/services/customer-display/canonicalHash'
import { PaymentMethod, Prisma } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError, PaymentOutcomeUnknownError, UnauthorizedError } from '@/errors/AppError'
import logger from '@/config/logger'
import { nanoid } from 'nanoid'
import { logAction } from './activity-log.service'
import { applySalePosting, createSalePostingInTx } from '@/services/inventory/inventoryPosting.service'
import { getProvider } from '@/services/payments/provider-registry'
import { isEcommerceMerchantChargeable } from '@/services/payments/ecommerceCapability'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '@/services/payments/providers/money'
import { getVatRateBps } from '@/services/superadmin/platformSettings.service'
import emailService from '@/services/email.service'
import { generateDigitalReceipt } from '@/services/tpv/digitalReceipt.tpv.service'
import { formatInTimeZone } from 'date-fns-tz'
import { es as esLocale } from 'date-fns/locale'
import { enqueuePaymentCommissionInTx } from '@/services/tpv/paymentEffects.service'
import { activarSobresDeCuentaPagadaEnTx } from '../giftCards/giftCardLedger'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO } from '@/services/tpv/candadoDeIntento'
import { sendReceiptWhatsApp, sendPaymentLinkShareWhatsApp } from '@/services/whatsapp.service'
import { assertVenueSalesEnabled } from '@/services/venueSalesGuard'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { paymentLinksDashboardUrl } from '@/services/dashboard/paymentLink.dashboardUrl'
import {
  BASE_LIGA_ABIERTA,
  cargarRegla,
  Desglose,
  DescuentoDeLiga,
  desgloseDeLiga,
  EntradaDescuento,
  MotivoNoDisponible,
  rechazarDescuentoEnDonacion,
  reglaDeFila,
  resolverDescuentoDeEntrada,
  resumenDeDescuento,
  validarFotoContraBase,
  vistaDeDescuento,
} from '@/services/dashboard/paymentLinkDiscount'
import { filaDeDescuentoDeLiga } from '@/services/shared/discount.service'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'

// Stripe charge bounds (MXN cents). Kept inline to avoid yet-another shared
// module for what is functionally a pair of env-tunable constants. Defaults
// pick safe values: $10 min, $50,000 max per transaction.
function getStripeChargeBounds() {
  return {
    min: Number(process.env.STRIPE_MIN_CHARGE_MXN_CENTS ?? 1000),
    max: Number(process.env.STRIPE_MAX_CHARGE_MXN_CENTS ?? 5000000),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BUNDLE VALIDATION (shared by create + update)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate raw bundle items (products + modifiers) and return them in a shape
 * ready for Prisma nested writes. Throws BadRequestError on any violation.
 *
 * Rules enforced:
 *   1. 1-20 items per bundle
 *   2. Duplicate productIds are deduped (quantities summed)
 *   3. Every productId belongs to this venue
 *   4. quantity ≥ 1 (defaults to 1 if missing)
 *   5. Every modifierId belongs to a group linked to its product
 *   6. Required modifier groups have ≥ 1 modifier picked
 *   7. minSelections / maxSelections per group are respected
 *   8. All modifiers' venue matches the item's venue
 */
async function validateBundleItems(
  venueId: string,
  rawItems: Array<{ productId: string; quantity: number; modifiers?: Array<{ modifierId: string; quantity?: number }> }>,
): Promise<
  Array<{
    productId: string
    quantity: number
    position: number
    modifiers: Array<{ modifierId: string; quantity: number }>
  }>
> {
  if (rawItems.length === 0) {
    throw new BadRequestError('La liga de pago de artículo requiere al menos un producto')
  }
  if (rawItems.length > 20) {
    throw new BadRequestError('Máximo 20 productos por liga de pago')
  }

  // Dedupe products. When the same product appears 2x, sum the quantities AND
  // merge their modifier lists (also dedupe modifiers within the merged set).
  const byProduct = new Map<string, { quantity: number; position: number; modifiers: Map<string, number> }>()
  rawItems.forEach((it, idx) => {
    const qty = Math.max(1, Math.floor(it.quantity || 1))
    const existing = byProduct.get(it.productId)
    if (!existing) {
      byProduct.set(it.productId, { quantity: qty, position: idx, modifiers: new Map() })
    } else {
      existing.quantity += qty
    }
    const entry = byProduct.get(it.productId)!
    for (const m of it.modifiers ?? []) {
      const mqty = Math.max(1, Math.floor(m.quantity ?? 1))
      entry.modifiers.set(m.modifierId, (entry.modifiers.get(m.modifierId) ?? 0) + mqty)
    }
  })

  const distinctProductIds = [...byProduct.keys()]

  // Load each product with its modifier groups + modifiers. We need the
  // group metadata (required, minSelections, maxSelections) to validate the
  // admin's selection. Stale references (deleted modifiers) are caught here.
  const products = await prisma.product.findMany({
    where: { id: { in: distinctProductIds }, venueId },
    select: {
      id: true,
      modifierGroups: {
        select: {
          group: {
            select: {
              id: true,
              name: true,
              required: true,
              minSelections: true,
              maxSelections: true,
              modifiers: { where: { active: true }, select: { id: true } },
            },
          },
        },
      },
    },
  })
  const validProductIds = new Set(products.map(p => p.id))
  const invalidProducts = distinctProductIds.filter(id => !validProductIds.has(id))
  if (invalidProducts.length > 0) {
    throw new BadRequestError(
      `Uno o más productos no existen o no pertenecen a este venue (${invalidProducts.length} inválido${invalidProducts.length === 1 ? '' : 's'}).`,
    )
  }

  // Per-product modifier validation. The product's allowed modifier set is the
  // union of all modifiers across its linked groups; cross-product modifier
  // attribution is rejected (admin can't sneak a Pizza topping onto a Café).
  for (const product of products) {
    const entry = byProduct.get(product.id)!
    const selectedModifierIds = [...entry.modifiers.keys()]

    // Build group lookup so we can count selections per group.
    const groups = product.modifierGroups.map(pmg => pmg.group)
    const modifierToGroup = new Map<string, (typeof groups)[number]>()
    const allowedModifiers = new Set<string>()
    for (const g of groups) {
      for (const m of g.modifiers) {
        modifierToGroup.set(m.id, g)
        allowedModifiers.add(m.id)
      }
    }

    // Reject modifiers that don't belong to this product.
    const unrelated = selectedModifierIds.filter(id => !allowedModifiers.has(id))
    if (unrelated.length > 0) {
      throw new BadRequestError(
        `Uno o más modificadores no pertenecen al producto seleccionado (${unrelated.length} inválido${unrelated.length === 1 ? '' : 's'}).`,
      )
    }

    // Per-group selection count (sum of quantities, since allowMultiple may apply).
    const countsByGroup = new Map<string, number>()
    for (const mid of selectedModifierIds) {
      const g = modifierToGroup.get(mid)!
      countsByGroup.set(g.id, (countsByGroup.get(g.id) ?? 0) + (entry.modifiers.get(mid) ?? 0))
    }

    // Required groups must have at least one selection.
    for (const g of groups) {
      const picked = countsByGroup.get(g.id) ?? 0
      if (g.required && picked === 0) {
        throw new BadRequestError(`El modificador "${g.name}" es requerido para este producto.`)
      }
      if (picked < g.minSelections) {
        throw new BadRequestError(`El grupo de modificadores "${g.name}" requiere al menos ${g.minSelections} selección(es).`)
      }
      if (g.maxSelections != null && picked > g.maxSelections) {
        throw new BadRequestError(`El grupo de modificadores "${g.name}" permite máximo ${g.maxSelections} selección(es).`)
      }
    }
  }

  return distinctProductIds.map(pid => {
    const entry = byProduct.get(pid)!
    return {
      productId: pid,
      quantity: entry.quantity,
      position: entry.position,
      modifiers: [...entry.modifiers.entries()].map(([modifierId, quantity]) => ({ modifierId, quantity })),
    }
  })
}

/**
 * validateBundleItems reads without locks: «Reemplazar menú» (importMenu replace) can delete a product or extra between that
 * read and the insert. The foreign key then rejects the row (P2003) — the safe outcome (plan 5, C5-1) — and this turns it
 * into a 409 the owner can act on instead of a 500 carrying Prisma's text. Any other error passes through unchanged.
 */
function rethrowMenuChangedWhileSaving(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003' &&
    /PaymentLinkItem(Modifier)?_(productId|modifierId)_fkey/.test(`${error.message} ${JSON.stringify(error.meta ?? {})}`)
  ) {
    throw new ConflictError(
      'El menú cambió mientras guardabas la liga y uno de los productos o extras ya no existe. Vuelve a elegirlos y guarda otra vez.',
    )
  }
  throw error
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS (items with modifiers)
// ═══════════════════════════════════════════════════════════════════════════

const CUSTOMER_SUMMARY_SELECT = { id: true, firstName: true, lastName: true, email: true, phone: true } as const

/** Prisma include clause for loading a bundle's items + modifiers ready for
 *  pricing/snapshotting. Centralised so the 3 checkout flows (Stripe Elements,
 *  Stripe Hosted, Blumon) stay in sync. */
const BUNDLE_ITEMS_INCLUDE = {
  items: {
    orderBy: { position: 'asc' as const },
    include: {
      product: { select: { id: true, name: true, description: true, price: true, imageUrl: true, taxRate: true } },
      modifiers: {
        include: {
          modifier: { select: { id: true, name: true, price: true } },
        },
      },
    },
  },
}

/** Bundle line snapshot shape — what we persist to CheckoutSession.metadata
 *  and Stripe PaymentIntent.metadata so the webhook can replay OrderItem +
 *  OrderItemModifier creation without re-reading the link. */
export interface BundleItemSnapshot {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  modifiers: Array<{ modifierId: string; modifierName: string; quantity: number; price: number }>
}

/** Compute the total customer charge for a bundle: sum over items of
 *  quantity × (product.price + Σ modifier.price × modifier.quantity).
 *  Modifiers are priced per-modifier-unit (e.g. 2 extra cheese = 2 × price). */
function computeBundleTotal(
  items: Array<{
    quantity: number
    product: { price: Prisma.Decimal | number }
    modifiers: Array<{ quantity: number; modifier: { price: Prisma.Decimal | number } }>
  }>,
): number {
  return items.reduce((sum, it) => {
    const modSum = it.modifiers.reduce((m, mm) => m + Number(mm.modifier.price) * mm.quantity, 0)
    return sum + (Number(it.product.price) + modSum) * it.quantity
  }, 0)
}

/** Total del paquete para validar un descuento al crear/editar: lee precios vigentes de productos y extras. */
async function totalDeItemsResueltos(
  venueId: string,
  items: Array<{ productId: string; quantity: number; modifiers: Array<{ modifierId: string; quantity: number }> }>,
): Promise<number> {
  const productIds = items.map(i => i.productId)
  const modifierIds = items.flatMap(i => i.modifiers.map(m => m.modifierId))
  const [products, modifiers] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds }, venueId }, take: productIds.length, select: { id: true, price: true } }),
    modifierIds.length > 0
      ? prisma.modifier.findMany({ where: { id: { in: modifierIds } }, take: modifierIds.length, select: { id: true, price: true } })
      : [],
  ])
  const productPrice = new Map(products.map(p => [p.id, p.price]))
  const modifierPrice = new Map(modifiers.map(m => [m.id, m.price]))
  return computeBundleTotal(
    items.map(i => ({
      quantity: i.quantity,
      product: { price: productPrice.get(i.productId) ?? 0 },
      modifiers: i.modifiers.map(m => ({ quantity: m.quantity, modifier: { price: modifierPrice.get(m.modifierId) ?? 0 } })),
    })),
  )
}

/**
 * Lo que se cobra en los cuatro caminos de una liga: base − descuento + propina.
 * - Base: fija = `amount`; abierta = lo que escribió la clienta; productos = total vivo del paquete.
 * - Un descuento del catálogo que ya no aplica (vencido, apagado, fuera de horario, sin la compra mínima) se cobra sin
 *   descuento: es lo que la página muestra como «ya no está disponible».
 * - Abierta con un descuento que no cabe en lo escrito → 400 (nunca se cobra completo en silencio).
 * - `expectedTotal` (el total que mostró la página) distinto, en centavos → 409 con el desglose nuevo, sin cobrar.
 * - `minimoNeto` (pesos): con descuento efectivo, el neto solo, sin propina, debe alcanzar el mínimo del procesador.
 *   Sin descuento, cada camino valida el total exactamente como antes.
 */
export async function cobroDeLiga(
  link: {
    venueId: string
    purpose: string
    amountType: string
    amount: Prisma.Decimal | number | null
    discount?: Prisma.JsonValue | null
    tippingConfig: Prisma.JsonValue | null
    items: Parameters<typeof computeBundleTotal>[0]
  },
  input: { amount?: number; tipAmount?: number; expectedTotal?: number },
  ahora: Date,
  minimoNeto = 0,
): Promise<{
  desglose: Desglose
  propina: number
  total: number
  fotoParaSesion: { foto: DescuentoDeLiga; descuento: number; base: number } | null
}> {
  const esPaquete = link.purpose === 'ITEM' && link.items.length > 0
  let base: number
  if (esPaquete) {
    base = computeBundleTotal(link.items)
  } else if (link.amountType === 'FIXED') {
    base = Number(link.amount)
  } else {
    if (!input.amount || input.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    base = input.amount
  }

  const foto = (link.discount as unknown as DescuentoDeLiga | null) ?? null
  let desglose: Desglose
  if (foto) {
    const [regla, venue] = await Promise.all([
      cargarRegla(prisma, foto),
      prisma.venue.findUnique({ where: { id: link.venueId }, select: { timezone: true } }),
    ])
    desglose = desgloseDeLiga(base, foto, regla, ahora, venue?.timezone ?? 'America/Mexico_City')
    const porCompraMinima = regla?.minPurchaseAmount != null && base < regla.minPurchaseAmount
    if (!esPaquete && link.amountType !== 'FIXED' && desglose.motivo === 'MINIMO' && !porCompraMinima) {
      throw new BadRequestError('El descuento es mayor que el importe')
    }
  } else {
    desglose = desgloseDeLiga(base, null, null, ahora, 'America/Mexico_City')
  }

  const propina = input.tipAmount && input.tipAmount > 0 ? input.tipAmount : 0
  if (propina > 0 && !link.tippingConfig) {
    throw new BadRequestError('Esta liga de pago no acepta propinas')
  }
  const total = new Prisma.Decimal(desglose.neto).plus(propina).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()

  if (input.expectedTotal != null && Math.round(input.expectedTotal * 100) !== Math.round(total * 100)) {
    throw new ConflictError('El precio de esta liga cambió', 'PAYMENT_LINK_PRICE_CHANGED', { desglose })
  }
  if (desglose.descuento > 0 && desglose.neto < minimoNeto) {
    throw new BadRequestError(`Con el descuento, el importe queda debajo del mínimo de cobro ($${minimoNeto.toFixed(2)} MXN)`)
  }

  return {
    desglose,
    propina,
    total,
    fotoParaSesion: foto && desglose.aplica ? { foto, descuento: desglose.descuento, base: desglose.base } : null,
  }
}

/** Project the Prisma-loaded items into the snapshot shape we put on
 *  CheckoutSession.metadata. The webhook handler reads this back to create
 *  OrderItem + OrderItemModifier rows. */
function buildBundleSnapshot(
  items: Array<{
    quantity: number
    product: { id: string; name: string; price: Prisma.Decimal | number }
    modifiers: Array<{ quantity: number; modifier: { id: string; name: string; price: Prisma.Decimal | number } }>
  }>,
): BundleItemSnapshot[] {
  return items.map(it => ({
    productId: it.product.id,
    productName: it.product.name,
    quantity: it.quantity,
    unitPrice: Number(it.product.price),
    modifiers: it.modifiers.map(mm => ({
      modifierId: mm.modifier.id,
      modifierName: mm.modifier.name,
      quantity: mm.quantity,
      price: Number(mm.modifier.price),
    })),
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CustomFieldDefinition {
  id: string
  type: 'TEXT' | 'SELECT'
  label: string
  required: boolean
  options?: string[]
}

export interface TippingConfig {
  presets: number[]
  allowCustom: boolean
}

export interface CreatePaymentLinkData {
  customerId?: string | null
  title: string
  description?: string
  imageUrl?: string
  amountType: 'FIXED' | 'OPEN'
  amount?: number
  currency?: string
  isReusable?: boolean
  expiresAt?: string
  redirectUrl?: string
  purpose?: 'PAYMENT' | 'ITEM' | 'DONATION'
  /**
   * Line items for ITEM-purpose links. Bundle model: customer pays the
   * fixed total of sum(quantity × (product.price + Σ modifier.price)).
   * Required when purpose is ITEM, ignored otherwise. Max 20 items per link.
   *
   * Each item may include pre-selected modifiers (e.g. size, toppings,
   * substitutions). Validation enforces: modifiers belong to a group linked
   * to the product · required groups have ≥1 selection · min/max bounds
   * respected · all modifiers belong to the venue.
   */
  items?: Array<{
    productId: string
    quantity: number
    modifiers?: Array<{ modifierId: string; quantity?: number }>
  }>
  customFields?: CustomFieldDefinition[] | null
  tippingConfig?: TippingConfig | null
  /**
   * Optional — pin the link to a specific ecommerce merchant (channel). When
   * omitted, the service auto-picks: prefers Blumon if available, else the
   * first active merchant. Required when the venue has multiple active
   * channels and the user wants control over which one the link routes to.
   */
  ecommerceMerchantId?: string
  /**
   * Optional — array of staff IDs who share commission for sales via this
   * link. Distinct from the link *creator* (taken from auth session).
   *
   *   []      → no commission
   *   [a]     → 100% to staff a
   *   [a, b]  → 50/50 between a and b
   *   [a,b,c] → 33/33/33
   *
   * The first ID also becomes `Payment.processedById` so reports/receipts
   * show a named staff. Lets a manager create a link "on behalf of"
   * salespeople, or create uncredited links for donations.
   */
  attributedStaffIds?: string[]
  /** Descuento de la liga: escrito a mano o tomado del catálogo. `null`/ausente = sin descuento. */
  discount?: EntradaDescuento | null
}

export interface UpdatePaymentLinkData {
  /** Sólo AGREGA a una liga sin cliente; nunca cambia ni quita uno puesto (founder, 23-oct). */
  customerId?: string
  title?: string
  description?: string | null
  imageUrl?: string | null
  amountType?: 'FIXED' | 'OPEN'
  amount?: number | null
  currency?: string
  isReusable?: boolean
  expiresAt?: string | null
  redirectUrl?: string | null
  status?: 'ACTIVE' | 'PAUSED'
  /** Replace the full item list for an ITEM link. Pass null/[] to clear. */
  items?: Array<{
    productId: string
    quantity: number
    modifiers?: Array<{ modifierId: string; quantity?: number }>
  }> | null
  customFields?: CustomFieldDefinition[] | null
  tippingConfig?: TippingConfig | null
  /** Poner/cambiar con un objeto; `null` lo quita; ausente no lo toca. */
  discount?: EntradaDescuento | null
}

export interface ListPaymentLinksFilters {
  status?: string
  search?: string
  limit?: number
  offset?: number
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD CRUD
// ═══════════════════════════════════════════════════════════════════════════

// `isEcommerceMerchantChargeable` now lives in @/services/payments/ecommerceCapability
// (imported above) so every online-money surface — payment links, reservation
// deposits, credit packs — shares one "can this channel actually charge?" predicate.

/**
 * Creates a new payment link for a venue
 */
export async function createPaymentLink(
  venueId: string,
  data: CreatePaymentLinkData,
  staffId: string,
  creationKey?: string,
  onCreated?: (link: { id: string; discount: Prisma.JsonValue }) => Promise<void>,
) {
  if (creationKey !== undefined && (!creationKey.trim() || creationKey.length > 128)) {
    throw new BadRequestError('La clave de creación debe tener entre 1 y 128 caracteres')
  }
  const creationHash = creationKey ? createHash('sha256').update(canonicalJson(data)).digest('hex') : undefined
  const previousCreation = async () => {
    if (!creationKey) return null
    const previous = await prisma.paymentLink.findUnique({
      where: { venueId_createdById_creationKey: { venueId, createdById: staffId, creationKey } },
      include: {
        customer: { select: CUSTOMER_SUMMARY_SELECT },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { checkoutSessions: true } },
      },
    })
    if (previous && previous.creationHash !== creationHash) throw new ConflictError('Esta clave de creación ya se usó con otros datos')
    return previous
  }
  const previous = await previousCreation()
  if (previous) return previous
  await assertVenueSalesEnabled(venueId)
  if (data.customerId) {
    const customer = await prisma.customer.findFirst({ where: { id: data.customerId, venueId, active: true }, select: { id: true } })
    if (!customer) throw new BadRequestError('El cliente no existe, está inactivo o no pertenece a este negocio')
  }
  // 1. Resolve the ecommerce merchant (channel) to attach the link to.
  //
  // Two paths:
  //   A. Caller specifies `ecommerceMerchantId` → use it but verify it
  //      belongs to this venue and is active. Lets the user pick when there
  //      are multiple active channels (e.g. Stripe + Blumon).
  //   B. Not specified → auto-pick. Only consider channels that can ACTUALLY
  //      charge (see isEcommerceMerchantChargeable); prefer Blumon for its
  //      inline card-capture UX, then any other chargeable channel. This stops
  //      us from binding a link to an unconfigured channel that would throw
  //      "Configuración de pago incompleta" at checkout.
  let ecommerceMerchant: { id: string } | null = null

  if (data.ecommerceMerchantId) {
    ecommerceMerchant = await prisma.ecommerceMerchant.findFirst({
      where: { id: data.ecommerceMerchantId, venueId, active: true },
      select: { id: true },
    })
    if (!ecommerceMerchant) {
      throw new BadRequestError('El canal de e-commerce seleccionado no existe, no está activo, o no pertenece a este venue.')
    }
  } else {
    const candidates = await prisma.ecommerceMerchant.findMany({
      where: { venueId, active: true },
      select: {
        id: true,
        chargesEnabled: true,
        providerCredentials: true,
        provider: { select: { code: true } },
      },
    })

    const chargeable = candidates.filter(isEcommerceMerchantChargeable)
    ecommerceMerchant = chargeable.find(m => m.provider?.code === 'BLUMON') ?? chargeable[0] ?? null
  }

  if (!ecommerceMerchant) {
    throw new BadRequestError(
      'Este venue no tiene un canal de e-commerce listo para cobrar. Completa la activación del canal (Stripe, Mercado Pago o Blumon) o contacta a soporte.',
    )
  }

  // 2. ITEM links: validate the line items array (+ modifiers). Bundle model
  // — N products each with quantity ≥1 and optional pre-selected modifiers.
  // Output `resolvedItems` is ready to write directly via Prisma nested create.
  let resolvedItems: Array<{
    productId: string
    quantity: number
    position: number
    modifiers: Array<{ modifierId: string; quantity: number }>
  }> = []
  if (data.purpose === 'ITEM') {
    resolvedItems = await validateBundleItems(venueId, data.items ?? [])
  }

  // 2b. Descuento: se valida contra la base (fija → amount, ITEM → total del paquete, abierta → sin base).
  rechazarDescuentoEnDonacion(data.purpose, data.discount)
  const createBase = !data.discount
    ? null
    : data.purpose === 'ITEM'
      ? await totalDeItemsResueltos(venueId, resolvedItems)
      : data.amountType === 'FIXED' && data.amount != null
        ? data.amount
        : null
  const { foto: discountFoto, discountId } = await resolverDescuentoDeEntrada(prisma, venueId, data.discount, {
    isReusable: data.isReusable ?? false,
    base: createBase,
  })

  // 3. Validate every attributedStaffId belongs to this venue and is active.
  // Prevents misattribution across organizations. Dedupe + drop falsy values
  // up-front so the caller can send sloppy input safely.
  const attributedStaffIds = Array.from(new Set((data.attributedStaffIds ?? []).filter(Boolean)))
  if (attributedStaffIds.length > 0) {
    const validStaff = await prisma.staffVenue.findMany({
      where: { staffId: { in: attributedStaffIds }, venueId, active: true },
      select: { staffId: true },
    })
    const validIds = new Set(validStaff.map(sv => sv.staffId))
    const invalid = attributedStaffIds.filter(id => !validIds.has(id))
    if (invalid.length > 0) {
      throw new BadRequestError(
        `Uno o más miembros del equipo seleccionados no pertenecen a este venue o están inactivos (${invalid.length} inválido${invalid.length === 1 ? '' : 's'}).`,
      )
    }
  }

  // 4. Generate unique short code
  const shortCode = nanoid(8)

  // 5. Create payment link
  let replayed = false
  const paymentLink = await prisma.paymentLink
    .create({
      data: {
        shortCode,
        customerId: data.customerId ?? null,
        creationKey,
        creationHash,
        venueId,
        ecommerceMerchantId: ecommerceMerchant.id,
        createdById: staffId,
        attributions: attributedStaffIds.length > 0 ? { create: attributedStaffIds.map(id => ({ staffId: id })) } : undefined,
        purpose: data.purpose || 'PAYMENT',
        items:
          resolvedItems.length > 0
            ? {
                create: resolvedItems.map(it => ({
                  productId: it.productId,
                  quantity: it.quantity,
                  position: it.position,
                  modifiers: it.modifiers.length > 0 ? { create: it.modifiers } : undefined,
                })),
              }
            : undefined,
        title: data.title,
        description: data.description,
        imageUrl: data.imageUrl,
        amountType: data.amountType,
        amount: data.amount !== undefined && data.amount !== null ? new Prisma.Decimal(data.amount) : undefined,
        currency: data.currency || 'MXN',
        isReusable: data.isReusable ?? false,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        redirectUrl: data.redirectUrl,
        customFields: data.customFields ? (data.customFields as unknown as Prisma.InputJsonValue) : undefined,
        tippingConfig: data.tippingConfig ? (data.tippingConfig as unknown as Prisma.InputJsonValue) : undefined,
        discount: discountFoto ? (discountFoto as unknown as Prisma.InputJsonValue) : undefined,
        discountId,
      },
      include: {
        customer: { select: CUSTOMER_SUMMARY_SELECT },
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        _count: {
          select: { checkoutSessions: true },
        },
      },
    })
    .catch(async error => {
      if (creationKey && error?.code === 'P2002') {
        const winner = await previousCreation()
        if (winner) {
          replayed = true
          return winner
        }
      }
      return rethrowMenuChangedWhileSaving(error)
    })
  if (replayed) return paymentLink

  logger.info('Payment link created', {
    paymentLinkId: paymentLink.id,
    shortCode,
    venueId,
    amountType: data.amountType,
  })

  if (onCreated) {
    try {
      await onCreated(paymentLink)
    } catch (error) {
      logger.error('No se pudo auditar la creación MCP de la liga', { paymentLinkId: paymentLink.id, error })
    }
  } else {
    logAction({
      venueId,
      staffId,
      action: 'PAYMENT_LINK_CREATED',
      entity: 'PaymentLink',
      entityId: paymentLink.id,
      data:
        data.customerId || discountFoto
          ? {
              ...(data.customerId ? { customerId: data.customerId } : {}),
              ...(discountFoto ? { discount: resumenDeDescuento(discountFoto) } : {}),
            }
          : undefined,
    })
  }

  return paymentLink
}

const DISCOUNT_RULE_SELECT = {
  id: true,
  active: true,
  validFrom: true,
  validUntil: true,
  daysOfWeek: true,
  timeFrom: true,
  timeUntil: true,
  minPurchaseAmount: true,
  maxDiscountAmount: true,
  scope: true,
  type: true,
  requiresApproval: true,
  isAutomatic: true,
  buyQuantity: true,
  getQuantity: true,
  getDiscountPercent: true,
  buyItemIds: true,
  getItemIds: true,
  maxTotalUses: true,
  maxUsesPerCustomer: true,
  customerGroupId: true,
} as const

/** Descuento del catálogo que ya no existe: se lee como «apagado». */
const MISSING_RULE = {
  active: false,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  existe: false,
  compatible: false,
}

/**
 * Lists payment links for a venue with filtering
 */
export async function getPaymentLinks(venueId: string, filters: ListPaymentLinksFilters = {}) {
  const { status, search } = filters
  const limit = Number.isFinite(filters.limit) ? Math.min(100, Math.max(1, Math.floor(filters.limit!))) : 20
  const offset = Number.isFinite(filters.offset) ? Math.max(0, Math.floor(filters.offset!)) : 0

  const where: Prisma.PaymentLinkWhereInput = { venueId }

  if (status) {
    where.status = status as any
  }

  if (search) {
    where.title = { contains: search, mode: 'insensitive' }
  }

  const [paymentLinks, total] = await Promise.all([
    prisma.paymentLink.findMany({
      where,
      include: {
        customer: { select: CUSTOMER_SUMMARY_SELECT },
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        _count: {
          select: { checkoutSessions: true },
        },
      },
      // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
      // on one page and drops another for good (Asana 1217127206664238).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    }),
    prisma.paymentLink.count({ where }),
  ])

  // Estado del descuento calculado al leer: una consulta para los descuentos del catálogo de la página y una para la zona (sin N+1).
  const conDescuento = paymentLinks.filter(l => l.discount)
  const catalogIds = [
    ...new Set(conDescuento.map(l => (l.discount as unknown as DescuentoDeLiga).discountId).filter((id): id is string => !!id)),
  ]
  const [filas, venue] =
    conDescuento.length > 0
      ? await Promise.all([
          catalogIds.length > 0
            ? prisma.discount.findMany({
                where: { id: { in: catalogIds }, venueId },
                take: catalogIds.length,
                select: DISCOUNT_RULE_SELECT,
              })
            : [],
          prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
        ])
      : [[], null]
  const reglas = new Map(filas.map(f => [f.id, reglaDeFila(f)]))
  const ahora = new Date()
  const zona = venue?.timezone ?? 'America/Mexico_City'
  const withDiscount = paymentLinks.map(l => {
    const foto = (l.discount as unknown as DescuentoDeLiga | null) ?? null
    const regla = foto?.discountId ? (reglas.get(foto.discountId) ?? MISSING_RULE) : null
    return { ...l, ...vistaDeDescuento(foto, regla, l.amount != null ? Number(l.amount) : null, ahora, zona) }
  })

  return {
    paymentLinks: withDiscount,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  }
}

/**
 * Gets a single payment link by ID
 */
export async function getPaymentLinkById(venueId: string, linkId: string) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    include: {
      customer: { select: CUSTOMER_SUMMARY_SELECT },
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      ...BUNDLE_ITEMS_INCLUDE,
      attributions: {
        orderBy: { createdAt: 'asc' },
        include: {
          staff: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      checkoutSessions: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          sessionId: true,
          amount: true,
          status: true,
          customerEmail: true,
          createdAt: true,
          completedAt: true,
        },
      },
      _count: {
        select: { checkoutSessions: true },
      },
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (paymentLink.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  const foto = (paymentLink.discount as unknown as DescuentoDeLiga | null) ?? null
  if (!foto) return { ...paymentLink, ...vistaDeDescuento(null, null, null, new Date(), 'UTC') }
  const [fila, venue] = await Promise.all([
    foto.discountId ? prisma.discount.findFirst({ where: { id: foto.discountId, venueId }, select: DISCOUNT_RULE_SELECT }) : null,
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
  ])
  const regla = foto.discountId ? (fila ? reglaDeFila(fila) : MISSING_RULE) : null
  const base =
    paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0
      ? computeBundleTotal(paymentLink.items)
      : paymentLink.amount != null
        ? Number(paymentLink.amount)
        : null
  return { ...paymentLink, ...vistaDeDescuento(foto, regla, base, new Date(), venue?.timezone ?? 'America/Mexico_City') }
}

/**
 * Updates a payment link
 */
export async function updatePaymentLink(
  venueId: string,
  linkId: string,
  data: UpdatePaymentLinkData,
  staffId?: string,
  // El MCP audita con su propio sello en lugar del registro nativo (mismo patrón que createPaymentLink).
  auditCustomerAdded?: () => Promise<void>,
) {
  const addsCustomer = Object.prototype.hasOwnProperty.call(data, 'customerId')
  if (addsCustomer && !data.customerId) throw new BadRequestError('El cliente de una liga no se puede quitar')
  const existing = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      venueId: true,
      status: true,
      customerId: true,
      purpose: true,
      amountType: true,
      amount: true,
      isReusable: true,
      discount: true,
    },
  })

  if (!existing) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (existing.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  if (existing.status === 'ARCHIVED') {
    throw new BadRequestError('No se puede editar una liga de pago archivada')
  }

  // Agregar cliente: sólo a una liga que no tiene. El mismo cliente otra vez no hace nada (reintento).
  // Sólo cuenta para los pagos que empiecen después: cada sesión copia el cliente al abrirse.
  const customerToAdd = addsCustomer && existing.customerId !== data.customerId ? data.customerId! : null
  if (addsCustomer) {
    if (existing.customerId && existing.customerId !== data.customerId) {
      throw new ConflictError('Esta liga ya tiene un cliente y no se puede cambiar')
    }
    const customer = await prisma.customer.findFirst({ where: { id: data.customerId, venueId, active: true }, select: { id: true } })
    if (!customer) throw new BadRequestError('El cliente no existe, está inactivo o no pertenece a este negocio')
  }
  // Sólo el cliente y ya era ése (reintento): nada que escribir ni que auditar (Codex r1 #1).
  const onlyCustomer = addsCustomer && Object.keys(data).every(key => key === 'customerId')
  if (onlyCustomer && !customerToAdd) return getPaymentLinkById(venueId, linkId)

  const updateData: Prisma.PaymentLinkUncheckedUpdateInput = {}

  if (data.title !== undefined) updateData.title = data.title
  if (data.description !== undefined) updateData.description = data.description
  if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl
  if (data.amountType !== undefined) updateData.amountType = data.amountType
  if (data.amount !== undefined) {
    updateData.amount = data.amount !== null ? new Prisma.Decimal(data.amount) : null
  }
  if (data.currency !== undefined) updateData.currency = data.currency
  if (data.isReusable !== undefined) updateData.isReusable = data.isReusable
  if (data.expiresAt !== undefined) {
    updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null
  }
  if (data.redirectUrl !== undefined) updateData.redirectUrl = data.redirectUrl
  if (data.status !== undefined) updateData.status = data.status

  // Items: replace the full set when provided. Pass [] / null to clear.
  // Same validator the create path uses — keeps semantics in sync.
  // `null` means "no change", `[]` means "clear all items".
  let itemReplacement: Awaited<ReturnType<typeof validateBundleItems>> | null = null
  if (data.items !== undefined) {
    const rawItems = data.items ?? []
    if (rawItems.length === 0) {
      itemReplacement = []
    } else {
      itemReplacement = await validateBundleItems(venueId, rawItems)
    }
  }
  if (data.customFields !== undefined) {
    updateData.customFields = data.customFields === null ? Prisma.JsonNull : (data.customFields as unknown as Prisma.InputJsonValue)
  }
  if (data.tippingConfig !== undefined) {
    updateData.tippingConfig = data.tippingConfig === null ? Prisma.JsonNull : (data.tippingConfig as unknown as Prisma.InputJsonValue)
  }

  // Descuento: se vuelve a validar al cambiarlo y también si cambia lo que lo sostiene (importe o productos).
  const effectiveAmountType = data.amountType ?? existing.amountType
  const effectiveAmount = data.amount !== undefined ? data.amount : existing.amount != null ? Number(existing.amount) : null
  const touchesBase = data.amount !== undefined || data.amountType !== undefined || data.items !== undefined
  rechazarDescuentoEnDonacion(existing.purpose, data.discount)
  if (data.discount !== undefined || touchesBase) {
    const keptFoto = data.discount === undefined ? ((existing.discount as unknown as DescuentoDeLiga | null) ?? null) : null
    if (data.discount !== undefined || keptFoto) {
      let base: number | null
      if (existing.purpose === 'ITEM') {
        const items =
          itemReplacement !== null
            ? itemReplacement
            : (
                await prisma.paymentLinkItem.findMany({
                  where: { paymentLinkId: linkId },
                  take: 20, // tope del esquema: máximo 20 productos por liga
                  select: { productId: true, quantity: true, modifiers: { select: { modifierId: true, quantity: true } } },
                })
              ).map(i => ({ productId: i.productId, quantity: i.quantity, modifiers: i.modifiers }))
        base = items.length > 0 ? await totalDeItemsResueltos(venueId, items) : null
      } else {
        base = effectiveAmountType === 'FIXED' && effectiveAmount != null ? effectiveAmount : null
      }
      if (data.discount === undefined) {
        await validarFotoContraBase(prisma, venueId, keptFoto!, base, true)
      } else if (data.discount === null) {
        updateData.discount = Prisma.JsonNull
        updateData.discountId = null
      } else {
        const { foto, discountId } = await resolverDescuentoDeEntrada(prisma, venueId, data.discount, {
          isReusable: data.isReusable ?? existing.isReusable,
          base,
        })
        updateData.discount = foto as unknown as Prisma.InputJsonValue
        updateData.discountId = discountId
      }
    }
  }

  // Wrap the metadata update + items replacement in a transaction so the
  // rows are atomic — partial state would confuse the customer checkout.
  // Nested modifier rows can't be inserted via createMany (Prisma limitation),
  // so we loop and use create() per item which accepts the nested write.
  let customerAdded = false
  const updated = await prisma
    .$transaction(async tx => {
      if (customerToAdd) {
        // CAS: sólo donde sigue vacío. Si otro guardado ganó, gana él (o era el mismo cliente).
        // Tampoco a una liga que archivaron entre la lectura y aquí (Codex r1 #2).
        const { count } = await tx.paymentLink.updateMany({
          where: { id: linkId, venueId, customerId: null, status: { not: 'ARCHIVED' } },
          data: { customerId: customerToAdd },
        })
        if (count === 0) {
          const now = await tx.paymentLink.findUnique({ where: { id: linkId }, select: { customerId: true, status: true } })
          if (now?.status === 'ARCHIVED') throw new BadRequestError('No se puede editar una liga de pago archivada')
          if (now?.customerId !== customerToAdd) throw new ConflictError('Esta liga ya tiene un cliente y no se puede cambiar')
        }
        customerAdded = count === 1 // sólo quien escribió deja rastro; el reintento que llegó segundo, no
      }
      if (itemReplacement !== null) {
        // Cascade deletes the modifier rows because PaymentLinkItemModifier
        // has onDelete: Cascade on paymentLinkItemId.
        await tx.paymentLinkItem.deleteMany({ where: { paymentLinkId: linkId } })
        for (const it of itemReplacement) {
          await tx.paymentLinkItem.create({
            data: {
              paymentLinkId: linkId,
              productId: it.productId,
              quantity: it.quantity,
              position: it.position,
              modifiers: it.modifiers.length > 0 ? { create: it.modifiers } : undefined,
            },
          })
        }
      }
      return tx.paymentLink.update({
        where: { id: linkId },
        data: updateData,
        include: {
          customer: { select: CUSTOMER_SUMMARY_SELECT },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { checkoutSessions: true } },
        },
      })
    })
    .catch(rethrowMenuChangedWhileSaving)

  logger.info('Payment link updated', { paymentLinkId: linkId, venueId })

  if (!onlyCustomer) {
    // Bitácora: el descuento puesto, cambiado o quitado (precio de una liga ya compartida), con antes/después.
    const before = resumenDeDescuento(existing.discount)
    const after =
      data.discount === undefined ? before : resumenDeDescuento(updateData.discount === Prisma.JsonNull ? null : updateData.discount)
    const discountChange =
      data.discount === undefined || (!before && !after)
        ? null
        : { change: !before ? 'SET' : !after ? 'REMOVED' : 'CHANGED', before, after }
    logAction({
      venueId,
      staffId,
      action: 'PAYMENT_LINK_UPDATED',
      entity: 'PaymentLink',
      entityId: linkId,
      data: discountChange ? { discount: discountChange } : undefined,
    })
  }
  if (customerAdded && auditCustomerAdded) {
    await auditCustomerAdded()
  } else if (customerAdded) {
    logAction({
      venueId,
      staffId,
      action: 'PAYMENT_LINK_CUSTOMER_ADDED',
      entity: 'PaymentLink',
      entityId: linkId,
      data: { customerId: customerToAdd! },
    })
  }

  return updated
}

/**
 * ¿Este PUT cambia la base (importe y tipo; en ITEM, los productos) de una liga que ya trae descuento?
 * Si sí, la ruta pide también `discounts:apply`: cambiar la base aplica ese descuento a otro precio.
 * Compara contra lo guardado porque el panel reenvía importe y productos en cada edición.
 */
export async function cambiaBaseDeLigaConDescuento(venueId: string, linkId: string, body: UpdatePaymentLinkData): Promise<boolean> {
  if (body.discount !== undefined) return false // poner/cambiar ya pide discounts:apply; null lo quita
  if (body.amount === undefined && body.amountType === undefined && body.items === undefined) return false
  const link = await prisma.paymentLink.findFirst({
    where: { id: linkId, venueId },
    select: {
      purpose: true,
      amountType: true,
      amount: true,
      discount: true,
      items: {
        take: 20, // tope del esquema
        select: { productId: true, quantity: true, modifiers: { take: 20, select: { modifierId: true, quantity: true } } },
      },
    },
  })
  if (!link?.discount) return false
  if (link.purpose === 'ITEM') {
    if (body.items === undefined) return false
    const firma = (items: Array<{ productId: string; quantity: number; modifiers?: Array<{ modifierId: string; quantity?: number }> }>) =>
      JSON.stringify(
        items
          .map(i => [i.productId, i.quantity, (i.modifiers ?? []).map(m => `${m.modifierId}x${m.quantity ?? 1}`).sort()] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      )
    return firma(body.items ?? []) !== firma(link.items)
  }
  if (body.amountType !== undefined && body.amountType !== link.amountType) return true
  if (body.amount === undefined) return false
  if (body.amount === null || link.amount === null) return body.amount !== link.amount
  return !new Prisma.Decimal(body.amount).eq(link.amount)
}

/**
 * Archives a payment link (soft delete)
 */
export async function archivePaymentLink(venueId: string, linkId: string) {
  const existing = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    select: { id: true, venueId: true },
  })

  if (!existing) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  if (existing.venueId !== venueId) {
    throw new UnauthorizedError('No tienes acceso a esta liga de pago')
  }

  await prisma.paymentLink.update({
    where: { id: linkId },
    data: { status: 'ARCHIVED' },
  })

  logger.info('Payment link archived', { paymentLinkId: linkId, venueId })

  logAction({
    venueId,
    action: 'PAYMENT_LINK_ARCHIVED',
    entity: 'PaymentLink',
    entityId: linkId,
  })

  return { success: true }
}

// ═══════════════════════════════════════════════════════════════════════════
// BRANDING (PUBLIC CHECKOUT APPEARANCE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default branding applied when a venue has never customised it. Mirrored
 * in the frontend (PaymentLinkBranding.tsx) — keep both copies in sync.
 */
export const DEFAULT_PAYMENT_LINK_BRANDING = {
  showLogo: true,
  buttonColor: '#006aff',
  buttonShape: 'rounded' as 'rounded' | 'square' | 'pill',
  /** CSS font-family applied to the public checkout. Whitelist enforced
   *  by the Zod schema (`PAYMENT_LINK_FONT_IDS`). Default matches the
   *  legacy DM Sans the customer-facing app shipped with. */
  fontFamily: 'DM Sans',
  showImage: true,
  showTitle: true,
  showPrice: true,
}

export type PaymentLinkBranding = typeof DEFAULT_PAYMENT_LINK_BRANDING

/**
 * Merge stored branding with the defaults. Used by both the dashboard
 * (preview) and the public checkout reader so missing keys never leak
 * through as `undefined` to the UI.
 */
/**
 * Brand-accent fallback for the checkout button. When a venue never set an
 * explicit `buttonColor`, the public checkout inherits the venue's brand
 * accent (`Venue.primaryColor` — the same field the booking widget consumes
 * as `--avq-accent`) so payment links and appointments/classes share one
 * color. Only honored when it looks like a CSS color; otherwise the legacy
 * blue default. Resolved at READ time and NEVER persisted, so changing the
 * venue's primaryColor keeps propagating (live inheritance).
 */
function resolveBrandFallbackColor(primaryColor?: string | null): string {
  const trimmed = typeof primaryColor === 'string' ? primaryColor.trim() : ''
  return /^(#[0-9a-fA-F]{3,8}|rgb|hsl|oklch|color\()/.test(trimmed) ? trimmed : DEFAULT_PAYMENT_LINK_BRANDING.buttonColor
}

function mergeBranding(raw: unknown, primaryColor?: string | null): PaymentLinkBranding {
  const buttonFallback = resolveBrandFallbackColor(primaryColor)
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_PAYMENT_LINK_BRANDING, buttonColor: buttonFallback }
  }
  const stored = raw as Partial<PaymentLinkBranding>
  return {
    showLogo: stored.showLogo ?? DEFAULT_PAYMENT_LINK_BRANDING.showLogo,
    buttonColor: stored.buttonColor ?? buttonFallback,
    buttonShape: stored.buttonShape ?? DEFAULT_PAYMENT_LINK_BRANDING.buttonShape,
    fontFamily: stored.fontFamily ?? DEFAULT_PAYMENT_LINK_BRANDING.fontFamily,
    showImage: stored.showImage ?? DEFAULT_PAYMENT_LINK_BRANDING.showImage,
    showTitle: stored.showTitle ?? DEFAULT_PAYMENT_LINK_BRANDING.showTitle,
    showPrice: stored.showPrice ?? DEFAULT_PAYMENT_LINK_BRANDING.showPrice,
  }
}

export async function getPaymentLinkBranding(venueId: string): Promise<PaymentLinkBranding> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { paymentLinkBranding: true, primaryColor: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')
  return mergeBranding(venue.paymentLinkBranding, venue.primaryColor)
}

export async function updatePaymentLinkBranding(
  venueId: string,
  data: Partial<PaymentLinkBranding>,
  staffId: string,
): Promise<PaymentLinkBranding> {
  // Read-modify-write so the caller can send only the fields they want to
  // change. The frontend currently sends the full object, but the merge
  // pattern keeps the API forgiving and lets us add new fields without
  // breaking older clients.
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { paymentLinkBranding: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const current = mergeBranding(venue.paymentLinkBranding)
  const next: PaymentLinkBranding = {
    showLogo: data.showLogo ?? current.showLogo,
    buttonColor: data.buttonColor ?? current.buttonColor,
    buttonShape: data.buttonShape ?? current.buttonShape,
    fontFamily: data.fontFamily ?? current.fontFamily,
    showImage: data.showImage ?? current.showImage,
    showTitle: data.showTitle ?? current.showTitle,
    showPrice: data.showPrice ?? current.showPrice,
  }

  await prisma.venue.update({
    where: { id: venueId },
    data: { paymentLinkBranding: next as unknown as Prisma.InputJsonValue },
  })

  logAction({
    venueId,
    staffId,
    action: 'PAYMENT_LINK_BRANDING_UPDATED',
    entity: 'Venue',
    entityId: venueId,
    data: { from: current, to: next },
  })

  return next
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC (CHECKOUT FLOW)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolves a payment link by short code (public, no auth)
 * Returns venue branding + link data for the checkout page
 */
type PublicDiscount = {
  name: string
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  minPurchaseAmount: number | null
  maxDiscountAmount: number | null
  amount: number | null
  available: boolean
  reason: MotivoNoDisponible | null
  validUntil: string | null
}

export async function getPaymentLinkByShortCode(shortCode: string) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          primaryColor: true,
          secondaryColor: true,
          // Per-venue payment-link branding (button color/shape + toggle
          // visibility of logo/image/title/price). Public checkout reads this
          // to skin its Pay button and hide fields per the admin's choices.
          paymentLinkBranding: true,
          // WhatsApp del negocio (la página lo ofrece si el descuento ya no está disponible) y su zona para evaluar horarios.
          phone: true,
          timezone: true,
        },
      },
      ...BUNDLE_ITEMS_INCLUDE,
      // Include the merchant's provider so the public checkout knows whether
      // to render an inline card form (Blumon-style tokenization) or redirect
      // the customer to Stripe-hosted checkout.
      ecommerceMerchant: {
        select: {
          provider: { select: { code: true } },
        },
      },
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }

  // Check if link is active
  if (paymentLink.status !== 'ACTIVE') {
    throw new BadRequestError(paymentLink.status === 'EXPIRED' ? 'Esta liga de pago ha expirado' : 'Esta liga de pago no está disponible')
  }

  // Check if link has expired
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    // Auto-expire the link
    await prisma.paymentLink.update({
      where: { id: paymentLink.id },
      data: { status: 'EXPIRED' },
    })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }

  // Check if single-use link has already been paid
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }

  // `paymentMethod` tells the public checkout which UX to render:
  //  - 'STRIPE_HOSTED': Stripe Elements inline (option name kept for backward
  //    compat — historically meant "hosted by Stripe", now means "iframe-tokenized
  //    inline by Stripe"). Application fee handled by Stripe at settlement.
  //  - 'MERCADO_PAGO_BRICKS': MP Bricks inline (analog of Stripe Elements but
  //    via @mercadopago/sdk-react). Application_fee passed at /v1/payments.
  //  - 'INLINE_CARD': legacy Blumon flow — Avoqado tokenizes the card inline
  //    and authorizes the charge directly.
  let paymentMethod: 'STRIPE_HOSTED' | 'MERCADO_PAGO_BRICKS' | 'INLINE_CARD' = 'INLINE_CARD'
  if (paymentLink.ecommerceMerchant.provider?.code === 'STRIPE_CONNECT') {
    paymentMethod = 'STRIPE_HOSTED'
  } else if (paymentLink.ecommerceMerchant.provider?.code === 'MERCADO_PAGO') {
    paymentMethod = 'MERCADO_PAGO_BRICKS'
  }

  // Base viva: la MISMA que cobra `cobroDeLiga` (paquete = precios de hoy; fija = amount; abierta = sin base).
  const baseAmount =
    paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0
      ? computeBundleTotal(paymentLink.items)
      : paymentLink.amountType === 'FIXED' && paymentLink.amount != null
        ? Number(paymentLink.amount)
        : null
  const foto = (paymentLink.discount as unknown as DescuentoDeLiga | null) ?? null
  let discount: PublicDiscount | null = null
  if (foto) {
    const regla = await cargarRegla(prisma, foto)
    const d = desgloseDeLiga(baseAmount ?? BASE_LIGA_ABIERTA, foto, regla, new Date(), paymentLink.venue.timezone || 'America/Mexico_City')
    discount = {
      name: foto.name,
      type: foto.type,
      value: foto.value,
      minPurchaseAmount: regla?.minPurchaseAmount ?? null,
      maxDiscountAmount: regla?.maxDiscountAmount ?? null,
      amount: baseAmount !== null && d.aplica ? d.descuento : null,
      available: d.aplica,
      reason: d.motivo,
      validUntil: regla?.validUntil ? regla.validUntil.toISOString() : null,
    }
  }

  return {
    id: paymentLink.id,
    shortCode: paymentLink.shortCode,
    purpose: paymentLink.purpose,
    title: paymentLink.title,
    description: paymentLink.description,
    imageUrl: paymentLink.imageUrl,
    amountType: paymentLink.amountType,
    amount: paymentLink.amount,
    currency: paymentLink.currency,
    venue: {
      id: paymentLink.venue.id,
      name: paymentLink.venue.name,
      slug: paymentLink.venue.slug,
      logo: paymentLink.venue.logo,
      primaryColor: paymentLink.venue.primaryColor,
      secondaryColor: paymentLink.venue.secondaryColor,
      // Sólo con descuento: la página lo ofrece cuando el descuento ya no está; sin él, el teléfono no se hace público.
      whatsappPhone: foto ? paymentLink.venue.phone?.trim() || null : null,
    },
    discount,
    baseAmount,
    // Branding overrides for this checkout. Always merged with defaults so
    // the customer-facing page never has to handle null/undefined fields.
    branding: mergeBranding(paymentLink.venue.paymentLinkBranding, paymentLink.venue.primaryColor),
    // Line items for ITEM-purpose links. Empty array for PAYMENT/DONATION.
    // Each line includes its pre-selected modifiers so the customer-facing
    // checkout page can render the full configuration. Total =
    // sum(qty × (product.price + Σ modifier.price × modifier.quantity)).
    items: paymentLink.items.map(it => ({
      id: it.id,
      quantity: it.quantity,
      product: it.product,
      modifiers: it.modifiers.map(mm => ({
        id: mm.id,
        quantity: mm.quantity,
        modifier: mm.modifier,
      })),
    })),
    customFields: paymentLink.customFields,
    tippingConfig: paymentLink.tippingConfig,
    redirectUrl: paymentLink.redirectUrl,
    paymentMethod,
  }
}

/**
 * Stripe Elements (inline) flow for payment links — Option D.
 *
 * Unlike `createStripeCheckoutForPaymentLink` (which redirects the customer
 * to Stripe-hosted Checkout), this creates a `PaymentIntent` on the
 * connected account and returns the `client_secret` so the public checkout
 * page can render Stripe Elements INLINE — customer never leaves
 * `pay.avoqado.io`. Avoqado branding, tipping, custom fields, product info
 * all preserved. Stripe handles card collection + 3DS in iframes (PCI-SAQ-A
 * compliant — card data never touches our servers).
 *
 * Webhook event `payment_intent.succeeded` finalizes the payment via
 * `finalizePaymentLinkCheckout` (same as the Checkout Session flow).
 *
 * Returns:
 *   - clientSecret: pass to Stripe.js confirmPayment()
 *   - publishableKey: pass to <Elements> stripe prop
 *   - paymentIntentId: persisted as CheckoutSession.sessionId
 *   - amount, currency, applicationFeeCents — for UI display
 */
export async function createStripePaymentIntentForPaymentLink(
  shortCode: string,
  input: {
    amount?: number
    quantity?: number
    tipAmount?: number
    /** Total (neto + propina) que mostró la página; distinto → 409 sin cobrar. Ausente = no se compara. */
    expectedTotal?: number
    customerEmail?: string
    customFieldResponses?: Record<string, string>
  },
) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      ecommerceMerchant: {
        include: { provider: { select: { code: true } } },
      },
      ...BUNDLE_ITEMS_INCLUDE,
    },
  })

  if (!paymentLink) throw new NotFoundError('Liga de pago no encontrada')
  await assertVenueSalesEnabled(paymentLink.venueId)
  if (paymentLink.status !== 'ACTIVE') throw new BadRequestError('Esta liga de pago no está disponible')
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    await prisma.paymentLink.update({ where: { id: paymentLink.id }, data: { status: 'EXPIRED' } })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }
  if (paymentLink.ecommerceMerchant.provider?.code !== 'STRIPE_CONNECT') {
    throw new BadRequestError('Esta liga de pago no está configurada para Stripe Connect')
  }
  if (!paymentLink.ecommerceMerchant.chargesEnabled) {
    throw new BadRequestError('La cuenta de Stripe del comercio aún no está activa')
  }

  const connectAccountId = (paymentLink.ecommerceMerchant.providerCredentials as { connectAccountId?: string })?.connectAccountId
  if (!connectAccountId) {
    throw new BadRequestError('La cuenta Stripe Connect del comercio no está configurada')
  }

  // 1. Lo que se cobra (base − descuento + propina) y el 409 si la página mostró otro total. `input.quantity` se ignora.
  const bounds = getStripeChargeBounds()
  const cobro = await cobroDeLiga(paymentLink, input, new Date(), bounds.min / 100)
  const tipAmount = cobro.propina
  const chargeAmount = cobro.total

  // 2. Validate custom fields
  const customFields = paymentLink.customFields as CustomFieldDefinition[] | null
  if (customFields && customFields.length > 0) {
    for (const field of customFields) {
      if (field.required) {
        const response = input.customFieldResponses?.[field.id]
        if (!response || response.trim() === '') {
          throw new BadRequestError(`El campo "${field.label}" es requerido`)
        }
      }
      if (field.type === 'SELECT' && field.options && input.customFieldResponses?.[field.id]) {
        if (!field.options.includes(input.customFieldResponses[field.id])) {
          throw new BadRequestError(`Opción inválida para el campo "${field.label}"`)
        }
      }
    }
  }

  // 4. Stripe amount + fee
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  if (stripeAmount < bounds.min) throw new BadRequestError('El monto es menor al mínimo permitido por Stripe')
  if (stripeAmount > bounds.max) throw new BadRequestError('El monto excede el máximo permitido por transacción')

  const vatRateBps = await getVatRateBps()
  const applicationFeeAmount = calculateApplicationFeeWithVAT(stripeAmount, paymentLink.ecommerceMerchant.platformFeeBps, vatRateBps)

  // 5. Build metadata. PaymentIntent metadata has a 50-key, 500-char/value
  // limit per Stripe — keep keys lean. customFieldResponses is JSON-encoded
  // into a single key to stay under the limit; the webhook handler decodes.
  const metadata: Record<string, string> = {
    type: 'payment_link',
    paymentLinkId: paymentLink.id,
    shortCode: paymentLink.shortCode,
    venueId: paymentLink.venueId,
    ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
    flow: 'stripe_elements',
  }
  if (tipAmount > 0) metadata.tipAmount = String(tipAmount)
  if (paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0) {
    metadata.purpose = 'ITEM'
    metadata.itemCount = String(paymentLink.items.length)
    // Stripe metadata values cap at 500 chars. The CheckoutSession.metadata
    // column has no such limit and carries the FULL snapshot (incl. modifier
    // names + prices) — Stripe metadata is just a debugging/observability hint.
    metadata.items = JSON.stringify(buildBundleSnapshot(paymentLink.items)).slice(0, 500)
  }
  if (input.customFieldResponses) {
    metadata.customFieldResponses = JSON.stringify(input.customFieldResponses).slice(0, 500)
  }

  // 6. Create PaymentIntent on the connected account. `transfer_data`-style
  // routing isn't needed here because we're calling with `stripeAccount`
  // header — funds settle on the connected account and Stripe automatically
  // routes the application_fee back to the platform.
  // Cast the API version through `any` — Stripe's typed `LatestApiVersion`
  // union doesn't include preview/clover versions, but the runtime accepts
  // any string. The single-source-of-truth for the version is the provider.
  const Stripe = (await import('stripe')).default
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-02-25.clover' as any })

  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: stripeAmount,
      currency: paymentLink.currency.toLowerCase(),
      application_fee_amount: applicationFeeAmount,
      // `automatic_payment_methods` lets Stripe surface every method the
      // connected account has activated (cards, OXXO, SPEI, Apple Pay…)
      // without us hardcoding the list.
      automatic_payment_methods: { enabled: true },
      receipt_email: input.customerEmail,
      description: paymentLink.title,
      statement_descriptor_suffix: 'AVOQADO',
      metadata,
    },
    {
      stripeAccount: connectAccountId,
      idempotencyKey: `paymentLink:${paymentLink.id}:pi:${nanoid(10)}`,
    },
  )

  // 7. Persist CheckoutSession keyed by PaymentIntent id. Webhook updates
  // status=COMPLETED when Stripe notifies us via payment_intent.succeeded.
  await prisma.checkoutSession.create({
    data: {
      sessionId: paymentIntent.id,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      paymentLinkId: paymentLink.id,
      attributedCustomerId: paymentLink.customerId ?? null,
      amount: new Prisma.Decimal(chargeAmount),
      currency: paymentLink.currency,
      description: paymentLink.title,
      customerEmail: input.customerEmail,
      applicationFeeCents: applicationFeeAmount,
      metadata: {
        applicationFeeCents: applicationFeeAmount,
        platformFeeBps: paymentLink.ecommerceMerchant.platformFeeBps,
        vatRateBps,
        provider: 'STRIPE_CONNECT',
        flow: 'stripe_elements',
        ...(tipAmount > 0 && { tipAmount }),
        // La orden lee el descuento de aquí (no de la liga, que pudo cambiar después).
        ...(cobro.fotoParaSesion && { descuento: cobro.fotoParaSesion }),
        ...(input.customFieldResponses && { customFieldResponses: input.customFieldResponses }),
        // Persist the full line-item snapshot (incl. modifiers) on the
        // CheckoutSession so the webhook handler can replay OrderItem +
        // OrderItemModifier creation without re-reading the link (which may
        // have been edited between purchase and webhook arrival).
        ...(paymentLink.purpose === 'ITEM' &&
          paymentLink.items.length > 0 && {
            purpose: 'ITEM',
            items: buildBundleSnapshot(paymentLink.items),
          }),
      } as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      // PaymentIntents don't have a hard expiry, but we still need a value
      // for the column. Use 24h to match the Checkout Session default — if
      // the customer doesn't confirm by then, the row is effectively stale.
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  })

  logger.info('Stripe PaymentIntent created for payment link (Elements flow)', {
    paymentIntentId: paymentIntent.id,
    paymentLinkId: paymentLink.id,
    shortCode,
    amountCents: stripeAmount,
    applicationFeeCents: applicationFeeAmount,
  })

  // Fail loudly if the deploy is missing the publishable key — without it
  // Stripe.js initialises with `undefined` on the client and throws
  // "Expected publishable key to be of type string, got type undefined",
  // which gives the customer a broken checkout with no actionable error.
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    logger.error('STRIPE_PUBLISHABLE_KEY env var is not set — payment-link checkout cannot render Stripe Elements', {
      shortCode,
      env: process.env.NODE_ENV,
    })
    throw new BadRequestError('El procesador de pagos está mal configurado (falta clave publicable). Contacta a soporte de Avoqado.')
  }

  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    publishableKey,
    // We expose connectAccountId because Stripe.js needs `stripeAccount` set
    // when initializing for connected accounts (so direct-charge PaymentIntents
    // resolve correctly).
    connectAccountId,
    amount: chargeAmount,
    currency: paymentLink.currency,
    applicationFeeCents: applicationFeeAmount,
  }
}

/**
 * Webhook callback: Stripe notified that a payment-link checkout session
 * completed. Updates our local session to PAID, bumps counters on the
 * payment link, creates an Order for ITEM-purpose links, and triggers
 * inventory deduction. Mirrors what `completeCharge` does for Blumon, but
 * driven by the webhook event payload instead of an interactive request.
 *
 * Idempotent: if the session is already PAID we return without re-processing.
 * The webhook service also guards against duplicate Stripe event deliveries
 * via `processedStripeEvent` unique constraint.
 */
/**
 * Map Stripe `payment_method.type` to our `PaymentMethod` enum.
 *
 * Stripe's enum is much richer than ours (40+ values), so we collapse into
 * the closest semantic match. Default fallback is CREDIT_CARD because card
 * is the dominant method and lets the row still appear in card-based
 * reports if something exotic comes through. Add new mappings as we enable
 * more Stripe payment methods.
 */
/**
 * Fase 2 de la unificación de caja: TODO pago que entra por Stripe lo liquida Stripe → Avoqado,
 * sin importar cómo lo pagó el cliente. El efectivo de OXXO lo cobró OXXO al cliente: NUNCA entró al
 * cajón del negocio. Sin este sello, el fallback legacy (`method === 'CASH'`) lo contaba como efectivo
 * físico y el arqueo le exigía al cajero un dinero que jamás tuvo en la mano (auditoría 27-ago §2.2).
 */
export function fundsFlowForStripePayment(_stripeType: string | null | undefined): 'AVOQADO_PROCESSED' {
  return 'AVOQADO_PROCESSED'
}

/**
 * Método y forma SAT de un cobro de Stripe, para los DOS escritores (liga de pago y checkout del negocio). OXXO va como OTHER
 * con forma SAT 01 sellada, igual que OXXO de Mercado Pago (`metodoDeMercadoPago`): como CASH, la conciliación, el saldo, la
 * póliza y el corte —que deciden por `method === 'CASH'` e ignoran `fundsFlow`— lo trataban como efectivo del cajón.
 *
 * ponytail: sin tipo se asume tarjeta. Si la consulta del cargo falló por algo PASAJERO, el finalizador ya no llega aquí: lanza y
 * Stripe reintenta (`debeReintentarSinTipo`). Queda el techo con un error permanente de Stripe (llave, permiso) o sin
 * `connectAccountId`: el cajón queda bien, pero un OXXO así sale con SAT 04 (founder «A», 19-oct: no atorar el cobro por eso).
 */
export function metodoDeStripe(stripeType: string | null | undefined): { method: PaymentMethod; tenderSatFormaPago: string | null } {
  if (stripeType === 'oxxo') return { method: 'OTHER', tenderSatFormaPago: '01' }
  return { method: mapStripeMethodToPaymentMethod(stripeType), tenderSatFormaPago: null }
}

/**
 * ¿El finalizador debe lanzar porque la consulta del cargo falló? Sólo si el aviso no trajo el tipo (el cargo es lo único que
 * dice si fue OXXO) y el error es pasajero (red, 5xx, límite de peticiones): el webhook libera su reclamo (`withClaimedEvent`) y
 * Stripe reintenta. Con un error permanente lanzar atoraría el cobro 3 días y luego se perdería (no hay barrido).
 */
export function debeReintentarSinTipo(stripeType: string | null | undefined, err: unknown): boolean {
  const type = (err as { type?: string } | null)?.type
  return !stripeType && (type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError')
}

export function mapStripeMethodToPaymentMethod(
  stripeType: string | null | undefined,
): 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET' | 'BANK_TRANSFER' | 'CRYPTOCURRENCY' | 'OTHER' {
  if (!stripeType) return 'CREDIT_CARD'
  // OXXO NO es CASH (ese efectivo nunca entró al cajón): cae a OTHER abajo; su forma SAT la sella `metodoDeStripe`.
  // Bank transfers: SPEI/CoDi (MX), ACH (US), SEPA (EU). All bank rails.
  if (stripeType === 'customer_balance' || stripeType === 'sepa_debit' || stripeType === 'us_bank_account') {
    return 'BANK_TRANSFER'
  }
  // Wallets: Apple Pay, Google Pay, Link, etc. They tokenize a card behind
  // the scenes but the customer-perceived method is the wallet.
  if (stripeType === 'apple_pay' || stripeType === 'google_pay' || stripeType === 'link') return 'DIGITAL_WALLET'
  // Cards: the default for `card`, `card_present`, plus most country-card variants.
  if (stripeType === 'card' || stripeType.startsWith('card_')) return 'CREDIT_CARD'
  // Crypto isn't on Stripe Connect today but covered for completeness.
  return 'OTHER'
}

/** Translate Stripe's lowercase brand strings into our CardBrand enum.
 *  Stripe values: 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' |
 *  'jcb' | 'unionpay' | 'unknown'. Anything we can't map → OTHER so reports
 *  stay grouped instead of falling to NULL. */
export function mapStripeCardBrandToEnum(
  brand: string | null | undefined,
):
  | 'VISA'
  | 'MASTERCARD'
  | 'AMERICAN_EXPRESS'
  | 'DISCOVER'
  | 'DINERS_CLUB'
  | 'JCB'
  | 'MAESTRO'
  | 'UNIONPAY'
  | 'ELO'
  | 'HIPERCARD'
  | 'OTHER'
  | undefined {
  if (!brand) return undefined
  switch (brand) {
    case 'visa':
      return 'VISA'
    case 'mastercard':
      return 'MASTERCARD'
    case 'amex':
      return 'AMERICAN_EXPRESS'
    case 'discover':
      return 'DISCOVER'
    case 'diners':
      return 'DINERS_CLUB'
    case 'jcb':
      return 'JCB'
    case 'unionpay':
      return 'UNIONPAY'
    default:
      return 'OTHER'
  }
}

/** Blumon returns uppercase brand strings (VISA, MASTERCARD, AMEX). Map to
 *  our enum, falling back to OTHER for anything unexpected. */
function mapBlumonCardBrandToEnum(
  brand: unknown,
):
  | 'VISA'
  | 'MASTERCARD'
  | 'AMERICAN_EXPRESS'
  | 'DISCOVER'
  | 'DINERS_CLUB'
  | 'JCB'
  | 'MAESTRO'
  | 'UNIONPAY'
  | 'ELO'
  | 'HIPERCARD'
  | 'OTHER'
  | undefined {
  if (typeof brand !== 'string' || !brand) return undefined
  const up = brand.toUpperCase()
  if (up === 'VISA') return 'VISA'
  if (up === 'MASTERCARD' || up === 'MASTER') return 'MASTERCARD'
  if (up === 'AMEX' || up === 'AMERICAN_EXPRESS' || up === 'AMERICAN EXPRESS') return 'AMERICAN_EXPRESS'
  if (up === 'DISCOVER') return 'DISCOVER'
  if (up === 'DINERS' || up === 'DINERS_CLUB') return 'DINERS_CLUB'
  if (up === 'JCB') return 'JCB'
  if (up === 'MAESTRO') return 'MAESTRO'
  if (up === 'UNIONPAY' || up === 'UNION_PAY') return 'UNIONPAY'
  if (up === 'ELO') return 'ELO'
  if (up === 'HIPERCARD') return 'HIPERCARD'
  return 'OTHER'
}

// ==========================================
// LEALTAD Y MÉTRICAS DEL CLIENTE (canal: ligas de pago)
// ==========================================
//
// El TPV (`payment.tpv.service.ts`) y el pago manual (`manualPayment.service.ts`)
// ya acreditaban puntos y movían visitas/gasto al cerrar una venta con cliente.
// Las ligas de pago disparaban comisión y NUNCA tocaban al cliente: quien pagaba
// por link se quedaba sin sus puntos y sin su visita. Estos dos helpers cierran
// ese hueco REUSANDO los mismos dos servicios — aquí no se calcula ni un punto.

/** Lo que la sesión de pago congeló del descuento (T5). La orden se arma con esto, nunca releyendo la liga ni el catálogo. */
type DescuentoDeLaSesion = { foto: DescuentoDeLiga; descuento: number; base: number }

/**
 * `null` si la sesión se cobró sin descuento: la orden queda exactamente como hoy. También `null` (con un error en el log) si
 * el descuento guardado no cuadra con lo cobrado sin propina o viene mal formado: el banco ya cobró, así que nunca se lanza
 * dentro del registro (en Blumon perdería una venta cobrada) y lo guardado es lo que se cobró.
 */
function descuentoDeLaSesion(
  metadata: Record<string, any> | null | undefined,
  cobradoSinPropina: Prisma.Decimal,
  sessionId: string,
): DescuentoDeLaSesion | null {
  const d = metadata?.descuento
  if (d == null) return null
  const base = Number(d.base)
  const descuento = Number(d.descuento)
  const foto = d.foto
  const fotoValida =
    !!foto &&
    (foto.type === 'PERCENTAGE' || foto.type === 'FIXED_AMOUNT') &&
    typeof foto.name === 'string' &&
    Number.isFinite(Number(foto.value))
  const cuadra =
    Number.isFinite(base) &&
    Number.isFinite(descuento) &&
    descuento > 0 &&
    Math.round(base * 100) - Math.round(descuento * 100) === Math.round(Number(cobradoSinPropina) * 100)
  if (fotoValida && cuadra) return { foto, descuento, base }
  logger.error('🚨 [PaymentLink] El descuento de la sesión no cuadra con lo cobrado; la venta se registra sin descuento', {
    sessionId,
    cobradoSinPropina: cobradoSinPropina.toString(),
    descuento: d,
  })
  return null
}

/**
 * Suma el uso al descuento del catálogo en la transacción del cobro y devuelve el `discountId` para la fila. Si el descuento
 * se borró después de abrir la sesión, la venta se registra igual con lo cobrado y la fila queda sin `discountId`: el dinero
 * ya se cobró, así que nunca lanza ni recalcula el precio.
 */
async function contarUsoDelDescuento(tx: Prisma.TransactionClient, venueId: string, discountId: string | null): Promise<string | null> {
  if (!discountId) return null
  const { count } = await tx.discount.updateMany({ where: { id: discountId, venueId }, data: { currentUses: { increment: 1 } } })
  return count > 0 ? discountId : null
}

/**
 * Resuelve la atribución congelada del checkout o, para sesiones legacy,
 * el cliente registrado que coincide con el correo/teléfono del pagador.
 *
 * Reglas deliberadas:
 * - **Sólo empata, nunca crea.** Un pago anónimo por link no debe dar de alta un
 *   cliente: inflaría el CRM y las listas de marketing con gente que nunca se
 *   registró. Sin coincidencia → `null` y no cambia nada (ni puntos ni métricas).
 * - **El correo manda sobre el teléfono** (es el dato que capturan los tres
 *   canales) y el orden es fijo, para que el mismo pago resuelva siempre igual.
 * - Sin snapshot, conserva el fallback legacy no bloqueante. Con snapshot, falla cerrado si no se puede validar el venue.
 */
async function resolvePaymentLinkCustomerId(
  venueId: string,
  email?: string | null,
  phone?: string | null,
  attributedCustomerId?: string | null,
): Promise<string | null> {
  if (attributedCustomerId) {
    const customer = await prisma.customer.findFirst({ where: { id: attributedCustomerId, venueId }, select: { id: true } })
    if (!customer) throw new BadRequestError('El cliente atribuido a esta sesión no pertenece al negocio')
    return customer.id
  }
  const normalizedEmail = email?.trim().toLowerCase() || null
  const normalizedPhone = phone?.trim() || null
  if (!normalizedEmail && !normalizedPhone) return null

  try {
    if (normalizedEmail) {
      const byEmail = await prisma.customer.findFirst({
        where: { venueId, active: true, email: { equals: normalizedEmail, mode: 'insensitive' as const } },
        select: { id: true },
      })
      if (byEmail) return byEmail.id
    }
    if (normalizedPhone) {
      const byPhone = await prisma.customer.findFirst({
        where: { venueId, active: true, phone: normalizedPhone },
        select: { id: true },
      })
      if (byPhone) return byPhone.id
    }
    return null
  } catch (err) {
    logger.warn('No se pudo resolver el cliente de una liga de pago (el cobro no se ve afectado)', {
      venueId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Acredita puntos y mueve las métricas del cliente por un cobro de liga de pago.
 *
 * BASE (decisión del founder, 2026-08-18): lo que el cliente pagó por la venta,
 * **con IVA** (en México el precio en pantalla ya lo trae) y **sin propina** —
 * la propina es del empleado, no venta del negocio. En estos tres caminos eso es
 * exactamente `Order.total − Order.tipAmount`, que es el mismo número que queda
 * en `Payment.amount`.
 *
 * IDEMPOTENCIA (dos capas, ninguna nueva):
 *  1. Los tres finalizadores ya son de un solo disparo — una reentrega del
 *     webhook regresa ANTES de crear una segunda orden (sesión COMPLETED en
 *     Stripe, claim CAS en Blumon, `paymentId` ya sellado en MercadoPago). Es la
 *     misma garantía de la que ya dependen la comisión y el vale de inventario.
 *  2. `earnPoints` deduplica por `(customerId, orderId, EARN)` con índice único
 *     parcial en la DB, así que dos llamadas por la MISMA orden no dan doble punto.
 *
 * NUNCA lanza: un cobro aprobado no se cae porque falle un enganche de lealtad
 * (mismo patrón que comisión, referidos y el vale de inventario en este archivo).
 *
 * `earnPoints` NO recibe staff: `LoyaltyTransaction.createdById` referencia
 * `StaffVenue.id`, y en una liga de pago el cliente cobra solo desde la web — no
 * hay cajero. Pasar el `Staff.id` del creador de la liga reventaría la FK en
 * silencio (trampa ya documentada en `manualPayment.service.ts`).
 */
async function creditPaymentLinkCustomer(args: {
  venueId: string
  customerId: string
  orderId: string
  amount: Prisma.Decimal
  channel: 'stripe' | 'blumon' | 'mercadopago'
}): Promise<void> {
  const base = Number(args.amount.toString())

  try {
    await updateCustomerMetrics(args.customerId, base, args.orderId, args.venueId)
    logger.info('📊 Métricas del cliente actualizadas (liga de pago)', {
      orderId: args.orderId,
      customerId: args.customerId,
      channel: args.channel,
      amount: base,
    })
  } catch (metricsError: any) {
    logger.error('⚠️ Falló actualizar métricas del cliente en liga de pago (el cobro sigue en pie)', {
      orderId: args.orderId,
      customerId: args.customerId,
      venueId: args.venueId,
      channel: args.channel,
      error: metricsError?.message ?? String(metricsError),
    })
  }

  try {
    const loyaltyResult = await earnPoints(args.venueId, args.customerId, base, args.orderId)
    logger.info('🎁 Puntos de lealtad acreditados (liga de pago)', {
      orderId: args.orderId,
      customerId: args.customerId,
      channel: args.channel,
      amount: base,
      pointsEarned: loyaltyResult?.pointsEarned,
      newBalance: loyaltyResult?.newBalance,
    })
  } catch (loyaltyError: any) {
    logger.error('⚠️ Falló acreditar puntos en liga de pago (el cobro sigue en pie)', {
      orderId: args.orderId,
      customerId: args.customerId,
      venueId: args.venueId,
      channel: args.channel,
      error: loyaltyError?.message ?? String(loyaltyError),
    })
  }
}

export async function finalizePaymentLinkCheckout(args: {
  stripeSessionId: string
  paymentIntentId?: string | null
  amountPaidCents?: number | null
  /** Stripe `payment_method.type` (card, oxxo, customer_balance, apple_pay, ...). */
  stripePaymentMethodType?: string | null
}) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: args.stripeSessionId },
    include: {
      paymentLink: {
        select: {
          id: true,
          venueId: true,
          purpose: true,
          shortCode: true,
          createdById: true,
          // Commission attribution. Empty array → no commission. N items →
          // commission split equally across them. The first attribution is
          // also used as Payment.processedById so reports/receipts have a
          // single named staff to display.
          attributions: {
            select: { staffId: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      // EcommerceMerchant gives us the connectAccountId we need to fetch
      // full charge details (card brand / last4 / receipt_url) from Stripe.
      ecommerceMerchant: {
        select: { id: true, providerCredentials: true, provider: { select: { code: true } } },
      },
    },
  })

  if (!session || !session.paymentLink) {
    logger.warn('⚠️ [STRIPE PAYMENT-LINK WEBHOOK] No payment-link session found for Stripe session', {
      stripeSessionId: args.stripeSessionId,
    })
    return
  }

  if (session.status === 'COMPLETED') {
    // Already processed — webhook retry. No-op: la comisión quedó encolada en la MISMA transacción que marcó la sesión
    // (fase 3, A5), así que salir aquí ya no la pierde.
    return
  }

  // Fetch charge details from Stripe (card brand, last4, receipt URL) using
  // the connected account credentials. Best-effort: if Stripe is unreachable
  // we still create the Payment row so finalization isn't blocked. The
  // receipt URL is the most useful payload — `pay.avoqado.io` shows a
  // "Ver recibo" button on success that links here.
  const chargeDetails: {
    cardBrand: string | null
    last4: string | null
    receiptUrl: string | null
    /** Tipo real del cobro (`oxxo`, `card`, `customer_balance`…). El webhook casi nunca lo trae: no expande objetos. */
    tipo: string | null
  } = { cardBrand: null, last4: null, receiptUrl: null, tipo: null }
  const connectAccountId = (session.ecommerceMerchant?.providerCredentials as { connectAccountId?: string })?.connectAccountId
  if (connectAccountId && args.paymentIntentId && session.ecommerceMerchant?.provider?.code === 'STRIPE_CONNECT') {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2026-02-25.clover' as any })
      const pi = await stripe.paymentIntents.retrieve(
        args.paymentIntentId,
        { expand: ['latest_charge'] },
        { stripeAccount: connectAccountId },
      )
      const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null
      if (charge) {
        chargeDetails.receiptUrl = charge.receipt_url ?? null
        chargeDetails.tipo = charge.payment_method_details?.type ?? null
        const cardDetails = (charge.payment_method_details as { card?: { brand?: string; last4?: string } } | null)?.card
        chargeDetails.cardBrand = cardDetails?.brand ?? null
        chargeDetails.last4 = cardDetails?.last4 ?? null
      }
    } catch (err) {
      if (debeReintentarSinTipo(args.stripePaymentMethodType, err)) throw err
      logger.warn('Failed to fetch Stripe charge details (non-fatal)', {
        paymentIntentId: args.paymentIntentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const metadata = (session.metadata ?? {}) as Record<string, any>
  // Bundle line items snapshot saved at PaymentIntent-creation time, so the
  // webhook is replay-safe even if the link was edited or archived after the
  // customer initiated the payment.
  const sessionItems: BundleItemSnapshot[] = Array.isArray(metadata.items) ? metadata.items : []
  const isItemLink = session.paymentLink.purpose === 'ITEM' && sessionItems.length > 0
  const venueId = session.paymentLink.venueId

  const tipAmount = new Prisma.Decimal(metadata.tipAmount || 0)
  const subtotal = session.amount.sub(tipAmount) // session.amount already includes tip
  // Con descuento: la orden lleva la base y el descuento; el cobro, la lealtad y la comisión siguen sobre `subtotal` (el neto).
  const descuentoDeLiga = descuentoDeLaSesion(metadata, subtotal, session.sessionId)
  const stripePaymentIntentId = args.paymentIntentId ?? null

  // Commission attribution: the first attributed staff is the "named seller" on Payment.processedById; the commission is
  // frozen INSIDE the payment transaction (fase 3, A5).
  const attributedStaffIds = session.paymentLink.attributions.map(a => a.staffId)
  const primaryStaffId = attributedStaffIds[0] ?? null // for Payment.processedById
  let orderIdForReferral: string | null = null
  let postingId: string | null = null
  // Cliente registrado detrás del cobro (si lo hay). Se resuelve ANTES de la
  // transacción para poder sellar `Order.customerId`.
  const loyaltyCustomerId = await resolvePaymentLinkCustomerId(
    venueId,
    session.customerEmail,
    session.customerPhone,
    session.attributedCustomerId,
  )
  // Base de lealtad = lo cobrado por la venta, con IVA y SIN propina.
  const loyaltyBase = subtotal.lt(0) ? new Prisma.Decimal(0) : subtotal

  await prisma.$transaction(async tx => {
    // 1. Mark session COMPLETED + record Stripe paymentIntent for reconciliation
    await tx.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        metadata: {
          ...metadata,
          stripePaymentIntentId,
          ...(args.amountPaidCents != null ? { stripeAmountPaidCents: args.amountPaidCents } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    })

    // 2. Update payment link counters
    await tx.paymentLink.update({
      where: { id: session.paymentLink!.id },
      data: {
        totalCollected: { increment: session.amount },
        paymentCount: { increment: 1 },
      },
    })

    // 3. Always create an Order so every payment-link transaction shows up in
    //    /orders and /payments alongside TPV in-person sales. ITEM links use
    //    a TAKEOUT order with the real product; PAYMENT/DONATION links use
    //    MANUAL_ENTRY (the enum doc says: "no items, no inventory impact,
    //    filtered out of operational reports but kept in revenue totals")
    //    so they don't clog kitchen prep queues or other operational views.
    const isPaymentOrDonation = !isItemLink

    // 🔴 NO se estampa `shiftId`, y es DELIBERADO — no lo "arregles".
    //
    // Quien paga es el CLIENTE desde su teléfono, cuando quiere: este código corre en un webhook
    // del procesador, no en el mostrador. `createdById` es quien CREÓ LA LIGA, a veces días antes.
    // Estampar «el turno abierto ahora» metería en el corte de un cajero una venta en la que no
    // participó —y una liga pagada de madrugada caería en el turno que alguien dejó abierto—.
    // El dinero SÍ llega al turno correcto por otra vía: `Payment.shiftId` lo resuelve el camino
    // del cobro. Guardado por `tests/unit/services/dashboard/paymentLink.sinTurno.test.ts`.
    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber: `PL-${Date.now()}`,
        type: isPaymentOrDonation ? 'MANUAL_ENTRY' : 'TAKEOUT',
        source: 'PAYMENT_LINK',
        createdById: session.paymentLink!.createdById,
        ...(loyaltyCustomerId ? { customerId: loyaltyCustomerId } : {}),
        customerName: session.customerName,
        customerEmail: session.customerEmail,
        subtotal: descuentoDeLiga ? new Prisma.Decimal(descuentoDeLiga.base) : subtotal.lt(0) ? new Prisma.Decimal(0) : subtotal,
        discountAmount: descuentoDeLiga ? new Prisma.Decimal(descuentoDeLiga.descuento) : 0,
        taxAmount: 0,
        contratoDePrecio: 'IVA_INCLUIDO',
        tipAmount,
        total: session.amount,
        paidAmount: session.amount,
        remainingBalance: 0,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        completedAt: new Date(),
        ...(isItemLink && {
          items: {
            create: sessionItems.map(it => {
              const mods = it.modifiers ?? []
              const modSumPerUnit = mods.reduce((s, m) => s + m.price * m.quantity, 0)
              const lineTotal = (it.unitPrice + modSumPerUnit) * it.quantity
              return {
                productId: it.productId,
                productName: it.productName,
                quantity: it.quantity,
                unitPrice: new Prisma.Decimal(it.unitPrice),
                discountAmount: 0,
                taxAmount: 0,
                total: new Prisma.Decimal(lineTotal),
                modifiers:
                  mods.length > 0
                    ? {
                        create: mods.map(m => ({
                          modifierId: m.modifierId,
                          name: m.modifierName,
                          quantity: m.quantity,
                          price: new Prisma.Decimal(m.price),
                        })),
                      }
                    : undefined,
              }
            }),
          },
        }),
      },
      // Los renglones con su id (y sus modificadores) son lo que el vale de
      // inventario necesita para nacer dentro de esta misma transacción.
      include: { items: { include: { modifiers: { include: { modifier: true } } } } },
    })

    // El descuento de la liga es su fila de CUENTA, repartida entre los renglones, y un uso del descuento del catálogo.
    if (descuentoDeLiga) {
      const discountId = await contarUsoDelDescuento(tx, venueId, descuentoDeLiga.foto.discountId)
      await tx.orderDiscount.create({
        data: filaDeDescuentoDeLiga({
          orderId: order.id,
          foto: { ...descuentoDeLiga.foto, discountId },
          montoPesos: descuentoDeLiga.descuento,
          basePesos: descuentoDeLiga.base,
        }),
      })
      await sincronizarRepartos(tx, order.id)
    }

    // 3b. Vale durable de inventario, en la MISMA transacción que la orden PAID.
    //     Antes se deducía en un `for` fuera de la transacción y con
    //     `session.sessionId` como orderId: un crash entre el commit y ese loop
    //     dejaba la venta cobrada, sin deducir y sin rastro. Ahora el vale nace
    //     atómico con la venta y el sweeper rescata lo que no se aplique.
    const posting = await createSalePostingInTx(tx, {
      venueId,
      orderId: order.id,
      items: (order.items ?? []) as any,
      staffId: primaryStaffId ?? session.paymentLink!.createdById,
    })
    postingId = posting?.id ?? null

    // 4. Create a Payment row linked to the Order. This is what the
    //    /payments dashboard reads — without it, the transaction shows in
    //    /ligas-de-pago but NOT in the unified payments view. We always
    //    create one regardless of purpose so the user sees every incoming
    //    peso in one place.
    // Avoqado's application fee was already charged by Stripe at settlement;
    // expose it on the Payment row so revenue reports stay accurate.
    // applicationFeeCents is in MINOR units; convert to MAJOR (MXN) for the
    // Decimal column. feePercentage is Decimal(5,4) so 0.0116 = 1.16%.
    const feeAmount = session.applicationFeeCents ? new Prisma.Decimal(session.applicationFeeCents).div(100) : new Prisma.Decimal(0)
    const grossForPayment = subtotal.lt(0) ? new Prisma.Decimal(0) : subtotal
    const netAmount = grossForPayment.sub(feeAmount).gte(0) ? grossForPayment.sub(feeAmount) : new Prisma.Decimal(0)
    // feePercentage = feeAmount / gross (when gross>0). Keep 4 decimal precision.
    const feePercentage = grossForPayment.gt(0) ? feeAmount.div(grossForPayment).toDecimalPlaces(4) : new Prisma.Decimal(0)

    // Stripe's payment_method.type → nuestro método y forma SAT (OXXO = OTHER + '01', SPEI = BANK_TRANSFER…), en vez de
    // que todo caiga en CREDIT_CARD. Ver `metodoDeStripe`.
    // Codex r1 (19-oct): el webhook casi nunca trae el tipo (no expande `latest_charge`) y un OXXO caía a CREDIT_CARD/SAT 04.
    // El cargo que ya se consultó arriba sí lo dice.
    const tipoDeStripe = args.stripePaymentMethodType ?? chargeDetails.tipo
    const { method, tenderSatFormaPago } = metodoDeStripe(tipoDeStripe)
    const fundsFlow = fundsFlowForStripePayment(tipoDeStripe)

    const createdPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: order.id,
        // 🔴 Sello explícito: Stripe liquida este dinero. Ver fundsFlowForStripePayment.
        fundsFlow,
        // Commission attribution. Payment.processedById gets the FIRST
        // attributed staff (used by receipts/reports as the "named seller").
        // The full split — 1/N per staff when there are multiple — is
        // frozen with this payment, right below (fase 3, A5), from the
        // attributions join table. When the link has no
        // attributions we leave processedById NULL and skip commission.
        processedById: primaryStaffId ?? undefined,
        // Link to the EcommerceMerchant channel so the dashboard's "Cuenta
        // Comercial" column can render which Stripe/Blumon channel
        // processed this payment (vs the in-person Banorte/Menta accounts).
        ecommerceMerchantId: session.ecommerceMerchant?.id,
        amount: grossForPayment,
        tipAmount,
        method,
        tenderSatFormaPago,
        source: 'WEB',
        status: 'COMPLETED',
        // FAST signals "no inventory / no operational fulfilment" so
        // operational dashboards can skip it without affecting revenue.
        type: isItemLink ? 'REGULAR' : 'FAST',
        processor: 'stripe',
        processorId: stripePaymentIntentId,
        feePercentage,
        feeAmount,
        netAmount,
        // Card brand + last 4 captured from the Stripe charge fetched above.
        // Both nullable — async methods (OXXO, SPEI) won't populate them.
        cardBrand: mapStripeCardBrandToEnum(chargeDetails.cardBrand),
        maskedPan: chargeDetails.last4 ? `************${chargeDetails.last4}` : undefined,
        receiptUrl: chargeDetails.receiptUrl ?? undefined,
        // Idempotency: PaymentIntent IDs are already unique per Stripe;
        // reuse as the key so duplicate webhooks (if they ever bypass the
        // ProcessedStripeEvent guard) still no-op via the unique index.
        idempotencyKey: stripePaymentIntentId ?? undefined,
      },
      select: { id: true },
    })
    // Fase 3 (A5, Codex r3-12): la comisión se CONGELA con el cobro, en esta misma transacción, como en la terminal. Antes
    // se calculaba después del commit sin esperarla: si el proceso moría ahí se perdía para siempre, y si la venta se
    // devolvía antes de que apareciera, el reverso no la encontraba y se pagaba sobre una venta devuelta.
    if (attributedStaffIds.length > 0) await enqueuePaymentCommissionInTx(tx, createdPayment.id, attributedStaffIds)
    // D7: la sesión apunta a su pago, como en Mercado Pago (la página alojada de Stripe es `cs_…` y el pago `pi_…`).
    await tx.checkoutSession.update({ where: { id: session.id }, data: { paymentId: createdPayment.id } })
    // R8: activar sobres va DESPUÉS del Payment (compara lo cobrado). Las ligas venden catálogo: hoy no encuentra sobres.
    await activarSobresDeCuentaPagadaEnTx(tx, {
      venueId,
      orderId: order.id,
      staffId: primaryStaffId ?? session.paymentLink!.createdById,
      items: (order.items ?? []) as Array<{ giftCardId?: string | null }>,
    })
    orderIdForReferral = order.id
    // A5 r1: congelar la comisión le suma consultas a esta transacción; el mismo tope de 10 s que el cobro de la terminal.
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  // REFERRAL HOOK: trigger referral qualification if this paid order has a pending referral
  if (orderIdForReferral) {
    try {
      const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
      await onOrderPaid({ orderId: orderIdForReferral, venueId })
    } catch (err) {
      console.error('[referral hook] onOrderPaid failed for order', orderIdForReferral, err)
    }
  }

  // LEALTAD + MÉTRICAS DEL CLIENTE. Fuera de la transacción y a prueba de fallos,
  // igual que referidos / vale de inventario: el cobro ya está hecho.
  if (loyaltyCustomerId && orderIdForReferral) {
    await creditPaymentLinkCustomer({
      venueId,
      customerId: loyaltyCustomerId,
      orderId: orderIdForReferral,
      amount: loyaltyBase,
      channel: 'stripe',
    })
  }

  // 4. Aplicar el vale de inventario, YA COMMITEADO el cobro. El aplicador es
  //    reintentable por línea y nunca puede tumbar una venta cobrada: si truena
  //    aquí, el posting queda PENDING/PARTIAL_FAILED y el sweeper lo retoma.
  if (postingId) {
    try {
      await applySalePosting(postingId, primaryStaffId ?? session.paymentLink.createdById)
    } catch (deductionError: any) {
      logger.error('Failed to apply inventory posting for Stripe payment-link', {
        paymentLinkId: session.paymentLink.id,
        postingId,
        error: deductionError?.message ?? String(deductionError),
      })
    }
  }

  logger.info('Stripe payment-link checkout finalized', {
    stripeSessionId: args.stripeSessionId,
    paymentLinkId: session.paymentLink.id,
    shortCode: session.paymentLink.shortCode,
    amount: session.amount.toString(),
  })

  // Best-effort venue admin notification. Fires outside the critical path
  // so a slow email round-trip doesn't delay the webhook response. Any
  // error here only logs — the payment finalization stands.
  void notifyVenueOnLinkPaid({
    paymentLinkId: session.paymentLink.id,
    venueId: session.paymentLink.venueId,
    stripeSessionId: args.stripeSessionId,
  }).catch(err => {
    logger.warn(`[PAYMENT-LINK NOTIFY] failed for session ${args.stripeSessionId}: ${(err as Error).message}`)
  })
}

/**
 * Fan out the "payment received" email to venue admins (OWNER/ADMIN role)
 * when VenuePaymentLinkSettings.notifyOnPaid is on. Looks up the freshly
 * paid session + link + customer info, then iterates eligible staff one
 * at a time so a single bad address doesn't block the rest.
 */
async function notifyVenueOnLinkPaid(args: { paymentLinkId: string; venueId: string; stripeSessionId: string }): Promise<void> {
  const settings = await prisma.venuePaymentLinkSettings.findUnique({
    where: { venueId: args.venueId },
    select: { notifyOnPaid: true },
  })
  if (!settings?.notifyOnPaid) return

  const [link, venue, recipients, paidSession] = await Promise.all([
    prisma.paymentLink.findUnique({
      where: { id: args.paymentLinkId },
      select: { title: true, shortCode: true, currency: true },
    }),
    prisma.venue.findUnique({
      where: { id: args.venueId },
      select: { name: true, slug: true, timezone: true },
    }),
    // Eligible recipients: active OWNER/ADMIN staff assigned to this venue.
    // Staff.email is non-nullable in schema so we don't filter for it.
    prisma.staffVenue.findMany({
      where: {
        venueId: args.venueId,
        active: true,
        role: { in: ['OWNER', 'ADMIN'] },
        staff: { active: true },
      },
      include: { staff: { select: { id: true, email: true, firstName: true } } },
    }),
    prisma.checkoutSession.findUnique({
      where: { sessionId: args.stripeSessionId },
      select: {
        amount: true,
        customerEmail: true,
        customerName: true,
        completedAt: true,
        metadata: true,
      },
    }),
  ])

  if (!link || !venue || !paidSession || recipients.length === 0) return

  const tz = venue.timezone || 'America/Mexico_City'
  const paidAtRaw = formatInTimeZone(paidSession.completedAt ?? new Date(), tz, "EEEE d 'de' MMMM 'de' yyyy HH:mm", { locale: esLocale })
  const paidAtLong = paidAtRaw.charAt(0).toUpperCase() + paidAtRaw.slice(1)
  const dashboardOrigin = process.env.DASHBOARD_URL || 'https://app.avoqado.io'
  const dashboardUrl = paymentLinksDashboardUrl(dashboardOrigin, venue.slug)

  // Tip lives on the Stripe session metadata (set when the checkout was
  // created, line ~1033 in this file). String-typed because Stripe's
  // metadata is always strings.
  const metadata = (paidSession.metadata ?? {}) as Record<string, unknown>
  const tipStr = typeof metadata.tipAmount === 'string' ? metadata.tipAmount : null
  const tipAmount = tipStr ? Number(tipStr) : null

  for (const r of recipients) {
    const email = r.staff.email
    try {
      await emailService.sendPaymentLinkPaidEmail(email, {
        recipientName: r.staff.firstName,
        venueName: venue.name,
        linkTitle: link.title,
        linkShortCode: link.shortCode,
        customerEmail: paidSession.customerEmail,
        customerName: paidSession.customerName,
        amountPaid: Number(paidSession.amount),
        tipAmount,
        currency: link.currency || 'MXN',
        // Card last-4 lives on processorData (JSON blob) and varies per
        // provider. Skipped for now to keep this lean; can be re-added
        // once we standardize a getter.
        cardLast4: null,
        paidAtLong,
        dashboardUrl,
      })
    } catch (mailError) {
      logger.warn(`[PAYMENT-LINK NOTIFY] failed for ${email} (link=${args.paymentLinkId}): ${(mailError as Error).message}`)
    }
  }
}

/**
 * Stripe Connect hosted-checkout flow for payment links.
 *
 * Unlike `createCheckoutSession` (which is Blumon-style inline card capture),
 * this generates a Stripe-hosted checkout URL the customer is redirected to.
 * Avoqado's platform fee (`platformFeeBps` on the merchant, default 100bps =
 * 1.00%) is taken as Stripe `application_fee_amount`, automatically split at
 * settlement — no separate invoicing needed.
 *
 * Returns the redirect URL the public checkout site should send the user to.
 * Status finalization happens via Stripe webhook (`checkout.session.completed`).
 */
export async function createStripeCheckoutForPaymentLink(
  shortCode: string,
  input: {
    /** Required only for OPEN amount payment links. Ignored for FIXED/ITEM. */
    amount?: number
    /** Required only for ITEM payment links where the customer picks quantity. */
    quantity?: number
    /** Optional tip on top of base amount. */
    tipAmount?: number
    /** Total (neto + propina) que mostró la página; distinto → 409 sin cobrar. Ausente = no se compara. */
    expectedTotal?: number
    /** Pre-fills Stripe Checkout email field. */
    customerEmail?: string
    /** Custom field responses (validated against link.customFields). */
    customFieldResponses?: Record<string, string>
    /** Base URL the customer returns to after Stripe checkout. Comes from the
     *  public checkout site (avoqado-checkout / pay.avoqado.io). */
    returnUrl?: string
  },
) {
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      ecommerceMerchant: {
        include: { provider: { select: { code: true } } },
      },
      ...BUNDLE_ITEMS_INCLUDE,
    },
  })

  if (!paymentLink) throw new NotFoundError('Liga de pago no encontrada')
  await assertVenueSalesEnabled(paymentLink.venueId)
  if (paymentLink.status !== 'ACTIVE') throw new BadRequestError('Esta liga de pago no está disponible')
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    await prisma.paymentLink.update({ where: { id: paymentLink.id }, data: { status: 'EXPIRED' } })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }
  if (paymentLink.ecommerceMerchant.provider?.code !== 'STRIPE_CONNECT') {
    throw new BadRequestError('Esta liga de pago no está configurada para Stripe Connect')
  }
  if (!paymentLink.ecommerceMerchant.chargesEnabled) {
    throw new BadRequestError('La cuenta de Stripe del comercio aún no está activa')
  }

  // 1. Lo que se cobra (base − descuento + propina) y el 409 si la página mostró otro total. `input.quantity` se ignora.
  const bounds = getStripeChargeBounds()
  const cobro = await cobroDeLiga(paymentLink, input, new Date(), bounds.min / 100)
  const tipAmount = cobro.propina
  const chargeAmount = cobro.total

  // 2. Validate custom fields
  const customFields = paymentLink.customFields as CustomFieldDefinition[] | null
  if (customFields && customFields.length > 0) {
    for (const field of customFields) {
      if (field.required) {
        const response = input.customFieldResponses?.[field.id]
        if (!response || response.trim() === '') {
          throw new BadRequestError(`El campo "${field.label}" es requerido`)
        }
      }
      if (field.type === 'SELECT' && field.options && input.customFieldResponses?.[field.id]) {
        if (!field.options.includes(input.customFieldResponses[field.id])) {
          throw new BadRequestError(`Opción inválida para el campo "${field.label}"`)
        }
      }
    }
  }

  // 4. Compute Stripe amount + fee. Bounds check protects against pennies
  //    (Stripe rejects sub-$10 MXN) and absurdly large amounts.
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  if (stripeAmount < bounds.min) throw new BadRequestError('El monto es menor al mínimo permitido por Stripe')
  if (stripeAmount > bounds.max) throw new BadRequestError('El monto excede el máximo permitido por transacción')

  // VAT-inclusive platform fee (industry standard in MX). The merchant is
  // charged `platformFeeBps + IVA`, Avoqado retains the net and remits IVA
  // to SAT via monthly CFDI emission (separate process, not handled here).
  const vatRateBps = await getVatRateBps()
  const applicationFeeAmount = calculateApplicationFeeWithVAT(stripeAmount, paymentLink.ecommerceMerchant.platformFeeBps, vatRateBps)

  // 5. Build return URLs. Stripe substitutes {CHECKOUT_SESSION_ID} server-side
  //    so the success page can fetch session status from our API.
  const checkoutBaseUrl = (input.returnUrl || process.env.CHECKOUT_BASE_URL || 'https://pay.avoqado.io').replace(/\/$/, '')
  const sep = (u: string) => (u.includes('?') ? '&' : '?')
  const baseReturn = `${checkoutBaseUrl}/${shortCode}`
  const successUrl = `${baseReturn}${sep(baseReturn)}status=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${baseReturn}${sep(baseReturn)}status=cancelled`

  // 6. Create the Stripe checkout session via the provider
  const provider = getProvider(paymentLink.ecommerceMerchant)
  const stripeSession = await provider.createCheckoutSession(paymentLink.ecommerceMerchant, {
    amount: stripeAmount,
    currency: paymentLink.currency.toLowerCase(),
    applicationFeeAmount,
    successUrl,
    cancelUrl,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    customerEmail: input.customerEmail,
    metadata: {
      // The webhook handler routes on `paymentLinkId`. Keep all values as
      // strings (Stripe metadata only accepts string values).
      type: 'payment_link',
      paymentLinkId: paymentLink.id,
      shortCode: paymentLink.shortCode,
      venueId: paymentLink.venueId,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      ...(tipAmount > 0 ? { tipAmount: String(tipAmount) } : {}),
      ...(paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0
        ? {
            purpose: 'ITEM',
            itemCount: String(paymentLink.items.length),
            // Stripe metadata caps at 500 chars/value; full bundle (incl. modifiers)
            // is in the CheckoutSession.metadata column instead.
            items: JSON.stringify(buildBundleSnapshot(paymentLink.items)).slice(0, 500),
          }
        : {}),
      ...(input.customFieldResponses ? { customFieldResponses: JSON.stringify(input.customFieldResponses) } : {}),
    },
    description: paymentLink.title,
    statementDescriptorSuffix: 'AVOQADO',
    idempotencyKey: `paymentLink:${paymentLink.id}:${nanoid(10)}`,
    paymentMethodTypes: ['card'],
  })

  // 7. Persist our CheckoutSession row keyed by Stripe's session id. The
  //    webhook handler updates `status` to PAID when Stripe notifies us;
  //    until then the session sits in PENDING.
  await prisma.checkoutSession.create({
    data: {
      sessionId: stripeSession.id,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      paymentLinkId: paymentLink.id,
      attributedCustomerId: paymentLink.customerId ?? null,
      amount: new Prisma.Decimal(chargeAmount),
      currency: paymentLink.currency,
      description: paymentLink.title,
      customerEmail: input.customerEmail,
      // Real column for fast SUM() reporting. The metadata copy below is kept
      // for backward compatibility with rows created before this column existed.
      applicationFeeCents: applicationFeeAmount,
      metadata: {
        applicationFeeCents: applicationFeeAmount,
        platformFeeBps: paymentLink.ecommerceMerchant.platformFeeBps,
        provider: 'STRIPE_CONNECT',
        ...(tipAmount > 0 && { tipAmount }),
        ...(cobro.fotoParaSesion && { descuento: cobro.fotoParaSesion }),
        ...(input.customFieldResponses && { customFieldResponses: input.customFieldResponses }),
        // Persist the full line-item snapshot (incl. modifiers) on the
        // CheckoutSession so the webhook handler can replay OrderItem +
        // OrderItemModifier creation without re-reading the link (which may
        // have been edited between purchase and webhook arrival).
        ...(paymentLink.purpose === 'ITEM' &&
          paymentLink.items.length > 0 && {
            purpose: 'ITEM',
            items: buildBundleSnapshot(paymentLink.items),
          }),
      } as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      expiresAt: stripeSession.expiresAt,
    },
  })

  logger.info('Stripe checkout session created for payment link', {
    sessionId: stripeSession.id,
    paymentLinkId: paymentLink.id,
    shortCode,
    amountCents: stripeAmount,
    applicationFeeCents: applicationFeeAmount,
  })

  return {
    sessionId: stripeSession.id,
    redirectUrl: stripeSession.url,
    expiresAt: stripeSession.expiresAt,
  }
}

/**
 * Creates a checkout session and tokenizes the card
 */
export async function createCheckoutSession(
  shortCode: string,
  cardData: {
    pan: string
    cvv: string
    expMonth: string
    expYear: string
    holderName: string
    customerEmail?: string
    customerPhone?: string
    amount?: number
    quantity?: number
    tipAmount?: number
    /** Total (neto + propina) que mostró la página; distinto → 409 sin cobrar. Ausente = no se compara. */
    expectedTotal?: number
    customFieldResponses?: Record<string, string>
  },
) {
  // 1. Resolve payment link
  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      ecommerceMerchant: {
        select: {
          id: true,
          sandboxMode: true,
          providerCredentials: true,
          provider: { select: { code: true } },
        },
      },
      ...BUNDLE_ITEMS_INCLUDE,
    },
  })

  if (!paymentLink) {
    throw new NotFoundError('Liga de pago no encontrada')
  }
  await assertVenueSalesEnabled(paymentLink.venueId)

  if (paymentLink.status !== 'ACTIVE') {
    throw new BadRequestError('Esta liga de pago no está disponible')
  }

  // Check expiration
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    await prisma.paymentLink.update({
      where: { id: paymentLink.id },
      data: { status: 'EXPIRED' },
    })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }

  // Check single-use
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }

  // 🔴 Auditoría 2026-09-30: con un cobro EN VUELO (S1 en CHARGING, resultado desconocido) una liga de un solo uso no abre otra
  // sesión: el reintento del cliente cobraría dos veces. Se destraba conciliando ese cobro.
  if (!paymentLink.isReusable) {
    const inFlight = await prisma.checkoutSession.findFirst({
      where: { paymentLinkId: paymentLink.id, status: 'CHARGING' },
      select: { id: true, sessionId: true },
    })
    if (inFlight) {
      // El `sessionId` es de OTRO pagador (con él se consulta y hasta se podría cobrar su sesión): sólo al registro, para
      // soporte; nunca en la respuesta pública.
      logger.warn('[paymentLink] liga de un solo uso con un cobro en vuelo', {
        paymentLinkId: paymentLink.id,
        sessionId: inFlight.sessionId,
      })
      throw new ConflictError(
        'Hay un pago en proceso para esta liga. Espera la confirmación antes de intentar de nuevo.',
        'PAYMENT_IN_FLIGHT',
      )
    }
  }

  // 2. Lo que se cobra (base − descuento + propina) y el 409 si la página mostró otro total. Blumon no tiene mínimo
  // propio: con descuento sólo se exige neto > 0 (lo garantiza el desglose).
  const cobro = await cobroDeLiga(paymentLink, cardData, new Date())
  const tipAmount = cobro.propina
  const chargeAmount = cobro.total

  // 2b. Validate custom field responses if link has custom fields
  const customFields = paymentLink.customFields as CustomFieldDefinition[] | null
  if (customFields && customFields.length > 0) {
    for (const field of customFields) {
      if (field.required) {
        const response = cardData.customFieldResponses?.[field.id]
        if (!response || response.trim() === '') {
          throw new BadRequestError(`El campo "${field.label}" es requerido`)
        }
      }
      // Validate SELECT field options
      if (field.type === 'SELECT' && field.options && cardData.customFieldResponses?.[field.id]) {
        if (!field.options.includes(cardData.customFieldResponses[field.id])) {
          throw new BadRequestError(`Opción inválida para el campo "${field.label}"`)
        }
      }
    }
  }

  // 3. Resolve provider

  // 4. Tokenize card
  const provider = getProvider(paymentLink.ecommerceMerchant)
  const tokenResult = await provider.tokenizeCard(paymentLink.ecommerceMerchant, {
    pan: cardData.pan,
    cvv: cardData.cvv,
    expMonth: cardData.expMonth,
    expYear: cardData.expYear,
    holderName: cardData.holderName,
    customerEmail: cardData.customerEmail,
    customerPhone: cardData.customerPhone,
  })

  // 5. Create checkout session
  const sessionId = `cs_pl_${nanoid(16)}`
  const session = await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      paymentLinkId: paymentLink.id,
      attributedCustomerId: paymentLink.customerId ?? null,
      amount: new Prisma.Decimal(chargeAmount),
      currency: paymentLink.currency,
      description: paymentLink.title,
      customerEmail: cardData.customerEmail,
      customerPhone: cardData.customerPhone,
      customerName: cardData.holderName,
      metadata: {
        cardToken: tokenResult.token,
        maskedPan: tokenResult.maskedPan,
        cardBrand: tokenResult.cardBrand,
        cvv: cardData.cvv, // Needed for charge step
        // Tip tracking
        ...(tipAmount > 0 && { tipAmount }),
        ...(cobro.fotoParaSesion && { descuento: cobro.fotoParaSesion }),
        // Custom field responses
        ...(cardData.customFieldResponses && { customFieldResponses: cardData.customFieldResponses }),
        // ITEM link metadata for order creation
        // Persist the full line-item snapshot (incl. modifiers) on the
        // CheckoutSession so the webhook handler can replay OrderItem +
        // OrderItemModifier creation without re-reading the link (which may
        // have been edited between purchase and webhook arrival).
        ...(paymentLink.purpose === 'ITEM' &&
          paymentLink.items.length > 0 && {
            purpose: 'ITEM',
            items: buildBundleSnapshot(paymentLink.items),
          }),
      } as unknown as Prisma.InputJsonValue,
      status: 'PROCESSING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    },
  })

  logger.info('Checkout session created for payment link', {
    sessionId,
    paymentLinkId: paymentLink.id,
    shortCode,
    amount: chargeAmount,
  })

  // 6. TODO: 3DS registration would happen here when implemented
  // For now, proceed directly to charge-ready state
  return {
    sessionId: session.sessionId,
    amount: chargeAmount,
    currency: paymentLink.currency,
    maskedPan: tokenResult.maskedPan,
    cardBrand: tokenResult.cardBrand,
    // threeDSUrl: null, // Would contain 3DS challenge URL if needed
  }
}

/**
 * Completes the charge for a checkout session
 */
export async function completeCharge(shortCode: string, sessionId: string, _threeDSTransactionId?: string) {
  // 1. Find session
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    include: {
      paymentLink: {
        select: {
          id: true,
          shortCode: true,
          venueId: true,
          purpose: true,
          createdById: true,
          // Commission attribution — same shape used in
          // finalizePaymentLinkCheckout. Empty array = no commission;
          // 1 = full commission; 2+ = split equally.
          attributions: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        },
      },
      ecommerceMerchant: {
        select: {
          id: true,
          sandboxMode: true,
          providerCredentials: true,
          provider: { select: { code: true } },
        },
      },
    },
  })

  if (!session) {
    throw new NotFoundError('Sesión de pago no encontrada')
  }

  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }
  await assertVenueSalesEnabled(session.paymentLink.venueId)

  if (session.status !== 'PROCESSING') {
    throw new BadRequestError(
      session.status === 'COMPLETED' ? 'Este pago ya fue procesado' : `No se puede cobrar una sesión con estado ${session.status}`,
    )
  }

  // Valida el snapshot antes de autorizar en el banco; nunca sustituye al cliente elegido por el pagador.
  const loyaltyCustomerId = await resolvePaymentLinkCustomerId(
    session.paymentLink.venueId,
    session.customerEmail,
    session.customerPhone,
    session.attributedCustomerId,
  )

  // 2. Extract card token from metadata
  const metadata = session.metadata as Record<string, any>
  const cardToken = metadata?.cardToken
  const cvv = metadata?.cvv

  if (!cardToken) {
    throw new BadRequestError('Token de tarjeta no encontrado en la sesión')
  }

  // 2.5 🔴 Claim atómico ANTES de autorizar (auditoría 2026-08-12): el check de
  // arriba lee fuera de transacción, así que dos llamadas concurrentes lo pasaban
  // las dos y AUTORIZABAN DOS VECES con el proveedor (cada autorización trae su
  // propio transactionId, así que ni la llave del Payment colisionaba: doble
  // cargo + doble deducción). Solo quien gana PROCESSING→CHARGING autoriza.
  // Si el proveedor falla, se regresa a PROCESSING (reintentable); un crash a
  // media autorización deja CHARGING — fail-closed: una sesión atorada es
  // infinitamente más barata que un doble cargo.
  const claim = await prisma.checkoutSession.updateMany({
    where: { id: session.id, status: 'PROCESSING' },
    data: { status: 'CHARGING' },
  })
  if (claim.count === 0) {
    throw new BadRequestError('Este cobro ya se está procesando. Espera el resultado; no lo intentes de nuevo.')
  }

  // 3. Resolve provider and charge
  const provider = getProvider(session.ecommerceMerchant)
  let chargeResult
  try {
    chargeResult = await provider.authorizeCardPayment(session.ecommerceMerchant, {
      amount: Number(session.amount),
      currency: session.currency === 'MXN' ? '484' : session.currency,
      cardToken,
      cvv,
      orderId: session.sessionId,
    })
  } catch (error) {
    // 🔴 El claim SOLO se suelta en rechazos DEFINITIVOS del proveedor
    // (declinada, fondos insuficientes: Blumon respondió que NO). Un timeout o
    // corte de red después de mandar el charge deja el resultado DESCONOCIDO —
    // el cargo pudo aprobarse y perderse solo la respuesta. Soltar el claim ahí
    // rehabilitaba exactamente el doble cargo que este claim vino a matar: el
    // cliente reintenta, gana PROCESSING→CHARGING otra vez y autoriza una
    // SEGUNDA vez con otro transactionId. Con resultado desconocido la sesión
    // se queda CHARGING (atorada pero segura) para reconciliación manual.
    const outcomeUnknown = error instanceof PaymentOutcomeUnknownError
    if (!outcomeUnknown) {
      await prisma.checkoutSession
        .updateMany({ where: { id: session.id, status: 'CHARGING' }, data: { status: 'PROCESSING' } })
        .catch(() => undefined)
    } else {
      logger.error('🚨 [PaymentLink] Resultado del cobro DESCONOCIDO — sesión retenida en CHARGING para reconciliación', {
        sessionId: session.sessionId,
        paymentLinkId: session.paymentLink?.id,
        venueId: session.paymentLink?.venueId,
        amount: Number(session.amount),
      })
    }
    throw error
  }

  // 4. Update session and payment link + create Order for ITEM links.
  // Bundle line items were snapshotted onto CheckoutSession.metadata at
  // session creation, so we can replay OrderItem creation safely even if
  // the link was edited between checkout and charge completion.
  const sessionItems: BundleItemSnapshot[] = Array.isArray(metadata.items) ? metadata.items : []
  const isItemLink = session.paymentLink!.purpose === 'ITEM' && sessionItems.length > 0
  const venueId = session.paymentLink!.venueId

  // Commission attribution (parallels finalizePaymentLinkCheckout). The first
  // attributed staff is the "named seller" on Payment.processedById; the commission
  // is frozen INSIDE the payment transaction (fase 3, A5).
  const attributedStaffIds = session.paymentLink!.attributions.map(a => a.staffId)
  const primaryStaffId = attributedStaffIds[0] ?? null
  let orderIdForReferral: string | null = null
  let postingId: string | null = null
  let loyaltyBase: Prisma.Decimal | null = null

  await prisma.$transaction(async tx => {
    // Update checkout session
    await tx.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        blumonCheckoutId: chargeResult.transactionId,
        metadata: {
          maskedPan: metadata.maskedPan,
          cardBrand: metadata.cardBrand,
          authorizationCode: chargeResult.authorizationCode,
          transactionId: chargeResult.transactionId,
          // Preserve tip and custom field data
          ...(metadata.tipAmount && { tipAmount: metadata.tipAmount }),
          ...(metadata.customFieldResponses && { customFieldResponses: metadata.customFieldResponses }),
          // Preserve item list for reference + audit
          ...(isItemLink && { items: sessionItems }),
          ...(metadata.descuento && { descuento: metadata.descuento }),
        } as unknown as Prisma.InputJsonValue,
      },
    })

    // Update payment link counters
    await tx.paymentLink.update({
      where: { id: session.paymentLink!.id },
      data: {
        totalCollected: { increment: session.amount },
        paymentCount: { increment: 1 },
      },
    })

    // Always create an Order (parallels Stripe path). ITEM links get a real
    // TAKEOUT order with line items + modifiers; PAYMENT/DONATION links get a
    // MANUAL_ENTRY order so revenue reports stay consistent.
    {
      // Subtotal = ITEM ? sum(qty × (unitPrice + Σ modifier.price × modifier.qty))
      //                  : session.amount - tip (for PAYMENT/DONATION the amount
      //                  is already the gross + tip).
      const orderTipAmount = new Prisma.Decimal(metadata.tipAmount || 0)
      // Con descuento, la sesión manda: base, descuento y lo cobrado (neto + propina) son los que vio y pagó la clienta.
      const descuentoDeLiga = descuentoDeLaSesion(metadata, session.amount.sub(orderTipAmount), session.sessionId)
      const subtotal = descuentoDeLiga
        ? new Prisma.Decimal(descuentoDeLiga.base)
        : isItemLink
          ? sessionItems.reduce((sum, it) => {
              const modSumPerUnit = (it.modifiers ?? []).reduce((s, m) => s + m.price * m.quantity, 0)
              return sum.add(new Prisma.Decimal(it.unitPrice + modSumPerUnit).mul(it.quantity))
            }, new Prisma.Decimal(0))
          : session.amount.sub(orderTipAmount)
      const taxAmount = new Prisma.Decimal(0) // Tax included in price for payment links
      const total = descuentoDeLiga ? session.amount : subtotal.add(orderTipAmount)
      // Lo cobrado por la venta, con IVA y SIN propina (sin descuento = subtotal): el cobro, la lealtad y la comisión.
      const neto = total.sub(orderTipAmount)
      loyaltyBase = neto

      const orderNumber = `PL-${Date.now()}`

      // 🔴 NO se estampa `shiftId`, y es DELIBERADO — no lo "arregles".
      //
      // Quien paga es el CLIENTE desde su teléfono, cuando quiere: este código corre en un webhook
      // del procesador, no en el mostrador. `createdById` es quien CREÓ LA LIGA, a veces días antes.
      // Estampar «el turno abierto ahora» metería en el corte de un cajero una venta en la que no
      // participó —y una liga pagada de madrugada caería en el turno que alguien dejó abierto—.
      // El dinero SÍ llega al turno correcto por otra vía: `Payment.shiftId` lo resuelve el camino
      // del cobro. Guardado por `tests/unit/services/dashboard/paymentLink.sinTurno.test.ts`.
      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          type: isItemLink ? 'TAKEOUT' : 'MANUAL_ENTRY',
          source: 'PAYMENT_LINK',
          createdById: session.paymentLink!.createdById,
          ...(loyaltyCustomerId ? { customerId: loyaltyCustomerId } : {}),
          customerName: session.customerName,
          customerEmail: session.customerEmail,
          subtotal,
          discountAmount: descuentoDeLiga ? new Prisma.Decimal(descuentoDeLiga.descuento) : 0,
          taxAmount,
          contratoDePrecio: 'IVA_INCLUIDO',
          tipAmount: orderTipAmount,
          total,
          paidAmount: total,
          remainingBalance: 0,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          completedAt: new Date(),
          ...(isItemLink && {
            items: {
              create: sessionItems.map(it => {
                const mods = it.modifiers ?? []
                const modSumPerUnit = mods.reduce((s, m) => s + m.price * m.quantity, 0)
                const lineTotal = new Prisma.Decimal(it.unitPrice + modSumPerUnit).mul(it.quantity)
                return {
                  productId: it.productId,
                  productName: it.productName,
                  quantity: it.quantity,
                  unitPrice: new Prisma.Decimal(it.unitPrice),
                  discountAmount: 0,
                  taxAmount: 0,
                  total: lineTotal,
                  modifiers:
                    mods.length > 0
                      ? {
                          create: mods.map(m => ({
                            modifierId: m.modifierId,
                            name: m.modifierName,
                            quantity: m.quantity,
                            price: new Prisma.Decimal(m.price),
                          })),
                        }
                      : undefined,
                }
              }),
            },
          }),
        },
        // Los renglones con su id (y sus modificadores) son lo que el vale de
        // inventario necesita para nacer dentro de esta misma transacción.
        include: { items: { include: { modifiers: { include: { modifier: true } } } } },
      })

      // El descuento de la liga es su fila de CUENTA, repartida entre los renglones, y un uso del descuento del catálogo.
      if (descuentoDeLiga) {
        const discountId = await contarUsoDelDescuento(tx, venueId, descuentoDeLiga.foto.discountId)
        await tx.orderDiscount.create({
          data: filaDeDescuentoDeLiga({
            orderId: order.id,
            foto: { ...descuentoDeLiga.foto, discountId },
            montoPesos: descuentoDeLiga.descuento,
            basePesos: descuentoDeLiga.base,
          }),
        })
        await sincronizarRepartos(tx, order.id)
      }

      // Vale durable de inventario, atómico con la orden PAID — mismo motivo
      // que en el camino Stripe: antes se deducía fuera de la transacción y
      // contra el id de la sesión de checkout, no contra la orden.
      const posting = await createSalePostingInTx(tx, {
        venueId,
        orderId: order.id,
        items: (order.items ?? []) as any,
        staffId: primaryStaffId ?? session.paymentLink!.createdById,
      })
      postingId = posting?.id ?? null

      logger.info('Order created for payment link (Blumon)', {
        orderId: order.id,
        orderNumber,
        paymentLinkId: session.paymentLink!.id,
        itemCount: sessionItems.length,
        isItemLink,
      })

      // Create the unified Payment row so this transaction shows up in
      // /payments alongside Stripe + TPV sales. Blumon doesn't surface an
      // application_fee to us — fee/net columns are zeroed.
      const createdPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: order.id,
          processedById: primaryStaffId ?? undefined,
          // Same EcommerceMerchant link as the Stripe path — drives the
          // dashboard's "Cuenta Comercial" column for payment-link rows.
          ecommerceMerchantId: session.ecommerceMerchant?.id,
          amount: neto,
          tipAmount: orderTipAmount,
          method: 'CREDIT_CARD',
          source: 'WEB',
          status: 'COMPLETED',
          type: isItemLink ? 'REGULAR' : 'FAST',
          processor: 'blumon',
          processorId: chargeResult.transactionId,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: neto,
          // Card details captured at tokenize time + persisted in
          // CheckoutSession.metadata (see createCheckoutSession).
          cardBrand: mapBlumonCardBrandToEnum(metadata.cardBrand),
          maskedPan: typeof metadata.maskedPan === 'string' ? metadata.maskedPan : undefined,
          idempotencyKey: chargeResult.transactionId,
        },
        select: { id: true },
      })
      // Fase 3 (A5): la comisión se congela con el cobro, en esta transacción.
      if (attributedStaffIds.length > 0) await enqueuePaymentCommissionInTx(tx, createdPayment.id, attributedStaffIds)
      // D7: la sesión apunta a su pago, como en Mercado Pago (Blumon guarda el pago con su transactionId, no la sesión).
      await tx.checkoutSession.update({ where: { id: session.id }, data: { paymentId: createdPayment.id } })
      // R8: activar sobres va DESPUÉS del Payment (compara lo cobrado). Las ligas venden catálogo: hoy no encuentra sobres.
      await activarSobresDeCuentaPagadaEnTx(tx, {
        venueId,
        orderId: order.id,
        staffId: primaryStaffId ?? session.paymentLink!.createdById,
        items: (order.items ?? []) as Array<{ giftCardId?: string | null }>,
      })
      orderIdForReferral = order.id
    }
    // A5 r1: el mismo tope de 10 s que el cobro de la terminal. Pasarse aquí deja la tarjeta YA cobrada sin registro (CHARGING).
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  // REFERRAL HOOK: trigger referral qualification if this paid order has a pending referral
  if (orderIdForReferral) {
    try {
      const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
      await onOrderPaid({ orderId: orderIdForReferral, venueId })
    } catch (err) {
      console.error('[referral hook] onOrderPaid failed for order', orderIdForReferral, err)
    }
  }

  // LEALTAD + MÉTRICAS DEL CLIENTE. Fuera de la transacción y a prueba de fallos,
  // igual que referidos / vale de inventario: el cobro ya está hecho.
  if (loyaltyCustomerId && orderIdForReferral && loyaltyBase) {
    await creditPaymentLinkCustomer({
      venueId,
      customerId: loyaltyCustomerId,
      orderId: orderIdForReferral,
      amount: loyaltyBase,
      channel: 'blumon',
    })
  }

  // 5. Aplicar el vale de inventario, YA COMMITEADO el cobro (no bloqueante,
  // mismo patrón que TPV). El aplicador es reintentable por línea y jamás puede
  // tumbar una venta cobrada: si truena, el posting queda PENDING/PARTIAL_FAILED
  // y el sweeper lo retoma. La bitácora se ancla a la ORDEN, no a la sesión de
  // checkout, que es lo que antes hacía inconciliable el rastro.
  if (postingId) {
    try {
      const outcome = await applySalePosting(postingId, primaryStaffId ?? session.paymentLink!.createdById)
      if (outcome && !outcome.applied) {
        logAction({
          venueId,
          action: 'INVENTORY_DEDUCTION_FAILED',
          entity: 'Order',
          entityId: orderIdForReferral ?? session.sessionId,
          data: {
            source: 'PAYMENT_LINK',
            postingId,
            issues: outcome.issues,
            paymentLinkId: session.paymentLink!.id,
          },
        })
      }
    } catch (deductionError: any) {
      logger.error('Failed to apply inventory posting for payment-link', {
        paymentLinkId: session.paymentLink!.id,
        postingId,
        error: deductionError?.message ?? String(deductionError),
      })
    }
  }

  logger.info('Payment link charge completed', {
    sessionId,
    paymentLinkId: session.paymentLink!.id,
    amount: Number(session.amount),
    transactionId: chargeResult.transactionId,
    isItemLink,
  })

  return {
    status: 'COMPLETED',
    amount: Number(session.amount),
    currency: session.currency,
    transactionId: chargeResult.transactionId,
    authorizationCode: chargeResult.authorizationCode,
  }
}

/**
 * D7 (26-oct): el pago de una sesión cobrada. Mercado Pago deja `CheckoutSession.paymentId` y su sesión (`cs_mp_…`) no es
 * el `processorId` del pago; Stripe guarda la sesión como el PaymentIntent (`pi_…`), que sí es el `processorId`.
 */
function pagoDeLaSesion(session: { sessionId: string; paymentId: string | null }): Prisma.PaymentWhereInput {
  return session.paymentId ? { id: session.paymentId } : { processorId: session.sessionId }
}

/**
 * D7: el recibo que ve el cliente. El del proveedor si lo trae (Stripe); si no (Mercado Pago, Blumon, o Stripe sin su
 * `receipt_url`), el recibo digital de Avoqado: el canónico de la terminal, bajo candado del pago (dos consultas a la vez
 * reciben el mismo) y sin datos del cliente (en una liga el cliente puede venir de un correo que nadie verificó). Nunca
 * lanza: sin recibo, `null`.
 */
async function reciboParaElCliente(payment: { id: string; receiptUrl: string | null }): Promise<string | null> {
  if (payment.receiptUrl) return payment.receiptUrl
  if (!process.env.FRONTEND_URL) return null
  try {
    const recibo = await generateDigitalReceipt(payment.id)
    // Codex r2 #1: si el recibo ya existía, generado desde el panel con los datos del cliente, no se le da a quien pagó.
    if ((recibo.dataSnapshot as { customer?: unknown } | null)?.customer) return null
    return `${process.env.FRONTEND_URL}/receipts/public/${recibo.accessKey}`
  } catch (err) {
    logger.warn('No se pudo generar el recibo de Avoqado de una liga (no fatal)', {
      paymentId: payment.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Gets the status of a checkout session (for polling after 3DS)
 */
export async function getSessionStatus(shortCode: string, sessionId: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      paymentId: true,
      status: true,
      amount: true,
      currency: true,
      completedAt: true,
      errorMessage: true,
      paymentLink: {
        select: { shortCode: true, redirectUrl: true },
      },
    },
  })

  if (!session) {
    throw new NotFoundError('Sesión de pago no encontrada')
  }

  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }

  // After completion, look up the Payment that finalize created — gives the
  // customer-checkout success page the data it needs for the "Ver recibo"
  // link + the masked card line ("Visa •••• 4242"). We don't expose it
  // before status === COMPLETED to avoid leaking partial card details from
  // an in-flight charge.
  let payment: { receiptUrl: string | null; cardBrand: string | null; last4: string | null } | null = null
  if (session.status === 'COMPLETED') {
    const p = await prisma.payment.findFirst({
      where: pagoDeLaSesion(session),
      select: { id: true, receiptUrl: true, cardBrand: true, maskedPan: true },
      orderBy: { createdAt: 'desc' },
    })
    if (p) {
      payment = {
        receiptUrl: await reciboParaElCliente(p),
        cardBrand: p.cardBrand,
        // maskedPan is stored as ************4242 — extract the last 4 for
        // the UI so the customer-facing page doesn't have to parse it.
        last4: p.maskedPan ? p.maskedPan.replace(/^[*]+/, '').slice(-4) : null,
      }
    }
  }

  return {
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    completedAt: session.completedAt,
    errorMessage: session.errorMessage,
    redirectUrl: session.paymentLink?.redirectUrl,
    payment,
  }
}

/**
 * Send the Stripe-hosted receipt for a completed payment-link payment to a
 * customer-provided phone number via the venue's WhatsApp Business template
 * (`receipt_link`). Looks up the Payment with `pagoDeLaSesion` and the receipt
 * with `reciboParaElCliente` (Stripe's, or Avoqado's own for Mercado Pago).
 * Validates the link + session match so a customer can't trigger sends for
 * unrelated payments.
 */
export async function sendPaymentLinkReceiptWhatsapp(shortCode: string, sessionId: string, phone: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      paymentId: true,
      status: true,
      paymentLink: { select: { shortCode: true } },
    },
  })

  if (!session) throw new NotFoundError('Sesión de pago no encontrada')
  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }
  if (session.status !== 'COMPLETED') {
    throw new BadRequestError('El pago aún no se ha completado')
  }

  const payment = await prisma.payment.findFirst({
    where: pagoDeLaSesion(session),
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      receiptUrl: true,
      venue: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!payment) throw new NotFoundError('Pago no encontrado')
  const receiptUrl = await reciboParaElCliente(payment)
  if (!receiptUrl) {
    throw new BadRequestError('Recibo aún no disponible — intenta de nuevo en unos segundos')
  }

  const total = new Prisma.Decimal(payment.amount).add(payment.tipAmount ?? 0)
  const formatted = `$${total.toFixed(2)} MXN`

  await sendReceiptWhatsApp(phone, {
    venueName: payment.venue.name,
    totalAmount: formatted,
    receiptUrl,
  })

  return { sent: true }
}

/**
 * Email the Stripe-hosted receipt URL for a completed payment-link payment
 * to a customer-supplied address. Mirrors `sendPaymentLinkReceiptWhatsapp`
 * — validates the link↔session relationship, requires COMPLETED status, and
 * requires a receipt from `reciboParaElCliente` (Stripe's, or Avoqado's own
 * for Mercado Pago). Uses the existing `sendReceiptEmail` template so the
 * customer gets the same branded receipt email Avoqado sends elsewhere.
 */
export async function sendPaymentLinkReceiptEmail(shortCode: string, sessionId: string, email: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
      paymentId: true,
      status: true,
      paymentLink: { select: { shortCode: true } },
    },
  })

  if (!session) throw new NotFoundError('Sesión de pago no encontrada')
  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('Sesión no pertenece a esta liga de pago')
  }
  if (session.status !== 'COMPLETED') {
    throw new BadRequestError('El pago aún no se ha completado')
  }

  const payment = await prisma.payment.findFirst({
    where: pagoDeLaSesion(session),
    include: {
      venue: {
        select: {
          name: true,
          logo: true,
          address: true,
          city: true,
          state: true,
          phone: true,
          email: true,
          currency: true,
        },
      },
      // Pull the order and its line items so the email template can render
      // a real product breakdown instead of an empty "Recibo #XXXX" header.
      // For OPEN-amount links there's still an Order, just usually with a
      // single placeholder "Otro importe" line item.
      order: {
        include: {
          items: {
            include: {
              modifiers: { include: { modifier: true } },
            },
            orderBy: { sequence: 'asc' },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!payment) throw new NotFoundError('Pago no encontrado')
  const receiptUrl = await reciboParaElCliente(payment)
  if (!receiptUrl) {
    throw new BadRequestError('Recibo aún no disponible — intenta de nuevo en unos segundos')
  }

  const total = new Prisma.Decimal(payment.amount).add(payment.tipAmount ?? 0).toNumber()
  const receiptNumber = payment.id.slice(-4).toUpperCase()

  // Build the "Method of payment" label from the captured card details.
  // Stripe sometimes resolves OXXO/SPEI which have no card brand — for those
  // we surface the PaymentMethod enum value as a localized label.
  const last4 = payment.maskedPan ? payment.maskedPan.replace(/^[*]+/, '').slice(-4) : null
  const paymentMethod = formatPaymentMethodLabel(payment.cardBrand, last4, payment.method)

  // Map order items to the email template's shape. Modifiers come back as
  // joined rows so we flatten them per-item with a localized name.
  const items = payment.order?.items.map(item => ({
    name: item.productName ?? 'Producto',
    quantity: item.quantity,
    price: Number(item.unitPrice),
    totalPrice: Number(item.total),
    modifiers: item.modifiers.length
      ? item.modifiers.map(m => ({
          name: m.modifier?.name ?? m.name ?? 'Modificador',
          price: Number(m.price ?? 0),
        }))
      : undefined,
  }))

  await emailService.sendReceiptEmail(email, {
    venueName: payment.venue.name,
    receiptUrl,
    receiptNumber,
    venueLogoUrl: payment.venue.logo ?? undefined,
    venueAddress: payment.venue.address ?? undefined,
    venueCity: payment.venue.city ?? undefined,
    venueState: payment.venue.state ?? undefined,
    venuePhone: payment.venue.phone ?? undefined,
    venueEmail: payment.venue.email ?? undefined,
    currency: payment.venue.currency ?? 'MXN',
    items,
    // La venta antes del descuento y el descuento, de la orden (sin descuento, el subtotal es lo cobrado, como antes).
    subtotal: payment.order ? Number(payment.order.subtotal) : Number(payment.amount),
    discountAmount: payment.order && Number(payment.order.discountAmount) > 0 ? Number(payment.order.discountAmount) : undefined,
    tipAmount: payment.tipAmount ? Number(payment.tipAmount) : undefined,
    totalAmount: total,
    paymentMethod,
    paymentDate: payment.createdAt.toISOString(),
  })

  return { sent: true }
}

/** Render the customer-facing payment-method label. Prefers the card brand
 *  + last 4 ("Visa •••• 4242") when present, otherwise localizes the
 *  PaymentMethod enum (OXXO, SPEI, etc.). */
function formatPaymentMethodLabel(cardBrand: string | null, last4: string | null, method: string): string {
  const brandLabels: Record<string, string> = {
    VISA: 'Visa',
    MASTERCARD: 'Mastercard',
    AMERICAN_EXPRESS: 'Amex',
    DISCOVER: 'Discover',
    DINERS_CLUB: 'Diners',
    JCB: 'JCB',
    UNIONPAY: 'UnionPay',
  }
  if (cardBrand && last4) {
    return `${brandLabels[cardBrand] ?? 'Tarjeta'} •••• ${last4}`
  }
  if (last4) return `Tarjeta •••• ${last4}`
  const methodLabels: Record<string, string> = {
    CREDIT_CARD: 'Tarjeta de crédito',
    DEBIT_CARD: 'Tarjeta de débito',
    CASH: 'Efectivo',
    BANK_TRANSFER: 'Transferencia bancaria',
    OXXO: 'OXXO',
    SPEI: 'SPEI',
  }
  return methodLabels[method] ?? 'Tarjeta'
}

/**
 * Dashboard action — share a payment link with a customer via WhatsApp using
 * the approved `payment_link_share` template. Validates that the link belongs
 * to the venue, isn't expired/paused/archived, and (for single-use links)
 * hasn't already been paid — so an operator can't send a link the public
 * checkout will reject.
 *
 * The "concepto" sent to the customer is built here so we control formatting:
 *   - FIXED amount  → "<title> — $<amount> <currency>"
 *   - OPEN amount   → "<title>" (customer picks the amount on checkout)
 */
export async function sharePaymentLinkViaWhatsapp(venueId: string, linkId: string, phone: string) {
  const link = await prisma.paymentLink.findFirst({
    where: { id: linkId, venueId },
    select: {
      id: true,
      shortCode: true,
      title: true,
      amount: true,
      amountType: true,
      currency: true,
      status: true,
      isReusable: true,
      paymentCount: true,
      expiresAt: true,
      venue: { select: { name: true } },
    },
  })

  if (!link) throw new NotFoundError('Liga de pago no encontrada')

  if (link.status === 'PAUSED') throw new BadRequestError('Esta liga está pausada — actívala antes de compartirla')
  if (link.status === 'EXPIRED') throw new BadRequestError('Esta liga ya expiró')
  if (link.status === 'ARCHIVED') throw new BadRequestError('Esta liga está archivada')
  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new BadRequestError('Esta liga ya expiró')
  }
  if (!link.isReusable && link.paymentCount > 0) {
    throw new BadRequestError('Esta liga de un solo uso ya fue pagada — crea una nueva')
  }

  // Resolve customer-facing URL. CHECKOUT_BASE_URL is set per environment
  // (pay.avoqado.io / staging / demo). Fall back to production so a missing
  // var in dev doesn't ship an internal localhost URL to a real customer.
  const checkoutBase = process.env.CHECKOUT_BASE_URL || 'https://pay.avoqado.io'
  const paymentLinkUrl = `${checkoutBase.replace(/\/$/, '')}/${link.shortCode}`

  // Build the "concepto" — what the customer sees in {{2}} of the template.
  // Currency formatting mirrors the customer checkout (Intl.NumberFormat
  // with the link's currency); keeping it server-side prevents the operator
  // dashboard's locale from affecting what the customer reads.
  let concepto = link.title
  if (link.amountType === 'FIXED' && link.amount != null) {
    const formatted = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: link.currency || 'MXN',
    }).format(Number(link.amount))
    concepto = `${link.title} — ${formatted} ${link.currency || 'MXN'}`
  }

  await sendPaymentLinkShareWhatsApp(phone, {
    venueName: link.venue.name,
    concepto,
    paymentLinkUrl,
  })

  return { sent: true }
}

// ============================================================================
// Mercado Pago — public Brick (inline) checkout flow
// ============================================================================

/**
 * Initializes the MP Bricks payment flow for a public payment link.
 *
 * Equivalent of `createStripePaymentIntentForPaymentLink` but for MP:
 *   - Validates the link + provider + seller credentials
 *   - Computes charge amount + Avoqado's application_fee (centavos)
 *   - Creates a CheckoutSession row (status=PENDING)
 *   - Returns the seller's publicKey + sessionId so the frontend Brick can
 *     initialize and bootstrap tokenization
 *
 * The actual MP /v1/payments call happens later in
 * `executeMercadoPagoPaymentForPaymentLink` once the Brick submits the token.
 */
export async function createMercadoPagoPaymentIntentForPaymentLink(
  shortCode: string,
  input: {
    amount?: number
    tipAmount?: number
    /** Total (neto + propina) que mostró la página; distinto → 409 sin cobrar. Ausente = no se compara. */
    expectedTotal?: number
    customerEmail?: string
    customFieldResponses?: Record<string, string>
  },
) {
  const { loadCredentials } = await import('@/services/mercado-pago/connection.service')

  const paymentLink = await prisma.paymentLink.findUnique({
    where: { shortCode },
    include: {
      ecommerceMerchant: {
        include: { provider: { select: { code: true } } },
      },
      ...BUNDLE_ITEMS_INCLUDE,
    },
  })

  if (!paymentLink) throw new NotFoundError('Liga de pago no encontrada')
  await assertVenueSalesEnabled(paymentLink.venueId)
  if (paymentLink.status !== 'ACTIVE') throw new BadRequestError('Esta liga de pago no está disponible')
  if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
    await prisma.paymentLink.update({ where: { id: paymentLink.id }, data: { status: 'EXPIRED' } })
    throw new BadRequestError('Esta liga de pago ha expirado')
  }
  if (!paymentLink.isReusable && paymentLink.paymentCount > 0) {
    throw new BadRequestError('Esta liga de pago ya fue utilizada')
  }
  if (paymentLink.ecommerceMerchant.provider?.code !== 'MERCADO_PAGO') {
    throw new BadRequestError('Esta liga de pago no usa Mercado Pago')
  }

  const creds = await loadCredentials(paymentLink.ecommerceMerchant.id)
  if (!creds) {
    throw new BadRequestError('La cuenta de Mercado Pago del comercio no está conectada')
  }
  if (creds.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError('El token de Mercado Pago expiró. El comercio debe reconectar.')
  }

  // MercadoPago Mexico rejects amounts below its platform minimum (~$10 MXN)
  // with a generic 2072 "Invalid value for transaction_amount" — and that only
  // surfaces at payment time (mp-pay), after the customer entered their card.
  // Fail fast here, at intent creation, with a clear message.
  const mpMinMxn = Number(process.env.MP_MIN_CHARGE_MXN ?? 5)

  // 1. Lo que se cobra (base − descuento + propina) y el 409 si la página mostró otro total.
  const cobro = await cobroDeLiga(paymentLink, input, new Date(), mpMinMxn)
  const tipAmount = cobro.propina
  const chargeAmount = cobro.total

  // 2. Validate custom fields (same as Stripe)
  const customFields = paymentLink.customFields as CustomFieldDefinition[] | null
  if (customFields && customFields.length > 0) {
    for (const field of customFields) {
      if (field.required) {
        const response = input.customFieldResponses?.[field.id]
        if (!response || response.trim() === '') {
          throw new BadRequestError(`El campo "${field.label}" es requerido`)
        }
      }
      if (field.type === 'SELECT' && field.options && input.customFieldResponses?.[field.id]) {
        if (!field.options.includes(input.customFieldResponses[field.id])) {
          throw new BadRequestError(`Opción inválida para el campo "${field.label}"`)
        }
      }
    }
  }

  if (chargeAmount < mpMinMxn) {
    throw new BadRequestError(`El monto mínimo para pagar con Mercado Pago es $${mpMinMxn} MXN`)
  }

  // 4. Compute application_fee (same VAT logic as Stripe). Returns centavos.
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  const vatRateBps = await getVatRateBps()
  const applicationFeeCents = calculateApplicationFeeWithVAT(stripeAmount, paymentLink.ecommerceMerchant.platformFeeBps, vatRateBps)

  // 5. Generate a stable sessionId that will become MP's external_reference
  //    when the Brick submits the payment. The webhook handler looks up the
  //    session by this id.
  const sessionId = `cs_mp_${nanoid(16)}`

  await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: paymentLink.ecommerceMerchant.id,
      paymentLinkId: paymentLink.id,
      attributedCustomerId: paymentLink.customerId ?? null,
      amount: new Prisma.Decimal(chargeAmount),
      currency: 'MXN',
      description: paymentLink.title,
      customerEmail: input.customerEmail,
      applicationFeeCents,
      metadata: {
        applicationFeeCents,
        platformFeeBps: paymentLink.ecommerceMerchant.platformFeeBps,
        vatRateBps,
        provider: 'MERCADO_PAGO',
        flow: 'mp_bricks',
        ...(tipAmount > 0 && { tipAmount }),
        ...(cobro.fotoParaSesion && { descuento: cobro.fotoParaSesion }),
        ...(input.customFieldResponses && { customFieldResponses: input.customFieldResponses }),
        ...(paymentLink.purpose === 'ITEM' &&
          paymentLink.items.length > 0 && {
            purpose: 'ITEM',
            items: buildBundleSnapshot(paymentLink.items),
          }),
      } as unknown as Prisma.InputJsonValue,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  })

  logger.info('MP Bricks payment intent created for payment link', {
    sessionId,
    paymentLinkId: paymentLink.id,
    shortCode,
    amountMxn: chargeAmount,
    applicationFeeCents,
  })

  return {
    sessionId,
    publicKey: creds.publicKey,
    mpUserId: creds.mpUserId,
    amountMxn: chargeAmount,
    applicationFeeMxn: applicationFeeCents / 100,
    currency: 'MXN',
    description: paymentLink.title,
  }
}

/**
 * Completes the MP Bricks payment flow.
 *
 * The frontend Brick tokenized the card and submitted {token, paymentMethodId,
 * installments, payer} to our backend. We call MP /v1/payments with the
 * seller's access_token + application_fee, then update CheckoutSession with
 * mpPaymentId and the resulting status.
 *
 * Note: this returns immediately with the MP API result. Final status comes
 * via webhook (handleIpn) once MP confirms async approval (3DS, etc.).
 */
export async function executeMercadoPagoPaymentForPaymentLink(
  shortCode: string,
  sessionId: string,
  input: {
    token?: string
    paymentMethodId: string
    installments: number
    issuerId?: string
    payer: {
      email: string
      firstName?: string
      lastName?: string
      identification?: { type: string; number: string }
    }
  },
) {
  const { loadCredentials } = await import('@/services/mercado-pago/connection.service')
  const { createPayment, mpToCheckoutStatus } = await import('@/services/mercado-pago/payment.service')

  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    include: {
      ecommerceMerchant: { include: { provider: { select: { code: true } } } },
      paymentLink: true,
    },
  })
  if (!session) throw new NotFoundError('Sesión de pago no encontrada')
  if (session.status !== 'PENDING') {
    throw new BadRequestError(`Esta sesión ya fue procesada (status=${session.status})`)
  }
  if (session.paymentLink?.shortCode !== shortCode) {
    throw new BadRequestError('La sesión no pertenece a esta liga de pago')
  }
  await assertVenueSalesEnabled(session.paymentLink.venueId)
  if (session.ecommerceMerchant.provider?.code !== 'MERCADO_PAGO') {
    throw new BadRequestError('Esta sesión no usa Mercado Pago')
  }

  const creds = await loadCredentials(session.ecommerceMerchantId)
  if (!creds) {
    throw new BadRequestError('Credenciales de Mercado Pago no disponibles')
  }

  const amountMxn = Number(session.amount)
  const applicationFeeMxn = (session.applicationFeeCents ?? 0) / 100

  const payment = await createPayment({
    accessToken: creds.accessToken,
    token: input.token,
    paymentMethodId: input.paymentMethodId,
    installments: input.installments,
    issuerId: input.issuerId,
    orderId: session.sessionId, // becomes MP's external_reference
    amountMxn,
    applicationFeeMxn,
    description: session.description ?? 'Pago',
    payerEmail: input.payer.email,
    payerFirstName: input.payer.firstName,
    payerLastName: input.payer.lastName,
    payerIdentificationType: input.payer.identification?.type,
    payerIdentificationNumber: input.payer.identification?.number,
    idempotencyKey: session.sessionId,
  })

  // Map MP status → our CheckoutStatus for the optimistic update. The
  // webhook will confirm the authoritative state later.
  const optimisticStatus = mpToCheckoutStatus(payment.status)

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      mpPaymentId: String(payment.id),
      status: optimisticStatus,
      completedAt: optimisticStatus === 'COMPLETED' ? new Date() : null,
    },
  })

  // Record the Payment + Order now if the charge is already approved. The MP
  // IPN webhook does the same on its authoritative callback — both are
  // idempotent (unique Payment.idempotencyKey = mpPaymentId), so whichever
  // lands first wins. Non-fatal: the payment already succeeded on MP, so a
  // finalize hiccup must not fail the response — the IPN will reconcile.
  if (optimisticStatus === 'COMPLETED') {
    await finalizeMercadoPagoCheckout({ sessionId, mpPaymentId: payment.id, paymentTypeId: payment.payment_type_id }).catch(err =>
      logger.error('finalizeMercadoPagoCheckout failed (optimistic path)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  logger.info('MP Bricks payment created', {
    sessionId,
    paymentId: payment.id,
    status: payment.status,
    statusDetail: payment.status_detail,
  })

  return {
    paymentId: payment.id,
    status: payment.status,
    statusDetail: payment.status_detail,
    threeDsRedirectUrl: payment.three_ds_redirect_url,
  }
}

/**
 * Record the Order + Payment for a COMPLETED MercadoPago checkout — the MP
 * analogue of what `finalizePaymentLinkCheckout` does for Stripe. Without this,
 * MP payments charge the seller but never show up in the venue's /payments or
 * /orders (the bug seen in production: a $5 MP payment to a venue left no record).
 *
 * Works for BOTH payment-link and venue (data-venue widget) checkout sessions —
 * it branches on `session.paymentLink`. Called from two places, both idempotent:
 *  - `executeMercadoPagoPaymentForPaymentLink/ForVenue` (optimistic, on approval)
 *  - the MP IPN handler (authoritative, on webhook)
 *
 * Idempotency: guarded by `session.paymentId` (set once finalized) AND the
 * unique `Payment(venueId, idempotencyKey=mpPaymentId)` index — a duplicate
 * call throws P2002 and no-ops. Safe to call twice concurrently.
 */
/**
 * El método del cobro sale del `payment_type_id` de Mercado Pago (16-oct: un SPEI quedaba como tarjeta).
 * OXXO (`ticket`/`atm`) NO es CASH: varios lectores (conciliación, saldo disponible, dispersión, póliza, corte del turno)
 * deciden por `method === CASH` sin mirar `fundsFlow` y lo tratarían como efectivo del negocio (Codex r2). Va como OTHER con
 * forma SAT 01 sellada en `tenderSatFormaPago`: se factura como efectivo y todo lo demás lo trata como antes. El saldo de
 * Mercado Pago es dinero electrónico (SAT 06): sin el sello, DIGITAL_WALLET caería en '99' y bloquearía la factura.
 * Sin tipo (llamada que no lo trae) queda CREDIT_CARD, como antes; un tipo desconocido queda OTHER ('99', por revisar).
 */
export function metodoDeMercadoPago(paymentTypeId?: string | null): { method: PaymentMethod; tenderSatFormaPago: string | null } {
  if (!paymentTypeId) return { method: 'CREDIT_CARD', tenderSatFormaPago: null }
  const sellados: Record<string, { method: PaymentMethod; tenderSatFormaPago: string }> = {
    ticket: { method: 'OTHER', tenderSatFormaPago: '01' },
    atm: { method: 'OTHER', tenderSatFormaPago: '01' },
    account_money: { method: 'DIGITAL_WALLET', tenderSatFormaPago: '06' },
  }
  if (sellados[paymentTypeId]) return sellados[paymentTypeId]
  const metodos: Record<string, PaymentMethod> = {
    credit_card: 'CREDIT_CARD',
    debit_card: 'DEBIT_CARD',
    prepaid_card: 'DEBIT_CARD',
    bank_transfer: 'BANK_TRANSFER',
  }
  return { method: metodos[paymentTypeId] ?? 'OTHER', tenderSatFormaPago: null }
}

export async function finalizeMercadoPagoCheckout(args: {
  sessionId: string
  mpPaymentId: string | number
  paymentTypeId?: string | null
}): Promise<void> {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId: args.sessionId },
    include: {
      ecommerceMerchant: { select: { id: true, venueId: true } },
      // `purpose` decide si la venta trae productos: sin él, TODO cobro por
      // MercadoPago se guardaba como entrada manual sin renglones.
      // La primera persona atribuida (por fecha, como las otras ligas) queda como quien cobró (FT-GRAVES T2).
      paymentLink: {
        select: {
          id: true,
          venueId: true,
          createdById: true,
          purpose: true,
          attributions: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        },
      },
    },
  })
  if (!session) {
    logger.warn('⚠️ [MP FINALIZE] No checkout session found', { sessionId: args.sessionId })
    return
  }
  if (session.paymentId) return // already finalized — idempotent no-op

  const isLink = !!session.paymentLink
  const venueId = session.paymentLink?.venueId ?? session.ecommerceMerchant.venueId
  // FT-GRAVES T2: igual que las ligas por Stripe y Blumon — la primera persona atribuida queda como quien cobró y la comisión se
  // congela con el cobro, repartida entre todas. Sin atribución (o checkout sin liga) no hay comisión: no se inventa a quién.
  const attributedStaffIds = (session.paymentLink?.attributions ?? []).map(a => a.staffId)
  // session.amount already includes the tip; split it out so the Order/Payment
  // report the tip separately, mirroring finalizePaymentLinkCheckout (Stripe).
  const metadata = (session.metadata ?? {}) as Record<string, any>
  const gross = session.amount
  const tipAmount = new Prisma.Decimal(metadata.tipAmount || 0)
  const subtotal = gross.sub(tipAmount).gte(0) ? gross.sub(tipAmount) : new Prisma.Decimal(0)
  // Con descuento: la orden lleva la base y el descuento; el cobro, la lealtad y la comisión siguen sobre `subtotal` (el neto).
  const descuentoDeLiga = isLink ? descuentoDeLaSesion(metadata, subtotal, session.sessionId) : null
  const feeAmount = session.applicationFeeCents ? new Prisma.Decimal(session.applicationFeeCents).div(100) : new Prisma.Decimal(0)
  const netAmount = subtotal.sub(feeAmount).gte(0) ? subtotal.sub(feeAmount) : new Prisma.Decimal(0)
  const feePercentage = subtotal.gt(0) ? feeAmount.div(subtotal).toDecimalPlaces(4) : new Prisma.Decimal(0)
  const processorId = String(args.mpPaymentId)
  // Snapshot de renglones congelado al crear la intención de pago — el mismo
  // que usan los caminos Stripe y Blumon. Sin esto, una liga de PRODUCTOS
  // pagada con MercadoPago se guardaba sin renglones: cero inventario y la
  // venta contada como entrada manual (que los reportes operativos filtran).
  const sessionItems: BundleItemSnapshot[] = Array.isArray(metadata.items) ? metadata.items : []
  const isItemLink = isLink && session.paymentLink!.purpose === 'ITEM' && sessionItems.length > 0

  let orderIdForReferral: string | null = null
  let postingId: string | null = null
  // Cliente registrado detrás del cobro (si lo hay). Aquí cubre TAMBIÉN el
  // checkout directo sin liga: es la misma función y el mismo `Order` COMPLETED,
  // y la regla es "acumula en cualquier venta con cliente" — excluirlo habría
  // pedido una excepción que nadie pidió.
  const loyaltyCustomerId = await resolvePaymentLinkCustomerId(
    venueId,
    session.customerEmail,
    session.customerPhone,
    session.attributedCustomerId,
  )
  try {
    await prisma.$transaction(async tx => {
      // Re-check inside the tx so two concurrent finalizers (optimistic + IPN)
      // can't both create an Order.
      const fresh = await tx.checkoutSession.findUnique({ where: { id: session.id }, select: { paymentId: true } })
      if (fresh?.paymentId) return

      // 🔴 NO se estampa `shiftId`, y es DELIBERADO — no lo "arregles".
      //
      // Quien paga es el CLIENTE desde su teléfono, cuando quiere: este código corre en un webhook
      // del procesador, no en el mostrador. `createdById` es quien CREÓ LA LIGA, a veces días antes.
      // Estampar «el turno abierto ahora» metería en el corte de un cajero una venta en la que no
      // participó —y una liga pagada de madrugada caería en el turno que alguien dejó abierto—.
      // El dinero SÍ llega al turno correcto por otra vía: `Payment.shiftId` lo resuelve el camino
      // del cobro. Guardado por `tests/unit/services/dashboard/paymentLink.sinTurno.test.ts`.
      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber: `${isLink ? 'PL' : 'VC'}-${Date.now()}`,
          type: isItemLink ? 'TAKEOUT' : 'MANUAL_ENTRY',
          source: isLink ? 'PAYMENT_LINK' : 'WEB',
          createdById: session.paymentLink?.createdById ?? undefined,
          ...(loyaltyCustomerId ? { customerId: loyaltyCustomerId } : {}),
          customerEmail: session.customerEmail,
          subtotal: descuentoDeLiga ? new Prisma.Decimal(descuentoDeLiga.base) : subtotal,
          discountAmount: descuentoDeLiga ? new Prisma.Decimal(descuentoDeLiga.descuento) : 0,
          taxAmount: 0,
          contratoDePrecio: 'IVA_INCLUIDO',
          tipAmount,
          total: gross,
          paidAmount: gross,
          remainingBalance: 0,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          completedAt: new Date(),
          ...(isItemLink && {
            items: {
              create: sessionItems.map(it => {
                const mods = it.modifiers ?? []
                const modSumPerUnit = mods.reduce((s, m) => s + m.price * m.quantity, 0)
                const lineTotal = new Prisma.Decimal(it.unitPrice + modSumPerUnit).mul(it.quantity)
                return {
                  productId: it.productId,
                  productName: it.productName,
                  quantity: it.quantity,
                  unitPrice: new Prisma.Decimal(it.unitPrice),
                  discountAmount: 0,
                  taxAmount: 0,
                  total: lineTotal,
                  modifiers:
                    mods.length > 0
                      ? {
                          create: mods.map(m => ({
                            modifierId: m.modifierId,
                            name: m.modifierName,
                            quantity: m.quantity,
                            price: new Prisma.Decimal(m.price),
                          })),
                        }
                      : undefined,
                }
              }),
            },
          }),
        },
        include: { items: { include: { modifiers: { include: { modifier: true } } } } },
      })

      // El descuento de la liga es su fila de CUENTA, repartida entre los renglones, y un uso del descuento del catálogo.
      if (descuentoDeLiga) {
        const discountId = await contarUsoDelDescuento(tx, venueId, descuentoDeLiga.foto.discountId)
        await tx.orderDiscount.create({
          data: filaDeDescuentoDeLiga({
            orderId: order.id,
            foto: { ...descuentoDeLiga.foto, discountId },
            montoPesos: descuentoDeLiga.descuento,
            basePesos: descuentoDeLiga.base,
          }),
        })
        await sincronizarRepartos(tx, order.id)
      }

      // Vale durable de inventario, atómico con la orden PAID (igual que
      // Stripe/Blumon). Para un cobro de puro monto nace SKIPPED, que es lo que
      // mantiene el invariante "orden PAID ⟺ vale existe".
      const posting = await createSalePostingInTx(tx, {
        venueId,
        orderId: order.id,
        items: (order.items ?? []) as any,
        staffId: session.paymentLink?.createdById ?? null,
      })
      postingId = posting?.id ?? null

      const createdPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: order.id,
          ecommerceMerchantId: session.ecommerceMerchant.id,
          amount: subtotal,
          tipAmount,
          ...metodoDeMercadoPago(args.paymentTypeId),
          // Lo liquida Mercado Pago, nunca el cajón (igual que Stripe): sin el sello, una devolución SPEI no se descontaba en
          // la conciliación bancaria (la devolución hereda este valor).
          fundsFlow: 'AVOQADO_PROCESSED',
          source: 'WEB',
          status: 'COMPLETED',
          // FAST significa "sin inventario ni cumplimiento operativo"; una
          // venta de productos sí los tiene, igual que en Stripe y Blumon.
          type: isItemLink ? 'REGULAR' : 'FAST',
          processor: 'mercadopago',
          processorId,
          processedById: attributedStaffIds[0] ?? undefined,
          feePercentage,
          feeAmount,
          netAmount,
          idempotencyKey: processorId,
        },
        select: { id: true },
      })
      if (attributedStaffIds.length > 0) await enqueuePaymentCommissionInTx(tx, createdPayment.id, attributedStaffIds)
      // R8: activar sobres va DESPUÉS del Payment (compara lo cobrado). Las ligas venden catálogo: hoy no encuentra sobres.
      await activarSobresDeCuentaPagadaEnTx(tx, {
        venueId,
        orderId: order.id,
        staffId: session.paymentLink?.createdById ?? null,
        items: (order.items ?? []) as Array<{ giftCardId?: string | null }>,
      })

      await tx.checkoutSession.update({ where: { id: session.id }, data: { paymentId: createdPayment.id } })

      if (isLink) {
        await tx.paymentLink.update({
          where: { id: session.paymentLink!.id },
          data: { totalCollected: { increment: gross }, paymentCount: { increment: 1 } },
        })
      }

      orderIdForReferral = order.id
      // La comisión se congela en esta transacción: el mismo tope de 10 s que las otras ligas y la terminal.
    }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

    // Aplicar el vale YA COMMITEADO el cobro. Nunca puede tumbar una venta
    // cobrada: si truena, el posting queda pendiente y el sweeper lo retoma.
    if (postingId) {
      try {
        await applySalePosting(postingId, session.paymentLink?.createdById ?? null)
      } catch (deductionError: any) {
        logger.error('Failed to apply inventory posting for MercadoPago checkout', {
          sessionId: args.sessionId,
          postingId,
          error: deductionError?.message ?? String(deductionError),
        })
      }
    }

    // REFERRAL HOOK: trigger referral qualification if this paid order has a pending referral
    if (orderIdForReferral) {
      try {
        const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
        await onOrderPaid({ orderId: orderIdForReferral, venueId })
      } catch (err) {
        console.error('[referral hook] onOrderPaid failed for order', orderIdForReferral, err)
      }
    }

    // LEALTAD + MÉTRICAS DEL CLIENTE. `orderIdForReferral` sólo queda sellado
    // cuando ESTA invocación creó la orden — una reentrega del IPN sale por el
    // `paymentId` ya sellado y no llega aquí con orden nueva.
    if (loyaltyCustomerId && orderIdForReferral) {
      await creditPaymentLinkCustomer({
        venueId,
        customerId: loyaltyCustomerId,
        orderId: orderIdForReferral,
        amount: subtotal,
        channel: 'mercadopago',
      })
    }

    logger.info('MercadoPago checkout finalized (Order + Payment recorded)', {
      sessionId: args.sessionId,
      mpPaymentId: processorId,
      venueId,
      isLink,
    })
  } catch (err: any) {
    // Only the Payment idempotencyKey collision means "already finalized".
    // Any OTHER unique violation is a real bug — surface it, don't mask it as
    // a successful no-op.
    const target = err?.meta?.target
    const isIdempotencyCollision =
      err?.code === 'P2002' && (Array.isArray(target) ? target.includes('idempotencyKey') : String(target ?? '').includes('idempotencyKey'))
    if (isIdempotencyCollision) {
      logger.info('ℹ️ [MP FINALIZE] Duplicate finalize ignored (idempotent)', { sessionId: args.sessionId, mpPaymentId: processorId })
      return
    }
    throw err
  }
}
