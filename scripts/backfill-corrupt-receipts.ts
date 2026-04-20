/**
 * Backfill DigitalReceipts whose `dataSnapshot` contains corrupt item data.
 *
 * Root cause:
 *   An earlier version of `generateAndStoreReceipt` read item price from a
 *   non-existent `item.price` field and fell back to "Unknown Product" when
 *   products weren't joined. Result: every receipt showed $0 per item with
 *   "Unknown Product" as the name.
 *
 * What this script does (per affected receipt):
 *   - Rebuilds `dataSnapshot.order.items` from the live OrderItem rows
 *   - Uses `item.productName` (denormalized) first, then `product.name`, then
 *     "Importe personalizado" for custom line items
 *   - Replaces `item.price` with `item.unitPrice` and keeps `item.total`
 *   - Preserves the receipt's accessKey and id so existing links stay valid
 *
 * Idempotency:
 *   Skips receipts where every item has a non-zero price AND no "Unknown"
 *   string in its name.
 *
 * Usage:
 *   Dry run (default, no writes):
 *     npx tsx scripts/backfill-corrupt-receipts.ts
 *   Execute:
 *     EXECUTE=true npx tsx scripts/backfill-corrupt-receipts.ts
 *   Limit to a venue / date range:
 *     VENUE_ID=<id> npx tsx scripts/backfill-corrupt-receipts.ts
 *     SINCE=2026-04-01 UNTIL=2026-04-18 EXECUTE=true npx tsx scripts/...
 */

import prisma from '../src/utils/prismaClient'

const EXECUTE = process.env.EXECUTE === 'true'
const VENUE_ID = process.env.VENUE_ID
const SINCE = process.env.SINCE ? new Date(process.env.SINCE) : undefined
const UNTIL = process.env.UNTIL ? new Date(process.env.UNTIL) : undefined

function looksCorrupt(snapshot: any): boolean {
  const items = snapshot?.order?.items
  if (!Array.isArray(items) || items.length === 0) return false
  return items.some(
    (i: any) =>
      (typeof i.name === 'string' && /unknown/i.test(i.name)) ||
      (typeof i.price === 'number' && i.price === 0 && typeof i.totalPrice === 'number' && i.totalPrice === 0),
  )
}

async function main() {
  console.log('\n' + '='.repeat(60))
  console.log('Backfill corrupt DigitalReceipt snapshots')
  console.log('='.repeat(60))
  console.log(`Mode:   ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}`)
  if (VENUE_ID) console.log(`Venue:  ${VENUE_ID}`)
  if (SINCE) console.log(`Since:  ${SINCE.toISOString()}`)
  if (UNTIL) console.log(`Until:  ${UNTIL.toISOString()}`)
  console.log()

  const receipts = await prisma.digitalReceipt.findMany({
    where: {
      ...(SINCE || UNTIL
        ? {
            createdAt: {
              ...(SINCE && { gte: SINCE }),
              ...(UNTIL && { lte: UNTIL }),
            },
          }
        : {}),
      ...(VENUE_ID && { payment: { venueId: VENUE_ID } }),
    },
    select: {
      id: true,
      paymentId: true,
      dataSnapshot: true,
      payment: { select: { id: true, orderId: true, venueId: true } },
    },
  })

  console.log(`Scanning ${receipts.length} receipts...`)

  const corrupt = receipts.filter(r => looksCorrupt(r.dataSnapshot as any))
  console.log(`Corrupt receipts found: ${corrupt.length}`)

  if (corrupt.length === 0) {
    console.log('\n✅ Nothing to backfill.')
    return
  }

  if (!EXECUTE) {
    console.log('\n--- Preview (first 10) ---')
    corrupt.slice(0, 10).forEach(r => {
      const items = (r.dataSnapshot as any)?.order?.items ?? []
      console.log(
        `Receipt ${r.id} payment=${r.paymentId} itemCount=${items.length} ` +
          `firstName="${items[0]?.name ?? '?'}" firstPrice=${items[0]?.price ?? '?'}`,
      )
    })
    console.log(`\n${corrupt.length} receipts would be fixed. Re-run with EXECUTE=true to apply.`)
    return
  }

  let ok = 0
  let failed = 0

  for (const r of corrupt) {
    try {
      if (!r.payment?.orderId) {
        // Fast payments without an order — can't rebuild items. Skip.
        continue
      }
      const orderItems = await prisma.orderItem.findMany({
        where: { orderId: r.payment.orderId },
        include: {
          product: { select: { name: true } },
          modifiers: { include: { modifier: { select: { name: true, price: true } } } },
        },
      })

      const snapshot = (r.dataSnapshot as any) ?? {}
      const fixedItems = orderItems.map(item => {
        const name = item.productName || item.product?.name || 'Importe personalizado'
        const unitPrice = Number(item.unitPrice) || 0
        const total = Number(item.total) || 0
        return {
          name,
          quantity: item.quantity,
          price: unitPrice,
          totalPrice: total,
          modifiers: item.modifiers.map(m => ({
            name: m.name || m.modifier?.name || 'Modificador',
            price: Number(m.price) || Number(m.modifier?.price) || 0,
          })),
        }
      })

      const updatedSnapshot = {
        ...snapshot,
        order: {
          ...(snapshot.order ?? {}),
          items: fixedItems,
        },
      }

      await prisma.digitalReceipt.update({
        where: { id: r.id },
        data: { dataSnapshot: updatedSnapshot as any },
      })
      ok++
      if (ok % 25 === 0) console.log(`  ...updated ${ok}/${corrupt.length}`)
    } catch (err: any) {
      failed++
      console.error(`❌ Receipt ${r.id}: ${err?.message ?? err}`)
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
