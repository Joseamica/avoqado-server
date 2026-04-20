/**
 * Backfill missing "Importe personalizado" OrderItems.
 *
 * Root cause:
 *   An earlier version of the mobile create-order controller rejected items
 *   without productId. When a mobile cart contained a custom amount + products,
 *   the cash payment was recorded with the FULL amount (including custom), but
 *   the custom amount was NOT persisted as an OrderItem. This leaves orders
 *   where sum(items.total) < sum(payments.amount).
 *
 * What this script does (per affected order):
 *   1. Computes delta = sum(payment.amount) - sum(item.total) for REGULAR completed payments
 *   2. If delta > 0 and the order has no productId=null ("custom") item yet, creates
 *      a synthetic OrderItem { productName: 'Importe personalizado', unitPrice: delta,
 *      quantity: 1, total: delta, taxAmount: 0 }
 *   3. Updates order.subtotal to new items-total and order.total to subtotal + tipAmount
 *
 * Idempotency:
 *   Skips orders that already have a productId=null OrderItem, or where delta <= 0.01.
 *
 * SAFETY:
 *   Only orders with source in {AVOQADO_IOS, AVOQADO_ANDROID, APP} are considered.
 *   TPV, QR, WEB, POS, etc. are NEVER touched because a mismatch there usually
 *   means something legitimate (fees, gift cards, manual adjustments) rather
 *   than the mobile-specific bug this script targets.
 *
 *   Orders with any non-zero refund (processorData.refundedAmount > 0) are
 *   also skipped — refunds mutate the math and require manual review.
 *
 * Usage:
 *   Dry run (default, no writes):
 *     npx tsx scripts/backfill-missing-custom-items.ts
 *   Execute:
 *     EXECUTE=true npx tsx scripts/backfill-missing-custom-items.ts
 *   Limit to one venue:
 *     VENUE_ID=<venueId> npx tsx scripts/backfill-missing-custom-items.ts
 *   Override sources (CSV):
 *     SOURCES=AVOQADO_ANDROID,AVOQADO_IOS npx tsx scripts/backfill-missing-custom-items.ts
 *   Limit to a date range (ISO):
 *     SINCE=2026-04-01 UNTIL=2026-04-18 npx tsx scripts/backfill-missing-custom-items.ts
 */

import { Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'

const EXECUTE = process.env.EXECUTE === 'true'
const VENUE_ID = process.env.VENUE_ID
const SINCE = process.env.SINCE ? new Date(process.env.SINCE) : undefined
const UNTIL = process.env.UNTIL ? new Date(process.env.UNTIL) : undefined
const SOURCES = (process.env.SOURCES ?? 'AVOQADO_IOS,AVOQADO_ANDROID,APP')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const TOLERANCE = 0.01 // ignore sub-cent drift

async function main() {
  console.log('\n' + '='.repeat(60))
  console.log('Backfill missing custom OrderItems')
  console.log('='.repeat(60))
  console.log(`Mode:       ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}`)
  console.log(`Sources:    ${SOURCES.join(', ')}`)
  if (VENUE_ID) console.log(`Venue:      ${VENUE_ID}`)
  if (SINCE) console.log(`Since:      ${SINCE.toISOString()}`)
  if (UNTIL) console.log(`Until:      ${UNTIL.toISOString()}`)
  console.log()

  const orders = await prisma.order.findMany({
    where: {
      source: { in: SOURCES as any },
      ...(VENUE_ID && { venueId: VENUE_ID }),
      ...(SINCE || UNTIL
        ? {
            createdAt: {
              ...(SINCE && { gte: SINCE }),
              ...(UNTIL && { lte: UNTIL }),
            },
          }
        : {}),
      payments: {
        some: { type: 'REGULAR', status: 'COMPLETED' },
      },
    },
    include: {
      items: { select: { id: true, productId: true, total: true, sequence: true } },
      payments: {
        where: { type: 'REGULAR', status: 'COMPLETED' },
        select: { id: true, amount: true, processorData: true },
      },
    },
  })

  console.log(`Scanning ${orders.length} orders...`)

  type Fix = {
    orderId: string
    orderNumber: string
    venueId: string
    delta: number
    currentSubtotal: number
    newSubtotal: number
    tipAmount: number
    nextSequence: number
  }
  const fixes: Fix[] = []
  const sourceBreakdown: Record<string, number> = {}
  let skippedHasCustom = 0
  let skippedClean = 0
  let skippedNegative = 0
  let skippedNoPayments = 0
  let skippedHasRefund = 0

  for (const order of orders) {
    if (order.payments.length === 0) {
      skippedNoPayments++
      continue
    }

    const hasRefund = order.payments.some(p => {
      const pd = (p.processorData as Record<string, unknown> | null) ?? {}
      return Number(pd.refundedAmount ?? 0) > 0
    })
    if (hasRefund) {
      skippedHasRefund++
      continue
    }

    const hasCustom = order.items.some(i => !i.productId)
    if (hasCustom) {
      skippedHasCustom++
      continue
    }

    const itemsTotal = order.items.reduce((s, i) => s + Number(i.total || 0), 0)
    const paymentsTotal = order.payments.reduce((s, p) => s + Number(p.amount || 0), 0)
    const delta = Number((paymentsTotal - itemsTotal).toFixed(2))

    if (delta <= TOLERANCE) {
      skippedClean++
      continue
    }
    if (delta < 0) {
      skippedNegative++
      continue
    }

    const currentSubtotal = Number(order.subtotal || 0)
    const tipAmount = Number(order.tipAmount || 0)
    const nextSequence = Math.max(-1, ...order.items.map(i => i.sequence ?? 0)) + 1

    sourceBreakdown[order.source] = (sourceBreakdown[order.source] ?? 0) + 1
    fixes.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: order.venueId,
      delta,
      currentSubtotal,
      newSubtotal: Number((itemsTotal + delta).toFixed(2)),
      tipAmount,
      nextSequence,
    })
  }

  console.log()
  console.log(`Needing backfill:                    ${fixes.length}`)
  console.log(`Skipped (already has custom item):   ${skippedHasCustom}`)
  console.log(`Skipped (items already match):       ${skippedClean}`)
  console.log(`Skipped (payments < items, weird):   ${skippedNegative}`)
  console.log(`Skipped (no REGULAR payments):       ${skippedNoPayments}`)
  console.log(`Skipped (has refund, needs review):  ${skippedHasRefund}`)
  if (Object.keys(sourceBreakdown).length > 0) {
    console.log('\nBreakdown by source (orders needing fix):')
    Object.entries(sourceBreakdown).forEach(([src, count]) => {
      console.log(`  ${src.padEnd(20)} ${count}`)
    })
  }

  if (fixes.length === 0) {
    console.log('\n✅ Nothing to backfill.')
    return
  }

  console.log('\n--- Preview (first 20) ---')
  fixes.slice(0, 20).forEach(f => {
    console.log(
      `Order ${f.orderNumber.padEnd(20)} venue=${f.venueId.slice(0, 10)}… ` +
        `delta=$${f.delta.toFixed(2).padStart(8)}  ` +
        `subtotal ${f.currentSubtotal.toFixed(2)} -> ${f.newSubtotal.toFixed(2)}`,
    )
  })
  if (fixes.length > 20) console.log(`...and ${fixes.length - 20} more`)

  if (!EXECUTE) {
    console.log(`\nDry run — no writes. Re-run with EXECUTE=true to apply.`)
    return
  }

  console.log('\n--- Executing ---')
  let ok = 0
  let failed = 0

  for (const fix of fixes) {
    try {
      await prisma.$transaction(async tx => {
        await tx.orderItem.create({
          data: {
            orderId: fix.orderId,
            productId: null,
            productName: 'Importe personalizado',
            productSku: null,
            categoryName: null,
            quantity: 1,
            unitPrice: new Prisma.Decimal(fix.delta),
            discountAmount: new Prisma.Decimal(0),
            taxAmount: new Prisma.Decimal(0),
            total: new Prisma.Decimal(fix.delta),
            notes: 'Backfilled — legacy payment where custom amount was not saved as line item',
            sequence: fix.nextSequence,
          },
        })

        await tx.order.update({
          where: { id: fix.orderId },
          data: {
            subtotal: new Prisma.Decimal(fix.newSubtotal),
            total: new Prisma.Decimal(Number((fix.newSubtotal + fix.tipAmount).toFixed(2))),
          },
        })
      })
      ok++
      if (ok % 25 === 0) console.log(`  ...processed ${ok}/${fixes.length}`)
    } catch (err: any) {
      failed++
      console.error(`❌ ${fix.orderNumber} (${fix.orderId}): ${err?.message ?? err}`)
    }
  }

  console.log(`\n✅ Updated: ${ok}`)
  if (failed > 0) console.log(`❌ Failed:  ${failed}`)
}

main()
  .catch(err => {
    console.error('\n💥 Script crashed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
