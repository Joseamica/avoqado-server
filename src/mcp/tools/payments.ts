import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PaymentMethod, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

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
            maskedPan: true,
            processor: true,
            authorizationNumber: true,
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
          card: p.cardBrand ? { brand: p.cardBrand, pan: p.maskedPan } : null,
          processor: p.processor,
          authorization: p.authorizationNumber,
          processedBy: p.processedBy ? `${p.processedBy.firstName} ${p.processedBy.lastName}`.trim() : null,
          terminal: p.terminal?.name ?? null,
          orderNumber: p.order?.orderNumber ?? null,
          at: p.createdAt.toISOString(),
        })),
      })
    },
  )
}
