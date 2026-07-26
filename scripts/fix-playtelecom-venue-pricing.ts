/**
 * fix-playtelecom-venue-pricing.ts — re-runnable data fix (NOT a one-off)
 *
 * PROBLEM
 * -------
 * A venue with no active `VenuePricingStructure` makes Step 4 of
 * `createTransactionCost()` throw (`src/services/payments/transactionCost.service.ts:335`).
 * The TPV caller catches it non-blockingly (`payment.tpv.service.ts:1862`), so the cobro
 * succeeds — but the `Payment` is left with `feeAmount = 0` and `netAmount = gross`, while
 * Blumon still charges Avoqado its ~1.68% debit cost. Silent negative margin.
 *
 * This is a CONFIGURATION gap, not a code regression: PlayTelecom onboards new BAE stores
 * continuously and each new venue arrives without pricing until someone creates it. Hence a
 * RE-RUNNABLE script (resolves everything by name/rule at runtime, idempotent) rather than a
 * change to `bulkVenueCreation.service.ts` — see `.claude/rules/playtelecom-vertical.md`:
 * "Fix those gaps via the re-runnable by-name scripts, never by changing the shared creation
 * path" (founder, 2026-06-23).
 *
 * WHAT IT DOES
 * ------------
 *   PART A — For every ACTIVE venue in the org that can already take money (has a Terminal, or
 *            has payment history) but has NO active PRIMARY `VenuePricingStructure`, create one
 *            by CLONING the org's canonical rate
 *            (derived at runtime from the venues that already have pricing — never hardcoded).
 *            `effectiveFrom` is backdated to cover the venue's existing payment history.
 *
 *   PART B — Backfill the `TransactionCost` of payments that were processed while their venue
 *            had no pricing, and repair `Payment.feeAmount` / `netAmount` /
 *            `VenueTransaction` exactly like the TPV path does
 *            (`payment.tpv.service.ts:1837-1856`).
 *
 * SAFETY
 * ------
 *   - Dry-run by default. Writes ONLY with `--apply`.
 *   - Idempotent: skips venues that already have pricing and payments that already have a
 *     TransactionCost (`TransactionCost.paymentId` is `@unique`).
 *   - Resolve-don't-guess: if the org's existing venues disagree on the rate, it ABORTS and
 *     prints the variants instead of picking one.
 *   - Never widens scope: only the resolved org, only PRIMARY, only non-CASH Avoqado payments
 *     with money on them. Everything skipped is reported, never silently dropped.
 *   - Writes `ActivityLog` for both parts (`.claude/rules/critical-warnings.md`).
 *
 * USAGE
 *   DATABASE_URL=$RENDER_DATABASE_URL npx tsx scripts/fix-playtelecom-venue-pricing.ts            # dry-run
 *   DATABASE_URL=$RENDER_DATABASE_URL npx tsx scripts/fix-playtelecom-venue-pricing.ts --apply    # write
 *   ... --org="Play Telecom"   |   ... --org-id=<cuid>   |   ... --actor=<staffId>
 *
 * NOTE — why NOT `OrganizationPricingStructure` (evaluated and rejected, 2026-07-24):
 *   `getEffectivePricing()` does fall back to org-level pricing, which would cover all 45
 *   venues with a single row. But `TransactionCost.venuePricingStructureId` has an FK to
 *   `VenuePricingStructure` ONLY, so `createTransactionCost` would resolve an
 *   `OrganizationPricingStructure` id and then die on that FK — trading a silent Step-4
 *   failure for a silent P2003. Verified in prod: 0 TransactionCost rows point at an
 *   org-level pricing id. Venue-level rows are the only path that works today.
 */

import { AccountType, OriginSystem, PaymentMethod, Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'
import { createTransactionCost } from '../src/services/payments/transactionCost.service'
import { logAction } from '../src/services/dashboard/activity-log.service'

// ─── args ───────────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply')
const ORG_ID_ARG = process.argv.find(a => a.startsWith('--org-id='))?.split('=')[1]
const ORG_NAME_ARG = process.argv.find(a => a.startsWith('--org='))?.split('=')[1] ?? 'play telecom'
const ACTOR_ARG = process.argv.find(a => a.startsWith('--actor='))?.split('=')[1] ?? null

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

const money = (n: number) => `$${n.toFixed(2)}`
const pct = (r: Prisma.Decimal | number) => `${(Number(r) * 100).toFixed(2)}%`

// ─── the shape we clone ─────────────────────────────────────────────────────
type CanonicalRate = {
  debitRate: Prisma.Decimal
  creditRate: Prisma.Decimal
  amexRate: Prisma.Decimal
  internationalRate: Prisma.Decimal
  includesTax: boolean | null
  taxRate: Prisma.Decimal
  fixedFeePerTransaction: Prisma.Decimal | null
  monthlyServiceFee: Prisma.Decimal | null
  minimumMonthlyVolume: Prisma.Decimal | null
  volumePenalty: Prisma.Decimal | null
}

const rateKey = (r: CanonicalRate) =>
  [
    r.debitRate,
    r.creditRate,
    r.amexRate,
    r.internationalRate,
    r.includesTax,
    r.taxRate,
    r.fixedFeePerTransaction,
    r.monthlyServiceFee,
    r.minimumMonthlyVolume,
    r.volumePenalty,
  ]
    .map(v => (v === null || v === undefined ? 'null' : String(v)))
    .join('|')

async function resolveOrganization() {
  if (ORG_ID_ARG) {
    const org = await prisma.organization.findUnique({ where: { id: ORG_ID_ARG }, select: { id: true, name: true } })
    if (!org) throw new Error(`No existe la organización ${ORG_ID_ARG}`)
    return org
  }

  const target = norm(ORG_NAME_ARG)
  const all = await prisma.organization.findMany({ select: { id: true, name: true } })
  // Exact name wins over substring: prod has both "PlayTelecom" and "Play Telecom Pruebas",
  // and a substring match alone would make the real org ambiguous with its test twin.
  const exact = all.filter(o => norm(o.name) === target)
  const matches = exact.length > 0 ? exact : all.filter(o => norm(o.name).includes(target))

  if (matches.length === 0) throw new Error(`Ninguna organización coincide con "${ORG_NAME_ARG}"`)
  if (matches.length > 1) {
    throw new Error(
      `"${ORG_NAME_ARG}" es ambiguo — coincide con ${matches.length} organizaciones:\n` +
        matches.map(o => `    ${o.id}  ${o.name}`).join('\n') +
        `\n  Vuelve a correr con --org-id=<cuid>.`,
    )
  }
  return matches[0]
}

/**
 * Derive the org's canonical PRIMARY rate from the venues that already have one.
 * Aborts on disagreement instead of guessing (resolve-don't-guess).
 */
async function resolveCanonicalRate(organizationId: string): Promise<CanonicalRate> {
  const existing = await prisma.venuePricingStructure.findMany({
    where: { active: true, accountType: AccountType.PRIMARY, venue: { organizationId } },
    select: {
      debitRate: true,
      creditRate: true,
      amexRate: true,
      internationalRate: true,
      includesTax: true,
      taxRate: true,
      fixedFeePerTransaction: true,
      monthlyServiceFee: true,
      minimumMonthlyVolume: true,
      volumePenalty: true,
      venue: { select: { name: true } },
    },
  })

  if (existing.length === 0) {
    throw new Error(
      'Ningún venue de esta organización tiene VenuePricingStructure activa, así que no hay tarifa canónica que clonar.\n' +
        '  Crea la primera a mano (es una decisión comercial, no la puede inferir un script) y vuelve a correr esto.',
    )
  }

  const variants = new Map<string, { rate: CanonicalRate; venues: string[] }>()
  for (const row of existing) {
    const { venue, ...rate } = row
    const key = rateKey(rate as CanonicalRate)
    const entry = variants.get(key)
    if (entry) entry.venues.push(venue.name)
    else variants.set(key, { rate: rate as CanonicalRate, venues: [venue.name] })
  }

  if (variants.size > 1) {
    const detail = [...variants.values()]
      .sort((a, b) => b.venues.length - a.venues.length)
      .map(
        v =>
          `    ${v.venues.length} venue(s): déb ${pct(v.rate.debitRate)} / créd ${pct(v.rate.creditRate)} / amex ${pct(
            v.rate.amexRate,
          )} / intl ${pct(v.rate.internationalRate)} / fijo ${v.rate.fixedFeePerTransaction ?? '—'}` +
          `\n      ej.: ${v.venues.slice(0, 4).join(', ')}${v.venues.length > 4 ? '…' : ''}`,
      )
      .join('\n')
    throw new Error(
      `La organización tiene ${variants.size} tarifas distintas — no hay una canónica que clonar sin adivinar:\n${detail}\n` +
        `  Decide cuál aplica a los venues nuevos y créala a mano, o unifica las existentes.`,
    )
  }

  return [...variants.values()][0].rate
}

async function main() {
  const org = await resolveOrganization()
  const canonical = await resolveCanonicalRate(org.id)

  console.log(`\n${'═'.repeat(78)}`)
  console.log(`  ${APPLY ? '⚠️  APPLY — se ESCRIBE en la base' : '🔍 DRY-RUN — no se escribe nada'}`)
  console.log(`  Organización: ${org.name}  (${org.id})`)
  console.log(`${'═'.repeat(78)}\n`)

  console.log('Tarifa canónica derivada de los venues ya configurados:')
  console.log(
    `  débito ${pct(canonical.debitRate)} · crédito ${pct(canonical.creditRate)} · amex ${pct(
      canonical.amexRate,
    )} · internacional ${pct(canonical.internationalRate)}`,
  )
  console.log(
    `  fijo/tx ${canonical.fixedFeePerTransaction ?? '—'} · mensualidad ${canonical.monthlyServiceFee ?? '—'} · ` +
      `includesTax ${canonical.includesTax === null ? 'null (legacy → se trata como YA incluye IVA)' : canonical.includesTax} · ` +
      `taxRate ${pct(canonical.taxRate)}\n`,
  )

  // ══ PART A — crear VenuePricingStructure faltantes ════════════════════════
  console.log(`${'─'.repeat(78)}\nPARTE A — VenuePricingStructure faltantes\n${'─'.repeat(78)}`)

  const venues = await prisma.venue.findMany({
    where: { organizationId: org.id, active: true },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { terminals: true, payments: true } },
      pricingStructures: { where: { active: true, accountType: AccountType.PRIMARY }, select: { id: true } },
    },
    orderBy: { name: 'asc' },
  })

  // A venue needs pricing once it can take money: it has hardware assigned, or it is already
  // transacting (BAE TERCERA GRANDE has payment history but no Terminal row yet — its terminal
  // is pending, and it would break on its first card sale). Purely logical venues (no terminal,
  // no payments — e.g. "Virtual") are left alone: pricing them creates a row nothing ever reads.
  const canTakeMoney = (v: (typeof venues)[number]) => v._count.terminals > 0 || v._count.payments > 0

  const alreadyPriced = venues.filter(v => v.pricingStructures.length > 0)
  const dormant = venues.filter(v => v.pricingStructures.length === 0 && !canTakeMoney(v))
  const needPricing = venues.filter(v => v.pricingStructures.length === 0 && canTakeMoney(v))

  console.log(`  ${venues.length} venues activos · ${alreadyPriced.length} ya con tarifa · ${needPricing.length} sin tarifa y operando`)
  if (dormant.length > 0) {
    // Reported, never silently dropped.
    console.log(`  ⏭  ${dormant.length} sin tarifa, sin terminal y sin cobros (se omiten, no pueden cobrar):`)
    dormant.forEach(v => console.log(`       · ${v.name}`))
  }
  console.log()

  let createdPricing = 0

  for (const venue of needPricing) {
    // Backdate so the pricing also covers payments already taken by this venue —
    // findActiveVenuePricingStructure filters on effectiveFrom <= payment.createdAt.
    const firstPayment = await prisma.payment.findFirst({
      where: { venueId: venue.id, method: { not: PaymentMethod.CASH } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    })

    const effectiveFrom = firstPayment && firstPayment.createdAt < venue.createdAt ? firstPayment.createdAt : venue.createdAt

    console.log(`  ▸ ${venue.name}`)
    console.log(
      `      terminales: ${venue._count.terminals} · pagos: ${venue._count.payments} · effectiveFrom: ${effectiveFrom.toISOString()}`,
    )

    if (!APPLY) {
      console.log(`      [dry-run] se crearía VenuePricingStructure PRIMARY\n`)
      createdPricing++
      continue
    }

    const created = await prisma.venuePricingStructure.create({
      data: {
        venueId: venue.id,
        accountType: AccountType.PRIMARY,
        ...canonical,
        effectiveFrom,
        active: true,
        notes:
          'Creada por scripts/fix-playtelecom-venue-pricing.ts — clonada de la tarifa canónica de la organización. ' +
          'Sin ella los cobros con tarjeta quedan con feeAmount=0 (margen negativo silencioso).',
      },
    })

    await logAction({
      staffId: ACTOR_ARG,
      venueId: venue.id,
      action: 'VENUE_PRICING_STRUCTURE_CREATED',
      entity: 'VenuePricingStructure',
      entityId: created.id,
      data: {
        source: 'fix-playtelecom-venue-pricing.ts',
        organizationId: org.id,
        accountType: 'PRIMARY',
        clonedFrom: 'organization canonical rate',
        debitRate: String(canonical.debitRate),
        creditRate: String(canonical.creditRate),
        amexRate: String(canonical.amexRate),
        internationalRate: String(canonical.internationalRate),
        fixedFeePerTransaction: canonical.fixedFeePerTransaction ? String(canonical.fixedFeePerTransaction) : null,
        effectiveFrom: effectiveFrom.toISOString(),
      },
    })

    console.log(`      ✅ creada ${created.id}\n`)
    createdPricing++
  }

  if (needPricing.length === 0) console.log('  ✅ Nada que crear: todos los venues con terminal ya tienen tarifa.\n')

  // ══ PART B — backfill de TransactionCost huérfanos ════════════════════════
  console.log(`${'─'.repeat(78)}\nPARTE B — TransactionCost huérfanos\n${'─'.repeat(78)}`)

  // Eligible = exactly what createTransactionCost() would have processed:
  // Avoqado-originated, non-CASH, with money on it, and no TransactionCost yet.
  const orphans = await prisma.payment.findMany({
    where: {
      venue: { organizationId: org.id },
      status: 'COMPLETED',
      originSystem: OriginSystem.AVOQADO,
      method: { not: PaymentMethod.CASH },
      transactionCost: { is: null },
    },
    select: {
      id: true,
      venueId: true,
      amount: true,
      tipAmount: true,
      method: true,
      cardBrand: true,
      createdAt: true,
      venue: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const withMoney = orphans.filter(p => Number(p.amount) + Number(p.tipAmount ?? 0) > 0)
  const zeroValue = orphans.length - withMoney.length

  console.log(`  ${orphans.length} pagos sin TransactionCost`)
  if (zeroValue > 0) {
    // Reported, never silently dropped: $0 payments produce a $0 TransactionCost —
    // no money at stake, and backfilling them would add hundreds of empty rows.
    console.log(`  ⏭  ${zeroValue} de $0 (se omiten: fee 0, sin impacto en margen)`)
  }
  console.log(`  → ${withMoney.length} con dinero real a recalcular\n`)

  let repaired = 0
  let skipped = 0
  let recoveredFees = 0

  for (const p of withMoney) {
    const gross = Number(p.amount) + Number(p.tipAmount ?? 0)
    const label = `${p.venue.name} · ${p.method}${p.cardBrand ? `/${p.cardBrand}` : ''} · ${money(gross)} · ${p.createdAt.toISOString()}`

    if (!APPLY) {
      console.log(`  ▸ [dry-run] ${label}`)
      console.log(`      ${p.id}`)
      skipped++
      continue
    }

    try {
      const result = await createTransactionCost(p.id)

      if (!result) {
        console.log(`  ⏭  ${label}\n      ${p.id} — no elegible (createTransactionCost devolvió null)`)
        skipped++
        continue
      }

      // Mirror exactly what the TPV path persists after a successful cost calc.
      if (result.feeAmount > 0) {
        await prisma.payment.update({
          where: { id: p.id },
          data: { feeAmount: result.feeAmount, netAmount: result.netAmount },
        })

        await prisma.venueTransaction.updateMany({
          where: { paymentId: p.id },
          data: {
            feeAmount: result.feeAmount,
            netAmount: result.netAmount,
            netSettlementAmount: result.netAmount,
          },
        })
      }

      await logAction({
        staffId: ACTOR_ARG,
        venueId: p.venueId,
        action: 'TRANSACTION_COST_BACKFILLED',
        entity: 'TransactionCost',
        entityId: result.transactionCost.id,
        data: {
          source: 'fix-playtelecom-venue-pricing.ts',
          paymentId: p.id,
          reason: 'Venue sin VenuePricingStructure al momento del cobro (Step 4 de createTransactionCost falló)',
          grossAmount: gross,
          feeAmount: result.feeAmount,
          netAmount: result.netAmount,
        },
      })

      recoveredFees += result.feeAmount
      repaired++
      console.log(`  ✅ ${label}`)
      console.log(`      ${p.id} → fee ${money(result.feeAmount)} · neto ${money(result.netAmount)}`)
    } catch (err) {
      skipped++
      console.log(`  ❌ ${label}`)
      console.log(`      ${p.id} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (withMoney.length === 0) console.log('  ✅ Nada que recalcular.\n')

  // ══ resumen ═══════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(78)}`)
  console.log('  RESUMEN')
  console.log(`${'═'.repeat(78)}`)
  console.log(`  VenuePricingStructure ${APPLY ? 'creadas' : 'a crear'} : ${createdPricing}`)
  console.log(`  TransactionCost       ${APPLY ? 'recalculados' : 'a recalcular'} : ${APPLY ? repaired : withMoney.length}`)
  if (APPLY) {
    console.log(`  Comisión contabilizada      : ${money(recoveredFees)}`)
    if (skipped > 0) console.log(`  Omitidos / fallidos         : ${skipped}`)
  } else {
    console.log(`\n  Nada de esto se escribió. Corre otra vez con --apply para aplicarlo.`)
  }
  console.log()
}

main()
  .catch(err => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
