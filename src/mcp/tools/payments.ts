import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentMethod, PaymentType, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { issueRefund, type RefundReason } from '@/services/dashboard/refund.dashboard.service'

// Maps the tool's friendly reasons to the service's RefundReason values.
const REFUND_REASON_MAP: Record<string, RefundReason> = {
  returned_goods: 'RETURNED_GOODS',
  accidental_charge: 'ACCIDENTAL_CHARGE',
  cancelled_order: 'CANCELLED_ORDER',
  fraudulent_charge: 'FRAUDULENT_CHARGE',
  other: 'OTHER',
}

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const round2 = (n: number): number => Math.round(n * 100) / 100

export interface PaymentStatusGroup {
  status: string
  _count: { _all: number }
  _sum: {
    amount: { toString(): string } | null
    tipAmount: { toString(): string } | null
    feeAmount: { toString(): string } | null
    netAmount: { toString(): string } | null
  }
}

export interface PaymentsSummary {
  count: number
  byStatus: Record<string, { count: number; amount: number; tips: number }>
  completed: { count: number; gross: number; tips: number; processorFees: number; net: number }
}

/**
 * Pure: shape a Prisma `groupBy(['status'])` result into a readable payments summary.
 * `completed` isolates real revenue (gross/tips/fees/net) from refunds and failed charges,
 * while `byStatus` keeps the full breakdown so an operator can see money going OUT.
 */
export function buildPaymentsSummary(groups: PaymentStatusGroup[]): PaymentsSummary {
  const out: PaymentsSummary = {
    count: 0,
    byStatus: {},
    completed: { count: 0, gross: 0, tips: 0, processorFees: 0, net: 0 },
  }
  for (const g of groups) {
    const amount = round2(num(g._sum.amount))
    const tips = round2(num(g._sum.tipAmount))
    out.count += g._count._all
    out.byStatus[g.status] = { count: g._count._all, amount, tips }
    if (g.status === 'COMPLETED') {
      out.completed = {
        count: g._count._all,
        gross: amount,
        tips,
        processorFees: round2(num(g._sum.feeAmount)),
        net: round2(num(g._sum.netAmount)),
      }
    }
  }
  return out
}

const STATUS_MAP: Record<string, TransactionStatus> = {
  completed: TransactionStatus.COMPLETED,
  refunded: TransactionStatus.REFUNDED,
  failed: TransactionStatus.FAILED,
  pending: TransactionStatus.PENDING,
  processing: TransactionStatus.PROCESSING,
}
const METHOD_MAP: Record<string, PaymentMethod> = {
  cash: PaymentMethod.CASH,
  credit_card: PaymentMethod.CREDIT_CARD,
  debit_card: PaymentMethod.DEBIT_CARD,
  digital_wallet: PaymentMethod.DIGITAL_WALLET,
  bank_transfer: PaymentMethod.BANK_TRANSFER,
  crypto: PaymentMethod.CRYPTOCURRENCY,
  other: PaymentMethod.OTHER,
}

export function registerPaymentTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_payments',
    'Individual payments/transactions for a venue you can access, over a date range (default last 7 days): each payment\'s amount, tip, method (cash/card/…), card brand & masked PAN, status (completed/refunded/failed/…), processor fee & net deposited, who processed it, terminal, and order number. Plus a summary broken down BY STATUS — so you can see refunds and failed charges (money going out), not just sales. Answers "¿qué pagos se reembolsaron?", "¿hubo cobros fallidos hoy?", "¿cuánto pagué de comisión al procesador?". Pass venueId; optionally status, method, fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue whose payments to read (must be in your scope)'),
      status: z
        .enum(['completed', 'refunded', 'failed', 'pending', 'processing', 'all'])
        .optional()
        .describe("Filter by status (default 'all' — the summary always breaks down every status)"),
      method: z
        .enum(['cash', 'credit_card', 'debit_card', 'digital_wallet', 'bank_transfer', 'crypto', 'other'])
        .optional()
        .describe('Filter by payment method'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(100).optional().describe('Max payments to list (default 25, newest first)'),
    },
    async ({ venueId, status, method, fromDate, toDate, limit }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const where = {
        ...base,
        createdAt: { gte: start, lte: end },
        ...(status && status !== 'all' ? { status: STATUS_MAP[status] } : {}),
        ...(method ? { method: METHOD_MAP[method] } : {}),
      }

      const [groups, payments] = await Promise.all([
        prisma.payment.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
          _sum: { amount: true, tipAmount: true, feeAmount: true, netAmount: true },
        }),
        prisma.payment.findMany({
          where,
          select: {
            id: true,
            status: true,
            method: true,
            source: true,
            amount: true,
            tipAmount: true,
            feeAmount: true,
            netAmount: true,
            cardBrand: true,
            processor: true,
            createdAt: true,
            processedBy: { select: { firstName: true, lastName: true } },
            terminal: { select: { name: true } },
            order: { select: { orderNumber: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit ?? 25,
        }),
      ])

      return text({
        venueId,
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        summary: buildPaymentsSummary(groups as PaymentStatusGroup[]),
        count: payments.length,
        payments: payments.map(p => ({
          id: p.id,
          status: p.status, // COMPLETED | REFUNDED | FAILED | PENDING | PROCESSING
          method: p.method,
          source: p.source,
          amount: num(p.amount),
          tip: num(p.tipAmount),
          processorFee: num(p.feeAmount),
          net: num(p.netAmount), // what actually lands after the processor fee
          cardBrand: p.cardBrand ?? null, // brand only — maskedPan/authorizationNumber are redacted (SENSITIVE_PAYMENT_FIELDS)
          processor: p.processor,
          processedBy: p.processedBy ? `${p.processedBy.firstName} ${p.processedBy.lastName}`.trim() : null,
          terminal: p.terminal?.name ?? null,
          orderNumber: p.order?.orderNumber ?? null,
          at: p.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'list_refunds',
    'Refunds ISSUED for a venue you can access, over a date range (default last 7 days). Mirrors the dashboard "Reembolsos" report. Each refund: amount given back (sale + tip, as positive magnitudes), payment method, reason (RETURNED_GOODS/ACCIDENTAL_CHARGE/CANCELLED_ORDER/FRAUDULENT_CHARGE/OTHER), free-text note, the original order number, who processed it, and when. Plus totals (count + total refunded) and a breakdown BY REASON. Use this for "¿cuánto devolvimos esta semana?", "¿por qué se hicieron los reembolsos?", "¿quién procesó los reembolsos?". Refunds are Payment rows with type=REFUND — list_payments (filtered by status) does NOT surface these. Pass venueId; optionally fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().describe('Venue whose refunds to read (must be in your scope)'),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().positive().max(100).optional().describe('Max refunds to list (default 25, newest first)'),
    },
    async ({ venueId, fromDate, toDate, limit }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      const tz = venue?.timezone || 'America/Mexico_City'
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const where = {
        ...base,
        type: PaymentType.REFUND,
        status: { not: TransactionStatus.PENDING },
        createdAt: { gte: start, lte: end },
      }

      const rows = await prisma.payment.findMany({
        where,
        select: {
          id: true,
          amount: true,
          tipAmount: true,
          status: true,
          method: true,
          createdAt: true,
          processorData: true,
          processedBy: { select: { firstName: true, lastName: true } },
          order: { select: { orderNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 25,
      })

      const refunds = rows.map(r => {
        const pd = (r.processorData as Record<string, unknown> | null) || {}
        const sale = Math.abs(num(r.amount))
        const tip = Math.abs(num(r.tipAmount))
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          orderNumber: r.order?.orderNumber ?? null,
          method: r.method,
          reason: typeof pd.refundReason === 'string' ? pd.refundReason : null,
          note: typeof pd.note === 'string' ? pd.note : null,
          saleAmount: sale,
          tipAmount: tip,
          totalAmount: round2(sale + tip),
          status: r.status,
          processedBy: r.processedBy ? `${r.processedBy.firstName} ${r.processedBy.lastName}`.trim() : null,
        }
      })

      const byReason: Record<string, { count: number; amount: number }> = {}
      let totalRefunded = 0
      for (const r of refunds) {
        totalRefunded += r.totalAmount
        const key = r.reason ?? 'UNKNOWN'
        byReason[key] = byReason[key] || { count: 0, amount: 0 }
        byReason[key].count += 1
        byReason[key].amount = round2(byReason[key].amount + r.totalAmount)
      }

      return text({
        venueId,
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        summary: { count: refunds.length, totalRefunded: round2(totalRefunded), byReason },
        count: refunds.length,
        refunds,
      })
    },
  )

  server.tool(
    'issue_refund',
    '🔴 CRITICAL (returns money to a customer). Issue a refund on a COMPLETED payment of a venue you can access. Identify the payment by its id (from list_payments), give the amount in pesos (partial allowed; the service enforces the remaining refundable) and a reason. By DEFAULT this only PREVIEWS the refund (payment details + what would be returned); to actually execute it call again with confirm:true. Cash refunds are recorded; card refunds follow the processor flow. This WRITES MONEY — requires payments:refund.',
    {
      venueId: z.string().describe('Venue that owns the payment (must be in your scope)'),
      paymentId: z.string().min(1).describe('The payment id (from list_payments)'),
      amount: z.number().positive().describe('Amount to refund in pesos (major units), e.g. 150.50'),
      reason: z
        .enum(['returned_goods', 'accidental_charge', 'cancelled_order', 'fraudulent_charge', 'other'])
        .describe('Why the refund is issued'),
      note: z.string().optional().describe('Free-text note for the audit trail'),
      confirm: z.boolean().optional().describe('Must be true to actually issue the refund; without it you get a preview'),
    },
    async ({ venueId, paymentId, amount, reason, note, confirm }) => {
      const base = guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payments:refund', venueId) // write gate (per-venue role)

      // Resolve the payment WITHIN scope for the preview (the service re-validates everything under a row lock).
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, ...base },
        select: { amount: true, tipAmount: true, method: true, status: true, type: true, createdAt: true, order: { select: { orderNumber: true } } },
      })
      if (!payment) return text({ ok: false, error: 'No encontré ese pago en tus locales.' })
      if (payment.status !== TransactionStatus.COMPLETED) {
        return text({ ok: false, error: `Solo se puede reembolsar un pago COMPLETED (este está ${payment.status}).` })
      }
      const originalTotal = round2(num(payment.amount) + num(payment.tipAmount))
      if (amount > originalTotal) {
        return text({ ok: false, error: `El reembolso ($${amount}) excede el total original del pago ($${originalTotal}).` })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            payment: {
              id: paymentId,
              orderNumber: payment.order?.orderNumber ?? null,
              method: payment.method,
              originalTotal,
              paidAt: payment.createdAt.toISOString(),
            },
            refundAmount: amount,
            reason: REFUND_REASON_MAP[reason],
            note: note ?? null,
          },
          message: `Esto DEVOLVERÁ $${amount} del pago de $${originalTotal} (orden ${payment.order?.orderNumber ?? 's/n'}). Vuelve a llamar con confirm:true para ejecutar.`,
        })
      }

      try {
        const result = await issueRefund({
          venueId,
          paymentId,
          amount: Math.round(amount * 100), // service expects cents
          reason: REFUND_REASON_MAP[reason],
          staffId: scope.staffId,
          ...(note ? { note } : {}),
        })
        await auditMcpWrite(scope, {
          action: 'REFUND_ISSUED',
          entity: 'Payment',
          entityId: result.refundId,
          venueId,
          data: { originalPaymentId: paymentId, amount: result.amount, reason: REFUND_REASON_MAP[reason], note: note ?? null },
        })
        return text({
          ok: true,
          refund: {
            refundId: result.refundId,
            amount: result.amount,
            remainingRefundable: result.remainingRefundable,
            status: result.status,
          },
        })
      } catch (err) {
        return text({ ok: false, error: (err as Error).message })
      }
    },
  )
}
