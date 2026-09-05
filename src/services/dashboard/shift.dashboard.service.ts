import { calculateExpectedAmount } from '../mobile/cash-drawer.mobile.service'
import logger from '../../config/logger'
import { BadRequestError, ConflictError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'
import { lineRevenue } from './lineRevenue'
import { calculateCashReconciliation, calculateCashReconciliationFromExpected } from '../shared/cashReconciliation.service'
import { lockShiftLifecycleForVenue } from '../shared/shiftLifecycleLock'

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
}

type ShiftCashValue = { toString(): string } | number | null | undefined

/** Preserve zero as a real count/difference while keeping an absent count null. */
export function serializeShiftCashReconciliation(shift: {
  endingCash: ShiftCashValue
  cashDeclared: ShiftCashValue
  cashDifference: ShiftCashValue
}): { endingCash: number | null; cashDeclared: number | null; cashDifference: number | null } {
  return {
    endingCash: shift.endingCash == null ? null : Number(shift.endingCash),
    cashDeclared: shift.cashDeclared == null ? null : Number(shift.cashDeclared),
    cashDifference: shift.cashDifference == null ? null : Number(shift.cashDifference),
  }
}

export async function getShifts(
  venueId: string,
  page: number,
  pageSize: number,
  filters: ShiftFilters = {},
): Promise<PaginationResponse<any>> {
  const { staffId, startTime, endTime } = filters

  const whereClause: any = {
    venueId: venueId,
  }

  if (startTime || endTime) {
    whereClause.startTime = {}

    if (startTime) {
      const parsedStartTime = new Date(startTime)
      if (!isNaN(parsedStartTime.getTime())) {
        whereClause.startTime.gte = parsedStartTime
      } else {
        throw new BadRequestError(`Invalid startTime: ${startTime}`)
      }
    }

    if (endTime) {
      const parsedEndTime = new Date(endTime)
      if (!isNaN(parsedEndTime.getTime())) {
        whereClause.startTime.lte = parsedEndTime
      } else {
        throw new BadRequestError(`Invalid endTime: ${endTime}`)
      }
    }

    if (Object.keys(whereClause.startTime).length === 0) {
      delete whereClause.startTime
    }
  }

  if (staffId) {
    whereClause.staffId = staffId
  }

  const skip = (page - 1) * pageSize

  const [shifts, totalCount] = await prisma.$transaction([
    prisma.shift.findMany({
      where: whereClause,
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        startTime: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.shift.count({
      where: whereClause,
    }),
  ])

  const shiftsWithCalculations = shifts.map(shift => {
    // Determine effective status based on time logic
    const now = new Date()
    const effectiveStatus = shift.endTime && shift.endTime < now ? 'CLOSED' : shift.status

    return {
      id: shift.id,
      venueId: shift.venueId,
      staffId: shift.staffId,
      startTime: shift.startTime,
      endTime: shift.endTime,
      startingCash: Number(shift.startingCash),
      ...serializeShiftCashReconciliation(shift),
      totalSales: Number(shift.totalSales),
      totalTips: Number(shift.totalTips),
      totalOrders: shift.totalOrders,
      status: effectiveStatus,
      staff: shift.staff,
      venue: shift.venue,
    }
  })

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: shiftsWithCalculations,
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
 * Fase 5 de la unificación de caja: el arqueo del CAJÓN que cubrió este turno.
 *
 * `Shift` calculaba su propio "efectivo esperado" a partir de sus pagos y el cajón (Android +
 * TPV) el suyo: dos números para el mismo dinero. Aquí el turno EXPONE el del cajón — campo
 * nuevo y opcional, nada de lo que ya devolvía cambia. Una PAX vieja lo ignora; la nueva lo
 * usa en vez de calcular aparte. La liga exacta manda; para legacy se elige la sesión única
 * del mismo venue cuya ventana [openedAt, closedAt] cubre el cierre del turno y, si ninguna lo
 * cubre, la única que se traslapó. Si no hay, `null` y el turno se ve como hoy.
 * `counted` es explícito: una caja cerrada sin conteo nunca se pinta como cuadrada.
 */
// @param incluirEsperado ¿el llamante tiene `cash-drawer:view-expected`? Con `false` (el
// default) el esperado y el fondo se omiten MIENTRAS el cajón siga abierto: es el mismo
// conteo ciego que aplica el endpoint del cajón, y sin él bastaba abrir el detalle del turno
// para leer la cifra. Un cajón ya CERRADO revela siempre: ese resultado ya está firmado.
// @param shiftId el turno que se está resolviendo. Su liga exacta manda sin mirar fechas; sólo si
// no existe se consideran sesiones legacy SIN liga. Una ventana con dos legacy plausibles es
// ambigua: elegir la más nueva firmaría dinero contra un libro arbitrario.
type ShiftCashDrawerWindowStage = 'ANCHOR' | 'OVERLAP'
type ShiftCashDrawerLegacySelection =
  | { kind: 'NONE' }
  | { kind: 'ONE'; id: string }
  | { kind: 'AMBIGUOUS'; stage: ShiftCashDrawerWindowStage }

class AmbiguousShiftCashDrawerError extends Error {
  readonly code = 'AMBIGUOUS_SHIFT_CASH_DRAWER'

  constructor(readonly stage: ShiftCashDrawerWindowStage) {
    super(`Más de una gaveta legacy coincide con la ventana del turno (${stage})`)
    this.name = 'AmbiguousShiftCashDrawerError'
  }
}

class SelectedShiftCashDrawerUnavailableError extends Error {
  readonly code = 'SELECTED_SHIFT_CASH_DRAWER_UNAVAILABLE'

  constructor() {
    super('La gaveta legacy seleccionada cambió antes de poder hidratarla')
    this.name = 'SelectedShiftCashDrawerUnavailableError'
  }
}

export async function resolveShiftCashDrawer(
  venueId: string,
  startTime: Date | null,
  endTime?: Date | null,
  incluirEsperado = false,
  shiftId?: string,
) {
  const include = { events: { orderBy: { createdAt: 'asc' as const } } }

  // Identidad durable: no compite con una fila legacy más nueva ni depende de que la ventana
  // histórica esté completa. `venueId` conserva el aislamiento aun cuando `shiftId` es único.
  const findLinkedSession = () =>
    shiftId ? prisma.cashDrawerSession.findFirst({ where: { venueId, shiftId }, include }) : Promise.resolve(null)
  let session = await findLinkedSession()
  if (!session && !startTime) {
    // Incluso sin ventana temporal, una liga puede haber aparecido después de la primera
    // lectura. Revalidarla evita convertir esa carrera en una ausencia financiera falsa.
    session = await findLinkedSession()
  }
  if (!session && !startTime) return null

  // 🔴 P1 (Codex 27-ago): se ancla al CIERRE del turno (o a "ahora" si sigue abierto), no a su inicio.
  // Turno 08–20 con cajón A (07–12) y B (12–20): el que operó al cerrar es B; anclar al inicio
  // devolvía A y la PAX enseñaba el arqueo de otro cajón sin decirlo. El índice único parcial
  // (fase 4) garantiza UNA caja abierta por venue en cada instante, así que "la que cubre el
  // ancla" es única. Si ninguna cubre el ancla (la caja se cerró antes que el turno), se cae a la
  // última que se traslapó con el turno. Cada etapa lee sólo dos identidades: 0 permite avanzar,
  // 1 elige, 2 prueba ambigüedad. Los eventos se hidratan DESPUÉS y sólo para la ganadora.
  const anchor = endTime ?? new Date()
  if (!session) {
    const selectLegacyCandidate = async (
      where: Record<string, unknown>,
      stage: ShiftCashDrawerWindowStage,
    ): Promise<ShiftCashDrawerLegacySelection> => {
      const candidates = await prisma.cashDrawerSession.findMany({
        where: { ...where, venueId, shiftId: null },
        select: { id: true },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      })
      if (candidates.length > 1) return { kind: 'AMBIGUOUS', stage }
      if (candidates.length === 1) return { kind: 'ONE', id: candidates[0].id }
      return { kind: 'NONE' }
    }

    const anchorSelection = await selectLegacyCandidate(
      { openedAt: { lte: anchor }, OR: [{ closedAt: null }, { closedAt: { gte: anchor } }] },
      'ANCHOR',
    )
    const legacySelection =
      anchorSelection.kind === 'NONE'
        ? await selectLegacyCandidate({ openedAt: { lte: anchor }, OR: [{ closedAt: null }, { closedAt: { gte: startTime! } }] }, 'OVERLAP')
        : anchorSelection

    // La liga exacta tiene prioridad absoluta, también si nació después de la primera lectura.
    // Se revalida después de los scans y antes de interpretar cero como ausencia, lanzar por
    // ambigüedad o hidratar una legacy. Así una carrera con `asegurarLaLiga` no cae a TURNO ni
    // carga eventos de dos candidatas.
    session = await findLinkedSession()
    if (!session && legacySelection.kind === 'AMBIGUOUS') {
      throw new AmbiguousShiftCashDrawerError(legacySelection.stage)
    }
    if (!session && legacySelection.kind === 'ONE') {
      session = await prisma.cashDrawerSession.findFirst({
        // Mantener ambos filtros es deliberado: si la fila se ligó a otro turno durante la
        // carrera, no podemos leer su libro. Pero tampoco es "ausencia": hubo una identidad
        // elegida y perderla vuelve desconocida la autoridad financiera de este turno.
        where: { id: legacySelection.id, venueId, shiftId: null },
        include,
      })
      if (!session) throw new SelectedShiftCashDrawerUnavailableError()
    }
  }
  if (!session) return null
  const money = (v: unknown) => Number(Number(v).toFixed(2))
  const counted = session.actualAmount !== null && session.actualAmount !== undefined
  return {
    sessionId: session.id,
    status: session.status,
    deviceName: session.deviceName ?? null,
    openedByName: session.openedByName,
    closedByName: session.closedByName ?? null,
    openedAt: session.openedAt.toISOString(),
    closedAt: session.closedAt ? session.closedAt.toISOString() : null,
    ...(incluirEsperado || session.status !== 'OPEN'
      ? { startingAmount: money(session.startingAmount), expectedAmount: calculateExpectedAmount(session) }
      : {}),
    counted,
    actualAmount: counted ? money(session.actualAmount) : null,
    overShort: counted && session.overShort != null ? money(session.overShort) : null,
  }
}

export async function getShiftById(venueId: string, shiftId: string, incluirEsperado = false): Promise<any | null> {
  const shift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      venueId: venueId,
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      venue: {
        select: {
          id: true,
          name: true,
          timezone: true,
        },
      },
      // Include payments with processor data for card brand breakdown
      payments: {
        where: {
          status: 'COMPLETED',
        },
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          method: true,
          // Etiqueta del tipo de pago para el desglose "expande Otros".
          // `externalSource` es el fallback de lo histórico (antes del catálogo).
          tenderLabel: true,
          externalSource: true,
          cardBrand: true,
          maskedPan: true,
          processorData: true,
          processedById: true,
          processedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          orderId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      // Include orders with items for product breakdown
      orders: {
        where: {
          status: {
            in: ['COMPLETED', 'CONFIRMED'],
          },
        },
        select: {
          id: true,
          orderNumber: true,
          total: true,
          subtotal: true,
          status: true,
          table: {
            select: {
              id: true,
              number: true,
            },
          },
          createdAt: true,
          servedById: true,
          servedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          items: {
            select: {
              id: true,
              quantity: true,
              unitPrice: true,
              discountAmount: true,
              // Both are REQUIRED by lineRevenue: without `modifiers` the
              // modifier revenue vanishes, without `weightQuantity` a weighing
              // is charged as a whole kilo.
              weightQuantity: true,
              modifiers: { select: { price: true, quantity: true } },
              product: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          payments: {
            where: {
              status: 'COMPLETED',
            },
            select: {
              id: true,
              method: true,
              cardBrand: true,
              maskedPan: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
    },
  })

  if (!shift) {
    return null
  }

  // Determine effective status based on time logic
  const now = new Date()
  const effectiveStatus = shift.endTime && shift.endTime < now ? 'CLOSED' : shift.status

  // ============================================================
  // Calculate Payment Method Breakdown
  // ============================================================
  // Toda la lógica vive en `buildPaymentBreakdown` (función pura, con tests): desglosa por
  // método REAL —débito y crédito por separado— y calcula el porcentaje por marca contra la
  // suma de tarjetas, no contra una cubeta 'CARD' que ya no existe.
  const {
    paymentMethodBreakdown,
    cardBrandBreakdown,
    totalSales: calculatedTotalSales,
    totalTips: calculatedTotalTips,
  } = buildPaymentBreakdown(shift.payments as any)

  // ============================================================
  // Calculate Staff Breakdown (sales per employee)
  // ============================================================
  const staffMap = new Map<
    string,
    {
      staffId: string
      name: string
      sales: number
      tips: number
      ordersCount: number
      paymentsCount: number
    }
  >()

  // Process payments to get sales and tips per staff
  for (const payment of shift.payments) {
    const staffId = payment.processedById
    if (!staffId) continue

    const staffName = payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : 'Sin asignar'
    const amount = Number(payment.amount || 0)
    const tipAmount = Number(payment.tipAmount || 0)

    if (staffMap.has(staffId)) {
      const existing = staffMap.get(staffId)!
      existing.sales += amount
      existing.tips += tipAmount
      existing.paymentsCount += 1
    } else {
      staffMap.set(staffId, {
        staffId,
        name: staffName,
        sales: amount,
        tips: tipAmount,
        ordersCount: 0,
        paymentsCount: 1,
      })
    }
  }

  // Process orders to get order count per staff
  for (const order of shift.orders) {
    const staffId = order.servedById
    if (!staffId) continue

    const staffName = order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : 'Sin asignar'

    if (staffMap.has(staffId)) {
      const existing = staffMap.get(staffId)!
      existing.ordersCount += 1
    } else {
      staffMap.set(staffId, {
        staffId,
        name: staffName,
        sales: 0,
        tips: 0,
        ordersCount: 1,
        paymentsCount: 0,
      })
    }
  }

  const staffBreakdown = Array.from(staffMap.values())
    .map(staff => ({
      ...staff,
      sales: Number(staff.sales.toFixed(2)),
      tips: Number(staff.tips.toFixed(2)),
      tipPercentage: staff.sales > 0 ? Number(((staff.tips / staff.sales) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.sales - a.sales)

  // ============================================================
  // Calculate Top Products
  // ============================================================
  const productMap = new Map<string, { name: string; quantity: number; revenue: number }>()

  for (const order of shift.orders) {
    for (const item of order.items) {
      const productName = item.product?.name || 'Unknown Product'
      const quantity = item.quantity || 1
      // Revenue is net of the line's own discount — charging it at list price
      // overstated every shift that sold a combo or a discounted item.
      const revenue = lineRevenue(item)

      if (productMap.has(productName)) {
        const existing = productMap.get(productName)!
        existing.quantity += quantity
        existing.revenue += revenue
      } else {
        productMap.set(productName, {
          name: productName,
          quantity,
          revenue,
        })
      }
    }
  }

  const topProducts = Array.from(productMap.values())
    .map(product => ({
      ...product,
      revenue: Number(product.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 20) // Top 20 products

  // ============================================================
  // Format orders for response (with payment method info)
  // ============================================================
  const formattedOrders = shift.orders.slice(0, 50).map(order => {
    const orderPayment = order.payments[0] // Get first payment for display
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      total: Number(order.total || 0),
      subtotal: Number(order.subtotal || 0),
      tableName: order.table?.number ? `${order.table.number}` : null,
      staffName: order.servedBy ? `${order.servedBy.firstName} ${order.servedBy.lastName}` : null,
      staffId: order.servedById,
      paymentMethod: orderPayment?.method || null,
      cardBrand: orderPayment?.cardBrand || null,
      cardLast4: orderPayment?.maskedPan ? orderPayment.maskedPan.slice(-4) : null,
      createdAt: order.createdAt,
      itemsCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      items: order.items.map(item => ({
        name: item.product?.name || 'Unknown Product',
        quantity: item.quantity,
        price: Number(item.unitPrice || 0),
      })),
    }
  })

  // ============================================================
  // Format payments for response
  // ============================================================
  const formattedPayments = shift.payments.map(payment => ({
    id: payment.id,
    amount: Number(payment.amount || 0),
    tipAmount: Number(payment.tipAmount || 0),
    total: Number(payment.amount || 0) + Number(payment.tipAmount || 0),
    method: payment.method,
    cardBrand: payment.cardBrand || (payment.processorData as any)?.cardBrand || null,
    cardLast4: payment.maskedPan ? payment.maskedPan.slice(-4) : null,
    staffName: payment.processedBy ? `${payment.processedBy.firstName} ${payment.processedBy.lastName}` : null,
    staffId: payment.processedById,
    orderId: payment.orderId,
    createdAt: payment.createdAt,
  }))

  // Use calculated totals if they're more accurate than stored values
  const finalTotalSales = calculatedTotalSales > 0 ? calculatedTotalSales : Number(shift.totalSales)
  const finalTotalTips = calculatedTotalTips > 0 ? calculatedTotalTips : Number(shift.totalTips)

  // P2 (Codex 27-ago): el campo es ADITIVO — si su consulta truena, el endpoint viejo no puede volverse un 500.
  let cashDrawer: Awaited<ReturnType<typeof resolveShiftCashDrawer>> = null
  try {
    // `shiftId` acota al turno: sin él, el detalle puede PINTAR la gaveta de otro turno junto a un
    // `cashDifference` que se firmó contra la propia — dos números para el mismo dinero.
    cashDrawer = await resolveShiftCashDrawer(
      venueId,
      (shift as any).startTime ?? null,
      (shift as any).endTime ?? null,
      incluirEsperado,
      shiftId,
    )
  } catch (err) {
    logger.warn('[CASH-DRAWER] No se pudo adjuntar el arqueo del cajón al detalle del turno', {
      shiftId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    id: shift.id,
    venueId: shift.venueId,
    staffId: shift.staffId,
    turnId: (shift as any).turnId,
    startTime: shift.startTime,
    endTime: shift.endTime,
    startingCash: Number(shift.startingCash),
    ...serializeShiftCashReconciliation(shift),
    totalSales: finalTotalSales,
    totalTips: finalTotalTips,
    totalOrders: shift.orders.length,
    status: effectiveStatus,
    staff: shift.staff,
    venue: shift.venue,
    createdAt: (shift as any).createdAt,
    updatedAt: (shift as any).updatedAt,
    // Fase 5 de la unificación de caja: el arqueo del cajón que cubrió el turno (aditivo, puede ser null)
    cashDrawer,
    // NEW: Detailed breakdowns
    payments: formattedPayments,
    orders: formattedOrders,
    paymentMethodBreakdown,
    cardBrandBreakdown,
    staffBreakdown,
    topProducts,
    // Summary stats
    stats: {
      totalPayments: shift.payments.length,
      totalOrders: shift.orders.length,
      totalProducts: topProducts.reduce((sum, p) => sum + p.quantity, 0),
      avgOrderValue: shift.orders.length > 0 ? Number((finalTotalSales / shift.orders.length).toFixed(2)) : 0,
      avgTipPercentage: finalTotalSales > 0 ? Number(((finalTotalTips / finalTotalSales) * 100).toFixed(1)) : 0,
    },
  }
}

export async function getShiftsSummary(venueId: string, filters: ShiftFilters = {}): Promise<ShiftSummaryResponse> {
  const { staffId, startTime, endTime } = filters

  const whereClause: any = {
    venueId: venueId,
  }

  if (startTime || endTime) {
    whereClause.startTime = {}

    if (startTime) {
      const parsedStartTime = new Date(startTime)
      if (!isNaN(parsedStartTime.getTime())) {
        whereClause.startTime.gte = parsedStartTime
      } else {
        throw new BadRequestError(`Invalid startTime: ${startTime}`)
      }
    }

    if (endTime) {
      const parsedEndTime = new Date(endTime)
      if (!isNaN(parsedEndTime.getTime())) {
        whereClause.startTime.lte = parsedEndTime
      } else {
        throw new BadRequestError(`Invalid endTime: ${endTime}`)
      }
    }

    if (Object.keys(whereClause.startTime).length === 0) {
      delete whereClause.startTime
    }
  }

  if (staffId) {
    whereClause.staffId = staffId
  }

  const shifts = await prisma.shift.findMany({
    where: whereClause,
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

  let totalSales = 0
  let totalTips = 0
  let totalOrders = 0

  const staffTipsMap: Map<string, { name: string; amount: number; count: number }> = new Map()

  for (const shift of shifts) {
    totalSales += Number(shift.totalSales)
    totalTips += Number(shift.totalTips)
    totalOrders += shift.totalOrders

    const staffId = shift.staffId
    const staffName = shift.staff ? `${shift.staff.firstName} ${shift.staff.lastName}` : 'Unknown'
    const tipAmount = Number(shift.totalTips)

    if (staffId && tipAmount > 0) {
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

  let totalRatings = 0
  try {
    const reviewWhereClause: any = {
      venueId,
    }

    if (startTime || endTime) {
      reviewWhereClause.createdAt = {}

      if (startTime) {
        reviewWhereClause.createdAt.gte = new Date(startTime)
      }
      if (endTime) {
        reviewWhereClause.createdAt.lte = new Date(endTime)
      }
    }

    totalRatings = await prisma.review.count({
      where: reviewWhereClause,
    })
  } catch (error) {
    logger.warn('Error counting reviews:', error)
  }

  const averageTipPercentage = totalSales > 0 ? (totalTips / totalSales) * 100 : 0

  const waiterTips = Array.from(staffTipsMap.entries())
    .map(([id, data]) => ({
      staffId: id,
      name: data.name,
      amount: data.amount,
      count: data.count,
    }))
    .sort((a, b) => b.amount - a.amount)

  return {
    dateRange: {
      startTime: startTime ? new Date(startTime) : null,
      endTime: endTime ? new Date(endTime) : null,
    },
    summary: {
      totalSales: totalSales,
      totalTips: totalTips,
      ordersCount: totalOrders,
      averageTipPercentage: Number(averageTipPercentage.toFixed(2)),
      ratingsCount: totalRatings,
    },
    waiterTips: waiterTips,
  }
}

/**
 * Delete a shift by ID
 * @param venueId Venue ID
 * @param shiftId Shift ID to delete
 * @param performedBy Staff ID del actor — QUIÉN borró el corte (ver el asiento de abajo)
 * @returns boolean indicating if shift was deleted
 */
export async function deleteShift(venueId: string, shiftId: string, performedBy?: string): Promise<boolean> {
  try {
    logger.info('Deleting shift', { venueId, shiftId })

    // First check if shift exists and belongs to the venue
    const existingShift = await prisma.shift.findFirst({
      where: {
        id: shiftId,
        venueId: venueId,
      },
    })

    if (!existingShift) {
      logger.warn('Shift not found for deletion', { venueId, shiftId })
      return false
    }

    // 🔴 CLOSING se juzga por el estado CRUDO, nunca por el "efectivo" de abajo. Esa derivación
    // por reloj declara CLOSED cualquier turno cuyo `endTime` ya pasó — y el cierre ESCRIBE `endTime`
    // mientras trabaja, así que un turno en pleno cierre se vería como cerrado y la guarda no
    // dispararía. `CLOSING` es el compare-and-set del cierre (`shift.tpv.service.ts`): significa que
    // alguien está contando el efectivo AHORA. Borrar ahí deja al cierre sin fila que actualizar,
    // falla a medias, y suelta las órdenes, pagos, comisiones y la gaveta.
    // P1.4 de la auditoría de Codex (3-sep-2026).
    if (existingShift.status === 'CLOSING') {
      logger.warn('Cannot delete a shift that is being closed', { venueId, shiftId })
      throw new BadRequestError('No se puede borrar un turno que se está cerrando. Espera a que el cierre termine.')
    }

    // Check if shift is still open using time-based logic
    const now = new Date()
    const effectiveStatus = existingShift.endTime && existingShift.endTime < now ? 'CLOSED' : existingShift.status

    if (effectiveStatus === 'OPEN') {
      logger.warn('Cannot delete open shift', { venueId, shiftId, status: existingShift.status, effectiveStatus })
      throw new BadRequestError('Cannot delete an open shift. Please close the shift first.')
    }

    // Delete the shift
    await prisma.shift.delete({
      where: {
        id: shiftId,
      },
    })

    logger.info('Shift deleted successfully', { venueId, shiftId })

    // 🔴 QUIÉN y QUÉ. El borrado es DURO: la fila se va, y las órdenes, pagos, comisiones y la
    // sesión de gaveta que apuntaban al turno quedan SUELTAS (`onDelete: SetNull`) en vez de irse
    // con él. O sea que el dinero sobrevive y el corte que lo firmó no: este asiento es la única
    // constancia que queda. Sin autor decía que un turno dejó de existir y no quién lo decidió,
    // mientras `SHIFT_UPDATED` —que toca el MISMO descuadre— sí lo registra.
    const pesos = (value: unknown) => (value == null ? null : Number(value).toFixed(2))
    logAction({
      venueId,
      action: 'SHIFT_DELETED',
      entity: 'Shift',
      entityId: shiftId,
      staffId: performedBy,
      data: {
        // Acotado al corte firmado, en pesos y como texto (mismo vocabulario que `SHIFT_UPDATED`).
        // Un NULL se conserva NULL: un cierre sin conteo no tuvo un 0.00 — no tuvo conteo, y
        // volcarlo como cero afirmaría que alguien contó y cuadró.
        status: existingShift.status,
        startTime: existingShift.startTime,
        endTime: existingShift.endTime,
        startingCash: pesos(existingShift.startingCash),
        cashDeclared: pesos(existingShift.cashDeclared),
        cashDifference: pesos(existingShift.cashDifference),
        totalSales: pesos(existingShift.totalSales),
        totalTips: pesos(existingShift.totalTips),
        totalOrders: existingShift.totalOrders,
      },
    })

    return true
  } catch (error) {
    logger.error('Error deleting shift', { venueId, shiftId, error })
    throw error
  }
}

/**
 * Update shift data interface
 */
export interface UpdateShiftData {
  startingCash?: number
  endingCash?: number | null
  totalSales?: number
  totalTips?: number
  totalOrders?: number
  staffId?: string

  /**
   * 🔴 EL CICLO DE VIDA NO SE EDITA DESDE AQUÍ — y por eso siguen declarados: para que
   * `rechazarCambioDeCicloDeVida` pueda mirarlos con tipos y no con `any`. Escribir cualquiera
   * de los tres produce un par incoherente que el resto del sistema no sabe leer:
   *
   *   · `status='OPEN'` con `endTime` puesto ⇒ nadie lo ve (las tres lecturas del turno vivo
   *     exigen `endTime: null`) pero el único parcial `Shift(venueId) WHERE status='OPEN'` sí:
   *     abrir turno o caja da **409 `CASH_SHIFT_ALREADY_OPEN` para siempre**, y `claimShiftForClose`
   *     tampoco lo cierra. Sólo lo destraba un UPDATE a mano en Postgres.
   *   · `endTime: null` sobre un turno cerrado lo hace pasar por abierto ante la PAX mientras
   *     `turnoAbiertoDelNegocio` sigue devolviendo `null` ⇒ el día entero cobra sin turno.
   *   · `startTime` mueve la ventana con la que se resuelven la gaveta y los cobros huérfanos
   *     del turno: cambia el descuadre YA firmado sin tocar un solo cobro.
   *
   * El turno se abre y se cierra por su propio carril (`shared/turnoDeCaja.ts`), que es el único
   * que sostiene el candado de «uno abierto por negocio».
   */
  status?: never
  endTime?: never
  startTime?: never
}

/** Los tres campos de arriba, con el porqué que se le devuelve a quien los mande. */
const CAMPOS_DE_CICLO_DE_VIDA: ReadonlyArray<[string, string]> = [
  ['status', 'No se puede cambiar el estado del turno desde aquí: ciérralo o ábrelo desde la caja'],
  ['endTime', 'No se puede cambiar la hora de cierre del turno desde aquí'],
  ['startTime', 'No se puede cambiar la hora de apertura del turno desde aquí'],
]

/**
 * 🔴 La REGLA, no la forma. Zod ya acota el cuerpo en la ruta (`schemas/dashboard/shift.schema.ts`),
 * pero a un servicio se le llama sin pasar por Express —scripts, otro servicio, una ruta futura—,
 * y este defecto deja al negocio sin poder abrir caja. Se comprueba ANTES de resolver la gaveta,
 * de escribir y de auditar: nada se toca.
 */
function rechazarCambioDeCicloDeVida(data: UpdateShiftData): void {
  const cuerpo = data as Record<string, unknown>
  for (const [campo, mensaje] of CAMPOS_DE_CICLO_DE_VIDA) {
    // `in`, no truthiness ni `!== undefined`: `{"endTime": null}` es exactamente la variante que
    // deja el día entero sin turno, y es la que un `!= null` dejaría pasar.
    if (campo in cuerpo && cuerpo[campo] !== undefined) throw new BadRequestError(mensaje)
  }
}

/**
 * Cash over/short for a shift: what was counted minus what should be in the drawer.
 *
 * 🔴 This used to be `endingCash - startingCash`, which is not a cash difference at all —
 * it is the net change in the drawer. A shift that sold $5,000 in cash and balanced to the
 * peso reported "+$5,000 over". The number on the shift-difference report was noise, not
 * control, and it read as a huge surplus on every shift that sold anything.
 *
 * A cash difference is COUNTED − EXPECTED, where expected is the float plus the cash the
 * system recorded as taken in:
 *
 *     expected   = startingCash + cashSales
 *     difference = counted − expected        (negative = short, positive = over)
 *
 * KNOWN LIMITATION, stated rather than hidden: pay-ins and pay-outs are not part of
 * `expected`, because `CashDrawerSession` is not linked to `Shift` — it hangs off venue +
 * staff, so drawer events cannot be attributed to a shift without guessing by time overlap,
 * and guessing here mis-attributes real money. A venue that takes cash out mid-shift will
 * therefore show a shortfall equal to what it took out. That is still strictly better than
 * the old formula, and it is wrong in the direction that makes someone look, not the
 * direction that hides a hole.
 *
 * Returns `null` when nobody counted the drawer. A fabricated 0 would read as "balanced",
 * which is the one answer we must never invent.
 */
/** Cómo debe pintarse el método, para que la UI no adivine con "todo lo que no es efectivo". */
export type PaymentMethodKind = 'CASH' | 'CARD' | 'OTHER'

const METHOD_KIND: Record<string, PaymentMethodKind> = {
  CASH: 'CASH',
  CREDIT_CARD: 'CARD',
  DEBIT_CARD: 'CARD',
}

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Efectivo',
  CREDIT_CARD: 'Tarjeta de crédito',
  DEBIT_CARD: 'Tarjeta de débito',
  DIGITAL_WALLET: 'Monedero digital',
  BANK_TRANSFER: 'Transferencia',
  CRYPTOCURRENCY: 'Cripto',
  OTHER: 'Otro',
}

export interface PaymentMethodBreakdownRow {
  /** El método REAL (`CREDIT_CARD`, `DEBIT_CARD`…), no la cubeta vieja 'CASH'|'CARD'. */
  method: string
  kind: PaymentMethodKind
  /** Español, listo para pintar — evita que cada cliente invente su propia traducción. */
  label: string
  total: number
  tips: number
  count: number
  percentage: number
  /**
   * Desglose por NOMBRE del tipo de pago dentro de este método — el "expande Otros"
   * de Square. Sólo aparece cuando hay más de una etiqueta bajo el mismo método
   * (típicamente `OTHER`: "Uber Eats", "Terminal BBVA", "Vale de despensa").
   *
   * ADITIVO: las filas de arriba no cambian, así que el dashboard, el MCP
   * (`src/mcp/tools/shifts.ts`) y el corte del TPV siguen leyendo lo mismo.
   * Para pagos viejos sin tender cae a `externalSource`, que era la única pista
   * que existía antes del catálogo.
   */
  children?: Array<{ label: string; total: number; tips: number; count: number }>
}

/**
 * Desglose del corte por método de pago REAL + marcas de tarjeta.
 *
 * Antes agrupaba con `payment.method === 'CASH' ? 'CASH' : 'CARD'`, así que el dueño no veía
 * débito contra crédito aunque la base ya lo guardaba por separado, y una transferencia se
 * pintaba como tarjeta.
 *
 * 🔴 Por qué esto es una función aparte y con tests: el cambio "obvio" de una línea NO era
 * seguro. El denominador de los porcentajes por marca era `paymentMethodMap.get('CARD')`; al
 * desaparecer esa llave el denominador caía a 1 y una venta VISA de $1,000 se pintaba como
 * **100000%**. Aquí el denominador es la suma de los pagos con tarjeta de verdad.
 *
 * Además, las marcas se recogen SÓLO de pagos con tarjeta: antes cualquier pago que no fuera
 * efectivo entraba al mapa de marcas, así que una transferencia inventaba una marca "OTHER".
 */
export function buildPaymentBreakdown(
  payments: Array<{
    amount: unknown
    tipAmount: unknown
    method: string
    cardBrand?: string | null
    processorData?: unknown
    tenderLabel?: string | null
    externalSource?: string | null
  }>,
): {
  paymentMethodBreakdown: PaymentMethodBreakdownRow[]
  cardBrandBreakdown: Array<{ brand: string; total: number; count: number; percentage: number }>
  totalSales: number
  totalTips: number
} {
  const methodMap = new Map<string, { total: number; tips: number; count: number }>()
  // método → etiqueta → totales. La etiqueta viene del snapshot del tender (congelado
  // al cobrar) y, para lo histórico, del `externalSource` de texto libre.
  const labelMap = new Map<string, Map<string, { total: number; tips: number; count: number }>>()
  const cardBrandMap = new Map<string, { total: number; count: number }>()
  let totalSales = 0
  let totalTips = 0
  let cardTotal = 0

  for (const payment of payments) {
    const amount = Number(payment.amount || 0)
    const tipAmount = Number(payment.tipAmount || 0)
    totalSales += amount
    totalTips += tipAmount

    const method = payment.method || 'OTHER'
    const kind = METHOD_KIND[method] ?? 'OTHER'

    const existing = methodMap.get(method)
    if (existing) {
      existing.total += amount
      existing.tips += tipAmount
      existing.count += 1
    } else {
      methodMap.set(method, { total: amount, tips: tipAmount, count: 1 })
    }

    const tenderLabel = payment.tenderLabel || payment.externalSource
    if (tenderLabel) {
      const byLabel = labelMap.get(method) ?? new Map()
      const le = byLabel.get(tenderLabel)
      if (le) {
        le.total += amount
        le.tips += tipAmount
        le.count += 1
      } else {
        byLabel.set(tenderLabel, { total: amount, tips: tipAmount, count: 1 })
      }
      labelMap.set(method, byLabel)
    }

    // Marcas: SÓLO de pagos con tarjeta real.
    if (kind === 'CARD') {
      cardTotal += amount
      const processorData = payment.processorData as any
      const brand = payment.cardBrand || processorData?.cardBrand || processorData?.card_brand || 'OTHER'
      const normalizedBrand = String(brand).toUpperCase()
      const brandEntry = cardBrandMap.get(normalizedBrand)
      if (brandEntry) {
        brandEntry.total += amount
        brandEntry.count += 1
      } else {
        cardBrandMap.set(normalizedBrand, { total: amount, count: 1 })
      }
    }
  }

  const salesDenominator = totalSales || 1
  const cardDenominator = cardTotal || 1

  return {
    paymentMethodBreakdown: Array.from(methodMap.entries())
      .map(([method, data]) => ({
        method,
        kind: METHOD_KIND[method] ?? 'OTHER',
        label: METHOD_LABEL[method] ?? method,
        total: Number(data.total.toFixed(2)),
        tips: Number(data.tips.toFixed(2)),
        count: data.count,
        percentage: Number(((data.total / salesDenominator) * 100).toFixed(1)),
        ...(labelMap.has(method)
          ? {
              children: Array.from(labelMap.get(method)!.entries())
                .map(([label, d]) => ({
                  label,
                  total: Number(d.total.toFixed(2)),
                  tips: Number(d.tips.toFixed(2)),
                  count: d.count,
                }))
                .sort((a, b) => b.total - a.total),
            }
          : {}),
      }))
      .sort((a, b) => b.total - a.total),
    cardBrandBreakdown: Array.from(cardBrandMap.entries())
      .map(([brand, data]) => ({
        brand,
        total: Number(data.total.toFixed(2)),
        count: data.count,
        percentage: Number(((data.total / cardDenominator) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.total - a.total),
    totalSales,
    totalTips,
  }
}

export function computeCashDifference(input: {
  countedCash: number | null
  startingCash: number
  /**
   * Lo que ENTRÓ AL CAJÓN por el turno: ventas en efectivo **más la propina cobrada en
   * efectivo**. NO es la cifra de ventas — el billete de propina también está físicamente
   * adentro, así que excluirlo reportaba un sobrante falso del tamaño de las propinas.
   */
  cashInDrawer: number
  /**
   * El esperado de la GAVETA cuando hay una (Task 5): fondo + cada venta + cada ingreso −
   * cada retiro. Cuando viene, MANDA sobre `startingCash + cashInDrawer`, que es ciega a los
   * retiros y al refondeo a media jornada. Sin gaveta se omite y la fórmula del turno queda
   * byte a byte.
   */
  expectedCash?: number | null
}): number | null {
  if (input.countedCash === null || input.countedCash === undefined) return null
  // 🔴 `!= null` y NUNCA una comprobación por verdad/falsedad: un esperado de CERO (la gaveta
  // que se vació entera) es un esperado, y `if (expectedCash)` lo leería como "no hay gaveta"
  // devolviendo el descuadre ciego. Es el mismo motivo por el que el cierre usa `??` y no `||`.
  const { difference } =
    input.expectedCash != null
      ? calculateCashReconciliationFromExpected(input.countedCash, input.expectedCash)
      : calculateCashReconciliation(input.countedCash, input.startingCash, input.cashInDrawer)
  const rounded = difference.toDecimalPlaces(2).toNumber()
  return Object.is(rounded, -0) ? 0 : rounded
}

/** De dónde salió el esperado con el que se firmó un descuadre. Mismo vocabulario que el cierre. */
export type FuenteDelEsperado = 'CAJON' | 'TURNO' | 'DESCONOCIDO'

export interface EsperadoDelTurno {
  /** El esperado de la gaveta, o `null` cuando manda la fórmula del turno. */
  esperado: number | null
  sessionId: string | null
  fuente: FuenteDelEsperado
}

/**
 * El esperado de la gaveta que cubrió un turno YA CERRADO.
 *
 * 🔴 No es `esperadoDelCajonAbierto`: aquélla sólo mira cajas `OPEN`, porque el cierre corre
 * con el cajero enfrente. Aquí el turno ya se cerró y su gaveta también, así que hay que
 * resolverla como la resuelve el dashboard:
 *
 *   1. **la LIGADA** por `CashDrawerSession.shiftId` (`@unique`, columna de esta fase). Es
 *      exacta y no depende de ninguna fecha, así que corregir la hora de cierre no puede
 *      cambiar de gaveta.
 *   2. **por ventana de tiempo** (`resolveShiftCashDrawer`) para todo lo anterior a la
 *      migración, que no tiene liga y no puede tenerla — es lo que dice el propio comentario
 *      de la columna en el schema.
 *
 * `fuente` existe para no tener que adivinar por verdad/falsedad: `TURNO` es "no hay gaveta y
 * manda la fórmula de siempre"; `DESCONOCIDO` es "no se pudo leer", y ahí el descuadre
 * guardado NO se toca — degradar en silencio a la fórmula ciega sería reescribir un número
 * bueno con uno malo, que es justo el defecto que esto viene a cerrar.
 */
export async function esperadoDeLaGavetaDelTurno(
  venueId: string,
  shift: { id: string; startTime: Date | null; endTime: Date | null },
  // ¿el llamante tiene `cash-drawer:view-expected`? Con una gaveta todavía ABIERTA y sin ese
  // permiso NO se resuelve el esperado, y el resultado es `DESCONOCIDO` — nunca la fórmula
  // ciega. Caer a ella sería reintroducir el defecto justo para quien no puede ver el número, y
  // escribirlo sería servir el esperado de una caja abierta por la puerta de atrás: la respuesta
  // devuelve `cashDifference`, así que un `PUT {"endingCash":0}` daría `−esperado` de vuelta.
  puedeVerEsperado: boolean,
): Promise<EsperadoDelTurno> {
  try {
    const cashDrawer = await resolveShiftCashDrawer(venueId, shift.startTime, shift.endTime, puedeVerEsperado, shift.id)
    if (!cashDrawer) return { esperado: null, sessionId: null, fuente: 'TURNO' }
    const esperado = 'expectedAmount' in cashDrawer ? cashDrawer.expectedAmount : null
    // Hay gaveta, pero su esperado viene oculto por el conteo ciego: se sabe que la fórmula del
    // turno NO es la autoridad, así que tampoco se usa.
    if (typeof esperado !== 'number') return { esperado: null, sessionId: cashDrawer.sessionId, fuente: 'DESCONOCIDO' }
    return { esperado, sessionId: cashDrawer.sessionId, fuente: 'CAJON' }
  } catch (error) {
    logger.warn('[Shift Update] No se pudo resolver la gaveta del turno; el descuadre guardado no se toca', {
      venueId,
      shiftId: shift.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { esperado: null, sessionId: null, fuente: 'DESCONOCIDO' }
  }
}

/**
 * Update a shift by ID (MANAGER para arriba — ver el comentario de la ruta en dashboard.routes.ts)
 * @param venueId Venue ID
 * @param shiftId Shift ID to update
 * @param data Update data
 * @returns Updated shift
 */
export async function updateShift(
  venueId: string,
  shiftId: string,
  data: UpdateShiftData,
  contexto: { performedBy?: string; puedeVerEsperado?: boolean } = {},
): Promise<any> {
  const { performedBy, puedeVerEsperado = false } = contexto
  logger.info('Updating shift', { venueId, shiftId, fields: Object.keys(data) })

  // ANTES de cualquier lectura: corregir un turno no es cambiarle el ciclo de vida.
  rechazarCambioDeCicloDeVida(data)

  // First check if shift exists and belongs to the venue
  const existingShift = await prisma.shift.findFirst({
    where: {
      id: shiftId,
      venueId: venueId,
    },
  })

  if (!existingShift) {
    logger.warn('Shift not found for update', { venueId, shiftId })
    return null
  }

  // `updatedAt` es el cutoff durable del claim OPEN → CLOSING: el cierre final y el watchdog lo
  // usan como testigo del mismo CAS. El editor debe detenerse ANTES de resolver gaveta, escribir
  // dinero o auditar; moverlo ampliaría la membresía del reporte mientras el cierre ya calculó su
  // snapshot con el instante anterior.
  if (existingShift.status === 'CLOSING') {
    throw new ConflictError('El cierre de turno ya está en proceso. Intenta de nuevo en unos momentos.', 'SHIFT_CLOSE_IN_PROGRESS')
  }

  // Build update data object, only including provided fields
  const updateData: any = {}

  if (data.startingCash !== undefined) {
    updateData.startingCash = data.startingCash
  }
  if (data.endingCash !== undefined) {
    const normalizedCashCount = data.endingCash === null ? null : Number(data.endingCash)
    updateData.endingCash = normalizedCashCount
    updateData.cashDeclared = normalizedCashCount
  }
  if (data.totalSales !== undefined) {
    updateData.totalSales = data.totalSales
  }
  if (data.totalTips !== undefined) {
    updateData.totalTips = data.totalTips
  }
  if (data.totalOrders !== undefined) {
    updateData.totalOrders = data.totalOrders
  }
  if (data.staffId !== undefined) {
    // 🔴 AISLAMIENTO POR TENANT (P2.3). La FK de `Shift.staffId` sólo exige que el `Staff` exista,
    // así que sin esta comprobación un MANAGER del venue A podía reasignarle la autoría de un
    // corte a un empleado del venue B. Se pregunta por el venue DE LA RUTA, que es el que el
    // permiso ya autorizó — no por el del turno.
    const perteneceAlNegocio = await prisma.staffVenue.findFirst({
      where: { staffId: data.staffId, venueId },
      select: { id: true },
    })
    if (!perteneceAlNegocio) {
      throw new BadRequestError('Ese empleado no pertenece a este negocio')
    }
    updateData.staffId = data.staffId
  }

  // 🔴 EL ESPERADO SALE DE LA GAVETA, igual que el del cierre (Task 5). Sin esto, editar un turno
  // desde el dashboard —aunque sólo se corrija `totalSales`, que es lo único que la pantalla manda
  // hoy— reescribía el descuadre con la fórmula CIEGA: el 0.00 que el cierre firmó contra la
  // gaveta volvía a firmarse en −2,500.00, con el dueño como autor de un faltante que nadie tuvo.
  //
  // La ventana es la GUARDADA, nunca la del cuerpo: qué gaveta operó es un hecho histórico, y
  // resolverla contra una fecha que alguien está editando en este mismo request podría cambiar de
  // gaveta y con ella el número firmado.
  // 🔴 `Number(...)` sobre lo que llegó en el cuerpo, y no es paranoia: la ruta ya lleva
  // `validateRequest(UpdateShiftSchema)` desde el 4-sep-2026, pero a este SERVICIO se le llama sin
  // pasar por Express (scripts, otros servicios), así que un `startingCash: "500"` sigue pudiendo
  // entrar tal cual. Prisma lo acepta (string → Decimal), pero en JS `"500" + 1800` es la
  // CONCATENACIÓN `"5001800"` y el `.toFixed` de la bitácora reventaría con el `update` YA
  // commiteado: un 500 sobre una edición que sí se guardó, y sin fila de auditoría.
  const effectiveStartingCash = data.startingCash !== undefined ? Number(data.startingCash) : Number(existingShift.startingCash)

  // 🔴 EL CONTEO ES `cashDeclared`, NUNCA `endingCash`. `endingCash` no es lo que alguien contó:
  // en un cierre sin conteo es el total del cajón, y en uno legacy vale `startingCash + declarado`
  // — o sea que tomarlo por conteo cuenta el fondo DOS veces y firma un sobrante fantasma del
  // tamaño del fondo. Medido contra la base local: dos cortes de Desktop con `cashDifference` en
  // NULL recibían +500.00 al editarlos, que era exactamente su fondo.
  //
  // Un `endingCash` en el cuerpo SÍ manda: ahí el dueño está corrigiendo el conteo con la hoja
  // enfrente, y entre dos conteos gana el más nuevo.
  const countedCash =
    data.endingCash !== undefined
      ? data.endingCash === null
        ? null
        : Number(data.endingCash)
      : existingShift.cashDeclared == null
        ? null
        : Number(existingShift.cashDeclared)

  // Ventas en efectivo + propina en efectivo: lo que hay físicamente en el cajón. Sólo alimenta
  // la fórmula del turno, que es el respaldo para el venue sin módulo de caja.
  const cashInDrawer = Number(existingShift.totalCashPayments ?? 0) + Number(existingShift.totalCashTips ?? 0)

  // 🔴 EL ESPERADO SALE DE LA GAVETA, igual que el del cierre (Task 5). Sin esto, editar un turno
  // desde el dashboard —aunque sólo se corrija `totalSales`, que es lo único que la pantalla manda
  // hoy— reescribía el descuadre con la fórmula CIEGA: el 0.00 que el cierre firmó contra la
  // gaveta volvía a firmarse en −2,500.00, con el dueño como autor de un faltante que nadie tuvo.
  //
  // Sin conteo NO se consulta: la mayoría de los turnos cerrados no tienen uno, y ahí resolver la
  // gaveta son hasta 3 consultas con una carga de eventos sin tope para no escribir nada.
  //
  // La ventana es la GUARDADA, nunca la del cuerpo: qué gaveta operó es un hecho histórico, y
  // resolverla contra una fecha que alguien está editando en este mismo request podría cambiar de
  // gaveta y con ella el número firmado.
  const gaveta =
    countedCash == null
      ? null
      : await esperadoDeLaGavetaDelTurno(
          venueId,
          { id: existingShift.id, startTime: existingShift.startTime, endTime: existingShift.endTime },
          puedeVerEsperado,
        )

  const expectedCash = gaveta == null || gaveta.fuente === 'DESCONOCIDO' ? null : (gaveta.esperado ?? effectiveStartingCash + cashInDrawer)

  const difference =
    gaveta == null || gaveta.fuente === 'DESCONOCIDO'
      ? null
      : computeCashDifference({
          countedCash,
          startingCash: effectiveStartingCash,
          cashInDrawer,
          expectedCash: gaveta.esperado,
        })
  if (data.endingCash === null) {
    updateData.cashDifference = null
  } else if (difference !== null) {
    updateData.cashDifference = difference
  }

  // El chequeo temprano evita trabajo inútil, pero no basta: el cierre puede reclamar el turno
  // entre esa lectura y esta escritura. `updatedAt` + estado + `endTime` son el snapshot observado;
  // sólo quien todavía lo ve idéntico puede editarlo. Así el claim conserva exactamente su cutoff.
  const updatedShift = await prisma.$transaction(async tx => {
    await lockShiftLifecycleForVenue(tx, venueId)
    const wonUpdate = await tx.shift.updateMany({
      where: {
        id: shiftId,
        venueId,
        status: existingShift.status,
        endTime: existingShift.endTime,
        updatedAt: existingShift.updatedAt,
      },
      data: updateData,
    })

    if (wonUpdate.count !== 1) {
      throw new ConflictError('El turno cambió mientras se estaba editando. Actualiza e intenta de nuevo.', 'SHIFT_CONCURRENT_UPDATE')
    }

    // `updateMany` es necesario para el CAS y no hidrata relaciones. Se relee únicamente DESPUÉS
    // de ganar, todavía bajo la autoridad del lifecycle; si desaparece tampoco se audita.
    const saved = await tx.shift.findFirst({
      where: {
        id: shiftId,
        venueId,
      },
      include: {
        staff: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    if (!saved) {
      throw new ConflictError('El turno cambió mientras se estaba editando. Actualiza e intenta de nuevo.', 'SHIFT_CONCURRENT_UPDATE')
    }
    return saved
  })

  // Determine effective status based on time logic
  const now = new Date()
  const effectiveStatus = updatedShift.endTime && updatedShift.endTime < now ? 'CLOSED' : updatedShift.status

  logger.info('Shift updated successfully', { venueId, shiftId })

  // 🔴 En PESOS y con la AUTORIDAD del esperado a la vista: el dashboard renderiza este jsonb tal
  // cual al dueño, y dos ediciones del mismo turno con números distintos son indistinguibles si no
  // dice de dónde salió cada uno. Mismo vocabulario que la bitácora del cierre (`SHIFT_CLOSED`).
  const pesos = (value: number) => value.toFixed(2)
  logAction({
    venueId,
    action: 'SHIFT_UPDATED',
    entity: 'Shift',
    entityId: shiftId,
    staffId: performedBy,
    data: {
      // Acotado: Zod descarta lo desconocido en la ruta, pero al servicio se le puede llamar sin
      // pasar por ella. Registrar QUÉ se intentó tocar es útil; copiar mil llaves inventadas a la
      // tabla de auditoría, no.
      fields: Object.keys(data).slice(0, 20),
      ...(gaveta ? { expectedSource: gaveta.fuente } : {}),
      ...(gaveta?.sessionId ? { cashDrawerSessionId: gaveta.sessionId } : {}),
      ...(expectedCash != null ? { expectedCash: pesos(expectedCash) } : {}),
      ...(countedCash != null ? { countedCash: pesos(countedCash) } : {}),
      ...(difference != null ? { cashDifference: pesos(difference) } : {}),
    },
  })

  return {
    id: updatedShift.id,
    venueId: updatedShift.venueId,
    staffId: updatedShift.staffId,
    startTime: updatedShift.startTime,
    endTime: updatedShift.endTime,
    startingCash: Number(updatedShift.startingCash),
    ...serializeShiftCashReconciliation(updatedShift),
    totalSales: Number(updatedShift.totalSales),
    totalTips: Number(updatedShift.totalTips),
    totalOrders: updatedShift.totalOrders,
    status: effectiveStatus,
    staff: updatedShift.staff,
    venue: updatedShift.venue,
  }
}
