/**
 * Zod de los listados y resúmenes de /payments y /orders del dashboard (2026-09-01).
 *
 * `paginated-v1` es opt-in: aplica el tope moderno de 100. Sin ese modo se conserva
 * temporalmente el pageSize de los bundles ya publicados (hasta el techo legacy de
 * 10,000) para que sus tarjetas no sumen un subconjunto como si fuera el total.
 */
import { z } from 'zod'
import { AMOUNT_OPERATORS, LEGACY_LIST_PAGE_SIZE_MAX, LIST_PAGE_SIZE_DEFAULT } from '../../services/dashboard/listSummary.shared'

/** CSV, o el mismo parámetro repetido (`?methods=CASH&methods=CARD`, que Express entrega como arreglo). */
const csv = z.union([z.string(), z.array(z.string())]).optional()
const page = z.coerce.number().int().min(1).catch(1)
const pageSize = z.coerce
  .number()
  .int()
  .min(1)
  .catch(LIST_PAGE_SIZE_DEFAULT)
  .transform(n => Math.min(n, LEGACY_LIST_PAGE_SIZE_MAX))
const responseMode = z.enum(['paginated-v1']).optional()

const amountOp = z
  .enum(AMOUNT_OPERATORS as unknown as [string, ...string[]], {
    errorMap: () => ({ message: 'Operador de monto inválido (gt, lt, eq, between)' }),
  })
  .optional()
const amountValue = z.coerce.number({ invalid_type_error: 'El monto debe ser un número' }).optional()
const yesNoCsv = csv.refine(
  v => (v === undefined ? true : (Array.isArray(v) ? v.join(',') : v).split(',').every(x => ['yes', 'no', ''].includes(x.trim()))),
  {
    message: "international sólo acepta 'yes' y/o 'no'",
  },
)

/** Filtros del listado de pagos (los mismos de siempre, incluidos los de UN valor). */
const paymentListFilters = {
  merchantAccountIds: csv,
  methods: csv,
  sources: csv,
  staffIds: csv,
  merchantAccountId: z.string().optional(),
  method: z.string().optional(),
  source: z.string().optional(),
  staffId: z.string().optional(),
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
}

/** Filtros del listado de órdenes. */
const orderListFilters = {
  statuses: csv,
  types: csv,
  tableIds: csv,
  staffIds: csv,
  search: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
}

export const PaymentsListQuerySchema = z.object({
  query: z.object({ page, pageSize, responseMode, ...paymentListFilters }),
})

export const OrdersListQuerySchema = z.object({
  query: z.object({ page, pageSize, responseMode, ...orderListFilters }),
})

/** Los filtros que hoy aplica el navegador, ahora como parámetros del resumen. */
export const PaymentsSummaryQuerySchema = z.object({
  query: z.object({
    ...paymentListFilters,
    subtotalOp: amountOp,
    subtotalValue: amountValue,
    subtotalValue2: amountValue,
    tipOp: amountOp,
    tipValue: amountValue,
    tipValue2: amountValue,
    totalOp: amountOp,
    totalValue: amountValue,
    totalValue2: amountValue,
    /** CSV de 'yes' | 'no' */
    international: yesNoCsv,
    /** CSV de marcas (VISA, MASTERCARD, …) */
    cardBrands: csv,
  }),
})

export const OrdersSummaryQuerySchema = z.object({
  query: z.object({
    ...orderListFilters,
    totalOp: amountOp,
    totalValue: amountValue,
    totalValue2: amountValue,
    tipOp: amountOp,
    tipValue: amountValue,
    tipValue2: amountValue,
  }),
})
