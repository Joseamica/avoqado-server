import { resolveShiftCashDrawer } from '../dashboard/shift.dashboard.service'
import { PaymentFundsFlow, PaymentMethod, PaymentType, Prisma, Shift, ShiftStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import socketManager from '../../communication/sockets'
import { logAction } from '../dashboard/activity-log.service'
import { paymentCountsAsDrawerCash } from '../shared/tenderSemantics'
import { isCashReconciliationEnabled } from '../access/cashReconciliationAccess.service'
import {
  calculateCashReconciliation,
  normalizeCashReconciliationRequest,
  type CashReconciliationOutcome,
  type NormalizedCashReconciliationRequest,
} from '../shared/cashReconciliation.service'
import { SHIFT_CLOSE_STALE_MS } from './shiftCloseClaim.constants'

interface ShiftFilters {
  staffId?: string
  startTime?: string
  endTime?: string
}

interface PaginationResponse<T> {
  data: T[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
    diagnostics?: any
  }
}

interface ShiftSummaryResponse {
  dateRange: {
    startTime: Date | null
    endTime: Date | null
  }
  summary: {
    totalSales: number
    totalTips: number
    ordersCount: number
    averageTipPercentage: number
    ratingsCount: number
  }
  waiterTips: Array<{
    staffId: string
    name: string
    amount: number
    count: number
  }>
  paymentMethods: Array<{
    method: string
    total: number
    percentage: number
  }>
  salesTrend: Array<{
    label: string
    value: number
  }>
  staffSales: Array<{
    staffId: string
    name: string
    totalSales: number
    totalOrders: number
    totalTips: number
  }>
}

/**
 * Get current active shift for a venue
 * ✅ REAL-TIME TOTALS: Calculates payment totals dynamically from actual payments
 * This ensures TPV always shows accurate shift totals even before closing
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param posName POS name (optional)
 * @returns Current active shift with calculated totals or null
 */
export async function getCurrentShift(venueId: string, _orgId?: string, _posName?: string): Promise<Shift | null> {
  // Look up shift in database
  const shift = await prisma.shift.findFirst({
    where: {
      venueId: venueId,
      endTime: null, // Shift must still be open (endTime es DateTime?)
      // ✅ Removemos startTime: { not: null } porque startTime es requerido
    },
    orderBy: {
      startTime: 'desc', // Get the most recent open shift
    },
  })

  if (!shift) {
    return null
  }

  // ============================================================
  // ✅ REAL-TIME CALCULATION: Calculate current shift totals from payments
  // This ensures TPV displays accurate totals before shift is closed
  // ============================================================
  const shiftPayments = await prisma.payment.findMany({
    where: {
      shiftId: shift.id,
      status: 'COMPLETED',
    },
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      method: true,
    },
  })

  let totalCashPayments = new Decimal(0)
  let totalCardPayments = new Decimal(0)
  let totalVoucherPayments = new Decimal(0)
  let totalOtherPayments = new Decimal(0)
  let totalSales = new Decimal(0)
  let totalTips = new Decimal(0)

  shiftPayments.forEach(payment => {
    const amount = new Decimal(payment.amount || 0)
    const tipAmount = new Decimal(payment.tipAmount || 0)

    totalSales = totalSales.add(amount)
    totalTips = totalTips.add(tipAmount)

    // Group by payment method
    switch (payment.method) {
      case 'CASH':
        totalCashPayments = totalCashPayments.add(amount)
        break
      case 'CREDIT_CARD':
      case 'DEBIT_CARD':
        totalCardPayments = totalCardPayments.add(amount)
        break
      case 'DIGITAL_WALLET':
        totalVoucherPayments = totalVoucherPayments.add(amount)
        break
      case 'BANK_TRANSFER':
      case 'OTHER':
      default:
        totalOtherPayments = totalOtherPayments.add(amount)
        break
    }
  })

  // Get order count
  const orderCount = await prisma.order.count({
    where: {
      shiftId: shift.id,
      status: {
        in: ['CONFIRMED', 'COMPLETED'],
      },
    },
  })

  // Get products sold count
  const orderItems = await prisma.orderItem.findMany({
    where: {
      order: {
        shiftId: shift.id,
        status: {
          in: ['CONFIRMED', 'COMPLETED'],
        },
      },
    },
    select: {
      quantity: true,
    },
  })

  const totalProductsSold = orderItems.reduce((sum, item) => sum + item.quantity, 0)

  // Return shift with calculated totals
  return {
    ...shift,
    totalSales: totalSales,
    totalTips: totalTips,
    totalOrders: orderCount,
    totalCashPayments: totalCashPayments,
    totalCardPayments: totalCardPayments,
    totalVoucherPayments: totalVoucherPayments,
    totalOtherPayments: totalOtherPayments,
    totalProductsSold: totalProductsSold,
  }
}

/**
 * Get shifts for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated shift results
 */
export async function getShifts(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: ShiftFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<any>> {
  const { staffId, startTime, endTime } = filters

  // Parse date filters once for reuse
  let parsedStartTime: Date | undefined
  let parsedEndTime: Date | undefined

  if (startTime) {
    parsedStartTime = new Date(startTime)
    if (isNaN(parsedStartTime.getTime())) {
      throw new BadRequestError(`Invalid startTime: ${startTime}`)
    }
  }

  if (endTime) {
    parsedEndTime = new Date(endTime)
    if (isNaN(parsedEndTime.getTime())) {
      throw new BadRequestError(`Invalid endTime: ${endTime}`)
    }
  }

  // Build payment filter for date range
  const paymentDateFilter: any = {}
  if (parsedStartTime || parsedEndTime) {
    paymentDateFilter.createdAt = {}
    if (parsedStartTime) {
      paymentDateFilter.createdAt.gte = parsedStartTime
    }
    if (parsedEndTime) {
      paymentDateFilter.createdAt.lte = parsedEndTime
    }
  }

  // Build the base query filters for shifts
  const whereClause: any = {
    venueId: venueId,
  }

  // If date filters are provided, include shifts that:
  // 1. Were active during the period
  // 2. Have payments in the period
  if (parsedStartTime || parsedEndTime) {
    whereClause.OR = [
      // Include open shifts (they might have today's payments)
      { endTime: null },
      // Include closed shifts that overlap with the date range
      {
        // Shift was active during this period
        AND: [
          parsedStartTime ? { startTime: { lte: parsedEndTime || parsedStartTime } } : {},
          parsedEndTime
            ? {
                OR: [{ endTime: null }, { endTime: { gte: parsedStartTime || parsedEndTime } }],
              }
            : {},
        ].filter(obj => Object.keys(obj).length > 0),
      },
      // Or shift has payments in this period
      {
        payments: {
          some: paymentDateFilter,
        },
      },
    ]
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Get the shifts with related data
  const [shifts, totalCount] = await prisma.$transaction([
    prisma.shift.findMany({
      where: whereClause,
      include: {
        orders: {
          include: {
            payments: {
              where: {
                ...(staffId ? { processedById: staffId } : {}),
                // Filter payments by date range if provided
                ...(parsedStartTime || parsedEndTime
                  ? {
                      createdAt: {
                        ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                        ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                      },
                    }
                  : {}),
              },
              include: {
                allocations: true,
              },
            },
          },
          // Filter orders by date if date range is provided
          where:
            parsedStartTime || parsedEndTime
              ? {
                  createdAt: {
                    ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                    ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                  },
                }
              : undefined,
        },
        payments: {
          where: {
            ...(staffId ? { processedById: staffId } : {}),
            // Filter payments by date range if provided
            ...(parsedStartTime || parsedEndTime
              ? {
                  createdAt: {
                    ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                    ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                  },
                }
              : {}),
          },
        },
        staff: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.shift.count({
      where: whereClause,
    }),
  ])

  // Calculate the sum of tips and payments for each shift
  const shiftsWithCalculations = shifts.map(shift => {
    // Calculate payment totals from orders
    // 🔴 EL COBRO TIENE QUE SER DE ESTE TURNO — o de ninguno.
    //
    // La premisa que estaba escrita aquí («la orden y su cobro se atan al MISMO turno») dejó de
    // ser cierta el 3-sep-2026: la orden se estampa al ABRIRSE y el cobro se resuelve al PAGARSE,
    // y entre las dos cosas puede cambiar el turno. Mesa abierta 13:00 en el turno A → A cierra a
    // las 15:00 → pagan 15:30 en B: A alcanzaba ese cobro por su orden y B por `Payment.shiftId`,
    // y como el `Map` de abajo deduplica DENTRO de un turno y no ENTRE turnos, la pantalla sumaba
    // el mismo dinero dos veces. El cobro pertenece a donde entró el dinero, que es B.
    //
    // 🔴 La rama por orden NO se borra, y ésa es la parte que no se ve: hay órdenes históricas de
    // pos-sync con turno cuyo `Payment.shiftId` es NULO, y quitarla les borraría el dinero de la
    // pantalla. Por eso el filtro deja pasar también el cobro sin turno: es de esta orden y no lo
    // reclama nadie más.
    //
    // 🔴 `=== null`, NUNCA `== null`. El `==` suelto traga también `undefined`, y `undefined` es lo
    // que llega si alguien estrecha el `include` de arriba a un `select` sin `shiftId`: entonces
    // TODOS los cobros pasan el filtro y el mismo dinero vuelve a contarse en dos turnos, con las
    // pruebas en verde porque sus fixtures sí traen el campo. Con `===`, un cobro sin el dato se
    // cae del conteo — que se ve y se investiga— en vez de duplicarse en silencio. La otra mitad
    // del candado es la aserción sobre la FORMA de la consulta en
    // `tests/unit/services/tpv/shift.getShifts.cobroDeOtroTurno.test.ts`.
    const orderPayments = shift.orders.flatMap(order => order.payments).filter(p => p.shiftId === shift.id || p.shiftId === null)
    // Deduplicar por id sigue haciendo falta: un cobro de ESTE turno llega por los dos caminos.
    // Se conserva el orden actual (primero los de la orden) para no mover nada más.
    const allPayments = [...new Map([...orderPayments, ...shift.payments].map(payment => [payment.id, payment])).values()]

    // Calculate tip sum from payment allocations and tipAmount
    const tipSum = allPayments.reduce((sum, payment) => {
      const tipAmount = Number(payment.tipAmount || 0)
      return sum + tipAmount
    }, 0)

    // Calculate payment sum
    const paymentSum = allPayments.reduce((sum, payment) => {
      const paymentAmount = Number(payment.amount || 0)
      return sum + paymentAmount
    }, 0)

    // Calculate average tip percentage
    const avgTipPercentage = paymentSum > 0 ? (tipSum / paymentSum) * 100 : 0

    return {
      ...shift,
      // Remove the detailed data to make response cleaner
      orders: undefined,
      payments: undefined,
      // Add calculated values
      tipsSum: tipSum,
      tipsCount: allPayments.filter(p => Number(p.tipAmount || 0) > 0).length,
      paymentSum: paymentSum,
      avgTipPercentage: Number(avgTipPercentage.toFixed(2)),
      // Include staff information if filtered by staffId
      staffInfo: staffId
        ? {
            staffId: staffId,
            tipsCount: allPayments.filter(p => Number(p.tipAmount || 0) > 0).length,
            tipsSum: tipSum,
            avgTipPercentage: Number(avgTipPercentage.toFixed(2)),
          }
        : undefined,
    }
  })

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const response: PaginationResponse<any> = {
    data: shiftsWithCalculations,
    meta: {
      totalCount,
      pageSize,
      currentPage: pageNumber,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPrevPage: pageNumber > 1,
    },
  }

  // Add diagnostic information if no results
  if (totalCount === 0) {
    const totalVenueShifts = await prisma.shift.count({
      where: { venueId },
    })

    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenueShifts,
      filters: {
        dateRange: startTime || endTime ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent shift for this venue
    const latestShift = await prisma.shift.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    })

    if (latestShift) {
      diagnosticInfo.latestShiftDate = latestShift.createdAt
    }

    // If staffId was provided, check if staff member exists
    if (staffId) {
      const staffMember = await prisma.staff.findFirst({
        where: {
          id: staffId,
          venues: {
            some: {
              venueId: venueId,
            },
          },
        },
      })

      diagnosticInfo.staffExists = !!staffMember
      if (staffMember) {
        diagnosticInfo.staffInfo = {
          id: staffMember.id,
          firstName: staffMember.firstName,
          lastName: staffMember.lastName,
        }
      }
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Get shift summary with totals and waiter breakdown
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param filters Filter options
 * @returns Shift summary data
 */
export async function getShiftsSummary(venueId: string, filters: ShiftFilters = {}, _orgId?: string): Promise<ShiftSummaryResponse> {
  const { staffId, startTime, endTime } = filters

  // Parse date filters once for reuse
  let parsedStartTime: Date | undefined
  let parsedEndTime: Date | undefined

  if (startTime) {
    parsedStartTime = new Date(startTime)
    if (isNaN(parsedStartTime.getTime())) {
      throw new BadRequestError(`Invalid startTime: ${startTime}`)
    }
  }

  if (endTime) {
    parsedEndTime = new Date(endTime)
    if (isNaN(parsedEndTime.getTime())) {
      throw new BadRequestError(`Invalid endTime: ${endTime}`)
    }
  }

  // Auditorías de Codex (2026-09-01, P2 y luego P1 pre-push): el resumen usa UNA ventana
  // efectiva y la fija ANTES de armar cualquier consulta. Con fechas del cliente, la del
  // cliente; sin startTime, 24 h antes del endTime (o de ahora). La comparten los TURNOS
  // (solapamiento + pagos dentro del periodo), los huérfanos, las reseñas y el dateRange.
  // Antes la ventana sólo regía huérfanos y reseñas: los turnos seguían otra regla (sólo
  // abiertos, con TODO su historial) y dateRange declaraba 24 h que sus totales no cumplían.
  if (!parsedStartTime) {
    parsedStartTime = new Date((parsedEndTime ?? new Date()).getTime() - 24 * 60 * 60 * 1000)
  }
  const effectiveStartTime: Date = parsedStartTime
  const effectiveEndTime: Date | null = parsedEndTime ?? null
  const paymentDateFilter = {
    createdAt: {
      gte: effectiveStartTime,
      ...(effectiveEndTime ? { lte: effectiveEndTime } : {}),
    },
  }

  // Build the base query filters for shifts
  const whereClause: any = {
    venueId: venueId,
    // Include all shifts that are open OR have payments in the date range
    OR: [
      // Include open shifts (they might have today's payments)
      { endTime: null },
      // Include closed shifts that overlap with the date range
      ...(parsedStartTime || parsedEndTime
        ? [
            {
              // Shift was active during this period
              AND: [
                parsedStartTime ? { startTime: { lte: parsedEndTime || parsedStartTime } } : {},
                parsedEndTime
                  ? {
                      OR: [{ endTime: null }, { endTime: { gte: parsedStartTime || parsedEndTime } }],
                    }
                  : {},
              ].filter(obj => Object.keys(obj).length > 0),
            },
            // Or shift has payments in this period
            {
              payments: {
                some: paymentDateFilter,
              },
            },
          ]
        : []),
    ],
  }

  // Get shifts with related data
  const shifts = await prisma.shift.findMany({
    where: whereClause,
    include: {
      orders: {
        select: {
          id: true,
          total: true,
        },
        // 🔴 Sólo las COMPLETADAS, y tiene que ser el MISMO predicado que `orphanOrderCount`
        // (abajo, `status: 'COMPLETED'` + `shiftId: null`), porque `totalOrders` SUMA los dos.
        //
        // Hasta el 3-sep-2026 daba igual: casi ninguna orden llevaba `shiftId`, así que este
        // lado aportaba ~0 y el conteo lo cargaba entero la mitad huérfana. Al estampar el turno
        // al ABRIR la orden, sin este filtro las cuentas abiertas y las canceladas empezarían a
        // contar aquí — cuando antes no contaban en NINGUNA de las dos mitades—, e inflarían un
        // «total de órdenes» que se lee al lado del total de ventas.
        where: {
          status: 'COMPLETED',
          // Filter orders by date if date range is provided
          ...(parsedStartTime || parsedEndTime
            ? {
                createdAt: {
                  ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                  ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                },
              }
            : {}),
        },
      },
      payments: {
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          processedById: true,
          createdAt: true,
          method: true,
          processedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        where: {
          ...(staffId ? { processedById: staffId } : {}),
          // Filter payments by date range if provided
          ...(parsedStartTime || parsedEndTime
            ? {
                createdAt: {
                  ...(parsedStartTime ? { gte: parsedStartTime } : {}),
                  ...(parsedEndTime ? { lte: parsedEndTime } : {}),
                },
              }
            : {}),
        },
      },
    },
  })

  // Also fetch orphan payments (shiftId = null) — venues without shifts module
  // These payments exist but aren't associated with any shift.
  // 🔴 SIN fechas del cliente, esta rama se acota a las últimas 24 h. Sin esa ventana
  // materializaba TODOS los huérfanos históricos en el hilo único — Testarudo tiene
  // 32,646 (pagos importados de otro POS, sin turno): la misma clase de bomba que
  // tumbó producción el 2026-09-01 con el detalle del venue. La pantalla de turnos de
  // la PAX habla del día en curso; con fechas explícitas, la ventana del cliente manda.
  // Guardia: tests/unit/services/tpv/shiftsSummary.huerfanosAcotados.test.ts
  const orphanPaymentWhere: any = {
    venueId,
    shiftId: null,
    status: 'COMPLETED',
    ...(staffId ? { processedById: staffId } : {}),
    createdAt: {
      gte: effectiveStartTime,
      ...(effectiveEndTime ? { lte: effectiveEndTime } : {}),
    },
  }

  const orphanPayments = await prisma.payment.findMany({
    where: orphanPaymentWhere,
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      processedById: true,
      createdAt: true,
      method: true,
      processedBy: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  // Also count orphan orders (shiftId = null, with completed payments)
  const orphanOrderCount = await prisma.order.count({
    where: {
      venueId,
      shiftId: null,
      status: 'COMPLETED',
      // Misma ventana efectiva que los pagos huérfanos — sin ella, el resumen mezclaba
      // ventas de 24 h con un conteo de órdenes de TODA la historia (32k en Testarudo).
      createdAt: {
        gte: effectiveStartTime,
        ...(effectiveEndTime ? { lte: effectiveEndTime } : {}),
      },
    },
  })

  // Calculate summary data
  let totalTips = 0
  let totalSales = 0
  let totalOrders = 0
  let totalRatings = 0

  // Create a map to track tips per staff member
  const staffTipsMap: Map<string, { name: string; amount: number; count: number }> = new Map()

  // Create a map to track sales per staff member
  const staffSalesMap: Map<string, { name: string; totalSales: number; totalOrders: number; totalTips: number }> = new Map()

  // Create maps for payment methods and time-series data
  const paymentMethodMap: Map<string, number> = new Map()
  const allPayments: Array<{ createdAt: Date; amount: number }> = []

  // Process all shifts
  for (const shift of shifts) {
    // Count orders
    totalOrders += shift.orders.length

    // Process payments
    for (const payment of shift.payments) {
      // Add to total sales
      const paymentAmount = Number(payment.amount || 0)
      const tipAmount = Number(payment.tipAmount || 0)

      if (!isNaN(paymentAmount)) {
        totalSales += paymentAmount

        // Track payment method
        const method = payment.method || 'OTHER'
        paymentMethodMap.set(method, (paymentMethodMap.get(method) || 0) + paymentAmount)

        // Store for time-series data
        allPayments.push({
          createdAt: payment.createdAt,
          amount: paymentAmount,
        })

        // Track per-staff sales
        const pStaffId = payment.processedById
        if (pStaffId) {
          const sName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Unknown'
          if (staffSalesMap.has(pStaffId)) {
            const d = staffSalesMap.get(pStaffId)!
            d.totalSales += paymentAmount
            d.totalTips += tipAmount
            d.totalOrders += 1
          } else {
            staffSalesMap.set(pStaffId, { name: sName, totalSales: paymentAmount, totalTips: tipAmount, totalOrders: 1 })
          }
        }
      }

      if (!isNaN(tipAmount)) {
        totalTips += tipAmount

        // Track tips per staff member
        const staffId = payment.processedById
        const staffName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Unknown'

        if (staffId) {
          if (staffTipsMap.has(staffId)) {
            const staffData = staffTipsMap.get(staffId)!
            staffData.amount += tipAmount
            staffData.count += 1
          } else {
            staffTipsMap.set(staffId, {
              name: staffName,
              amount: tipAmount,
              count: 1,
            })
          }
        }
      }
    }
  }

  // Process orphan payments (no shift association)
  totalOrders += orphanOrderCount
  for (const payment of orphanPayments) {
    const paymentAmount = Number(payment.amount || 0)
    const tipAmount = Number(payment.tipAmount || 0)

    if (!isNaN(paymentAmount)) {
      totalSales += paymentAmount

      const method = payment.method || 'OTHER'
      paymentMethodMap.set(method, (paymentMethodMap.get(method) || 0) + paymentAmount)

      allPayments.push({
        createdAt: payment.createdAt,
        amount: paymentAmount,
      })

      // Track per-staff sales (orphan payments)
      const oStaffId = payment.processedById
      if (oStaffId) {
        const sName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Unknown'
        if (staffSalesMap.has(oStaffId)) {
          const d = staffSalesMap.get(oStaffId)!
          d.totalSales += paymentAmount
          d.totalTips += tipAmount
          d.totalOrders += 1
        } else {
          staffSalesMap.set(oStaffId, { name: sName, totalSales: paymentAmount, totalTips: tipAmount, totalOrders: 1 })
        }
      }
    }

    if (!isNaN(tipAmount)) {
      totalTips += tipAmount

      const pStaffId = payment.processedById
      const staffName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Unknown'

      if (pStaffId) {
        if (staffTipsMap.has(pStaffId)) {
          const staffData = staffTipsMap.get(pStaffId)!
          staffData.amount += tipAmount
          staffData.count += 1
        } else {
          staffTipsMap.set(pStaffId, {
            name: staffName,
            amount: tipAmount,
            count: 1,
          })
        }
      }
    }
  }

  // Get review count for these shifts
  try {
    const reviewWhereClause: any = {
      venueId,
      // Misma ventana efectiva que el resto del resumen (P2 de la auditoría).
      createdAt: {
        gte: effectiveStartTime,
        ...(effectiveEndTime ? { lte: effectiveEndTime } : {}),
      },
    }

    totalRatings = await prisma.review.count({
      where: reviewWhereClause,
    })
  } catch (error) {
    logger.warn('Error counting reviews:', error)
    // Continue without review count
  }

  // Calculate average tip percentage
  const averageTipPercentage = totalSales > 0 ? (totalTips / totalSales) * 100 : 0

  // Convert staff tips map to sorted array
  const waiterTips = Array.from(staffTipsMap.entries())
    .map(([id, data]) => ({
      staffId: id,
      name: data.name,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount) // Sort by highest amount first

  // Convert payment method map to array
  const paymentMethodBreakdown = Array.from(paymentMethodMap.entries()).map(([method, total]) => ({
    method: method,
    total: Number(total.toFixed(2)),
    percentage: totalSales > 0 ? Number(((total / totalSales) * 100).toFixed(2)) : 0,
  }))

  // Generate time-series sales data based on date range
  const salesTrend = generateSalesTrend(allPayments, parsedStartTime, parsedEndTime)

  return {
    // La ventana EFECTIVA, nunca null/null: si el cliente no mandó fechas, aquí se
    // declara el default de 24 h con el que se calculó todo lo de arriba.
    dateRange: {
      startTime: effectiveStartTime,
      endTime: effectiveEndTime,
    },
    summary: {
      totalSales: totalSales,
      totalTips: totalTips,
      ordersCount: totalOrders,
      averageTipPercentage: Number(averageTipPercentage.toFixed(2)),
      ratingsCount: totalRatings,
    },
    waiterTips: waiterTips,
    paymentMethods: paymentMethodBreakdown,
    salesTrend: salesTrend,
    staffSales: Array.from(staffSalesMap.entries())
      .map(([id, d]) => ({
        staffId: id,
        name: d.name,
        totalSales: +d.totalSales.toFixed(2),
        totalOrders: d.totalOrders,
        totalTips: +d.totalTips.toFixed(2),
      }))
      .sort((a, b) => b.totalSales - a.totalSales),
  }
}

/**
 * Generate time-series sales data based on payment timestamps
 */
function generateSalesTrend(
  payments: Array<{ createdAt: Date; amount: number }>,
  startTime?: Date,
  endTime?: Date,
): Array<{ label: string; value: number }> {
  if (payments.length === 0) {
    return []
  }

  const now = new Date()
  const start = startTime || new Date(Math.min(...payments.map(p => p.createdAt.getTime())))
  const end = endTime || now

  const diffMs = end.getTime() - start.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  // Determine granularity based on date range
  if (diffDays <= 1) {
    // Hourly for single day
    return generateHourlySalesTrend(payments)
  } else if (diffDays <= 7) {
    // Daily for week
    return generateDailySalesTrend(payments)
  } else if (diffDays <= 31) {
    // Weekly for month
    return generateWeeklySalesTrend(payments)
  } else {
    // Monthly for longer periods
    return generateMonthlySalesTrend(payments)
  }
}

function generateHourlySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const hourlyMap: Map<string, number> = new Map()

  payments.forEach(payment => {
    const hour = payment.createdAt.getHours()
    const label = `${hour.toString().padStart(2, '0')}:00`
    hourlyMap.set(label, (hourlyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(hourlyMap.entries())
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function generateDailySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const dailyMap: Map<string, number> = new Map()
  const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

  payments.forEach(payment => {
    const dayOfWeek = payment.createdAt.getDay()
    const label = days[dayOfWeek]
    dailyMap.set(label, (dailyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(dailyMap.entries()).map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
}

function generateWeeklySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const weeklyMap: Map<string, number> = new Map()

  payments.forEach(payment => {
    const weekNumber = Math.floor((payment.createdAt.getDate() - 1) / 7) + 1
    const label = `Sem ${weekNumber}`
    weeklyMap.set(label, (weeklyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(weeklyMap.entries())
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
    .sort((a, b) => {
      const weekA = parseInt(a.label.split(' ')[1])
      const weekB = parseInt(b.label.split(' ')[1])
      return weekA - weekB
    })
}

function generateMonthlySalesTrend(payments: Array<{ createdAt: Date; amount: number }>): Array<{ label: string; value: number }> {
  const monthlyMap: Map<string, number> = new Map()
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']

  payments.forEach(payment => {
    const monthIndex = payment.createdAt.getMonth()
    const label = months[monthIndex]
    monthlyMap.set(label, (monthlyMap.get(label) || 0) + payment.amount)
  })

  return Array.from(monthlyMap.entries()).map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
}

/**
 * Interface for shift closing data
 */
interface ShiftCloseData {
  cashDeclared: number
  cardDeclared: number
  vouchersDeclared: number
  otherDeclared: number
  notes?: string
}

export interface CashReconciliationResult {
  outcome: CashReconciliationOutcome
  countedCash?: string
  cashDifference?: string
  /**
   * Fase 5 de la unificación de caja: el arqueo del CAJÓN físico que cubrió este turno
   * (Android + TPV al cobrar). Campo NUEVO y OPCIONAL: sólo viaja cuando hay una caja que
   * cubre el turno; una PAX vieja lo ignora. La PAX nueva lo muestra junto a su propia
   * conciliación para que el cajero vea las DOS verdades — y si no coinciden, se note.
   */
  cashDrawer?: {
    sessionId: string
    status: string
    deviceName: string | null
    openedAt: string
    closedAt: string | null
    /** Ausente si quien cierra no tiene `cash-drawer:view-expected` y el cajón sigue abierto. */
    expectedAmount?: number
    counted: boolean
    actualAmount: number | null
    overShort: number | null
  }
}

export interface ShiftCloseRequestContext {
  orgId?: string
  actorStaffId?: string
  ipAddress?: string
  userAgent?: string
  /** Deterministic clock for stale-claim recovery tests; HTTP callers use the real clock. */
  now?: () => Date
}

export interface ShiftCloseExecutionResult {
  shift: Shift
  reconciliation: CashReconciliationResult
}

/**
 * Open a new shift for a venue
 * Works with both integrated POS (SOFTRESTAURANT) and standalone (NONE) mode
 * @param venueId Venue ID
 * @param staffId Staff ID who is opening the shift
 * @param startingCash Starting cash amount
 * @param stationId POS station ID (optional)
 * @param orgId Organization ID for authorization
 * @returns Created shift object
 */
export async function openShiftForVenue(
  venueId: string,
  staffId: string,
  startingCash: number,
  stationId?: string,
  _orgId?: string,
): Promise<Shift> {
  logger.info('Opening new shift for venue', {
    venueId,
    staffId,
    startingCash,
    stationId,
  })

  // Verify venue exists and get its POS configuration
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      name: true,
      posType: true,
      posStatus: true,
    },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found')
  }

  // Check if there's already an open shift for this venue
  const existingOpenShift = await prisma.shift.findFirst({
    where: {
      venueId: venueId,
      endTime: null, // Open shift
    },
  })

  if (existingOpenShift) {
    throw new BadRequestError('There is already an open shift for this venue. Please close it before opening a new one.')
  }

  // Verify staff member exists and belongs to venue
  // Find staff and their venue association
  const staffWithVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId: staffId,
      venueId: venueId,
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!staffWithVenue) {
    throw new NotFoundError('Staff member not found or not associated with this venue')
  }

  const posStaffId = staffWithVenue.posStaffId || staffId

  // Determine if we should send command to POS
  const isIntegratedPOS = venue.posType === 'SOFTRESTAURANT' && venue.posStatus === 'CONNECTED'

  let shiftExternalId: string | null = null

  if (isIntegratedPOS) {
    // INTEGRATED MODE: Send command to Windows service to open shift in POS
    try {
      // Generate a temporary shift ID for tracking
      const tempShiftId = `SHIFT_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`

      logger.info('Sending shift open command to POS', {
        venueId,
        tempShiftId,
        staffPosId: posStaffId,
      })

      await publishCommand(`command.softrestaurant.${venueId}`, {
        entity: 'Shift',
        action: 'OPEN',
        payload: {
          tempShiftId,
          posStaffId: posStaffId,
          startingCash: startingCash || 0,
          stationId: stationId || 'AVOQADO',
        },
      })

      // The Windows service will process this command and create the shift in POS
      // The shift will be synced back via the posSyncShift service
      // For now, we'll create the shift record with a marker that it's pending POS confirmation
      shiftExternalId = tempShiftId
    } catch (error) {
      logger.error('Failed to send shift open command to POS', error)
      throw new BadRequestError('Failed to open shift in POS system. Please try again.')
    }
  }

  // Create shift record in database
  //
  // 🔴 El `findFirst` de arriba es la respuesta amable del caso normal, pero NO evita la carrera:
  // dos terminales que abren a la vez pasan las dos el check antes de que ninguna cree. Lo que la
  // evita es el índice único PARCIAL `Shift(venueId) WHERE status='OPEN'` (migración
  // `20260903030000_shift_one_open_per_venue`, Fase 2 del turno de caja del negocio). Y no es un
  // registro de más: `turnoAbiertoDelNegocio` elige «el más reciente», así que con dos turnos
  // abiertos el dinero del negocio se parte entre ellos según el reloj.
  //
  // Aquí sólo se traduce ese choque al MISMO `ConflictError` que las apps ya conocen del cajón
  // (`mobile/cash-drawer.mobile.service.openSession`), en vez de dejar escapar un P2002 como 500:
  // un 500 al abrir el turno es un cajero mirando «algo salió mal» con la fila enfrente.
  const shift = await prisma.shift
    .create({
      data: {
        venueId: venueId,
        staffId: staffId,
        startTime: new Date(),
        endTime: null,
        status: 'OPEN' as ShiftStatus,
        startingCash: startingCash || 0,
        endingCash: null,
        cashDeclared: null,
        cardDeclared: null,
        vouchersDeclared: null,
        otherDeclared: null,
        totalSales: 0,
        totalTips: 0,
        notes: null,
        externalId: shiftExternalId,
        posRawData: stationId ? { stationId } : undefined,
      },
    })
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Ya hay un turno de caja abierto en este negocio. Ciérralo antes de abrir otro.', 'CASH_SHIFT_ALREADY_OPEN')
      }
      throw error
    })

  logger.info('Shift opened successfully', {
    shiftId: shift.id,
    venueId,
    staffId,
    isIntegratedPOS,
  })

  void logAction({
    staffId: staffId ?? null,
    venueId: venueId,
    action: 'SHIFT_OPENED',
    entity: 'Shift',
    entityId: shift.id,
    data: { startingCash: startingCash, stationId: stationId ?? undefined, isIntegratedPOS: isIntegratedPOS },
  })

  // Emit Socket.IO event for real-time dashboard updates
  try {
    const broadcastingService = socketManager.getBroadcastingService()
    if (broadcastingService) {
      broadcastingService.broadcastShiftEvent(venueId, 'opened', {
        shiftId: shift.id,
        staffId: shift.staffId,
        staffName: `${staffWithVenue.staff.firstName} ${staffWithVenue.staff.lastName}`,
        status: 'OPEN',
        startTime: shift.startTime.toISOString(),
        startingCash: shift.startingCash.toNumber(),
        totalSales: shift.totalSales.toNumber(),
        totalTips: shift.totalTips.toNumber(),
        totalOrders: shift.totalOrders,
        totalCashPayments: shift.totalCashPayments?.toNumber() || 0,
        totalCardPayments: shift.totalCardPayments?.toNumber() || 0,
        totalVoucherPayments: shift.totalVoucherPayments?.toNumber() || 0,
        totalOtherPayments: shift.totalOtherPayments?.toNumber() || 0,
        totalProductsSold: shift.totalProductsSold || 0,
        venueId,
      })
      logger.info('✅ Broadcasted shift_opened event to dashboard', { shiftId: shift.id, venueId })
    }
  } catch (error) {
    logger.error('❌ Failed to broadcast shift_opened event', {
      shiftId: shift.id,
      venueId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }

  return shift
}

type ClosableShift = Shift & {
  venue: {
    posType: string
    posStatus: string
    name: string
  }
}

interface EffectiveCloseRequest extends NormalizedCashReconciliationRequest {
  ignoreReason?: string
}

function moneyString(value: Decimal): string {
  return value.toFixed(2)
}

function shiftCloseInProgress(): ConflictError {
  return new ConflictError('El cierre de turno ya está en proceso. Intenta de nuevo en unos momentos.', 'SHIFT_CLOSE_IN_PROGRESS')
}

async function findClosableShift(venueId: string, shiftId: string): Promise<ClosableShift | null> {
  return prisma.shift.findFirst({
    where: { id: shiftId, venueId },
    include: {
      venue: {
        select: {
          posType: true,
          posStatus: true,
          name: true,
        },
      },
    },
  }) as Promise<ClosableShift | null>
}

/**
 * Claims a shift using OPEN -> CLOSING compare-and-set. A fresh claim is never stolen;
 * a process-abandoned claim older than five minutes can be recovered with a second CAS.
 */
async function claimShiftForClose(venueId: string, shiftId: string, claimedAt: Date): Promise<ClosableShift> {
  const shift = await findClosableShift(venueId, shiftId)
  if (!shift) {
    throw new NotFoundError('Shift not found or does not belong to this venue')
  }
  if (shift.endTime !== null || shift.status === ShiftStatus.CLOSED) {
    throw new BadRequestError('Shift is already closed')
  }

  const claim = await prisma.shift.updateMany({
    where: {
      id: shiftId,
      venueId,
      status: ShiftStatus.OPEN,
      endTime: null,
    },
    data: {
      status: ShiftStatus.CLOSING,
      updatedAt: claimedAt,
    },
  })
  if (claim.count === 1) return shift

  const latest = await findClosableShift(venueId, shiftId)
  if (!latest) {
    throw new NotFoundError('Shift not found or does not belong to this venue')
  }
  if (latest.endTime !== null || latest.status === ShiftStatus.CLOSED) {
    throw new BadRequestError('Shift is already closed')
  }

  const staleBefore = new Date(claimedAt.getTime() - SHIFT_CLOSE_STALE_MS)
  if (latest.status === ShiftStatus.CLOSING && latest.updatedAt instanceof Date && latest.updatedAt.getTime() < staleBefore.getTime()) {
    const recovered = await prisma.shift.updateMany({
      where: {
        id: shiftId,
        venueId,
        status: ShiftStatus.CLOSING,
        endTime: null,
        updatedAt: latest.updatedAt,
      },
      data: {
        status: ShiftStatus.CLOSING,
        updatedAt: claimedAt,
      },
    })
    if (recovered.count === 1) return latest
  }

  throw shiftCloseInProgress()
}

async function releaseShiftCloseClaim(venueId: string, shiftId: string, claimedAt: Date): Promise<void> {
  try {
    await prisma.shift.updateMany({
      where: {
        id: shiftId,
        venueId,
        status: ShiftStatus.CLOSING,
        endTime: null,
        updatedAt: claimedAt,
      },
      data: { status: ShiftStatus.OPEN },
    })
  } catch (releaseError) {
    logger.error('[Shift Close] Failed to release CLOSING claim after rollback', {
      venueId,
      shiftId,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    })
  }
}

async function publishShiftCloseToPos(venueId: string, shift: ClosableShift, request: EffectiveCloseRequest): Promise<void> {
  if (shift.venue.posType !== 'SOFTRESTAURANT' || shift.venue.posStatus !== 'CONNECTED' || !shift.externalId) return

  const legacy = request.source === 'LEGACY' ? request.legacyCloseData : undefined
  try {
    await publishCommand('command.softrestaurant.' + venueId, {
      entity: 'Shift',
      action: 'CLOSE',
      payload: {
        shiftId: shift.externalId,
        // Preserve the existing SoftRestaurant wire contract. The new physical-count
        // protocol is intentionally not reinterpreted as the legacy declaration.
        cashDeclared: legacy?.cashDeclared || 0,
        cardDeclared: legacy?.cardDeclared || 0,
        vouchersDeclared: legacy?.vouchersDeclared || 0,
        otherDeclared: legacy?.otherDeclared || 0,
      },
    })
  } catch (error) {
    logger.error('Failed to send shift close command to POS', error)
  }
}

async function broadcastClosedShift(venueId: string, updatedShift: Shift): Promise<void> {
  try {
    const broadcastingService = socketManager.getBroadcastingService()
    if (!broadcastingService) return

    const staffInfo = await prisma.staffVenue.findFirst({
      where: {
        staffId: updatedShift.staffId,
        venueId,
      },
      include: {
        staff: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    })

    broadcastingService.broadcastShiftEvent(venueId, 'closed', {
      shiftId: updatedShift.id,
      staffId: updatedShift.staffId,
      staffName: staffInfo ? staffInfo.staff.firstName + ' ' + staffInfo.staff.lastName : 'Unknown',
      status: 'CLOSED',
      startTime: updatedShift.startTime.toISOString(),
      endTime: updatedShift.endTime?.toISOString(),
      startingCash: updatedShift.startingCash.toNumber(),
      endingCash: updatedShift.endingCash?.toNumber(),
      cashDeclared: updatedShift.cashDeclared?.toNumber(),
      cashDifference: updatedShift.cashDifference?.toNumber(),
      totalSales: updatedShift.totalSales.toNumber(),
      totalTips: updatedShift.totalTips.toNumber(),
      totalOrders: updatedShift.totalOrders,
      totalCashPayments: updatedShift.totalCashPayments?.toNumber() || 0,
      totalCardPayments: updatedShift.totalCardPayments?.toNumber() || 0,
      totalVoucherPayments: updatedShift.totalVoucherPayments?.toNumber() || 0,
      totalOtherPayments: updatedShift.totalOtherPayments?.toNumber() || 0,
      totalProductsSold: updatedShift.totalProductsSold || 0,
      venueId,
    })
  } catch (error) {
    logger.error('Failed to broadcast shift_closed event', {
      shiftId: updatedShift.id,
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * La proyección MÍNIMA de un `Payment` con la que se pueden calcular los totales de un turno —
 * exactamente lo que selecciona el cierre.
 *
 * 🔴 Los tres campos de `tenderSemantics` son OBLIGATORIOS (aunque nulos) a propósito: si fueran
 * opcionales, un `select` que olvide `tenderCountsAsCash` compilaría y el vale de despensa
 * dejaría de contar en el cajón sin que nada avise. Es la trampa del mock que ya costó una vez
 * («el mock pasa el campo gratis, el `select` real no»).
 */
export interface ShiftPaymentForTotals {
  amount: Decimal | number | string | null
  tipAmount: Decimal | number | string | null
  method: PaymentMethod | string
  fundsFlow: PaymentFundsFlow | string | null
  tenderTypeId: string | null
  tenderCountsAsCash: boolean | null
  /**
   * Aceptado para que un llamador pueda pasar su fila tal cual, pero la agregación NO lo mira:
   * el cierre nunca ramificó por `type`. Un REFUND ya viene con `amount` negativo y por eso
   * resta solo. Ramificar aquí sería cambiar la regla, no extraerla.
   */
  type?: PaymentType | string | null
}

/** Los ocho totales con los que se cierra un turno. Todos `Decimal`: dinero nunca en float. */
export interface ShiftPaymentTotals {
  totalSales: Decimal
  totalTips: Decimal
  totalCashPayments: Decimal
  totalCardPayments: Decimal
  totalVoucherPayments: Decimal
  totalOtherPayments: Decimal
  totalCashTips: Decimal
  totalDrawerExtra: Decimal
}

/**
 * Los totales de un turno a partir de sus cobros COMPLETED.
 *
 * Extraída VERBATIM del cuerpo de `closeShiftUsingRequest` (tarea 9, «turno de caja del
 * negocio»): mismas ramas por método, misma `totalCashTips`, mismo `totalDrawerExtra`. Existe
 * para que el script de reatribución histórica (`scripts/reatribuir-cobros-al-turno.ts`)
 * recalcule un turno con LA MISMA regla que el cierre en vez de con una copia — si divergieran,
 * el turno reparado y el turno cerrado dirían cifras distintas del mismo dinero.
 *
 * Pura: sin base, sin reloj, sin `venueId`. Lo que decide qué está en el cajón NO es
 * `method === 'CASH'` sino `paymentCountsAsDrawerCash` (la autoridad de `tenderSemantics`).
 */
export function aggregateShiftPayments(payments: ShiftPaymentForTotals[]): ShiftPaymentTotals {
  let totalCashPayments = new Decimal(0)
  let totalCardPayments = new Decimal(0)
  let totalVoucherPayments = new Decimal(0)
  let totalOtherPayments = new Decimal(0)
  let totalSales = new Decimal(0)
  let totalTips = new Decimal(0)
  // 🔴 Propina cobrada EN EFECTIVO — se lleva aparte de `totalCashPayments` a propósito.
  //
  // `totalCashPayments` es la cifra de VENTAS en efectivo y la consumen el MCP
  // (`src/mcp/tools/shifts.ts`), `cashSales` del dashboard y `salesTotal`
  // (`shared-query.service.ts`). Sumarle la propina ahí arreglaría el arqueo inflando
  // las ventas — cambiar un bug por otro peor.
  //
  // Pero el billete de propina SÍ entró físicamente al cajón junto con la venta, así
  // que el efectivo esperado tiene que incluirlo o el cierre reporta un sobrante falso
  // del tamaño de las propinas (era la contradicción contra
  // `cashCloseout.dashboard.service.ts`, que sí las sumaba). El dueño cuenta, ve el
  // desglose en el ticket y reparte DESPUÉS: por eso no hace falta registrar un egreso.
  //
  // La propina de TARJETA no entra aquí: ese dinero llega por el depósito del banco.
  let totalCashTips = new Decimal(0)
  // Dinero que SÍ está en el cajón sin ser venta en efectivo: tender personalizado con
  // countsAsPhysicalCash (vale de despensa, method=OTHER). Entra al efectivo esperado
  // pero NUNCA a `totalCashPayments` (que es la cifra de VENTAS en efectivo — ver arriba).
  // Con la data actual (sin tender snapshots) esto es siempre 0: comportamiento idéntico.
  let totalDrawerExtra = new Decimal(0)

  payments.forEach(payment => {
    const amount = new Decimal(payment.amount || 0)
    const tipAmount = new Decimal(payment.tipAmount || 0)
    totalSales = totalSales.add(amount)
    totalTips = totalTips.add(tipAmount)

    if (payment.method !== 'CASH' && paymentCountsAsDrawerCash(payment)) {
      totalDrawerExtra = totalDrawerExtra.add(amount).add(tipAmount)
    }

    switch (payment.method) {
      case 'CASH':
        totalCashPayments = totalCashPayments.add(amount)
        totalCashTips = totalCashTips.add(tipAmount)
        break
      case 'CREDIT_CARD':
      case 'DEBIT_CARD':
        totalCardPayments = totalCardPayments.add(amount)
        break
      case 'DIGITAL_WALLET':
        totalVoucherPayments = totalVoucherPayments.add(amount)
        break
      case 'BANK_TRANSFER':
      case 'OTHER':
      default:
        totalOtherPayments = totalOtherPayments.add(amount)
        break
    }
  })

  return {
    totalSales,
    totalTips,
    totalCashPayments,
    totalCardPayments,
    totalVoucherPayments,
    totalOtherPayments,
    totalCashTips,
    totalDrawerExtra,
  }
}

async function closeShiftUsingRequest(
  venueId: string,
  shiftId: string,
  request: EffectiveCloseRequest,
  context: ShiftCloseRequestContext,
): Promise<ShiftCloseExecutionResult> {
  const claimedAt = context.now?.() ?? new Date()
  const shift = await claimShiftForClose(venueId, shiftId, claimedAt)

  try {
    const shiftPayments = await prisma.payment.findMany({
      where: {
        shiftId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        method: true,
        // tenderSemantics inputs — a cash-counting voucher tender must reach the drawer math.
        fundsFlow: true,
        tenderTypeId: true,
        tenderCountsAsCash: true,
      },
    })

    // Los ocho totales salen de `aggregateShiftPayments` (arriba en este archivo). Vive fuera
    // para que el script de reatribución histórica recalcule un turno con LA MISMA regla; los
    // comentarios de por qué `totalCashTips` y `totalDrawerExtra` van aparte viven con ella.
    const {
      totalSales,
      totalTips,
      totalCashPayments,
      totalCardPayments,
      totalVoucherPayments,
      totalOtherPayments,
      totalCashTips,
      totalDrawerExtra,
    } = aggregateShiftPayments(shiftPayments)

    const orderItems = await prisma.orderItem.findMany({
      where: {
        order: {
          shiftId,
          status: { in: ['COMPLETED'] },
        },
      },
      select: {
        id: true,
        quantity: true,
        productName: true,
        product: { select: { name: true } },
      },
    })
    const totalProductsSold = orderItems.reduce((sum, item) => sum + item.quantity, 0)

    const inventoryMovements = await prisma.rawMaterialMovement.findMany({
      where: {
        type: 'USAGE',
        createdAt: {
          gte: shift.startTime,
          lte: claimedAt,
        },
        rawMaterial: { venueId },
      },
      include: {
        rawMaterial: {
          select: {
            id: true,
            name: true,
            sku: true,
            unit: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    const inventoryConsumedMap = new Map<
      string,
      {
        rawMaterialId: string
        name: string
        sku: string | null
        unit: string
        quantityConsumed: number
        movementsCount: number
      }
    >()

    inventoryMovements.forEach(movement => {
      const key = movement.rawMaterialId
      const quantity = Math.abs(Number(movement.quantity || 0))
      const existing = inventoryConsumedMap.get(key)
      if (existing) {
        existing.quantityConsumed += quantity
        existing.movementsCount += 1
      } else {
        inventoryConsumedMap.set(key, {
          rawMaterialId: movement.rawMaterialId,
          name: movement.rawMaterial.name,
          sku: movement.rawMaterial.sku,
          unit: movement.rawMaterial.unit,
          quantityConsumed: quantity,
          movementsCount: 1,
        })
      }
    })
    const inventoryConsumed = Array.from(inventoryConsumedMap.values())

    const shiftDuration = Math.floor((claimedAt.getTime() - shift.startTime.getTime()) / 1000 / 60)
    const reportData = {
      shift: {
        id: shiftId,
        startTime: shift.startTime,
        endTime: claimedAt,
        durationMinutes: shiftDuration,
        venueName: shift.venue.name,
      },
      sales: {
        total: totalSales.toNumber(),
        totalTips: totalTips.toNumber(),
        totalOrders: orderItems.length,
        productsSold: totalProductsSold,
      },
      paymentMethods: {
        cash: totalCashPayments.toNumber(),
        card: totalCardPayments.toNumber(),
        voucher: totalVoucherPayments.toNumber(),
        other: totalOtherPayments.toNumber(),
      },
      inventory: {
        uniqueRawMaterialsConsumed: inventoryConsumed.length,
        totalMovements: inventoryMovements.length,
        details: inventoryConsumed,
      },
      products: {
        totalSold: totalProductsSold,
        uniqueProducts: new Set(orderItems.map(item => item.product?.name || item.productName || 'Unknown')).size,
        items: orderItems.map(item => ({
          name: item.product?.name || item.productName || 'Unknown',
          quantity: item.quantity,
        })),
      },
    }

    // Lo que HAY en el cajón por este turno: ventas en efectivo + propina cobrada en
    // efectivo + tenders que cuentan como efectivo físico (vales). Es la cifra del
    // arqueo, distinta de `totalCashPayments` (ventas) que alimenta los reportes.
    // Ver los comentarios donde se acumulan `totalCashTips` y `totalDrawerExtra`.
    const cashInDrawer = totalCashPayments.add(totalCashTips).add(totalDrawerExtra)

    const expectedCash = new Decimal(shift.startingCash || 0).add(cashInDrawer)
    let outcome: CashReconciliationOutcome = request.outcome
    let ignoreReason = request.ignoreReason ?? request.reason
    let endingCash = cashInDrawer
    let cashDeclared: Decimal | null = null
    let cashDifference: Decimal | null = null
    let calculatedDifference: Decimal | null = null

    if (request.source === 'NEW' && request.action === 'COUNTED' && request.countedCash && outcome === 'APPLIED') {
      const calculation = calculateCashReconciliation(request.countedCash, shift.startingCash || 0, cashInDrawer)
      endingCash = new Decimal(request.countedCash)
      cashDeclared = new Decimal(request.countedCash)
      calculatedDifference = new Decimal(calculation.difference)

      if (calculation.fitsDifferenceColumn) {
        cashDifference = calculatedDifference
      } else {
        outcome = 'IGNORED_OVERFLOW'
        ignoreReason = 'cash difference exceeds Decimal(10,2)'
      }
    } else if (request.source === 'LEGACY' && request.legacyCloseData) {
      const legacyCash = new Decimal(request.legacyCloseData.cashDeclared ?? 0)
      endingCash = request.legacyCloseData.cashDeclared ? new Decimal(shift.startingCash || 0).add(legacyCash) : totalCashPayments
      cashDeclared = request.legacyCloseData.cashDeclared ? legacyCash : null
      // Preserve the active Desktop/legacy database contract: declarations remain stored and
      // continue driving endingCash, but H0.6 does not retrofit a reconciliation difference.
      // Only the explicit, entitled COUNTED protocol owns Shift.cashDifference.
    }

    const legacy = request.source === 'LEGACY' ? request.legacyCloseData : undefined
    const finalData = {
      endTime: claimedAt,
      status: ShiftStatus.CLOSED,
      endingCash,
      cashDeclared,
      cashDifference,
      cardDeclared: legacy?.cardDeclared ? new Decimal(legacy.cardDeclared) : null,
      vouchersDeclared: legacy?.vouchersDeclared ? new Decimal(legacy.vouchersDeclared) : null,
      otherDeclared: legacy?.otherDeclared ? new Decimal(legacy.otherDeclared) : null,
      totalSales,
      totalTips,
      totalOrders: orderItems.length,
      notes: legacy?.notes || null,
      totalCashPayments,
      totalCashTips,
      totalCardPayments,
      totalVoucherPayments,
      totalOtherPayments,
      totalProductsSold,
      inventoryConsumed: inventoryConsumed as Prisma.InputJsonValue,
      reportData: reportData as Prisma.InputJsonValue,
    }

    const auditData: Record<string, string | number | undefined> = {
      source: request.source,
      action: request.action,
      outcome,
      expectedCash: moneyString(expectedCash),
      ignoreReason,
      endingCash: endingCash.toNumber(),
      totalSales: totalSales.toNumber(),
      totalTips: totalTips.toNumber(),
    }
    if (request.countedCash) auditData.countedCash = moneyString(new Decimal(request.countedCash))
    if (cashDifference) auditData.cashDifference = moneyString(cashDifference)
    if (outcome === 'IGNORED_OVERFLOW' && calculatedDifference) {
      auditData.calculatedDifference = moneyString(calculatedDifference)
    }
    if (legacy) {
      auditData.declaredCash = moneyString(new Decimal(legacy.cashDeclared ?? 0))
      auditData.cashDiscrepancy =
        legacy.cashDeclared != null ? new Decimal(legacy.cashDeclared).sub(totalCashPayments).toNumber() : undefined
    }

    const updatedShift = await prisma.$transaction(async tx => {
      const finalized = await tx.shift.updateMany({
        where: {
          id: shiftId,
          venueId,
          status: ShiftStatus.CLOSING,
          endTime: null,
          updatedAt: claimedAt,
        },
        data: finalData,
      })
      if (finalized.count !== 1) throw shiftCloseInProgress()

      const closedShift = await tx.shift.findUnique({ where: { id: shiftId } })
      if (!closedShift) throw new NotFoundError('Shift disappeared while closing')

      await tx.activityLog.create({
        data: {
          staffId: context.actorStaffId ?? shift.staffId ?? null,
          venueId,
          action: 'SHIFT_CLOSED',
          entity: 'Shift',
          entityId: shift.id,
          data: auditData as Prisma.InputJsonValue,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        },
      })

      return closedShift
    })

    logger.info('Shift closed successfully with an atomic claim', {
      shiftId,
      venueId,
      source: request.source,
      outcome,
    })

    // External effects are attempted only after the Shift + ActivityLog transaction commits.
    await publishShiftCloseToPos(venueId, shift, request)
    await broadcastClosedShift(venueId, updatedShift)

    const reconciliation: CashReconciliationResult = { outcome }
    if (request.source === 'NEW' && request.action === 'COUNTED' && request.countedCash) {
      reconciliation.countedCash = moneyString(new Decimal(request.countedCash))
    }
    if (outcome === 'APPLIED' && cashDifference) {
      reconciliation.cashDifference = moneyString(cashDifference)
    }
    // Fase 5: la PAX LEE el cajón. Se adjunta el arqueo de la caja física que cubrió el
    // turno (campo opcional; se omite si no hay caja). Es informativo — nunca puede hacer
    // fallar un cierre que ya está commiteado, por eso el try/catch.
    try {
      // P2 (Codex): el turno YA está cerrado y commiteado; la PAX espera 12 s. Una consulta lenta no
      // puede convertir un cierre exitoso en un NetworkError: si tarda más de 1.5 s, va sin el campo.
      const drawer = await Promise.race([
        resolveShiftCashDrawer(venueId, updatedShift.startTime, updatedShift.endTime ?? new Date()),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1500).unref?.()),
      ])
      // 🔴 Con el conteo ciego, `expectedAmount` puede venir ausente (cajón todavía ABIERTO y
      // quien cierra sin `cash-drawer:view-expected`). En ese caso NO se adjunta el bloque:
      // `CashDrawerSummaryDto.expectedAmount` es un `Double` NO nullable en la PAX y Gson
      // rellena un primitivo ausente con 0.0, así que la terminal imprimiría "Esperado en el
      // cajón: $0.00" — una cifra de dinero FALSA. El objeto entero sí es opcional allá
      // (`cashDrawer: CashDrawerSummaryDto? = null`) y la pantalla ya sabe no pintar la
      // sección, que es exactamente lo que debe pasar cuando no se puede mostrar el número.
      if (drawer && drawer.expectedAmount !== undefined) {
        reconciliation.cashDrawer = {
          sessionId: drawer.sessionId,
          // P1 (Codex 27-ago): la PAX debe poder decir DE QUÉ caja es el número — aparato y horario.
          status: drawer.status,
          deviceName: drawer.deviceName,
          openedAt: drawer.openedAt,
          closedAt: drawer.closedAt,
          expectedAmount: drawer.expectedAmount,
          counted: drawer.counted,
          actualAmount: drawer.actualAmount,
          overShort: drawer.overShort,
        }
      }
    } catch (err) {
      logger.warn('[CASH-DRAWER] No se pudo adjuntar el arqueo del cajón al cierre del turno', {
        shiftId: updatedShift.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return { shift: updatedShift, reconciliation }
  } catch (error) {
    await releaseShiftCloseClaim(venueId, shiftId, claimedAt)
    throw error
  }
}

/**
 * Long-lived direct-call contract retained for scripts and trusted callers. Passing closeData
 * remains the legacy declaration path and never consults the new paid-feature gate.
 */
export async function closeShiftForVenue(venueId: string, shiftId: string, closeData?: ShiftCloseData, orgId?: string): Promise<Shift> {
  const normalized = normalizeCashReconciliationRequest(closeData ?? {})
  const result = await closeShiftUsingRequest(venueId, shiftId, normalized, { orgId })
  return result.shift
}

/** HTTP-facing additive wrapper with request-scoped reconciliation outcome. */
export async function closeShiftForVenueWithResult(
  venueId: string,
  shiftId: string,
  rawBody: unknown,
  context: ShiftCloseRequestContext = {},
): Promise<ShiftCloseExecutionResult> {
  const normalized = normalizeCashReconciliationRequest(rawBody)
  const effective: EffectiveCloseRequest = { ...normalized }

  if (normalized.source === 'NEW' && normalized.action === 'COUNTED' && normalized.outcome === 'APPLIED') {
    const enabled = await isCashReconciliationEnabled(venueId)
    if (!enabled) {
      effective.outcome = 'IGNORED_DISABLED'
      effective.ignoreReason = 'cash reconciliation is disabled'
    }
  }

  return closeShiftUsingRequest(venueId, shiftId, effective, context)
}
