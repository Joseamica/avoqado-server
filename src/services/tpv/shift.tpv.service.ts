import { resolveShiftCashDrawer } from '../dashboard/shift.dashboard.service'
import { PaymentFundsFlow, PaymentMethod, PaymentType, Prisma, Shift, ShiftStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, InternalServerError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import socketManager from '../../communication/sockets'
import { paymentCountsAsDrawerCash } from '../shared/tenderSemantics'
import { isCashReconciliationEnabled } from '../access/cashReconciliationAccess.service'
import {
  calculateCashReconciliationFromExpected,
  normalizeCashReconciliationRequest,
  type CashReconciliationOutcome,
  type NormalizedCashReconciliationRequest,
} from '../shared/cashReconciliation.service'
import { SHIFT_CLOSE_STALE_MS } from './shiftCloseClaim.constants'
import { abrirTurnoDeCaja, cerrarTurnoDeCaja, esperadoDelCajonAbierto } from '../shared/turnoDeCaja'
import { asegurarLaLiga } from '../shared/parejaDeCierre'
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
  // 🔴 AGREGA EN LA BASE, no en el hilo de Node (P2.5 de la auditoría del 4-sep-2026). Esto era un
  // `findMany` sin `take` y sin `venueId`, y es el endpoint que la PAX SONDEA cada pocos segundos:
  // antes leía los cobros de una persona y desde la Fase 1 lee los de todo el negocio durante todo
  // el día. `groupBy` devuelve una fila por método —cinco como mucho— con la suma hecha en Postgres,
  // en `Decimal` y por tanto exacta: el mismo número que salía del bucle, sin hidratar nada.
  const porMetodo = await prisma.payment.groupBy({
    by: ['method'],
    where: {
      venueId,
      shiftId: shift.id,
      status: 'COMPLETED',
    },
    _sum: { amount: true, tipAmount: true },
  })

  let totalCashPayments = new Decimal(0)
  let totalCardPayments = new Decimal(0)
  let totalVoucherPayments = new Decimal(0)
  let totalOtherPayments = new Decimal(0)
  let totalSales = new Decimal(0)
  let totalTips = new Decimal(0)

  for (const fila of porMetodo) {
    const amount = new Decimal(fila._sum?.amount ?? 0)
    const tipAmount = new Decimal(fila._sum?.tipAmount ?? 0)

    totalSales = totalSales.add(amount)
    totalTips = totalTips.add(tipAmount)

    // Group by payment method — el MISMO reparto de siempre, incluido el `default` a «otros».
    switch (fila.method) {
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
  }

  // Get order count
  const orderCount = await prisma.order.count({
    where: {
      venueId,
      shiftId: shift.id,
      status: {
        in: ['CONFIRMED', 'COMPLETED'],
      },
    },
  })

  // Get products sold count — misma suma, hecha en la base. Era el segundo `findMany` sin `take`
  // de este endpoint: traía una fila por RENGLÓN vendido en el día sólo para sumarle la cantidad.
  const renglones = await prisma.orderItem.aggregate({
    where: {
      order: {
        venueId,
        shiftId: shift.id,
        status: {
          in: ['CONFIRMED', 'COMPLETED'],
        },
      },
    },
    _sum: { quantity: true },
  })

  const totalProductsSold = renglones._sum?.quantity ?? 0

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

/** Un instante legible, o `null` si el dato falta o no se puede leer. Nunca lanza. */
function instanteDe(valor: unknown): number | null {
  if (valor === null || valor === undefined) return null
  const ms = valor instanceof Date ? valor.getTime() : new Date(valor as string | number).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * ¿Un cobro SIN turno propio pertenece a ESTE turno? Sólo si ocurrió DENTRO de su ventana.
 *
 * 🔴 Gobierna EXCLUSIVAMENTE el respaldo histórico de `getShifts` —los cobros con `shiftId` nulo
 * que cuelgan de una orden del turno (órdenes de pos-sync)—, NUNCA la rama estampada. Un cobro
 * que trae su propio `Payment.shiftId` cuenta sin condiciones: ése lo resolvió el servidor
 * (`shared/turnoDeCaja.ts`) y es la autoridad. Medido el 3-sep-2026 en la base local: 19 cobros
 * con su `shiftId` propio caen fuera de la ventana de ese mismo turno ($6 874.06) — acotarlos
 * borraría dinero bien atribuido, que es peor que el defecto que se está arreglando.
 *
 * Sin este techo, el respaldo aceptaba CUALQUIER cobro sin turno de una orden del turno, incluido
 * uno ocurrido DESPUÉS del cierre: dinero que entra retrospectivamente a un turno ya firmado.
 * Medido: los 8 cobros con esa forma en la base local caen tras el cierre de su turno, entre
 * 1 701 y 3 015 horas después (70–125 días), $4 638.00.
 *
 * Es el mismo patrón que `gavetaCerrable` (`shared/turnoDeCaja.ts:888`): ventana + `OR` sobre el id.
 *
 * 🔴 El techo depende del ESTADO, no sólo de `endTime`: OPEN real queda abierto; CLOSING usa
 * `updatedAt`, que `claimShiftForClose` fija al `claimedAt` del CAS; CLOSED usa `endTime`. Durante
 * CLOSING ese `updatedAt` es además el testigo que exigen el cierre final y el watchdog, por lo que
 * ningún editor/cobro puede moverlo (los writers vecinos llevan CAS/guard de estado).
 *
 * FALLA CERRADO: un estado/cutoff ausente o ilegible nunca adopta un huérfano. Un renglón que se
 * cae de la pantalla se ve y se investiga; dinero que se cuenta en un turno que no lo cobró, no.
 */
export function cobroSinTurnoPerteneceAlTurno(
  cobro: { createdAt?: Date | string | null },
  turno: {
    status?: ShiftStatus | string | null
    startTime?: Date | string | null
    endTime?: Date | string | null
    updatedAt?: Date | string | null
  },
): boolean {
  const ocurrio = instanteDe(cobro?.createdAt)
  const abre = instanteDe(turno?.startTime)
  if (ocurrio === null || abre === null) return false
  if (ocurrio < abre) return false

  if (turno.status === ShiftStatus.OPEN) return turno.endTime === null
  if (turno.status === ShiftStatus.CLOSING) {
    if (turno.endTime !== null) return false
    const claimedAt = instanteDe(turno.updatedAt)
    return claimedAt !== null && ocurrio <= claimedAt
  }
  if (turno.status === ShiftStatus.CLOSED) {
    const cierra = instanteDe(turno.endTime)
    return cierra !== null && ocurrio <= cierra
  }
  return false
}

/**
 * 🔴 TECHO DEL SERVIDOR para la lista de turnos. Nunca se confía en el `pageSize` del cliente
 * (`.claude/rules/bounded-queries-and-server-load.md`). Se RECORTA, no se rechaza: un 400 rompería
 * a una PAX vieja que pidiera de más, y lo que se quiere es acotar el trabajo, no negar la pantalla.
 *
 * 50 y no 100 porque desde la Fase 1 **un turno = un día entero del negocio**: el ledger reporta
 * 128 órdenes y $18,206.75 en UN turno de Testarudo. `meta.pageSize` devuelve el valor ya
 * recortado, así que el cliente ve lo que de verdad se aplicó.
 */
export const TOPE_DE_TURNOS_POR_PAGINA = 50

/** Páginas del barrido de cobros. Mismo tamaño que el cursor del cierre, por la misma razón. */
const COBROS_POR_PAGINA = 500

/** Lo único que la pantalla de Turnos necesita de los cobros: tres números, no la lista. */
interface RollupDelTurno {
  totalSales: Decimal
  totalTips: Decimal
  tipsCount: number
}

const ROLLUP_VACIO = (): RollupDelTurno => ({ totalSales: new Decimal(0), totalTips: new Decimal(0), tipsCount: 0 })

/**
 * La proyección MÍNIMA de un `Payment` con la que se pueden calcular los totales de un turno —
 * exactamente lo que selecciona el cierre. Vive aquí arriba porque la usan DOS: el cursor del
 * cierre (`readShiftPaymentsForClose`) y el rollup de la lista de turnos, que es el de más arriba
 * en el archivo.
 *
 * 🔴 Los tres campos de `tenderSemantics` son OBLIGATORIOS (aunque nulos) a propósito: si fueran
 * opcionales, un `select` que olvide `tenderCountsAsCash` compilaría y el vale de despensa dejaría
 * de contar en el cajón sin que nada avise. Es la trampa del mock que ya costó una vez («el mock
 * pasa el campo gratis, el `select` real no»).
 */
const SHIFT_PAYMENT_TOTALS_SELECT = {
  id: true,
  amount: true,
  tipAmount: true,
  method: true,
  fundsFlow: true,
  tenderTypeId: true,
  tenderCountsAsCash: true,
} satisfies Prisma.PaymentSelect

/** La proyección del cobro que el rollup necesita: los totales + con qué decidir de quién es. */
const COBRO_DEL_ROLLUP_SELECT = {
  ...SHIFT_PAYMENT_TOTALS_SELECT,
  // 🔴 Los tres de abajo NO son opcionales. `shiftId` decide la rama; `createdAt` es el techo del
  // respaldo histórico; `order.shiftId` es la única vía del huérfano. Si alguien los quita del
  // `select`, `turnoDelCobro` FALLA CERRADO (devuelve null) en vez de adivinar — un renglón que se
  // cae de la pantalla se ve y se investiga; dinero contado en dos turnos, no.
  shiftId: true,
  createdAt: true,
  order: { select: { shiftId: true } },
} satisfies Prisma.PaymentSelect

type CobroDelRollup = Prisma.PaymentGetPayload<{ select: typeof COBRO_DEL_ROLLUP_SELECT }>

/** El turno al que pertenece un cobro, o `null` si no es de ninguno de los de esta página. */
function turnoDelCobro(cobro: CobroDelRollup, turnos: Map<string, TurnoParaRollup>): string | null {
  // 🔴 Falla CERRADO ante un `select` estrechado: sin el campo no se adivina. Con `!== null` a
  // secas, un cobro que llegara sin `shiftId` caería a la rama del huérfano y podría sumarse a un
  // turno que no lo cobró — el mismo dinero contado dos veces, con las pruebas en verde porque sus
  // fixtures sí traen el campo.
  if (cobro.shiftId === undefined) return null

  // (1) Estampado por el servidor: su identidad gana a la fecha, sin condiciones.
  if (cobro.shiftId !== null) return turnos.has(cobro.shiftId) ? cobro.shiftId : null

  // (2) Respaldo histórico: el huérfano de una orden CON turno (pos-sync). Con techo — un cobro
  // posterior al cierre no entra retrospectivamente a un turno ya firmado.
  const delaOrden = cobro.order?.shiftId
  if (!delaOrden) return null
  const turno = turnos.get(delaOrden)
  if (!turno) return null
  return cobroSinTurnoPerteneceAlTurno(cobro, turno) ? delaOrden : null
}

type TurnoParaRollup = Pick<Shift, 'id' | 'status' | 'startTime' | 'endTime' | 'updatedAt'>

/**
 * 🔴 LOS TOTALES DE LA LISTA DE TURNOS, SIN HIDRATAR EL DÍA ENTERO.
 *
 * Hasta el 4-sep-2026 esto salía de un `include` anidado sin un solo `take`:
 * `shift.orders → payments → allocations` más `shift.payments`. Antes de la Fase 1 traía casi nada
 * (78 de 92 cobros de Testarudo tenían `shiftId` nulo), pero desde que **un turno es un día entero
 * del negocio** la MISMA consulta pasó a materializar todas las órdenes, todos sus cobros y todas
 * sus asignaciones × `pageSize` turnos en el hilo de Node — la clase de defecto que tumbó
 * producción el 1-sep (memoria `include-sin-tope-en-un-detalle`), en el camino que la PAX consulta
 * a diario. Y `allocations` ni siquiera se leía nunca.
 *
 * Ahora es UNA consulta plana, paginada por cursor y **plegada página a página**: la memoria queda
 * en 500 filas de 8 columnas pase lo que pase, en vez de crecer con la historia del negocio. Los
 * totales los sigue calculando `aggregateShiftPayments` —la MISMA aritmética Decimal que el
 * cierre—, así que la pantalla no puede divergir del corte firmado; sumar por páginas da lo mismo
 * porque son sumas exactas de Decimal.
 *
 * La membresía es la misma de antes, escrita ahora en el `where` en vez de en un `filter` de JS:
 * cobro COMPLETED del venue, estampado con uno de estos turnos **o** huérfano de una orden de uno
 * de estos turnos. El techo del huérfano lo sigue poniendo `cobroSinTurnoPerteneceAlTurno`, que
 * depende del estado de CADA turno y por eso no baja al SQL.
 */
async function rollupDeCobrosPorTurno(
  venueId: string,
  turnos: TurnoParaRollup[],
  filtros: { staffId?: string; desde?: Date; hasta?: Date },
): Promise<Map<string, RollupDelTurno>> {
  const acumulado = new Map<string, RollupDelTurno>()
  if (turnos.length === 0) return acumulado

  const porId = new Map(turnos.map(t => [t.id, t]))
  const ids = [...porId.keys()]
  const { staffId, desde, hasta } = filtros
  const rangoDeFechas = desde || hasta ? { createdAt: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } } : {}

  const where: Prisma.PaymentWhereInput = {
    venueId,
    // 🔴 SÓLO lo que de verdad se cobró. `b4bit.service.ts` crea el `Payment` en PENDING con el
    // turno ya estampado y lo pasa a FAILED al cancelarse: sin este filtro, un cobro cripto que
    // nunca entró salía como venta del turno. Mismo predicado que `getCurrentShift` y el CIERRE.
    // NO se filtra por `type`: el reembolso llega con `amount` negativo y RESTA solo.
    status: 'COMPLETED',
    ...(staffId ? { processedById: staffId } : {}),
    ...rangoDeFechas,
    OR: [
      { shiftId: { in: ids } },
      // El huérfano se alcanza sólo por su orden, y la orden respeta el mismo rango de fechas que
      // respetaba el `include` de las órdenes.
      { shiftId: null, order: { venueId, shiftId: { in: ids }, ...rangoDeFechas } },
    ],
  }

  let cursor: string | undefined
  for (;;) {
    const pagina: CobroDelRollup[] = await prisma.payment.findMany({
      where,
      select: COBRO_DEL_ROLLUP_SELECT,
      orderBy: { id: 'asc' },
      take: COBROS_POR_PAGINA,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    const deEstaPagina = new Map<string, CobroDelRollup[]>()
    for (const cobro of pagina) {
      const turnoId = turnoDelCobro(cobro, porId)
      if (!turnoId) continue
      const lista = deEstaPagina.get(turnoId)
      if (lista) lista.push(cobro)
      else deEstaPagina.set(turnoId, [cobro])
    }

    for (const [turnoId, cobros] of deEstaPagina) {
      const totales = aggregateShiftPayments(cobros)
      const previo = acumulado.get(turnoId) ?? ROLLUP_VACIO()
      acumulado.set(turnoId, {
        totalSales: previo.totalSales.add(totales.totalSales),
        totalTips: previo.totalTips.add(totales.totalTips),
        tipsCount: previo.tipsCount + cobros.filter(p => Number(p.tipAmount || 0) > 0).length,
      })
    }

    if (pagina.length < COBROS_POR_PAGINA) return acumulado

    const siguiente = pagina[pagina.length - 1]?.id
    if (!siguiente || siguiente === cursor) {
      throw new InternalServerError('No se pudo avanzar el cursor de cobros de la lista de turnos')
    }
    cursor = siguiente
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
  // 🔴 El techo lo pone el SERVIDOR, no el cliente. `meta.pageSize` devuelve el valor recortado.
  pageSize = Math.min(Math.max(Math.trunc(pageSize) || 1, 1), TOPE_DE_TURNOS_POR_PAGINA)

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
  //
  // 🔴 SIN `include` de órdenes ni de cobros. Aquí vivía un `orders → payments → allocations` sin
  // un solo `take`, que desde la Fase 1 —un turno = un día entero del negocio— materializaba el día
  // completo × `pageSize` turnos. Los totales salen ahora de `rollupDeCobrosPorTurno`, acotado por
  // cursor. `staff` se queda: es una fila por turno y la respuesta la expone.
  const [shifts, totalCount] = await prisma.$transaction([
    prisma.shift.findMany({
      where: whereClause,
      include: { staff: true },
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

  // Los totales de cada turno, en UNA consulta plana y acotada por cursor. La membresía es la
  // misma que antes (estampado, o huérfano de una orden del turno con techo por su ventana) y la
  // aritmética la misma (`aggregateShiftPayments`); lo que cambia es que ya no se hidrata el día.
  const rollup = await rollupDeCobrosPorTurno(venueId, shifts, { staffId, desde: parsedStartTime, hasta: parsedEndTime })

  const shiftsWithCalculations = shifts.map(shift => {
    const totales = rollup.get(shift.id) ?? ROLLUP_VACIO()
    const tipSum = totales.totalTips.toNumber()
    const paymentSum = totales.totalSales.toNumber()
    const tipsCount = totales.tipsCount

    // Calculate average tip percentage
    const avgTipPercentage = paymentSum > 0 ? (tipSum / paymentSum) * 100 : 0

    return {
      ...shift,
      // Se conservan en `undefined` a propósito: el contrato de la respuesta no cambia (nunca
      // llegaron al JSON) y así queda escrito que esas dos llaves NO se sirven desde aquí.
      orders: undefined,
      payments: undefined,
      // Add calculated values
      tipsSum: tipSum,
      tipsCount,
      paymentSum: paymentSum,
      avgTipPercentage: Number(avgTipPercentage.toFixed(2)),
      // Include staff information if filtered by staffId
      staffInfo: staffId
        ? {
            staffId: staffId,
            tipsCount,
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
          // 🔴 SÓLO cobros COMPLETED — la MISMA regla que ya aplica la mitad huérfana de este
          // mismo resumen (`orphanPaymentWhere`, abajo) y que el cierre. Sin ella un `Payment`
          // PENDING de B4Bit —creado con el turno ya estampado— sumaba a `totalSales` y seguía
          // sumando después de quedar FAILED, en la MISMA cifra que la mitad huérfana calculaba
          // bien: dos mitades del mismo total con reglas distintas.
          status: 'COMPLETED',
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
  /**
   * 🔴 Este cierre lo disparó el CIERRE DE LA GAVETA (la tablet), no la PAX. Dos consecuencias, y
   * las dos son de dinero:
   *
   *   · el esperado ya viene resuelto por la gaveta que se acaba de cerrar — volver a buscarlo
   *     daría `null` (ya no está abierta) y el turno recalcularía contra su fondo congelado;
   *   · **no se cierra ninguna gaveta al terminar.** Sin esta guarda, el turno cerraría «la gaveta
   *     abierta del negocio», que en ese instante puede ser la que alguien acaba de abrir para el
   *     siguiente relevo: su turno nuevo se quedaría sin caja y el cajero de la tarde contando una
   *     gaveta que se cerró sola.
   */
  cerrandoDesdeElCajon?: { sessionId: string; esperado: Decimal | null }
}

export interface ShiftCloseExecutionResult {
  shift: Shift
  reconciliation: CashReconciliationResult
}

/**
 * Lo que la ruta de la PAX devuelve al abrir: la fila de `Shift` de siempre MÁS el id del cajón
 * físico con el que quedó ligada.
 *
 * 🔴 **ADITIVO.** `cashDrawerSessionId` es un campo NUEVO; ninguna app instalada lo lee y ninguna
 * puede romperse por recibirlo (la PAX mapea `ShiftDto` con Gson, que ignora las llaves que no
 * declara). Nunca se quita ni se renombra un campo de esta respuesta.
 */
export type ShiftConCajon = Shift & { cashDrawerSessionId: string }

/**
 * Abre el turno de caja de la terminal — la puerta de la PAX (`POST /tpv/venues/:id/shifts/open`).
 *
 * 🔴 **Desde la Fase 2 (3-sep-2026) esta ruta NO abre un `Shift` a secas: abre EL TURNO DE CAJA DEL
 * NEGOCIO**, que es un solo gesto con dos registros ligados (`abrirTurnoDeCaja` en
 * `shared/turnoDeCaja.ts`). El negocio abría dos cosas cada mañana —la Caja en la tablet con su
 * fondo y el Turno en la PAX con otro— para UNA sola gaveta física: Testarudo, 1-sep-2026, $2,000 a
 * las 07:38 en el Sunmi y $0 a las 08:12 en la PAX.
 *
 * **Quien llama sigue siendo la ruta de SIEMPRE, y ése es el punto**: las PAX en la calle reciben el
 * gesto único sin actualizarse, y el servidor se puede desplegar solo.
 *
 * ── Qué cambia para la PAX, y qué no ───────────────────────────────────────────────────────
 *
 * · La respuesta es la fila de `Shift` de siempre —los mismos campos, sin relaciones nuevas— MÁS
 *   `cashDrawerSessionId`, aditivo y opcional para cualquier cliente que no lo lea.
 * · Con un turno ya abierto ya **no** contesta 400 «There is already an open shift»: LIGA y
 *   devuelve el que hay. Es lo que permite que una apertura repetida no rebote, y de paso la PAX
 *   deja de enseñar «ciérralo antes de abrir otro» sobre un turno que es suyo.
 * · Con un cierre EN CURSO contesta 409 `SHIFT_CLOSE_IN_PROGRESS`, que es la verdad —antes decía
 *   400 «ya hay uno abierto, ciérralo», que era falso—. `ShiftViewModel.translateError` de la PAX
 *   ya traduce ese 409 a «La caja se está cerrando en otra terminal. Espera unos segundos», sin
 *   tocar una línea de la app.
 *
 * @param venueId Venue ID
 * @param staffId Staff que abre el turno
 * @param startingCash Fondo tecleado. Sólo manda si NO hay ya una caja o un turno abiertos con su
 *   propio fondo: el dinero que alguien contó gana sobre el que alguien tecleó después.
 * @param stationId Estación del POS integrado (opcional)
 * @param _orgId Se conserva por compatibilidad de firma; la autorización vive en el middleware
 */
export async function openShiftForVenue(
  venueId: string,
  staffId: string,
  startingCash: number,
  stationId?: string,
  _orgId?: string,
): Promise<ShiftConCajon> {
  logger.info('Opening new shift for venue', {
    venueId,
    staffId,
    startingCash,
    stationId,
  })

  const apertura = await abrirTurnoDeCaja({
    venueId,
    staffId,
    startingCash: startingCash || 0,
    stationId,
    source: 'TURNO_TPV',
  })

  // La fila COMPLETA, sin `include`: es exactamente lo que `prisma.shift.create` devolvía y lo que
  // la PAX mapea hoy (`ShiftDto`, con `staff` opcional que llega nulo). Un `include` nuevo aquí le
  // cambiaría el payload a una app que nadie va a actualizar.
  const shift = await prisma.shift.findUnique({ where: { id: apertura.shiftId } })
  if (!shift) {
    // Imposible salvo que alguien borre el turno entre la transacción y esta lectura. Se reporta
    // como error del servidor y no como «no encontrado»: el turno SÍ se abrió.
    throw new InternalServerError('El turno se abrió pero no se pudo releer')
  }

  logger.info('Shift opened successfully', {
    shiftId: shift.id,
    venueId,
    staffId,
    creado: apertura.shiftCreado,
    cashDrawerSessionId: apertura.cashDrawerSessionId,
  })

  // 🔴 El aviso en tiempo real sólo cuando el turno se CREÓ. Si sólo se ligó, nadie abrió nada y
  // anunciar `shift_opened` le pintaría al dashboard una apertura que no ocurrió.
  // `logAction(SHIFT_OPENED)` ya lo escribe `abrirTurnoDeCaja`, con el mismo `data` de siempre.
  if (apertura.shiftCreado) {
    try {
      const broadcastingService = socketManager.getBroadcastingService()
      if (broadcastingService) {
        broadcastingService.broadcastShiftEvent(venueId, 'opened', {
          shiftId: shift.id,
          staffId: shift.staffId,
          staffName: apertura.staffName,
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
  }

  return { ...shift, cashDrawerSessionId: apertura.cashDrawerSessionId }
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

async function findClosableShift(
  db: Pick<Prisma.TransactionClient, 'shift'>,
  venueId: string,
  shiftId: string,
): Promise<ClosableShift | null> {
  return db.shift.findFirst({
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
async function claimShiftForClose(venueId: string, shiftId: string, now: () => Date): Promise<{ shift: ClosableShift; claimedAt: Date }> {
  return prisma.$transaction(async tx => {
    await lockShiftLifecycleForVenue(tx, venueId)
    const shift = await findClosableShift(tx, venueId, shiftId)
    if (!shift) {
      throw new NotFoundError('Shift not found or does not belong to this venue')
    }
    if (shift.endTime !== null || shift.status === ShiftStatus.CLOSED) {
      throw new BadRequestError('Shift is already closed')
    }
    // Esta muestra pertenece al estado autoritativo que acabamos de releer bajo el lock.
    // Tomarla antes permitiría que un lifecycle writer moviera `startTime` mientras
    // esperábamos y dejara un intervalo imposible (`startTime > claimedAt`).
    const claimedAt = now()

    const claim = await tx.shift.updateMany({
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
    if (claim.count === 1) return { shift, claimedAt }

    const latest = await findClosableShift(tx, venueId, shiftId)
    if (!latest) {
      throw new NotFoundError('Shift not found or does not belong to this venue')
    }
    if (latest.endTime !== null || latest.status === ShiftStatus.CLOSED) {
      throw new BadRequestError('Shift is already closed')
    }

    const staleBefore = new Date(claimedAt.getTime() - SHIFT_CLOSE_STALE_MS)
    if (latest.status === ShiftStatus.CLOSING && latest.updatedAt instanceof Date && latest.updatedAt.getTime() < staleBefore.getTime()) {
      const recovered = await tx.shift.updateMany({
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
      if (recovered.count === 1) return { shift: latest, claimedAt }
    }

    throw shiftCloseInProgress()
  })
}

async function releaseShiftCloseClaim(venueId: string, shiftId: string, claimedAt: Date): Promise<void> {
  try {
    await prisma.$transaction(async tx => {
      await lockShiftLifecycleForVenue(tx, venueId)
      await tx.shift.updateMany({
        where: {
          id: shiftId,
          venueId,
          status: ShiftStatus.CLOSING,
          endTime: null,
          updatedAt: claimedAt,
        },
        data: { status: ShiftStatus.OPEN },
      })
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

/**
 * El cierre necesita el total completo, pero nunca hidrata una colección sin techo en una sola
 * consulta. `id` es único e inmutable: sirve como orden y cursor deterministas aun cuando varios
 * cobros compartan el mismo `createdAt`.
 */
const SHIFT_CLOSE_PAYMENT_PAGE_SIZE = 500

// (`SHIFT_PAYMENT_TOTALS_SELECT` vive arriba, junto al rollup de la lista de turnos: los dos lo usan.)

export type ShiftPaymentPageRow = Prisma.PaymentGetPayload<{ select: typeof SHIFT_PAYMENT_TOTALS_SELECT }>

/**
 * La membresía canónica del snapshot firmado:
 *
 * 1. un cobro COMPLETED estampado con el turno cuenta siempre (su identidad gana a la fecha);
 * 2. un huérfano COMPLETED sólo se adopta si pertenece al mismo venue, su Order pertenece al
 *    turno y ocurrió dentro de `[startTime, claimedAt]`, ambos extremos inclusivos.
 *
 * `shiftId: null` es literal a propósito: un campo ausente/undefined nunca es evidencia de
 * orfandad. El cierre sólo lee; no backfillea ni reescribe el Payment.
 */
function shiftPaymentsForCloseWhere(venueId: string, shiftId: string, startTime: Date, claimedAt: Date): Prisma.PaymentWhereInput {
  return {
    venueId,
    status: 'COMPLETED',
    OR: [
      { shiftId },
      {
        shiftId: null,
        createdAt: { gte: startTime, lte: claimedAt },
        order: { venueId, shiftId },
      },
    ],
  }
}

export async function readShiftPaymentsForClose(
  venueId: string,
  shiftId: string,
  startTime: Date,
  claimedAt: Date,
): Promise<ShiftPaymentPageRow[]> {
  const payments: ShiftPaymentPageRow[] = []
  let cursorId: string | undefined

  while (true) {
    const page = await prisma.payment.findMany({
      where: shiftPaymentsForCloseWhere(venueId, shiftId, startTime, claimedAt),
      select: SHIFT_PAYMENT_TOTALS_SELECT,
      orderBy: { id: 'asc' },
      take: SHIFT_CLOSE_PAYMENT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })

    payments.push(...page)
    if (page.length < SHIFT_CLOSE_PAYMENT_PAGE_SIZE) return payments

    const nextCursor = page[page.length - 1]?.id
    if (!nextCursor || nextCursor === cursorId) {
      throw new InternalServerError('No se pudo avanzar el cursor de cobros durante el cierre del turno')
    }
    cursorId = nextCursor
  }
}

async function closeShiftUsingRequest(
  venueId: string,
  shiftId: string,
  request: EffectiveCloseRequest,
  context: ShiftCloseRequestContext,
): Promise<ShiftCloseExecutionResult> {
  const { shift, claimedAt } = await claimShiftForClose(venueId, shiftId, context.now ?? (() => new Date()))

  try {
    const shiftPayments = await readShiftPaymentsForClose(venueId, shiftId, shift.startTime, claimedAt)

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

    // 🔴 EL ESPERADO SALE DE LA GAVETA, no de un fondo congelado en la apertura (Task 5).
    //
    // `startingCash + cashInDrawer` es ciego a los retiros (`PAY_OUT`) y a que la gaveta se
    // refonde a media jornada — `Shift.startingCash` es un ESCALAR y no puede describir dos
    // sesiones de caja el mismo día. El detalle, con los dos escenarios medidos, vive en
    // `esperadoDelCajonAbierto`. Sin gaveta (el venue que no usa el módulo de caja) se cae a la
    // fórmula de siempre, byte a byte.
    //
    // Cuando el cierre lo dispara la propia gaveta, el esperado llega ya resuelto: buscarlo aquí
    // daría `null` porque esa caja acaba de cerrarse.
    const cajon = context.cerrandoDesdeElCajon
      ? { sessionId: context.cerrandoDesdeElCajon.sessionId, esperado: context.cerrandoDesdeElCajon.esperado }
      : await esperadoDelCajonAbierto(venueId, shiftId, claimedAt).catch(error => {
          // Es una lectura auxiliar: si falla, el cierre sigue con la fórmula del turno en vez de
          // reventar sobre un turno ya reclamado en CLOSING.
          logger.warn('[Shift Close] No se pudo resolver el esperado del cajón; se usa el del turno', {
            venueId,
            shiftId,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        })

    // ── El registro durable del gesto, ANTES del primer commit ────────────────────────────
    //
    // 🔴 Este cierre son DOS commits, y si el proceso muere en medio lo que queda NO «degrada a lo
    // de hoy»: la gaveta se queda OPEN mientras `turnoAbiertoDelNegocio` ya devuelve `null`, así
    // que los cobros nuevos nacen sin turno y sus `CASH_SALE` se siguen posteando a esa caja —
    // efectivo acumulándose en una gaveta que ya nadie va a cuadrar. El barrido
    // `cash-close-pair-reconciler` lo repara, pero sólo si la gaveta dice de QUÉ turno era:
    // emparejarlas por reloj es lo que mezclaría jornadas.
    //
    // Cuando el cierre lo dispara la propia gaveta no hay nada que ligar: esa pareja ya la resolvió
    // quien llamó. Y `asegurarLaLiga` nunca lanza ni roba una liga ajena, así que no puede tumbar
    // un cierre que por lo demás está bien.
    if (cajon && !context.cerrandoDesdeElCajon) {
      await asegurarLaLiga(prisma, venueId, shiftId, cajon.sessionId)
    }

    const expectedCash = cajon?.esperado ?? new Decimal(shift.startingCash || 0).add(cashInDrawer)
    let outcome: CashReconciliationOutcome = request.outcome
    let ignoreReason = request.ignoreReason ?? request.reason
    let endingCash = cashInDrawer
    let cashDeclared: Decimal | null = null
    let cashDifference: Decimal | null = null
    let calculatedDifference: Decimal | null = null

    if (request.source === 'NEW' && request.action === 'COUNTED' && request.countedCash && outcome === 'APPLIED') {
      const calculation = calculateCashReconciliationFromExpected(request.countedCash, expectedCash)
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
      // 🔴 QUIÉN cerró. `staffId` es quien ABRIÓ, y con el gesto único no tienen por qué ser la
      // misma persona. Nunca se cae a `shift.staffId`: copiarlo afirmaría que quien abrió también
      // cerró, que es exactamente el supuesto que esta columna existe para dejar de hacer.
      closedById: context.actorStaffId ?? null,
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
      // De DÓNDE salió ese esperado. Sin esto, dos cierres del mismo venue con números distintos
      // son indistinguibles para quien audita.
      expectedSource: cajon?.esperado ? 'CAJON' : 'TURNO',
      ...(cajon ? { cashDrawerSessionId: cajon.sessionId } : {}),
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
      await lockShiftLifecycleForVenue(tx, venueId)
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

    // 🔴 UN GESTO, DOS REGISTROS (Task 5): cerrar el turno cierra también la gaveta ligada.
    //
    // Antes no lo hacía, y por eso una caja creada por la apertura del turno desde la PAX acababa
    // cerrándola el auto-cierre de las 04:00 o el relevo de la mañana siguiente: los venues
    // sólo-PAX habrían visto un bloque «Caja física · sin conteo» todos los días.
    //
    // 🔴 El conteo sólo viaja si de verdad se APLICÓ. Si el protocolo se ignoró —por el candado del
    // venue, por un cuerpo inválido o por desbordar `Decimal(10,2)`— la gaveta se cierra SIN conteo:
    // escribirlo ahí colaría por la puerta de atrás justo lo que el candado deja fuera, y dejaría
    // las dos mitades diciendo cosas distintas del mismo dinero.
    //
    // Va después del commit y en try/catch: el turno YA está cerrado y firmado. Un fallo aquí nunca
    // convierte un cierre bueno en un error para el mostrador.
    //
    // 🔴 **Pero NO «degrada a lo de hoy», y este comentario lo afirmaba hasta el 3-sep-2026**
    // (auditoría de Codex): la gaveta se queda OPEN mientras `turnoAbiertoDelNegocio` ya devuelve
    // `null`, así que los cobros nuevos nacen sin turno y sus `CASH_SALE` se siguen posteando ahí.
    // Se tolera porque queda REPARABLE —la liga se escribió arriba— y lo completa
    // `cash-close-pair-reconciler`, no porque sea inocuo.
    //
    // ⚠️ CONSECUENCIA DECLARADA, sin mitigación inventada: **no hay evento de socket para el estado
    // de la gaveta** (no existe en `src/communication/`) — la tablet SONDEA. Antes, cerrar el turno
    // desde la PAX dejaba la gaveta abierta y la tablet seguía vendiendo en ella; ahora la gaveta se
    // cierra a media operación y la tablet se entera hasta su siguiente sondeo, así que lo que se
    // cobre en ese hueco cae `outsideDrawer` y el reconciliador no lo puede colocar (sólo repone
    // DENTRO de la ventana de una sesión). Es la misma familia que la ventana del `CLOSING`, y como
    // aquélla tiene dueño: se cierra con un evento de socket para la gaveta, no aquí.
    if (!context.cerrandoDesdeElCajon) {
      try {
        await cerrarTurnoDeCaja({
          venueId,
          staffId: context.actorStaffId ?? null,
          staffName: null,
          source: 'TURNO_TPV',
          yaCerrado: { shiftId },
          conteo: outcome === 'APPLIED' && cashDeclared ? cashDeclared : null,
          // 🔴 El MISMO esperado que el turno acaba de firmar. Entre que se resolvió (antes de la
          // consulta de pagos) y esta escritura pasan segundos: una venta en efectivo en esa
          // ventana postea su `CASH_SALE` a la gaveta abierta, y si la gaveta recalculara desde sus
          // eventos firmaría `overShort = −venta` mientras el turno firma 0. Una foto, dos firmas
          // — AL CERRAR. Una reposición posterior del reconciliador mueve la gaveta y no el turno
          // (ver el alcance en `cerrarLaGavetaDelTurno`).
          // Va `null` cuando no hubo gaveta: no se le inventa un esperado a la que no existe.
          esperadoDelCajon: cajon?.esperado ?? null,
          note: legacy?.notes ?? null,
          now: () => claimedAt,
        })
      } catch (error) {
        logger.error('[Shift Close] El turno se cerró pero la gaveta ligada no', {
          venueId,
          shiftId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

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
        // `shiftId` acota al turno (espejo de `gavetaCerrable`): la PAX no puede imprimir el
        // arqueo de la gaveta de OTRO turno junto al conteo de éste.
        resolveShiftCashDrawer(venueId, updatedShift.startTime, updatedShift.endTime ?? new Date(), false, shiftId),
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

/**
 * Cierra el turno porque se acaba de cerrar LA GAVETA desde la tablet — la otra mitad del gesto
 * único (`cerrarTurnoDeCaja` en `shared/turnoDeCaja.ts`, que es quien llama).
 *
 * 🔴 **No pasa por el candado del protocolo de conciliación de la PAX, a propósito.** Ese candado
 * (`isCashReconciliationEnabled`) gobierna si la TERMINAL le pide al cajero que cuente. Aquí el
 * cajero YA contó, por `POST /mobile/…/cash-drawer/close`, que es core, gratis y exige
 * `actualAmount`. Volver a pedir permiso dejaría a la gaveta diciendo «faltan $50» y al turno
 * callado sobre el mismo dinero — dos verdades para el mismo billete, que es justo lo que la
 * unificación quita. (Decisión declarada de la Task 5; si el founder la revierte, se cambia aquí.)
 *
 * 🔴 Y el esperado viaja con el conteo: lo calculó la gaveta sobre SUS eventos, así que las dos
 * mitades firman el mismo número por construcción y no por coincidencia.
 */
export async function cerrarTurnoPorCierreDeCaja(
  venueId: string,
  shiftId: string,
  opciones: {
    /** Lo que el cajero contó en la gaveta. `null` = nadie contó, y no se inventa nada. */
    conteo: Decimal | null
    /** El esperado de ESA gaveta, ya resuelto. */
    esperadoDelCajon: Decimal | null
    actorStaffId?: string | null
    cashDrawerSessionId: string
  },
): Promise<Shift> {
  const request: EffectiveCloseRequest =
    opciones.conteo != null
      ? { source: 'NEW', action: 'COUNTED', outcome: 'APPLIED', countedCash: opciones.conteo }
      : { source: 'NONE', outcome: 'NOT_REQUESTED' }

  const resultado = await closeShiftUsingRequest(venueId, shiftId, request, {
    actorStaffId: opciones.actorStaffId ?? undefined,
    cerrandoDesdeElCajon: { sessionId: opciones.cashDrawerSessionId, esperado: opciones.esperadoDelCajon },
  })
  return resultado.shift
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
