import { createHash } from 'crypto'
import { Prisma, OrderType, type PosSyncIntent } from '@prisma/client'
import { z } from 'zod'
import AppError, { BadRequestError, NotFoundError, ForbiddenError, ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'

export const HTTP_TYPE = 'HTTP_OP_V1' as const
export const HTTP_PREFIX = 'http:v1:' as const
export const HTTP_MAX_BYTES = 1_048_576

const tokenSchema = z
  .object({
    version: z.literal(1),
    id: z
      .string()
      .uuid('Identidad de operación inválida')
      .transform(x => x.toLowerCase()),
    deviceId: z
      .string()
      .uuid('Identidad de dispositivo inválida')
      .transform(x => x.toLowerCase()),
  })
  .strict()
export type HttpOperation = z.infer<typeof tokenSchema>

const idSchema = z.string().min(1, 'Referencia requerida')
const orderRefs = z.object({ orderId: idSchema }).strict()
const removeChargeRefs = orderRefs.extend({ orderServiceChargeId: idSchema })
const emptyPayload = z.object({}).strict()
const compPayload = z.object({ reason: z.string().trim().min(1, 'El motivo es requerido') }).strict()
const detailsPayload = z
  .object({
    name: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    covers: z.number().finite().min(1).max(200).nullable().optional(),
    customerId: z.string().nullable().optional(),
    orderType: z.enum(['DINE_IN', 'TAKEOUT', 'DELIVERY', 'PICKUP', '']).nullable().optional(),
  })
  .strict()
  .transform(p => ({
    ...(p.name != null ? { name: p.name.trim() } : {}),
    ...(p.notes != null ? { notes: p.notes.trim() } : {}),
    ...(p.covers != null ? { covers: p.covers } : {}),
    ...(p.customerId != null ? { customerId: p.customerId } : {}),
    ...(p.orderType ? { orderType: p.orderType } : {}),
  }))
const manifestShape = <A extends string, R extends z.ZodTypeAny, P extends z.ZodTypeAny>(action: A, refs: R, payload: P) =>
  z.object({ action: z.literal(action), refs, payload }).strict()
export const manifestSchema = z.discriminatedUnion('action', [
  manifestShape('moveOrder', orderRefs.extend({ targetTableId: idSchema }), emptyPayload),
  manifestShape('assignOrder', orderRefs.extend({ staffId: idSchema }), emptyPayload),
  manifestShape('applyServiceCharge', orderRefs.extend({ serviceChargeId: idSchema }), emptyPayload),
  manifestShape('mergeOrders', orderRefs.extend({ sourceOrderId: idSchema }), emptyPayload),
  manifestShape('splitOrderBySeat', orderRefs, emptyPayload),
  manifestShape('applyOrderDiscount', orderRefs.extend({ discountId: idSchema }), emptyPayload),
  manifestShape('compWholeOrder', orderRefs, compPayload),
  manifestShape('updateOrderDetails', orderRefs, detailsPayload),
  manifestShape(
    'cancelOrder',
    orderRefs,
    z
      .object({
        reason: z
          .string()
          .nullable()
          .optional()
          .transform(r => r ?? null),
      })
      .strict(),
  ),
  manifestShape('clearTable', z.object({ tableId: idSchema }).strict(), emptyPayload),
  manifestShape('splitOrder', orderRefs, z.object({ itemIds: z.array(idSchema).min(1, 'Selecciona artículos') }).strict()),
  manifestShape('removeServiceCharge', removeChargeRefs, emptyPayload),
  manifestShape(
    'redeemLoyaltyPoints',
    orderRefs.extend({ customerId: idSchema }),
    z.object({ points: z.number().finite().int().positive() }).strict(),
  ),
  manifestShape('removeOrderDiscount', orderRefs.extend({ orderDiscountId: idSchema }), emptyPayload),
  manifestShape('compItem', orderRefs.extend({ itemId: idSchema }), compPayload),
])
export type HttpManifest = z.infer<typeof manifestSchema>

const totalsSchema = z
  .object({
    subtotal: z.number().finite(),
    discountAmount: z.number().finite(),
    serviceChargeAmount: z.number().finite(),
    total: z.number().finite(),
    version: z.number().int(),
  })
  .strict()
const n = z.number().finite()
const text = z.string()
const responseWith = <S extends z.ZodTypeAny>(data: S) =>
  z
    .object({
      status: z.literal(200),
      body: z.object({ success: z.literal(true), data }).strict(),
    })
    .strict()
const bareResponse = z.object({ status: z.literal(200), body: z.object({ success: z.literal(true) }).strict() }).strict()
const messageResponse = <M extends string>(message: M) =>
  z
    .object({
      status: z.literal(200),
      body: z.object({ success: z.literal(true), message: z.literal(message) }).strict(),
    })
    .strict()
const checkResult = z.object({ id: idSchema, orderNumber: text, total: n, version: z.number().int() }).strict()
const seatResult = z.object({ id: idSchema, orderNumber: text, total: n, seat: z.number().int() }).strict()
const responses = {
  moveOrder: bareResponse,
  assignOrder: responseWith(z.object({ staffName: text }).strict()),
  applyServiceCharge: responseWith(totalsSchema),
  mergeOrders: responseWith(
    z
      .object({
        target: checkResult,
        merged: z.object({ id: idSchema, orderNumber: text, items: z.number().int() }).strict(),
        tableFreed: z.boolean(),
      })
      .strict(),
  ),
  splitOrderBySeat: responseWith(z.object({ source: seatResult, created: z.array(seatResult) }).strict()),
  applyOrderDiscount: responseWith(totalsSchema.extend({ orderDiscountId: idSchema, name: text, amount: n })),
  compWholeOrder: responseWith(totalsSchema.extend({ itemsComped: z.number().int(), compedAmount: n, reason: text })),
  updateOrderDetails: responseWith(
    z
      .object({
        name: text.nullable(),
        notes: text.nullable(),
        covers: n.nullable(),
        customerId: text.nullable(),
        orderType: z.nativeEnum(OrderType),
      })
      .strict(),
  ),
  cancelOrder: messageResponse('Orden cancelada exitosamente'),
  clearTable: messageResponse('Mesa liberada'),
  splitOrder: responseWith(z.object({ source: checkResult, created: checkResult }).strict()),
  removeServiceCharge: responseWith(totalsSchema),
  redeemLoyaltyPoints: responseWith(
    z.object({ pointsRedeemed: z.number().int(), discountAmount: n, newBalance: z.number().int(), order: totalsSchema }).strict(),
  ),
  removeOrderDiscount: responseWith(totalsSchema),
  compItem: responseWith(totalsSchema.extend({ itemId: idSchema, reason: text })),
} satisfies Record<HttpManifest['action'], z.ZodTypeAny>
const affectedRefsSchema = z.array(
  z
    .object({
      kind: z.enum([
        'Order',
        'OrderItem',
        'Table',
        'Staff',
        'ServiceCharge',
        'OrderServiceCharge',
        'Discount',
        'OrderDiscount',
        'Customer',
        'LoyaltyTransaction',
        'StampReward',
        'OrderPromotion',
        'KdsOrder',
        'KdsOrderItem',
      ]),
      id: idSchema,
    })
    .strict(),
)
const receiptFor = <A extends HttpManifest['action'], R extends z.ZodTypeAny, S extends z.ZodTypeAny>(action: A, refs: R, response: S) => {
  const common = z.object({
    protocol: z.literal(HTTP_TYPE),
    action: z.literal(action),
    request: z
      .object({ originalActorId: text.nullable(), deviceId: text.uuid(), refs, payloadHash: text.regex(/^[a-f0-9]{64}$/) })
      .strict(),
    affectedRefs: affectedRefsSchema,
  })
  return z.discriminatedUnion('outcome', [
    common.extend({ outcome: z.literal('APPLIED'), originalResponse: response }).strict(),
    common
      .extend({
        outcome: z.literal('REJECTED'),
        fencedByStaffId: text.optional(),
        rejection: z.object({ status: z.number().int().min(400).max(499), code: text, message: text }).strict(),
      })
      .strict(),
  ])
}
const loyaltyRefundSchema = z.object({ pointsRefunded: z.number().int(), customerId: idSchema, transactionId: idSchema }).strict()
const stampRefundSchema = z.object({ rewardId: idSchema, customerId: idSchema, rewardLabel: text }).strict()
const discountBenefitSchema = z
  .object({ orderDiscountId: idSchema, loyaltyRefund: loyaltyRefundSchema.nullable(), stampRefund: stampRefundSchema.nullable() })
  .strict()
const compItemBase = receiptFor('compItem', orderRefs.extend({ itemId: idSchema }), responses.compItem)
const compItemEnvelope = z.discriminatedUnion('outcome', [
  compItemBase.options[0].extend({ effects: z.object({ discountBenefits: z.array(discountBenefitSchema) }).strict() }),
  compItemBase.options[1],
])
const compWholeBase = receiptFor('compWholeOrder', orderRefs, responses.compWholeOrder)
const compWholeEnvelope = z.discriminatedUnion('outcome', [
  compWholeBase.options[0].extend({ effects: z.object({ discountBenefits: z.array(discountBenefitSchema) }).strict() }),
  compWholeBase.options[1],
])
const removalBase = receiptFor('removeOrderDiscount', orderRefs.extend({ orderDiscountId: idSchema }), responses.removeOrderDiscount)
const removalEnvelope = z.discriminatedUnion('outcome', [
  removalBase.options[0].extend({
    effects: z.object({ loyaltyRefund: loyaltyRefundSchema.nullable(), stampRefund: stampRefundSchema.nullable() }).strict(),
  }),
  removalBase.options[1],
])
// Collapse only Zod's builder representation; preserve exact input/output types without casts.
const schemaOf = <S extends z.ZodTypeAny>(schema: S): z.ZodType<z.output<S>, z.ZodTypeDef, z.input<S>> => schema
export const envelopeSchema = z.union([
  schemaOf(receiptFor('moveOrder', orderRefs.extend({ targetTableId: idSchema }), responses.moveOrder)),
  schemaOf(receiptFor('assignOrder', orderRefs.extend({ staffId: idSchema }), responses.assignOrder)),
  schemaOf(receiptFor('applyServiceCharge', orderRefs.extend({ serviceChargeId: idSchema }), responses.applyServiceCharge)),
  schemaOf(receiptFor('mergeOrders', orderRefs.extend({ sourceOrderId: idSchema }), responses.mergeOrders)),
  schemaOf(receiptFor('splitOrderBySeat', orderRefs, responses.splitOrderBySeat)),
  schemaOf(receiptFor('applyOrderDiscount', orderRefs.extend({ discountId: idSchema }), responses.applyOrderDiscount)),
  schemaOf(compWholeEnvelope),
  schemaOf(receiptFor('updateOrderDetails', orderRefs, responses.updateOrderDetails)),
  schemaOf(receiptFor('cancelOrder', orderRefs, responses.cancelOrder)),
  schemaOf(receiptFor('clearTable', z.object({ tableId: idSchema }).strict(), responses.clearTable)),
  schemaOf(receiptFor('splitOrder', orderRefs, responses.splitOrder)),
  schemaOf(receiptFor('removeServiceCharge', removeChargeRefs, responses.removeServiceCharge)),
  schemaOf(receiptFor('redeemLoyaltyPoints', orderRefs.extend({ customerId: idSchema }), responses.redeemLoyaltyPoints)),
  schemaOf(removalEnvelope),
  schemaOf(compItemEnvelope),
])
export type HttpEnvelope = z.infer<typeof envelopeSchema>

type Action = HttpManifest['action']
type Applied<A extends Action> = Extract<HttpEnvelope, { action: A; outcome: 'APPLIED' }>
export type OperationInput<A extends Action = Action> = {
  venueId: string
  actorId: string
  operation: HttpOperation
  manifest: Extract<HttpManifest, { action: A }>
}
export type DomainResult<A extends Action = Action> = A extends Action
  ? {
      response: Applied<A>['originalResponse']
      affectedRefs: HttpEnvelope['affectedRefs']
    } & (Applied<A> extends { effects: infer E } ? { effects: E } : {})
  : never
export type OriginalResponse = z.infer<typeof responses.removeServiceCharge>
export type OperationReply =
  | { kind: 'TERMINAL'; envelope: HttpEnvelope; appliedNow: boolean }
  | { kind: 'RETRY'; code: 'OPERATION_OUTCOME_PENDING' }

export class DomainRejected extends Error {
  constructor(readonly rejection: { status: number; code: string; message: string }) {
    super(rejection.code)
  }
}

export function parseHttpOperation(body: unknown): HttpOperation | undefined {
  if (body === null || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'httpOperation')) return undefined
  const parsed = tokenSchema.safeParse((body as Record<string, unknown>).httpOperation)
  if (!parsed.success) throw new BadRequestError('Identidad de operación inválida', 'HTTP_OPERATION_INVALID')
  return parsed.data
}

function parseManifest(input: HttpManifest): HttpManifest {
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) throw new BadRequestError('Manifiesto de operación inválido', 'HTTP_OPERATION_INVALID')
  return parsed.data
}

export function fingerprint(input: HttpManifest): string {
  const m = manifestSchema.parse(input)
  const method = ['cancelOrder', 'removeOrderDiscount', 'removeServiceCharge'].includes(m.action) ? 'DELETE' : 'POST'
  return createHash('sha256')
    .update(JSON.stringify({ action: m.action, method, refs: m.refs, payload: m.payload }))
    .digest('hex')
}

export function serializeEnvelope(envelope: HttpEnvelope): HttpEnvelope {
  const json = JSON.stringify(envelopeSchema.parse(envelope))
  if (Buffer.byteLength(json, 'utf8') > HTTP_MAX_BYTES) {
    throw new DomainRejected({
      status: 413,
      code: 'RECEIPT_TOO_LARGE',
      message: 'El resultado de la operación excede el tamaño permitido. Relee la cuenta.',
    })
  }
  return envelopeSchema.parse(JSON.parse(json))
}

export function isReceiptKeyCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  const constraint = error.meta?.constraint ?? error.meta?.target
  if (constraint === 'PosSyncIntent_venueId_idempotencyKey_key') return true
  if (Array.isArray(constraint) && constraint.length === 1 && constraint[0] === 'PosSyncIntent_venueId_idempotencyKey_key') return true
  const target = error.meta?.target
  return (
    error.meta?.modelName === 'PosSyncIntent' &&
    Array.isArray(target) &&
    target.length === 2 &&
    target.includes('venueId') &&
    target.includes('idempotencyKey')
  )
}

type Stored = PosSyncIntent
const lookup = (i: OperationInput) =>
  prisma.posSyncIntent.findUnique({
    where: {
      venueId_idempotencyKey: { venueId: i.venueId, idempotencyKey: HTTP_PREFIX + i.operation.id },
    },
  })
const retry = (): OperationReply => ({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
const recovered = (envelope: HttpEnvelope): OperationReply => ({ kind: 'TERMINAL', envelope, appliedNow: false })
async function databaseOutcome(run: () => Promise<OperationReply>): Promise<OperationReply> {
  try {
    return await run()
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientRustPanicError
    )
      return retry()
    throw error // AppError authorization/conflict and validation are never downgraded to RETRY.
  }
}
function binding(i: OperationInput, originalActorId: string | null): HttpEnvelope['request'] {
  const common = { originalActorId, deviceId: i.operation.deviceId }
  const payloadHash = fingerprint(i.manifest)
  const manifest = i.manifest
  if (manifest.action === 'clearTable') return { ...common, refs: manifest.refs, payloadHash }
  return { ...common, refs: manifest.refs, payloadHash }
}
function decode(row: Stored, i: OperationInput, requirePostActor: boolean): HttpEnvelope {
  const p = envelopeSchema.safeParse(row.resultJson)
  if (
    !p.success ||
    row.type !== HTTP_TYPE ||
    row.seq !== null ||
    row.localRef !== null ||
    (row.status !== 'ACKED' && row.status !== 'REJECTED')
  )
    throw new ConflictError('Recibo incompatible', 'HTTP_OPERATION_CONFLICT')
  const e = p.data
  if (
    (e.outcome === 'APPLIED') !== (row.status === 'ACKED') ||
    row.deviceId !== i.operation.deviceId ||
    e.request.deviceId !== i.operation.deviceId ||
    e.action !== i.manifest.action ||
    e.request.payloadHash !== fingerprint(i.manifest) ||
    JSON.stringify(e.request.refs) !== JSON.stringify(i.manifest.refs) ||
    row.staffId !== (e.request.originalActorId ?? (e.outcome === 'REJECTED' ? e.fencedByStaffId : undefined))
  )
    throw new ConflictError('La identidad de operación ya fue utilizada', 'HTTP_OPERATION_CONFLICT')
  if (requirePostActor && e.request.originalActorId !== null && e.request.originalActorId !== i.actorId)
    throw new ConflictError('La identidad de operación pertenece a otra persona', 'HTTP_OPERATION_CONFLICT')
  return e // Null-original tombstone fences all POST actors, but contains no APPLIED body.
}
async function readResolveAccess(i: OperationInput): Promise<{ delegated: boolean }> {
  const current = await resolveUserRoleForVenue({ userId: i.actorId, targetVenueId: i.venueId })
  if (!current.role) throw new ForbiddenError('Ya no tienes acceso a este establecimiento', 'HTTP_OPERATION_ACCESS_DENIED')
  const custom = current.permissionSet
    ? null
    : await prisma.venueRolePermission.findUnique({
        where: { venueId_role: { venueId: i.venueId, role: current.role } },
        select: { permissions: true, deniedPermissions: true },
      })
  const allowed = (name: string) =>
    current.permissionSet
      ? evaluatePermissionList(current.permissionSet.permissions, name)
      : hasPermission(current.role!, custom?.permissions ?? null, name, custom?.deniedPermissions ?? null)
  if (!allowed('orders:read') || (i.manifest.action === 'clearTable' && !allowed('tables:read'))) {
    throw new ForbiddenError('No tienes permiso para leer esta operación', 'HTTP_OPERATION_ACCESS_DENIED')
  }
  return { delegated: allowed('tables:manage-all') }
}
async function resolveStored(row: Stored, i: OperationInput): Promise<OperationReply> {
  const access = await readResolveAccess(i) // no request memo; refresh after any wait/unique race
  const e = decode(row, i, false)
  const owner = e.request.originalActorId ?? (e.outcome === 'REJECTED' ? e.fencedByStaffId : undefined)
  if (owner !== i.actorId && !access.delegated)
    throw new ForbiddenError('No tienes permiso para resolver esta operación', 'HTTP_OPERATION_ACCESS_DENIED')
  return recovered(e) // immutable receipt survives deleted targets; do not consult current business rows.
}
async function verifyReceiptRefs(tx: Prisma.TransactionClient, i: OperationInput): Promise<'VERIFIED' | 'UNKNOWN'> {
  const m = i.manifest
  const denied = () => new ForbiddenError('La operación no pertenece a este establecimiento o cuenta', 'HTTP_OPERATION_ACCESS_DENIED')
  if (m.action === 'clearTable') {
    if (!(await tx.table.findFirst({ where: { id: m.refs.tableId, venueId: i.venueId }, select: { id: true } }))) throw denied()
    return 'VERIFIED'
  }
  const order = await tx.order.findFirst({ where: { id: m.refs.orderId, venueId: i.venueId }, select: { id: true } })
  if (!order) throw denied()
  switch (m.action) {
    case 'removeServiceCharge': {
      const row = await tx.orderServiceCharge.findUnique({ where: { id: m.refs.orderServiceChargeId }, select: { orderId: true } })
      if (!row) return 'UNKNOWN'
      if (row.orderId !== order.id) throw denied()
      break
    }
    case 'removeOrderDiscount': {
      const row = await tx.orderDiscount.findUnique({ where: { id: m.refs.orderDiscountId }, select: { orderId: true } })
      if (!row) return 'UNKNOWN'
      if (row.orderId !== order.id) throw denied()
      break
    }
    case 'compItem': {
      const row = await tx.orderItem.findUnique({ where: { id: m.refs.itemId }, select: { orderId: true } })
      if (!row) return 'UNKNOWN'
      if (row.orderId !== order.id) throw denied()
      break
    }
    case 'splitOrder': {
      const ids = [...new Set(m.payload.itemIds)]
      for (let start = 0; start < ids.length; start += 500) {
        const part = ids.slice(start, start + 500)
        const rows = await tx.orderItem.findMany({ where: { id: { in: part } }, select: { id: true, orderId: true }, take: part.length })
        if (rows.some(row => row.orderId !== order.id)) throw denied()
        if (rows.length !== part.length) return 'UNKNOWN'
      }
      break
    }
    case 'moveOrder': {
      const row = await tx.table.findUnique({ where: { id: m.refs.targetTableId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'mergeOrders': {
      const row = await tx.order.findUnique({ where: { id: m.refs.sourceOrderId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'assignOrder': {
      const row = await tx.staffVenue.findUnique({
        where: { staffId_venueId: { staffId: m.refs.staffId, venueId: i.venueId } },
        select: { id: true },
      })
      if (!row) return 'UNKNOWN'
      break
    }
    case 'applyServiceCharge': {
      const row = await tx.serviceCharge.findUnique({ where: { id: m.refs.serviceChargeId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'applyOrderDiscount': {
      const row = await tx.discount.findUnique({ where: { id: m.refs.discountId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'redeemLoyaltyPoints': {
      const row = await tx.customer.findUnique({ where: { id: m.refs.customerId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'updateOrderDetails': {
      if (!m.payload.customerId) break
      const row = await tx.customer.findUnique({ where: { id: m.payload.customerId }, select: { venueId: true } })
      if (!row) return 'UNKNOWN'
      if (row.venueId !== i.venueId) throw denied()
      break
    }
    case 'compWholeOrder':
    case 'splitOrderBySeat':
    case 'cancelOrder':
      break
  }
  return 'VERIFIED'
}
function declaredRefs(m: HttpManifest): HttpEnvelope['affectedRefs'] {
  if (m.action === 'clearTable') return [{ kind: 'Table', id: m.refs.tableId }]
  const refs: HttpEnvelope['affectedRefs'] = [{ kind: 'Order', id: m.refs.orderId }]
  switch (m.action) {
    case 'moveOrder':
      refs.push({ kind: 'Table', id: m.refs.targetTableId })
      break
    case 'assignOrder':
      refs.push({ kind: 'Staff', id: m.refs.staffId })
      break
    case 'applyServiceCharge':
      refs.push({ kind: 'ServiceCharge', id: m.refs.serviceChargeId })
      break
    case 'removeServiceCharge':
      refs.push({ kind: 'OrderServiceCharge', id: m.refs.orderServiceChargeId })
      break
    case 'applyOrderDiscount':
      refs.push({ kind: 'Discount', id: m.refs.discountId })
      break
    case 'removeOrderDiscount':
      refs.push({ kind: 'OrderDiscount', id: m.refs.orderDiscountId })
      break
    case 'compItem':
      refs.push({ kind: 'OrderItem', id: m.refs.itemId })
      break
    case 'mergeOrders':
      refs.push({ kind: 'Order', id: m.refs.sourceOrderId })
      break
    case 'redeemLoyaltyPoints':
      refs.push({ kind: 'Customer', id: m.refs.customerId })
      break
    case 'updateOrderDetails':
      if (m.payload.customerId) refs.push({ kind: 'Customer', id: m.payload.customerId })
      break
    case 'splitOrder':
      refs.push(...[...new Set(m.payload.itemIds)].map(id => ({ kind: 'OrderItem' as const, id })))
      break
    case 'compWholeOrder':
    case 'splitOrderBySeat':
    case 'cancelOrder':
      break
  }
  return refs
}

class UnknownRefs extends Error {}
async function insertRejected(
  i: OperationInput,
  originalActorId: string | null,
  rejection: { status: number; code: string; message: string },
): Promise<OperationReply> {
  try {
    const e = serializeEnvelope(
      envelopeSchema.parse({
        protocol: HTTP_TYPE,
        action: i.manifest.action,
        request: binding(i, originalActorId),
        outcome: 'REJECTED',
        rejection,
        ...(originalActorId === null ? { fencedByStaffId: i.actorId } : {}),
        affectedRefs: declaredRefs(i.manifest),
      }),
    )
    await prisma.$transaction(async tx => {
      // Prisma puede vencer sin cancelar la consulta bloqueada; Postgres debe cortar esa espera.
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${ORDER_LOCK_WAIT_BUDGET.timeout}ms`}, true)`
      await tx.posSyncIntent.create({
        data: {
          venueId: i.venueId,
          staffId: originalActorId ?? i.actorId,
          deviceId: i.operation.deviceId,
          seq: null,
          localRef: null,
          idempotencyKey: HTTP_PREFIX + i.operation.id,
          type: HTTP_TYPE,
          status: 'REJECTED',
          errorCode: rejection.code,
          resultJson: e as Prisma.InputJsonValue,
        },
      })
      if (originalActorId === null) {
        const access = await readResolveAccess(i) // after unique wait and before fencing commit
        if (!access.delegated) throw new ForbiddenError('Solicita resolución gerencial de esta operación', 'HTTP_OPERATION_ACCESS_DENIED')
      }
      // EVERY terminal rejection, including a failed POST, must prove refs before commit.
      // Domain BadRequest/NotFound may precede the charge lookup; they do not prove binding.
      if ((await verifyReceiptRefs(tx, i)) === 'UNKNOWN') throw new UnknownRefs()
    }, ORDER_LOCK_WAIT_BUDGET)
    return recovered(e)
  } catch (error) {
    if (isReceiptKeyCollision(error)) {
      const winner = await lookup(i) // tx aborted, use fresh global client
      if (!winner) return retry()
      return originalActorId === null ? resolveStored(winner, i) : recovered(decode(winner, i, true))
    }
    if (error instanceof UnknownRefs) {
      const winner = await lookup(i) // race may have committed while business target disappeared
      if (!winner) return retry()
      return originalActorId === null ? resolveStored(winner, i) : recovered(decode(winner, i, true))
    }
    if (error instanceof AppError) throw error
    return retry() // uncertain connection/transaction/commit; never assert NOT_APPLIED
  }
}
export function executeHttpOperation<A extends Action>(
  input: OperationInput<A>,
  mutate: (tx: Prisma.TransactionClient) => Promise<DomainResult<A>>,
): Promise<OperationReply> {
  return databaseOutcome(async () => {
    const i: OperationInput = { ...input, manifest: parseManifest(input.manifest) }
    const prior = await lookup(i)
    if (prior) return recovered(decode(prior, i, true))
    try {
      const envelope = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${ORDER_LOCK_WAIT_BUDGET.timeout}ms`}, true)`
        const reservation = await tx.posSyncIntent.create({
          data: {
            venueId: i.venueId,
            staffId: i.actorId,
            deviceId: i.operation.deviceId,
            seq: null,
            localRef: null,
            type: HTTP_TYPE,
            idempotencyKey: HTTP_PREFIX + i.operation.id,
            status: 'PROCESSING',
          },
        })
        let result: DomainResult<A>
        try {
          result = await mutate(tx)
        } catch (error) {
          if (error instanceof BadRequestError || error instanceof NotFoundError)
            throw new DomainRejected({ status: error.statusCode, code: error.code ?? 'OPERATION_REJECTED', message: error.message })
          throw error
        }
        const e = serializeEnvelope(
          envelopeSchema.parse({
            protocol: HTTP_TYPE,
            action: i.manifest.action,
            request: binding(i, i.actorId),
            originalResponse: result.response,
            outcome: 'APPLIED',
            affectedRefs: result.affectedRefs,
            ...('effects' in result ? { effects: result.effects } : {}),
          }),
        )
        await tx.posSyncIntent.update({
          where: { id: reservation.id },
          data: {
            status: 'ACKED',
            errorCode: null,
            resultJson: e as Prisma.InputJsonValue,
          },
        })
        return e
      }, ORDER_LOCK_WAIT_BUDGET)
      return { kind: 'TERMINAL', envelope, appliedNow: true }
    } catch (error) {
      if (isReceiptKeyCollision(error)) {
        const winner = await lookup(i)
        return winner ? recovered(decode(winner, i, true)) : retry()
      }
      // A business error is only a CANDIDATE rejection: insertRejected must verify its refs in its own dispute tx.
      if (error instanceof DomainRejected) return insertRejected(i, i.actorId, error.rejection)
      if (error instanceof AppError) throw error
      return retry()
    }
  })
}
export function resolveHttpOperation<A extends Action>(input: OperationInput<A>): Promise<OperationReply> {
  return databaseOutcome(async () => {
    const i: OperationInput = { ...input, manifest: parseManifest(input.manifest) }
    const access = await readResolveAccess(i)
    const existing = await lookup(i)
    if (existing) return resolveStored(existing, i)
    if (!access.delegated) throw new ForbiddenError('Solicita resolución gerencial de esta operación', 'HTTP_OPERATION_ACCESS_DENIED')
    return insertRejected(i, null, { status: 409, code: 'OPERATION_NOT_APPLIED', message: 'La operación no fue aplicada' })
  })
}
