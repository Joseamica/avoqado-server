import type { TerminalOrderPaymentMethod } from '@prisma/client'

export interface CreateOrderItemInput {
  catalogKey: string // e.g. "PAX_A910S"
  quantity: number
  namePrefix?: string // default = productName
}

export interface CreateOrderInput {
  venueId: string
  createdById: string
  items: CreateOrderItemInput[]
  contactName: string
  contactEmail: string
  contactPhone: string
  shippingAddress: string
  shippingAddress2?: string
  shippingCity: string
  shippingState: string
  shippingZip: string
  shippingCountry?: string
  paymentMethod: TerminalOrderPaymentMethod
}

export interface OrderTotals {
  subtotalCents: number
  taxCents: number
  totalCents: number
  currency: 'MXN'
}

export interface AssignSerialsItemInput {
  orderItemId: string
  units: Array<{ name: string; serial: string }>
}

export interface AssignSerialsInput {
  orderId: string
  assignedBy: string
  items: AssignSerialsItemInput[]
}

export interface UploadSpeiProofInput {
  orderId: string
  /** Venue of the route: an order of another venue is "not found" (D1). */
  venueId: string
  file: {
    buffer: Buffer
    mimetype: string
    originalname: string
    size: number
  }
}

export interface ApproveSpeiInput {
  orderId: string
  approvedBy: string // email or "system" or "magic-link"
  /** La llave de la liga que se usó: tiene que ser la VIGENTE del pedido (D1, 1-nov). */
  token: string
}

export interface RejectSpeiInput {
  orderId: string
  reason: string
  rejectedBy: string
  /** La llave de la liga que se usó: tiene que ser la VIGENTE del pedido (D1, 1-nov). */
  token: string
}
