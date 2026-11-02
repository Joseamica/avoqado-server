import { ForbiddenError } from '../../errors/AppError'

export const ATTACH_CUSTOMER_PERMISSION = 'orders:attach-customer'

/** Autoridad calculada por el servidor; nunca se deserializa del body. */
export interface CustomerAttributionActor {
  staffId?: string | null
  canAssignHistorical?: boolean
  canAttachAtReceipt?: boolean
  /** Sólo el cliente ya guardado por el POS en su solicitud de cobro, sobre ESA orden. */
  originalCustomer?: { orderId: string; customerId: string }
}

export function hasHistoricalCustomerAuthority(role: string | null | undefined, permitted: boolean): boolean {
  return permitted && ['MANAGER', 'ADMIN', 'OWNER', 'SUPERADMIN'].includes(role ?? '')
}

type PaymentSnapshot = { status: string; type?: string | null; createdAt: Date; processedById?: string | null }
type OrderSnapshot = { status: string; paymentStatus: string | null; customerId?: string | null }

export function isCustomerAssignableSale(payment: Pick<PaymentSnapshot, 'status' | 'type'> | null, order: OrderSnapshot | null): boolean {
  return (
    !!payment &&
    payment.status === 'COMPLETED' &&
    payment.type !== 'REFUND' &&
    !!order &&
    order.paymentStatus === 'PAID' &&
    !['CANCELLED', 'DELETED'].includes(order.status)
  )
}

export function ownsRecentReceipt(payment: PaymentSnapshot | null, actor: CustomerAttributionActor, now = Date.now()): boolean {
  if (!payment || !actor.staffId || !actor.canAttachAtReceipt || payment.status !== 'COMPLETED' || payment.type === 'REFUND') return false
  const age = now - payment.createdAt.getTime()
  return payment.processedById === actor.staffId && age >= 0 && age <= 15 * 60_000
}

export function requireHistoricalCustomerAuthority(actor: CustomerAttributionActor): void {
  if (!actor.canAssignHistorical) {
    throw new ForbiddenError(
      'Sólo un gerente o superior con permiso puede asignar un cliente a esta venta.',
      'CUSTOMER_ASSIGNMENT_REQUIRES_MANAGER',
    )
  }
}
