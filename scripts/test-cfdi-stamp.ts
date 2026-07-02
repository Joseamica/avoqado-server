/**
 * One-off proof: timbrar (stamp) a sandbox CFDI for ONE order in each of the 3
 * demo venues via the REAL issuance path (issueCfdiForOrder → validateBeforeStamp
 * → Facturapi test mode). Leaves the 3 stamped sandbox CFDIs in place as demo data.
 *
 * Why a custom `deps`: issueCfdiForOrder's default deps upload the XML/PDF to
 * Firebase/GCS (uploadFileToStorage), which throws locally without cloud creds —
 * AFTER the PAC stamps, leaving the row STAMPING. We override ONLY storeArtifact
 * with a no-op placeholder URL; every other step (load, validate, real PAC call,
 * persist STAMPED) is the production path.
 *
 * Receptor: EKU9003173C9 / régimen 601 / G03 — Facturapi's documented test
 * receptor. NOTE: XAXX010101000 ("Público en General") is BLOCKED for individual
 * (non-global) invoices by validateBeforeStamp, so we must use a real-business RFC.
 *
 * Run (keys must be in .env: FACTURAPI_TEST_KEY + FISCAL_PROVIDER_KEY):
 *   npx tsx scripts/test-cfdi-stamp.ts
 */

import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'
import { issueCfdiForOrder, loadOrderForCfdiFromDb, type IssueCfdiDeps, type IssueReceptor } from '../src/services/fiscal/cfdi.service'
import { resolveFiscalProvider } from '../src/services/fiscal/fiscalProvider.factory'

// The 3 demo venues (stable IDs).
const VENUES = [
  { name: 'Lunaria Boutique', id: 'cmr0u1fs40005c9lqjlvaz64k' },
  { name: 'Studio Bloom', id: 'cmr0u1ifz0111c9lqh12ria0q' },
  { name: 'Dermédica', id: 'cmr0u1kmf01zxc9lqrbut4ney' },
]

// Facturapi sandbox test receptor (real-business RFC — required for individual CFDIs).
const RECEPTOR: IssueReceptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601', // General de Ley Personas Morales
  codigoPostal: '11560', // valid 5-digit SAT CP
  usoCfdi: 'G03', // Gastos en general
  email: 'demo@avoqado.io',
}

// Deps = production defaults EXCEPT storeArtifact (no cloud creds in a script).
const testDeps: IssueCfdiDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  loadOrderForCfdi: loadOrderForCfdiFromDb,
  resolveProvider: resolveFiscalProvider,
  reserveCfdi: data => prisma.cfdi.create({ data: data as any }),
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: {
        status: data.status,
        lastError: data.lastError ?? null,
        attempts: { increment: 1 },
        ...(data.uuid
          ? { uuid: data.uuid, facturapiId: data.facturapiId, serie: data.serie, folio: data.folio, stampedAt: data.stampedAt }
          : {}),
      },
    }),
  // No-op storage: prove stamping without Firebase/GCS. Returns a placeholder URL.
  storeArtifact: async (_buffer, path) => `local://skipped/${path}`,
}

/** Pick one COMPLETED order whose most-recent COMPLETED payment has a merchant
 *  (so loadOrderForCfdi can resolve the emisor) and that isn't already stamped. */
async function pickInvoiceableOrder(venueId: string): Promise<string | null> {
  const candidates = await prisma.order.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      payments: { some: { status: 'COMPLETED', ecommerceMerchantId: { not: null } } },
    },
    select: { id: true, orderNumber: true, total: true },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  for (const o of candidates) {
    const already = await prisma.cfdi.findUnique({ where: { idempotencyKey: `cfdi-order-${o.id}` }, select: { status: true } })
    if (!already || already.status !== 'STAMPED') return o.id
  }
  // All candidates already stamped → reuse the first (issuance is idempotent).
  return candidates[0]?.id ?? null
}

async function main() {
  const dbName = (process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? 'unknown'
  logger.info(`🧾 CFDI sandbox stamp test → DB: ${dbName}`)
  logger.info(
    `   FACTURAPI_TEST_KEY: ${process.env.FACTURAPI_TEST_KEY ? 'set' : 'MISSING'} · FISCAL_PROVIDER_KEY: ${process.env.FISCAL_PROVIDER_KEY ? 'set' : 'MISSING'}`,
  )

  const results: Array<{ venue: string; orderId: string | null; status: string; uuid?: string; folio?: string; reasons?: string[] }> = []

  for (const v of VENUES) {
    logger.info('')
    logger.info(`──────── ${v.name} (${v.id}) ────────`)

    const orderId = await pickInvoiceableOrder(v.id)
    if (!orderId) {
      logger.error('   ❌ No invoiceable order found (no COMPLETED order with a merchant-linked payment)')
      results.push({ venue: v.name, orderId: null, status: 'NO_ORDER' })
      continue
    }
    logger.info(`   order: ${orderId}`)

    try {
      const res = await issueCfdiForOrder({ orderId, receptor: RECEPTOR, sandbox: true, flow: 'STAFF_B', expectedVenueId: v.id }, testDeps)
      const folio = res.cfdi?.serie && res.cfdi?.folio != null ? `${res.cfdi.serie}-${res.cfdi.folio}` : undefined
      logger.info(
        `   → status=${res.status}` +
          (res.cfdi?.uuid ? ` · uuid=${res.cfdi.uuid}` : '') +
          (folio ? ` · folio=${folio}` : '') +
          (res.reasons?.length ? ` · reasons=[${res.reasons.join(' | ')}]` : ''),
      )
      results.push({ venue: v.name, orderId, status: res.status, uuid: res.cfdi?.uuid, folio, reasons: res.reasons })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`   ❌ threw: ${msg}`)
      results.push({ venue: v.name, orderId, status: `THREW: ${msg}` })
    }
  }

  logger.info('')
  logger.info('════════════ RESUMEN CFDI ════════════')
  for (const r of results) {
    const ok = r.status === 'STAMPED'
    logger.info(
      `${ok ? '✅' : '❌'} ${r.venue}: ${r.status}` +
        (r.uuid ? ` · uuid=${r.uuid}` : '') +
        (r.folio ? ` · folio=${r.folio}` : '') +
        (r.reasons?.length ? ` · reasons=[${r.reasons.join(' | ')}]` : ''),
    )
  }
  const stamped = results.filter(r => r.status === 'STAMPED').length
  logger.info('')
  logger.info(`${stamped === VENUES.length ? '✅' : '⚠️'} ${stamped}/${VENUES.length} venues STAMPED`)
}

main()
  .catch(err => {
    logger.error('❌ CFDI test failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
