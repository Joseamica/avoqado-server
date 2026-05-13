/**
 * Payment Link Service
 *
 * Manages payment link CRUD operations for the dashboard.
 * Payment links allow venues to generate shareable URLs for collecting payments.
 *
 * @module services/dashboard/paymentLink
 */

import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import logger from '@/config/logger'
import { nanoid } from 'nanoid'
import { logAction } from './activity-log.service'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { getProvider } from '@/services/payments/provider-registry'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '@/services/payments/providers/money'
import { getVatRateBps } from '@/services/superadmin/platformSettings.service'
import emailService from '@/services/email.service'
import { formatInTimeZone } from 'date-fns-tz'
import { es as esLocale } from 'date-fns/locale'
import { createCommissionForPayment, createSplitCommissionForPayment } from '@/services/dashboard/commission/commission-calculation.service'

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

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS (items with modifiers)
// ═══════════════════════════════════════════════════════════════════════════

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
}

export interface UpdatePaymentLinkData {
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

/**
 * Creates a new payment link for a venue
 */
export async function createPaymentLink(venueId: string, data: CreatePaymentLinkData, staffId: string) {
  // 1. Resolve the ecommerce merchant (channel) to attach the link to.
  //
  // Two paths:
  //   A. Caller specifies `ecommerceMerchantId` → use it but verify it
  //      belongs to this venue and is active. Lets the user pick when there
  //      are multiple active channels (e.g. Stripe + Blumon).
  //   B. Not specified → keep legacy auto-pick (Blumon first because of
  //      OAuth token setup, then any active merchant). Used by venues with
  //      a single channel where the UI can skip the picker.
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
    ecommerceMerchant =
      (await prisma.ecommerceMerchant.findFirst({
        where: { venueId, active: true, provider: { code: 'BLUMON' } },
        select: { id: true },
      })) ||
      (await prisma.ecommerceMerchant.findFirst({
        where: { venueId, active: true },
        select: { id: true },
      }))
  }

  if (!ecommerceMerchant) {
    throw new BadRequestError('Este venue no tiene una afiliación de e-commerce activa. Contacta a soporte para activarla.')
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
  const paymentLink = await prisma.paymentLink.create({
    data: {
      shortCode,
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
    },
    include: {
      createdBy: {
        select: { id: true, firstName: true, lastName: true },
      },
      _count: {
        select: { checkoutSessions: true },
      },
    },
  })

  logger.info('Payment link created', {
    paymentLinkId: paymentLink.id,
    shortCode,
    venueId,
    amountType: data.amountType,
  })

  logAction({
    venueId,
    staffId,
    action: 'PAYMENT_LINK_CREATED',
    entity: 'PaymentLink',
    entityId: paymentLink.id,
  })

  return paymentLink
}

/**
 * Lists payment links for a venue with filtering
 */
export async function getPaymentLinks(venueId: string, filters: ListPaymentLinksFilters = {}) {
  const { status, search, limit = 20, offset = 0 } = filters

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
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        _count: {
          select: { checkoutSessions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.paymentLink.count({ where }),
  ])

  return {
    paymentLinks,
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

  return paymentLink
}

/**
 * Updates a payment link
 */
export async function updatePaymentLink(venueId: string, linkId: string, data: UpdatePaymentLinkData) {
  const existing = await prisma.paymentLink.findUnique({
    where: { id: linkId },
    select: { id: true, venueId: true, status: true },
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

  const updateData: Prisma.PaymentLinkUpdateInput = {}

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

  // Wrap the metadata update + items replacement in a transaction so the
  // rows are atomic — partial state would confuse the customer checkout.
  // Nested modifier rows can't be inserted via createMany (Prisma limitation),
  // so we loop and use create() per item which accepts the nested write.
  const updated = await prisma.$transaction(async tx => {
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
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { checkoutSessions: true } },
      },
    })
  })

  logger.info('Payment link updated', { paymentLinkId: linkId, venueId })

  logAction({
    venueId,
    action: 'PAYMENT_LINK_UPDATED',
    entity: 'PaymentLink',
    entityId: linkId,
  })

  return updated
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
function mergeBranding(raw: unknown): PaymentLinkBranding {
  if (!raw || typeof raw !== 'object') return DEFAULT_PAYMENT_LINK_BRANDING
  const stored = raw as Partial<PaymentLinkBranding>
  return {
    showLogo: stored.showLogo ?? DEFAULT_PAYMENT_LINK_BRANDING.showLogo,
    buttonColor: stored.buttonColor ?? DEFAULT_PAYMENT_LINK_BRANDING.buttonColor,
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
    select: { paymentLinkBranding: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')
  return mergeBranding(venue.paymentLinkBranding)
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
  //  - 'STRIPE_HOSTED': customer is redirected to Stripe's hosted checkout; no
  //    card form on Avoqado's side. Avoqado collects an application_fee on
  //    every charge (set by `platformFeeBps` on the merchant).
  //  - 'INLINE_CARD': legacy Blumon flow — Avoqado tokenizes the card inline
  //    and authorizes the charge directly.
  const paymentMethod: 'STRIPE_HOSTED' | 'INLINE_CARD' =
    paymentLink.ecommerceMerchant.provider?.code === 'STRIPE_CONNECT' ? 'STRIPE_HOSTED' : 'INLINE_CARD'

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
    },
    // Branding overrides for this checkout. Always merged with defaults so
    // the customer-facing page never has to handle null/undefined fields.
    branding: mergeBranding(paymentLink.venue.paymentLinkBranding),
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

  // 1. Resolve charge amount.
  //
  // For ITEM purpose this is the FIXED bundle total: sum(qty × price). The
  // `input.quantity` parameter is ignored — the bundle defines its own
  // quantities. For PAYMENT/DONATION links we honor the legacy single-amount
  // flow (FIXED uses `paymentLink.amount`, OPEN uses `input.amount`).
  let chargeAmount: number
  if (paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0) {
    chargeAmount = computeBundleTotal(paymentLink.items)
  } else if (paymentLink.amountType === 'FIXED') {
    chargeAmount = Number(paymentLink.amount)
  } else {
    if (!input.amount || input.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    chargeAmount = input.amount
  }

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

  // 3. Tip
  const tipAmount = input.tipAmount && input.tipAmount > 0 ? input.tipAmount : 0
  const tippingConfig = paymentLink.tippingConfig as TippingConfig | null
  if (tipAmount > 0 && !tippingConfig) {
    throw new BadRequestError('Esta liga de pago no acepta propinas')
  }
  chargeAmount = chargeAmount + tipAmount

  // 4. Stripe amount + fee
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  const bounds = getStripeChargeBounds()
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

  return {
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
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
function mapStripeMethodToPaymentMethod(
  stripeType: string | null | undefined,
): 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET' | 'BANK_TRANSFER' | 'CRYPTOCURRENCY' | 'OTHER' {
  if (!stripeType) return 'CREDIT_CARD'
  // OXXO: customer pays cash at OXXO. We map to CASH because that's what
  // hit the merchant's bank — even though the rail is "voucher".
  if (stripeType === 'oxxo') return 'CASH'
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
    },
  })

  if (!session || !session.paymentLink) {
    logger.warn('⚠️ [STRIPE PAYMENT-LINK WEBHOOK] No payment-link session found for Stripe session', {
      stripeSessionId: args.stripeSessionId,
    })
    return
  }

  if (session.status === 'COMPLETED') {
    // Already processed — webhook retry. No-op.
    return
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
  const stripePaymentIntentId = args.paymentIntentId ?? null

  // Capture the Payment we create inside the transaction so we can fire the
  // commission calculation AFTER the tx commits. Doing it inside the tx is
  // risky — the commission service does its own DB writes and we'd nest
  // transactions / hold locks longer than needed.
  const attributedStaffIds = session.paymentLink.attributions.map(a => a.staffId)
  const primaryStaffId = attributedStaffIds[0] ?? null // for Payment.processedById
  let paymentIdForCommission: string | null = null

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

    const order = await tx.order.create({
      data: {
        venueId,
        orderNumber: `PL-${Date.now()}`,
        type: isPaymentOrDonation ? 'MANUAL_ENTRY' : 'TAKEOUT',
        source: 'PAYMENT_LINK',
        createdById: session.paymentLink!.createdById,
        customerName: session.customerName,
        customerEmail: session.customerEmail,
        subtotal: subtotal.lt(0) ? new Prisma.Decimal(0) : subtotal,
        discountAmount: 0,
        taxAmount: 0,
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
    })

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

    // Map Stripe's payment_method.type to our PaymentMethod enum — keeps
    // OXXO ledgered as CASH, SPEI as BANK_TRANSFER, etc. instead of every-
    // thing falling into CREDIT_CARD. Useful for revenue breakdowns later.
    const method = mapStripeMethodToPaymentMethod(args.stripePaymentMethodType)

    const createdPayment = await tx.payment.create({
      data: {
        venueId,
        orderId: order.id,
        // Commission attribution. Payment.processedById gets the FIRST
        // attributed staff (used by receipts/reports as the "named seller").
        // The full split — 1/N per staff when there are multiple — is
        // applied later by createSplitCommissionForPayment, which reads
        // the attributions join table directly. When the link has no
        // attributions we leave processedById NULL and skip commission.
        processedById: primaryStaffId ?? undefined,
        amount: grossForPayment,
        tipAmount,
        method,
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
        // Idempotency: PaymentIntent IDs are already unique per Stripe;
        // reuse as the key so duplicate webhooks (if they ever bypass the
        // ProcessedStripeEvent guard) still no-op via the unique index.
        idempotencyKey: stripePaymentIntentId ?? undefined,
      },
      select: { id: true },
    })
    paymentIdForCommission = createdPayment.id
  })

  // Fire-and-forget commission calculation. Mirrors how the TPV flow does it
  // (payment.tpv.service.ts:1813) — async so the webhook ack isn't blocked
  // by commission logic, and errors are logged but never bubble up to fail
  // the webhook. Branching:
  //   • 0 attributions → skip entirely.
  //   • 1 attribution  → regular createCommissionForPayment (reads
  //     processedById, respects config.recipient enum). Keeps the single
  //     -recipient code path identical to TPV.
  //   • 2+ attributions → createSplitCommissionForPayment writes N rows
  //     directly, bypassing the recipient enum + the paymentId idempotency
  //     guard (which only allows 1 calc per payment).
  if (paymentIdForCommission && attributedStaffIds.length > 0) {
    const target = paymentIdForCommission
    const promise =
      attributedStaffIds.length === 1 ? createCommissionForPayment(target) : createSplitCommissionForPayment(target, attributedStaffIds)
    promise.catch(err => {
      logger.error('Failed to create commission for payment-link payment', {
        paymentId: target,
        staffCount: attributedStaffIds.length,
        shortCode: session.paymentLink?.shortCode,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // 4. Inventory deduction outside the transaction (best-effort, matches
  //    Blumon's completeCharge behavior). Loop through each bundle line —
  //    deduct quantity × productId independently. We swallow per-product
  //    errors so one bad line doesn't block the others.
  if (isItemLink) {
    for (const it of sessionItems) {
      try {
        await deductInventoryForProduct(venueId, it.productId, it.quantity, session.sessionId)
      } catch (deductionError: any) {
        logger.error('Failed to deduct inventory for Stripe payment-link bundle item', {
          paymentLinkId: session.paymentLink.id,
          productId: it.productId,
          quantity: it.quantity,
          error: deductionError.message,
        })
      }
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
      select: { name: true, timezone: true },
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
  const dashboardUrl = `${dashboardOrigin}/venues/${args.venueId}/payment-links/${args.paymentLinkId}`

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

  // 1. Resolve charge amount. Bundle ITEM links use sum(qty × price) and
  // ignore the legacy `input.quantity` parameter.
  let chargeAmount: number
  if (paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0) {
    chargeAmount = computeBundleTotal(paymentLink.items)
  } else if (paymentLink.amountType === 'FIXED') {
    chargeAmount = Number(paymentLink.amount)
  } else {
    if (!input.amount || input.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    chargeAmount = input.amount
  }

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

  // 3. Add tip (validated against tipping config)
  const tipAmount = input.tipAmount && input.tipAmount > 0 ? input.tipAmount : 0
  const tippingConfig = paymentLink.tippingConfig as TippingConfig | null
  if (tipAmount > 0 && !tippingConfig) {
    throw new BadRequestError('Esta liga de pago no acepta propinas')
  }
  chargeAmount = chargeAmount + tipAmount

  // 4. Compute Stripe amount + fee. Bounds check protects against pennies
  //    (Stripe rejects sub-$10 MXN) and absurdly large amounts.
  const stripeAmount = toStripeAmount(new Prisma.Decimal(chargeAmount))
  const bounds = getStripeChargeBounds()
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

  // 2. Determine amount. Bundle ITEM links sum all line items; legacy single-
  // amount semantics remain for PAYMENT/DONATION links.
  let chargeAmount: number

  if (paymentLink.purpose === 'ITEM' && paymentLink.items.length > 0) {
    chargeAmount = computeBundleTotal(paymentLink.items)
  } else if (paymentLink.amountType === 'FIXED') {
    chargeAmount = Number(paymentLink.amount)
  } else {
    if (!cardData.amount || cardData.amount <= 0) {
      throw new BadRequestError('El monto es requerido para esta liga de pago')
    }
    chargeAmount = cardData.amount
  }

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

  // 2c. Calculate tip amount
  const tipAmount = cardData.tipAmount && cardData.tipAmount > 0 ? cardData.tipAmount : 0
  const tippingConfig = paymentLink.tippingConfig as TippingConfig | null
  if (tipAmount > 0 && !tippingConfig) {
    throw new BadRequestError('Esta liga de pago no acepta propinas')
  }

  // Add tip to total charge amount
  chargeAmount = chargeAmount + tipAmount

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

  if (session.status !== 'PROCESSING') {
    throw new BadRequestError(
      session.status === 'COMPLETED' ? 'Este pago ya fue procesado' : `No se puede cobrar una sesión con estado ${session.status}`,
    )
  }

  // 2. Extract card token from metadata
  const metadata = session.metadata as Record<string, any>
  const cardToken = metadata?.cardToken
  const cvv = metadata?.cvv

  if (!cardToken) {
    throw new BadRequestError('Token de tarjeta no encontrado en la sesión')
  }

  // 3. Resolve provider and charge
  const provider = getProvider(session.ecommerceMerchant)
  const chargeResult = await provider.authorizeCardPayment(session.ecommerceMerchant, {
    amount: Number(session.amount),
    currency: session.currency === 'MXN' ? '484' : session.currency,
    cardToken,
    cvv,
    orderId: session.sessionId,
  })

  // 4. Update session and payment link + create Order for ITEM links.
  // Bundle line items were snapshotted onto CheckoutSession.metadata at
  // session creation, so we can replay OrderItem creation safely even if
  // the link was edited between checkout and charge completion.
  const sessionItems: BundleItemSnapshot[] = Array.isArray(metadata.items) ? metadata.items : []
  const isItemLink = session.paymentLink!.purpose === 'ITEM' && sessionItems.length > 0
  const venueId = session.paymentLink!.venueId

  // Commission attribution (parallels finalizePaymentLinkCheckout). The first
  // attributed staff is the "named seller" on Payment.processedById; if 2+
  // attributions the commission gets split equally after the tx commits.
  const attributedStaffIds = session.paymentLink!.attributions.map(a => a.staffId)
  const primaryStaffId = attributedStaffIds[0] ?? null
  let paymentIdForCommission: string | null = null

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
      const subtotal = isItemLink
        ? sessionItems.reduce((sum, it) => {
            const modSumPerUnit = (it.modifiers ?? []).reduce((s, m) => s + m.price * m.quantity, 0)
            return sum.add(new Prisma.Decimal(it.unitPrice + modSumPerUnit).mul(it.quantity))
          }, new Prisma.Decimal(0))
        : session.amount.sub(orderTipAmount)
      const taxAmount = new Prisma.Decimal(0) // Tax included in price for payment links
      const total = subtotal.add(orderTipAmount)

      const orderNumber = `PL-${Date.now()}`

      const order = await tx.order.create({
        data: {
          venueId,
          orderNumber,
          type: isItemLink ? 'TAKEOUT' : 'MANUAL_ENTRY',
          source: 'PAYMENT_LINK',
          createdById: session.paymentLink!.createdById,
          customerName: session.customerName,
          customerEmail: session.customerEmail,
          subtotal,
          discountAmount: 0,
          taxAmount,
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
      })

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
          amount: subtotal,
          tipAmount: orderTipAmount,
          method: 'CREDIT_CARD',
          source: 'WEB',
          status: 'COMPLETED',
          type: isItemLink ? 'REGULAR' : 'FAST',
          processor: 'blumon',
          processorId: chargeResult.transactionId,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: subtotal,
          idempotencyKey: chargeResult.transactionId,
        },
        select: { id: true },
      })
      paymentIdForCommission = createdPayment.id
    }
  })

  // Fire-and-forget commission calculation (matches the Stripe webhook flow).
  // 0 attributions → skip · 1 → regular createCommissionForPayment · 2+ →
  // createSplitCommissionForPayment.
  if (paymentIdForCommission && attributedStaffIds.length > 0) {
    const target = paymentIdForCommission
    const promise =
      attributedStaffIds.length === 1 ? createCommissionForPayment(target) : createSplitCommissionForPayment(target, attributedStaffIds)
    promise.catch(err => {
      logger.error('Failed to create commission for Blumon payment-link', {
        paymentId: target,
        staffCount: attributedStaffIds.length,
        shortCode: session.paymentLink?.shortCode,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // 5. Deduct inventory AFTER transaction (non-blocking, same pattern as TPV).
  // Loop through each bundle line independently. Per-line errors are logged
  // but don't abort the others.
  if (isItemLink) {
    for (const it of sessionItems) {
      try {
        await deductInventoryForProduct(venueId, it.productId, it.quantity, session.sessionId)
        logger.info('Inventory deducted for payment-link bundle item', {
          paymentLinkId: session.paymentLink!.id,
          productId: it.productId,
          quantity: it.quantity,
        })
      } catch (deductionError: any) {
        logger.error('Failed to deduct inventory for payment-link bundle item', {
          paymentLinkId: session.paymentLink!.id,
          productId: it.productId,
          quantity: it.quantity,
          error: deductionError.message,
        })

        const errorReason = deductionError.message.includes('Insufficient stock')
          ? 'INSUFFICIENT_STOCK'
          : deductionError.message.includes('does not have a recipe')
            ? 'NO_RECIPE'
            : 'UNKNOWN'

        if (errorReason !== 'NO_RECIPE') {
          logAction({
            venueId,
            action: 'INVENTORY_DEDUCTION_FAILED',
            entity: 'Order',
            entityId: session.sessionId,
            data: {
              source: 'PAYMENT_LINK',
              productId: it.productId,
              productName: it.productName,
              quantity: it.quantity,
              reason: errorReason,
              error: deductionError.message,
              paymentLinkId: session.paymentLink!.id,
            },
          })
        }
      }
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
 * Gets the status of a checkout session (for polling after 3DS)
 */
export async function getSessionStatus(shortCode: string, sessionId: string) {
  const session = await prisma.checkoutSession.findUnique({
    where: { sessionId },
    select: {
      sessionId: true,
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

  return {
    sessionId: session.sessionId,
    status: session.status,
    amount: session.amount,
    currency: session.currency,
    completedAt: session.completedAt,
    errorMessage: session.errorMessage,
    redirectUrl: session.paymentLink?.redirectUrl,
  }
}
