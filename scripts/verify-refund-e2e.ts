/**
 * Verifier: for a given refund Payment id, assert every side-effect is aligned.
 *
 * Works across all entry points (TPV `recordRefund`, dashboard `issueRefund`,
 * mobile wrapper). Run this after issuing a refund to confirm money and
 * downstream state match the intended contract.
 *
 * Usage:
 *   npx tsx scripts/verify-refund-e2e.ts <refundPaymentId>
 *   npx tsx scripts/verify-refund-e2e.ts --latest          # pick last refund
 *
 * Output: one PASS/FAIL line per check, exit code 0 if all pass, 1 otherwise.
 */

import prisma from '../src/utils/prismaClient'

type Check = { name: string; pass: boolean; detail: string }

async function main() {
  const argv = process.argv.slice(2)
  let refundId = argv[0]
  if (argv.includes('--latest') || !refundId) {
    const latest = await prisma.payment.findFirst({
      where: { type: 'REFUND' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!latest) {
      console.error('No refund payments found.')
      process.exit(1)
    }
    refundId = latest.id
  }

  console.log(`\n=== Refund E2E Verifier === refundId=${refundId}\n`)

  const refund = await prisma.payment.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      type: true,
      amount: true,
      tipAmount: true,
      status: true,
      shiftId: true,
      venueId: true,
      orderId: true,
      method: true,
      processedById: true,
      processorData: true,
      createdAt: true,
    },
  })

  if (!refund) {
    console.error(`Refund ${refundId} not found.`)
    process.exit(1)
  }

  const pd = (refund.processorData as Record<string, unknown> | null) ?? {}
  const originalId = (pd.originalPaymentId as string | undefined) ?? null
  // Total refund cents = abs(sale part) + abs(tip part). Since 2026-04-19 refund
  // Payments split the refund across Payment.amount (sale) and Payment.tipAmount
  // (tip), so the canonical "how much was refunded" needs to sum both.
  const refundCents = Math.abs(Math.round(Number(refund.amount) * 100)) + Math.abs(Math.round(Number(refund.tipAmount ?? 0) * 100))

  const checks: Check[] = []

  // 1. Type + negative amount
  checks.push({
    name: 'refund.type === REFUND && amount < 0',
    pass: refund.type === 'REFUND' && Number(refund.amount) < 0,
    detail: `type=${refund.type} amount=${refund.amount}`,
  })

  // 2. Status COMPLETED
  checks.push({
    name: 'refund.status === COMPLETED',
    pass: refund.status === 'COMPLETED',
    detail: `status=${refund.status}`,
  })

  // 3. processorData.originalPaymentId references an existing REGULAR payment
  const original = originalId
    ? await prisma.payment.findUnique({
        where: { id: originalId },
        select: { id: true, amount: true, tipAmount: true, type: true, venueId: true, processorData: true, shiftId: true },
      })
    : null
  checks.push({
    name: 'original payment exists and type=REGULAR',
    pass: !!original && original.type === 'REGULAR',
    detail: original ? `id=${original.id} type=${original.type}` : 'missing',
  })

  // 4. Same venue on both sides
  checks.push({
    name: 'refund.venueId === original.venueId',
    pass: !!original && refund.venueId === original.venueId,
    detail: original ? `${refund.venueId} vs ${original.venueId}` : 'n/a',
  })

  // 5. Original processorData has entry for this refund (refunds[] or refundHistory[])
  const origPd = (original?.processorData as Record<string, unknown> | null) ?? {}
  const refundsArr = Array.isArray(origPd.refunds) ? (origPd.refunds as any[]) : []
  const refundHistArr = Array.isArray(origPd.refundHistory) ? (origPd.refundHistory as any[]) : []
  const inRefunds = refundsArr.some(r => r?.refundPaymentId === refundId)
  const inHistory = refundHistArr.some(r => r?.refundId === refundId)
  checks.push({
    name: 'original.processorData.refunds[] or refundHistory[] contains this refund',
    pass: inRefunds || inHistory,
    detail: `refunds=${inRefunds} refundHistory=${inHistory}`,
  })

  // 6. refundedAmount on original reflects at least this refund
  const refundedAmount = Number(origPd.refundedAmount ?? 0)
  const refundAmountPesos = Math.abs(Number(refund.amount))
  checks.push({
    name: 'original.processorData.refundedAmount >= this refund amount',
    pass: refundedAmount + 0.001 >= refundAmountPesos,
    detail: `refundedAmount=${refundedAmount} refundAmount=${refundAmountPesos}`,
  })

  // 7. VenueTransaction REFUND exists
  const vt = await prisma.venueTransaction.findFirst({
    where: { paymentId: refundId, type: 'REFUND' },
    select: { id: true, grossAmount: true, status: true },
  })
  checks.push({
    name: 'VenueTransaction(type=REFUND) exists for refund',
    pass: !!vt && Number(vt.grossAmount) < 0,
    detail: vt ? `id=${vt.id} gross=${vt.grossAmount} status=${vt.status}` : 'missing',
  })

  // 8. DigitalReceipt auto-generated
  const receipt = await prisma.digitalReceipt.findFirst({
    where: { paymentId: refundId },
    select: { id: true, accessKey: true, status: true },
  })
  checks.push({
    name: 'DigitalReceipt auto-generated for refund',
    pass: !!receipt && !!receipt.accessKey,
    detail: receipt ? `id=${receipt.id} status=${receipt.status}` : 'missing',
  })

  // 9. CommissionCalculation reverse entry (only if original had commission)
  const origCommission = originalId
    ? await prisma.commissionCalculation.findFirst({
        where: { paymentId: originalId },
        select: { id: true, netCommission: true },
      })
    : null
  const refundCommission = await prisma.commissionCalculation.findFirst({
    where: { paymentId: refundId },
    select: { id: true, netCommission: true, status: true },
  })
  if (origCommission) {
    checks.push({
      name: 'CommissionCalculation reverse exists (negative netCommission)',
      pass: !!refundCommission && Number(refundCommission.netCommission) < 0,
      detail: refundCommission ? `id=${refundCommission.id} net=${refundCommission.netCommission}` : 'missing (original had commission)',
    })
  } else {
    checks.push({
      name: 'Commission revert skipped (original had no commission — expected)',
      pass: true,
      detail: 'no original commission',
    })
  }

  // 10. Shift.totalSales decrement is reflected (only if shiftId resolved)
  const resolvedShiftId = refund.shiftId
  if (resolvedShiftId) {
    // Sum all refunds attributed to this shift to confirm the shift total looks sane
    // We can't deterministically prove the exact decrement happened (no snapshot),
    // but we can confirm: shiftBackfilled marker is present OR the total hasn't
    // accumulated in a visibly-broken way.
    const shiftBackfilled = pd.shiftBackfilled === true
    checks.push({
      name: 'shiftBackfilled marker present (shift decrement was applied in-line)',
      pass: shiftBackfilled,
      detail: `shiftId=${resolvedShiftId} shiftBackfilled=${shiftBackfilled}`,
    })
  } else {
    checks.push({
      name: 'No shift attribution — skip decrement check',
      pass: true,
      detail: 'no shiftId',
    })
  }

  // 11. TransactionCost revert (TPV path adds this; dashboard currently does NOT)
  const txCost = await prisma.transactionCost.findFirst({
    where: { paymentId: refundId },
    select: { id: true, amount: true, grossProfit: true },
  })
  checks.push({
    name: 'TransactionCost revert exists (TPV only — informational)',
    pass: true, // informational: not failing if missing
    detail: txCost
      ? `id=${txCost.id} amount=${txCost.amount} grossProfit=${txCost.grossProfit}`
      : 'missing (OK for dashboard/mobile refunds)',
  })

  // Informational: amountCents in processorData matches
  const pdAmountCents = typeof pd.amountCents === 'number' ? pd.amountCents : null
  checks.push({
    name: 'refund.processorData.amountCents matches abs(amount*100)',
    pass: pdAmountCents === null || pdAmountCents === refundCents,
    detail: `pd=${pdAmountCents} vs computed=${refundCents}`,
  })

  // Print results
  let failed = 0
  for (const c of checks) {
    const tag = c.pass ? '✅ PASS' : '❌ FAIL'
    console.log(`${tag}  ${c.name}`)
    console.log(`        ${c.detail}`)
    if (!c.pass) failed++
  }

  console.log(`\n${failed === 0 ? '🎉 All checks passed.' : `🚨 ${failed} check(s) failed.`}`)

  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Verifier error:', err)
  process.exit(1)
})
