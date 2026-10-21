/** Local-only regression. Run: node -r ts-node/register/transpile-only -r tsconfig-paths/register tests/manual/tpv-migration-atomicity.ts
 * Creates one isolated terminal, injects failure AFTER the command/history insert, checks rollback, removes only its own fixture.
 */
import assert from 'node:assert/strict'
import { config } from 'dotenv'
config({ quiet: true })
const target = new URL(process.env.DATABASE_URL ?? '')
assert(
  ['localhost', '127.0.0.1', '::1'].includes(target.hostname) && /^\/fulltest_tpvs_[a-z0-9]+$/.test(target.pathname),
  'This check requires an isolated local TPV test database',
)
process.env.LOG_LEVEL = 'error'

async function main() {
  const prisma = require('../../src/utils/prismaClient').default
  const { updateTerminal } = require('../../src/services/dashboard/terminals.superadmin.service')
  const { tpvCommandQueueService } = require('../../src/services/tpv/command-queue.service')
  const venues = await prisma.venue.findMany({ take: 2, orderBy: { id: 'asc' }, select: { id: true } })
  assert.equal(venues.length, 2, 'Requires two existing local fixture venues')
  const terminal = await prisma.terminal.create({
    data: {
      name: 'FULLTEST-migration rollback check',
      serialNumber: `AVQD-QA-ROLLBACK-${Date.now()}`,
      venueId: venues[0].id,
      type: 'TPV_ANDROID',
      brand: 'PAX',
      status: 'ACTIVE',
    },
  })
  const originalQueue = tpvCommandQueueService.queueCommand.bind(tpvCommandQueueService)
  let insertedCommand: string | undefined
  try {
    tpvCommandQueueService.queueCommand = async (input: unknown, tx: unknown) => {
      const queued = await originalQueue(input, tx)
      insertedCommand = queued.commandId
      throw new Error('TEST_FAILURE_AFTER_QUEUE_INSERT')
    }
    await assert.rejects(updateTerminal(terminal.id, { venueId: venues[1].id }), /TEST_FAILURE_AFTER_QUEUE_INSERT/)
    assert(insertedCommand, 'Failure must happen AFTER the second write, not during preflight')
    const saved = await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })
    assert.equal(saved.venueId, venues[0].id)
    assert.deepEqual(saved.assignedMerchantIds, [])
    assert.equal(await prisma.tpvCommandQueue.count({ where: { terminalId: terminal.id } }), 0)
    assert.equal(await prisma.tpvCommandHistory.count({ where: { terminalId: terminal.id } }), 0)
    console.log('PASS: venue, merchant assignments, queued command and history roll back together after a post-insert failure.')
  } finally {
    tpvCommandQueueService.queueCommand = originalQueue
    await prisma.tpvCommandHistory.deleteMany({ where: { terminalId: terminal.id } })
    await prisma.terminal.delete({ where: { id: terminal.id } })
    await prisma.$disconnect()
  }
}
main().then(
  () => process.exit(0),
  error => {
    console.error(error.message)
    process.exit(1)
  },
)
