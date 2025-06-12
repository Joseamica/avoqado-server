// services/dashboard/receipt.dashboard.service.ts
import { DigitalReceipt, ReceiptStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'

// Define types for the receipt snapshot
import { ReceiptDataSnapshot } from '../../schemas/dashboard/receipt.schema'

// Main function to generate and store a digital receipt
export async function generateAndStoreReceipt(paymentId: string, recipientEmail?: string): Promise<DigitalReceipt> {
  // Get payment data first
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
  })

  if (!payment) {
    throw new NotFoundError('Payment not found')
  }

  // Get venue data
  const venue = await prisma.venue.findUnique({
    where: { id: payment.venueId },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      state: true,
      zipCode: true,
      phone: true,
      logo: true, // Using logo instead of logoUrl based on schema
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Get order details
  const order = await prisma.order.findUnique({
    where: { id: payment.orderId },
  })

  if (!order) {
    throw new NotFoundError('Order not found')
  }

  // Get order items separately
  const orderItems = await prisma.orderItem.findMany({
    where: { orderId: payment.orderId },
    include: {
      product: true,
    },
  })

  // Get modifiers for each order item
  const orderItemsWithModifiers = await Promise.all(
    orderItems.map(async item => {
      const modifiers = await prisma.orderItemModifier.findMany({
        where: { orderItemId: item.id },
        include: {
          modifier: true,
        },
      })
      return { ...item, modifiers }
    }),
  )

  // Try to get customer info if available
  let customer = null
  try {
    // Try to get the customerId if it exists on the order model
    // This is a safe approach that won't throw errors if the field doesn't exist
    const orderWithCustomer: any = order
    if (orderWithCustomer.customerId) {
      customer = await prisma.customer.findUnique({
        where: { id: orderWithCustomer.customerId },
      })
    }
  } catch (error) {
    // Silently handle if customer relation doesn't exist
    console.log('Customer relation might not exist in schema:', error)
  }

  // Get processed by staff if available
  let processedBy = null
  if (payment.processedById) {
    processedBy = await prisma.staff.findUnique({
      where: { id: payment.processedById },
    })
  }

  // These variables were already declared above, removing duplicate declarations

  // Create data snapshot with all information needed to render the receipt
  const dataSnapshot: ReceiptDataSnapshot = {
    payment: {
      id: payment.id,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      totalAmount: parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount.toString()),
      method: payment.method.toString(),
      status: payment.status.toString(),
      createdAt: payment.createdAt,
    },
    venue: {
      id: venue.id,
      name: venue.name,
      address: venue.address || '',
      city: venue.city || '',
      state: venue.state || '',
      zipCode: venue.zipCode || '',
      phone: venue.phone || '',
      logo: venue.logo, // This would be the venue logo URL
    },
    order: {
      id: order.id,
      number: typeof order.orderNumber === 'number' ? order.orderNumber : 0,
      items: orderItemsWithModifiers.map(item => ({
        name: item.product?.name || 'Unknown Product',
        quantity: item.quantity,
        price: parseFloat((item as any).price?.toString() || '0'),
        totalPrice: parseFloat((item as any).price?.toString() || '0') * item.quantity,
        modifiers: item.modifiers.map(mod => ({
          name: mod.modifier?.name || 'Unknown Modifier',
          price: parseFloat(mod.modifier?.price?.toString() || '0'),
        })),
      })),
      subtotal: order.subtotal,
      tax: order.taxAmount || (order as any).tax || 0, // Flexible field name approach with type safety
      total: order.total,
      createdAt: order.createdAt,
    },
    processedBy: processedBy
      ? {
          name: `${processedBy.firstName || ''} ${processedBy.lastName || ''}`.trim() || 'Staff Member',
        }
      : null,
    // Use customer data if available in a type-safe way
    customer: customer
      ? {
          name: (customer as any).name || `${(customer as any).firstName || ''} ${(customer as any).lastName || ''}`.trim() || 'Customer',
          email: (customer as any).email || null,
        }
      : null,
  }

  // Create digital receipt
  const digitalReceipt = await prisma.digitalReceipt.create({
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
    // In a real implementation, you would call your email service here
    // For example:
    // await emailService.sendTemplate('receipt', {
    //   to: receipt.recipientEmail,
    //   subject: 'Your receipt from Avoqado',
    //   data: {
    //     receiptUrl: `https://dashboard.avoqado.io/r/${receipt.accessKey}`,
    //     venueName: receipt.dataSnapshot.venue.name
    //   }
    // });

    // For now, we'll simulate a successful email send
    console.log(`Email would be sent to ${receipt.recipientEmail} with receipt link: /r/${receipt.accessKey}`)

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
