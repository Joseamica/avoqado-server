import cuid from 'cuid'
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import prisma from '@/utils/prismaClient'
import { closeShift, getShiftOperation } from '@/controllers/tpv/shift.tpv.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { closeShiftForVenueWithResult } from '@/services/tpv/shift.tpv.service'
import { ShiftCloseWatchdogJob } from '@/jobs/shift-close-watchdog.job'
import { CashClosePairReconcilerJob } from '@/jobs/cash-close-pair-reconciler.job'
import { registerShiftOperationTools } from '@/mcp/tools/shiftOperations'
import { resolveScope } from '@/mcp/scope'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable propia de avq-verify, nunca av-db-25.')
}
const app = express()
app.use(express.json())
const auth = (req: Request, _res: Response, next: NextFunction) => {
  req.authContext = {
    userId: req.get('x-test-actor')!,
    orgId: 'test-org',
    venueId: req.params.venueId,
    role: StaffRole.OWNER,
    terminalSerialNumber: req.get('x-test-terminal'),
  }
  next()
}
app.post('/venues/:venueId/shifts/:shiftId/close', auth, checkPermission('tpv-shifts:close'), closeShift)
app.get('/venues/:venueId/shift-operations/:operationId', auth, checkPermission('shifts:read'), getShiftOperation)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) =>
  res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code }),
)

async function fixture() {
  const key = cuid()
  const org = await prisma.organization.create({ data: { name: `S2 ${key}`, email: `${key}@example.com`, phone: '5555555555' } })
  const venue = await prisma.venue.create({ data: { name: `S2 ${key}`, slug: `s2-${key}`, organizationId: org.id, status: 'LIVE_DEMO' } })
  const staff = await prisma.staff.create({ data: { firstName: 'Actual', lastName: 'Actor', email: `${key}@staff.test`, active: true } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: StaffRole.OWNER } })
  await prisma.venueSettings.create({ data: { venueId: venue.id, cashReconciliationEnabled: true } })
  const serial = `AVQD-${key}`
  await prisma.terminal.create({
    data: { venueId: venue.id, serialNumber: serial, name: 'S2 terminal', type: 'TPV_ANDROID', status: 'ACTIVE' },
  })
  const pair = await abrirTurnoDeCaja({ venueId: venue.id, staffId: staff.id, startingCash: 500, source: 'TURNO_TPV' })
  return {
    venueId: venue.id,
    organizationId: org.id,
    staffId: staff.id,
    serial,
    shiftId: pair.shiftId,
    drawerId: pair.cashDrawerSessionId,
    operationId: cuid(),
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const body = (n: Fixture, delta: object = {}) => ({
  operationId: n.operationId,
  closedAtLocal: new Date(Date.now() - 3000).toISOString(),
  isOfflineReplay: true,
  cashReconciliationAction: 'COUNTED',
  countedCash: '510.00',
  cashDrawerSessionId: n.drawerId,
  staffId: 'not-the-authority',
  ...delta,
})
const close = (n: Fixture, input: object, actor = n.staffId, serial = n.serial) =>
  request(app).post(`/venues/${n.venueId}/shifts/${n.shiftId}/close`).set('x-test-actor', actor).set('x-test-terminal', serial).send(input)
const status = (n: Fixture, id = n.operationId, actor = n.staffId, serial = n.serial) =>
  request(app).get(`/venues/${n.venueId}/shift-operations/${id}`).set('x-test-actor', actor).set('x-test-terminal', serial)
const operation = (n: Fixture, id = n.operationId) => prisma.tpvShiftOperation.findFirstOrThrow({ where: { id, venueId: n.venueId } })
const auditCount = (n: Fixture, action = 'SHIFT_CLOSED') => prisma.activityLog.count({ where: { venueId: n.venueId, action } })

async function releaseFailureTrigger(n: Fixture) {
  await prisma.$executeRawUnsafe(`CREATE FUNCTION s2_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.id = '${n.shiftId}' AND OLD.status = 'CLOSING' AND NEW.status = 'OPEN' THEN RAISE EXCEPTION 'S2_RELEASE_FAILURE'; END IF;
    RETURN NEW; END $$`)
  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER s2_release_failure BEFORE UPDATE ON "Shift" FOR EACH ROW EXECUTE FUNCTION s2_release_failure()',
  )
}
async function dropTrigger(table: string, name: string) {
  await prisma.$executeRawUnsafe(`DROP TRIGGER ${name} ON "${table}"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION ${name}()`)
}

describe('durable CLOSE — real isolated Postgres', () => {
  it.each(['missing', 'inactive', 'lower-role'])(
    'inherited authority: organization OWNER with %s assignment may CLOSE and GET',
    async assignment => {
      const n = await fixture()
      await prisma.staffOrganization.create({
        data: { staffId: n.staffId, organizationId: n.organizationId, role: 'OWNER', isActive: true },
      })
      const where = { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } }
      if (assignment === 'missing') await prisma.staffVenue.delete({ where })
      else await prisma.staffVenue.update({ where, data: { active: assignment !== 'inactive', role: 'CASHIER' } })
      const r = await close(n, body(n))
      expect(r.status).toBe(200)
      expect(r.body.operation.state).toBe('APPLIED')
      expect(r.body.data.closedById).toBe(n.staffId)
      expect((await status(n)).body).toMatchObject({ operation: { state: 'APPLIED' } })
    },
  )

  it('inherited authority still respects an empty PermissionSet on an inactive assignment and revoked organization ownership', async () => {
    const n = await fixture(),
      input = body(n)
    await prisma.staffOrganization.create({ data: { staffId: n.staffId, organizationId: n.organizationId, role: 'OWNER', isActive: true } })
    const where = { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } }
    await prisma.staffVenue.update({ where, data: { active: false, role: 'CASHIER' } })
    expect((await close(n, input)).status).toBe(200)
    const denied = await prisma.permissionSet.create({ data: { venueId: n.venueId, name: 'Inherited owner denied', permissions: [] } })
    await prisma.staffVenue.update({ where, data: { permissionSetId: denied.id } })
    expect((await close(n, input)).status).toBe(403)
    expect((await status(n)).status).toBe(403)
    await prisma.staffVenue.update({ where, data: { permissionSetId: null } })
    await prisma.staffOrganization.update({
      where: { staffId_organizationId: { staffId: n.staffId, organizationId: n.organizationId } },
      data: { isActive: false },
    })
    expect((await close(n, input)).status).toBe(403)
    expect((await status(n)).status).toBe(403)
    expect(await auditCount(n)).toBe(1)
  })

  it('global SUPERADMIN MCP scope reads another organization without a direct assignment, and a revoked global grant stops the same stale scope', async () => {
    const home = await fixture(),
      target = await fixture()
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: home.staffId, venueId: home.venueId } },
      data: { role: 'SUPERADMIN' },
    })
    expect(await prisma.staffVenue.count({ where: { staffId: home.staffId, venueId: target.venueId } })).toBe(0)
    expect((await close(target, body(target))).status).toBe(200)
    const scope = await resolveScope(home.staffId, home.organizationId)
    expect(scope.isSuperAdmin).toBe(true)
    let handler: any
    registerShiftOperationTools(
      {
        tool: (...args: any[]) => {
          handler = args.at(-1)
        },
      } as any,
      scope,
    )
    const result = await handler({ venueId: target.venueId, operationId: target.operationId })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ operation: { state: 'APPLIED' }, shift: { id: target.shiftId } })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: home.staffId, venueId: home.venueId } },
      data: { active: false },
    })
    await expect(handler({ venueId: target.venueId, operationId: target.operationId })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lost response, another authorized actor, and 12 later shifts still recover the exact immutable A result', async () => {
    const n = await fixture(),
      input = body(n)
    const first = await close(n, input)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      data: { id: n.shiftId, closedById: n.staffId, cashDeclared: '510' },
      reconciliation: { outcome: 'APPLIED', countedCash: '510.00', cashDifference: '10.00' },
      operation: { state: 'APPLIED', countApplied: true, pairStatus: 'COMPLETE' },
    })
    const durable = await operation(n)
    expect(durable.requestJson).toMatchObject({ declaredStaffId: 'not-the-authority' })
    expect(durable.resultJson).toMatchObject({ operation: { pairStatus: 'PENDING' }, reconciliation: first.body.reconciliation })
    for (let i = 0; i < 12; i++)
      await prisma.shift.create({
        data: { venueId: n.venueId, staffId: n.staffId, startTime: new Date(), endTime: new Date(), status: 'CLOSED' },
      })
    const b = await abrirTurnoDeCaja({ venueId: n.venueId, staffId: n.staffId, startingCash: 100, source: 'TURNO_TPV' })
    const other = await prisma.staff.create({
      data: { firstName: 'Other', lastName: 'Actor', email: `${cuid()}@staff.test`, active: true },
    })
    await prisma.staffVenue.create({ data: { venueId: n.venueId, staffId: other.id, role: 'OWNER' } })
    await prisma.venueSettings.update({ where: { venueId: n.venueId }, data: { cashReconciliationEnabled: false } })
    const replay = await close(n, input, other.id)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await auditCount(n)).toBe(1)
    expect((await operation(n)).actorStaffId).toBe(n.staffId)
    expect((await prisma.shift.findFirstOrThrow({ where: { id: b.shiftId, venueId: n.venueId } })).status).toBe('OPEN')
    expect((await status(n, n.operationId, other.id)).body).toMatchObject({
      operation: { state: 'APPLIED' },
      shift: { id: n.shiftId, cashDeclared: '510.00' },
    })
  })

  it('two simultaneous gestures sign once; loser retries to durable CONFLICT with its own evidence', async () => {
    const n = await fixture(),
      other = cuid(),
      a = body(n),
      b = body(n, { operationId: other, countedCash: '700.00' })
    const results = await Promise.all([close(n, a), close(n, b)])
    expect(results.filter(r => r.status === 200 && r.body.operation.state === 'APPLIED')).toHaveLength(1)
    const winner = results.find(r => r.status === 200 && r.body.operation.state === 'APPLIED')!
    const loserBody = winner.body.operation.operationId === n.operationId ? b : a
    const loser = await close(n, loserBody)
    expect(loser.status).toBe(200)
    expect(loser.body).toMatchObject({
      reconciliation: { outcome: 'CONFLICT' },
      operation: { state: 'CONFLICT', countApplied: false, submittedCountedCash: loserBody.countedCash },
    })
    expect(loser.body.data.cashDeclared).toBe(winner.body.data.cashDeclared)
    expect(await auditCount(n)).toBe(1)
    expect(await auditCount(n, 'TPV_SHIFT_CLOSE_CONFLICT')).toBe(1)
    await close(n, loserBody)
    expect(await auditCount(n, 'TPV_SHIFT_CLOSE_CONFLICT')).toBe(1)
  })

  it('changed contract, terminal, kind and tenant cannot reuse a key or modify a signed close', async () => {
    const n = await fixture(),
      input = body(n)
    expect((await close(n, input)).status).toBe(200)
    const serial = `AVQD-${cuid()}`
    await prisma.terminal.create({ data: { venueId: n.venueId, serialNumber: serial, name: 'Other', type: 'TPV_ANDROID' } })
    for (const r of [await close(n, { ...input, countedCash: '520.00' }), await close(n, input, n.staffId, serial)]) {
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('SHIFT_OPERATION_CONTRACT_MISMATCH')
    }
    const foreign = await fixture()
    const r = await close(foreign, body(foreign, { operationId: n.operationId }))
    expect(r.status).toBe(409)
    expect(await prisma.tpvShiftOperation.count({ where: { venueId: foreign.venueId } })).toBe(0)
    expect((await prisma.shift.findFirstOrThrow({ where: { id: foreign.shiftId, venueId: foreign.venueId } })).status).toBe('OPEN')
    const openKey = cuid()
    await prisma.tpvShiftOperation.create({
      data: {
        id: openKey,
        venueId: foreign.venueId,
        kind: 'OPEN',
        terminalSerial: foreign.serial,
        actorStaffId: foreign.staffId,
        requestHash: 'other',
        requestJson: {},
        state: 'APPLIED',
        shiftId: foreign.shiftId,
        resultJson: {},
      },
    })
    expect((await close(foreign, body(foreign, { operationId: openKey }))).status).toBe(409)
  })

  it('failure storing APPLIED after Shift update rolls back CLOSED and its audit; claim remains retriable', async () => {
    const n = await fixture(),
      input = body(n)
    await prisma.$executeRawUnsafe(`CREATE FUNCTION s2_after_closed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${n.operationId}' AND NEW.state = 'APPLIED' THEN
        IF NOT EXISTS (SELECT 1 FROM "Shift" WHERE id = NEW."shiftId" AND status = 'CLOSED') THEN RAISE EXCEPTION 'SHIFT_NOT_CLOSED'; END IF;
        RAISE EXCEPTION 'S2_SECOND_WRITE_AFTER_CLOSED';
      END IF; RETURN NEW; END $$`)
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER s2_after_closed BEFORE UPDATE ON "TpvShiftOperation" FOR EACH ROW EXECUTE FUNCTION s2_after_closed()',
    )
    try {
      const r = await close(n, input)
      expect(r.status).toBe(500)
      expect(r.body.message).toContain('S2_SECOND_WRITE_AFTER_CLOSED')
      expect((await prisma.shift.findFirstOrThrow({ where: { id: n.shiftId, venueId: n.venueId } })).status).toBe('OPEN')
      expect(await auditCount(n)).toBe(0)
      expect((await operation(n)).state).toBe('PENDING')
    } finally {
      await dropTrigger('TpvShiftOperation', 's2_after_closed')
    }
    expect((await close(n, input)).body.operation.state).toBe('APPLIED')
  })

  it.each(['new', 'legacy'])('watchdog reopens abandoned A; %s B may close, then exact GET A records CONFLICT once', async kind => {
    const n = await fixture(),
      input = body(n)
    await releaseFailureTrigger(n)
    const failure = jest.spyOn(prisma.payment, 'findMany').mockRejectedValueOnce(new Error('S2_PROCESS_DIED'))
    try {
      expect((await close(n, input)).status).toBe(500)
    } finally {
      failure.mockRestore()
      await dropTrigger('Shift', 's2_release_failure')
    }
    const pending = await operation(n)
    expect(pending.state).toBe('PENDING')
    expect((await status(n)).body.operation.state).toBe('PENDING')
    const later = new Date(Date.now() + 400_000)
    const opB = cuid()
    await expect(
      closeShiftForVenueWithResult(
        n.venueId,
        n.shiftId,
        { cashReconciliationAction: 'COUNTED', countedCash: '650.00' },
        { actorStaffId: n.staffId, now: () => later, operation: { operationId: opB, terminalSerial: n.serial, isOfflineReplay: true } },
      ),
    ).rejects.toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
    const watchdog = new ShiftCloseWatchdogJob({ now: () => later, cron: { start() {}, async stop() {} } })
    expect((await watchdog.runNow()).reopened).toBeGreaterThanOrEqual(1)
    const b = kind === 'new' ? body(n, { operationId: opB, countedCash: '650.00' }) : { cashDeclared: 650 }
    expect((await close(n, b)).status).toBe(200)
    const read = await status(n)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({
      operation: { state: 'CONFLICT', submittedCountedCash: '510.00', countApplied: false },
      shift: { cashDeclared: '650.00' },
    })
    expect((await operation(n)).state).toBe('CONFLICT')
    expect((await close(n, input)).body.reconciliation.outcome).toBe('CONFLICT')
    expect(await auditCount(n, 'TPV_SHIFT_CLOSE_CONFLICT')).toBe(1)
  })

  it('only same operation recovers its stale claim after process restart, keeping the original count/time', async () => {
    const n = await fixture(),
      input = body(n)
    await releaseFailureTrigger(n)
    const failure = jest.spyOn(prisma.payment, 'findMany').mockRejectedValueOnce(new Error('S2_PROCESS_DIED'))
    try {
      expect((await close(n, input)).status).toBe(500)
    } finally {
      failure.mockRestore()
      await dropTrigger('Shift', 's2_release_failure')
    }
    const later = new Date(Date.now() + 400_000)
    const result = await closeShiftForVenueWithResult(n.venueId, n.shiftId, input, {
      actorStaffId: n.staffId,
      now: () => later,
      operation: {
        operationId: n.operationId,
        terminalSerial: n.serial,
        closedAtLocal: input.closedAtLocal,
        isOfflineReplay: true,
        cashDrawerSessionId: n.drawerId,
      },
    })
    expect(result.operation).toMatchObject({ state: 'APPLIED', submittedCountedCash: '510.00' })
    expect(result.shift.endTime).toEqual(later)
    expect((await operation(n)).requestJson).toMatchObject({ closedAtLocal: input.closedAtLocal })
  })

  it.each(['operation', 'legacy'])('late %s A cannot sign or release B after watchdog, even with the same timestamp', async kind => {
    const n = await fixture(),
      input = body(n),
      opB = cuid(),
      stamp = new Date(Date.now() + 1000)
    let enterA!: () => void, enterB!: () => void, finishA!: () => void, finishB!: () => void
    const aStarted = new Promise<void>(resolve => {
      enterA = resolve
    })
    const bStarted = new Promise<void>(resolve => {
      enterB = resolve
    })
    const aReady = new Promise<void>(resolve => {
      finishA = resolve
    })
    const bReady = new Promise<void>(resolve => {
      finishB = resolve
    })
    const realRead = prisma.payment.findMany.bind(prisma.payment)
    let reads = 0
    const delayed = jest.spyOn(prisma.payment, 'findMany').mockImplementation((async (args: any) => {
      if (++reads === 1) {
        enterA()
        await aReady
      } else if (reads === 2) {
        enterB()
        await bReady
      }
      return realRead(args)
    }) as any)
    const ctx = (id: string) => ({
      actorStaffId: n.staffId,
      now: () => stamp,
      operation: {
        operationId: id,
        terminalSerial: n.serial,
        closedAtLocal: input.closedAtLocal,
        isOfflineReplay: true,
        cashDrawerSessionId: n.drawerId,
      },
    })
    const closingA = closeShiftForVenueWithResult(
      n.venueId,
      n.shiftId,
      kind === 'operation' ? input : { cashDeclared: 510 },
      kind === 'operation' ? ctx(n.operationId) : { actorStaffId: n.staffId, now: () => stamp },
    ).then(
      () => ({ code: 'STOLEN' }),
      error => error,
    )
    let closingB: ReturnType<typeof closeShiftForVenueWithResult> | undefined
    try {
      await aStarted
      const watchdog = new ShiftCloseWatchdogJob({ now: () => new Date(stamp.getTime() + 400_000), cron: { start() {}, async stop() {} } })
      expect((await watchdog.runNow()).reopened).toBeGreaterThanOrEqual(1)
      if (kind === 'operation') expect((await operation(n)).resultJson).toEqual({ claimedAt: null })
      closingB = closeShiftForVenueWithResult(
        n.venueId,
        n.shiftId,
        { cashReconciliationAction: 'COUNTED', countedCash: '650.00' },
        ctx(opB),
      )
      await bStarted
      finishA()
      expect(await closingA).toMatchObject({ code: 'SHIFT_CLOSE_IN_PROGRESS' })
      const live = await prisma.shift.findFirstOrThrow({ where: { id: n.shiftId, venueId: n.venueId } })
      expect(live.status).toBe('CLOSING')
      expect(live.endTime).toBeNull()
      expect((await operation(n, opB)).state).toBe('PENDING')
      finishB()
      expect((await closingB).operation).toMatchObject({ state: 'APPLIED', submittedCountedCash: '650.00' })
      expect(await auditCount(n)).toBe(1)
    } finally {
      finishA()
      finishB()
      await closingA
      await closingB?.catch(() => undefined)
      delayed.mockRestore()
    }
  })

  it('failure closing the drawer leaves a truthful durable half; real reconciler repairs it and GET reports COMPLETE', async () => {
    const n = await fixture(),
      input = body(n)
    await prisma.$executeRawUnsafe(`CREATE FUNCTION s2_drawer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.id = '${n.drawerId}' AND NEW.status = 'CLOSED' THEN RAISE EXCEPTION 'S2_DRAWER_FAILURE'; END IF; RETURN NEW; END $$`)
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER s2_drawer_failure BEFORE UPDATE ON "CashDrawerSession" FOR EACH ROW EXECUTE FUNCTION s2_drawer_failure()',
    )
    try {
      const r = await close(n, input)
      expect(r.status).toBe(200)
      expect(r.body.operation).toMatchObject({ state: 'APPLIED', pairStatus: 'PENDING' })
      expect(r.body.reconciliation).not.toHaveProperty('cashDrawer')
      expect((await operation(n)).resultJson).toMatchObject({ operation: { pairStatus: 'PENDING' } })
    } finally {
      await dropTrigger('CashDrawerSession', 's2_drawer_failure')
    }
    const job = new CashClosePairReconcilerJob({ cron: { start() {}, async stop() {} } })
    expect((await job.runNow()).repaired).toBeGreaterThanOrEqual(1)
    expect((await status(n)).body.operation.pairStatus).toBe('COMPLETE')
    expect(
      (await prisma.cashDrawerSession.findFirstOrThrow({ where: { id: n.drawerId, venueId: n.venueId } })).actualAmount?.toString(),
    ).toBe('510')
    expect(await auditCount(n)).toBe(1)
  })

  it.each(['2038-01-01T00:00:00Z', '2010-01-01T00:00:00Z', '2026-10-26T23:59:00-06:00'])(
    'local clock %s stays evidence and never changes the financial close time',
    async date => {
      const n = await fixture(),
        before = Date.now()
      const r = await close(n, body(n, { closedAtLocal: date }))
      expect(r.status).toBe(200)
      expect(new Date(r.body.data.endTime).getTime()).toBeGreaterThanOrEqual(before)
      expect((await operation(n)).requestJson).toMatchObject({ closedAtLocal: new Date(date).toISOString() })
    },
  )

  it('disabled, SKIPPED and legacy retain their protocol and do not invent applied counts', async () => {
    for (const mode of ['disabled', 'skipped', 'legacy']) {
      const n = await fixture()
      if (mode === 'disabled')
        await prisma.venueSettings.update({ where: { venueId: n.venueId }, data: { cashReconciliationEnabled: false } })
      const input =
        mode === 'skipped'
          ? body(n, { cashReconciliationAction: 'SKIPPED', countedCash: undefined })
          : mode === 'legacy'
            ? { cashDeclared: 600 }
            : body(n)
      const r = await close(n, input)
      expect(r.status).toBe(200)
      expect(r.body.reconciliation.outcome).toBe(
        mode === 'disabled' ? 'IGNORED_DISABLED' : mode === 'skipped' ? 'SKIPPED' : 'LEGACY_APPLIED',
      )
      if (mode === 'legacy') expect(r.body).not.toHaveProperty('operation')
      else {
        expect(r.body.operation.countApplied).toBe(false)
        expect(r.body.data.cashDeclared).toBeNull()
        expect((await prisma.cashDrawerSession.findFirstOrThrow({ where: { id: n.drawerId, venueId: n.venueId } })).actualAmount).toBeNull()
      }
    }
  })

  it('exact GET checks current read permission, active actor, venue and authenticated terminal; no internal request/serial leaks', async () => {
    const n = await fixture(),
      input = body(n)
    expect((await close(n, input)).status).toBe(200)
    const read = await status(n)
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.body)).not.toMatch(/requestJson|requestHash|terminalSerial|declaredStaffId|claimedAt/)
    expect((await status(n, n.operationId, n.staffId, `AVQD-${cuid()}`)).status).toBe(404)
    const foreign = await fixture()
    expect((await status(foreign, n.operationId)).status).toBe(404)
    const set = await prisma.permissionSet.create({ data: { name: `No read ${cuid()}`, venueId: n.venueId, permissions: [] } })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } },
      data: { permissionSetId: set.id },
    })
    expect((await status(n)).status).toBe(403)
    expect((await close(n, input)).status).toBe(403)
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } },
      data: { permissionSetId: null },
    })
    await prisma.staff.update({ where: { id: n.staffId }, data: { active: false } })
    expect((await status(n)).status).toBe(403)
    expect((await close(n, input)).status).toBe(403)
  })
})
