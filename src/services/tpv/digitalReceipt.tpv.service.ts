import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { DigitalReceipt, ReceiptStatus } from '@prisma/client'
import { contarCobrosDeVenta, ticketTotals, type TicketTotals } from '../shared/ticketTotals'
import { reciboCanonicoDelPago } from '../shared/reciboCanonico'

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
    /** Código estable para que cada área valide la entrega del comprobante pagado. */
    areaDeliveryCode?: string
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
    /** Venta por peso: kilos pesados (unitPrice = precio por kg). Null/absent for normal lines. */
    weightKg?: number | null
    /** Origen operativo de una línea importada desde un vale, para verificación visual. */
    areaSourceLabel?: string
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
  /**
   * IVA por producto, plan 7 (D3): lo que muestra el comprobante de ESTE cobro, congelado al crear el recibo (con `discount` si la
   * venta lo tuvo). Ausente en recibos viejos.
   */
  ticketTotals?: TicketTotals | null
  // Receipt metadata
  receiptInfo: {
    generatedAt: string
    currency: string
    /** @deprecated IVA por producto, plan 7 (D3): nadie lo lee; el ticket no calcula IVA. Se sigue escribiendo para no cambiar la forma del JSON. */
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
    return await prisma.$transaction(async tx => {
      // Serialize every creation/replay for this payment. Historical duplicate
      // receipts remain valid; new callers consistently reuse the oldest one.
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`
      const existing = await reciboCanonicoDelPago(tx, paymentId)
      if (existing) return existing

      // Fetch complete payment data with all related information
      const paymentData = await tx.payment.findUnique({
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
                  fulfillmentArea: {
                    select: {
                      name: true,
                    },
                  },
                  areaTicketLine: {
                    select: {
                      areaTicket: {
                        select: {
                          code: true,
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

      // D1: un renglón cuyo vale se volvió a cobrar en otra cuenta conserva su procedencia (`releasedAreaTicketLineId`) y ya no el
      // vínculo; el recibo de ESTA cuenta sigue diciendo de qué vale era. Una consulta, sólo si hay alguno.
      const lineasRevendidas =
        paymentData.order?.items
          .filter(item => !item.areaTicketLine && item.releasedAreaTicketLineId)
          .map(item => item.releasedAreaTicketLineId!) ?? []
      const codigoDeValeRevendido = new Map(
        lineasRevendidas.length === 0
          ? []
          : (
              await tx.areaTicketLine.findMany({
                where: { id: { in: lineasRevendidas } },
                select: { id: true, areaTicket: { select: { code: true } } },
                take: lineasRevendidas.length,
              })
            ).map(linea => [linea.id, linea.areaTicket.code] as const),
      )

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
          areaDeliveryCode: paymentData.order.areaDeliveryCode || undefined,
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
          productName: item.productName || item.product?.name || 'Item',
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          total: Number(item.total),
          weightKg: item.weightQuantity != null ? Number(item.weightQuantity) : null,
          areaSourceLabel: (() => {
            const codigo =
              item.areaTicketLine?.areaTicket.code ??
              (item.releasedAreaTicketLineId ? codigoDeValeRevendido.get(item.releasedAreaTicketLineId) : undefined)
            return item.fulfillmentArea && codigo ? `${item.fulfillmentArea.name} · Vale ${codigo}` : undefined
          })(),
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
        // IVA por producto, plan 7 (D3; r1 #4, r2 R2-10): los totales del comprobante de ESTE cobro, con la regla única de
        // `ticketTotals`, armados con el MISMO `paymentData` (y su orden) que el resto del snapshot y dentro de la transacción
        // que ya bloqueó el cobro. El visor, el HTML legado, el correo y la reimpresión los leen de aquí.
        ticketTotals: ticketTotals({
          payment: { amount: paymentData.amount, tipAmount: paymentData.tipAmount, type: paymentData.type, status: paymentData.status },
          order: paymentData.order,
          cobrosDeVenta: await contarCobrosDeVenta(tx, paymentData.orderId),
        }),
        receiptInfo: {
          generatedAt: new Date().toISOString(),
          currency: paymentData.venue.currency || 'MXN',
          taxRate: 0.16, // Default Mexican tax rate, could be venue-specific
        },
      }

      // Create the digital receipt record
      const digitalReceipt = await tx.digitalReceipt.create({
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
    })
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
