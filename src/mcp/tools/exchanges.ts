import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ExchangeStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { z } from 'zod'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { parseDbDateRange } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

export function registerExchangeTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)
  server.tool(
    'list_exchanges',
    'Consulta los cambios de talla o producto de una sucursal: venta original, venta nueva, importe que regresa, importe que se lleva, diferencia y cómo se liquida. Incluye el importe por cobrar sólo en PENDING_PAYMENT (pendiente de pago), el identificador del cobro de la terminal y el motivo de revisión; si no corresponden, devuelve null. Montos en pesos. Filtra por fechas locales y estado, incluidos NEEDS_REVIEW (por revisar) y CANCELLED (cancelado). Sin fechas consulta los últimos 7 días. Devuelve el total y siguienteOffset para recorrer todas las páginas; 25 cambios por defecto y máximo 100 por página. Requiere permiso para consultar pagos. Sólo lectura.',
    {
      venueId: z
        .string({ required_error: 'Indica la sucursal', invalid_type_error: 'La sucursal debe ser texto' })
        .min(1, 'Indica la sucursal')
        .describe('Identificador de una sucursal a la que tienes acceso'),
      fromDate: z
        .string({ invalid_type_error: 'La fecha inicial debe ser texto' })
        .optional()
        .describe('Fecha inicial en la zona horaria de la sucursal (YYYY-MM-DD)'),
      toDate: z
        .string({ invalid_type_error: 'La fecha final debe ser texto' })
        .optional()
        .describe('Fecha final inclusiva en la zona horaria de la sucursal (YYYY-MM-DD)'),
      status: z.nativeEnum(ExchangeStatus, { errorMap: () => ({ message: 'Selecciona un estado de cambio válido' }) }).optional(),
      limit: z
        .number({ invalid_type_error: 'El tamaño de página debe ser numérico' })
        .int('Indica un número entero')
        .positive('El tamaño de página debe ser positivo')
        .optional(),
      offset: z
        .number({ invalid_type_error: 'El desplazamiento debe ser numérico' })
        .int('Indica un número entero')
        .min(0, 'El desplazamiento no puede ser negativo')
        .max(2147483647, 'El desplazamiento es demasiado grande')
        .optional(),
    },
    async ({ venueId, fromDate, toDate, status, limit, offset }) => {
      const venueFilter = guard.venueFilter(venueId)
      guard.requirePermission('payments:read', venueId)
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
      if (!venue) throw new NotFoundError('No se encontró la sucursal')
      const { from, to } = parseDbDateRange(fromDate, toDate, venue.timezone, 7)
      if (from > to) throw new BadRequestError('La fecha inicial debe ser anterior o igual a la final')
      const skip = offset ?? 0
      const where = { ...venueFilter, createdAt: { gte: from, lte: to }, ...(status ? { status } : {}) }
      const [total, exchanges] = await Promise.all([
        prisma.exchange.count({ where }),
        prisma.exchange.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: Math.min(limit ?? 25, 100),
          select: {
            id: true,
            status: true,
            createdAt: true,
            originalOrderId: true,
            newOrderId: true,
            returnedAmount: true,
            takenAmount: true,
            differenceAmount: true,
            chargePaymentId: true,
            reviewReason: true,
            settlementKind: true,
            settlementMethod: true,
            staffId: true,
          },
        }),
      ])
      const hayMas = skip + exchanges.length < total
      const fechaLocal = (date: Date) => formatInTimeZone(date, venue.timezone, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
      return text({
        sucursal: venue.name,
        zonaHoraria: venue.timezone,
        desde: fechaLocal(from),
        hasta: fechaLocal(to),
        total,
        cuantos: exchanges.length,
        hayMas,
        siguienteOffset: hayMas ? skip + exchanges.length : null,
        cambios: exchanges.map(exchange => ({
          id: exchange.id,
          estado: exchange.status,
          fecha: fechaLocal(exchange.createdAt),
          ventaOriginal: exchange.originalOrderId,
          ventaNueva: exchange.newOrderId,
          regresa: Number(exchange.returnedAmount),
          seLleva: Number(exchange.takenAmount),
          diferencia: Number(exchange.differenceAmount),
          porCobrar: exchange.status === ExchangeStatus.PENDING_PAYMENT ? Number(exchange.differenceAmount) : null,
          cobroDeLaTerminal: exchange.chargePaymentId ?? null,
          motivoDeRevision: exchange.reviewReason ?? null,
          liquidacion: { tipo: exchange.settlementKind, medio: exchange.settlementMethod },
          hizo: exchange.staffId,
        })),
      })
    },
  )
}
