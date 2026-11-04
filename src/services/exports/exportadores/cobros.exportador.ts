import type { ExportColumnDef } from '@/services/dashboard/export.helpers'
import { countPaymentsForExportHasta, fetchPaymentsExportPage, type PaymentFilters } from '@/services/dashboard/payment.dashboard.service'
import { construirWhereKeyset, fecha, lista, str } from './comun'
import type { Exportador } from './types'

export type FilaCobro = Awaited<ReturnType<typeof fetchPaymentsExportPage>>[number]

// Mismo registro que el GET viejo (`payment.dashboard.controller.ts`, `exportPaymentsData`); ahora vive aquí y el controller lo importa.
export const COBROS_COLUMNAS: ExportColumnDef<FilaCobro>[] = [
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
    value: r => r.merchantAccount?.displayName || r.merchantAccount?.externalMerchantId || r.ecommerceMerchant?.channelName || '',
  },
  { id: 'method', label: 'Método', value: r => r.method ?? '' },
  { id: 'source', label: 'Origen', value: r => r.source ?? '' },
  {
    id: 'international',
    label: 'Internacional',
    value: r => {
      const raw = (r.processorData as { isInternational?: unknown } | null)?.isInternational
      return raw === true || raw === 'true' ? 'Sí' : 'No'
    },
  },
  { id: 'cardBrand', label: 'Marca', value: r => r.cardBrand ?? '' },
  { id: 'last4', label: 'Últimos 4', value: r => (r.maskedPan ? r.maskedPan.slice(-4) : '') },
  { id: 'amount', label: 'Subtotal', value: r => Number(r.amount) || 0 },
  { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
  { id: 'totalAmount', label: 'Total', value: r => (Number(r.amount) || 0) + (Number(r.tipAmount) || 0) },
  { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
]

export const cobros: Exportador<PaymentFilters, FilaCobro> = {
  kind: 'cobros',
  titulo: 'Pagos',
  nombreArchivo: 'payments', // el mismo nombre de archivo que baja hoy
  permiso: 'payments:read',
  parsearFiltros(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    return {
      merchantAccountIds: lista(r.merchantAccountIds),
      methods: lista(r.methods),
      sources: lista(r.sources),
      staffIds: lista(r.staffIds),
      search: str(r.search),
      startDate: fecha(r.startDate, 'startDate'),
      endDate: fecha(r.endDate, 'endDate'),
    }
  },
  async autorizar() {
    return null // hoy: sólo `payments:read` en la ruta, sin función de plan
  },
  columnas: COBROS_COLUMNAS,
  contar: (venueId, f, corte) => countPaymentsForExportHasta(venueId, f, corte),
  pagina: (venueId, f, corte, despuesDe, limite) => fetchPaymentsExportPage(venueId, f, corte, construirWhereKeyset(despuesDe), limite),
  cursorDe: f => ({ createdAt: f.createdAt.toISOString(), id: f.id }),
}
