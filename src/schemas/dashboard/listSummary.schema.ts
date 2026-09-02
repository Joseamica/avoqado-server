/**
 * Zod de los listados y resúmenes de /payments y /orders del dashboard (2026-09-01).
 *
 * `pageSize` NO rechaza un valor grande: lo RECORTA al tope (`LIST_PAGE_SIZE_MAX`).
 * Un 400 dejaría sin resumen a los dashboards ya desplegados que todavía mandan
 * `pageSize=10000` en la ventana entre el deploy del backend y el del dashboard; el
 * recorte se declara en `meta.pageSize` + `meta.maxPageSize`, así que nadie puede creer
 * que recibió el total. Los demás campos son cadenas opcionales (listas CSV que parsea
 * el controlador), sin formato impuesto: exactamente lo que el listado aceptaba ya.
 */
import { z } from 'zod'
import { AMOUNT_OPERATORS, LIST_PAGE_SIZE_DEFAULT, LIST_PAGE_SIZE_MAX } from '../../services/dashboard/listSummary.shared'

const csv = z.string().optional()
const page = z.coerce.number().int().min(1).catch(1)
const pageSize = z.coerce
  .number()
  .int()
  .min(1)
  .catch(LIST_PAGE_SIZE_DEFAULT)
  .transform(n => Math.min(n, LIST_PAGE_SIZE_MAX))

const amountOp = z.enum(AMOUNT_OPERATORS as unknown as [string, ...string[]]).optional()
const amountValue = z.coerce.number().optional()

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
  query: z.object({ page, pageSize, ...paymentListFilters }),
})

export const OrdersListQuerySchema = z.object({
  query: z.object({ page, pageSize, ...orderListFilters }),
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
    international: csv,
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
