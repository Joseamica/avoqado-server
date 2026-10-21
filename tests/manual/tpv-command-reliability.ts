/** Isolated regression: DATABASE_URL must name a disposable fulltest_tpvs_* database. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import prisma from '../../src/utils/prismaClient'
import { tpvCommandQueueService as queue } from '../../src/services/tpv/command-queue.service'
import { tpvHealthService as health } from '../../src/services/tpv/tpv-health.service'
import { issueCommandCredential, resolveCommandTerminal } from '../../src/services/tpv/command-credential.service'
import { commandsReady, permitCommand } from '../../src/controllers/tpv/heartbeat.tpv.controller'
import { updateTerminal, deviceReboundAfter } from '../../src/services/dashboard/terminals.superadmin.service'
import { migrateCancel } from '../../src/services/dashboard/terminal-migration.service'

const target = new URL(process.env.DATABASE_URL ?? '')
assert(['localhost', '127.0.0.1', '::1'].includes(target.hostname) && /^\/fulltest_tpvs_[a-z0-9]+$/.test(target.pathname))
async function call(handler: any, request: any) {
  let status = 200,
    body: any,
    error: any
  const response = {
    status(code: number) {
      status = code
      return this
    },
    json(value: any) {
      body = value
      return this
    },
  }
  await handler(request, response, (e: any) => {
    error = e
  })
  if (error) throw error
  return { status, body }
}
async function main() {
  const config = await prisma.venuePaymentConfig.findFirstOrThrow({
    where: { primaryAccount: { active: true, provider: { code: 'BLUMON' } } },
    select: { venueId: true },
    orderBy: { id: 'asc' },
  })
  const origin = await prisma.venue.findFirstOrThrow({
    where: { id: { not: config.venueId } },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  const venues = [origin, { id: config.venueId }]
  const staff = await prisma.staff.findFirstOrThrow({ select: { id: true } })
  assert.equal(venues.length, 2)
  const serial = `AVQD-FULLTEST-${randomUUID()}`
  const boot = randomUUID()
  const terminal = await prisma.terminal.create({
    data: {
      name: 'FULLTEST-command reliability',
      serialNumber: serial,
      venueId: venues[0].id,
      brand: 'PAX',
      type: 'TPV_ANDROID',
      status: 'ACTIVE',
      commandProtocolVersion: 2,
      commandSessionId: boot,
    },
  })
  const key = `FULLTEST-${randomUUID()}`
  try {
    const credential = await issueCommandCredential(terminal.id)
    assert.equal(await resolveCommandTerminal({ headers: {} } as any, serial), null)
    const req = { headers: { 'x-tpv-command-token': credential }, body: { terminalId: serial, sessionId: boot } }
    const input = {
      terminalId: terminal.id,
      venueId: terminal.venueId,
      commandType: 'RESTART' as const,
      requestedBy: staff.id,
      idempotencyKey: key,
    }
    const [first, retry] = await Promise.all([queue.queueCommand(input), queue.queueCommand(input)])
    assert.equal(first.commandId, retry.commandId)
    assert.equal(await prisma.tpvCommandQueue.count({ where: { terminalId: terminal.id } }), 1)
    assert.equal(await prisma.tpvCommandHistory.count({ where: { terminalId: terminal.id } }), 1)
    assert.equal(first.expiresAt, null)
    await assert.rejects(queue.queueCommand({ ...input, commandType: 'SHUTDOWN' }), (e: any) => e.statusCode === 409)
    const delivered = await Promise.all([call(commandsReady, req), call(commandsReady, req)])
    assert.equal(
      delivered.reduce((total, r) => total + r.body.pendingCommands.length, 0),
      1,
    )
    const execution = { ...req, body: { ...req.body, commandId: first.commandId } }
    assert.equal((await call(permitCommand, execution)).body.permitted, true)
    assert.equal((await call(permitCommand, execution)).body.permitted, true)
    const permitHistory = await prisma.tpvCommandHistory.count({ where: { commandQueueId: first.commandId, status: 'EXECUTION_STARTED' } })
    assert.equal(permitHistory, 1)
    await health.acknowledgeCommand(first.commandId, serial, 'SUCCESS', 'FULLTEST-result')
    await health.acknowledgeCommand(first.commandId, serial, 'FAILED', 'late response')
    assert.equal((await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: first.commandId } })).status, 'COMPLETED')
    await assert.rejects(health.acknowledgeCommand(first.commandId, 'AVQD-OTHER', 'SUCCESS'), (e: any) => e.statusCode === 403)
    console.log('PASS: authenticated delivery, concurrent idempotency, same-boot permit recovery and immutable final ACK.')

    const intents = await Promise.allSettled([
      updateTerminal(terminal.id, { venueId: venues[1].id }, { staffId: staff.id }),
      updateTerminal(terminal.id, { venueId: venues[1].id }, { staffId: staff.id }),
    ])
    assert.equal(intents.filter(r => r.status === 'fulfilled').length, 1)
    const moved = intents.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>
    const wipeId = moved.value.migrationCommandId
    assert(wipeId)
    const wipe = await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: wipeId } })
    assert.equal((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).venueId, venues[0].id)
    assert.equal(wipe.venueId, venues[0].id)
    assert.equal(wipe.expiresAt, null)
    await call(commandsReady, req) // Claiming delivery must not change the parent.
    await migrateCancel(terminal.id, { staffId: staff.id })
    assert.equal((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).venueId, venues[0].id)
    assert.equal((await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: wipeId } })).status, 'CANCELLED')
    assert.equal((await call(permitCommand, { ...req, body: { ...req.body, commandId: wipeId } })).body.permitted, false)
    console.log('PASS: concurrent migration intentions create one wipe; delivery is cancellable and leaves the origin intact.')

    const next = (await updateTerminal(terminal.id, { venueId: venues[1].id }, { staffId: staff.id })) as any
    const nextId = next.migrationCommandId
    await call(commandsReady, req)
    const permit = { ...req, body: { ...req.body, commandId: nextId } }
    assert.equal((await call(permitCommand, permit)).body.permitted, true)
    assert.equal((await call(permitCommand, permit)).body.permitted, true)
    assert.equal((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).venueId, venues[1].id)
    assert.equal((await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: nextId } })).venueId, venues[1].id)
    assert.equal(await prisma.activityLog.count({ where: { entityId: terminal.id, action: 'TERMINAL_MIGRATION_COMMITTED' } }), 1)
    const applied = await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: nextId } })
    assert.equal(deviceReboundAfter(applied, randomUUID()), false)
    await health.acknowledgeCommand(nextId, serial, 'SUCCESS', 'FULLTEST-wipe')
    const complete = await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id: nextId } })
    assert.equal(deviceReboundAfter(complete, boot), false)
    const nextBoot = randomUUID()
    await call(commandsReady, { ...req, body: { terminalId: serial, sessionId: nextBoot } })
    const rebooted = await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })
    assert.equal(deviceReboundAfter(complete, rebooted.commandSessionId), true)
    console.log(
      'PASS: the execution permit commits venue, queue and audit once; confirmation requires a receipt and authenticated new boot.',
    )
  } finally {
    await prisma.idempotencyRequest.deleteMany({ where: { idempotencyKey: key } })
    await prisma.activityLog.deleteMany({ where: { entity: 'Terminal', entityId: terminal.id } })
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
