import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { resolveUserRoleForVenue } from '../../middlewares/checkPermission.middleware'
import { isTableOwnershipEnforced, staffCanManageAllTables } from '../../middlewares/checkTableOwnership.middleware'
import { IMPERSONATION_ERROR_CODES } from '../../types/impersonation'
import { esSuperadminReal } from '../access/rolVigente'
import { assertNoLiveTerminalCharge } from '../shared/orderCancelGuard'
import { lockExistingOrderForPayment, ORDER_LOCK_WAIT_BUDGET } from '../shared/paymentShiftClaim'
import { rechazarSiEsImportada } from '../shared/ordenImportada'
import { aCentavos } from '../shared/repartoDescuento'
import { compOrderItemInTransaction } from './comp-item.mobile.service'
import { tieneRenglonDeTarjeta } from '../giftCards/giftCardPredicados'

const externalIdSchema = z.string().min(1).max(256)
const centsSchema = z.number().int().safe()
// Presupuesto de ESTA revisión; no modifica el catálogo ni los escritores de órdenes.
const MAX_MODIFIER_UNITS = 100
const MAX_REASON_CHARACTERS = 500
const modifierIdsSchema = z.array(z.string().cuid()).max(MAX_MODIFIER_UNITS)
const originalLineSchema = z
  .object({
    externalId: externalIdSchema,
    productId: z.string().cuid(),
    quantity: z.number().int().positive().safe(),
    modifierIds: modifierIdsSchema,
    isCortesia: z.literal(true),
    cortesiaReason: z.string().max(MAX_REASON_CHARACTERS).trim().min(1),
  })
  .strict()
const canonicalLineSchema = z
  .object({
    externalId: externalIdSchema,
    productId: z.string().cuid(),
    quantity: z.number().int().positive().safe(),
    modifierIds: modifierIdsSchema,
    isCortesia: z.boolean(),
    cortesiaReason: z.string().max(MAX_REASON_CHARACTERS).nullable(),
    id: z.string().cuid(),
    unitPriceCents: centsSchema,
    totalCents: centsSchema,
    discountCents: centsSchema,
    taxCents: centsSchema,
    appliedDiscountId: z.string().nullable(),
    modifiers: z
      .array(
        z
          .object({
            id: z.string(),
            modifierId: z.string().cuid(),
            quantity: z.number().int().positive().max(MAX_MODIFIER_UNITS),
            priceCents: centsSchema,
          })
          .strict(),
      )
      .max(MAX_MODIFIER_UNITS),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (line.modifiers.reduce((sum, modifier) => sum + modifier.quantity, 0) > MAX_MODIFIER_UNITS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modifiers'],
        message: 'La revisión admite hasta 100 unidades de extras por línea.',
      })
  })
export const cortesiaPendienteSnapshotSchema = z
  .object({
    orderId: z.string().cuid(),
    externalId: externalIdSchema,
    orderNumber: z.string(),
    version: z.number().int().nonnegative().safe(),
    status: z.string(),
    paymentStatus: z.string(),
    originSystem: z.string(),
    contratoDePrecio: z.string(),
    tableId: z.string().nullable(),
    servedById: z.string().nullable(),
    subtotalCents: centsSchema,
    discountCents: centsSchema,
    taxCents: centsSchema,
    serviceChargeCents: centsSchema,
    deliveryFeeCents: centsSchema,
    tipCents: centsSchema,
    totalCents: centsSchema,
    paidAmountCents: centsSchema,
    remainingBalanceCents: centsSchema,
    lines: z.array(canonicalLineSchema).min(1).max(100),
  })
  .strict()
export const cortesiaPendienteInputSchema = z
  .object({
    originalPaymentKey: externalIdSchema,
    externalId: externalIdSchema,
    expectedAmountCents: z.literal(0),
    expectedTipCents: z.literal(0),
    lines: z.array(originalLineSchema).min(1).max(100),
    confirm: z.boolean().default(false),
    expected: cortesiaPendienteSnapshotSchema.optional(),
  })
  .strict()
export type CortesiaPendienteInput = z.input<typeof cortesiaPendienteInputSchema>
export type CortesiaPendienteSnapshot = z.infer<typeof cortesiaPendienteSnapshotSchema>
/** Contexto interno del adapter autenticado; nunca se toma del body. Permisos read/comp y PIN pertenecen al adapter. */
export interface CortesiaPendienteActor {
  actorId: string
  overrideAuthorizedBy?: string
  /** El adapter debe transportar el indicador del contexto autenticado, nunca del body. */
  isImpersonating?: boolean
}
export interface CortesiaPendienteReply {
  outcome: 'PREVIEW' | 'APPLIED' | 'ALREADY_APPLIED'
  originalPaymentKey: string
  snapshot: CortesiaPendienteSnapshot
}

const orderSelect = {
  id: true,
  externalId: true,
  orderNumber: true,
  version: true,
  status: true,
  paymentStatus: true,
  originSystem: true,
  contratoDePrecio: true,
  tableId: true,
  servedById: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  serviceChargeAmount: true,
  deliveryFeeAmount: true,
  tipAmount: true,
  total: true,
  paidAmount: true,
  remainingBalance: true,
} as const satisfies Prisma.OrderSelect
type ReviewOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>
const itemSelect = {
  id: true,
  externalId: true,
  productId: true,
  quantity: true,
  unitPrice: true,
  total: true,
  discountAmount: true,
  taxAmount: true,
  isCortesia: true,
  cortesiaReason: true,
  appliedDiscountId: true,
  orderPromotionId: true,
  giftCardId: true,
  modifiers: { select: { id: true, modifierId: true, quantity: true, price: true }, take: MAX_MODIFIER_UNITS + 1, orderBy: { id: 'asc' } },
} as const satisfies Prisma.OrderItemSelect
type ReviewItem = Prisma.OrderItemGetPayload<{ select: typeof itemSelect }>
type ReviewInput = z.infer<typeof cortesiaPendienteInputSchema>
type ReadDb = Pick<Prisma.TransactionClient, 'orderItem'>

function changed(): never {
  throw new ConflictError('La cuenta cambió o no coincide con el intento original. Vuelve a revisarla.', 'COURTESY_REVIEW_CHANGED')
}

/** El lector tolerante de reparto no valida entradas: aquí exigimos centavos exactos y representables antes de usarlo. */
function exactCents(value: Prisma.Decimal | number): number {
  const decimal = new Prisma.Decimal(value)
  const cents = aCentavos(decimal)
  if (!decimal.isFinite() || !Number.isSafeInteger(cents) || !decimal.mul(100).eq(cents)) changed()
  return cents
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}
function normalizeSnapshot(snapshot: CortesiaPendienteSnapshot): CortesiaPendienteSnapshot {
  return {
    ...snapshot,
    lines: snapshot.lines
      .map(line => ({
        ...line,
        modifierIds: sorted(line.modifierIds),
        modifiers: [...line.modifiers].sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.externalId.localeCompare(b.externalId)),
  }
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function sourceDigest(venueId: string, input: ReviewInput): string {
  return digest({
    venueId,
    originalPaymentKey: input.originalPaymentKey,
    externalId: input.externalId,
    expectedAmountCents: input.expectedAmountCents,
    expectedTipCents: input.expectedTipCents,
    lines: input.lines
      .map(line => ({ ...line, modifierIds: sorted(line.modifierIds) }))
      .sort((a, b) => a.externalId.localeCompare(b.externalId)),
  })
}

async function readSnapshot(db: ReadDb, order: ReviewOrder): Promise<{ snapshot: CortesiaPendienteSnapshot; items: ReviewItem[] }> {
  // 101 prueba exceso: nunca presentar cien filas como si fueran la cuenta completa.
  const items = await db.orderItem.findMany({ where: { orderId: order.id }, select: itemSelect, take: 101, orderBy: { id: 'asc' } })
  if (items.length < 1 || items.length > 100) changed()
  const lines = items.map(item => {
    if (!item.externalId || !item.productId || item.modifiers.some(m => !m.modifierId)) changed()
    if (item.modifiers.length > MAX_MODIFIER_UNITS) changed()
    let units = 0
    for (const modifier of item.modifiers) {
      const quantity = modifier.quantity ?? 1
      // Decidir el presupuesto ANTES de expandir: una cantidad arbitraria nunca determina una asignación de memoria.
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MODIFIER_UNITS - units) changed()
      units += quantity
    }
    return {
      id: item.id,
      externalId: item.externalId,
      productId: item.productId,
      quantity: item.quantity,
      modifierIds: item.modifiers.flatMap(m => Array.from({ length: m.quantity ?? 1 }, () => m.modifierId!)),
      isCortesia: item.isCortesia,
      cortesiaReason: item.cortesiaReason,
      unitPriceCents: exactCents(item.unitPrice),
      totalCents: exactCents(item.total),
      discountCents: exactCents(item.discountAmount),
      taxCents: exactCents(item.taxAmount),
      appliedDiscountId: item.appliedDiscountId,
      modifiers: item.modifiers.map(m => ({
        id: m.id,
        modifierId: m.modifierId!,
        quantity: m.quantity ?? 1,
        priceCents: exactCents(m.price),
      })),
    }
  })
  const parsed = cortesiaPendienteSnapshotSchema.safeParse({
    orderId: order.id,
    externalId: order.externalId,
    orderNumber: order.orderNumber,
    version: order.version,
    status: order.status,
    paymentStatus: order.paymentStatus,
    originSystem: order.originSystem,
    contratoDePrecio: order.contratoDePrecio,
    tableId: order.tableId,
    servedById: order.servedById,
    subtotalCents: exactCents(order.subtotal),
    discountCents: exactCents(order.discountAmount),
    taxCents: exactCents(order.taxAmount),
    serviceChargeCents: exactCents(order.serviceChargeAmount),
    deliveryFeeCents: exactCents(order.deliveryFeeAmount ?? 0),
    tipCents: exactCents(order.tipAmount),
    totalCents: exactCents(order.total),
    paidAmountCents: exactCents(order.paidAmount),
    remainingBalanceCents: exactCents(order.remainingBalance),
    lines,
  })
  if (!parsed.success) changed()
  return { snapshot: normalizeSnapshot(parsed.data), items }
}

/** Resolver todas las identidades y restricciones ANTES de llamar al primer escritor de cortesía. */
function validateLines(input: ReviewInput, snapshot: CortesiaPendienteSnapshot, items: ReviewItem[]): void {
  if (input.lines.length !== items.length || new Set(items.map(item => item.externalId)).size !== items.length) changed()
  const originals = new Map(input.lines.map(line => [line.externalId, line]))
  for (const line of snapshot.lines) {
    const original = originals.get(line.externalId)
    if (
      !original ||
      original.productId !== line.productId ||
      original.quantity !== line.quantity ||
      JSON.stringify(sorted(original.modifierIds)) !== JSON.stringify(line.modifierIds)
    )
      changed()
    if (line.isCortesia && (line.cortesiaReason !== original.cortesiaReason || line.totalCents !== 0)) changed()
  }
  if (items.some(item => item.orderPromotionId)) changed()
}

async function assertCurrentOwnership(venueId: string, actor: CortesiaPendienteActor, order: ReviewOrder): Promise<void> {
  if (actor.isImpersonating)
    throw new ForbiddenError('No puedes realizar esta acción en modo impersonación (solo lectura).', IMPERSONATION_ERROR_CODES.READ_ONLY)
  const { actorId } = actor
  // La autoridad global se relee bajo el Order lock; ni rol recibido ni overrideAuthorizedBy la conceden.
  if (await esSuperadminReal(actorId)) return
  // Sin Request evita la memoria de permisos de los middlewares previos a adquirir el candado.
  const current = await resolveUserRoleForVenue({ userId: actorId, targetVenueId: venueId })
  if (!current.role) throw new ForbiddenError('Ya no tienes acceso a este negocio.')
  if (
    order.tableId &&
    order.servedById &&
    order.servedById !== actorId &&
    (await isTableOwnershipEnforced(venueId)) &&
    !(await staffCanManageAllTables(actorId, venueId))
  ) {
    throw new ForbiddenError('Esta mesa pertenece a otra persona.', 'TABLE_OWNED_BY_OTHER')
  }
}

/** Preview sin efectos; confirmación financiera de la cuenta original, sin crear pagos ni cerrarla. */
export async function revisarCortesiaPendiente(
  venueId: string,
  actor: CortesiaPendienteActor,
  rawInput: unknown,
): Promise<CortesiaPendienteReply> {
  if (!actor?.actorId || !z.string().cuid().safeParse(actor.actorId).success) throw new UnauthorizedError('Autenticación requerida')
  if (actor.overrideAuthorizedBy !== undefined && !z.string().cuid().safeParse(actor.overrideAuthorizedBy).success)
    throw new UnauthorizedError('Autorización interna inválida')
  const parsed = cortesiaPendienteInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new BadRequestError('La captura de cortesía debe estar completa y tener importe y propina cero.')
  const input = parsed.data
  if (new Set(input.lines.map(line => line.externalId)).size !== input.lines.length)
    throw new BadRequestError('Los identificadores originales de los artículos deben ser únicos.')
  if (input.confirm && !input.expected) throw new BadRequestError('Revisa la cuenta antes de confirmar la cortesía.')
  const resolved = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId, externalId: input.externalId } },
    select: orderSelect,
  })
  if (!resolved) throw new NotFoundError('Orden original no encontrada')
  if (!input.confirm) {
    const { snapshot, items } = await readSnapshot(prisma, resolved)
    validateLines(input, snapshot, items)
    if (tieneRenglonDeTarjeta(items)) changed()
    return { outcome: 'PREVIEW', originalPaymentKey: input.originalPaymentKey, snapshot }
  }

  return prisma.$transaction(async tx => {
    if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: resolved.id }))) throw new NotFoundError('Orden original no encontrada')
    const order = await tx.order.findUnique({ where: { id: resolved.id, venueId, externalId: input.externalId }, select: orderSelect })
    if (!order) throw new NotFoundError('Orden original no encontrada')
    const { snapshot, items } = await readSnapshot(tx, order)
    validateLines(input, snapshot, items)
    if (tieneRenglonDeTarjeta(items)) changed()
    rechazarSiEsImportada(order)
    if (
      !['PENDING', 'CONFIRMED', 'PREPARING', 'READY'].includes(order.status) ||
      order.paymentStatus !== 'PENDING' ||
      snapshot.paidAmountCents !== 0
    )
      throw new ConflictError('La cuenta ya no está abierta y sin pagos. Vuelve a revisarla.')
    if (await tx.payment.count({ where: { venueId, orderId: order.id } }))
      throw new ConflictError('La cuenta ya tiene un pago registrado. No se puede corregir con esta revisión.')
    await assertCurrentOwnership(venueId, actor, order)
    await assertNoLiveTerminalCharge(
      tx,
      { venueId, orderId: order.id },
      {
        mensaje: 'Hay un cobro de terminal sin resultado confirmado. Compruébalo antes de aplicar la cortesía.',
      },
    )

    const before = digest(normalizeSnapshot(input.expected!))
    const current = digest(snapshot)
    const source = sourceDigest(venueId, input)
    const missing = snapshot.lines.filter(line => !line.isCortesia)
    if (before !== current) {
      // Sólo el resultado EXACTO de esta revisión permite repetir una confirmación vieja.
      // Tres huellas acotadas en el audit existente: no reconstruir el recálculo ni copiar cien líneas por fila.
      if (missing.length || snapshot.totalCents !== 0) changed()
      const proof = await tx.activityLog.findFirst({
        where: {
          venueId,
          action: 'ORDER_ITEM_COMPED',
          entity: 'OrderItem',
          entityId: { in: snapshot.lines.map(line => line.id) },
          AND: [
            { data: { path: ['orderId'], equals: order.id } },
            { data: { path: ['originalPaymentKey'], equals: input.originalPaymentKey } },
            { data: { path: ['courtesyReview', 'before'], equals: before } },
            { data: { path: ['courtesyReview', 'after'], equals: current } },
            { data: { path: ['courtesyReview', 'source'], equals: source } },
          ],
        },
        select: { id: true },
      })
      if (!proof) changed()
    }
    if (!missing.length) {
      if (snapshot.totalCents !== 0) changed()
      return { outcome: 'ALREADY_APPLIED', originalPaymentKey: input.originalPaymentKey, snapshot }
    }

    const results: Array<{ line: (typeof missing)[number]; result: Awaited<ReturnType<typeof compOrderItemInTransaction>> }> = []
    for (const line of missing) {
      const original = input.lines.find(original => original.externalId === line.externalId)!
      const result = await compOrderItemInTransaction(tx, {
        venueId,
        orderId: order.id,
        itemId: line.id,
        reason: original.cortesiaReason,
        staffId: actor.actorId,
        captureBenefits: true,
      })
      results.push({ line, result })
    }
    const finalOrder = await tx.order.findUnique({ where: { id: order.id, venueId, externalId: input.externalId }, select: orderSelect })
    if (!finalOrder) changed()
    const final = await readSnapshot(tx, finalOrder)
    validateLines(input, final.snapshot, final.items)
    if (tieneRenglonDeTarjeta(final.items)) changed()
    if (final.snapshot.totalCents !== 0 || final.snapshot.lines.some(line => !line.isCortesia))
      throw new ConflictError('La cuenta conserva un importe por cobrar. No se aplicó la revisión de cortesía.')
    const after = digest(final.snapshot)
    for (const { line, result } of results) {
      // El helper devuelve puntos/premios en la MISMA tx incluso sin captureBenefits; capturarlos conserva sus referencias.
      // Los avisos posteriores de wallet pertenecen al adapter de efectos existente, no a una emisión sin recibo aquí.
      await tx.activityLog.create({
        data: {
          venueId,
          staffId: actor.actorId,
          action: 'ORDER_ITEM_COMPED',
          entity: 'OrderItem',
          entityId: line.id,
          data: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            originalPaymentKey: input.originalPaymentKey,
            reason: input.lines.find(original => original.externalId === line.externalId)!.cortesiaReason,
            productName: result.item.productName,
            amount: Number(result.item.total),
            ...(actor.overrideAuthorizedBy ? { overrideAuthorizedBy: actor.overrideAuthorizedBy } : {}),
            descuentosRetirados: result.recorte.retiradas,
            discountBenefits: result.recorte.benefits ?? [],
            courtesyReview: { before, after, source },
          },
        },
      })
    }
    return { outcome: 'APPLIED', originalPaymentKey: input.originalPaymentKey, snapshot: final.snapshot }
  }, ORDER_LOCK_WAIT_BUDGET)
}
