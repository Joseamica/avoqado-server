/**
 * Customer Dashboard Service
 *
 * HTTP-agnostic business logic for customer management.
 * Controllers orchestrate HTTP, services contain logic.
 *
 * @see CLAUDE.md - Layered Architecture section
 */

import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import logger from '@/config/logger'
import { CustomerApprovalStatus, PaymentStatus } from '@prisma/client'
import { logAction } from './activity-log.service'
import { decideCustomerApproval } from '@/services/public/customerBookingAccess.service'
import { applySalePosting, createSalePostingInTx } from '../inventory/inventoryPosting.service'
import { postCashSaleToDrawer } from '../shared/cashDrawerPosting'

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface CustomerListItem {
  id: string
  email: string | null
  phone: string | null
  firstName: string | null
  lastName: string | null
  loyaltyPoints: number
  totalVisits: number
  totalSpent: number
  averageOrderValue: number
  lastVisitAt: Date | null
  customerGroup: {
    id: string
    name: string
    color: string | null
  } | null
  tags: string[]
  active: boolean
  createdAt: Date
  pendingOrderCount: number // Count of pay-later orders
  pendingBalance: number // Total balance pending
}

interface PaginatedCustomersResponse {
  data: CustomerListItem[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
  }
}

interface CreateCustomerRequest {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  birthDate?: Date
  gender?: string
  customerGroupId?: string
  notes?: string
  tags?: string[]
  marketingConsent?: boolean
}

interface UpdateCustomerRequest {
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  birthDate?: Date
  gender?: string
  customerGroupId?: string
  notes?: string
  tags?: string[]
  marketingConsent?: boolean
  active?: boolean
}

interface CustomerStatsResponse {
  totalCustomers: number
  activeCustomers: number
  newCustomersThisMonth: number
  vipCustomers: number // Customers with >10 visits or >$1000 spent
  averageLifetimeValue: number
  averageVisitsPerCustomer: number
  topSpenders: Array<{
    id: string
    name: string
    totalSpent: number
    totalVisits: number
  }>
}

// ==========================================
// CUSTOMER CRUD OPERATIONS
// ==========================================

/**
 * Get all customers for a venue with pagination and search
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param page - Page number (1-indexed)
 * @param pageSize - Items per page
 * @param search - Search term (firstName, lastName, email, phone)
 * @param customerGroupId - Filter by customer group
 * @param noGroup - Filter customers without a group
 * @param tags - Filter by tags (comma-separated)
 */
export async function getCustomers(
  venueId: string,
  page: number = 1,
  pageSize: number = 20,
  search?: string,
  customerGroupId?: string,
  noGroup?: boolean,
  tags?: string,
  sortBy: 'createdAt' | 'totalSpent' | 'visitCount' | 'lastVisit' | 'name' = 'createdAt',
  sortOrder: 'asc' | 'desc' = 'desc',
  hasPendingBalance?: boolean,
): Promise<PaginatedCustomersResponse> {
  const skip = (page - 1) * pageSize

  // Map sortBy to Prisma field names (with fallback for undefined)
  const sortFieldMap: Record<string, string> = {
    createdAt: 'createdAt',
    totalSpent: 'totalSpent',
    visitCount: 'totalVisits',
    lastVisit: 'lastVisitAt',
    name: 'firstName',
  }
  const effectiveSortBy = sortBy || 'createdAt'
  const effectiveSortOrder = sortOrder || 'desc'
  const orderByField = sortFieldMap[effectiveSortBy] || 'createdAt'

  // Build search conditions
  const searchConditions = search
    ? {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {}

  // Build tag filter
  const tagFilter = tags
    ? {
        tags: {
          hasSome: tags.split(',').map(t => t.trim()),
        },
      }
    : {}

  // Build group filter (customerGroupId takes precedence over noGroup)
  const groupFilter = customerGroupId ? { customerGroupId } : noGroup ? { customerGroupId: null } : {}

  // Build pending balance filter (only customers with pay-later orders)
  const pendingBalanceFilter = hasPendingBalance
    ? {
        orderAssociations: {
          some: {
            order: {
              paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
              remainingBalance: { gt: 0 },
            },
          },
        },
      }
    : {}

  const whereCondition = {
    venueId, // ✅ CRITICAL: Multi-tenant filter
    ...groupFilter,
    ...tagFilter,
    ...searchConditions,
    ...pendingBalanceFilter,
  }

  const [customers, totalCount] = await prisma.$transaction([
    prisma.customer.findMany({
      where: whereCondition,
      skip,
      take: pageSize,
      orderBy: { [orderByField]: effectiveSortOrder },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        loyaltyPoints: true,
        totalVisits: true,
        totalSpent: true,
        averageOrderValue: true,
        lastVisitAt: true,
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
        tags: true,
        active: true,
        createdAt: true,
        orderAssociations: {
          where: {
            order: {
              paymentStatus: { in: ['PENDING', 'PARTIAL'] },
              remainingBalance: { gt: 0 },
            },
          },
          include: {
            order: {
              select: {
                id: true,
                remainingBalance: true,
              },
            },
          },
        },
      },
    }),
    prisma.customer.count({ where: whereCondition }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: customers.map(customer => ({
      ...customer,
      totalSpent: customer.totalSpent.toNumber(),
      averageOrderValue: customer.averageOrderValue.toNumber(),
      // Map backend field names to frontend expected names
      visitCount: customer.totalVisits,
      lastVisit: customer.lastVisitAt,
      pendingOrderCount: customer.orderAssociations?.length || 0,
      pendingBalance: customer.orderAssociations?.reduce((sum, oc) => sum + Number(oc.order.remainingBalance), 0) || 0,
      orderAssociations: undefined, // Remove from response to keep it clean
    })),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  }
}

/**
 * Get a single customer by ID
 */
export async function getCustomerById(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
    include: {
      customerGroup: true,
      orders: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          status: true,
          createdAt: true,
        },
      },
      loyaltyTransactions: {
        take: 20,
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  // Map backend field names to frontend expected names
  return {
    ...customer,
    visitCount: customer.totalVisits,
    lastVisit: customer.lastVisitAt,
  }
}

/**
 * Create a new customer
 */
export async function createCustomer(venueId: string, data: CreateCustomerRequest) {
  // Validate email or phone is provided
  if (!data.email && !data.phone) {
    throw new BadRequestError('Se requiere email o teléfono')
  }

  // Normalize email to lowercase for consistent lookups
  const normalizedEmail = data.email?.toLowerCase()

  // Check for duplicate email/phone in this venue
  if (normalizedEmail) {
    const existingByEmail = await prisma.customer.findFirst({
      where: {
        venueId,
        email: normalizedEmail,
      },
    })

    if (existingByEmail) {
      throw new BadRequestError(`Customer with email ${data.email} already exists in this venue`)
    }
  }

  if (data.phone) {
    const existingByPhone = await prisma.customer.findFirst({
      where: {
        venueId,
        phone: data.phone,
      },
    })

    if (existingByPhone) {
      throw new BadRequestError(`Customer with phone ${data.phone} already exists in this venue`)
    }
  }

  // Validate customerGroupId if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: {
        id: data.customerGroupId,
        venueId, // ✅ Ensure group belongs to this venue
      },
    })

    if (!group) {
      throw new NotFoundError(`Customer group with ID ${data.customerGroupId} not found in this venue`)
    }
  }

  const customer = await prisma.customer.create({
    data: {
      venueId, // ✅ CRITICAL: Multi-tenant assignment
      email: normalizedEmail,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate,
      gender: data.gender,
      customerGroupId: data.customerGroupId,
      notes: data.notes,
      tags: data.tags || [],
      marketingConsent: data.marketingConsent ?? false,
    },
    include: {
      customerGroup: true,
    },
  })

  logger.info(`Customer created: ${customer.id} (${customer.email || customer.phone})`, {
    venueId,
    customerId: customer.id,
  })

  logAction({
    venueId,
    action: 'CUSTOMER_CREATED',
    entity: 'Customer',
    entityId: customer.id,
    data: { email: customer.email, phone: customer.phone },
  })

  // REFERRAL HOOK: auto-generate referralCode if program is active
  // for this venue, then fire the welcome email (with PNG card) when
  // the customer is reachable (has email + marketingConsent).
  //
  // The whole block is wrapped in try/catch and the email step is
  // wrapped again so a Resend failure can never bubble up and break
  // customer creation.
  try {
    const cfg = await prisma.referralProgramConfig.findUnique({
      where: { venueId: customer.venueId },
      select: { active: true, codePrefix: true, newCustomerDiscountPercent: true },
    })
    if (cfg?.active && !customer.referralCode) {
      const venue = await prisma.venue.findUnique({
        where: { id: customer.venueId },
        select: { slug: true, name: true },
      })
      const { generateReferralCode } = await import('@/services/referrals/referralCode.service')
      const code = await generateReferralCode({
        venueId: customer.venueId,
        venuePrefix: cfg.codePrefix ?? venue?.slug ?? customer.venueId.slice(-8),
        customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
      })
      await prisma.customer.update({ where: { id: customer.id }, data: { referralCode: code } })

      // Welcome email — only fire if the customer is contactable via
      // email AND has opted in to marketing. Both checks are required
      // to avoid sending unsolicited mail.
      if (customer.email && customer.marketingConsent && venue) {
        try {
          const { generateWelcomeCard } = await import('@/services/referrals/referralCard.service')
          const { sendReferralWelcomeEmail } = await import('@/services/email.service')
          const cardPng = await generateWelcomeCard({
            customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Cliente',
            venueName: venue.name,
            referralCode: code,
            newCustomerDiscountPercent: Number(cfg.newCustomerDiscountPercent),
          })
          await sendReferralWelcomeEmail({
            to: customer.email,
            customerName: customer.firstName ?? 'Cliente',
            venueName: venue.name,
            referralCode: code,
            newCustomerDiscountPercent: Number(cfg.newCustomerDiscountPercent),
            cardPng,
          })
        } catch (emailErr) {
          // Card or email send failure — log, don't throw.
          console.error('[referral-welcome-email] failed', { customerId: customer.id, err: emailErr })
        }
      }
    }
  } catch (err) {
    // Don't fail customer creation if referral hook fails — just log
    console.error('[referral hook] Failed to auto-generate referralCode for customer', customer.id, err)
  }

  return customer
}

/**
 * Update an existing customer
 */
export async function updateCustomer(venueId: string, customerId: string, data: UpdateCustomerRequest) {
  // Check if customer exists and belongs to this venue
  const existingCustomer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
  })

  if (!existingCustomer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  // Normalize email to lowercase for consistent lookups
  const normalizedEmail = data.email?.toLowerCase()
  const existingNormalizedEmail = existingCustomer.email?.toLowerCase()

  // Check for duplicate email/phone (excluding current customer)
  if (normalizedEmail && normalizedEmail !== existingNormalizedEmail) {
    const duplicateEmail = await prisma.customer.findFirst({
      where: {
        venueId,
        email: normalizedEmail,
        id: { not: customerId },
      },
    })

    if (duplicateEmail) {
      throw new BadRequestError(`Customer with email ${data.email} already exists`)
    }
  }

  if (data.phone && data.phone !== existingCustomer.phone) {
    const duplicatePhone = await prisma.customer.findFirst({
      where: {
        venueId,
        phone: data.phone,
        id: { not: customerId },
      },
    })

    if (duplicatePhone) {
      throw new BadRequestError(`Customer with phone ${data.phone} already exists`)
    }
  }

  // Validate customerGroupId if provided
  if (data.customerGroupId) {
    const group = await prisma.customerGroup.findFirst({
      where: {
        id: data.customerGroupId,
        venueId,
      },
    })

    if (!group) {
      throw new NotFoundError(`Customer group with ID ${data.customerGroupId} not found`)
    }
  }

  const updatedCustomer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      email: normalizedEmail,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate,
      gender: data.gender,
      customerGroupId: data.customerGroupId,
      notes: data.notes,
      tags: data.tags,
      marketingConsent: data.marketingConsent,
      active: data.active,
    },
    include: {
      customerGroup: true,
    },
  })

  logger.info(`Customer updated: ${customerId}`, {
    venueId,
    customerId,
  })

  logAction({
    venueId,
    action: 'CUSTOMER_UPDATED',
    entity: 'Customer',
    entityId: customerId,
    data: { email: updatedCustomer.email, phone: updatedCustomer.phone },
  })

  return updatedCustomer
}

/**
 * Delete a customer (soft delete by setting active=false)
 */
export async function deleteCustomer(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  // Soft delete (set active=false)
  await prisma.customer.update({
    where: { id: customerId },
    data: { active: false },
  })

  logger.info(`Customer soft-deleted: ${customerId}`, {
    venueId,
    customerId,
  })

  logAction({
    venueId,
    action: 'CUSTOMER_DELETED',
    entity: 'Customer',
    entityId: customerId,
    data: { email: customer.email, phone: customer.phone },
  })

  return { success: true, message: 'Customer deactivated successfully' }
}

// ==========================================
// CUSTOMER STATISTICS & ANALYTICS
// ==========================================

/**
 * Get customer statistics for dashboard
 */
export async function getCustomerStats(venueId: string): Promise<CustomerStatsResponse> {
  const now = new Date()
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [totalCustomers, activeCustomers, newCustomersThisMonth, vipCustomers, avgStats, topSpenders] = await prisma.$transaction([
    // Total customers
    prisma.customer.count({
      where: { venueId },
    }),

    // Active customers
    prisma.customer.count({
      where: { venueId, active: true },
    }),

    // New customers this month
    prisma.customer.count({
      where: {
        venueId,
        createdAt: { gte: firstDayOfMonth },
      },
    }),

    // VIP customers (>10 visits OR >$1000 spent)
    prisma.customer.count({
      where: {
        venueId,
        OR: [{ totalVisits: { gt: 10 } }, { totalSpent: { gt: 1000 } }],
      },
    }),

    // Average lifetime value and visits
    prisma.customer.aggregate({
      where: { venueId },
      _avg: {
        totalSpent: true,
        totalVisits: true,
      },
    }),

    // Top 5 spenders
    prisma.customer.findMany({
      where: { venueId },
      orderBy: { totalSpent: 'desc' },
      take: 5,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        totalSpent: true,
        totalVisits: true,
      },
    }),
  ])

  return {
    totalCustomers,
    activeCustomers,
    newCustomersThisMonth,
    vipCustomers,
    averageLifetimeValue: avgStats._avg.totalSpent?.toNumber() || 0,
    averageVisitsPerCustomer: avgStats._avg.totalVisits || 0,
    topSpenders: topSpenders.map(c => ({
      id: c.id,
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
      totalSpent: c.totalSpent.toNumber(),
      totalVisits: c.totalVisits,
    })),
  }
}

/**
 * Settle pending balance for a customer
 * Marks all pay-later orders as paid (for cash/deposit payments received outside the system)
 *
 * @param venueId - Venue ID (multi-tenant filter)
 * @param customerId - Customer ID
 * @param notes - Optional notes about the settlement (e.g., "Paid in cash", "Bank transfer received")
 * @returns Settlement result with settled orders count and total amount
 */
export async function settleCustomerBalance(
  venueId: string,
  customerId: string,
  notes?: string,
): Promise<{
  settledOrderCount: number
  settledAmount: number
  message: string
}> {
  // Verify customer exists and belongs to this venue
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId, // ✅ CRITICAL: Multi-tenant filter
    },
    include: {
      orderAssociations: {
        where: {
          order: {
            paymentStatus: { in: ['PENDING', 'PARTIAL'] },
            remainingBalance: { gt: 0 },
          },
        },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              remainingBalance: true,
              total: true,
            },
          },
        },
      },
    },
  })

  if (!customer) {
    throw new NotFoundError(`Customer with ID ${customerId} not found`)
  }

  const pendingOrders = customer.orderAssociations || []

  if (pendingOrders.length === 0) {
    return {
      settledOrderCount: 0,
      settledAmount: 0,
      message: 'No pending balance to settle',
    }
  }

  // Update all pending orders to mark them as paid and create payment records
  //
  // 🔴 CAS por orden (fase 5, audit Codex): el update era CIEGO, así que esta
  // liquidación masiva competía con `settleOrder` y con los cobros del TPV —
  // dos caminos podían crear DOS pagos por la MISMA orden. Ahora sólo quien
  // gana la transición PENDING/PARTIAL → PAID crea el Payment.
  //
  // 🔴 Y también deduce: marcaba PAID sin tocar inventario. El vale nace dentro
  // del mismo CAS, así que el perdedor tampoco puede descontar.
  const postingIds: string[] = []
  // 🔴 LA lista de lo que ESTA llamada liquidó de verdad — no las que estaban
  // pendientes al leer al cliente. TODO lo que se reporta hacia afuera sale de
  // aquí: el hook de referidos, el conteo, el monto, el mensaje y el
  // ActivityLog. Una sola fuente, para que no se puedan desincronizar.
  //
  // `pendingOrders` es una FOTO tomada en `:702`; entre esa lectura y el CAS de
  // abajo el TPV puede cobrar una de esas órdenes. Antes el reporte salía de la
  // foto: con 3 cuentas de $300 y una cobrada por otro camino, se creaban 2
  // Payment ($600) pero se le respondía al cajero "3 order(s) totaling 900" y se
  // escribía un ActivityLog con 900 — la bitácora contando el dinero DOS veces,
  // justo el registro del que dependemos para investigar un incidente.
  const settled: Array<{ orderId: string; amount: number; paymentId?: string }> = []
  await prisma.$transaction(async tx => {
    for (const oc of pendingOrders) {
      const remainingBalance = Number(oc.order.remainingBalance)

      const transition = await tx.order.updateMany({
        where: { id: oc.order.id, venueId, paymentStatus: { in: ['PENDING', 'PARTIAL'] } },
        data: {
          paymentStatus: 'PAID',
          paidAmount: oc.order.total,
          remainingBalance: 0,
          version: { increment: 1 },
        },
      })
      if (transition.count === 0) continue
      // Se registra el MISMO `remainingBalance` que va al Payment de abajo: el
      // monto reportado es la suma exacta de los pagos creados, no un recálculo
      // que pueda divergir de ellos.
      settled.push({ orderId: oc.order.id, amount: remainingBalance })

      // Create a payment record to track the settlement
      const settlementPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: oc.order.id,
          amount: remainingBalance,
          tipAmount: 0,
          method: 'CASH', // Default to cash for manual settlements
          // 🔴 Decisión del founder (27-ago): este efectivo SÍ entró al cajón (fase 2).
          fundsFlow: 'CASH_DRAWER',
          status: 'COMPLETED',
          feePercentage: 0,
          feeAmount: 0,
          netAmount: remainingBalance,
          source: 'OTHER',
          processorData: notes ? { settlementNote: notes, settledViaDashboard: true } : { settledViaDashboard: true },
        },
      })

      settled[settled.length - 1].paymentId = settlementPayment.id

      const itemsParaPosting = await tx.orderItem.findMany({
        where: { orderId: oc.order.id },
        include: { modifiers: { include: { modifier: true } } },
      })
      const posting = await createSalePostingInTx(tx, {
        venueId,
        orderId: oc.order.id,
        items: itemsParaPosting as any,
        staffId: null,
      })
      if (posting?.id) postingIds.push(posting.id)
    }
  })

  // Fase 2 de la unificación de caja: cada liquidación en efectivo sube el cajón. Después del
  // commit y fail-open, igual que el vale de inventario de abajo.
  for (const s of settled) {
    if (!s.paymentId) continue
    try {
      await postCashSaleToDrawer({
        venueId,
        paymentId: s.paymentId,
        orderId: s.orderId,
        status: 'COMPLETED',
        type: 'REGULAR',
        amount: s.amount,
        tipAmount: 0,
        method: 'CASH',
        fundsFlow: 'CASH_DRAWER',
        staffId: null,
      })
    } catch (err) {
      logger.error('[CASH-DRAWER] Falló registrar la liquidación del cliente en el cajón (la liquidación NO se afecta)', {
        customerId,
        orderId: s.orderId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Aplicar los vales ya commiteados. Un fallo aquí NO afecta la liquidación:
  // el posting queda pendiente y el sweeper lo reintenta.
  for (const postingId of postingIds) {
    try {
      await applySalePosting(postingId, null)
    } catch (err) {
      logger.error('[InventoryPosting] Falló la deducción al liquidar el saldo del cliente', {
        customerId,
        postingId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // REFERRAL HOOK: each settled order may have had a pending referral — trigger qualification
  // (idempotent: no-ops if no PENDING Referral matches each orderId)
  //
  // 🔴 Sobre `settled`, NO sobre `pendingOrders`: la que perdió el CAS no la
  // liquidó ESTA llamada (se le adelantó `settleOrder` o un cobro del TPV).
  // Dispararle el hook es afirmar un cobro que este camino no hizo — y
  // `onOrderPaid` reclama el referido y quema un `ReferralTierUnlock`, que se
  // gana UNA vez en la vida y no se re-emite.
  //
  // Corre DESPUÉS del commit de la transacción de arriba, y eso es obligatorio:
  // `onOrderPaid` abre su propia transacción y relee la orden, así que llamarlo
  // dentro de la nuestra le escondería el `PAID` sin commitear y mataría la
  // calificación en silencio. Ver su precondición.
  //
  // El try/catch por orden se conserva: un fallo del hook nunca puede tumbar una
  // liquidación ya commiteada.
  try {
    const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
    for (const { orderId } of settled) {
      try {
        await onOrderPaid({ orderId, venueId })
      } catch (err) {
        console.error('[referral hook] onOrderPaid failed for order', orderId, err)
      }
    }
  } catch (err) {
    console.error('[referral hook] Failed to import referralQualification.service', err)
  }

  // 🔴 Conteo, monto, mensaje y bitácora: los CUATRO salen de `settled`, nunca
  // de `pendingOrders`. Arreglar sólo el referido y dejar los pesos colgados de
  // la foto inicial era la asimetría que nadie iba a poder explicar después.
  const settledOrderCount = settled.length
  const settledAmount = settled.reduce((sum, s) => sum + s.amount, 0)

  logger.info(`Customer balance settled: ${customerId}`, {
    venueId,
    customerId,
    settledOrderCount,
    settledAmount,
    // Cuántas candidatas había al leer al cliente. Si no cuadra con
    // `settledOrderCount`, otro camino cobró en medio — es dato de diagnóstico,
    // no un error.
    candidateOrderCount: pendingOrders.length,
    notes,
  })

  logAction({
    venueId,
    action: 'CUSTOMER_BALANCE_SETTLED',
    entity: 'Customer',
    entityId: customerId,
    data: { settledOrderCount, settledAmount },
  })

  return {
    settledOrderCount,
    settledAmount,
    message: `Successfully settled ${settledOrderCount} order(s) totaling ${settledAmount}`,
  }
}

/**
 * Update customer metrics when an order is completed
 * (Called from order/payment service)
 */
export async function updateCustomerMetrics(customerId: string, orderTotal: number) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      totalVisits: true,
      totalSpent: true,
      firstVisitAt: true,
    },
  })

  if (!customer) {
    logger.warn(`Customer ${customerId} not found for metrics update`)
    return
  }

  const newTotalVisits = customer.totalVisits + 1
  const newTotalSpent = customer.totalSpent.toNumber() + orderTotal
  const newAverageOrderValue = newTotalSpent / newTotalVisits

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      totalVisits: newTotalVisits,
      totalSpent: newTotalSpent,
      averageOrderValue: newAverageOrderValue,
      lastVisitAt: new Date(),
      firstVisitAt: customer.firstVisitAt || new Date(), // Set only if null
    },
  })

  logger.info(`Customer metrics updated: ${customerId}`, {
    customerId,
    totalVisits: newTotalVisits,
    totalSpent: newTotalSpent,
  })
}

// ==========================================
// FASE 1 — APROBACIÓN DE CLIENTES (el negocio decide quién reserva en línea)
// ==========================================

/**
 * La decisión del staff, desde el dashboard.
 *
 * La lógica dura (lock de fila, write-CAS sobre `approvalVersion`, ActivityLog y outbox de
 * correo) vive en `customerBookingAccess.service`; aquí sólo se abre la transacción y se
 * resuelve la organización.
 *
 * 🔴 `organizationId` sale del VENUE, no del token de quien aprueba. Un SUPERADMIN —o alguien
 * con varias organizaciones— traería en su token la organización equivocada, y el rastro de
 * auditoría quedaría archivado bajo un negocio que no es.
 */
export async function decideCustomerApprovalFromDashboard(
  venueId: string,
  customerId: string,
  input: { decision: 'APPROVED' | 'REJECTED'; reason?: string; expectedVersion: number; actorStaffId: string },
): Promise<{ approvalStatus: CustomerApprovalStatus; approvalVersion: number; changed: boolean }> {
  return prisma.$transaction(async tx => {
    const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
    if (!venue) throw new NotFoundError('Negocio no encontrado')

    return decideCustomerApproval(tx, {
      customerId,
      venueId,
      organizationId: venue.organizationId,
      decision: input.decision,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
      actorStaffId: input.actorStaffId,
    })
  })
}

/**
 * La bandeja "En espera de aprobación".
 *
 * Orden ASCENDENTE por `approvalRequestedAt`: quien lleva más tiempo esperando se atiende
 * primero. Al revés, en un día ocupado la que pidió en la mañana queda sepultada bajo las de
 * la tarde y nunca la aprueban.
 */
export async function listCustomersAwaitingApproval(
  venueId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ data: unknown[]; meta: { page: number; pageSize: number; total: number } }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20))

  const where = { venueId, approvalStatus: CustomerApprovalStatus.PENDING }
  const [data, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      // 🔴 `id` como desempate al final, o la paginación pierde filas: `approvalRequestedAt`
      // NO es único —dos personas que se registran en el mismo instante lo comparten— y
      // Postgres es libre de ordenarlas distinto en cada página. Lo cazó el guardia
      // `pagination-stability.guard`.
      orderBy: [{ approvalRequestedAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        approvalStatus: true,
        approvalVersion: true,
        approvalRequestedAt: true,
        accountActivatedAt: true,
        createdAt: true,
      },
    }),
    prisma.customer.count({ where }),
  ])

  return { data, meta: { page, pageSize, total } }
}
