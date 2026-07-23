import { Decimal } from '@prisma/client/runtime/library'
import AppError from '@/errors/AppError'

export type InterVenueTransferStatusValue =
  | 'REQUESTED'
  | 'APPROVED'
  | 'IN_TRANSIT'
  | 'PARTIALLY_RECEIVED'
  | 'COMPLETED'
  | 'COMPLETED_WITH_VARIANCE'
  | 'REJECTED'
  | 'CANCELLED'

export type InterVenueTransferAction = 'APPROVE' | 'REJECT' | 'CANCEL' | 'DISPATCH' | 'RECEIVE' | 'RESOLVE_VARIANCE'

export interface TransferQuantities {
  requested: Decimal.Value
  dispatched: Decimal.Value
  received: Decimal.Value
  varianceResolved: Decimal.Value
}

export interface DispatchBatchInput {
  id: string
  remainingQuantity: Decimal.Value
  costPerUnit: Decimal.Value
  receivedDate: Date
  expirationDate: Date | null
}

export interface DispatchAllocation {
  batchId: string
  quantity: Decimal
  costPerUnit: Decimal
  receivedDate: Date
  expirationDate: Date | null
  remainingAfter: Decimal
}

export interface ReceiptAllocationInput {
  id: string
  quantityDispatched: Decimal.Value
  quantityReceived: Decimal.Value
}

export interface VarianceAllocationInput extends ReceiptAllocationInput {
  costPerUnit: Decimal.Value
}

const ALLOWED_ACTIONS: Record<InterVenueTransferStatusValue, ReadonlySet<InterVenueTransferAction>> = {
  REQUESTED: new Set(['APPROVE', 'REJECT', 'CANCEL']),
  APPROVED: new Set(['DISPATCH', 'CANCEL']),
  IN_TRANSIT: new Set(['RECEIVE', 'RESOLVE_VARIANCE']),
  PARTIALLY_RECEIVED: new Set(['RECEIVE', 'RESOLVE_VARIANCE']),
  COMPLETED: new Set(),
  COMPLETED_WITH_VARIANCE: new Set(),
  REJECTED: new Set(),
  CANCELLED: new Set(),
}

export function assertTransferTransition(status: InterVenueTransferStatusValue, action: InterVenueTransferAction): void {
  if (!ALLOWED_ACTIONS[status]?.has(action)) {
    throw new AppError(`Transición de traslado no permitida: ${status} -> ${action}`, 409)
  }
}

export function assertTransferQuantities(input: TransferQuantities): void {
  const requested = new Decimal(input.requested)
  const dispatched = new Decimal(input.dispatched)
  const received = new Decimal(input.received)
  const varianceResolved = new Decimal(input.varianceResolved)

  if (!requested.greaterThan(0)) throw new AppError('La cantidad solicitada debe ser mayor que cero', 400)
  if (dispatched.isNegative() || received.isNegative() || varianceResolved.isNegative()) {
    throw new AppError('Las cantidades del traslado no pueden ser negativas', 400)
  }
  if (dispatched.greaterThan(requested)) {
    throw new AppError('La cantidad enviada no puede superar la cantidad solicitada', 400)
  }
  if (received.greaterThan(dispatched)) {
    throw new AppError('La cantidad recibida no puede superar la cantidad enviada', 400)
  }
  if (varianceResolved.greaterThan(requested.sub(received))) {
    throw new AppError('La diferencia resuelta no puede superar la cantidad pendiente', 400)
  }
}

export function deriveTransferCompletionStatus(items: TransferQuantities[]): InterVenueTransferStatusValue {
  if (items.length === 0) throw new AppError('El traslado debe contener al menos un insumo', 400)

  let hasReceipt = false
  let hasVariance = false
  let isFullyAccounted = true

  for (const item of items) {
    assertTransferQuantities(item)
    const requested = new Decimal(item.requested)
    const received = new Decimal(item.received)
    const varianceResolved = new Decimal(item.varianceResolved)

    hasReceipt ||= received.greaterThan(0)
    hasVariance ||= varianceResolved.greaterThan(0)
    isFullyAccounted &&= received.add(varianceResolved).equals(requested)
  }

  if (isFullyAccounted) return hasVariance ? 'COMPLETED_WITH_VARIANCE' : 'COMPLETED'
  return hasReceipt ? 'PARTIALLY_RECEIVED' : 'IN_TRANSIT'
}

export function allocateDispatchFIFO(batches: DispatchBatchInput[], quantity: Decimal.Value): DispatchAllocation[] {
  let pending = new Decimal(quantity)
  if (!pending.greaterThan(0)) throw new AppError('La cantidad a enviar debe ser mayor que cero', 400)

  const allocations: DispatchAllocation[] = []
  const ordered = [...batches].sort((left, right) => {
    const byDate = left.receivedDate.getTime() - right.receivedDate.getTime()
    return byDate === 0 ? left.id.localeCompare(right.id) : byDate
  })

  for (const batch of ordered) {
    if (pending.equals(0)) break
    const available = new Decimal(batch.remainingQuantity)
    if (!available.greaterThan(0)) continue
    const allocated = Decimal.min(available, pending)
    allocations.push({
      batchId: batch.id,
      quantity: allocated,
      costPerUnit: new Decimal(batch.costPerUnit),
      receivedDate: batch.receivedDate,
      expirationDate: batch.expirationDate,
      remainingAfter: available.sub(allocated),
    })
    pending = pending.sub(allocated)
  }

  if (pending.greaterThan(0)) {
    const available = new Decimal(quantity).sub(pending)
    throw new AppError(`Stock insuficiente para el traslado. Disponible: ${available.toString()}`, 400)
  }
  return allocations
}

export function allocateReceiptFIFO(
  allocations: ReceiptAllocationInput[],
  quantity: Decimal.Value,
  previouslyResolvedInTransit: Decimal.Value = 0,
): Array<{ allocationId: string; quantity: Decimal }> {
  let pending = new Decimal(quantity)
  let toSkip = new Decimal(previouslyResolvedInTransit)
  if (!pending.greaterThan(0) || toSkip.isNegative()) {
    throw new AppError('Las cantidades de recepción deben ser válidas', 400)
  }

  const lines: Array<{ allocationId: string; quantity: Decimal }> = []
  for (const allocation of allocations) {
    if (pending.equals(0)) break
    let available = new Decimal(allocation.quantityDispatched).sub(allocation.quantityReceived)
    if (!available.greaterThan(0)) continue

    const skipped = Decimal.min(available, toSkip)
    available = available.sub(skipped)
    toSkip = toSkip.sub(skipped)
    if (!available.greaterThan(0)) continue

    const received = Decimal.min(available, pending)
    lines.push({ allocationId: allocation.id, quantity: received })
    pending = pending.sub(received)
  }

  if (toSkip.greaterThan(0) || pending.greaterThan(0)) {
    throw new AppError('La recepción supera la cantidad pendiente del traslado', 400)
  }
  return lines
}

export function calculateVarianceCostFIFO(
  allocations: VarianceAllocationInput[],
  quantity: Decimal.Value,
  previouslyResolvedInTransit: Decimal.Value = 0,
): Decimal {
  let pending = new Decimal(quantity)
  let toSkip = new Decimal(previouslyResolvedInTransit)
  let cost = new Decimal(0)
  if (!pending.greaterThan(0) || toSkip.isNegative()) {
    throw new AppError('Las cantidades de diferencia deben ser válidas', 400)
  }

  for (const allocation of allocations) {
    let available = Decimal.max(new Decimal(allocation.quantityDispatched).sub(allocation.quantityReceived), 0)
    if (!available.greaterThan(0)) continue

    const skipped = Decimal.min(available, toSkip)
    available = available.sub(skipped)
    toSkip = toSkip.sub(skipped)
    if (!available.greaterThan(0) || !pending.greaterThan(0)) continue

    const resolved = Decimal.min(available, pending)
    cost = cost.add(resolved.mul(allocation.costPerUnit))
    pending = pending.sub(resolved)
  }

  if (toSkip.greaterThan(0) || pending.greaterThan(0)) {
    throw new AppError('La diferencia supera la cantidad pendiente en tránsito', 400)
  }
  return cost
}
