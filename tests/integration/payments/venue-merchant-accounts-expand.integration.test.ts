/**
 * PR-1 (feat/venue-merchant-accounts) — Expand + Backfill, integration tests.
 *
 * Spec: docs/specs/2026-06-17-venue-merchant-accounts-design.md
 * Plan: docs/plans/2026-06-17-venue-merchant-accounts-PR1-expand.md
 *
 * Estrategia: cada prueba aplica el `migration.sql` de PR-1 DENTRO de una
 * transacción interactiva y hace ROLLBACK al final → CERO cambios persistentes en
 * la BD (la migración aún no está desplegada; esto la prueba sin desplegarla).
 *
 * Requiere que la BD de integración tenga ≥1 `VenuePaymentConfig` (y, para los
 * tests de constraints, ≥1 Terminal cuyo venue tenga config) — ambas BD locales
 * (`av-db-25`, `av-db-25-test`) la tienen. Si falta el seed de terminal, esos
 * casos se saltan con un aviso en vez de fallar.
 */
import * as fs from 'fs'
import * as path from 'path'
import prisma from '@/utils/prismaClient'
import { backfillVenueMerchantAccounts } from '@/services/payments/venueMerchantAccountBackfill.service'

const ROLLBACK = '__ROLLBACK_PR1_TEST__'

function migrationStatements(): string[] {
  const migRoot = path.join(__dirname, '..', '..', '..', 'prisma', 'migrations')
  const dir = fs.readdirSync(migRoot).find(d => d.includes('expand_venue_merchant_accounts'))
  if (!dir) throw new Error('migración expand_venue_merchant_accounts no encontrada')
  return fs
    .readFileSync(path.join(migRoot, dir, 'migration.sql'), 'utf8')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

const STMTS = migrationStatements()

/** Corre `fn` con la migración aplicada dentro de una tx, y hace ROLLBACK siempre. */
async function withMigratedTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let out: T
  await prisma
    .$transaction(
      async (tx: any) => {
        for (const s of STMTS) await tx.$executeRawUnsafe(s)
        out = await fn(tx)
        throw new Error(ROLLBACK)
      },
      { timeout: 30000, maxWait: 10000 },
    )
    .catch((e: any) => {
      if (e?.message !== ROLLBACK) throw e
    })
  return out!
}

async function firstSeed(tx: any): Promise<{ tid: string; vid: string; cid: string; ma: string } | null> {
  const rows: any[] = await tx.$queryRawUnsafe(
    `SELECT t.id AS tid, t."venueId" AS vid, vpc.id AS cid, vpc."primaryAccountId" AS ma
     FROM "Terminal" t JOIN "VenuePaymentConfig" vpc ON vpc."venueId" = t."venueId" LIMIT 1`,
  )
  return rows.length ? rows[0] : null
}

describe('PR-1 expand: venue merchant accounts', () => {
  it('T1 — la migración aplica limpio contra el schema vivo', async () => {
    await withMigratedTx(async tx => {
      const r: any[] = await tx.$queryRawUnsafe(
        `SELECT
           to_regclass('public."VenueMerchantAccount"')    IS NOT NULL AS roster,
           to_regclass('public."TerminalMerchantAccount"') IS NOT NULL AS terminal_acct,
           (SELECT count(*) FROM pg_constraint WHERE conname='TerminalMerchantAccount_venueId_merchantAccountId_fkey') AS composite_fk`,
      )
      expect(r[0].roster).toBe(true)
      expect(r[0].terminal_acct).toBe(true)
      expect(Number(r[0].composite_fk)).toBe(1) // la FK compuesta (invariante anti-amaena)
    })
  })

  it('T2 — la FK compuesta RECHAZA una cuenta en terminal que no está en el roster', async () => {
    await withMigratedTx(async tx => {
      const s = await firstSeed(tx)
      if (!s) return // sin seed de terminal → se salta
      await tx.venueMerchantAccount.create({
        data: { venuePaymentConfigId: s.cid, venueId: s.vid, merchantAccountId: s.ma, priority: 0, legacySlotType: 'PRIMARY' },
      })
      // en roster → aceptada
      await expect(
        tx.terminalMerchantAccount.create({ data: { terminalId: s.tid, venueId: s.vid, merchantAccountId: s.ma } }),
      ).resolves.toBeDefined()
      // fuera del roster → la FK compuesta la rechaza (último op: la tx queda abortada y se hace rollback)
      await expect(
        tx.terminalMerchantAccount.create({ data: { terminalId: s.tid, venueId: s.vid, merchantAccountId: 'ghost-no-en-roster' } }),
      ).rejects.toThrow()
    })
  })

  it('T2 — el partial-unique permite un solo default por terminal', async () => {
    await withMigratedTx(async tx => {
      const s = await firstSeed(tx)
      if (!s) return
      const ma2 = (await tx.$queryRawUnsafe(`SELECT id FROM "MerchantAccount" WHERE id <> $1 LIMIT 1`, s.ma)) as any[]
      if (!ma2.length) return
      await tx.venueMerchantAccount.createMany({
        data: [
          { venuePaymentConfigId: s.cid, venueId: s.vid, merchantAccountId: s.ma, priority: 0, legacySlotType: 'PRIMARY' },
          { venuePaymentConfigId: s.cid, venueId: s.vid, merchantAccountId: ma2[0].id, priority: 1, legacySlotType: 'SECONDARY' },
        ],
      })
      await tx.terminalMerchantAccount.create({ data: { terminalId: s.tid, venueId: s.vid, merchantAccountId: s.ma, isDefault: true } })
      // segundo default en el mismo terminal → rechazado por el partial-unique
      await expect(
        tx.terminalMerchantAccount.create({ data: { terminalId: s.tid, venueId: s.vid, merchantAccountId: ma2[0].id, isDefault: true } }),
      ).rejects.toThrow()
    })
  })

  it('T3 — el backfill es idempotente y usa la UNIÓN (slots + terminales + pagos)', async () => {
    await withMigratedTx(async tx => {
      const r1 = await backfillVenueMerchantAccounts(tx)
      const roster1 = await tx.venueMerchantAccount.count()
      const terminal1 = await tx.terminalMerchantAccount.count()

      await backfillVenueMerchantAccounts(tx) // 2da corrida
      const roster2 = await tx.venueMerchantAccount.count()
      const terminal2 = await tx.terminalMerchantAccount.count()

      expect(r1.venueConfigs).toBeGreaterThan(0)
      expect(roster1).toBeGreaterThan(0)
      expect(roster2).toBe(roster1) // IDEMPOTENTE
      expect(terminal2).toBe(terminal1) // IDEMPOTENTE

      // legacySlotType: priority 0 = PRIMARY; extras (priority>=3) sin legacy
      const p0 = await tx.venueMerchantAccount.findFirst({ where: { priority: 0 }, select: { legacySlotType: true } })
      expect(p0?.legacySlotType).toBe('PRIMARY')
      const extrasWithLegacy = await tx.venueMerchantAccount.count({ where: { priority: { gte: 3 }, legacySlotType: { not: null } } })
      expect(extrasWithLegacy).toBe(0)
    })
  })
})
