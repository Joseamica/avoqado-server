// services/dashboard/receipt.dashboard.service.ts
import { DigitalReceipt, ReceiptStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'

// Define types for the receipt snapshot
import { ReceiptDataSnapshot } from '../../schemas/dashboard/receipt.schema'
import logger from '@/config/logger'
import emailService from '../email.service'

// Main function to generate and store a digital receipt
export async function generateAndStoreReceipt(paymentId: string, recipientEmail?: string): Promise<DigitalReceipt> {
  // Check if a digital receipt already exists for this payment
  const existingReceipt = await prisma.digitalReceipt.findFirst({
    where: { paymentId },
  })

  if (existingReceipt) {
    // Update recipient email if provided and different
    if (recipientEmail && existingReceipt.recipientEmail !== recipientEmail) {
      return await prisma.digitalReceipt.update({
        where: { id: existingReceipt.id },
        data: { recipientEmail },
      })
    }
    return existingReceipt
  }

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
    logger.error('Customer relation might not exist in schema:', error)
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

    // Calculate total with fallbacks for older receipts
    const subtotal = order.subtotal || 0
    const taxAmount = order.taxAmount || 0
    const tipAmount = payment.tipAmount || 0
    // Use payment.totalAmount if available, otherwise calculate from order.total + tip, or from components
    const totalAmount = payment.totalAmount || order.total + tipAmount || subtotal + taxAmount + tipAmount || payment.amount + tipAmount

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
      // Order items
      items: order.items || [],
      // Totals
      subtotal,
      taxAmount,
      tipAmount,
      totalAmount,
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
