/**
 * setup-avoqado-demo-tpv-sandbox.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Provisions the "Avoqado Demo" TPV path for the gym demo venue (avoqado-fitness):
 * a SANDBOX Blumon MerchantAccount + an ACTIVE Terminal, ON THE PRODUCTION backend.
 *
 * ⚠️ INTENTIONAL PROD + SANDBOX COMBO. This copies a WORKING sandbox Blumon merchant
 *    from the DEV/local DB into PROD so the "Avoqado Demo" TPV build (BLUMON_ENV=SAND +
 *    API_ENV=PROD) can process TEST cards (no real money) while everything reflects in
 *    the prod gym venue. See docs/guides/VENUE_CREATION_GUIDE.md and the memory note
 *    `avoqado-fitness-prod-sandbox-tpv`. DO NOT "fix" the sandbox merchant in prod.
 *
 * Why copy (not auto-fetch): the Blumon auto-fetch endpoint hits Blumon's PRODUCTION
 * API, so it can't mint sandbox creds in prod. The credentials blob is portable because
 * the Android app decrypts it with the hardcoded default key
 * ("default-key-change-in-production-use-env-var"), matching how DEV encrypted it.
 *
 * ADDITIVE + idempotent: creates a NEW merchant + NEW terminal. Touches nothing else.
 * Does NOT reuse serial AVQD-2841548417 (already used by another venue in prod).
 *
 * RUN:
 *   DEV_URL="postgresql://postgres:...@localhost:5432/av-db-25" \
 *   PROD_URL="postgresql://...render.com/avoqado_db" \
 *     npx tsx scripts/setup-avoqado-demo-tpv-sandbox.ts
 *
 * TEARDOWN:  add --teardown  (deletes ONLY the prod terminal + the copied merchant)
 */
import { PrismaClient } from '@prisma/client'

const DEV_URL = process.env.DEV_URL
const PROD_URL = process.env.PROD_URL
if (!DEV_URL || !PROD_URL) throw new Error('Set DEV_URL and PROD_URL env vars.')

const dev = new PrismaClient({ datasources: { db: { url: DEV_URL } } })
const prod = new PrismaClient({ datasources: { db: { url: PROD_URL } } })

// Verified 2026-07-07
const DEV_MERCHANT_ID = 'cmq850h9e00019kpwbsthqw0s' // sandbox, posId 387, blumonSerial 2841548418
const GYM_VENUE_ID = 'cmrb9clsl0001c9126obyxp2q' // avoqado-fitness (PROD)
const APP_SERIAL = 'AVQD-2841548418' // Avoqado terminal serial the "Avoqado Demo" flavor will report (FREE in prod)
const EXTERNAL_MID = 'blumon_2841548418'

async function teardown() {
  const t = await prod.terminal.findFirst({ where: { serialNumber: APP_SERIAL }, select: { id: true } })
  if (t) {
    await prod.terminal.delete({ where: { id: t.id } })
    console.log(`🗑️  Deleted prod terminal ${APP_SERIAL}`)
  }
  const m = await prod.merchantAccount.findFirst({ where: { externalMerchantId: EXTERNAL_MID }, select: { id: true } })
  if (m) {
    await prod.merchantAccount.delete({ where: { id: m.id } })
    console.log(`🗑️  Deleted prod sandbox merchant ${EXTERNAL_MID}`)
  }
  console.log('✅ Teardown done. Nothing else touched.')
}

async function main() {
  if (process.argv.includes('--teardown')) return teardown()

  // 1. Read the WORKING sandbox merchant from DEV
  const src = await dev.merchantAccount.findUnique({ where: { id: DEV_MERCHANT_ID } })
  if (!src) throw new Error(`DEV merchant ${DEV_MERCHANT_ID} not found`)
  if (src.blumonEnvironment !== 'SANDBOX') throw new Error(`SAFETY: DEV merchant is ${src.blumonEnvironment}, expected SANDBOX`)
  console.log(`📥 DEV merchant: posId=${src.blumonPosId} serial=${src.blumonSerialNumber} env=${src.blumonEnvironment}`)

  // 2. Resolve PROD BLUMON provider
  const prodProvider = await prod.paymentProvider.findUnique({ where: { code: 'BLUMON' }, select: { id: true } })
  if (!prodProvider) throw new Error('PROD has no BLUMON PaymentProvider')

  // 3. Create (or reuse) the sandbox merchant in PROD
  let merchant = await prod.merchantAccount.findFirst({ where: { externalMerchantId: EXTERNAL_MID } })
  if (merchant) {
    console.log(`♻️  PROD sandbox merchant already exists: ${merchant.id}`)
  } else {
    merchant = await prod.merchantAccount.create({
      data: {
        providerId: prodProvider.id, // remap FK to PROD's BLUMON provider
        externalMerchantId: EXTERNAL_MID,
        alias: 'AVQ-DEMO-SANDBOX',
        displayName: 'SANDBOX Blumon · Avoqado Demo (gym)',
        active: true,
        blumonEnvironment: 'SANDBOX',
        blumonPosId: src.blumonPosId,
        blumonSerialNumber: src.blumonSerialNumber,
        blumonMerchantId: src.blumonMerchantId,
        credentialsEncrypted: src.credentialsEncrypted as any, // default-key encrypted → app-portable
        providerConfig: src.providerConfig as any,
        // financialAccountId / aggregatorId intentionally left null (env-specific FKs)
      },
    })
    console.log(`✅ PROD sandbox merchant created: ${merchant.id} (posId ${merchant.blumonPosId})`)
  }

  // 4. Create (or reuse) the gym Terminal in PROD, assigned to the sandbox merchant
  let terminal = await prod.terminal.findFirst({ where: { serialNumber: APP_SERIAL } })
  if (terminal) {
    console.log(`♻️  PROD terminal already exists: ${terminal.id} (venue ${terminal.venueId})`)
  } else {
    terminal = await prod.terminal.create({
      data: {
        venueId: GYM_VENUE_ID,
        serialNumber: APP_SERIAL,
        name: 'Avoqado Demo (sandbox)',
        type: 'TPV_ANDROID',
        status: 'ACTIVE',
        brand: 'PAX',
        model: 'A910S',
        assignedMerchantIds: [merchant.id],
        config: {
          demo: true,
          prodBackendSandboxProcessor: true,
          note: 'INTENTIONAL: SANDBOX Blumon on PROD backend for the gym demo. Test cards, no real money. Sandbox txns will NOT reconcile with Blumon PROD webhooks — that is EXPECTED, not a bug. Do NOT "fix". See docs/guides/VENUE_CREATION_GUIDE.md.',
        },
      },
    })
    console.log(`✅ PROD terminal created: ${terminal.id} serial=${APP_SERIAL} → venue avoqado-fitness, merchant ${merchant.id}`)
  }

  console.log('\n════════════════════════ RESUMEN ════════════════════════')
  console.log(`Merchant (SANDBOX):  ${merchant.id}  posId=${merchant.blumonPosId}  serial=${merchant.blumonSerialNumber}`)
  console.log(`Terminal (ACTIVE):   ${terminal.id}  app-serial=${APP_SERIAL}  venue=avoqado-fitness`)
  console.log(`App flavor "Avoqado Demo" debe usar OVERRIDE_TERMINAL_SERIAL="${APP_SERIAL}".`)
  console.log('avoqado-full y el terminal 2841548417 intactos.')
}

main()
  .catch(e => {
    console.error('❌ Failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await dev.$disconnect()
    await prod.$disconnect()
  })
