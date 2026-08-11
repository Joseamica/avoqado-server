/**
 * Vales por área v7.
 *
 * A diferencia del flujo legacy (`areaTicket.mobile.service.ts`), emitir un vale
 * NO crea una Order. Cada área emite un AreaTicket inmutable; caja agrupa claims
 * en AreaTicketCheckoutSession y materializa una Order normal una sola vez.
 *
 * Jerarquía de locks (no invertir):
 *
 *   checkout session → area tickets (id asc) → order → payment attempt
 *   inventory targets (kind + id asc) se bloquean sólo durante emisión/consumo
 *
 * Las rutas legacy se conservan para clientes desplegados. Este archivo es la
 * autoridad del contrato v7.
 */

import { createHash, randomInt } from 'node:crypto'
import {
  AreaSettlementRoute,
  AreaTicketCheckoutStatus,
  AreaTicketDeliveryVerificationMode,
  AreaTicketExternalHandoffState,
  AreaTicketExternalSettlementStatus,
  AreaTicketFulfillmentMethod,
  AreaTicketInventoryReservationMode,
  AreaTicketInventoryReservationStatus,
  AreaTicketInventoryTarget,
  AreaTicketPaymentAttemptStatus,
  AreaTicketPrintAttemptKind,
  AreaTicketPrintAttemptStatus,
  AreaTicketStatus,
  FulfillmentMode,
  MovementType,
  PaymentMethod,
  Prisma,
  RawMaterialMovementType,
} from '@prisma/client'

import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { areaTicketCheckDigit } from '../../lib/areaTicketCode'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { logAction } from '../dashboard/activity-log.service'
import { createStockBatch } from '../dashboard/fifoBatch.service'
import { convertUnit } from '../../utils/unitConversion'
import prisma from '../../utils/prismaClient'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { buildOrderItemsData, CreateOrderItemInput } from './order.mobile.service'

const DEFAULT_CLAIM_TTL_SECONDS = 300
const DEFAULT_SESSION_MAX_AGE_MINUTES = 30
const MAX_PAGE_SIZE = 100

type DbClient = Prisma.TransactionClient | typeof prisma

export interface AreaTicketLineInput {
  clientLineId: string
  productId: string
  quantity: string
  weightKg?: string | null
  notes?: string | null
  modifierIds?: string[]
  discountId?: string | null
}

export interface IssueAreaTicketInput {
  idempotencyKey: string
  deviceUid: string
  staffId?: string | null
  lines: AreaTicketLineInput[]
}

export interface CreateCheckoutInput {
  idempotencyKey: string
  deviceUid: string
  staffId?: string | null
}

export interface CheckoutMutationInput {
  idempotencyKey: string
  deviceUid: string
  staffId?: string | null
}

export interface MaterializeCheckoutInput extends CheckoutMutationInput {
  normalItems?: CreateOrderItemInput[]
  source?: 'AVOQADO_IOS' | 'AVOQADO_ANDROID' | 'TPV' | 'POS'
  customerName?: string | null
  note?: string | null
}

export interface PreparePaymentInput extends CheckoutMutationInput {
  amount: string
  method: PaymentMethod
}

export interface RecordPrintAttemptInput extends CheckoutMutationInput {
  status: AreaTicketPrintAttemptStatus
  kind: AreaTicketPrintAttemptKind
  reason?: string | null
  errorCode?: string | null
}

export interface FulfillAreaTicketInput extends CheckoutMutationInput {
  method: AreaTicketFulfillmentMethod
}

export interface CancelAreaTicketInput extends CheckoutMutationInput {
  reason: string
}

interface SnapshotModifier {
  modifierId: string
  name: string
  quantity: number
  price: string
}

interface SnapshotLine {
  clientLineId: string
  productId: string | null
  productNameSnapshot: string
  skuSnapshot: string | null
  categoryNameSnapshot: string | null
  modifiersSnapshot: SnapshotModifier[]
  quantity: string
  weightKg: string | null
  unitPrice: string
  discountAmount: string
  appliedDiscountId: string | null
  taxAmount: string
  total: string
  notes: string | null
}

interface ReservationSpec {
  lineIndex: number
  inventoryKind: AreaTicketInventoryTarget
  inventoryId: string
  quantityBaseUnits: Prisma.Decimal
  label: string
}

const ticketInclude = {
  fulfillmentArea: { select: { id: true, name: true, fulfillmentMode: true } },
  sourceTerminal: { select: { id: true, name: true } },
  lines: {
    include: { orderItem: { select: { id: true } } },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
  fulfillment: {
    include: {
      deliveredByStaff: { select: { firstName: true, lastName: true } },
      terminal: { select: { id: true, name: true } },
    },
  },
  // null en la ruta AVOQADO — issueAreaTicket sólo crea el settlement cuando el área
  // es EXTERNAL (ver isExternal).
  externalSettlement: true,
} satisfies Prisma.AreaTicketInclude

const checkoutInclude = {
  terminal: { select: { id: true, name: true } },
  tickets: {
    include: ticketInclude,
    orderBy: [{ issuedAt: 'asc' as const }, { id: 'asc' as const }],
  },
  paymentAttempts: { orderBy: { sequence: 'asc' as const } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      paidAmount: true,
      remainingBalance: true,
      total: true,
      areaDeliveryCode: true,
      status: true,
    },
  },
} satisfies Prisma.AreaTicketCheckoutSessionInclude

function domainError(statusCode: number, code: string, message: string, details?: unknown): AppError {
  return new AppError(message, statusCode, true, code, details)
}

function checkoutStatusIn(status: AreaTicketCheckoutStatus, allowed: AreaTicketCheckoutStatus[]): boolean {
  return allowed.includes(status)
}

function assertDeliveryMethodAllowed(verificationMode: AreaTicketDeliveryVerificationMode, method: AreaTicketFulfillmentMethod): void {
  const allowed =
    verificationMode === AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN ||
    (verificationMode === AreaTicketDeliveryVerificationMode.PAPER_CONFIRMATION &&
      method === AreaTicketFulfillmentMethod.PAPER_CONFIRMATION) ||
    (verificationMode === AreaTicketDeliveryVerificationMode.RECEIPT_SCAN && method === AreaTicketFulfillmentMethod.RECEIPT_SCAN)
  if (allowed) return
  throw domainError(
    409,
    'AREA_TICKET_DELIVERY_METHOD_NOT_ALLOWED',
    method === AreaTicketFulfillmentMethod.RECEIPT_SCAN
      ? 'Este local no permite confirmar entregas escaneando el comprobante.'
      : 'Este local no permite confirmar entregas con el vale de papel.',
  )
}

function requireIdempotencyKey(value: string | null | undefined): string {
  const key = value?.trim()
  if (!key || key.length > 64) {
    throw new BadRequestError('idempotencyKey es requerido y debe tener máximo 64 caracteres.')
  }
  return key
}

function money(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed(2)
}

function quantity(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed(3)
}

function parsePositiveDecimal(value: string, field: string, scale: number): Prisma.Decimal {
  const raw = value?.trim()
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new BadRequestError(`${field} debe ser un decimal positivo.`)
  }
  const parsed = new Prisma.Decimal(raw)
  if (!parsed.isPositive()) {
    throw new BadRequestError(`${field} debe ser mayor que cero.`)
  }
  return parsed.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP)
}

function canonicalSnapshotHash(currency: string, lines: SnapshotLine[]): string {
  const canonical = {
    version: 1,
    currency,
    lines: lines.map(line => ({
      productId: line.productId,
      productNameSnapshot: line.productNameSnapshot,
      skuSnapshot: line.skuSnapshot,
      categoryNameSnapshot: line.categoryNameSnapshot,
      modifiersSnapshot: line.modifiersSnapshot.map(modifier => ({
        modifierId: modifier.modifierId,
        name: modifier.name,
        quantity: modifier.quantity,
        price: money(modifier.price),
      })),
      quantity: quantity(line.quantity),
      weightKg: line.weightKg == null ? null : quantity(line.weightKg),
      unitPrice: money(line.unitPrice),
      discountAmount: money(line.discountAmount),
      appliedDiscountId: line.appliedDiscountId,
      taxAmount: money(line.taxAmount),
      total: money(line.total),
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function generateOpaqueCode(namespaceDigit: 8 | 9): string {
  const data = `${namespaceDigit}${randomInt(0, 100_000_000).toString().padStart(8, '0')}`
  return `${data}${areaTicketCheckDigit(data)}`
}

function mapTicket(ticket: any) {
  return {
    id: ticket.id,
    code: ticket.code,
    status: ticket.status,
    fulfillmentModeSnapshot: ticket.fulfillmentModeSnapshot,
    // Ruta vigente AL EMITIR (§caja externa fase 1). AVOQADO para todo lo existente
    // — el default no cambia nada de lo que ya funciona.
    settlementRoute: ticket.settlementRoute,
    fulfillmentArea: ticket.fulfillmentArea ? { ...ticket.fulfillmentArea, fulfillmentMode: ticket.fulfillmentModeSnapshot } : null,
    sourceTerminal: ticket.sourceTerminal,
    currency: ticket.currency,
    subtotal: money(ticket.subtotal),
    discountAmount: money(ticket.discountAmount),
    taxAmount: money(ticket.taxAmount),
    total: money(ticket.total),
    pricingSnapshotHash: ticket.pricingSnapshotHash,
    printStatus: ticket.printStatus,
    version: ticket.version,
    issuedAt: ticket.issuedAt,
    printedAt: ticket.printedAt,
    claimedAt: ticket.claimedAt,
    claimExpiresAt: ticket.claimExpiresAt,
    paidAt: ticket.paidAt,
    expiresAt: ticket.expiresAt,
    orderId: ticket.orderId,
    checkoutSessionId: ticket.checkoutSessionId,
    lines: ticket.lines.map((line: any) => ({
      id: line.id,
      clientLineId: line.clientLineId,
      productId: line.productId,
      productNameSnapshot: line.productNameSnapshot,
      skuSnapshot: line.skuSnapshot,
      categoryNameSnapshot: line.categoryNameSnapshot,
      modifiersSnapshot: line.modifiersSnapshot ?? [],
      quantity: quantity(line.quantity),
      weightKg: line.weightKg == null ? null : quantity(line.weightKg),
      unitPrice: money(line.unitPrice),
      discountAmount: money(line.discountAmount),
      appliedDiscountId: line.appliedDiscountId,
      taxAmount: money(line.taxAmount),
      total: money(line.total),
      notes: line.notes,
      orderItemId: line.orderItem?.id ?? null,
    })),
    fulfillment: ticket.fulfillment
      ? {
          id: ticket.fulfillment.id,
          method: ticket.fulfillment.method,
          deliveredAt: ticket.fulfillment.deliveredAt,
          deliveredBy: ticket.fulfillment.deliveredByStaff
            ? `${ticket.fulfillment.deliveredByStaff.firstName} ${ticket.fulfillment.deliveredByStaff.lastName}`.trim()
            : null,
          terminal: ticket.fulfillment.terminal,
        }
      : null,
    // Sólo existe si el área es EXTERNAL — null en la ruta AVOQADO.
    externalSettlement: ticket.externalSettlement
      ? {
          id: ticket.externalSettlement.id,
          status: ticket.externalSettlement.status,
          handoffState: ticket.externalSettlement.handoffState,
          confirmationMode: ticket.externalSettlement.confirmationMode,
          referenceAmount: money(ticket.externalSettlement.referenceAmount),
          externalAmount: ticket.externalSettlement.externalAmount == null ? null : money(ticket.externalSettlement.externalAmount),
          externalReference: ticket.externalSettlement.externalReference,
          confirmedAt: ticket.externalSettlement.confirmedAt,
        }
      : null,
  }
}

function mapCheckout(session: any) {
  return {
    id: session.id,
    status: session.status,
    terminal: session.terminal,
    order: session.order
      ? {
          ...session.order,
          paidAmount: money(session.order.paidAmount),
          remainingBalance: money(session.order.remainingBalance),
          total: money(session.order.total),
        }
      : null,
    activePaymentAttemptId: session.activePaymentAttemptId,
    version: session.version,
    lastHeartbeatAt: session.lastHeartbeatAt,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    tickets: session.tickets.map(mapTicket),
    paymentAttempts: session.paymentAttempts.map((attempt: any) => ({
      ...attempt,
      amount: money(attempt.amount),
    })),
    totals: {
      subtotal: money(session.tickets.reduce((sum: Prisma.Decimal, ticket: any) => sum.add(ticket.subtotal), new Prisma.Decimal(0))),
      discountAmount: money(
        session.tickets.reduce((sum: Prisma.Decimal, ticket: any) => sum.add(ticket.discountAmount), new Prisma.Decimal(0)),
      ),
      total: money(session.tickets.reduce((sum: Prisma.Decimal, ticket: any) => sum.add(ticket.total), new Prisma.Decimal(0))),
    },
  }
}

async function resolveTerminal(venueId: string, deviceUid: string | null | undefined, client: DbClient = prisma) {
  const uid = deviceUid?.trim()
  if (!uid) {
    throw new BadRequestError('Falta el identificador del dispositivo (X-Device-Id).')
  }
  const terminal = await client.terminal.findFirst({
    where: { venueId, deviceUid: uid },
    select: {
      id: true,
      name: true,
      fulfillmentAreaId: true,
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: true,
      defaultWorkspace: true,
      scaleProfile: {
        select: {
          id: true,
          name: true,
          location: true,
          model: true,
          allowedContexts: true,
          transport: true,
          vendorId: true,
          productId: true,
          baudRate: true,
          dataBits: true,
          parity: true,
          stopBits: true,
          frameParser: true,
          stableIndicator: true,
          unit: true,
          active: true,
        },
      },
      fulfillmentArea: {
        select: { id: true, name: true, fulfillmentMode: true, active: true, settlementRoute: true, externalConfirmationMode: true },
      },
    },
  })
  if (!terminal) {
    throw new ConflictError('Este dispositivo todavía no está registrado en el local. Vuelve a iniciar sesión.', 'DEVICE_NOT_REGISTERED')
  }
  return terminal
}

async function getSettingsRecord(venueId: string, client: DbClient = prisma) {
  return client.venueAreaTicketSettings.findUnique({ where: { venueId } })
}

async function assertAreaTicketsEnabled(venueId: string, client: DbClient = prisma) {
  const [entitled, settings] = await Promise.all([venueHasFeatureAccess(venueId, 'AREA_TICKETS'), getSettingsRecord(venueId, client)])
  if (!entitled || !settings?.enabled) {
    throw new ForbiddenError('Los vales por área no están habilitados para este local.', 'AREA_TICKETS_DISABLED')
  }
  return settings
}

function mapScaleIntegration(
  entitled: boolean,
  venueEnabled: boolean,
  profile: Awaited<ReturnType<typeof resolveTerminal>>['scaleProfile'],
) {
  const enabled = entitled && venueEnabled && profile?.active === true
  return {
    entitled,
    enabled,
    profile: enabled ? profile : null,
    manualFallbackAllowed: true,
  }
}

/**
 * Configuración de báscula independiente de vales por área.
 *
 * CEDIS usa la misma infraestructura desde inventario y no debe necesitar
 * `orders:read` ni que el módulo de vales esté activo.
 */
export async function getScaleSettings(venueId: string, deviceUid: string) {
  const [entitled, settings, terminal] = await Promise.all([
    venueHasFeatureAccess(venueId, 'SCALE_INTEGRATION'),
    prisma.venueScaleSettings.findUnique({ where: { venueId } }),
    resolveTerminal(venueId, deviceUid),
  ])
  return mapScaleIntegration(entitled, settings?.enabled === true, terminal.scaleProfile)
}

export async function getAreaTicketSettings(venueId: string, deviceUid: string) {
  const [areaTicketsEntitled, scaleEntitled, variableBarcodeEntitled, settings, scaleSettings, terminal] = await Promise.all([
    venueHasFeatureAccess(venueId, 'AREA_TICKETS'),
    venueHasFeatureAccess(venueId, 'SCALE_INTEGRATION'),
    venueHasFeatureAccess(venueId, 'VARIABLE_WEIGHT_BARCODE'),
    getSettingsRecord(venueId),
    prisma.venueScaleSettings.findUnique({ where: { venueId } }),
    resolveTerminal(venueId, deviceUid),
  ])

  const areaTicketsEnabled = areaTicketsEntitled && settings?.enabled === true
  return {
    venueId,
    areaTickets: {
      entitled: areaTicketsEntitled,
      enabled: areaTicketsEnabled,
      allowMixedCart: settings?.allowMixedCart ?? true,
      claimTtlSeconds: settings?.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
      checkoutSessionMaxAgeMinutes: settings?.checkoutSessionMaxAgeMinutes ?? DEFAULT_SESSION_MAX_AGE_MINUTES,
      ticketExpiryPolicy: settings?.ticketExpiryPolicy ?? 'BUSINESS_DAY_CLOSE',
      ticketExpiryMinutes: settings?.ticketExpiryMinutes ?? null,
      deliveryVerificationMode: settings?.deliveryVerificationMode ?? 'PAPER_OR_SCAN',
      codeSymbology: settings?.codeSymbology ?? 'CODE128',
      inventoryReservationMode: settings?.inventoryReservationMode ?? AreaTicketInventoryReservationMode.NONE,
    },
    terminal: {
      id: terminal.id,
      name: terminal.name,
      fulfillmentArea: terminal.fulfillmentArea,
      canIssueAreaTickets: areaTicketsEnabled && terminal.canIssueAreaTickets,
      canCheckoutAreaTickets: areaTicketsEnabled && terminal.canCheckoutAreaTickets,
      canDeliverAreaTickets: areaTicketsEnabled && terminal.canDeliverAreaTickets,
      defaultWorkspace: terminal.defaultWorkspace,
    },
    scaleIntegration: mapScaleIntegration(scaleEntitled, scaleSettings?.enabled === true, terminal.scaleProfile),
    variableWeightBarcode: {
      entitled: variableBarcodeEntitled,
      enabled: variableBarcodeEntitled && scaleSettings?.variableBarcodeEnabled === true,
      format: 'EAN13_PLU5_WEIGHT5',
      prefix: scaleSettings?.variableBarcodePrefix ?? '20',
    },
  }
}

function normalizeIssueLines(lines: AreaTicketLineInput[]): CreateOrderItemInput[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new BadRequestError('lines es requerido y debe contener al menos un producto.')
  }
  const seen = new Set<string>()
  return lines.map((line, index) => {
    const clientLineId = line.clientLineId?.trim()
    if (!clientLineId || clientLineId.length > 64) {
      throw new BadRequestError(`lines[${index}].clientLineId es requerido y debe tener máximo 64 caracteres.`)
    }
    if (seen.has(clientLineId)) {
      throw new BadRequestError(`clientLineId duplicado: ${clientLineId}.`)
    }
    seen.add(clientLineId)

    const quantityValue = parsePositiveDecimal(line.quantity, `lines[${index}].quantity`, 3)
    if (!quantityValue.isInteger()) {
      throw new BadRequestError(`lines[${index}].quantity debe ser un entero; usa weightKg para productos por peso.`)
    }
    const weight = line.weightKg == null ? null : parsePositiveDecimal(line.weightKg, `lines[${index}].weightKg`, 3)
    return {
      productId: line.productId,
      quantity: quantityValue.toNumber(),
      weightQuantity: weight?.toNumber() ?? null,
      notes: line.notes,
      modifierIds: line.modifierIds,
      discountId: line.discountId,
    }
  })
}

function issueIntentFromInput(lines: AreaTicketLineInput[]) {
  const normalized = normalizeIssueLines(lines)
  return lines.map((line, index) => ({
    clientLineId: line.clientLineId.trim(),
    productId: line.productId,
    quantity: quantity(normalized[index].quantity),
    weightKg: normalized[index].weightQuantity == null ? null : quantity(normalized[index].weightQuantity),
    notes: line.notes ?? null,
    modifierIds: [...new Set(line.modifierIds ?? [])].sort(),
    discountId: line.discountId ?? null,
  }))
}

function issueIntentFromTicket(ticket: any) {
  return ticket.lines.map((line: any) => ({
    clientLineId: line.clientLineId,
    productId: line.productId,
    quantity: quantity(line.quantity),
    weightKg: line.weightKg == null ? null : quantity(line.weightKg),
    notes: line.notes ?? null,
    modifierIds: [
      ...new Set(
        (Array.isArray(line.modifiersSnapshot) ? line.modifiersSnapshot : [])
          .map((modifier: any) => modifier?.modifierId)
          .filter((modifierId: unknown): modifierId is string => typeof modifierId === 'string'),
      ),
    ].sort(),
    discountId: line.appliedDiscountId ?? null,
  }))
}

function assertIssueIdempotencyMatch(ticket: any, lines: AreaTicketLineInput[]): void {
  const incomingIntent = issueIntentFromInput(lines)
  const persistedIntent = issueIntentFromTicket(ticket)
  if (JSON.stringify(incomingIntent) !== JSON.stringify(persistedIntent)) {
    throw domainError(
      409,
      'AREA_TICKET_IDEMPOTENCY_CONFLICT',
      'La llave de idempotencia ya fue utilizada para un vale con productos o cantidades diferentes.',
    )
  }
}

function buildSnapshotLines(inputs: AreaTicketLineInput[], itemsData: any[]): SnapshotLine[] {
  return itemsData.map((item, index) => {
    const modifiers: SnapshotModifier[] = (item.modifiers?.create ?? []).map((modifier: any) => ({
      modifierId: modifier.modifierId,
      name: modifier.name,
      quantity: modifier.quantity,
      price: money(modifier.price),
    }))
    return {
      clientLineId: inputs[index].clientLineId.trim(),
      productId: item.productId ?? null,
      productNameSnapshot: item.productName ?? 'Producto',
      skuSnapshot: item.productSku ?? null,
      categoryNameSnapshot: item.categoryName ?? null,
      modifiersSnapshot: modifiers,
      quantity: quantity(item.quantity),
      weightKg: item.weightQuantity == null ? null : quantity(item.weightQuantity),
      unitPrice: money(item.unitPrice),
      discountAmount: money(item.discountAmount ?? 0),
      appliedDiscountId: item.appliedDiscountId ?? null,
      taxAmount: money(item.taxAmount ?? 0),
      total: money(item.total),
      notes: item.notes ?? null,
    }
  })
}

async function buildReservationSpecs(
  venueId: string,
  inputs: AreaTicketLineInput[],
  snapshots: SnapshotLine[],
): Promise<ReservationSpec[]> {
  const productIds = [...new Set(snapshots.map(line => line.productId).filter((id): id is string => !!id))]
  if (productIds.length === 0) return []

  const products = await prisma.product.findMany({
    where: { venueId, id: { in: productIds } },
    include: {
      inventory: true,
      recipe: {
        include: {
          lines: { include: { rawMaterial: { select: { id: true, name: true, unit: true } } } },
        },
      },
    },
  })
  const modifiers = await prisma.modifier.findMany({
    where: {
      id: { in: inputs.flatMap(line => line.modifierIds ?? []) },
      group: { venueId },
    },
    include: { rawMaterial: { select: { id: true, name: true, unit: true } } },
  })

  const specs: ReservationSpec[] = []
  snapshots.forEach((snapshot, lineIndex) => {
    const product = products.find(candidate => candidate.id === snapshot.productId)
    if (!product?.trackInventory) return
    const effectiveQuantity = new Prisma.Decimal(snapshot.weightKg ?? snapshot.quantity)

    if (product.inventoryMethod === 'QUANTITY') {
      if (!product.inventory) {
        throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No existe inventario para "${product.name}".`)
      }
      specs.push({
        lineIndex,
        inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
        inventoryId: product.inventory.id,
        quantityBaseUnits: effectiveQuantity,
        label: product.name,
      })
    } else if (product.inventoryMethod === 'RECIPE') {
      if (!product.recipe) {
        throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No existe receta para "${product.name}".`)
      }
      const selectedSubstitutionGroups = new Set(
        modifiers
          .filter(modifier => (inputs[lineIndex].modifierIds ?? []).includes(modifier.id) && modifier.inventoryMode === 'SUBSTITUTION')
          .map(modifier => modifier.groupId),
      )
      for (const recipeLine of product.recipe.lines) {
        if (recipeLine.isOptional) continue
        if (recipeLine.isVariable && recipeLine.linkedModifierGroupId && selectedSubstitutionGroups.has(recipeLine.linkedModifierGroupId)) {
          continue
        }
        const perSale = convertUnit(recipeLine.quantity, recipeLine.unit, recipeLine.rawMaterial.unit)
        specs.push({
          lineIndex,
          inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL,
          inventoryId: recipeLine.rawMaterial.id,
          quantityBaseUnits: perSale.mul(effectiveQuantity),
          label: recipeLine.rawMaterial.name,
        })
      }
    }

    for (const modifier of modifiers.filter(candidate => (inputs[lineIndex].modifierIds ?? []).includes(candidate.id))) {
      if (!modifier.rawMaterial || !modifier.quantityPerUnit || !modifier.unit) continue
      const normalized = convertUnit(modifier.quantityPerUnit, modifier.unit, modifier.rawMaterial.unit)
      specs.push({
        lineIndex,
        inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL,
        inventoryId: modifier.rawMaterial.id,
        quantityBaseUnits: normalized.mul(effectiveQuantity),
        label: modifier.rawMaterial.name,
      })
    }
  })

  const aggregated = new Map<string, ReservationSpec>()
  for (const spec of specs) {
    const key = `${spec.lineIndex}:${spec.inventoryKind}:${spec.inventoryId}`
    const current = aggregated.get(key)
    if (current) current.quantityBaseUnits = current.quantityBaseUnits.add(spec.quantityBaseUnits)
    else aggregated.set(key, { ...spec })
  }
  return [...aggregated.values()]
}

async function lockAndValidateReservations(tx: Prisma.TransactionClient, venueId: string, specs: ReservationSpec[]): Promise<void> {
  const targets = [...new Map(specs.map(spec => [`${spec.inventoryKind}:${spec.inventoryId}`, spec])).values()].sort((a, b) =>
    `${a.inventoryKind}:${a.inventoryId}`.localeCompare(`${b.inventoryKind}:${b.inventoryId}`),
  )

  for (const target of targets) {
    const rows =
      target.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY
        ? await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
            SELECT id, "currentStock"
            FROM "Inventory"
            WHERE id = ${target.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
            SELECT id, "currentStock"
            FROM "RawMaterial"
            WHERE id = ${target.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
    if (rows.length !== 1) {
      throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No se encontró inventario para "${target.label}".`)
    }

    const requested = specs
      .filter(spec => spec.inventoryKind === target.inventoryKind && spec.inventoryId === target.inventoryId)
      .reduce((sum, spec) => sum.add(spec.quantityBaseUnits), new Prisma.Decimal(0))
    const reserved = await tx.areaTicketInventoryReservation.aggregate({
      where: {
        venueId,
        inventoryKind: target.inventoryKind,
        inventoryId: target.inventoryId,
        status: AreaTicketInventoryReservationStatus.ACTIVE,
      },
      _sum: { quantityBaseUnits: true },
    })
    const available = new Prisma.Decimal(rows[0].currentStock).sub(reserved._sum.quantityBaseUnits ?? 0)
    if (available.lessThan(requested)) {
      throw domainError(
        409,
        'AREA_TICKET_INSUFFICIENT_STOCK',
        `No hay existencia suficiente de "${target.label}". Disponible: ${quantity(available)}; requerida: ${quantity(requested)}.`,
      )
    }
  }
}

export async function issueAreaTicket(venueId: string, input: IssueAreaTicketInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const existing = await prisma.areaTicket.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    include: ticketInclude,
  })
  if (existing) {
    assertIssueIdempotencyMatch(existing, input.lines)
    return mapTicket(existing)
  }

  await assertVenueSalesEnabled(venueId)
  const [settings, terminal] = await Promise.all([assertAreaTicketsEnabled(venueId), resolveTerminal(venueId, input.deviceUid)])
  if (!terminal.canIssueAreaTickets || !terminal.fulfillmentAreaId || !terminal.fulfillmentArea?.active) {
    throw new ForbiddenError('Esta terminal no está configurada para emitir vales de un área activa.', 'TERMINAL_AREA_MISMATCH')
  }
  // El guard de arriba ya garantiza que ambos existen, pero TypeScript descarta el
  // estrechamiento de PROPIEDADES al entrar al callback de `prisma.$transaction`
  // (podrían mutar entre el chequeo y la ejecución). Fijarlos aquí es lo que hace
  // que adentro se lean sin `!`: la garantía queda en una constante, no en una
  // aserción que nadie vuelve a verificar.
  const fulfillmentAreaId = terminal.fulfillmentAreaId
  const fulfillmentArea = terminal.fulfillmentArea
  // Ruta vigente AL EMITIR — se congela en el vale (y, si aplica, en su settlement).
  // Cambiar la ruta del área después no reescribe vales ya emitidos.
  const isExternal = fulfillmentArea.settlementRoute === AreaSettlementRoute.EXTERNAL
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)
  const normalizedItems = normalizeIssueLines(input.lines)
  const { itemsData, subtotal, itemDiscountTotal } = await buildOrderItemsData(venueId, normalizedItems, fulfillmentAreaId)
  const snapshots = buildSnapshotLines(input.lines, itemsData)
  const snapshotHash = canonicalSnapshotHash('MXN', snapshots)
  const total = new Prisma.Decimal(subtotal).sub(itemDiscountTotal)
  const reservationSpecs =
    settings.inventoryReservationMode === AreaTicketInventoryReservationMode.HOLD_AVAILABLE_STOCK
      ? await buildReservationSpecs(venueId, input.lines, snapshots)
      : []
  const expiresAt =
    settings.ticketExpiryPolicy === 'FIXED_DURATION' && settings.ticketExpiryMinutes
      ? new Date(Date.now() + settings.ticketExpiryMinutes * 60_000)
      : null

  let created: any
  for (let collisionAttempt = 0; collisionAttempt < 5; collisionAttempt++) {
    const code = generateOpaqueCode(9)
    try {
      created = await prisma.$transaction(
        async tx => {
          if (reservationSpecs.length > 0) {
            await lockAndValidateReservations(tx, venueId, reservationSpecs)
          }
          const ticket = await tx.areaTicket.create({
            data: {
              venueId,
              fulfillmentAreaId,
              fulfillmentModeSnapshot: fulfillmentArea.fulfillmentMode,
              settlementRoute: fulfillmentArea.settlementRoute,
              sourceTerminalId: terminal.id,
              issuedByStaffId: staffId ?? null,
              code,
              idempotencyKey,
              currency: 'MXN',
              subtotal: new Prisma.Decimal(subtotal),
              discountAmount: new Prisma.Decimal(itemDiscountTotal),
              taxAmount: new Prisma.Decimal(0),
              total,
              pricingSnapshotHash: snapshotHash,
              expiresAt,
            },
          })
          const createdLines: Array<{ id: string }> = []
          for (const snapshot of snapshots) {
            createdLines.push(
              await tx.areaTicketLine.create({
                data: {
                  areaTicketId: ticket.id,
                  clientLineId: snapshot.clientLineId,
                  productId: snapshot.productId,
                  productNameSnapshot: snapshot.productNameSnapshot,
                  skuSnapshot: snapshot.skuSnapshot,
                  categoryNameSnapshot: snapshot.categoryNameSnapshot,
                  modifiersSnapshot: snapshot.modifiersSnapshot as unknown as Prisma.InputJsonValue,
                  quantity: new Prisma.Decimal(snapshot.quantity),
                  weightKg: snapshot.weightKg == null ? null : new Prisma.Decimal(snapshot.weightKg),
                  unitPrice: new Prisma.Decimal(snapshot.unitPrice),
                  discountAmount: new Prisma.Decimal(snapshot.discountAmount),
                  appliedDiscountId: snapshot.appliedDiscountId,
                  taxAmount: new Prisma.Decimal(snapshot.taxAmount),
                  total: new Prisma.Decimal(snapshot.total),
                  notes: snapshot.notes,
                },
              }),
            )
          }
          if (isExternal) {
            await tx.areaTicketExternalSettlement.create({
              data: {
                venueId,
                areaTicketId: ticket.id,
                status: AreaTicketExternalSettlementStatus.PENDING,
                handoffState: AreaTicketExternalHandoffState.PENDING,
                // Se congela: la política puede cambiar mañana, este vale se emitió bajo la de hoy.
                confirmationMode: fulfillmentArea.externalConfirmationMode,
                referenceAmount: total,
                idempotencyKey,
              },
            })
          }
          if (reservationSpecs.length > 0) {
            if (isExternal) {
              // El producto ya salió del área al emitir (enmienda E3): la reserva nace
              // CONSUMIDA con su movimiento en esta misma transacción, en vez de ACTIVA
              // a la espera de un pago que Avoqado nunca observa (cobra otra caja).
              await consumeReservationsAtIssue(
                tx,
                venueId,
                ticket.id,
                reservationSpecs.map(spec => ({ ...spec, areaTicketLineId: createdLines[spec.lineIndex].id })),
                staffId ?? undefined,
              )
            } else {
              await tx.areaTicketInventoryReservation.createMany({
                data: reservationSpecs.map(spec => ({
                  venueId,
                  areaTicketId: ticket.id,
                  areaTicketLineId: createdLines[spec.lineIndex].id,
                  inventoryKind: spec.inventoryKind,
                  inventoryId: spec.inventoryId,
                  quantityBaseUnits: spec.quantityBaseUnits,
                })),
              })
            }
          }
          return tx.areaTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude })
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      break
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const winner = await prisma.areaTicket.findUnique({
          where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
          include: ticketInclude,
        })
        if (winner) {
          assertIssueIdempotencyMatch(winner, input.lines)
          return mapTicket(winner)
        }
        continue
      }
      throw error
    }
  }
  if (!created) {
    throw domainError(503, 'AREA_TICKET_CODE_EXHAUSTED', 'No fue posible generar un código único. Intenta de nuevo.')
  }

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_ISSUED',
    entity: 'AreaTicket',
    entityId: created.id,
    data: { code: created.code, fulfillmentAreaId: created.fulfillmentAreaId, total: money(created.total) },
  })
  logger.info(`[AREA TICKETS v7] Vale emitido ${created.code}`, { venueId, ticketId: created.id })
  return mapTicket(created)
}

/**
 * Cancela un vale ISSUED — el único estado cancelable hoy. No existía ninguna
 * cancelación a nivel de vale individual antes de este cambio (sólo
 * `cancelAreaTicketCheckout`, que cancela una SESIÓN de caja completa y nunca
 * tocó `AreaTicketInventoryReservation`); esta función es nueva.
 *
 * Reservas `ACTIVE` (ruta AVOQADO, todavía sin pagar) sólo se sueltan — nunca
 * tocaron `currentStock` (son un hold validado contra el DISPONIBLE, ver
 * `lockAndValidateReservations`), así que soltarlas es 100% seguro.
 *
 * Reservas `CONSUMED` (ruta EXTERNAL, consumidas al emitir — Task 4) SÍ movieron
 * stock de verdad, así que revertirlas es la parte peligrosa de esta función:
 * o se devuelve el producto a existencia, o se registra como merma
 * (`VenueAreaTicketSettings.recordWasteOnCancel`) y el stock se queda como está.
 *
 * Idempotencia en DOS capas: (1) si el vale ya está CANCELLED, se corta antes
 * de tocar nada — ni siquiera se reabre la transacción; (2) por si acaso, cada
 * reserva revisa su propio `reversalMovementId` antes de moverse. Un vale sólo
 * se puede cancelar una vez, así que en la práctica la capa (1) sola ya
 * garantiza "una sola reversa" — la (2) es la misma defensa en profundidad que
 * pidió el brief.
 */
export async function cancelAreaTicket(venueId: string, ticketId: string, input: CancelAreaTicketInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const reason = input.reason?.trim()
  if (!reason) {
    throw new BadRequestError('Escribe por qué se cancela este vale.')
  }
  await assertAreaTicketsEnabled(venueId)
  // Sólo valida que el dispositivo pertenezca a este venue — igual que el
  // resto de las mutaciones de este archivo. No exige `canIssueAreaTickets`:
  // el brief no pide esa restricción y añadirla sin que nadie la pidiera
  // arriesgaba bloquear una llamada legítima que mis propios tests no
  // ejercitarían (yo mismo elijo qué probar).
  await resolveTerminal(venueId, input.deviceUid)
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const existing = await prisma.areaTicket.findFirst({
    where: { id: ticketId, venueId },
    select: { id: true, status: true, externalSettlement: { select: { status: true } } },
  })
  if (!existing) {
    throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
  }
  if (existing.status === AreaTicketStatus.CANCELLED) {
    // Idempotente: ya cancelado. Ni siquiera se reabre la transacción — el
    // trabajo de reversa ya ocurrió (o nunca hizo falta) la primera vez.
    return mapTicket(await prisma.areaTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude }))
  }
  if (existing.externalSettlement?.status === AreaTicketExternalSettlementStatus.CONFIRMED) {
    throw domainError(409, 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED', 'Este vale ya se cobró en la caja externa. La devolución se hace ahí.')
  }
  if (existing.status !== AreaTicketStatus.ISSUED) {
    throw domainError(409, 'AREA_TICKET_CANNOT_CANCEL', `Este vale está en estado ${existing.status} y no admite cancelación.`)
  }

  const settings = await getSettingsRecord(venueId)
  const wastes = settings?.recordWasteOnCancel === true

  const cancelled = await prisma.$transaction(async tx => {
    // Mismo patrón que cancelAreaTicketCheckout: lock pesimista + relectura
    // dentro de la tx. Dos cancelaciones concurrentes del MISMO vale se
    // serializan aquí — la segunda ve el estado ya actualizado por la primera
    // y toma la rama idempotente de abajo.
    await tx.$queryRaw`SELECT id FROM "AreaTicket" WHERE id = ${ticketId} AND "venueId" = ${venueId} FOR UPDATE`
    const fresh = await tx.areaTicket.findFirst({
      where: { id: ticketId, venueId },
      include: { externalSettlement: { select: { status: true } } },
    })
    if (!fresh) throw new NotFoundError('No encontramos ese vale en este local.')
    if (fresh.status === AreaTicketStatus.CANCELLED) {
      return tx.areaTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude })
    }
    if (fresh.externalSettlement?.status === AreaTicketExternalSettlementStatus.CONFIRMED) {
      throw domainError(409, 'AREA_TICKET_EXTERNAL_ALREADY_CHARGED', 'Este vale ya se cobró en la caja externa. La devolución se hace ahí.')
    }
    if (fresh.status !== AreaTicketStatus.ISSUED) {
      throw domainError(409, 'AREA_TICKET_CANNOT_CANCEL', `Este vale está en estado ${fresh.status} y no admite cancelación.`)
    }

    const reservations = await tx.areaTicketInventoryReservation.findMany({
      where: {
        areaTicketId: ticketId,
        venueId,
        status: { in: [AreaTicketInventoryReservationStatus.ACTIVE, AreaTicketInventoryReservationStatus.CONSUMED] },
      },
      orderBy: [{ inventoryKind: 'asc' }, { inventoryId: 'asc' }, { id: 'asc' }],
    })

    for (const reservation of reservations) {
      if (reservation.status === AreaTicketInventoryReservationStatus.CONSUMED) {
        // Ya revertida: un reintento no debe volver a mover inventario.
        if (reservation.reversalMovementId) continue
        if (reservation.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY) {
          await releaseQuantityReservation(tx, venueId, reservation, ticketId, wastes, staffId ?? undefined)
        } else {
          await releaseRawMaterialReservation(tx, venueId, reservation, ticketId, wastes, staffId ?? undefined)
        }
      } else {
        // ACTIVE: la ruta AVOQADO reserva sin pagar todavía. Nunca tocó
        // currentStock (es sólo un hold), así que soltarla no mueve
        // inventario — sólo libera el cupo para que otra venta lo use.
        await tx.areaTicketInventoryReservation.update({
          where: { id: reservation.id },
          data: { status: AreaTicketInventoryReservationStatus.RELEASED, releasedAt: new Date() },
        })
      }
    }

    await tx.areaTicket.update({
      where: { id: ticketId },
      data: { status: AreaTicketStatus.CANCELLED, cancelledAt: new Date(), version: { increment: 1 } },
    })

    return tx.areaTicket.findUniqueOrThrow({ where: { id: ticketId }, include: ticketInclude })
  })

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_CANCELLED',
    entity: 'AreaTicket',
    entityId: ticketId,
    // El idempotencyKey de ESTA llamada queda en la bitácora para trazabilidad
    // — el ancla real contra doble-reversa es `reversalMovementId` por
    // reserva (columna @unique, Task 1), no esta llave.
    data: { reason, idempotencyKey, settlementRoute: cancelled.settlementRoute, recordedAsWaste: wastes },
  })
  logger.info(`[AREA TICKETS v7] Vale cancelado ${cancelled.code}`, { venueId, ticketId })
  return mapTicket(cancelled)
}

async function loadCheckout(venueId: string, sessionId: string) {
  const session = await prisma.areaTicketCheckoutSession.findFirst({
    where: { id: sessionId, venueId },
    include: checkoutInclude,
  })
  if (!session) throw new NotFoundError('La sesión de caja no existe.')
  return session
}

async function assertCheckoutTerminal(venueId: string, session: { terminalId: string }, deviceUid: string) {
  const terminal = await resolveTerminal(venueId, deviceUid)
  if (terminal.id !== session.terminalId || !terminal.canCheckoutAreaTickets) {
    throw new ForbiddenError('Esta sesión pertenece a otra caja o la terminal no puede cobrar vales.', 'CHECKOUT_TERMINAL_MISMATCH')
  }
  return terminal
}

export async function createAreaTicketCheckout(venueId: string, input: CreateCheckoutInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const existing = await prisma.areaTicketCheckoutSession.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    include: checkoutInclude,
  })
  if (existing) return mapCheckout(existing)

  const [settings, terminal] = await Promise.all([assertAreaTicketsEnabled(venueId), resolveTerminal(venueId, input.deviceUid)])
  if (!terminal.canCheckoutAreaTickets) {
    throw new ForbiddenError('Esta terminal no está configurada como caja de vales.', 'CHECKOUT_TERMINAL_MISMATCH')
  }
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + settings.checkoutSessionMaxAgeMinutes * 60_000)

  try {
    const session = await prisma.areaTicketCheckoutSession.create({
      data: {
        venueId,
        terminalId: terminal.id,
        staffId: staffId ?? null,
        idempotencyKey,
        lastHeartbeatAt: now,
        expiresAt,
      },
      include: checkoutInclude,
    })
    void logAction({
      staffId,
      venueId,
      action: 'AREA_TICKET_CHECKOUT_CREATED',
      entity: 'AreaTicketCheckoutSession',
      entityId: session.id,
      data: { terminalId: terminal.id, expiresAt },
    })
    return mapCheckout(session)
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await prisma.areaTicketCheckoutSession.findUnique({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
        include: checkoutInclude,
      })
      if (winner) return mapCheckout(winner)
    }
    throw error
  }
}

async function releaseExpiredClaims(tx: Prisma.TransactionClient, venueId: string, sessionId: string, now: Date) {
  const stale = await tx.areaTicketCheckoutSession.findFirst({
    where: { id: sessionId, venueId, status: AreaTicketCheckoutStatus.OPEN, expiresAt: { lte: now } },
    select: { id: true, version: true },
  })
  if (!stale) return false
  const expired = await tx.areaTicketCheckoutSession.updateMany({
    where: { id: stale.id, venueId, status: AreaTicketCheckoutStatus.OPEN, version: stale.version, expiresAt: { lte: now } },
    data: { status: AreaTicketCheckoutStatus.EXPIRED, version: { increment: 1 } },
  })
  if (expired.count === 0) return false
  await tx.areaTicket.updateMany({
    where: { venueId, checkoutSessionId: stale.id, status: AreaTicketStatus.CLAIMED },
    data: {
      status: AreaTicketStatus.ISSUED,
      checkoutSessionId: null,
      claimedAt: null,
      claimExpiresAt: null,
      version: { increment: 1 },
    },
  })
  return true
}

export async function addTicketToCheckout(venueId: string, sessionId: string, ticketCode: string, input: CheckoutMutationInput) {
  requireIdempotencyKey(input.idempotencyKey)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)
  const settings = await assertAreaTicketsEnabled(venueId)

  await withSerializableRetry(async tx => {
    const now = new Date()
    await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${sessionId} AND "venueId" = ${venueId} FOR UPDATE`
    const current = await tx.areaTicketCheckoutSession.findFirst({
      where: { id: sessionId, venueId },
      select: { id: true, status: true, version: true, expiresAt: true, terminalId: true },
    })
    if (!current) throw new NotFoundError('La sesión de caja no existe.')
    if (current.expiresAt <= now && current.status === AreaTicketCheckoutStatus.OPEN) {
      await releaseExpiredClaims(tx, venueId, current.id, now)
      throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión de caja venció. Abre una nueva.')
    }
    if (current.status !== AreaTicketCheckoutStatus.OPEN) {
      throw domainError(409, 'CHECKOUT_SESSION_FROZEN', 'La sesión ya se congeló y no admite más vales.')
    }

    await tx.$queryRaw`SELECT id FROM "AreaTicket" WHERE "venueId" = ${venueId} AND code = ${ticketCode.trim()} FOR UPDATE`
    let ticket = await tx.areaTicket.findUnique({
      where: { venueId_code: { venueId, code: ticketCode.trim() } },
      select: {
        id: true,
        status: true,
        version: true,
        checkoutSessionId: true,
        expiresAt: true,
        claimExpiresAt: true,
        settlementRoute: true,
      },
    })
    if (!ticket) {
      throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
    }
    // Un vale EXTERNAL se cobra en la caja del otro POS, nunca en una de Avoqado.
    // El CHECK "area_ticket_external_no_avoqado_circuit" ya lo impide en la base
    // (un vale EXTERNAL no puede traer checkoutSessionId ni status CLAIMED), pero
    // dejar que este código llegue al updateMany de abajo convierte esa defensa en
    // un 500 crudo de Postgres para el cajero. Rechazar aquí, ANTES de cualquier
    // escritura, es la puerta — el CHECK sigue siendo la red.
    if (ticket.settlementRoute === AreaSettlementRoute.EXTERNAL) {
      throw domainError(409, 'AREA_TICKET_IS_EXTERNAL', 'Este vale se cobra en la caja externa, no en Avoqado.')
    }
    if (ticket.checkoutSessionId === current.id && ticket.status === AreaTicketStatus.CLAIMED) {
      return
    }
    if (ticket.status === AreaTicketStatus.CLAIMED && ticket.checkoutSessionId) {
      const released = await releaseExpiredClaims(tx, venueId, ticket.checkoutSessionId, now)
      if (released) {
        ticket = await tx.areaTicket.findUniqueOrThrow({
          where: { id: ticket.id },
          select: {
            id: true,
            status: true,
            version: true,
            checkoutSessionId: true,
            expiresAt: true,
            claimExpiresAt: true,
            settlementRoute: true,
          },
        })
      }
    }
    if (ticket.expiresAt && ticket.expiresAt <= now && ticket.status === AreaTicketStatus.ISSUED) {
      await tx.areaTicket.updateMany({
        where: { id: ticket.id, venueId, status: AreaTicketStatus.ISSUED, version: ticket.version },
        data: { status: AreaTicketStatus.EXPIRED, version: { increment: 1 } },
      })
      throw domainError(409, 'AREA_TICKET_NOT_ISSUED', 'Este vale ya venció.')
    }
    if (ticket.status === AreaTicketStatus.CLAIMED) {
      throw domainError(409, 'AREA_TICKET_ALREADY_CLAIMED', 'Este vale está siendo cobrado en otra caja.', {
        checkoutSessionId: ticket.checkoutSessionId,
        claimExpiresAt: ticket.claimExpiresAt,
      })
    }
    if (ticket.status !== AreaTicketStatus.ISSUED || ticket.checkoutSessionId) {
      throw domainError(409, 'AREA_TICKET_NOT_ISSUED', `Este vale está en estado ${ticket.status}.`)
    }

    const claimExpiresAt = new Date(Math.min(current.expiresAt.getTime(), now.getTime() + settings.claimTtlSeconds * 1000))
    const claimed = await tx.areaTicket.updateMany({
      where: {
        id: ticket.id,
        venueId,
        status: AreaTicketStatus.ISSUED,
        version: ticket.version,
        checkoutSessionId: null,
      },
      data: {
        status: AreaTicketStatus.CLAIMED,
        checkoutSessionId: current.id,
        claimedAt: now,
        claimExpiresAt,
        version: { increment: 1 },
      },
    })
    if (claimed.count !== 1) {
      throw domainError(409, 'AREA_TICKET_ALREADY_CLAIMED', 'Otra caja reclamó el vale al mismo tiempo.')
    }
    const bumped = await tx.areaTicketCheckoutSession.updateMany({
      where: { id: current.id, venueId, status: AreaTicketCheckoutStatus.OPEN, version: current.version },
      data: { version: { increment: 1 }, lastHeartbeatAt: now },
    })
    if (bumped.count !== 1) {
      throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión cambió. Recárgala antes de continuar.')
    }
  })

  const updated = await loadCheckout(venueId, sessionId)
  return mapCheckout(updated)
}

export async function removeTicketFromCheckout(venueId: string, sessionId: string, ticketId: string, input: CheckoutMutationInput) {
  requireIdempotencyKey(input.idempotencyKey)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)

  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${sessionId} AND "venueId" = ${venueId} FOR UPDATE`
    const current = await tx.areaTicketCheckoutSession.findFirst({
      where: { id: sessionId, venueId },
      select: { id: true, status: true, version: true },
    })
    if (!current) throw new NotFoundError('La sesión de caja no existe.')
    if (current.status !== AreaTicketCheckoutStatus.OPEN) {
      throw domainError(409, 'CHECKOUT_SESSION_FROZEN', 'La sesión ya se congeló; no puedes retirar vales.')
    }
    const ticket = await tx.areaTicket.findFirst({
      where: { id: ticketId, venueId },
      select: { id: true, status: true, version: true, checkoutSessionId: true },
    })
    if (!ticket) throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
    if (ticket.checkoutSessionId == null && ticket.status === AreaTicketStatus.ISSUED) return
    if (ticket.checkoutSessionId !== current.id || ticket.status !== AreaTicketStatus.CLAIMED) {
      throw domainError(409, 'AREA_TICKET_ALREADY_CLAIMED', 'Ese vale no pertenece a esta sesión.')
    }
    const released = await tx.areaTicket.updateMany({
      where: {
        id: ticket.id,
        venueId,
        checkoutSessionId: current.id,
        status: AreaTicketStatus.CLAIMED,
        version: ticket.version,
      },
      data: {
        status: AreaTicketStatus.ISSUED,
        checkoutSessionId: null,
        claimedAt: null,
        claimExpiresAt: null,
        version: { increment: 1 },
      },
    })
    if (released.count !== 1) {
      throw domainError(409, 'CHECKOUT_SESSION_STALE', 'El vale cambió. Recarga la sesión.')
    }
    await tx.areaTicketCheckoutSession.update({
      where: { id: current.id },
      data: { version: { increment: 1 } },
    })
  })

  return mapCheckout(await loadCheckout(venueId, sessionId))
}

export async function heartbeatAreaTicketCheckout(venueId: string, sessionId: string, input: CheckoutMutationInput) {
  requireIdempotencyKey(input.idempotencyKey)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)
  if (session.status !== AreaTicketCheckoutStatus.OPEN) return mapCheckout(session)

  const settings = await getSettingsRecord(venueId)
  const now = new Date()
  const maxAgeMinutes = settings?.checkoutSessionMaxAgeMinutes ?? DEFAULT_SESSION_MAX_AGE_MINUTES
  const claimTtlSeconds = settings?.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS
  const absoluteMax = new Date(session.createdAt.getTime() + maxAgeMinutes * 60_000)
  const nextExpiry = new Date(Math.min(absoluteMax.getTime(), now.getTime() + claimTtlSeconds * 1000))
  if (nextExpiry <= now) {
    await prisma.$transaction(tx => releaseExpiredClaims(tx, venueId, session.id, now))
    throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión de caja venció. Abre una nueva.')
  }
  const updated = await prisma.$transaction(async tx => {
    const bump = await tx.areaTicketCheckoutSession.updateMany({
      where: { id: session.id, venueId, status: AreaTicketCheckoutStatus.OPEN, version: session.version },
      data: { lastHeartbeatAt: now, expiresAt: nextExpiry, version: { increment: 1 } },
    })
    if (bump.count !== 1) {
      throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión cambió. Recárgala.')
    }
    await tx.areaTicket.updateMany({
      where: { venueId, checkoutSessionId: session.id, status: AreaTicketStatus.CLAIMED },
      data: { claimExpiresAt: nextExpiry, version: { increment: 1 } },
    })
    return tx.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: session.id }, include: checkoutInclude })
  })
  return mapCheckout(updated)
}

export async function getAreaTicketCheckout(venueId: string, sessionId: string, deviceUid: string) {
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, deviceUid)
  return mapCheckout(session)
}

function snapshotFromPersistedTicket(ticket: any): SnapshotLine[] {
  return ticket.lines.map((line: any) => ({
    clientLineId: line.clientLineId,
    productId: line.productId,
    productNameSnapshot: line.productNameSnapshot,
    skuSnapshot: line.skuSnapshot,
    categoryNameSnapshot: line.categoryNameSnapshot,
    modifiersSnapshot: Array.isArray(line.modifiersSnapshot) ? line.modifiersSnapshot : [],
    quantity: quantity(line.quantity),
    weightKg: line.weightKg == null ? null : quantity(line.weightKg),
    unitPrice: money(line.unitPrice),
    discountAmount: money(line.discountAmount),
    appliedDiscountId: line.appliedDiscountId,
    taxAmount: money(line.taxAmount),
    total: money(line.total),
    notes: line.notes,
  }))
}

function assertSnapshotIntegrity(ticket: any): void {
  const actual = canonicalSnapshotHash(ticket.currency, snapshotFromPersistedTicket(ticket))
  if (actual !== ticket.pricingSnapshotHash) {
    throw domainError(
      409,
      'AREA_TICKET_SNAPSHOT_MISMATCH',
      `El snapshot del vale ${ticket.code} no coincide. Reemítelo desde el área antes de cobrar.`,
    )
  }
}

function orderItemFromSnapshot(line: any, fulfillmentAreaId: string) {
  const modifiers: SnapshotModifier[] = Array.isArray(line.modifiersSnapshot) ? line.modifiersSnapshot : []
  const quantityValue = new Prisma.Decimal(line.quantity)
  if (!quantityValue.isInteger() || quantityValue.lessThanOrEqualTo(0)) {
    throw domainError(409, 'AREA_TICKET_SNAPSHOT_MISMATCH', 'Una línea de vale tiene cantidad inválida.')
  }
  return {
    productId: line.productId,
    productName: line.productNameSnapshot,
    productSku: line.skuSnapshot,
    categoryName: line.categoryNameSnapshot,
    quantity: quantityValue.toNumber(),
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount,
    appliedDiscountId: line.appliedDiscountId,
    taxAmount: line.taxAmount,
    total: line.total,
    weightQuantity: line.weightKg,
    weightUnit: line.weightKg == null ? null : ('KILOGRAM' as const),
    notes: line.notes,
    fulfillmentAreaId,
    areaTicketLineId: line.id,
    modifiers:
      modifiers.length === 0
        ? undefined
        : {
            create: modifiers.map(modifier => ({
              modifierId: modifier.modifierId,
              name: modifier.name,
              quantity: modifier.quantity,
              price: new Prisma.Decimal(modifier.price),
            })),
          },
  }
}

export async function materializeAreaTicketCheckout(venueId: string, sessionId: string, input: MaterializeCheckoutInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)
  if (session.orderId) {
    if (session.materializeIdempotencyKey && session.materializeIdempotencyKey !== idempotencyKey) {
      throw domainError(409, 'CHECKOUT_SESSION_FROZEN', 'Esta sesión ya fue materializada con otra llave.')
    }
    return mapCheckout(session)
  }
  if (session.status !== AreaTicketCheckoutStatus.OPEN || session.expiresAt <= new Date()) {
    throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión no está abierta o ya venció.')
  }
  if (session.tickets.length === 0) {
    throw new BadRequestError('Agrega al menos un vale antes de materializar la venta.')
  }
  session.tickets.forEach(assertSnapshotIntegrity)

  const settings = await getSettingsRecord(venueId)
  const normalItems = input.normalItems ?? []
  if (normalItems.length > 0 && settings?.allowMixedCart === false) {
    throw domainError(409, 'MIXED_CART_DISABLED', 'Este local no permite mezclar vales con productos de caja.')
  }
  const normalBuild =
    normalItems.length > 0
      ? await buildOrderItemsData(venueId, normalItems, null)
      : { itemsData: [] as any[], subtotal: 0, itemDiscountTotal: 0 }
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const ticketSubtotal = session.tickets.reduce((sum: Prisma.Decimal, ticket: any) => sum.add(ticket.subtotal), new Prisma.Decimal(0))
  const ticketDiscount = session.tickets.reduce((sum: Prisma.Decimal, ticket: any) => sum.add(ticket.discountAmount), new Prisma.Decimal(0))
  const subtotal = ticketSubtotal.add(normalBuild.subtotal)
  const discountAmount = ticketDiscount.add(normalBuild.itemDiscountTotal)
  const total = subtotal.sub(discountAmount)
  const sortedTicketIds = session.tickets.map(ticket => ticket.id).sort()

  let materialized: any
  for (let collisionAttempt = 0; collisionAttempt < 5; collisionAttempt++) {
    const deliveryCode = generateOpaqueCode(8)
    try {
      materialized = await prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${sessionId} AND "venueId" = ${venueId} FOR UPDATE`
          if (sortedTicketIds.length > 0) {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM "AreaTicket" WHERE "venueId" = ${venueId} AND id IN (${Prisma.join(
                sortedTicketIds,
              )}) ORDER BY id FOR UPDATE`,
            )
          }
          const fresh = await tx.areaTicketCheckoutSession.findFirst({
            where: { id: sessionId, venueId },
            include: {
              tickets: {
                include: { lines: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
                orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
              },
            },
          })
          if (!fresh) throw new NotFoundError('La sesión de caja no existe.')
          if (fresh.orderId) {
            return tx.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: fresh.id }, include: checkoutInclude })
          }
          if (fresh.status !== AreaTicketCheckoutStatus.OPEN || fresh.version !== session.version || fresh.expiresAt <= new Date()) {
            throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión cambió o venció. Recárgala.')
          }
          if (fresh.tickets.length !== sortedTicketIds.length) {
            throw domainError(409, 'CHECKOUT_SESSION_STALE', 'Los vales de la sesión cambiaron. Recárgala.')
          }
          for (const ticket of fresh.tickets) {
            if (
              ticket.status !== AreaTicketStatus.CLAIMED ||
              ticket.checkoutSessionId !== fresh.id ||
              !sortedTicketIds.includes(ticket.id)
            ) {
              throw domainError(409, 'AREA_TICKET_NOT_ISSUED', `El vale ${ticket.code} ya no puede cobrarse.`)
            }
            assertSnapshotIntegrity(ticket)
          }
          const requiresDeliveryCode = fresh.tickets.some(ticket => ticket.fulfillmentModeSnapshot !== FulfillmentMode.IMMEDIATE)

          const order = await tx.order.create({
            data: {
              venueId,
              orderNumber: `ORD-${Date.now()}-${randomInt(0, 1_679_616).toString(36).padStart(4, '0').toUpperCase()}`,
              terminalId: fresh.terminalId,
              createdById: staffId ?? fresh.staffId ?? null,
              servedById: staffId ?? fresh.staffId ?? null,
              status: 'CONFIRMED',
              kitchenStatus: 'PENDING',
              paymentStatus: 'PENDING',
              type: 'TAKEOUT',
              source: input.source ?? 'AVOQADO_ANDROID',
              customerName: input.customerName ?? null,
              specialRequests: input.note ?? null,
              subtotal,
              discountAmount,
              taxAmount: new Prisma.Decimal(0),
              tipAmount: new Prisma.Decimal(0),
              total,
              paidAmount: new Prisma.Decimal(0),
              remainingBalance: total,
              areaDeliveryCode: requiresDeliveryCode ? deliveryCode : null,
            },
          })

          for (const ticket of fresh.tickets) {
            for (const line of ticket.lines) {
              await tx.orderItem.create({
                data: {
                  orderId: order.id,
                  ...orderItemFromSnapshot(line, ticket.fulfillmentAreaId),
                },
              })
            }
          }
          for (const item of normalBuild.itemsData) {
            await tx.orderItem.create({ data: { orderId: order.id, ...item, fulfillmentAreaId: null } })
          }

          const linked = await tx.areaTicket.updateMany({
            where: {
              id: { in: sortedTicketIds },
              venueId,
              checkoutSessionId: fresh.id,
              status: AreaTicketStatus.CLAIMED,
            },
            data: { orderId: order.id, version: { increment: 1 } },
          })
          if (linked.count !== sortedTicketIds.length) {
            throw domainError(409, 'CHECKOUT_SESSION_STALE', 'No fue posible congelar todos los vales.')
          }
          const frozen = await tx.areaTicketCheckoutSession.updateMany({
            where: {
              id: fresh.id,
              venueId,
              status: AreaTicketCheckoutStatus.OPEN,
              version: fresh.version,
              orderId: null,
            },
            data: {
              status: AreaTicketCheckoutStatus.MATERIALIZED,
              orderId: order.id,
              materializeIdempotencyKey: idempotencyKey,
              version: { increment: 1 },
            },
          })
          if (frozen.count !== 1) {
            throw domainError(409, 'CHECKOUT_SESSION_STALE', 'Otra caja cambió la sesión.')
          }
          return tx.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: fresh.id }, include: checkoutInclude })
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      break
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const winner = await loadCheckout(venueId, sessionId)
        if (winner.orderId) return mapCheckout(winner)
        continue
      }
      throw error
    }
  }
  if (!materialized) {
    throw domainError(503, 'AREA_DELIVERY_CODE_EXHAUSTED', 'No fue posible generar el código de entrega. Intenta de nuevo.')
  }

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_ORDER_MATERIALIZED',
    entity: 'AreaTicketCheckoutSession',
    entityId: sessionId,
    data: {
      orderId: materialized.orderId,
      ticketIds: sortedTicketIds,
      total: materialized.order ? money(materialized.order.total) : money(total),
    },
  })
  return mapCheckout(materialized)
}

export async function prepareAreaTicketPayment(venueId: string, sessionId: string, input: PreparePaymentInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const amount = parsePositiveDecimal(input.amount, 'amount', 2)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)
  if (!session.orderId || !session.order) {
    throw domainError(409, 'CHECKOUT_NOT_MATERIALIZED', 'Materializa la venta antes de preparar el pago.')
  }

  const existing = session.paymentAttempts.find(attempt => attempt.idempotencyKey === idempotencyKey)
  if (existing) return { checkout: mapCheckout(session), paymentAttemptId: existing.id, state: existing.status }
  if (!checkoutStatusIn(session.status, [AreaTicketCheckoutStatus.MATERIALIZED, AreaTicketCheckoutStatus.PARTIALLY_PAID])) {
    if (checkoutStatusIn(session.status, [AreaTicketCheckoutStatus.PAYMENT_PENDING, AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED])) {
      return {
        checkout: mapCheckout(session),
        paymentAttemptId: session.activePaymentAttemptId,
        state: session.status,
      }
    }
    throw domainError(409, 'CHECKOUT_PAYMENT_NOT_ALLOWED', `La sesión está en estado ${session.status}.`)
  }
  if (amount.greaterThan(new Prisma.Decimal(session.order.remainingBalance).add('0.01'))) {
    throw new BadRequestError(`El abono excede el saldo de ${money(session.order.remainingBalance)}.`)
  }

  const attempt = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${sessionId} AND "venueId" = ${venueId} FOR UPDATE`
    const fresh = await tx.areaTicketCheckoutSession.findFirst({
      where: { id: sessionId, venueId },
      include: { paymentAttempts: { orderBy: { sequence: 'desc' }, take: 1 } },
    })
    if (!fresh || !fresh.orderId) {
      throw domainError(409, 'CHECKOUT_NOT_MATERIALIZED', 'La sesión no tiene una orden.')
    }
    const duplicate = await tx.areaTicketPaymentAttempt.findUnique({
      where: { checkoutSessionId_idempotencyKey: { checkoutSessionId: fresh.id, idempotencyKey } },
    })
    if (duplicate) return duplicate
    if (!checkoutStatusIn(fresh.status, [AreaTicketCheckoutStatus.MATERIALIZED, AreaTicketCheckoutStatus.PARTIALLY_PAID])) {
      throw domainError(409, 'CHECKOUT_PAYMENT_PENDING', 'Ya existe un pago pendiente o la sesión no admite otro abono.')
    }
    const created = await tx.areaTicketPaymentAttempt.create({
      data: {
        checkoutSessionId: fresh.id,
        orderId: fresh.orderId,
        sequence: (fresh.paymentAttempts[0]?.sequence ?? 0) + 1,
        idempotencyKey,
        amount,
        method: input.method,
        status: AreaTicketPaymentAttemptStatus.PREPARED,
      },
    })
    await tx.areaTicketCheckoutSession.update({
      where: { id: fresh.id },
      data: {
        status: AreaTicketCheckoutStatus.PAYMENT_PENDING,
        activePaymentAttemptId: created.id,
        version: { increment: 1 },
      },
    })
    return created
  })

  return {
    checkout: mapCheckout(await loadCheckout(venueId, sessionId)),
    paymentAttemptId: attempt.id,
    state: attempt.status,
  }
}

export async function getAreaTicketPaymentAttempt(venueId: string, sessionId: string, attemptId: string, deviceUid: string) {
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, deviceUid)
  const attempt = session.paymentAttempts.find(candidate => candidate.id === attemptId)
  if (!attempt) throw new NotFoundError('El intento de pago no existe.')
  return { ...attempt, amount: money(attempt.amount), checkoutStatus: session.status }
}

export async function cancelAreaTicketCheckout(venueId: string, sessionId: string, input: CheckoutMutationInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const session = await loadCheckout(venueId, sessionId)
  await assertCheckoutTerminal(venueId, session, input.deviceUid)
  if (session.status === AreaTicketCheckoutStatus.CANCELLED && session.cancelIdempotencyKey === idempotencyKey) {
    return mapCheckout(session)
  }
  if (
    checkoutStatusIn(session.status, [
      AreaTicketCheckoutStatus.PARTIALLY_PAID,
      AreaTicketCheckoutStatus.PAYMENT_PENDING,
      AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED,
      AreaTicketCheckoutStatus.PAID,
    ])
  ) {
    throw domainError(409, 'CHECKOUT_HAS_PAYMENT', 'Esta venta ya tiene o podría tener un pago; usa conciliación o reembolso.')
  }
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const cancelled = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${sessionId} AND "venueId" = ${venueId} FOR UPDATE`
    const fresh = await tx.areaTicketCheckoutSession.findFirst({
      where: { id: sessionId, venueId },
      include: { order: { include: { payments: { where: { status: 'COMPLETED' }, select: { id: true } } } } },
    })
    if (!fresh) throw new NotFoundError('La sesión de caja no existe.')
    if (fresh.status === AreaTicketCheckoutStatus.CANCELLED) {
      return tx.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: fresh.id }, include: checkoutInclude })
    }
    if (fresh.order?.payments.length) {
      throw domainError(409, 'CHECKOUT_HAS_PAYMENT', 'La venta ya tiene abonos; no puede cancelarse directamente.')
    }
    if (!checkoutStatusIn(fresh.status, [AreaTicketCheckoutStatus.OPEN, AreaTicketCheckoutStatus.MATERIALIZED])) {
      throw domainError(409, 'CHECKOUT_CANNOT_CANCEL', `La sesión está en estado ${fresh.status}.`)
    }
    if (fresh.orderId) {
      await tx.order.updateMany({
        where: { id: fresh.orderId, venueId, paymentStatus: 'PENDING' },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      })
    }
    await tx.areaTicket.updateMany({
      where: { venueId, checkoutSessionId: fresh.id, status: AreaTicketStatus.CLAIMED },
      data: {
        status: AreaTicketStatus.ISSUED,
        checkoutSessionId: null,
        orderId: null,
        claimedAt: null,
        claimExpiresAt: null,
        version: { increment: 1 },
      },
    })
    await tx.areaTicketCheckoutSession.update({
      where: { id: fresh.id },
      data: {
        status: AreaTicketCheckoutStatus.CANCELLED,
        cancelIdempotencyKey: idempotencyKey,
        activePaymentAttemptId: null,
        version: { increment: 1 },
      },
    })
    return tx.areaTicketCheckoutSession.findUniqueOrThrow({ where: { id: fresh.id }, include: checkoutInclude })
  })

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_CHECKOUT_CANCELLED',
    entity: 'AreaTicketCheckoutSession',
    entityId: sessionId,
    data: { orderId: cancelled.orderId, ticketIds: session.tickets.map(ticket => ticket.id) },
  })
  return mapCheckout(cancelled)
}

export async function recordAreaTicketPrintAttempt(venueId: string, ticketId: string, input: RecordPrintAttemptInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const terminal = await resolveTerminal(venueId, input.deviceUid)
  const ticket = await prisma.areaTicket.findFirst({
    where: { id: ticketId, venueId },
    include: ticketInclude,
  })
  if (!ticket) throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
  if (terminal.id !== ticket.sourceTerminalId && !terminal.canIssueAreaTickets) {
    throw new ForbiddenError('Esta terminal no puede imprimir vales de área.', 'TERMINAL_AREA_MISMATCH')
  }
  if (input.kind === AreaTicketPrintAttemptKind.REPRINT && !input.reason?.trim()) {
    throw new BadRequestError('La reimpresión requiere un motivo.')
  }
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)
  const existing = await prisma.areaTicketPrintAttempt.findUnique({
    where: { areaTicketId_idempotencyKey: { areaTicketId: ticket.id, idempotencyKey } },
  })
  if (existing) return { attempt: existing, ticket: mapTicket(ticket) }

  const result = await prisma.$transaction(async tx => {
    const attempt = await tx.areaTicketPrintAttempt.create({
      data: {
        areaTicketId: ticket.id,
        idempotencyKey,
        terminalId: terminal.id,
        staffId: staffId ?? null,
        status: input.status,
        kind: input.kind,
        reason: input.reason?.trim() || null,
        errorCode: input.errorCode?.trim() || null,
      },
    })
    const printed = input.status === AreaTicketPrintAttemptStatus.PRINTED
    await tx.areaTicket.update({
      where: { id: ticket.id },
      data: {
        ...(printed
          ? {
              printStatus: 'PRINTED',
              ...(input.kind === AreaTicketPrintAttemptKind.ORIGINAL && !ticket.printedAt ? { printedAt: new Date() } : {}),
            }
          : ticket.printStatus === 'PRINTED'
            ? {}
            : { printStatus: 'PRINT_FAILED' }),
      },
    })
    const fresh = await tx.areaTicket.findUniqueOrThrow({ where: { id: ticket.id }, include: ticketInclude })
    return { attempt, ticket: fresh }
  })

  void logAction({
    staffId,
    venueId,
    action:
      input.kind === AreaTicketPrintAttemptKind.REPRINT
        ? 'AREA_TICKET_REPRINTED'
        : input.status === AreaTicketPrintAttemptStatus.FAILED
          ? 'AREA_TICKET_PRINT_FAILED'
          : 'AREA_TICKET_PRINTED',
    entity: 'AreaTicketPrintAttempt',
    entityId: result.attempt.id,
    data: {
      ticketId,
      code: ticket.code,
      kind: input.kind,
      status: input.status,
      reason: input.reason,
      errorCode: input.errorCode,
    },
  })
  return { attempt: result.attempt, ticket: mapTicket(result.ticket) }
}

export async function resolveAreaTicketScan(
  venueId: string,
  code: string,
  context: 'CHECKOUT' | 'AREA_DELIVERY' | 'PRODUCT_LOOKUP',
  deviceUid: string,
) {
  const normalized = code.trim()
  if (!normalized) throw new BadRequestError('code es requerido.')
  const terminal = await resolveTerminal(venueId, deviceUid)
  const [entitled, settings, product, ticket, deliveryOrder] = await Promise.all([
    venueHasFeatureAccess(venueId, 'AREA_TICKETS'),
    getSettingsRecord(venueId),
    prisma.product.findFirst({
      where: {
        venueId,
        active: true,
        deletedAt: null,
        OR: [{ gtin: normalized }, { sku: normalized }],
      },
      select: { id: true, name: true, sku: true, gtin: true, soldByWeight: true, price: true },
    }),
    prisma.areaTicket.findUnique({
      where: { venueId_code: { venueId, code: normalized } },
      include: ticketInclude,
    }),
    context === 'AREA_DELIVERY'
      ? prisma.order.findUnique({
          where: { venueId_areaDeliveryCode: { venueId, areaDeliveryCode: normalized } },
          select: { id: true, orderNumber: true, paymentStatus: true, status: true, areaDeliveryCode: true },
        })
      : Promise.resolve(null),
  ])
  const moduleEnabled = entitled && settings?.enabled === true
  const deliveryReceiptCandidate = moduleEnabled && context === 'AREA_DELIVERY' && deliveryOrder
  if (deliveryReceiptCandidate) {
    assertDeliveryMethodAllowed(settings.deliveryVerificationMode, AreaTicketFulfillmentMethod.RECEIPT_SCAN)
  }
  const candidates = [
    ...(product ? ['PRODUCT'] : []),
    ...(moduleEnabled && ticket ? [ticket.status === AreaTicketStatus.PAID ? 'PAID_AREA_TICKET' : 'AREA_TICKET'] : []),
    ...(deliveryReceiptCandidate ? ['DELIVERY_RECEIPT'] : []),
  ]
  if (candidates.length === 0) return { type: 'UNKNOWN', code: normalized }
  if (candidates.length > 1) {
    return { type: 'AMBIGUOUS', code: normalized, candidates }
  }
  if (candidates[0] === 'PRODUCT') {
    return {
      type: 'PRODUCT',
      code: normalized,
      product: product ? { ...product, price: money(product.price) } : null,
    }
  }
  if (candidates[0] === 'DELIVERY_RECEIPT') {
    return {
      type: 'DELIVERY_RECEIPT',
      code: normalized,
      order: deliveryOrder,
      terminalArea: terminal.fulfillmentArea,
    }
  }
  return {
    type: candidates[0],
    code: normalized,
    ticket: ticket ? mapTicket(ticket) : null,
  }
}

function encodePendingCursor(ticket: { issuedAt: Date; id: string }): string {
  return Buffer.from(`${ticket.issuedAt.toISOString()}|${ticket.id}`).toString('base64url')
}

function decodePendingCursor(cursor?: string | null): { issuedAt: Date; id: string } | null {
  if (!cursor) return null
  try {
    const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    const issuedAt = new Date(date)
    if (!id || Number.isNaN(issuedAt.getTime())) throw new Error('invalid')
    return { issuedAt, id }
  } catch {
    throw new BadRequestError('El cursor de pendientes no es válido.')
  }
}

async function assertDeliveryTerminal(venueId: string, deviceUid: string) {
  const terminal = await resolveTerminal(venueId, deviceUid)
  if (!terminal.canDeliverAreaTickets || !terminal.fulfillmentAreaId || !terminal.fulfillmentArea?.active) {
    throw new ForbiddenError('Esta terminal no está configurada para entregar vales.', 'TERMINAL_AREA_MISMATCH')
  }
  return terminal
}

export async function listPendingAreaTicketFulfillment(
  venueId: string,
  input: { deviceUid: string; cursor?: string | null; limit?: number },
) {
  const terminal = await assertDeliveryTerminal(venueId, input.deviceUid)
  const cursor = decodePendingCursor(input.cursor)
  const limit = Math.max(1, Math.min(input.limit ?? 50, MAX_PAGE_SIZE))
  const tickets = await prisma.areaTicket.findMany({
    where: {
      venueId,
      fulfillmentAreaId: terminal.fulfillmentAreaId!,
      fulfillmentModeSnapshot: { not: FulfillmentMode.IMMEDIATE },
      status: AreaTicketStatus.PAID,
      fulfillment: null,
      order: { paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'DELETED'] } },
      ...(cursor
        ? {
            OR: [{ issuedAt: { gt: cursor.issuedAt } }, { issuedAt: cursor.issuedAt, id: { gt: cursor.id } }],
          }
        : {}),
    },
    include: ticketInclude,
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  })
  const hasMore = tickets.length > limit
  const page = hasMore ? tickets.slice(0, limit) : tickets
  return {
    fulfillmentArea: terminal.fulfillmentArea,
    tickets: page.map(mapTicket),
    nextCursor: hasMore ? encodePendingCursor(page[page.length - 1]) : null,
  }
}

export async function resolveAreaTicketFulfillment(venueId: string, deliveryCode: string, deviceUid: string) {
  const terminal = await assertDeliveryTerminal(venueId, deviceUid)
  const settings = await getSettingsRecord(venueId)
  assertDeliveryMethodAllowed(
    settings?.deliveryVerificationMode ?? AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN,
    AreaTicketFulfillmentMethod.RECEIPT_SCAN,
  )
  const order = await prisma.order.findUnique({
    where: { venueId_areaDeliveryCode: { venueId, areaDeliveryCode: deliveryCode.trim() } },
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      status: true,
      areaDeliveryCode: true,
      areaTickets: {
        where: { fulfillmentAreaId: terminal.fulfillmentAreaId! },
        include: ticketInclude,
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      },
    },
  })
  if (!order) throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese comprobante en este local.')
  if (order.paymentStatus === 'REFUNDED' || order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw domainError(409, 'AREA_TICKET_ORDER_REFUNDED', 'La venta fue cancelada o reembolsada; no se puede entregar.')
  }
  if (order.paymentStatus !== 'PAID') {
    throw domainError(409, 'AREA_TICKET_NOT_PAID', 'El comprobante todavía no está completamente pagado.')
  }
  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      areaDeliveryCode: order.areaDeliveryCode,
      paymentStatus: order.paymentStatus,
    },
    fulfillmentArea: terminal.fulfillmentArea,
    tickets: order.areaTickets.map(mapTicket),
  }
}

export async function fulfillAreaTicket(venueId: string, ticketId: string, input: FulfillAreaTicketInput) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const terminal = await assertDeliveryTerminal(venueId, input.deviceUid)
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const result = await prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "AreaTicket" WHERE id = ${ticketId} AND "venueId" = ${venueId} FOR UPDATE`
      const ticket = await tx.areaTicket.findFirst({
        where: { id: ticketId, venueId },
        include: {
          fulfillment: {
            include: {
              deliveredByStaff: { select: { firstName: true, lastName: true } },
              terminal: { select: { id: true, name: true } },
            },
          },
          order: {
            select: { id: true, paymentStatus: true, status: true },
          },
        },
      })
      if (!ticket) throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
      if (ticket.fulfillmentAreaId !== terminal.fulfillmentAreaId) {
        throw new ForbiddenError('El vale pertenece a otra área.', 'TERMINAL_AREA_MISMATCH')
      }
      if (ticket.fulfillment) {
        return { fulfillment: ticket.fulfillment, created: false }
      }
      if (ticket.fulfillmentModeSnapshot === FulfillmentMode.IMMEDIATE) {
        throw domainError(409, 'AREA_TICKET_FULFILLMENT_NOT_REQUIRED', 'Este vale se entregó al momento y no requiere confirmación manual.')
      }
      const settings = await getSettingsRecord(venueId, tx)
      assertDeliveryMethodAllowed(settings?.deliveryVerificationMode ?? AreaTicketDeliveryVerificationMode.PAPER_OR_SCAN, input.method)
      if (!ticket.order || ticket.order.paymentStatus !== 'PAID' || ticket.status !== AreaTicketStatus.PAID) {
        throw domainError(409, 'AREA_TICKET_NOT_PAID', 'Este vale todavía no está completamente pagado.')
      }
      if (ticket.order.status === 'CANCELLED' || ticket.order.status === 'DELETED') {
        throw domainError(409, 'AREA_TICKET_ORDER_REFUNDED', 'La venta fue cancelada o reembolsada.')
      }
      const fulfillment = await tx.areaTicketFulfillment.create({
        data: {
          areaTicketId: ticket.id,
          orderId: ticket.order.id,
          fulfillmentAreaId: terminal.fulfillmentAreaId!,
          method: input.method,
          idempotencyKey,
          deliveredByStaffId: staffId ?? null,
          terminalId: terminal.id,
        },
        include: {
          deliveredByStaff: { select: { firstName: true, lastName: true } },
          terminal: { select: { id: true, name: true } },
        },
      })
      const transitioned = await tx.areaTicket.updateMany({
        where: {
          id: ticket.id,
          venueId,
          status: AreaTicketStatus.PAID,
          version: ticket.version,
        },
        data: { status: AreaTicketStatus.DELIVERED, version: { increment: 1 } },
      })
      if (transitioned.count !== 1) {
        throw domainError(409, 'AREA_TICKET_FULFILLMENT_CONFLICT', 'Otra terminal entregó el vale al mismo tiempo.')
      }
      return { fulfillment, created: true }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )

  if (result.created) {
    void logAction({
      staffId,
      venueId,
      action: 'AREA_TICKET_FULFILLED',
      entity: 'AreaTicketFulfillment',
      entityId: result.fulfillment.id,
      data: {
        ticketId,
        fulfillmentAreaId: terminal.fulfillmentAreaId,
        terminalId: terminal.id,
        method: input.method,
      },
    })
  }
  return {
    alreadyFulfilled: !result.created,
    fulfillment: {
      id: result.fulfillment.id,
      method: result.fulfillment.method,
      deliveredAt: result.fulfillment.deliveredAt,
      deliveredBy: result.fulfillment.deliveredByStaff
        ? `${result.fulfillment.deliveredByStaff.firstName} ${result.fulfillment.deliveredByStaff.lastName}`.trim()
        : null,
      terminal: result.fulfillment.terminal,
    },
  }
}

export interface LockedAreaTicketPayment {
  sessionId: string
  attemptId: string
}

/**
 * Se llama DENTRO de la transacción del servicio de pago y ANTES de bloquear la
 * Order. Mantiene la jerarquía session → tickets → order y prepara un intento
 * aunque un cliente viejo no haya llamado explícitamente `prepare-payment`.
 */
export async function lockAreaTicketCheckoutForPayment(
  tx: Prisma.TransactionClient,
  input: {
    venueId: string
    orderId: string
    idempotencyKey?: string | null
    amount: Prisma.Decimal
    method: PaymentMethod
  },
): Promise<LockedAreaTicketPayment | null> {
  const candidate = await tx.areaTicketCheckoutSession.findFirst({
    where: { venueId: input.venueId, orderId: input.orderId },
    select: { id: true },
  })
  if (!candidate) return null
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)

  await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${candidate.id} AND "venueId" = ${input.venueId} FOR UPDATE`
  const session = await tx.areaTicketCheckoutSession.findFirst({
    where: { id: candidate.id, venueId: input.venueId, orderId: input.orderId },
    include: {
      tickets: { select: { id: true }, orderBy: { id: 'asc' } },
      paymentAttempts: { orderBy: { sequence: 'desc' }, take: 1 },
    },
  })
  if (!session) throw domainError(409, 'CHECKOUT_SESSION_STALE', 'La sesión de vales ya no existe.')
  if (session.tickets.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "AreaTicket" WHERE "venueId" = ${input.venueId} AND id IN (${Prisma.join(
        session.tickets.map(ticket => ticket.id),
      )}) ORDER BY id FOR UPDATE`,
    )
  }
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId} AND "venueId" = ${input.venueId} FOR UPDATE`

  const existing = await tx.areaTicketPaymentAttempt.findUnique({
    where: { checkoutSessionId_idempotencyKey: { checkoutSessionId: session.id, idempotencyKey } },
  })
  if (existing) {
    if (existing.status === AreaTicketPaymentAttemptStatus.UNKNOWN || session.status === AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED) {
      throw domainError(
        409,
        'CHECKOUT_RECONCILIATION_REQUIRED',
        'El resultado de este pago todavía es incierto. Consulta el mismo intento; no cobres otra vez.',
        { paymentAttemptId: existing.id },
      )
    }
    return { sessionId: session.id, attemptId: existing.id }
  }
  if (
    !checkoutStatusIn(session.status, [
      AreaTicketCheckoutStatus.MATERIALIZED,
      AreaTicketCheckoutStatus.PARTIALLY_PAID,
      AreaTicketCheckoutStatus.PAYMENT_PENDING,
    ])
  ) {
    throw domainError(409, 'CHECKOUT_PAYMENT_NOT_ALLOWED', `La sesión está en estado ${session.status}.`)
  }
  if (session.status === AreaTicketCheckoutStatus.PAYMENT_PENDING && session.activePaymentAttemptId) {
    throw domainError(409, 'CHECKOUT_PAYMENT_PENDING', 'Ya existe otro abono pendiente. Confírmalo antes de iniciar uno nuevo.', {
      paymentAttemptId: session.activePaymentAttemptId,
    })
  }

  const attempt = await tx.areaTicketPaymentAttempt.create({
    data: {
      checkoutSessionId: session.id,
      orderId: input.orderId,
      sequence: (session.paymentAttempts[0]?.sequence ?? 0) + 1,
      idempotencyKey,
      amount: input.amount,
      method: input.method,
      status: AreaTicketPaymentAttemptStatus.PENDING,
    },
  })
  await tx.areaTicketCheckoutSession.update({
    where: { id: session.id },
    data: {
      status: AreaTicketCheckoutStatus.PAYMENT_PENDING,
      activePaymentAttemptId: attempt.id,
      version: { increment: 1 },
    },
  })
  return { sessionId: session.id, attemptId: attempt.id }
}

async function consumeQuantityReservation(
  tx: Prisma.TransactionClient,
  venueId: string,
  reservation: any,
  orderId: string,
  staffId?: string,
) {
  const updated = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; previousStock: Prisma.Decimal }>>`
    UPDATE "Inventory"
    SET "currentStock" = "currentStock" - ${reservation.quantityBaseUnits},
        "updatedAt" = NOW()
    WHERE id = ${reservation.inventoryId}
      AND "venueId" = ${venueId}
      AND "currentStock" >= ${reservation.quantityBaseUnits}
    RETURNING id, "currentStock", ("currentStock" + ${reservation.quantityBaseUnits}) AS "previousStock"
  `
  if (updated.length !== 1) {
    throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'La existencia reservada ya no está disponible.')
  }
  const movement = await tx.inventoryMovement.create({
    data: {
      inventoryId: reservation.inventoryId,
      type: 'SALE',
      quantity: new Prisma.Decimal(reservation.quantityBaseUnits).neg(),
      previousStock: updated[0].previousStock,
      newStock: updated[0].currentStock,
      reason: 'Venta de vale por área',
      reference: reservation.id,
      createdBy: staffId,
    },
  })
  await tx.areaTicketInventoryReservation.update({
    where: { id: reservation.id },
    data: {
      status: AreaTicketInventoryReservationStatus.CONSUMED,
      inventoryMovementId: movement.id,
      consumedAt: new Date(),
    },
  })
  return { movementId: movement.id, orderId }
}

async function consumeRawMaterialReservation(tx: Prisma.TransactionClient, venueId: string, reservation: any, staffId?: string) {
  const materials = await tx.$queryRaw<
    Array<{ id: string; currentStock: Prisma.Decimal; unit: any }>
  >`SELECT id, "currentStock", unit FROM "RawMaterial" WHERE id = ${reservation.inventoryId} AND "venueId" = ${venueId} FOR UPDATE`
  if (materials.length !== 1) {
    throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'No encontramos el insumo reservado.')
  }
  const batches = await tx.$queryRaw<
    Array<{
      id: string
      remainingQuantity: Prisma.Decimal
      costPerUnit: Prisma.Decimal
    }>
  >`
    SELECT id, "remainingQuantity", "costPerUnit"
    FROM "StockBatch"
    WHERE "venueId" = ${venueId}
      AND "rawMaterialId" = ${reservation.inventoryId}
      AND status = 'ACTIVE'
      AND "remainingQuantity" > 0
    ORDER BY "receivedDate" ASC, id ASC
    FOR UPDATE
  `
  let remaining = new Prisma.Decimal(reservation.quantityBaseUnits)
  let currentStock = new Prisma.Decimal(materials[0].currentStock)
  let firstMovementId: string | null = null
  for (const batch of batches) {
    if (remaining.lessThanOrEqualTo(0)) break
    const available = new Prisma.Decimal(batch.remainingQuantity)
    const used = Prisma.Decimal.min(available, remaining)
    if (used.lessThanOrEqualTo(0)) continue
    const previousStock = currentStock
    currentStock = currentStock.sub(used)
    const batchRemaining = available.sub(used)
    await tx.stockBatch.update({
      where: { id: batch.id },
      data: {
        remainingQuantity: batchRemaining,
        status: batchRemaining.isZero() ? 'DEPLETED' : 'ACTIVE',
        depletedAt: batchRemaining.isZero() ? new Date() : null,
      },
    })
    const movement = await tx.rawMaterialMovement.create({
      data: {
        rawMaterialId: reservation.inventoryId,
        venueId,
        batchId: batch.id,
        type: 'USAGE',
        quantity: used.neg(),
        unit: materials[0].unit,
        previousStock,
        newStock: currentStock,
        costImpact: used.mul(batch.costPerUnit).neg(),
        reason: 'Venta de vale por área',
        reference: reservation.id,
        createdBy: staffId,
      },
    })
    firstMovementId ??= movement.id
    remaining = remaining.sub(used)
  }
  if (remaining.greaterThan(0) || !firstMovementId) {
    throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'Los lotes FIFO no cubren la reserva del vale.')
  }
  await tx.rawMaterial.update({
    where: { id: reservation.inventoryId },
    data: { currentStock },
  })
  await tx.areaTicketInventoryReservation.update({
    where: { id: reservation.id },
    data: {
      status: AreaTicketInventoryReservationStatus.CONSUMED,
      inventoryMovementId: firstMovementId,
      consumedAt: new Date(),
    },
  })
}

/**
 * Reversa de una reserva CONSUMED sobre `Inventory` (QUANTITY_INVENTORY) —
 * cancelación de un vale externo (Task 5).
 *
 * El signo es el espejo exacto de `consumeQuantityReservation`, unas líneas
 * arriba: ese helper resta con `"currentStock" - ${qty}` y registra
 * `quantity: qty.neg()` (negativo). Aquí se SUMA (`"currentStock" + ${qty}`) y
 * se registra `quantity: qty` en positivo — mismo patrón atómico
 * UPDATE...RETURNING (evita el race de leer-y-luego-escribir por separado),
 * sólo que en la dirección contraria. No hay una función de reversa
 * preexistente que reutilizar tal cual: `restockItem`
 * (`inventoryRestock.service.ts`, el restock por reembolso) resuelve por
 * `productId` y abre su PROPIA transacción, así que no puede participar en
 * ésta; pero de ahí sale el `MovementType` correcto para esto —
 * `ADJUSTMENT`, no `RETURN`/`WASTE` (ninguno de los dos existe en
 * `MovementType`; ver el enum real en schema.prisma:7215).
 *
 * `wastes=true` (merma, `VenueAreaTicketSettings.recordWasteOnCancel`): el
 * producto YA salió de `currentStock` cuando se consumió al emitir
 * (movimiento SALE de Task 4) — confirmarlo como merma NO es una segunda
 * baja, es sólo reclasificar esa salida ya ocurrida. `currentStock` no se
 * toca aquí; `previousStock`/`newStock` del movimiento quedan iguales a
 * propósito (cero cambio real de stock), mientras que `quantity` sí lleva el
 * signo negativo del monto perdido — así un reporte que sume `quantity`
 * agrupado por `type=LOSS` cuenta la merma real, sin que esta fila mienta
 * sobre el nivel de stock.
 */
async function releaseQuantityReservation(
  tx: Prisma.TransactionClient,
  venueId: string,
  reservation: { id: string; inventoryId: string; quantityBaseUnits: Prisma.Decimal },
  ticketId: string,
  wastes: boolean,
  staffId?: string,
) {
  const reference = `area-ticket-cancel:${ticketId}`

  if (wastes) {
    const current = await tx.inventory.findUniqueOrThrow({
      where: { id: reservation.inventoryId },
      select: { currentStock: true },
    })
    const movement = await tx.inventoryMovement.create({
      data: {
        inventoryId: reservation.inventoryId,
        type: MovementType.LOSS,
        quantity: new Prisma.Decimal(reservation.quantityBaseUnits).neg(),
        previousStock: current.currentStock,
        newStock: current.currentStock,
        reason: 'Vale por área externo cancelado — merma confirmada',
        reference,
        createdBy: staffId,
      },
    })
    await tx.areaTicketInventoryReservation.update({
      where: { id: reservation.id },
      data: { status: AreaTicketInventoryReservationStatus.WASTE, releasedAt: new Date(), reversalMovementId: movement.id },
    })
    return
  }

  const updated = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; previousStock: Prisma.Decimal }>>`
    UPDATE "Inventory"
    SET "currentStock" = "currentStock" + ${reservation.quantityBaseUnits},
        "updatedAt" = NOW()
    WHERE id = ${reservation.inventoryId}
      AND "venueId" = ${venueId}
    RETURNING id, "currentStock", ("currentStock" - ${reservation.quantityBaseUnits}) AS "previousStock"
  `
  if (updated.length !== 1) {
    throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'No encontramos el inventario reservado para revertir.')
  }
  const movement = await tx.inventoryMovement.create({
    data: {
      inventoryId: reservation.inventoryId,
      type: MovementType.ADJUSTMENT,
      quantity: new Prisma.Decimal(reservation.quantityBaseUnits),
      previousStock: updated[0].previousStock,
      newStock: updated[0].currentStock,
      reason: 'Reversa de vale por área externo cancelado',
      reference,
      createdBy: staffId,
    },
  })
  await tx.areaTicketInventoryReservation.update({
    where: { id: reservation.id },
    data: { status: AreaTicketInventoryReservationStatus.RELEASED, releasedAt: new Date(), reversalMovementId: movement.id },
  })
}

/**
 * Reversa de una reserva CONSUMED sobre `RawMaterial` (RAW_MATERIAL) —
 * cancelación de un vale externo (Task 5).
 *
 * 🔴 Fix round 1 (revisión, Finding 1): la primera versión leía
 * `currentStock` con un `findFirst` normal — sin lock — y escribía de vuelta
 * un `newStock` calculado en JS con un `update` separado. Dos cancelaciones
 * CONCURRENTES de vales DISTINTOS que liberan reservas del MISMO
 * `rawMaterialId` no tienen nada que las serialice (`cancelAreaTicket` sólo
 * bloquea la fila de `AreaTicket`, que es distinta para cada una) — las dos
 * podían leer el mismo `currentStock`, calcular por su cuenta, y la segunda
 * escritura pisaba a la primera en silencio (lost update: se sub-acredita el
 * stock). Detectable sólo en el conteo físico, nunca en un test secuencial.
 *
 * El fix: `SELECT … FOR UPDATE` sobre `RawMaterial` como PRIMERA operación,
 * antes de leer `currentStock` y antes de `createStockBatch` — mismo patrón
 * que ya usa `consumeRawMaterialReservation` (la hermana de consumo, un poco
 * más arriba en este archivo). El lock serializa el cuerpo COMPLETO de la
 * función entre dos cancelaciones que compiten por el mismo insumo, así que
 * además cierra una segunda carrera que apareció al escribir el test de
 * concurrencia: `createStockBatch` genera su `batchNumber` con su propio
 * `SELECT` sin lock (`generateBatchNumber`, `fifoBatch.service.ts`), y dos
 * llamadas concurrentes pueden calcular el MISMO número y chocar contra
 * `@@unique([rawMaterialId, batchNumber])` (23505). Con el lock tomado
 * primero, la segunda transacción no arranca su propio `createStockBatch`
 * hasta que la primera ya commiteó — ve el lote nuevo y calcula el siguiente
 * número correctamente. (`UPDATE … SET currentStock = currentStock + qty …
 * RETURNING`, el patrón atómico de `releaseQuantityReservation`, habría
 * cerrado SÓLO la carrera de `currentStock` — no la de `createStockBatch`,
 * que ocurre antes del `UPDATE` y necesitaba su propia serialización de
 * todos modos.)
 *
 * `!wastes`: reutiliza `createStockBatch` (ya usado por `adjustStock` en
 * `rawMaterial.service.ts` para el caso hermano "reponer insumo por
 * reembolso", ver `inventoryRestock.service.ts`) para abrir un lote nuevo al
 * costo vigente, en vez de reconstruir a qué lote(s) FIFO exactos se dedujo
 * — esa traza no se conserva hoy: `consumeRawMaterialReservation` puede
 * repartir una sola reserva entre varios lotes y sólo guarda el id del
 * PRIMER movimiento. `createStockBatch` acepta un `tx` externo (a diferencia
 * de `adjustStock`/`deductStockFIFO`, que abren su propia transacción), así
 * que sí participa atómicamente en la de `cancelAreaTicket` y bajo el MISMO
 * lock adquirido arriba.
 *
 * `wastes`: igual que en QUANTITY_INVENTORY, no se toca `currentStock` — ya
 * bajó al consumir. `SPOILAGE` es el tipo real de `RawMaterialMovementType`
 * para esto (tampoco existe `WASTE` en ese enum).
 */
async function releaseRawMaterialReservation(
  tx: Prisma.TransactionClient,
  venueId: string,
  reservation: { id: string; inventoryId: string; quantityBaseUnits: Prisma.Decimal },
  ticketId: string,
  wastes: boolean,
  staffId?: string,
) {
  const reference = `area-ticket-cancel:${ticketId}`
  const locked = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; unit: any; costPerUnit: Prisma.Decimal }>>`
    SELECT id, "currentStock", unit, "costPerUnit"
    FROM "RawMaterial"
    WHERE id = ${reservation.inventoryId} AND "venueId" = ${venueId}
    FOR UPDATE
  `
  if (locked.length !== 1) {
    throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'No encontramos el insumo reservado para revertir.')
  }
  const material = locked[0]

  if (wastes) {
    const movement = await tx.rawMaterialMovement.create({
      data: {
        rawMaterialId: reservation.inventoryId,
        venueId,
        type: RawMaterialMovementType.SPOILAGE,
        quantity: new Prisma.Decimal(reservation.quantityBaseUnits).neg(),
        unit: material.unit,
        previousStock: material.currentStock,
        newStock: material.currentStock,
        reason: 'Vale por área externo cancelado — merma confirmada',
        reference,
        createdBy: staffId,
      },
    })
    await tx.areaTicketInventoryReservation.update({
      where: { id: reservation.id },
      data: { status: AreaTicketInventoryReservationStatus.WASTE, releasedAt: new Date(), reversalMovementId: movement.id },
    })
    return
  }

  const batch = await createStockBatch(
    venueId,
    reservation.inventoryId,
    {
      quantity: Number(reservation.quantityBaseUnits),
      unit: material.unit,
      costPerUnit: material.costPerUnit.toNumber(),
      receivedDate: new Date(),
    },
    staffId,
    tx,
    { skipAudit: true },
  )
  const previousStock = material.currentStock
  const newStock = previousStock.add(reservation.quantityBaseUnits)
  await tx.rawMaterial.update({ where: { id: reservation.inventoryId }, data: { currentStock: newStock } })
  const movement = await tx.rawMaterialMovement.create({
    data: {
      rawMaterialId: reservation.inventoryId,
      venueId,
      batchId: batch.id,
      type: RawMaterialMovementType.ADJUSTMENT,
      quantity: new Prisma.Decimal(reservation.quantityBaseUnits),
      unit: material.unit,
      previousStock,
      newStock,
      costImpact: batch.costPerUnit.mul(reservation.quantityBaseUnits),
      reason: 'Reversa de vale por área externo cancelado',
      reference,
      createdBy: staffId,
    },
  })
  await tx.areaTicketInventoryReservation.update({
    where: { id: reservation.id },
    data: { status: AreaTicketInventoryReservationStatus.RELEASED, releasedAt: new Date(), reversalMovementId: movement.id },
  })
}

async function consumeAreaTicketReservations(
  tx: Prisma.TransactionClient,
  venueId: string,
  sessionId: string,
  orderId: string,
  staffId?: string,
) {
  const reservations = await tx.areaTicketInventoryReservation.findMany({
    where: {
      venueId,
      areaTicket: { checkoutSessionId: sessionId },
      status: AreaTicketInventoryReservationStatus.ACTIVE,
    },
    orderBy: [{ inventoryKind: 'asc' }, { inventoryId: 'asc' }, { id: 'asc' }],
  })
  for (const reservation of reservations) {
    if (reservation.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY) {
      await consumeQuantityReservation(tx, venueId, reservation, orderId, staffId)
    } else {
      await consumeRawMaterialReservation(tx, venueId, reservation, staffId)
    }
  }
}

/**
 * Ruta externa: consume la reserva EN EL MOMENTO DE EMITIR, no de pagar (enmienda E3
 * del spec — otro POS cobra en su propia caja y Avoqado nunca ve ese cobro). El
 * producto ya se rebanó y salió del área; esperar un pago que nunca llega dejaría el
 * stock inflado para siempre.
 *
 * Reutiliza `consumeQuantityReservation`/`consumeRawMaterialReservation` — las MISMAS
 * funciones que la ruta nativa dispara al pagar — para que el efecto contable (signo,
 * tipo de movimiento, orden FIFO de lotes) sea idéntico al de esa ruta. Lo único que
 * cambia es CUÁNDO: aquí la reserva nace y se consume en la misma transacción de
 * emisión, no al materializar/pagar un checkout.
 */
async function consumeReservationsAtIssue(
  tx: Prisma.TransactionClient,
  venueId: string,
  ticketId: string,
  specs: Array<ReservationSpec & { areaTicketLineId: string }>,
  staffId?: string,
): Promise<void> {
  for (const spec of specs) {
    const reservation = await tx.areaTicketInventoryReservation.create({
      data: {
        venueId,
        areaTicketId: ticketId,
        areaTicketLineId: spec.areaTicketLineId,
        inventoryKind: spec.inventoryKind,
        inventoryId: spec.inventoryId,
        quantityBaseUnits: spec.quantityBaseUnits,
      },
    })
    if (spec.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY) {
      // La ruta externa nunca tiene Order (lo prohíbe el CHECK
      // area_ticket_external_no_avoqado_circuit) — se pasa el propio ticketId donde la
      // firma pide un orderId. El parámetro no participa en la escritura (el
      // `reference` del movimiento sigue siendo `reservation.id`, igual que en la ruta
      // nativa), así que no hay semántica de dinero que traicionar.
      await consumeQuantityReservation(tx, venueId, reservation, ticketId, staffId)
    } else {
      await consumeRawMaterialReservation(tx, venueId, reservation, staffId)
    }
  }
}

/**
 * Locks the complete inventory footprint of a v7 checkout before the first
 * deduction. Reservations and ordinary cart lines can target the same rows in
 * opposite combinations across two concurrent payments; locking each subset
 * independently would allow a Z→A / A→Z deadlock. The union is therefore
 * acquired once in the same deterministic kind/id order used at issuance.
 */
async function lockAreaOrderInventoryFootprint(
  tx: Prisma.TransactionClient,
  venueId: string,
  sessionId: string,
  orderId: string,
): Promise<void> {
  const reservations = await tx.areaTicketInventoryReservation.findMany({
    where: {
      venueId,
      areaTicket: { checkoutSessionId: sessionId },
      status: AreaTicketInventoryReservationStatus.ACTIVE,
    },
    select: {
      inventoryKind: true,
      inventoryId: true,
    },
  })
  const unreservedDemands = await buildUnreservedAreaOrderInventoryDemands(tx, venueId, orderId)
  const targets = new Map<string, { inventoryKind: AreaTicketInventoryTarget; inventoryId: string }>()
  for (const target of [...reservations, ...unreservedDemands]) {
    const key = `${target.inventoryKind}:${target.inventoryId}`
    targets.set(key, {
      inventoryKind: target.inventoryKind,
      inventoryId: target.inventoryId,
    })
  }

  for (const target of [...targets.values()].sort((a, b) =>
    `${a.inventoryKind}:${a.inventoryId}`.localeCompare(`${b.inventoryKind}:${b.inventoryId}`),
  )) {
    const rows =
      target.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM "Inventory"
            WHERE id = ${target.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM "RawMaterial"
            WHERE id = ${target.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
    if (rows.length !== 1) {
      throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', 'No se encontró uno de los inventarios de la orden.')
    }

    if (target.inventoryKind === AreaTicketInventoryTarget.RAW_MATERIAL) {
      await tx.$queryRaw`
        SELECT id
        FROM "StockBatch"
        WHERE "venueId" = ${venueId}
          AND "rawMaterialId" = ${target.inventoryId}
          AND status = 'ACTIVE'
          AND "remainingQuantity" > 0
        ORDER BY "receivedDate" ASC, id ASC
        FOR UPDATE
      `
    }
  }
}

interface AreaOrderInventoryDemand {
  areaTicketLineId: string | null
  orderItemId: string
  inventoryKind: AreaTicketInventoryTarget
  inventoryId: string
  quantityBaseUnits: Prisma.Decimal
  label: string
}

interface AggregatedAreaOrderInventoryDemand {
  inventoryKind: AreaTicketInventoryTarget
  inventoryId: string
  quantityBaseUnits: Prisma.Decimal
  label: string
}

interface LockedAreaOrderInventoryTarget extends AggregatedAreaOrderInventoryDemand {
  currentStock: Prisma.Decimal
  unit?: any
  batches?: Array<{
    id: string
    remainingQuantity: Prisma.Decimal
    costPerUnit: Prisma.Decimal
  }>
}

/**
 * Builds the inventory portion that was not already covered by an area-ticket
 * reservation. Coverage is target-specific, not line-wide: if an old ticket
 * reserved the base product but omitted an inventory modifier, the modifier is
 * still consumed here.
 */
async function buildUnreservedAreaOrderInventoryDemands(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
): Promise<AggregatedAreaOrderInventoryDemand[]> {
  const items = await tx.orderItem.findMany({
    where: { orderId, order: { venueId } },
    select: {
      id: true,
      areaTicketLineId: true,
      quantity: true,
      weightQuantity: true,
      product: {
        select: {
          id: true,
          name: true,
          trackInventory: true,
          inventoryMethod: true,
          inventory: { select: { id: true } },
          recipe: {
            select: {
              lines: {
                select: {
                  quantity: true,
                  unit: true,
                  isOptional: true,
                  isVariable: true,
                  linkedModifierGroupId: true,
                  rawMaterial: { select: { id: true, name: true, unit: true } },
                },
              },
            },
          },
        },
      },
      modifiers: {
        select: {
          quantity: true,
          modifier: {
            select: {
              id: true,
              groupId: true,
              rawMaterialId: true,
              quantityPerUnit: true,
              unit: true,
              inventoryMode: true,
              rawMaterial: { select: { id: true, name: true, unit: true } },
            },
          },
        },
      },
    },
  })

  const demands: AreaOrderInventoryDemand[] = []
  for (const item of items) {
    if (!item.product) continue
    const effectiveQuantity = new Prisma.Decimal(item.weightQuantity ?? item.quantity)
    if (effectiveQuantity.lessThanOrEqualTo(0)) continue
    const consumedSubstitutionModifierIds = new Set<string>()

    if (item.product.trackInventory && item.product.inventoryMethod === 'QUANTITY') {
      if (!item.product.inventory) {
        throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No existe inventario para "${item.product.name}".`)
      }
      demands.push({
        areaTicketLineId: item.areaTicketLineId,
        orderItemId: item.id,
        inventoryKind: AreaTicketInventoryTarget.QUANTITY_INVENTORY,
        inventoryId: item.product.inventory.id,
        quantityBaseUnits: effectiveQuantity,
        label: item.product.name,
      })
    } else if (item.product.trackInventory && item.product.inventoryMethod === 'RECIPE') {
      if (!item.product.recipe) {
        throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No existe receta para "${item.product.name}".`)
      }
      for (const recipeLine of item.product.recipe.lines) {
        if (recipeLine.isOptional) continue
        const substitution =
          recipeLine.isVariable && recipeLine.linkedModifierGroupId
            ? item.modifiers.find(
                candidate =>
                  candidate.modifier?.groupId === recipeLine.linkedModifierGroupId &&
                  candidate.modifier.inventoryMode === 'SUBSTITUTION' &&
                  candidate.modifier.rawMaterialId &&
                  candidate.modifier.quantityPerUnit,
              )
            : undefined
        if (substitution?.modifier) {
          consumedSubstitutionModifierIds.add(substitution.modifier.id)
          continue
        }
        const perSale = convertUnit(recipeLine.quantity, recipeLine.unit, recipeLine.rawMaterial.unit)
        demands.push({
          areaTicketLineId: item.areaTicketLineId,
          orderItemId: item.id,
          inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL,
          inventoryId: recipeLine.rawMaterial.id,
          quantityBaseUnits: perSale.mul(effectiveQuantity),
          label: recipeLine.rawMaterial.name,
        })
      }
    }

    for (const orderModifier of item.modifiers) {
      const modifier = orderModifier.modifier
      if (!modifier?.rawMaterial || modifier.quantityPerUnit == null) continue
      const consumesInventory = modifier.inventoryMode === 'ADDITION' || consumedSubstitutionModifierIds.has(modifier.id)
      if (!consumesInventory) continue
      const modifierUnit = modifier.unit ?? modifier.rawMaterial.unit
      const perSelection = convertUnit(modifier.quantityPerUnit, modifierUnit, modifier.rawMaterial.unit)
      demands.push({
        areaTicketLineId: item.areaTicketLineId,
        orderItemId: item.id,
        inventoryKind: AreaTicketInventoryTarget.RAW_MATERIAL,
        inventoryId: modifier.rawMaterial.id,
        quantityBaseUnits: perSelection.mul(effectiveQuantity).mul(orderModifier.quantity),
        label: modifier.rawMaterial.name,
      })
    }
  }

  // A single reservation can aggregate base + modifier demand for the same
  // line/target, so aggregate before matching it against reservation coverage.
  const byLineTarget = new Map<string, AreaOrderInventoryDemand>()
  for (const demand of demands) {
    const lineKey = demand.areaTicketLineId ?? `order-item:${demand.orderItemId}`
    const key = `${lineKey}:${demand.inventoryKind}:${demand.inventoryId}`
    const current = byLineTarget.get(key)
    if (current) current.quantityBaseUnits = current.quantityBaseUnits.add(demand.quantityBaseUnits)
    else byLineTarget.set(key, { ...demand })
  }

  const areaTicketLineIds = [...new Set(items.map(item => item.areaTicketLineId).filter((id): id is string => !!id))]
  const coveredTargets = new Map<string, Prisma.Decimal>()
  if (areaTicketLineIds.length > 0) {
    const reservations = await tx.areaTicketInventoryReservation.findMany({
      where: {
        venueId,
        areaTicketLineId: { in: areaTicketLineIds },
        status: {
          in: [AreaTicketInventoryReservationStatus.ACTIVE, AreaTicketInventoryReservationStatus.CONSUMED],
        },
      },
      select: { areaTicketLineId: true, inventoryKind: true, inventoryId: true, quantityBaseUnits: true },
    })
    for (const reservation of reservations) {
      const key = `${reservation.areaTicketLineId}:${reservation.inventoryKind}:${reservation.inventoryId}`
      coveredTargets.set(key, (coveredTargets.get(key) ?? new Prisma.Decimal(0)).add(reservation.quantityBaseUnits))
    }
  }

  const byTarget = new Map<string, AggregatedAreaOrderInventoryDemand>()
  for (const demand of byLineTarget.values()) {
    let uncoveredQuantity = demand.quantityBaseUnits
    if (demand.areaTicketLineId) {
      const coveredQuantity =
        coveredTargets.get(`${demand.areaTicketLineId}:${demand.inventoryKind}:${demand.inventoryId}`) ?? new Prisma.Decimal(0)
      uncoveredQuantity = Prisma.Decimal.max(new Prisma.Decimal(0), uncoveredQuantity.sub(coveredQuantity))
    }
    if (uncoveredQuantity.isZero()) continue
    const key = `${demand.inventoryKind}:${demand.inventoryId}`
    const current = byTarget.get(key)
    if (current) current.quantityBaseUnits = current.quantityBaseUnits.add(uncoveredQuantity)
    else {
      byTarget.set(key, {
        inventoryKind: demand.inventoryKind,
        inventoryId: demand.inventoryId,
        quantityBaseUnits: uncoveredQuantity,
        label: demand.label,
      })
    }
  }
  return [...byTarget.values()].sort((a, b) => `${a.inventoryKind}:${a.inventoryId}`.localeCompare(`${b.inventoryKind}:${b.inventoryId}`))
}

/**
 * Applies non-reserved order inventory with the same row-lock protocol used by
 * reservation issuance. Every target is locked and validated before the first
 * mutation, and the caller's transaction rolls back reservation, recipe and
 * modifier writes together on any later failure.
 */
async function consumeUnreservedAreaOrderInventory(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  staffId?: string,
): Promise<void> {
  const demands = await buildUnreservedAreaOrderInventoryDemands(tx, venueId, orderId)
  const lockedTargets: LockedAreaOrderInventoryTarget[] = []

  for (const demand of demands) {
    const rows =
      demand.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY
        ? await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
            SELECT id, "currentStock"
            FROM "Inventory"
            WHERE id = ${demand.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
        : await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; unit: any }>>`
            SELECT id, "currentStock", unit
            FROM "RawMaterial"
            WHERE id = ${demand.inventoryId} AND "venueId" = ${venueId}
            FOR UPDATE
          `
    if (rows.length !== 1) {
      throw domainError(409, 'AREA_TICKET_INVENTORY_MISSING', `No se encontró inventario para "${demand.label}".`)
    }

    const reserved = await tx.areaTicketInventoryReservation.aggregate({
      where: {
        venueId,
        inventoryKind: demand.inventoryKind,
        inventoryId: demand.inventoryId,
        status: AreaTicketInventoryReservationStatus.ACTIVE,
      },
      _sum: { quantityBaseUnits: true },
    })
    const currentStock = new Prisma.Decimal(rows[0].currentStock)
    const available = currentStock.sub(reserved._sum.quantityBaseUnits ?? 0)
    if (available.lessThan(demand.quantityBaseUnits)) {
      throw domainError(
        409,
        'AREA_TICKET_INSUFFICIENT_STOCK',
        `No hay existencia libre suficiente de "${demand.label}". Disponible: ${quantity(available)}; requerida: ${quantity(
          demand.quantityBaseUnits,
        )}.`,
      )
    }

    if (demand.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY) {
      lockedTargets.push({ ...demand, currentStock })
      continue
    }

    const batches = await tx.$queryRaw<Array<{ id: string; remainingQuantity: Prisma.Decimal; costPerUnit: Prisma.Decimal }>>`
      SELECT id, "remainingQuantity", "costPerUnit"
      FROM "StockBatch"
      WHERE "venueId" = ${venueId}
        AND "rawMaterialId" = ${demand.inventoryId}
        AND status = 'ACTIVE'
        AND "remainingQuantity" > 0
      ORDER BY "receivedDate" ASC, id ASC
      FOR UPDATE
    `
    const batchStock = batches.reduce((sum, batch) => sum.add(batch.remainingQuantity), new Prisma.Decimal(0))
    if (batchStock.lessThan(demand.quantityBaseUnits)) {
      throw domainError(
        409,
        'AREA_TICKET_INSUFFICIENT_STOCK',
        `Los lotes FIFO de "${demand.label}" no cubren la venta. Disponible: ${quantity(batchStock)}; requerida: ${quantity(
          demand.quantityBaseUnits,
        )}.`,
      )
    }
    lockedTargets.push({ ...demand, currentStock, unit: (rows[0] as any).unit, batches })
  }

  for (const target of lockedTargets) {
    if (target.inventoryKind === AreaTicketInventoryTarget.QUANTITY_INVENTORY) {
      const updated = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal; previousStock: Prisma.Decimal }>>`
        UPDATE "Inventory"
        SET "currentStock" = "currentStock" - ${target.quantityBaseUnits},
            "updatedAt" = NOW()
        WHERE id = ${target.inventoryId}
          AND "venueId" = ${venueId}
        RETURNING id, "currentStock", ("currentStock" + ${target.quantityBaseUnits}) AS "previousStock"
      `
      if (updated.length !== 1) {
        throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'No pudimos aplicar el inventario de la orden.')
      }
      await tx.inventoryMovement.create({
        data: {
          inventoryId: target.inventoryId,
          type: 'SALE',
          quantity: target.quantityBaseUnits.neg(),
          previousStock: updated[0].previousStock,
          newStock: updated[0].currentStock,
          reason: 'Venta de orden con vales por área',
          reference: orderId,
          createdBy: staffId,
        },
      })
      continue
    }

    let remaining = new Prisma.Decimal(target.quantityBaseUnits)
    let currentStock = new Prisma.Decimal(target.currentStock)
    for (const batch of target.batches ?? []) {
      if (remaining.lessThanOrEqualTo(0)) break
      const batchAvailable = new Prisma.Decimal(batch.remainingQuantity)
      const used = Prisma.Decimal.min(batchAvailable, remaining)
      if (used.lessThanOrEqualTo(0)) continue
      const previousStock = currentStock
      currentStock = currentStock.sub(used)
      const batchRemaining = batchAvailable.sub(used)
      await tx.stockBatch.update({
        where: { id: batch.id },
        data: {
          remainingQuantity: batchRemaining,
          status: batchRemaining.isZero() ? 'DEPLETED' : 'ACTIVE',
          depletedAt: batchRemaining.isZero() ? new Date() : null,
        },
      })
      await tx.rawMaterialMovement.create({
        data: {
          rawMaterialId: target.inventoryId,
          venueId,
          batchId: batch.id,
          type: 'USAGE',
          quantity: used.neg(),
          unit: target.unit,
          previousStock,
          newStock: currentStock,
          costImpact: used.mul(batch.costPerUnit).neg(),
          reason: 'Venta de orden con vales por área',
          reference: orderId,
          createdBy: staffId,
        },
      })
      remaining = remaining.sub(used)
    }
    if (remaining.greaterThan(0)) {
      throw domainError(409, 'AREA_TICKET_INVENTORY_FINALIZATION_FAILED', 'Los lotes FIFO cambiaron durante la venta.')
    }
    await tx.rawMaterial.update({
      where: { id: target.inventoryId },
      data: { currentStock },
    })
  }
}

/**
 * Se llama después de crear Payment pero antes del COMMIT. Payment, Order,
 * sesión, vales y reservas quedan confirmados o revertidos juntos.
 */
export async function finalizeAreaTicketPaymentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    venueId: string
    orderId: string
    paymentId: string
    fullyPaid: boolean
    staffId?: string
    reconcileCapturedPayment?: boolean
    locked: LockedAreaTicketPayment | null
  },
): Promise<{ areaTicketOrder: boolean; sessionId?: string; fullyPaid?: boolean }> {
  if (!input.locked) return { areaTicketOrder: false }
  await tx.$queryRaw`SELECT id FROM "AreaTicketCheckoutSession" WHERE id = ${input.locked.sessionId} AND "venueId" = ${input.venueId} FOR UPDATE`
  const tickets = await tx.areaTicket.findMany({
    where: { venueId: input.venueId, checkoutSessionId: input.locked.sessionId },
    select: { id: true, fulfillmentModeSnapshot: true },
    orderBy: { id: 'asc' },
  })
  if (tickets.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "AreaTicket" WHERE "venueId" = ${input.venueId} AND id IN (${Prisma.join(
        tickets.map(ticket => ticket.id),
      )}) ORDER BY id FOR UPDATE`,
    )
  }
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId} AND "venueId" = ${input.venueId} FOR UPDATE`
  const lockedOrder = await tx.order.findFirst({
    where: { id: input.orderId, venueId: input.venueId },
    select: {
      paymentStatus: true,
      status: true,
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      servedById: true,
      createdById: true,
      areaTicketCode: true,
    },
  })
  if (!lockedOrder) {
    throw domainError(409, 'CHECKOUT_ORDER_MISSING', 'La orden materializada de esta sesión ya no existe.')
  }
  if (lockedOrder.paymentStatus === 'REFUNDED' || lockedOrder.status === 'CANCELLED' || lockedOrder.status === 'DELETED') {
    throw domainError(409, 'CHECKOUT_ORDER_NOT_PAYABLE', 'La orden materializada ya no admite pagos.')
  }
  let finalFullyPaid = input.fullyPaid
  if (input.reconcileCapturedPayment) {
    const payments = await tx.payment.findMany({
      where: { orderId: input.orderId, venueId: input.venueId, status: 'COMPLETED' },
      select: { amount: true, tipAmount: true },
    })
    const totalPaid = payments.reduce((sum, payment) => sum.add(payment.amount).add(payment.tipAmount), new Prisma.Decimal(0))
    const totalTip = payments.reduce((sum, payment) => sum.add(payment.tipAmount), new Prisma.Decimal(0))
    const total = new Prisma.Decimal(lockedOrder.subtotal)
      .sub(lockedOrder.discountAmount ?? 0)
      .add(lockedOrder.serviceChargeAmount ?? 0)
      .add(totalTip)
    const remainingBalance = Prisma.Decimal.max(new Prisma.Decimal(0), total.sub(totalPaid))
    finalFullyPaid = remainingBalance.lessThanOrEqualTo(new Prisma.Decimal('0.01'))
    const paymentStatus = finalFullyPaid ? 'PAID' : totalPaid.greaterThan(0) ? 'PARTIAL' : 'PENDING'
    await tx.order.update({
      where: { id: input.orderId },
      data: {
        paymentStatus,
        status: finalFullyPaid ? 'COMPLETED' : 'PENDING',
        paidAmount: totalPaid,
        remainingBalance,
        tipAmount: totalTip,
        total,
        ...(finalFullyPaid ? { completedAt: new Date() } : {}),
        ...(!lockedOrder.servedById && input.staffId
          ? { servedById: input.staffId, createdById: lockedOrder.createdById ?? input.staffId }
          : {}),
        ...(finalFullyPaid && lockedOrder.areaTicketCode ? { claimedByTerminalId: null, claimedAt: null } : {}),
      },
    })
  } else if ((lockedOrder.paymentStatus === 'PAID') !== finalFullyPaid) {
    throw domainError(
      409,
      'CHECKOUT_PAYMENT_STATE_MISMATCH',
      'El estado de pago de la orden cambió durante la confirmación; requiere conciliación.',
    )
  }
  const attempt = await tx.areaTicketPaymentAttempt.findFirst({
    where: {
      id: input.locked.attemptId,
      checkoutSessionId: input.locked.sessionId,
      orderId: input.orderId,
    },
  })
  if (!attempt) {
    throw domainError(409, 'CHECKOUT_PAYMENT_ATTEMPT_MISSING', 'No encontramos el intento de pago de esta sesión.')
  }
  if (attempt.status === AreaTicketPaymentAttemptStatus.SUCCEEDED) {
    if (attempt.paymentId !== input.paymentId) {
      throw domainError(409, 'CHECKOUT_PAYMENT_ALREADY_FINALIZED', 'La sesión ya fue finalizada por otro pago; requiere conciliación.', {
        paymentAttemptId: attempt.id,
        paymentId: attempt.paymentId,
      })
    }
    return {
      areaTicketOrder: true,
      sessionId: input.locked.sessionId,
      ...(input.reconcileCapturedPayment ? { fullyPaid: finalFullyPaid } : {}),
    }
  }
  // Sin condición A PROPÓSITO: el bloque de arriba ya cubre el caso SUCCEEDED —
  // o lanza CHECKOUT_PAYMENT_ALREADY_FINALIZED o retorna—, así que aquí el intento
  // siempre está pendiente. El `if (status !== SUCCEEDED)` que había era una
  // condición imposible de falsear, y leerla sugería una rama que nunca existió.
  await tx.areaTicketPaymentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: AreaTicketPaymentAttemptStatus.SUCCEEDED,
      paymentId: input.paymentId,
      completedAt: new Date(),
      lastCheckedAt: new Date(),
    },
  })

  if (!finalFullyPaid) {
    await tx.areaTicketCheckoutSession.update({
      where: { id: input.locked.sessionId },
      data: {
        status: AreaTicketCheckoutStatus.PARTIALLY_PAID,
        activePaymentAttemptId: null,
        version: { increment: 1 },
      },
    })
    return {
      areaTicketOrder: true,
      sessionId: input.locked.sessionId,
      ...(input.reconcileCapturedPayment ? { fullyPaid: false } : {}),
    }
  }

  await lockAreaOrderInventoryFootprint(tx, input.venueId, input.locked.sessionId, input.orderId)
  await consumeAreaTicketReservations(tx, input.venueId, input.locked.sessionId, input.orderId, input.staffId)
  await consumeUnreservedAreaOrderInventory(tx, input.venueId, input.orderId, input.staffId)
  const paidAt = new Date()
  const immediateTicketIds = tickets.filter(ticket => ticket.fulfillmentModeSnapshot === FulfillmentMode.IMMEDIATE).map(ticket => ticket.id)
  const deferredTicketIds = tickets.filter(ticket => ticket.fulfillmentModeSnapshot !== FulfillmentMode.IMMEDIATE).map(ticket => ticket.id)
  const paidTicketUpdate = {
    paidAt,
    claimExpiresAt: null,
    version: { increment: 1 },
  }
  if (immediateTicketIds.length > 0) {
    await tx.areaTicket.updateMany({
      where: {
        id: { in: immediateTicketIds },
        venueId: input.venueId,
        checkoutSessionId: input.locked.sessionId,
        orderId: input.orderId,
        status: AreaTicketStatus.CLAIMED,
      },
      data: { ...paidTicketUpdate, status: AreaTicketStatus.DELIVERED },
    })
  }
  if (deferredTicketIds.length > 0) {
    await tx.areaTicket.updateMany({
      where: {
        id: { in: deferredTicketIds },
        venueId: input.venueId,
        checkoutSessionId: input.locked.sessionId,
        orderId: input.orderId,
        status: AreaTicketStatus.CLAIMED,
      },
      data: { ...paidTicketUpdate, status: AreaTicketStatus.PAID },
    })
  }
  await tx.areaTicketCheckoutSession.update({
    where: { id: input.locked.sessionId },
    data: {
      status: AreaTicketCheckoutStatus.PAID,
      activePaymentAttemptId: null,
      version: { increment: 1 },
    },
  })
  return {
    areaTicketOrder: true,
    sessionId: input.locked.sessionId,
    ...(input.reconcileCapturedPayment ? { fullyPaid: true } : {}),
  }
}
