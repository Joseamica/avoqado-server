// services/dashboard/payment.dashboard.service.ts

import { TransactionStatus, PaymentMethod, CardBrand, CardEntryMode } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { PaginatedPaymentsResponse } from '../../schemas/dashboard/payment.schema'
import { logAction } from './activity-log.service'
import {
  MINDFORM_NEW_VENUE_ID,
  getLegacyPayments,
  shouldIncludeLegacyPayments,
  filterLegacyRowsByMethodSource,
} from '../legacy/qrPayments.legacy.service'
import logger from '../../config/logger'

export interface PaymentFilters {
  // Multi-select filter arrays (preferred)
  merchantAccountIds?: string[]
  methods?: string[]
  sources?: string[]
  staffIds?: string[]
  // Single-value filters kept for backward compatibility (TPV, scripts, etc.)
  merchantAccountId?: string
  method?: string
  source?: string
  staffId?: string
  search?: string
  startDate?: string
  endDate?: string
}

/**
 * `CARD` sólo existe en el puente QR legacy. Para la tabla Payment nativa equivale
 * a las dos variantes reales; sin esta expansión, seleccionar “Tarjeta” ocultaba
 * todos los pagos nuevos y el listado discrepaba del resumen.
 */
export function normalizeNativePaymentMethods(methods?: readonly string[]): string[] | undefined {
  if (!methods) return undefined
  const normalized = methods.flatMap(method => (method === 'CARD' ? ['CREDIT_CARD', 'DEBIT_CARD'] : [method]))
  return Array.from(new Set(normalized))
}

export async function getPaymentsData(
  venueId: string,
  page: number,
  pageSize: number,
  filters?: PaymentFilters,
): Promise<PaginatedPaymentsResponse> {
  if (!venueId) {
    throw new NotFoundError('Venue ID es requerido')
  }

  // Calculamos skip y take aquí para mantener la lógica de paginación en el servicio
  const skip = (page - 1) * pageSize
  const take = pageSize

  // La cláusula 'where' es la MISMA para la búsqueda, el conteo, el export y el
  // resumen (paymentSummary.dashboard.service.ts espeja sus predicados en SQL).
  const whereClause = buildPaymentsWhereClause(venueId, filters)

  // ─── MindForm legacy QR bridge — short-circuit pagination ───
  // For MindForm we CANNOT use Prisma's skip/take here, because we need to
  // merge its legacy payments with the new-system ones before slicing the
  // current page. Otherwise page N of the new data + all legacy gets sliced
  // wrong and later pages end up almost empty.
  // We only need the first `skip + take` rows from EACH sorted source to build
  // the exact global page; no source can contribute more than that to the top N.
  //
  // ⚠️ This list endpoint keeps its own MindForm branch because it needs
  // relations (processedBy, order.table, merchantAccount, transactionCost) that
  // the analytics helper doesn't fetch. When the native QR module ships and
  // this branch is removed, also delete src/services/legacy/mergedPayments.service.ts
  // and revert the /home analytics callers to direct prisma.payment.findMany.
  if (venueId === MINDFORM_NEW_VENUE_ID) {
    logger.info('[Payments] MindForm detected — attempting legacy QR merge', {
      venueId,
      startDate: filters?.startDate,
      endDate: filters?.endDate,
    })

    const sharedInclude = {
      processedBy: true,
      shift: true,
      order: { include: { table: true } },
      merchantAccount: {
        include: {
          provider: { select: { id: true, code: true, name: true } },
        },
      },
      // E-commerce merchant (Stripe Connect / Blumon channel) for payment-link
      // rows. Dashboard's "Cuenta Comercial" column falls back to this when
      // merchantAccount is null.
      ecommerceMerchant: {
        select: {
          id: true,
          channelName: true,
          provider: { select: { id: true, code: true, name: true } },
        },
      },
      transactionCost: true,
    }

    // Pre-flight: if the user's method/source filter cannot possibly match any
    // legacy row (e.g. methods=['CREDIT_CARD'] or sources=['TPV']), skip the
    // legacy DB round-trip entirely. Without this guard the legacy QR rows leak
    // into every filtered view because they ignore the filter — see Bug:
    // "filtrar Efectivo y aparecen los pagos QR".
    const methodFilterValues = filters?.methods ?? (filters?.method ? [filters.method] : undefined)
    const sourceFilterValues = filters?.sources ?? (filters?.source ? [filters.source] : undefined)
    const legacyFilter = { methods: methodFilterValues, sources: sourceFilterValues }
    const requestedEnd = skip + take

    const [newPaymentsWindow, newPaymentsTotal, legacy] = await Promise.all([
      prisma.payment.findMany({
        where: whereClause,
        include: sharedInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: requestedEnd,
      }),
      prisma.payment.count({ where: whereClause }),
      shouldIncludeLegacyPayments(legacyFilter)
        ? getLegacyPayments({
            startDate: filters?.startDate,
            endDate: filters?.endDate,
            search: filters?.search,
            methods: methodFilterValues,
            limit: requestedEnd,
          })
        : Promise.resolve({ rows: [] as Awaited<ReturnType<typeof getLegacyPayments>>['rows'], total: 0 }),
    ])

    // Post-fetch: drop any legacy row that doesn't match method/source. The
    // pre-flight guard skips the query when no legacy row could match at all,
    // but when the filter is partially-matching (e.g. methods=['CASH'] still
    // matches legacy CASH rows but not legacy CARD rows) we still need to
    // narrow the merged result here.
    const filteredLegacyRows = filterLegacyRowsByMethodSource(legacy.rows, legacyFilter)

    logger.info('[Payments] Legacy merge result', {
      legacyRows: legacy.rows.length,
      legacyKept: filteredLegacyRows.length,
      legacyTotal: legacy.total,
      newRows: newPaymentsWindow.length,
    })

    const merged = [...newPaymentsWindow, ...filteredLegacyRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id.localeCompare(a.id),
    )
    const combinedTotal = newPaymentsTotal + legacy.total
    const paginated = merged.slice(skip, skip + take)

    return {
      data: paginated as any,
      meta: {
        total: combinedTotal,
        page,
        pageSize,
        pageCount: Math.ceil(combinedTotal / pageSize),
      },
    }
  }

  // Usamos $transaction para ejecutar ambas queries en paralelo en la misma versión de la BD
  const [payments, total] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: true, // El staff que procesó el pago
        shift: true, // Información del turno
        order: {
          include: {
            table: true, // Información de la mesa
          },
        },
        merchantAccount: {
          include: {
            provider: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        ecommerceMerchant: {
          select: {
            id: true,
            channelName: true,
            provider: { select: { id: true, code: true, name: true } },
          },
        },
        transactionCost: true, // Include profit/cost information for SUPERADMIN
      },
      // Desempate por id: con el tope de 100 el cliente pagina de verdad, y dos pagos
      // con el mismo createdAt cambiaban de página entre peticiones (offset inestable).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  // Devolvemos el objeto con el formato esperado
  return {
    data: payments,
    meta: {
      total,
      page,
      pageSize,
      pageCount: Math.ceil(total / pageSize),
    },
  }
}

/**
 * The ONE `where` clause of the payments listing — shared by `getPaymentsData`, the export
 * and (mirrored predicate by predicate in SQL) the summary in
 * `paymentSummary.dashboard.service.ts`. Add a filter here → add it there → run
 * `tests/integration/dashboard/listSummary-sql-parity.integration.test.ts`.
 */
export function buildPaymentsWhereClause(venueId: string, filters?: PaymentFilters): any {
  const whereClause: any = {
    venueId,
    status: {
      not: 'PENDING' as TransactionStatus,
    },
  }
  if (!filters) return whereClause

  if (filters.merchantAccountIds && filters.merchantAccountIds.length > 0) {
    whereClause.merchantAccountId = { in: filters.merchantAccountIds }
  } else if (filters.merchantAccountId) {
    whereClause.merchantAccountId = filters.merchantAccountId
  }
  if (filters.methods && filters.methods.length > 0) {
    whereClause.method = { in: normalizeNativePaymentMethods(filters.methods) }
  } else if (filters.method) {
    const nativeMethods = normalizeNativePaymentMethods([filters.method]) ?? []
    whereClause.method = nativeMethods.length === 1 ? nativeMethods[0] : { in: nativeMethods }
  }
  if (filters.sources && filters.sources.length > 0) {
    whereClause.source = { in: filters.sources }
  } else if (filters.source) {
    whereClause.source = filters.source
  }
  if (filters.staffIds && filters.staffIds.length > 0) {
    whereClause.processedById = { in: filters.staffIds }
  } else if (filters.staffId) {
    whereClause.processedById = filters.staffId
  }
  if (filters.startDate || filters.endDate) {
    whereClause.createdAt = {}
    if (filters.startDate) whereClause.createdAt.gte = new Date(filters.startDate)
    if (filters.endDate) whereClause.createdAt.lte = new Date(filters.endDate)
  }
  if (filters.search) {
    const searchTerm = filters.search.trim()
    const searchNumber = parseFloat(searchTerm)
    whereClause.OR = [
      ...(isNaN(searchNumber)
        ? []
        : [{ amount: { gte: searchNumber, lt: searchNumber + 1 } }, { tipAmount: { gte: searchNumber, lt: searchNumber + 1 } }]),
      { maskedPan: { contains: searchTerm, mode: 'insensitive' } },
      { referenceNumber: { contains: searchTerm, mode: 'insensitive' } },
      { authorizationNumber: { contains: searchTerm, mode: 'insensitive' } },
      {
        processedBy: {
          OR: [{ firstName: { contains: searchTerm, mode: 'insensitive' } }, { lastName: { contains: searchTerm, mode: 'insensitive' } }],
        },
      },
    ]
  }
  return whereClause
}

/**
 * Count rows that match the export filters — used as a pre-flight check before
 * pulling everything into memory.
 */
export async function countPaymentsForExport(venueId: string, filters?: PaymentFilters): Promise<number> {
  return prisma.payment.count({ where: buildPaymentsWhereClause(venueId, filters) })
}

/**
 * Fetch all matching payment rows for export (caller is responsible for caps).
 * Returns a flat shape with everything the export columns need.
 */
export async function fetchPaymentsForExport(venueId: string, filters: PaymentFilters | undefined, limit: number) {
  return prisma.payment.findMany({
    where: buildPaymentsWhereClause(venueId, filters),
    include: {
      processedBy: { select: { firstName: true, lastName: true } },
      order: { include: { table: { select: { number: true } } } },
      merchantAccount: { select: { displayName: true, externalMerchantId: true } },
      ecommerceMerchant: { select: { channelName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

/**
 * Función para obtener un solo pago, adaptada al nuevo schema.
 */
export async function getPaymentById(venueId: string, paymentId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      venueId,
    },
    include: {
      processedBy: true, // Staff que procesó el pago
      shift: true, // Información del turno
      order: {
        include: {
          table: true, // AQUÍ INCLUIMOS LA INFORMACIÓN DE LA MESA
          customer: true, // Customer associated with the order (nullable)
          items: {
            // Line items (products + custom "Otro importe" entries) with their modifiers,
            // so the mobile/web drawer can render the full breakdown.
            // We also pull the product's trackInventory flag for the refund/restock flow.
            include: {
              product: {
                select: { id: true, trackInventory: true },
              },
              modifiers: {
                include: { modifier: true },
              },
            },
            orderBy: { sequence: 'asc' },
          },
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      ecommerceMerchant: {
        select: {
          id: true,
          channelName: true,
          provider: { select: { id: true, code: true, name: true } },
        },
      },
      transactionCost: true, // Include profit/cost information
      saleVerification: true, // Pre-payment verification photos
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado en este venue`)
  }

  return payment
}

/**
 * Update a payment (SUPERADMIN only)
 * Allows editing of specific fields
 */
export interface UpdatePaymentData {
  amount?: number
  tipAmount?: number
  status?: TransactionStatus
  method?: PaymentMethod
  cardBrand?: CardBrand
  last4?: string
  maskedPan?: string
  authorizationNumber?: string
  referenceNumber?: string
  entryMode?: CardEntryMode
}

export async function updatePayment(venueId: string, paymentId: string, data: UpdatePaymentData) {
  // First verify the payment exists
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      venueId,
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado en este venue`)
  }

  // Update the payment
  const updatedPayment = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      ...(data.amount !== undefined && { amount: data.amount }),
      ...(data.tipAmount !== undefined && { tipAmount: data.tipAmount }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.method !== undefined && { method: data.method }),
      ...(data.cardBrand !== undefined && { cardBrand: data.cardBrand }),
      ...(data.last4 !== undefined && { last4: data.last4 }),
      ...(data.maskedPan !== undefined && { maskedPan: data.maskedPan }),
      ...(data.authorizationNumber !== undefined && { authorizationNumber: data.authorizationNumber }),
      ...(data.referenceNumber !== undefined && { referenceNumber: data.referenceNumber }),
      ...(data.entryMode !== undefined && { entryMode: data.entryMode }),
    },
    include: {
      processedBy: true,
      shift: true,
      order: {
        include: {
          table: true,
        },
      },
      merchantAccount: {
        include: {
          provider: {
            select: {
              id: true,
              code: true,
              name: true,
            },
          },
        },
      },
      transactionCost: true,
    },
  })

  logAction({
    venueId: updatedPayment.venueId,
    action: 'PAYMENT_UPDATED',
    entity: 'Payment',
    entityId: updatedPayment.id,
    data: { status: updatedPayment.status, method: updatedPayment.method, amount: updatedPayment.amount },
  })

  return updatedPayment
}

/**
 * Delete a payment (SUPERADMIN only)
 * This is a hard delete - use with caution
 */
export async function deletePayment(venueId: string, paymentId: string): Promise<void> {
  // First verify the payment exists
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      venueId,
    },
    include: {
      transactionCost: true,
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment con ID ${paymentId} no encontrado en este venue`)
  }

  // Delete related records first (cascading)
  await prisma.$transaction(async tx => {
    // Delete transaction cost if exists
    if (payment.transactionCost) {
      await tx.transactionCost.delete({
        where: { id: payment.transactionCost.id },
      })
    }

    // Delete digital receipts associated with this payment
    await tx.digitalReceipt.deleteMany({
      where: { paymentId },
    })

    // Finally delete the payment itself
    await tx.payment.delete({
      where: { id: paymentId },
    })
  })

  logAction({
    venueId: payment.venueId,
    action: 'PAYMENT_DELETED',
    entity: 'Payment',
    entityId: paymentId,
    data: { amount: payment.amount, method: payment.method },
  })
}
