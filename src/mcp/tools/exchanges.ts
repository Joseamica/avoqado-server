import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ExchangeStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { z } from 'zod'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { getExchangeForDashboard, markExchangeReviewed } from '@/services/dashboard/exchange.dashboard.service'
import { effectiveExchangesEnabled } from '@/services/exchanges/exchangeRules'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'
import { exchangeReviewNoteSchema } from '@/schemas/dashboard/exchange.dashboard.schema'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { parseDbDateRange } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

export function registerExchangeTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)
  server.tool(
    'list_exchanges',
    'Consulta los cambios de talla o producto de una sucursal: venta original, venta nueva, importe que regresa, importe que se lleva, diferencia y cómo se liquida. Incluye el importe por cobrar sólo en PENDING_PAYMENT (pendiente de pago), el identificador del cobro de la terminal y el motivo de revisión; si no corresponden, devuelve null. Montos en pesos. Filtra por fechas locales y estado, incluidos NEEDS_REVIEW (por revisar) y CANCELLED (cancelado). Incluye quién revisó, cuándo y su nota. porRevisar:true consulta sólo los que nadie ha revisado, sin límite de fechas salvo que las indiques. Sin fechas ni porRevisar consulta los últimos 7 días. Devuelve el total y siguienteOffset para recorrer todas las páginas; 25 cambios por defecto y máximo 100 por página. Requiere permiso para consultar pagos. Sólo lectura.',
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
      originalOrderId: z
        .string({ invalid_type_error: 'El identificador de la venta debe ser texto' })
        .cuid('El identificador de la venta no es válido')
        .optional()
        .describe('Venta original cuyos cambios quieres consultar'),
      porRevisar: z.boolean({ invalid_type_error: 'Indica si quieres sólo los cambios por revisar' }).optional(),
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
    async ({ venueId, fromDate, toDate, status, porRevisar, limit, offset, originalOrderId }) => {
      const venueFilter = guard.venueFilter(venueId)
      guard.requirePermission('payments:read', venueId)
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
      if (!venue) throw new NotFoundError('No se encontró la sucursal')
      const range = porRevisar && !fromDate && !toDate ? null : parseDbDateRange(fromDate, toDate, venue.timezone, 7)
      if (range && range.from > range.to) throw new BadRequestError('La fecha inicial debe ser anterior o igual a la final')
      const skip = offset ?? 0
      const where = {
        ...venueFilter,
        ...(originalOrderId ? { originalOrderId } : {}),
        ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
        ...(status ? { status } : {}),
        ...(porRevisar ? { status: ExchangeStatus.NEEDS_REVIEW, reviewedAt: null } : {}),
      }
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
            reviewedAt: true,
            reviewedById: true,
            reviewNote: true,
          },
        }),
      ])
      const orderIds = [...new Set(exchanges.flatMap(e => [e.originalOrderId, e.newOrderId]).filter(Boolean))]
      const orders = orderIds.length
        ? await prisma.order.findMany({
            where: { ...venueFilter, id: { in: orderIds } },
            take: orderIds.length,
            select: { id: true, orderNumber: true },
          })
        : []
      const numbers = new Map(orders.map(o => [o.id, o.orderNumber]))
      const hayMas = skip + exchanges.length < total
      const fechaLocal = (date: Date) => formatInTimeZone(date, venue.timezone, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
      return text({
        sucursal: venue.name,
        zonaHoraria: venue.timezone,
        desde: range ? fechaLocal(range.from) : null,
        hasta: range ? fechaLocal(range.to) : null,
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
          ventaOriginalFolio: numbers.get(exchange.originalOrderId) ?? null,
          ventaNuevaFolio: numbers.get(exchange.newOrderId) ?? null,
          regresa: Number(exchange.returnedAmount),
          seLleva: Number(exchange.takenAmount),
          diferencia: Number(exchange.differenceAmount),
          porCobrar: exchange.status === ExchangeStatus.PENDING_PAYMENT ? Number(exchange.differenceAmount) : null,
          cobroDeLaTerminal: exchange.chargePaymentId ?? null,
          motivoDeRevision: exchange.reviewReason ?? null,
          revisado: exchange.reviewedAt
            ? { fecha: fechaLocal(exchange.reviewedAt), quien: exchange.reviewedById, nota: exchange.reviewNote }
            : null,
          liquidacion: { tipo: exchange.settlementKind, medio: exchange.settlementMethod },
          hizo: exchange.staffId,
        })),
      })
    },
  )

  const venueInput = z
    .string({ required_error: 'Indica la sucursal', invalid_type_error: 'La sucursal debe ser texto' })
    .min(1, 'Indica la sucursal')
  const readSetting = async (venueId: string) => {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { type: true, settings: { select: { exchangesEnabled: true } } },
    })
    if (!venue) throw new NotFoundError('No se encontró la sucursal')
    const guardado = venue.settings?.exchangesEnabled ?? null
    return { prendido: effectiveExchangesEnabled(guardado, venue.type), guardado, porGiro: effectiveExchangesEnabled(null, venue.type) }
  }
  server.tool(
    'get_exchanges_setting',
    'Consulta si los cambios de talla o producto están prendidos en una sucursal, el ajuste guardado (null significa sin elegir) y el valor predeterminado por giro. Requiere permiso para consultar la sucursal. Sólo lectura.',
    { venueId: venueInput },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('venues:read', venueId)
      return text(await readSetting(venueId))
    },
  )
  server.tool(
    'set_exchanges_setting',
    'Prende o apaga los cambios de talla o producto de una sucursal. Requiere permiso para editar la sucursal y conexión con escritura. Primero muestra actual → nuevo; sólo tras confirmación expresa del operador repite confirmationArguments con confirm:true y el confirmationToken firmado. Guarda la elección y su bitácora. No mueve dinero ni existencias.',
    {
      venueId: venueInput,
      exchangesEnabled: z.boolean({ required_error: 'Indica si quieres prender los cambios', invalid_type_error: 'Indica true o false' }),
      confirm: z.boolean({ invalid_type_error: 'La confirmación debe ser true o false' }).optional(),
    },
    async ({ venueId, exchangesEnabled, confirm }) => {
      guard.venueFilter(venueId)
      requireWriteScopeAlways(scope, 'venues:update', 'cambia el ajuste de cambios de producto')
      guard.requirePermission('venues:update', venueId)
      if (!confirm) {
        const setting = await readSetting(venueId)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { actual: setting.prendido, nuevo: exchangesEnabled },
          message: `Cambios de producto: ${setting.prendido ? 'Prendido' : 'Apagado'} → ${exchangesEnabled ? 'Prendido' : 'Apagado'}. Confirma con el operador antes de guardar.`,
        })
      }
      // The shared settings service records the authenticated actor and before/after values.
      await updateVenueSettings(venueId, { exchangesEnabled }, scope.staffId)
      return text({ ok: true, ...(await readSetting(venueId)) })
    },
  )
  server.tool(
    'get_exchange',
    'Consulta un cambio de talla o producto: ventas y folios, piezas solicitadas para regresar y llevarse, valores, diferencia, liquidación y revisión. aplicado sólo es true cuando el cambio se completó; restock expresa lo solicitado y no demuestra una devolución al inventario. Incluye el total esperado y cobrado de TODOS los cargos y sus identificadores; null si no consta. Todos los importes en pesos. Requiere permiso para consultar pagos. Sólo lectura.',
    {
      venueId: venueInput,
      exchangeId: z
        .string({ required_error: 'Indica el cambio', invalid_type_error: 'El cambio debe ser texto' })
        .min(1, 'Indica el cambio'),
    },
    async ({ venueId, exchangeId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:read', venueId)
      const row = await getExchangeForDashboard({ venueId, exchangeId })
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      if (!venue) throw new NotFoundError('No se encontró la sucursal')
      const local = (date: Date) => formatInTimeZone(date, venue.timezone, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
      return text({
        id: row.id,
        estado: row.status,
        aplicado: row.applied,
        fecha: local(row.createdAt),
        ventaOriginal: row.originalOrderId,
        ventaOriginalFolio: row.originalOrderNumber,
        cobroOriginal: row.originalPaymentId,
        ventaNueva: row.newOrderId,
        ventaNuevaFolio: row.newOrderNumber,
        hizo: row.staffId,
        nombre: row.staffName,
        regresa: row.returnedCents / 100,
        seLleva: row.takenCents / 100,
        diferencia: row.differenceCents / 100,
        devueltos: row.returned.map(line => ({
          orderItemId: line.orderItemId,
          productId: line.productId,
          nombre: line.productName,
          cantidad: line.quantity,
          motivo: line.reason,
          restock: line.restock,
          valor: line.valueCents / 100,
          valoresPorPieza: line.pieceValuesCents?.map(c => c / 100) ?? [],
        })),
        llevados: row.taken.map(line => ({
          productId: line.productId,
          nombre: line.productName,
          cantidad: line.quantity,
          precioLista: line.listCents / 100,
          precio: line.priceCents / 100,
          piezas: line.pieces?.map(p => ({ precio: p.priceCents / 100, heredadoDe: p.inheritedFromOrderItemId })) ?? [],
          newOrderItemIds: line.newOrderItemIds,
        })),
        liquidacion: { tipo: row.settlement.kind, medio: row.settlement.method, importe: row.settlement.amountCents / 100 },
        esperado: row.expectedChargeCents === null ? null : row.expectedChargeCents / 100,
        cobrado: row.chargedCents === null ? null : row.chargedCents / 100,
        cantidadDeCobros: row.chargePaymentCount,
        cobros: row.paymentIds,
        cobroDeLaTerminal: row.chargePaymentId,
        motivoDeRevision: row.reviewReason,
        revisado: row.reviewedAt ? { fecha: local(row.reviewedAt), quien: row.reviewedById, nota: row.reviewNote } : null,
      })
    },
  )

  server.tool(
    'review_exchange',
    'Marca revisado un cambio de talla o producto que está por revisar y deja una nota obligatoria. Conserva su estado: no mueve dinero ni existencias, no aplica crédito ni reabre la venta. Requiere permiso para reembolsar y una conexión con escritura. Dos pasos: primero muestra al operador la vista previa y su nota; sólo con su confirmación expresa repite confirmationArguments tal cual, con confirm:true y el confirmationToken de la vista previa. Si alguien ya lo revisó, se informa el conflicto.',
    {
      venueId: z
        .string({ required_error: 'Indica la sucursal', invalid_type_error: 'La sucursal debe ser texto' })
        .min(1, 'Indica la sucursal'),
      exchangeId: z
        .string({ required_error: 'Indica el cambio', invalid_type_error: 'El cambio debe ser texto' })
        .min(1, 'Indica el cambio'),
      note: exchangeReviewNoteSchema,
      confirm: z
        .boolean({ invalid_type_error: 'La confirmación debe ser true o false' })
        .optional()
        .describe('true sólo tras la confirmación expresa del operador'),
    },
    async ({ venueId, exchangeId, note, confirm }) => {
      const venueFilter = guard.venueFilter(venueId)
      requireWriteScopeAlways(scope, 'payments:refund', 'registra la revisión de un cambio')
      guard.requirePermission('payments:refund', venueId)
      // The catalog's signed confirmation (configureToolCatalog) binds venue, exchange and note to the preview.
      if (confirm) {
        // The shared service writes the audit in its transaction; a second MCP audit would duplicate it.
        const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
        if (!venue) throw new NotFoundError('No se encontró la sucursal')
        const row = await markExchangeReviewed({ venueId, exchangeId, staffId: scope.staffId, note, source: 'MCP' })
        return text({
          ok: true,
          cambio: row.id,
          revisado: {
            fecha: row.reviewedAt ? formatInTimeZone(row.reviewedAt, venue.timezone, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX") : null,
            quien: row.reviewedById,
            nota: row.reviewNote,
          },
        })
      }
      const row = await prisma.exchange.findFirst({
        where: { ...venueFilter, id: exchangeId },
        select: { id: true, status: true, reviewReason: true, reviewedAt: true },
      })
      if (!row) throw new NotFoundError('No se encontró el cambio')
      if (row.reviewedAt) throw new ConflictError('Este cambio ya fue revisado', 'EXCHANGE_ALREADY_REVIEWED')
      if (row.status !== 'NEEDS_REVIEW') throw new ConflictError('Este cambio no está por revisar', 'EXCHANGE_NOT_IN_REVIEW')
      return text({
        ok: false,
        requiresConfirmation: true,
        preview: {
          cambio: row.id,
          estado: row.status,
          motivoDeRevision: row.reviewReason,
          revisado: !!row.reviewedAt,
          nota: note,
        },
        message: `Vas a marcar revisado el cambio ${row.id}, de «Por revisar» a «Revisado», con la nota «${note}». No mueve dinero ni existencias. Confirma con el operador antes de continuar.`,
      })
    },
  )
}
