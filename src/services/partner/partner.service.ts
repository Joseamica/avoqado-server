import prisma from '../../utils/prismaClient'

// Map PlayTelecom status names to our TransactionStatus enum values
const STATUS_MAP: Record<string, string[]> = {
  exitosa: ['COMPLETED'],
  fallida: ['FAILED'],
  cancelada: ['REFUNDED'],
}

interface PartnerSalesQuery {
  organizationId: string
  from: Date
  to: Date
  venueId?: string
  status?: string // exitosa | fallida | cancelada
  page: number
  limit: number
}

interface PartnerSaleRecord {
  transaction_id: string
  fecha_venta: string
  tpv_id: string | null
  tienda_id: string
  tienda: string
  vendedor_id: string | null
  vendedor: string | null
  ciudad: string | null
  producto: string | null
  precio: number
  metodo_pago: string | null
  iccid: string
  portabilidad: boolean
  estado_transaccion: string
  registro_url: string | null
  latitud: string | null
  longitud: string | null
  evidencia_portabilidad_url: string | null
}

interface PartnerSalesResponse {
  data: PartnerSaleRecord[]
  pagination: {
    page: number
    limit: number
    total: number
  }
}

class PartnerService {
  async getSales(query: PartnerSalesQuery): Promise<PartnerSalesResponse> {
    const { organizationId, from, to, venueId, status, page, limit } = query
    const skip = (page - 1) * limit

    // Build where clause: all sold SerializedItems in this org's venues
    const where: any = {
      status: 'SOLD',
      soldAt: {
        gte: from,
        lte: to,
      },
      // Org-scoped: items that belong to the org OR items in org's venues
      OR: [{ organizationId }, { venue: { organizationId } }],
    }

    if (venueId) {
      // Filter by specific selling venue
      where.sellingVenueId = venueId
    }

    // Filter by payment status at DB level (not post-query)
    if (status && STATUS_MAP[status]) {
      where.orderItem = {
        order: {
          payments: {
            some: {
              status: { in: STATUS_MAP[status] },
            },
          },
        },
      }
    }

    // Count total for pagination
    const total = await prisma.serializedItem.count({ where })

    // Main query with all joins
    const items = await prisma.serializedItem.findMany({
      where,
      skip,
      take: limit,
      orderBy: { soldAt: 'desc' },
      include: {
        category: { select: { name: true } },
        sellingVenue: { select: { id: true, name: true, city: true } },
        venue: { select: { id: true, name: true, city: true } },
        orderItem: {
          select: {
            unitPrice: true,
            order: {
              select: {
                orderNumber: true,
                createdById: true,
                createdBy: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
                terminal: {
                  select: {
                    serialNumber: true,
                    lastLatitude: true,
                    lastLongitude: true,
                  },
                },
                payments: {
                  select: {
                    method: true,
                    status: true,
                    saleVerification: {
                      select: {
                        photos: true,
                        isPortabilidad: true,
                      },
                    },
                  },
                  take: 1, // Primary payment
                },
              },
            },
          },
        },
      },
    })

    // Map to PlayTelecom response format
    const data: PartnerSaleRecord[] = items.map(item => {
      const order = item.orderItem?.order
      const payment = order?.payments?.[0]
      const verification = payment?.saleVerification
      const terminal = order?.terminal
      const venue = item.sellingVenue || item.venue

      // Map payment status to PlayTelecom format
      let estadoTransaccion = 'exitosa'
      if (payment?.status === 'FAILED') estadoTransaccion = 'fallida'
      else if (payment?.status === 'REFUNDED') estadoTransaccion = 'cancelada'

      return {
        transaction_id: order?.orderNumber || item.id,
        fecha_venta: item.soldAt?.toISOString() || '',
        tpv_id: terminal?.serialNumber || null,
        tienda_id: venue?.id || '',
        tienda: venue?.name || '',
        vendedor_id: order?.createdBy?.id || null,
        vendedor: order?.createdBy ? `${order.createdBy.firstName} ${order.createdBy.lastName}` : null,
        ciudad: venue?.city || null,
        producto: item.category?.name || null,
        precio: item.orderItem?.unitPrice ? Number(item.orderItem.unitPrice) : 0,
        metodo_pago: payment?.method || null,
        iccid: item.serialNumber,
        portabilidad: verification?.isPortabilidad || false,
        estado_transaccion: estadoTransaccion,
        registro_url: verification?.photos?.[0] || null,
        latitud: terminal?.lastLatitude ? String(terminal.lastLatitude) : null,
        longitud: terminal?.lastLongitude ? String(terminal.lastLongitude) : null,
        evidencia_portabilidad_url: verification?.isPortabilidad && verification?.photos?.[1] ? verification.photos[1] : null,
      }
    })

    return {
      data,
      pagination: {
        page,
        limit,
        total,
      },
    }
  }
}

export const partnerService = new PartnerService()
