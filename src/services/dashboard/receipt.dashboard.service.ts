// services/dashboard/receipt.dashboard.service.ts
import { DigitalReceipt, Prisma, ReceiptStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'

// Define types for the receipt snapshot
import { ReceiptDataSnapshot } from '../../schemas/dashboard/receipt.schema'
import { copiaGuardada, totalesConLaCopia } from '../shared/lineasDelTicket'
import logger from '@/config/logger'
import emailService from '../email.service'
import { contarCobrosDeVenta, ticketTotals, ticketTotalsDelSnapshot, ticketTotalsSinDesglose } from '../shared/ticketTotals'
import { ORDEN_RECIBO_CANONICO, reciboCanonicoDelPago } from '../shared/reciboCanonico'
import { productosDelSnapshot } from '../shared/productosDelRecibo'

// Main function to generate and store a digital receipt
export async function generateAndStoreReceipt(paymentId: string, recipientEmail?: string): Promise<DigitalReceipt>
export async function generateAndStoreReceipt(
  venueId: string,
  paymentId: string,
  recipientEmail?: string,
  db?: Prisma.TransactionClient,
): Promise<DigitalReceipt>
export async function generateAndStoreReceipt(
  arg1: string,
  arg2?: string,
  arg3?: string,
  db: Prisma.TransactionClient = prisma,
): Promise<DigitalReceipt> {
  let venueId: string | undefined
  let paymentId: string
  let recipientEmail: string | undefined

  if (typeof arg3 === 'string') {
    venueId = arg1
    paymentId = arg2 as string
    recipientEmail = arg3
  } else if (typeof arg2 === 'undefined') {
    paymentId = arg1
  } else if (arg2.includes('@')) {
    paymentId = arg1
    recipientEmail = arg2
  } else {
    venueId = arg1
    paymentId = arg2
  }

  const payment = venueId
    ? await db.payment.findFirst({
        where: {
          id: paymentId,
          venueId,
        },
      })
    : await db.payment.findUnique({
        where: { id: paymentId },
      })

  if (!payment) {
    throw new NotFoundError(venueId ? 'Payment not found in this venue' : 'Payment not found')
  }

  // Check if a digital receipt already exists for this payment
  // r4 R4-A1: el recibo canónico (el más viejo por (createdAt, id)), el mismo que el TPV, el POS y el móvil.
  const existingReceipt = await reciboCanonicoDelPago(db, paymentId)

  if (existingReceipt) {
    // Update recipient email if provided and different
    if (recipientEmail && existingReceipt.recipientEmail !== recipientEmail) {
      return await db.digitalReceipt.update({
        where: { id: existingReceipt.id },
        data: { recipientEmail },
      })
    }
    return existingReceipt
  }

  // Get venue data
  const venue = await db.venue.findUnique({
    where: { id: payment.venueId },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      state: true,
      zipCode: true,
      phone: true,
      email: true, // Add email field
      logo: true,
      primaryColor: true, // Add primaryColor for theming
      currency: true, // Add currency field
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Get order details
  const order = await db.order.findUnique({
    where: { id: payment.orderId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Get order items and all their modifiers in 2 queries (avoids N+1)
  const [orderItems, allModifiers] = await Promise.all([
    db.orderItem.findMany({
      where: { orderId: payment.orderId },
      include: {
        product: true,
      },
    }),
    db.orderItemModifier.findMany({
      where: { orderItem: { orderId: payment.orderId } },
      include: {
        modifier: true,
      },
    }),
  ])

  // Group modifiers by orderItemId
  const modifiersByItemId = new Map<string, typeof allModifiers>()
  for (const mod of allModifiers) {
    const existing = modifiersByItemId.get(mod.orderItemId) || []
    existing.push(mod)
    modifiersByItemId.set(mod.orderItemId, existing)
  }

  const orderItemsWithModifiers = orderItems.map(item => ({
    ...item,
    modifiers: modifiersByItemId.get(item.id) || [],
  }))

  // Try to get customer info if available
  let customer = null
  try {
    // Try to get the customerId if it exists on the order model
    // This is a safe approach that won't throw errors if the field doesn't exist
    const orderWithCustomer: any = order
    if (orderWithCustomer.customerId) {
      customer = await db.customer.findUnique({
        where: { id: orderWithCustomer.customerId },
      })
    }
  } catch (error) {
    // Silently handle if customer relation doesn't exist
    logger.error('Customer relation might not exist in schema:', error)
  }

  // Get processed by staff if available
  let processedBy = null
  if (payment.processedById) {
    processedBy = await db.staff.findUnique({
      where: { id: payment.processedById },
    })
  }

  // These variables were already declared above, removing duplicate declarations

  // Create data snapshot with all information needed to render the receipt
  const baseAmount = parseFloat(payment.amount.toString())
  const tipAmount = parseFloat(payment.tipAmount.toString())

  const dataSnapshot: ReceiptDataSnapshot = {
    payment: {
      id: payment.id,
      amount: baseAmount,
      tipAmount: tipAmount,
      totalAmount: baseAmount + tipAmount, // Standardized calculation
      method: payment.method.toString(),
      status: payment.status.toString(),
      createdAt: payment.createdAt.toISOString(), // Convert to string for consistency
    },
    venue: {
      id: venue.id,
      name: venue.name,
      address: venue.address || '',
      city: venue.city || '',
      state: venue.state || '',
      zipCode: venue.zipCode || '',
      phone: venue.phone || '',
      email: venue.email || '', // Add email field for consistency
      logo: venue.logo || undefined, // Ensure proper optional handling
      primaryColor: venue.primaryColor || undefined, // Add primaryColor for theming
      currency: venue.currency || 'MXN', // Use venue currency or default
    },
    order: {
      id: order.id,
      number: typeof order.orderNumber === 'number' ? order.orderNumber : 0,
      items: orderItemsWithModifiers.map(item => {
        // Prefer denormalized productName (always set at create time, survives
        // product deletion). Fall back to live product relation, then to
        // "Importe personalizado" for custom line items with no productId.
        const name = item.productName || item.product?.name || 'Importe personalizado'
        const unitPrice = parseFloat(item.unitPrice?.toString() || '0')
        const totalPrice = parseFloat(item.total?.toString() || '0')
        return {
          name,
          quantity: item.quantity,
          price: unitPrice,
          totalPrice,
          // Venta por peso: kilos pesados (price = precio por kg); null en líneas normales.
          weightKg: item.weightQuantity != null ? parseFloat(item.weightQuantity.toString()) : null,
          modifiers: item.modifiers.map(mod => ({
            name: mod.name || mod.modifier?.name || 'Modificador',
            price: parseFloat(mod.price?.toString() || mod.modifier?.price?.toString() || '0'),
          })),
        }
      }),
      subtotal: parseFloat(order.subtotal.toString()),
      taxAmount: parseFloat((order.taxAmount || (order as any).tax || 0).toString()), // Standardized to taxAmount
      total: parseFloat(order.total.toString()),
      createdAt: order.createdAt.toISOString(), // Convert to string for consistency
    },
    processedBy: processedBy
      ? {
          name: `${processedBy.firstName || ''} ${processedBy.lastName || ''}`.trim() || 'Staff Member',
        }
      : undefined,
    // Use customer data if available in a type-safe way
    customer: customer
      ? {
          name: (customer as any).name || `${(customer as any).firstName || ''} ${(customer as any).lastName || ''}`.trim() || 'Customer',
          email: (customer as any).email || undefined,
        }
      : undefined,
    // IVA por producto, plan 7 (D3; r2 R2-10): congelado al crear el recibo, del MISMO cobro y la MISMA orden que el resto del snapshot.
    ticketTotals: ticketTotals({
      payment: { amount: payment.amount, tipAmount: payment.tipAmount, type: payment.type, status: payment.status },
      order,
      cobrosDeVenta: await contarCobrosDeVenta(db, payment.orderId),
    }),
    // D1 «fotocopia del ticket»: la copia que guardó ESTE cobro, congelada con el recibo.
    lineasDelTicket: copiaGuardada(payment.processorData) ?? undefined,
  }

  // Create digital receipt
  const digitalReceipt = await db.digitalReceipt.create({
    data: {
      paymentId,
      dataSnapshot,
      recipientEmail,
      status: ReceiptStatus.PENDING,
    },
  })

  return digitalReceipt
}

// Function to send the receipt via email
export async function sendReceiptByEmail(receiptId: string): Promise<DigitalReceipt> {
  const receipt = await prisma.digitalReceipt.findUnique({
    where: { id: receiptId },
    include: { payment: true },
  })

  if (!receipt) {
    throw new BadRequestError('Receipt not found')
  }

  if (!receipt.recipientEmail) {
    throw new BadRequestError('No recipient email provided')
  }

  try {
    // Extract all receipt data from dataSnapshot for email
    const dataSnapshot = receipt.dataSnapshot as any
    const venue = dataSnapshot?.venue || {}
    const order = dataSnapshot?.order || {}
    const payment = dataSnapshot?.payment || {}

    // Format the payment date
    const paymentDate = payment.createdAt
      ? new Date(payment.createdAt).toLocaleDateString('es-MX', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : undefined

    // IVA por producto, plan 7 (D3; r1 #4): los totales del comprobante de ESTE cobro, tal como se congelaron. Un recibo viejo
    // (sin totales congelados) cae al total del cobro guardado, sin desglose: nunca al subtotal o al total de toda la orden, que en
    // un cobro parcial mentían, ni al cobro vivo (`receipt.payment`), que pudo corregirse después de emitir el recibo.
    const congelados = ticketTotalsDelSnapshot(dataSnapshot)
    // Inalcanzable hoy (0 de 18,815 recibos sin el cobro en su snapshot), pero si pasa, que se vea (revisión T3 m2).
    if (!congelados) logger.warn('Correo del recibo sin el cobro en su snapshot: los totales salen en $0', { receiptId: receipt.id })
    // D1: con copia del ticket, el subtotal y el «Descuento» del papel (sus renglones ya salen de `productosDelSnapshot`).
    const totales = totalesConLaCopia(congelados ?? ticketTotalsSinDesglose({ amount: 0, tipAmount: 0 }), dataSnapshot)

    // Send actual email using the email service with full receipt data
    const emailSent = await emailService.sendReceiptEmail(receipt.recipientEmail, {
      // Venue info
      venueName: venue.name || 'Establecimiento',
      venueLogoUrl: venue.logo || undefined,
      venueAddress: venue.address || undefined,
      venueCity: venue.city || undefined,
      venueState: venue.state || undefined,
      venuePhone: venue.phone || undefined,
      venueEmail: venue.email || undefined,
      currency: venue.currency || 'MXN',
      // Receipt info
      receiptUrl: `${process.env.FRONTEND_URL}/receipts/public/${receipt.accessKey}`,
      receiptNumber: receipt.accessKey.slice(-4).toUpperCase(),
      orderNumber: order.number?.toString() || undefined,
      // Order items (D8: también los del recibo de la terminal, que van fuera de `order`)
      items: productosDelSnapshot(dataSnapshot),
      // Totals (IVA por producto, plan 7): misma regla de cuadre que el ticket (subtotal − descuento + cargo + IVA + propina = total)
      subtotal: totales.subtotal,
      discountAmount: totales.discount,
      serviceChargeAmount: totales.serviceCharge,
      taxAmount: totales.addedTax,
      tipAmount: totales.tip,
      totalAmount: totales.total,
      leyendaIva: totales.addedTax === 0,
      esDevolucion: totales.kind === 'DEVOLUCION',
      // Payment info
      paymentMethod: payment.method,
      paymentDate,
      // People
      processedBy: dataSnapshot?.processedBy?.name || undefined,
      customerName: dataSnapshot?.customer?.name || undefined,
    })

    if (!emailSent) {
      throw new Error('Email service failed to send receipt')
    }

    logger.info(`Receipt email sent successfully to ${receipt.recipientEmail}`, {
      receiptId: receipt.id,
      accessKey: receipt.accessKey,
      venueName: venue.name,
    })

    // Update receipt status
    return prisma.digitalReceipt.update({
      where: { id: receiptId },
      data: {
        status: ReceiptStatus.SENT,
        sentAt: new Date(),
      },
    })
  } catch (error) {
    // Update receipt with error status
    await prisma.digitalReceipt.update({
      where: { id: receiptId },
      data: { status: ReceiptStatus.ERROR },
    })
    throw new InternalServerError(`Failed to send receipt email: ${(error as Error).message}`)
  }
}

export async function getReceiptsByPaymentId(paymentId: string): Promise<DigitalReceipt[]> {
  const receipts = await prisma.digitalReceipt.findMany({
    where: { paymentId },
    orderBy: ORDEN_RECIBO_CANONICO,
  })

  if (!receipts) {
    throw new NotFoundError('Receipts not found')
  }

  return receipts
}

// Function to get a receipt by its access key (for public access)
export async function getReceiptByAccessKey(accessKey: string): Promise<DigitalReceipt> {
  const receipt = await prisma.digitalReceipt.findUnique({
    where: { accessKey },
  })

  if (!receipt) {
    throw new NotFoundError('Receipt not found')
  }

  // Update view tracking if not already viewed
  if (!receipt.viewedAt) {
    await prisma.digitalReceipt.update({
      where: { id: receipt.id },
      data: {
        status: ReceiptStatus.VIEWED,
        viewedAt: new Date(),
      },
    })
  }

  return receipt
}
