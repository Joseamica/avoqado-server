import cuid from 'cuid'
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import prisma from '@/utils/prismaClient'
import { openShift } from '@/controllers/tpv/shift.tpv.controller'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable propia de avq-verify, nunca av-db-25.')
}

const app = express()
app.use(express.json())
app.post(
  '/venues/:venueId/shifts/open',
  (req, _res, next) => {
    // Only authentication is supplied by the fixture; permission, validation and database writes are real.
    req.authContext = {
      userId: req.get('x-test-actor')!,
      orgId: 'test-org',
      venueId: req.params.venueId,
      role: StaffRole.OWNER,
      terminalSerialNumber: req.get('x-test-terminal'),
    }
    next()
  },
  checkPermission('tpv-shifts:create'),
  openShift,
)
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
})

async function fixture() {
  const key = cuid()
  const org = await prisma.organization.create({ data: { name: `S1 ${key}`, email: `${key}@example.com`, phone: '5555555555' } })
  const venue = await prisma.venue.create({ data: { name: `S1 ${key}`, slug: `s1-${key}`, organizationId: org.id } })
  const staff = await prisma.staff.create({ data: { firstName: 'Actual', lastName: 'Actor', email: `${key}@staff.test`, active: true } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: StaffRole.OWNER } })
  const serial = `AVQD-${key}`
  await prisma.terminal.create({
    data: { venueId: venue.id, serialNumber: serial, name: 'S1 terminal', type: 'TPV_ANDROID', status: 'ACTIVE' },
  })
  const operationId = cuid()
  return { venueId: venue.id, staffId: staff.id, serial, operationId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

const body = (n: Fixture, delta: Record<string, unknown> = {}) => ({
  operationId: n.operationId,
  localId: n.operationId,
  startingCash: 500,
  staffId: 'not-the-authority',
  openedAt: new Date(Date.now() - 60_000).toISOString(),
  isOfflineReplay: true,
  ...delta,
})
const open = (n: Fixture, input: object, serial = n.serial) =>
  request(app).post(`/venues/${n.venueId}/shifts/open`).set('x-test-actor', n.staffId).set('x-test-terminal', serial).send(input)

async function closePair(n: Fixture, shiftId: string, drawerId: string) {
  await prisma.$transaction([
    prisma.shift.update({ where: { id: shiftId }, data: { status: 'CLOSED', endTime: new Date() } }),
    prisma.cashDrawerSession.update({ where: { id: drawerId }, data: { status: 'CLOSED', closedAt: new Date() } }),
  ])
}
const counts = async (venueId: string) => ({
  shifts: await prisma.shift.count({ where: { venueId } }),
  drawers: await prisma.cashDrawerSession.count({ where: { venueId } }),
  events: await prisma.cashDrawerEvent.count({ where: { venueId } }),
  operations: await prisma.tpvShiftOperation.count({ where: { venueId } }),
})

describe('TPV durable opening — real Postgres and HTTP boundary', () => {
  it.each(['OWN', 'ADOPTED'] as const)(
    '%s + lost response + closed A/open B recovers only A without another money event',
    async disposition => {
      const n = await fixture()
      let originalKey = n.operationId
      if (disposition === 'ADOPTED') {
        originalKey = cuid()
        const original = await abrirTurnoDeCaja({
          venueId: n.venueId,
          staffId: n.staffId,
          startingCash: 2000,
          source: 'TURNO_TPV',
          localId: originalKey,
        })
        await prisma.shift.update({ where: { id: original.shiftId }, data: { startingCash: 300 } })
      }
      const input = body(n)
      const first = await open(n, input)
      expect(first.status).toBe(201)
      expect(first.body.data).toMatchObject({
        openingDisposition: disposition,
        localId: originalKey,
        fondoAplicado: disposition === 'ADOPTED' ? '2000' : '500',
      })
      const a = first.body.data
      const operation = await prisma.tpvShiftOperation.findFirstOrThrow({ where: { id: n.operationId, venueId: n.venueId } })
      expect(operation.actorStaffId).toBe(n.staffId)
      expect(operation.requestJson).toMatchObject({ declaredStaffId: 'not-the-authority' })
      await closePair(n, a.id, a.cashDrawerSessionId)
      const b = await abrirTurnoDeCaja({ venueId: n.venueId, staffId: n.staffId, startingCash: 100, source: 'TURNO_TPV' })
      const before = await counts(n.venueId)
      const replay = await open(n, input)
      expect(replay.status).toBe(201)
      expect(replay.body.data).toMatchObject({
        id: a.id,
        cashDrawerSessionId: a.cashDrawerSessionId,
        status: 'CLOSED',
        openingDisposition: disposition,
        localId: originalKey,
        fondoAplicado: disposition === 'ADOPTED' ? '2000' : '500',
        reintento: true,
      })
      expect(Number(replay.body.data.startingCash)).toBe(disposition === 'ADOPTED' ? 300 : 500)
      expect(await counts(n.venueId)).toEqual(before)
      expect((await prisma.shift.findFirstOrThrow({ where: { venueId: n.venueId, id: b.shiftId } })).status).toBe('OPEN')
      expect(await prisma.cashDrawerEvent.count({ where: { venueId: n.venueId, type: 'PAY_IN' } })).toBe(0)
    },
  )

  it('changed money or another authenticated terminal cannot reuse an operation', async () => {
    const n = await fixture()
    const input = body(n)
    expect((await open(n, input)).status).toBe(201)
    const before = await counts(n.venueId)
    const otherSerial = `AVQD-${cuid()}`
    await prisma.terminal.create({ data: { venueId: n.venueId, serialNumber: otherSerial, name: 'Second', type: 'TPV_ANDROID' } })
    for (const response of [await open(n, { ...input, startingCash: 501 }), await open(n, input, otherSerial)]) {
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('SHIFT_OPERATION_CONTRACT_MISMATCH')
    }
    expect(await counts(n.venueId)).toEqual(before)
  })

  it('an old OPEN without an operation row is ADOPTED, because its original terminal identity is unknown', async () => {
    const n = await fixture()
    const original = await abrirTurnoDeCaja({
      venueId: n.venueId,
      staffId: n.staffId,
      startingCash: 500,
      source: 'CAJA_MOVIL',
      localId: n.operationId,
    })
    const input = body(n)
    const first = await open(n, input)
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({
      id: original.shiftId,
      cashDrawerSessionId: original.cashDrawerSessionId,
      openingDisposition: 'ADOPTED',
      cajaCreada: false,
      reintento: true,
    })
    expect(await counts(n.venueId)).toEqual({ shifts: 1, drawers: 1, events: 1, operations: 1 })
    expect(await prisma.activityLog.count({ where: { venueId: n.venueId, action: 'TPV_SHIFT_OPEN_RESOLVED' } })).toBe(1)
    expect((await open(n, input)).body.data).toMatchObject({ openingDisposition: 'ADOPTED', cajaCreada: false, reintento: true })
    expect(await prisma.activityLog.count({ where: { venueId: n.venueId, action: 'TPV_SHIFT_OPEN_RESOLVED' } })).toBe(1)
  })

  it('same PK in another tenant returns no foreign result and rolls back its tentative opening', async () => {
    const a = await fixture()
    expect((await open(a, body(a))).status).toBe(201)
    const b = await fixture()
    const response = await open(b, body(b, { operationId: a.operationId, localId: a.operationId }))
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('SHIFT_OPERATION_CONTRACT_MISMATCH')
    expect(response.body).not.toHaveProperty('data')
    expect(await counts(b.venueId)).toEqual({ shifts: 0, drawers: 0, events: 0, operations: 0 })
  })

  it('permission revocation applies to replays too', async () => {
    const n = await fixture()
    const input = body(n)
    expect((await open(n, input)).status).toBe(201)
    const denied = await prisma.permissionSet.create({ data: { venueId: n.venueId, name: 'No operations', permissions: [] } })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: n.staffId, venueId: n.venueId } },
      data: { permissionSetId: denied.id },
    })
    expect((await open(n, input)).status).toBe(403)
  })

  it('an inactive actor cannot replay a previously authorized result', async () => {
    const n = await fixture()
    const input = body(n)
    expect((await open(n, input)).status).toBe(201)
    await prisma.staff.update({ where: { id: n.staffId }, data: { active: false } })
    expect((await open(n, input)).status).toBe(403)
  })

  it('concurrent repetitions commit one operation, one pair and one OPEN event', async () => {
    const n = await fixture()
    const input = body(n)
    const responses = await Promise.all([open(n, input), open(n, input)])
    expect(responses.map(r => r.status)).toEqual([201, 201])
    expect(responses[0].body.data.id).toBe(responses[1].body.data.id)
    expect(await counts(n.venueId)).toEqual({ shifts: 1, drawers: 1, events: 1, operations: 1 })
  })

  it('a drawer linked to another shift returns review conflict and preserves the original links', async () => {
    const n = await fixture()
    const old = await prisma.shift.create({
      data: { venueId: n.venueId, staffId: n.staffId, status: 'CLOSED', startTime: new Date(), endTime: new Date() },
    })
    const current = await prisma.shift.create({ data: { venueId: n.venueId, staffId: n.staffId, status: 'OPEN', startTime: new Date() } })
    const drawer = await prisma.cashDrawerSession.create({
      data: { venueId: n.venueId, shiftId: old.id, openedByStaffId: n.staffId, openedByName: 'Original', startingAmount: 2000 },
    })
    const before = await counts(n.venueId)
    const response = await open(n, body(n))
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('SHIFT_OPEN_PAIR_CONFLICT')
    expect(await counts(n.venueId)).toEqual(before)
    expect((await prisma.cashDrawerSession.findFirstOrThrow({ where: { venueId: n.venueId, id: drawer.id } })).shiftId).toBe(old.id)
    expect((await prisma.shift.findFirstOrThrow({ where: { venueId: n.venueId, id: current.id } })).status).toBe('OPEN')
  })

  it('failure on operation insertion after the pair exists rolls back BOTH the pair and its events', async () => {
    const n = await fixture()
    await prisma.$executeRawUnsafe(`CREATE FUNCTION s1_fail_after_pair() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."requestJson"->>'stationId' = 'S1_FAIL_AFTER_PAIR' THEN
          IF NOT EXISTS (SELECT 1 FROM "Shift" WHERE id = NEW."shiftId")
            OR NOT EXISTS (SELECT 1 FROM "CashDrawerSession" WHERE id = NEW."cashDrawerSessionId") THEN
            RAISE EXCEPTION 'PAIR_WAS_NOT_CREATED';
          END IF;
          RAISE EXCEPTION 'S1_SECOND_WRITE_AFTER_PAIR';
        END IF;
        RETURN NEW;
      END $$`)
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER s1_fail_after_pair BEFORE INSERT ON "TpvShiftOperation" FOR EACH ROW EXECUTE FUNCTION s1_fail_after_pair()',
    )
    try {
      const response = await open(n, body(n, { stationId: 'S1_FAIL_AFTER_PAIR' }))
      expect(response.status).toBe(500)
      expect(response.body.message).toContain('S1_SECOND_WRITE_AFTER_PAIR')
      expect(await counts(n.venueId)).toEqual({ shifts: 0, drawers: 0, events: 0, operations: 0 })
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER s1_fail_after_pair ON "TpvShiftOperation"')
      await prisma.$executeRawUnsafe('DROP FUNCTION s1_fail_after_pair()')
    }
  })

  it('REGRESSION: legacy body works without terminal identity and gains no operation metadata', async () => {
    const n = await fixture()
    const response = await request(app)
      .post(`/venues/${n.venueId}/shifts/open`)
      .set('x-test-actor', n.staffId)
      .send({ staffId: n.staffId, startingCash: 50 })
    expect(response.status).toBe(201)
    expect(response.body.data).not.toHaveProperty('openingDisposition')
    expect(await counts(n.venueId)).toEqual({ shifts: 1, drawers: 1, events: 1, operations: 0 })
  })
})
