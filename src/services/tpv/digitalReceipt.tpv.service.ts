import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { DigitalReceipt, ReceiptStatus } from '@prisma/client'

/**
 * Interface for digital receipt data snapshot
 */
interface ReceiptDataSnapshot {
  // Payment info
  payment: {
    id: string
    amount: number
    tipAmount: number
    method: string
    status: string
    splitType: string
    cardBrand?: string
    maskedPan?: string
    entryMode?: string
    authorizationNumber?: string
    referenceNumber?: string
    createdAt: string
  }
  // Venue info
  venue: {
    id: string
    name: string
    address?: string
    city?: string
    state?: string
    phone?: string
    email?: string
    logo?: string
    primaryColor?: string
  }
  // Order info
  order: {
    id: string
    orderNumber: string
    type: string
    source: string
    subtotal: number
    taxAmount: number
    tipAmount: number
    total: number
    table?: {
      number: string
      area?: string
    }
  }
  // Order items
  items: Array<{
    id: string
    productName: string
    quantity: number
    unitPrice: number
    total: number
    modifiers?: Array<{
      name: string
      quantity: number
      price: number
    }>
  }>
  // Staff info
  processedBy?: {
    firstName: string
    lastName: string
  }
  // Receipt metadata
  receiptInfo: {
    generatedAt: string
    currency: string
    taxRate: number
  }
}

/**
 * Generate a digital receipt for a payment
 * @param paymentId Payment ID to generate receipt for
 * @returns Created DigitalReceipt record
 */
export async function generateDigitalReceipt(paymentId: string): Promise<DigitalReceipt> {
  logger.info('Generating digital receipt', { paymentId })

  try {
    // Fetch complete payment data with all related information
    const paymentData = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            address: true,
            city: true,
            state: true,
            phone: true,
            email: true,
            logo: true,
            primaryColor: true,
            currency: true,
          },
        },
        order: {
          include: {
            table: {
              select: {
                number: true,
                area: {
                  select: {
                    name: true,
                  },
                },
              },
            },
            items: {
              include: {
                product: {
                  select: {
                    name: true,
                  },
                },
                modifiers: {
                  include: {
                    modifier: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        processedBy: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    if (!paymentData) {
      throw new Error(`Payment ${paymentId} not found`)
    }

    // Create comprehensive data snapshot
    const dataSnapshot: ReceiptDataSnapshot = {
      payment: {
        id: paymentData.id,
        amount: Number(paymentData.amount),
        tipAmount: Number(paymentData.tipAmount),
        method: paymentData.method,
        status: paymentData.status,
        splitType: paymentData.splitType,
        cardBrand: paymentData.cardBrand || undefined,
        maskedPan: paymentData.maskedPan || undefined,
        entryMode: paymentData.entryMode || undefined,
        authorizationNumber: paymentData.authorizationNumber || undefined,
        referenceNumber: paymentData.referenceNumber || undefined,
        createdAt: paymentData.createdAt.toISOString(),
      },
      venue: {
        id: paymentData.venue.id,
        name: paymentData.venue.name,
        address: paymentData.venue.address || undefined,
        city: paymentData.venue.city || undefined,
        state: paymentData.venue.state || undefined,
        phone: paymentData.venue.phone || undefined,
        email: paymentData.venue.email || undefined,
        logo: paymentData.venue.logo || undefined,
        primaryColor: paymentData.venue.primaryColor || undefined,
      },
      order: {
        id: paymentData.order.id,
        orderNumber: paymentData.order.orderNumber,
        type: paymentData.order.type,
        source: paymentData.order.source,
        subtotal: Number(paymentData.order.subtotal),
        taxAmount: Number(paymentData.order.taxAmount),
        tipAmount: Number(paymentData.order.tipAmount),
        total: Number(paymentData.order.total),
        table: paymentData.order.table
          ? {
              number: paymentData.order.table.number,
              area: paymentData.order.table.area?.name,
            }
          : undefined,
      },
      items: paymentData.order.items.map(item => ({
        id: item.id,
        productName: item.product?.name || item.productName || 'Item',
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        total: Number(item.total),
        modifiers: item.modifiers.map(modifier => ({
          name: modifier.modifier?.name || modifier.name || 'Modifier',
          quantity: modifier.quantity,
          price: Number(modifier.price),
        })),
      })),
      processedBy: paymentData.processedBy
        ? {
            firstName: paymentData.processedBy.firstName,
            lastName: paymentData.processedBy.lastName,
          }
        : undefined,
      receiptInfo: {
        generatedAt: new Date().toISOString(),
        currency: paymentData.venue.currency || 'MXN',
        taxRate: 0.16, // Default Mexican tax rate, could be venue-specific
      },
    }

    // Create the digital receipt record
    const digitalReceipt = await prisma.digitalReceipt.create({
      data: {
        paymentId: paymentId,
        dataSnapshot: dataSnapshot as any, // Prisma Json type
        status: ReceiptStatus.PENDING,
      },
    })

    logger.info('Digital receipt generated successfully', {
      paymentId,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })

    return digitalReceipt
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId, error })
    throw error
  }
}

/**
 * Get digital receipt by access key
 * @param accessKey Unique access key for the receipt
 * @returns DigitalReceipt with data snapshot
 */
export async function getDigitalReceiptByAccessKey(accessKey: string): Promise<DigitalReceipt | null> {
  logger.info('Fetching digital receipt by access key', { accessKey })

  try {
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      include: {
        payment: {
          select: {
            id: true,
            createdAt: true,
          },
        },
      },
    })

    if (receipt) {
      // Update viewedAt timestamp when receipt is accessed
      await prisma.digitalReceipt.update({
        where: { id: receipt.id },
        data: {
          viewedAt: new Date(),
          status: ReceiptStatus.VIEWED,
        },
      })

      logger.info('Digital receipt accessed', {
        receiptId: receipt.id,
        accessKey,
        paymentId: receipt.paymentId,
      })
    }

    return receipt
  } catch (error) {
    logger.error('Failed to fetch digital receipt', { accessKey, error })
    throw error
  }
}

/**
 * Generate receipt URL for a given access key
 * @param accessKey Receipt access key
 * @param baseUrl Base URL of the application
 * @returns Full receipt URL
 */
export function generateReceiptUrl(accessKey: string, baseUrl: string): string {
  return `${baseUrl}/receipts/public/${accessKey}`
}
