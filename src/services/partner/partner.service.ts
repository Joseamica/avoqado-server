import { fromZonedTime } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'

// Map PlayTelecom status names to our TransactionStatus enum values
const STATUS_MAP: Record<string, string[]> = {
  exitosa: ['COMPLETED'],
  fallida: ['FAILED'],
  cancelada: ['REFUNDED'],
}

// Partner venues operate in Mexico. Date-only range params (from/to) are
// interpreted as Mexico-local day boundaries so the ETL gets full days.
const PARTNER_TZ = 'America/Mexico_City'

// Req 3 (BAIT): the `ciudad`/`estado` fields must never be null. When the
// store has no location set we send a readable default instead of null.
const CIUDAD_DEFAULT = 'No Definida'
const ESTADO_DEFAULT = 'No Definido'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

interface PartnerSalesQuery {
  organizationId: string
  from: Date
  to: Date
  venueSlug?: string
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
  ciudad: string // never null (Req 3) — defaults to CIUDAD_DEFAULT
  estado: string // never null — geographic state of the store
  codigo_postal: string // store zip code, '' when unknown
  producto: string | null
  tipo_venta: 'LINEA_NUEVA' | 'PORTABILIDAD'
  precio: number
  metodo_pago: string | null
  iccid: string
  portabilidad: boolean
  estado_transaccion: string
  promotor: string | null // chain-of-custody: promoter that held the SIM
  promotor_id: string | null
  supervisor: string | null // chain-of-custody: supervisor that held the SIM
  supervisor_id: string | null
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

/**
 * Resolve a `from`/`to` query param into a real UTC Date.
 *
 * Date-only strings ("2026-03-31") are interpreted as Mexico-local day
 * boundaries — `start` => 00:00:00.000, `end` => 23:59:59.999 — so a range
 * like from=2026-03-01&to=2026-03-31 covers the FULL last day (previously the
 * end was parsed as 00:00 UTC, dropping almost all of March 31). Full ISO
 * datetimes are passed through unchanged for backwards compatibility.
 */
export function resolvePartnerBoundary(value: string, edge: 'start' | 'end'): Date {
  if (DATE_ONLY.test(value)) {
    const time = edge === 'start' ? '00:00:00.000' : '23:59:59.999'
    return fromZonedTime(`${value}T${time}`, PARTNER_TZ)
  }
  return new Date(value)
}

/**
 * Pure mapper: SerializedItem (with includes) → PlayTelecom/BAIT sale record.
 * Exported so the response contract can be unit-tested without the DB.
 *
 * Backwards compatibility (Req 2): existing field names/types are preserved.
 * New fields (estado, codigo_postal, tipo_venta, promotor*, supervisor*) are
 * additive. `ciudad` is the one type tightening — it can no longer be null.
 */
export function toPartnerSaleRecord(item: any): PartnerSaleRecord {
  const order = item.orderItem?.order
  const payment = order?.payments?.[0]
  const verification = payment?.saleVerification
  const terminal = order?.terminal
  const venue = item.sellingVenue || item.venue
  const isPort = verification?.isPortabilidad || false

  // Map payment status to PlayTelecom format
  let estadoTransaccion = 'exitosa'
  if (payment?.status === 'FAILED') estadoTransaccion = 'fallida'
  else if (payment?.status === 'REFUNDED') estadoTransaccion = 'cancelada'

  // Location: prefer the selling venue, fall back to the owning venue, then
  // to a readable default so the value is never null (Req 3).
  const ciudad = item.sellingVenue?.city || item.venue?.city || CIUDAD_DEFAULT
  const estado = item.sellingVenue?.state || item.venue?.state || ESTADO_DEFAULT
  const codigoPostal = item.sellingVenue?.zipCode || item.venue?.zipCode || ''

  const promotor = item.assignedPromoter ? `${item.assignedPromoter.firstName} ${item.assignedPromoter.lastName}` : null
  const supervisor = item.assignedSupervisor ? `${item.assignedSupervisor.firstName} ${item.assignedSupervisor.lastName}` : null

  return {
    transaction_id: order?.orderNumber || item.id,
    fecha_venta: item.soldAt?.toISOString() || '',
    tpv_id: terminal?.serialNumber || null,
    tienda_id: venue?.slug || venue?.id || '',
    tienda: venue?.name || '',
    vendedor_id: order?.createdBy?.id || null,
    vendedor: order?.createdBy ? `${order.createdBy.firstName} ${order.createdBy.lastName}` : null,
    ciudad,
    estado,
    codigo_postal: codigoPostal,
    producto: item.category?.name || null,
    tipo_venta: isPort ? 'PORTABILIDAD' : 'LINEA_NUEVA',
    precio: item.orderItem?.unitPrice ? Number(item.orderItem.unitPrice) : 0,
    metodo_pago: payment?.method || null,
    iccid: item.serialNumber,
    portabilidad: isPort,
    estado_transaccion: estadoTransaccion,
    promotor,
    promotor_id: item.assignedPromoterId || null,
    supervisor,
    supervisor_id: item.assignedSupervisorId || null,
    registro_url: verification?.photos?.[0] || null,
    latitud: terminal?.lastLatitude ? String(terminal.lastLatitude) : null,
    longitud: terminal?.lastLongitude ? String(terminal.lastLongitude) : null,
    evidencia_portabilidad_url: isPort && verification?.photos?.[1] ? verification.photos[1] : null,
  }
}

class PartnerService {
  async getSales(query: PartnerSalesQuery): Promise<PartnerSalesResponse> {
    const { organizationId, from, to, venueSlug, status, page, limit } = query
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

    // Resolve venue slug to ID if provided
    if (venueSlug) {
      const venue = await prisma.venue.findUnique({
        where: { slug: venueSlug },
        select: { id: true, organizationId: true },
      })
      if (venue) {
        where.sellingVenueId = venue.id
      } else {
        // Slug not found — return empty results
        return { data: [], pagination: { page, limit, total: 0 } }
      }
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
        sellingVenue: { select: { id: true, slug: true, name: true, city: true, state: true, zipCode: true } },
        venue: { select: { id: true, slug: true, name: true, city: true, state: true, zipCode: true } },
        // Chain-of-custody actors (PlayTelecom SIM assignment flow)
        assignedPromoter: { select: { firstName: true, lastName: true } },
        assignedSupervisor: { select: { firstName: true, lastName: true } },
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
    const data: PartnerSaleRecord[] = items.map(toPartnerSaleRecord)

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
