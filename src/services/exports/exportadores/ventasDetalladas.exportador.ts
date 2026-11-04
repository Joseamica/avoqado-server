import { BadRequestError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import type { ExportColumnDef } from '@/services/dashboard/export.helpers'
import { RESPUESTA_RANGO_FUERA_DEL_PLAN, rangoBloqueadoPorPlan } from '@/services/dashboard/salesSummaryPlanRange'
import {
  countSalesSummaryDetailRowsHasta,
  fetchSalesSummaryDetailPage,
  type CardTypeFilter,
  type PaymentMethodFilter,
  type SalesSummaryExportFilters,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { construirWhereKeyset, fecha, lista, sinFuncion, str } from './comun'
import type { Exportador } from './types'

export type FilaVentaDetallada = Awaited<ReturnType<typeof fetchSalesSummaryDetailPage>>[number]

// Mismo registro de columnas que el GET viejo (sales-summary.dashboard.controller.ts); ahora vive aquí y el controller lo importa.
export const VENTAS_DETALLADAS_COLUMNAS: ExportColumnDef<FilaVentaDetallada>[] = [
  { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
  { id: 'paymentId', label: 'ID', value: r => r.id },
  {
    id: 'waiterName',
    label: 'Mesero',
    value: r => (r.processedBy ? `${r.processedBy.firstName ?? ''} ${r.processedBy.lastName ?? ''}`.trim() : ''),
  },
  {
    id: 'merchantAccount',
    label: 'Cuenta Comercial',
    value: r => r.merchantAccount?.displayName || r.merchantAccount?.externalMerchantId || '',
  },
  { id: 'method', label: 'Método', value: r => r.method ?? '' },
  { id: 'cardBrand', label: 'Marca', value: r => r.cardBrand ?? '' },
  { id: 'last4', label: 'Últimos 4', value: r => (r.maskedPan ? r.maskedPan.slice(-4) : '') },
  {
    id: 'international',
    label: 'Internacional',
    value: r => ((r.processorData as { isInternational?: boolean } | null)?.isInternational ? 'Sí' : 'No'),
  },
  { id: 'amount', label: 'Subtotal', value: r => Number(r.amount) || 0 },
  { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
  { id: 'totalAmount', label: 'Total', value: r => (Number(r.amount) || 0) + (Number(r.tipAmount) || 0) },
  { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
  { id: 'source', label: 'Origen', value: r => r.source ?? '' },
]

const METODOS: PaymentMethodFilter[] = ['CASH', 'CARD', 'QR_LEGACY', 'OTHER']
const TARJETAS: CardTypeFilter[] = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']

export const ventasDetalladas: Exportador<SalesSummaryExportFilters, FilaVentaDetallada> = {
  kind: 'ventas-detalladas',
  titulo: 'Ventas detalladas',
  nombreArchivo: 'ventas-detalladas',
  permiso: 'reports:read',
  parsearFiltros(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    const startDate = fecha(r.startDate, 'startDate')
    const endDate = fecha(r.endDate, 'endDate')
    if (!startDate) throw new BadRequestError('startDate is required (ISO date string)')
    if (!endDate) throw new BadRequestError('endDate is required (ISO date string)')
    const paymentMethod = str(r.paymentMethod) as PaymentMethodFilter | undefined
    if (paymentMethod && !METODOS.includes(paymentMethod))
      throw new BadRequestError(`Invalid paymentMethod. Must be one of: ${METODOS.join(', ')}`)
    if (paymentMethod === 'QR_LEGACY')
      throw new BadRequestError('QR_LEGACY detailed export is not available; legacy QR transactions are not stored per-payment.')
    const cardType = str(r.cardType) as CardTypeFilter | undefined
    if (cardType && !TARJETAS.includes(cardType)) throw new BadRequestError(`Invalid cardType. Must be one of: ${TARJETAS.join(', ')}`)
    return {
      startDate,
      endDate,
      paymentMethod,
      cardType,
      merchantAccountId: str(r.merchantAccountId),
      staffIds: lista(r.staffIds),
      shiftId: str(r.shiftId),
    }
  },
  // Mismo orden que el GET viejo: primero el recorte del plan Gratis (middleware de la ruta), luego la función PREMIUM.
  async autorizar(ctx, f) {
    if (await rangoBloqueadoPorPlan(ctx.venueId, f.startDate, f.endDate))
      return { status: 403, body: { ...RESPUESTA_RANGO_FUERA_DEL_PLAN } }
    if (ctx.esSuperadmin || (await venueHasFeatureAccess(ctx.venueId, 'TRANSACTION_EXPORT'))) return null
    return sinFuncion('TRANSACTION_EXPORT')
  },
  columnas: VENTAS_DETALLADAS_COLUMNAS,
  contar: (venueId, f, corte) => countSalesSummaryDetailRowsHasta(venueId, f, corte),
  pagina: (venueId, f, corte, despuesDe, limite) => fetchSalesSummaryDetailPage(venueId, f, corte, construirWhereKeyset(despuesDe), limite),
  cursorDe: f => ({ createdAt: f.createdAt.toISOString(), id: f.id }),
}
