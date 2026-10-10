import type { Request, Response, NextFunction } from 'express'
import { randomUUID, randomInt } from 'crypto'
import type { Prisma as PrismaTypes } from '@prisma/client'
import type {
  DomainResult,
  HttpEnvelope,
  HttpManifest,
  OperationInput,
  OperationReply,
} from '@/services/mobile/http-operation.mobile.service'

type RemoveInput = OperationInput<'removeServiceCharge'>

// El launcher verifica propiedad/puerto/base exactos antes de Jest y dotenv.
// Este guard general también precede los imports productivos del test.
const testDatabaseUrl = process.env.TEST_DATABASE_URL
let testDatabase: URL
try {
  testDatabase = new URL(testDatabaseUrl ?? '')
} catch {
  throw new Error('Exige TEST_DATABASE_URL propia local válida; no se imprimió la URL')
}
if (
  !['postgres:', 'postgresql:'].includes(testDatabase.protocol) ||
  !['localhost', '127.0.0.1'].includes(testDatabase.hostname) ||
  !/^\/avoqado_[a-z0-9]+_test_/.test(testDatabase.pathname) ||
  process.env.DATABASE_URL !== testDatabaseUrl
) {
  throw new Error('Exige DB propia local y DATABASE_URL=TEST_DATABASE_URL; no se imprimió la URL')
}

const { Prisma, PrismaClient } = require('@prisma/client') as typeof import('@prisma/client')
const prisma = (require('@/utils/prismaClient') as typeof import('@/utils/prismaClient')).default
const { executeHttpOperation, resolveHttpOperation, serializeEnvelope, fingerprint, isReceiptKeyCollision } =
  require('@/services/mobile/http-operation.mobile.service') as typeof import('@/services/mobile/http-operation.mobile.service')
const { removeServiceChargeInTransaction } =
  require('@/services/mobile/service-charge.mobile.service') as typeof import('@/services/mobile/service-charge.mobile.service')

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => null },
}))

jest.setTimeout(45_000)
const venueId = `gate-a-${randomUUID()}`
let authorId: string
let managerId: string
let readerId: string

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: venueId, name: 'Gate A', email: `${venueId}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Gate A', slug: venueId } })
  for (const role of ['WAITER', 'MANAGER', 'VIEWER'] as const) {
    const staff = await prisma.staff.create({
      data: { email: `${randomUUID()}@example.test`, firstName: role, lastName: 'Gate A', active: true },
    })
    await prisma.staffVenue.create({ data: { venueId, staffId: staff.id, role, active: true } })
    if (role === 'WAITER') authorId = staff.id
    if (role === 'MANAGER') managerId = staff.id
    if (role === 'VIEWER') readerId = staff.id
  }
})

afterEach(() => jest.restoreAllMocks())
// Se conservan las filas UUID de esta corrida; el environment dispone sus clientes después de los hooks.
afterAll(async () => {
  await prisma.$disconnect()
})

async function fixture(targetVenueId = venueId): Promise<RemoveInput> {
  const order = await prisma.order.create({
    data: {
      venueId: targetVenueId,
      orderNumber: randomUUID(),
      servedById: authorId,
      subtotal: 100,
      taxAmount: 0,
      total: 110,
      serviceChargeAmount: 10,
      remainingBalance: 110,
      contratoDePrecio: 'IVA_INCLUIDO',
      items: { create: { productName: 'Gate A test', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
    },
  })
  const catalog = await prisma.serviceCharge.create({
    data: { venueId: targetVenueId, name: `gate-a-${randomUUID()}`, type: 'FIXED_AMOUNT', value: 10 },
  })
  const row = await prisma.orderServiceCharge.create({
    data: {
      orderId: order.id,
      serviceChargeId: catalog.id,
      name: catalog.name,
      type: 'FIXED_AMOUNT',
      value: 10,
      amount: 10,
      taxable: false,
      isAutomatic: false,
    },
  })
  return {
    venueId: targetVenueId,
    actorId: authorId,
    operation: { version: 1, id: randomUUID(), deviceId: randomUUID() },
    manifest: { action: 'removeServiceCharge', refs: { orderId: order.id, orderServiceChargeId: row.id }, payload: {} },
  }
}

async function foreignFixture(): Promise<RemoveInput> {
  const foreignVenueId = `gate-a-foreign-${randomUUID()}`
  await prisma.organization.create({
    data: { id: foreignVenueId, name: 'Foreign Gate A', email: `${foreignVenueId}@example.test`, phone: '5500000000' },
  })
  await prisma.venue.create({
    data: { id: foreignVenueId, organizationId: foreignVenueId, name: 'Foreign Gate A', slug: foreignVenueId },
  })
  return fixture(foreignVenueId)
}

async function removeDomain(tx: PrismaTypes.TransactionClient, input: RemoveInput): Promise<DomainResult<'removeServiceCharge'>> {
  const { row, totals } = await removeServiceChargeInTransaction(
    tx,
    input.venueId,
    input.manifest.refs.orderId,
    input.manifest.refs.orderServiceChargeId,
  )
  return {
    response: { status: 200, body: { success: true, data: totals } },
    affectedRefs: [
      { kind: 'Order', id: input.manifest.refs.orderId },
      { kind: 'OrderServiceCharge', id: row.id },
    ],
  }
}
const remove = (input: RemoveInput) => executeHttpOperation(input, tx => removeDomain(tx, input))

function terminal(reply: OperationReply): HttpEnvelope {
  if (reply.kind !== 'TERMINAL') throw new Error('Se esperaba resultado terminal')
  return reply.envelope
}

const stored = <A extends HttpEnvelope['action']>(input: OperationInput<A>) =>
  prisma.posSyncIntent.findUnique({
    where: { venueId_idempotencyKey: { venueId: input.venueId, idempotencyKey: `http:v1:${input.operation.id}` } },
  })

async function orderSnapshot(orderId: string, tx: PrismaTypes.TransactionClient = prisma) {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      taxAmount: true,
      total: true,
      paidAmount: true,
      remainingBalance: true,
      paymentStatus: true,
      version: true,
    },
  })
  return {
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discountAmount),
    serviceChargeAmount: Number(order.serviceChargeAmount),
    taxAmount: Number(order.taxAmount),
    total: Number(order.total),
    paidAmount: Number(order.paidAmount),
    remainingBalance: Number(order.remainingBalance),
    paymentStatus: order.paymentStatus,
    version: order.version,
  }
}

const staffAccess = (staffId: string) =>
  prisma.staffVenue.findUniqueOrThrow({
    where: { staffId_venueId: { staffId, venueId } },
    select: { role: true, active: true, permissionSetId: true },
  })

function evidence<A extends HttpEnvelope['action']>(name: string, input: OperationInput<A>, details: Record<string, unknown>) {
  process.stdout.write(
    `GATE_A_PG_EVIDENCE ${JSON.stringify({ name, operationId: input.operation.id, refs: input.manifest.refs, ...details })}\n`,
  )
}

function resultSummary(result: PromiseSettledResult<OperationReply>) {
  if (result.status === 'fulfilled') {
    const reply = result.value
    return reply.kind === 'TERMINAL'
      ? { status: result.status, kind: reply.kind, outcome: reply.envelope.outcome, appliedNow: reply.appliedNow }
      : { status: result.status, kind: reply.kind, code: reply.code }
  }
  const reason = result.reason as { statusCode?: number; code?: string }
  return { status: result.status, statusCode: reason?.statusCode, code: reason?.code }
}

test('same UUID concurrent requests apply once with exact original body', async () => {
  const input = await fixture()
  const [a, b] = await Promise.all([remove(input), remove(input)])
  expect(terminal(a)).toEqual(terminal(b))
  expect([a, b].filter(reply => reply.kind === 'TERMINAL' && reply.appliedNow)).toHaveLength(1)
  expect(terminal(a)).toMatchObject({
    outcome: 'APPLIED',
    originalResponse: {
      status: 200,
      body: { success: true, data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 } },
    },
    affectedRefs: [
      { kind: 'Order', id: input.manifest.refs.orderId },
      { kind: 'OrderServiceCharge', id: input.manifest.refs.orderServiceChargeId },
    ],
  })
  const receipt = await stored(input)
  expect(receipt).toMatchObject({
    type: 'HTTP_OP_V1',
    status: 'ACKED',
    staffId: authorId,
    deviceId: input.operation.deviceId,
    seq: null,
    localRef: null,
    errorCode: null,
  })
  expect(receipt?.resultJson).toEqual(terminal(a))
  const envelope = terminal(a)
  if (envelope.outcome !== 'APPLIED') throw new Error('Se esperaba un recibo aplicado')
  expect(envelope.originalResponse).toEqual({
    status: 200,
    body: { success: true, data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 } },
  })
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(0)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toMatchObject({ total: 100, serviceChargeAmount: 0, version: 2 })
  evidence('sameUUID', input, { results: [a, b].map(value => resultSummary({ status: 'fulfilled', value })) })
})

test('lostResponseIsOriginal: later Order changes do not rewrite receipt', async () => {
  const input = await fixture()
  const committed = await remove(input)
  const receipt = await stored(input)
  await prisma.order.update({ where: { id: input.manifest.refs.orderId }, data: { total: 321, version: { increment: 1 } } })
  expect(terminal(await resolveHttpOperation(input))).toEqual(terminal(committed))
  expect(terminal(await remove(input))).toEqual(terminal(committed))
  expect(await stored(input)).toEqual(receipt)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toMatchObject({ total: 321, version: 3 })
})

test('bindingConflicts: actor, device and real reference mismatch never apply', async () => {
  const input = await fixture()
  const other = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const otherBefore = await orderSnapshot(other.manifest.refs.orderId)
  for (const changed of [
    { ...input, actorId: managerId },
    { ...input, operation: { ...input.operation, deviceId: randomUUID() } },
    {
      ...input,
      manifest: { ...input.manifest, refs: { ...input.manifest.refs, orderServiceChargeId: other.manifest.refs.orderServiceChargeId } },
    },
    { ...input, manifest: { ...input.manifest, refs: other.manifest.refs } },
  ]) {
    await expect(remove(changed)).rejects.toMatchObject({ statusCode: 409, code: 'HTTP_OPERATION_CONFLICT' })
  }
  await expect(resolveHttpOperation({ ...input, venueId: other.venueId + '-missing' })).rejects.toMatchObject({ statusCode: 403 })
  expect(await stored(input)).toEqual(receipt)
  expect(await orderSnapshot(other.manifest.refs.orderId)).toEqual(otherBefore)
  expect(await prisma.orderServiceCharge.count({ where: { id: other.manifest.refs.orderServiceChargeId } })).toBe(1)
})

test('tombstoneCreatorAfterDemotion: only creator or current delegate reads null-original tombstone', async () => {
  const input = await fixture()
  const delegated = { ...input, actorId: managerId }
  const originalAccess = await staffAccess(managerId)
  const before = await orderSnapshot(input.manifest.refs.orderId)
  try {
    const fenced = await resolveHttpOperation(delegated)
    expect(fenced).toMatchObject({
      kind: 'TERMINAL',
      appliedNow: false,
      envelope: { outcome: 'REJECTED', request: { originalActorId: null }, fencedByStaffId: managerId },
    })
    expect(await stored(input)).toMatchObject({ status: 'REJECTED', staffId: managerId, seq: null, localRef: null })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { role: 'WAITER' } })
    expect(terminal(await resolveHttpOperation(delegated))).toEqual(terminal(fenced))
    await expect(resolveHttpOperation(input)).rejects.toMatchObject({ statusCode: 403 })
    expect(terminal(await remove(input))).toEqual(terminal(fenced))
    expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
    expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { active: false } })
    await expect(resolveHttpOperation(delegated)).rejects.toMatchObject({ statusCode: 403 })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: originalAccess })
  }
})

test('author without row cannot fence; pay-any is insufficient', async () => {
  const input = await fixture()
  const originalAccess = await staffAccess(readerId)
  try {
    await expect(resolveHttpOperation(input)).rejects.toMatchObject({ statusCode: 403 })
    const permissionSet = await prisma.permissionSet.create({
      data: { venueId, name: `gate-a-pay-any-${randomUUID()}`, permissions: ['orders:read', 'tables:pay-any'] },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: readerId, venueId } },
      data: { permissionSetId: permissionSet.id },
    })
    await expect(resolveHttpOperation({ ...input, actorId: readerId })).rejects.toMatchObject({ statusCode: 403 })
    expect(await stored(input)).toBeNull()
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: originalAccess })
  }
})

test('current membership and orders:read are required even for a committed author', async () => {
  const input = await fixture()
  const committed = await remove(input)
  const originalAccess = await staffAccess(authorId)
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { active: false } })
    await expect(resolveHttpOperation(input)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
    const permissionSet = await prisma.permissionSet.create({
      data: { venueId, name: `gate-a-no-order-read-${randomUUID()}`, permissions: ['tables:manage-all'] },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: authorId, venueId } },
      data: { active: true, permissionSetId: permissionSet.id },
    })
    await expect(resolveHttpOperation(input)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
    expect((await stored(input))?.resultJson).toEqual(terminal(committed))
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: originalAccess })
  }
  expect(terminal(await resolveHttpOperation(input))).toEqual(terminal(committed))
})

test('PermissionSet replaces MANAGER defaults and grants VIEWER delegation explicitly', async () => {
  const denied = await fixture()
  const granted = await fixture()
  const managerAccess = await staffAccess(managerId)
  const readerAccess = await staffAccess(readerId)
  try {
    const readOnly = await prisma.permissionSet.create({
      data: { venueId, name: `gate-a-manager-read-only-${randomUUID()}`, permissions: ['orders:read'] },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: managerId, venueId } },
      data: { permissionSetId: readOnly.id },
    })
    await expect(resolveHttpOperation({ ...denied, actorId: managerId })).rejects.toMatchObject({ statusCode: 403 })
    expect(await stored(denied)).toBeNull()
    const delegated = await prisma.permissionSet.create({
      data: { venueId, name: `gate-a-viewer-delegate-${randomUUID()}`, permissions: ['orders:read', 'tables:manage-all'] },
    })
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: readerId, venueId } },
      data: { permissionSetId: delegated.id },
    })
    expect(await resolveHttpOperation({ ...granted, actorId: readerId })).toMatchObject({
      kind: 'TERMINAL',
      envelope: { outcome: 'REJECTED', request: { originalActorId: null }, fencedByStaffId: readerId },
    })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: managerAccess })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: readerAccess })
  }
})

test('VenueRolePermission deniedPermissions removes default delegation', async () => {
  const input = await fixture()
  const where = { venueId_role: { venueId, role: 'MANAGER' as const } }
  const prior = await prisma.venueRolePermission.findUnique({ where })
  try {
    await prisma.venueRolePermission.upsert({
      where,
      create: { venueId, role: 'MANAGER', permissions: [], deniedPermissions: ['tables:manage-all'], modifiedBy: managerId },
      update: { permissions: [], deniedPermissions: ['tables:manage-all'], modifiedBy: managerId },
    })
    await expect(resolveHttpOperation({ ...input, actorId: managerId })).rejects.toMatchObject({ statusCode: 403 })
    expect(await stored(input)).toBeNull()
  } finally {
    if (prior) {
      await prisma.venueRolePermission.update({
        where,
        data: { permissions: prior.permissions, deniedPermissions: prior.deniedPermissions, modifiedBy: prior.modifiedBy },
      })
    } else {
      await prisma.venueRolePermission.delete({ where })
    }
  }
})

test('absence plus deleted charge stays RETRY without tombstone', async () => {
  const input = await fixture()
  await prisma.orderServiceCharge.delete({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const before = await orderSnapshot(input.manifest.refs.orderId)
  expect(await resolveHttpOperation({ ...input, actorId: managerId })).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(input)).toBeNull()
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
})

test('foreign charge cannot be fenced even when Order belongs to venue', async () => {
  const input = await fixture()
  const other = await fixture()
  const ownBefore = await orderSnapshot(input.manifest.refs.orderId)
  const otherBefore = await orderSnapshot(other.manifest.refs.orderId)
  const mismatched = {
    ...input,
    actorId: managerId,
    manifest: {
      ...input.manifest,
      refs: { orderId: input.manifest.refs.orderId, orderServiceChargeId: other.manifest.refs.orderServiceChargeId },
    },
  }
  await expect(resolveHttpOperation(mismatched)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
  expect(await stored(input)).toBeNull()
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(ownBefore)
  expect(await orderSnapshot(other.manifest.refs.orderId)).toEqual(otherBefore)
  expect(await prisma.orderServiceCharge.count({ where: { id: other.manifest.refs.orderServiceChargeId } })).toBe(1)
})

const invalidRefCases = ['missing-order', 'foreign-order', 'other-order-charge', 'paid-order-foreign-charge'] as const
type InvalidRefCase = (typeof invalidRefCases)[number]
async function invalidPostInput(kind: InvalidRefCase): Promise<RemoveInput> {
  const input = await fixture()
  if (kind === 'missing-order') {
    return { ...input, manifest: { ...input.manifest, refs: { ...input.manifest.refs, orderId: `missing-${randomUUID()}` } } }
  }
  if (kind === 'foreign-order') {
    const foreign = await foreignFixture()
    return { ...input, manifest: { ...input.manifest, refs: foreign.manifest.refs } }
  }
  const other = kind === 'paid-order-foreign-charge' ? await foreignFixture() : await fixture()
  if (kind === 'paid-order-foreign-charge') {
    await prisma.order.update({
      where: { id: input.manifest.refs.orderId },
      data: { paymentStatus: 'PAID', paidAmount: 110, remainingBalance: 0 },
    })
  }
  return {
    ...input,
    manifest: { ...input.manifest, refs: { ...input.manifest.refs, orderServiceChargeId: other.manifest.refs.orderServiceChargeId } },
  }
}

test.each(invalidRefCases)('POST %s cannot accredit unverified refs in a terminal receipt', async kind => {
  const input = await invalidPostInput(kind)
  const chargeBefore = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const orderBefore = await orderSnapshot(chargeBefore.orderId)
  const targetBefore = await prisma.order.findUnique({
    where: { id: input.manifest.refs.orderId },
    select: { version: true, total: true, paymentStatus: true },
  })
  await expect(remove(input)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
  expect(await stored(input)).toBeNull()
  expect(await prisma.orderServiceCharge.findUnique({ where: { id: chargeBefore.id } })).toEqual(chargeBefore)
  expect(await orderSnapshot(chargeBefore.orderId)).toEqual(orderBefore)
  expect(
    await prisma.order.findUnique({
      where: { id: input.manifest.refs.orderId },
      select: { version: true, total: true, paymentStatus: true },
    }),
  ).toEqual(targetBefore)
})

test('POST with deleted charge cannot turn NotFound into a trusted terminal receipt', async () => {
  const input = await fixture()
  await prisma.orderServiceCharge.delete({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const before = await orderSnapshot(input.manifest.refs.orderId)
  expect(await remove(input)).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(input)).toBeNull()
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
})

test('bound rejection and tombstone recover after their domain charge disappears', async () => {
  const rejected = await fixture()
  await prisma.order.update({
    where: { id: rejected.manifest.refs.orderId },
    data: { paymentStatus: 'PAID', paidAmount: 110, remainingBalance: 0 },
  })
  const rejection = terminal(await remove(rejected))
  expect(rejection).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: authorId } })
  expect(await stored(rejected)).toMatchObject({ status: 'REJECTED', staffId: authorId })
  await prisma.orderServiceCharge.delete({ where: { id: rejected.manifest.refs.orderServiceChargeId } })
  expect(terminal(await resolveHttpOperation(rejected))).toEqual(rejection)
  expect(terminal(await remove(rejected))).toEqual(rejection)
  const input = await fixture()
  const delegated = { ...input, actorId: managerId }
  const fenced = terminal(await resolveHttpOperation(delegated))
  await prisma.orderServiceCharge.delete({ where: { id: input.manifest.refs.orderServiceChargeId } })
  expect(terminal(await resolveHttpOperation(delegated))).toEqual(fenced)
  expect(terminal(await remove(input))).toEqual(fenced)
})

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const limit = Date.now() + 8_000
  while (Date.now() < limit) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('INCONCLUSO: no se observó el bloqueo PostgreSQL')
}

async function writtenTables(pid: number) {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT DISTINCT c.relname::text AS name
    FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
    WHERE l.pid=${pid}::int AND l.locktype='relation' AND l.mode='RowExclusiveLock' AND l.granted
    ORDER BY 1`
  return rows.map(row => row.name)
}

async function forceOrder<A extends HttpEnvelope['action']>(
  name: string,
  input: OperationInput<A>,
  status: 'PROCESSING' | 'REJECTED',
  first: () => Promise<OperationReply>,
  second: () => Promise<OperationReply>,
  whileBlocked: (pid: number, loser: Promise<OperationReply>) => Promise<void> = async () => {},
) {
  const suffix = randomUUID().replace(/-/g, '')
  const fn = `ga_fn_${suffix}`
  const trigger = `ga_trigger_${suffix}`
  const gate = randomInt(1, 2_000_000_000)
  const key = `http:v1:${input.operation.id}`
  const blocker = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  let unlock!: () => void
  let acquired!: () => void
  const release = new Promise<void>(resolve => {
    unlock = resolve
  })
  const held = new Promise<void>(resolve => {
    acquired = resolve
  })
  let hold: Promise<void> | undefined
  let winner: Promise<OperationReply> | undefined
  let loser: Promise<OperationReply> | undefined
  let winnerPid: number | undefined
  let loserPid: number | undefined
  let loserBlockedBy: number[] = []
  let winnerWriteTables: string[] = []
  let loserWriteTables: string[] = []
  try {
    // Todos los identificadores/literales proceden de UUIDs, enum e integer generados por este test.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$
      BEGIN IF NEW."idempotencyKey" = '${key}' AND NEW.type = 'HTTP_OP_V1' AND NEW.status = '${status}'
      THEN PERFORM pg_advisory_xact_lock(${gate}::bigint); END IF; RETURN NEW; END $b$`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" AFTER INSERT ON "PosSyncIntent"
      FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
    hold = blocker.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${gate}::bigint)`
        acquired()
        await release
      },
      { timeout: 30_000 },
    )
    await Promise.race([
      held,
      hold.then(() => {
        throw new Error('INCONCLUSO: blocker terminó sin retener lock')
      }),
    ])
    winner = first()
    void winner.catch(() => undefined)
    winnerPid = await eventually(async () => {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_locks
        WHERE locktype='advisory' AND classid=0 AND objid=${gate}::oid AND NOT granted`
      return rows[0]?.pid
    })
    loser = second()
    void loser.catch(() => undefined)
    const observedWinnerPid = winnerPid
    loserPid = await eventually(async () => {
      const rows = await prisma.$queryRaw<Array<{ pid: number; blockers: number[] }>>`
        SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE ${observedWinnerPid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`
      loserBlockedBy = rows[0]?.blockers ?? []
      return rows[0]?.pid
    })
    expect(loserBlockedBy).toContain(winnerPid)
    winnerWriteTables = await writtenTables(winnerPid)
    loserWriteTables = await writtenTables(loserPid)
    expect(loserWriteTables).toContain('PosSyncIntent')
    for (const table of ['Order', 'OrderServiceCharge', 'OrderItem', 'OrderDiscount', 'Customer', 'LoyaltyTransaction', 'StampReward'])
      expect(loserWriteTables).not.toContain(table)
    evidence(name, input, { phase: 'unique-blocked', gate, winnerPid, loserPid, loserBlockedBy, winnerWriteTables, loserWriteTables })
    await whileBlocked(loserPid, loser)
    unlock()
    await hold
    const results = await Promise.allSettled([winner, loser])
    evidence(name, input, {
      phase: 'settled',
      winnerPid,
      loserPid,
      loserBlockedBy,
      winnerWriteTables,
      loserWriteTables,
      results: results.map(resultSummary),
    })
    return results
  } catch (error) {
    evidence(name, input, { phase: 'INCONCLUSIVE_OR_FAILED', winnerPid, loserPid, loserBlockedBy, winnerWriteTables, loserWriteTables })
    throw error
  } finally {
    unlock()
    await Promise.allSettled([hold ?? Promise.resolve(), winner ?? Promise.resolve(), loser ?? Promise.resolve()])
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "PosSyncIntent"`)
    } finally {
      try {
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
      } finally {
        await blocker.$disconnect()
      }
    }
  }
}

test('POST wins; resolver sees original result, not its initial no-row branch', async () => {
  const input = await fixture()
  const results = await forceOrder(
    'postWins',
    input,
    'PROCESSING',
    () => remove(input),
    () => resolveHttpOperation({ ...input, actorId: managerId }),
  )
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Ambas operaciones deben terminar')
  expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
  expect(results[0].value).toMatchObject({ kind: 'TERMINAL', appliedNow: true })
  expect(results[1].value).toMatchObject({ kind: 'TERMINAL', appliedNow: false })
  expect(await stored(input)).toMatchObject({ status: 'ACKED', staffId: authorId })
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(0)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toMatchObject({ total: 100, version: 2 })
})

test('tombstone wins; losing POST writes no domain before unique and no later effects', async () => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  const results = await forceOrder(
    'tombstoneWins',
    input,
    'REJECTED',
    () => resolveHttpOperation({ ...input, actorId: managerId }),
    () => remove(input),
    async () => {
      expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
      expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
    },
  )
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Ambas operaciones deben terminar')
  expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
  expect(terminal(results[0].value)).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null } })
  expect(await stored(input)).toMatchObject({ status: 'REJECTED', staffId: managerId })
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
  expect(terminal(await remove(input))).toEqual(terminal(results[0].value))
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
})

test('revokedDelegateAfterPostWins', async () => {
  const input = await fixture()
  const originalAccess = await staffAccess(managerId)
  try {
    const results = await forceOrder(
      'revokedDelegateAfterPostWins',
      input,
      'PROCESSING',
      () => remove(input),
      () => resolveHttpOperation({ ...input, actorId: managerId }),
      async () => {
        await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { role: 'WAITER' } })
      },
    )
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', appliedNow: true } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' } })
    expect(await stored(input)).toMatchObject({ status: 'ACKED', staffId: authorId })
    expect(await orderSnapshot(input.manifest.refs.orderId)).toMatchObject({ total: 100, version: 2 })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: originalAccess })
  }
})

test('revoked PermissionSet after POST wins is freshly evaluated', async () => {
  const input = await fixture()
  const originalAccess = await staffAccess(managerId)
  const readOnly = await prisma.permissionSet.create({
    data: { venueId, name: `gate-a-race-revoked-${randomUUID()}`, permissions: ['orders:read'] },
  })
  try {
    const results = await forceOrder(
      'revokedPermissionSetAfterPostWins',
      input,
      'PROCESSING',
      () => remove(input),
      () => resolveHttpOperation({ ...input, actorId: managerId }),
      async () => {
        await prisma.staffVenue.update({
          where: { staffId_venueId: { staffId: managerId, venueId } },
          data: { permissionSetId: readOnly.id },
        })
      },
    )
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', appliedNow: true } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' } })
    expect(await stored(input)).toMatchObject({ status: 'ACKED', staffId: authorId })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: originalAccess })
  }
})

test('revoked creator cannot commit own tombstone after gate; losing POST may apply', async () => {
  const input = await fixture()
  const originalAccess = await staffAccess(managerId)
  try {
    const results = await forceOrder(
      'revokedOwnTombstone',
      input,
      'REJECTED',
      () => resolveHttpOperation({ ...input, actorId: managerId }),
      () => remove(input),
      async () => {
        await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { role: 'WAITER' } })
      },
    )
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' } })
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', appliedNow: true } })
    expect(await stored(input)).toMatchObject({ status: 'ACKED', staffId: authorId })
    expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(0)
    expect(await orderSnapshot(input.manifest.refs.orderId)).toMatchObject({ total: 100, version: 2 })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: originalAccess })
  }
})

test('oversizeRollsBackAndFences after domain already changed', async () => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  let deletedInside = false
  let inside: Awaited<ReturnType<typeof orderSnapshot>> | undefined
  const reply = await executeHttpOperation(input, async tx => {
    const result = await removeDomain(tx, input)
    deletedInside = (await tx.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })) === 0
    inside = await orderSnapshot(input.manifest.refs.orderId, tx)
    return {
      ...result,
      affectedRefs: [
        { kind: 'Order', id: input.manifest.refs.orderId },
        { kind: 'OrderServiceCharge', id: 'é'.repeat(524_288) },
      ],
    }
  })
  expect(deletedInside).toBe(true)
  expect(inside).toMatchObject({ total: 100, serviceChargeAmount: 0, version: 2 })
  expect(reply).toMatchObject({
    kind: 'TERMINAL',
    envelope: { outcome: 'REJECTED', rejection: { status: 413, code: 'RECEIPT_TOO_LARGE' } },
  })
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  const receipt = await stored(input)
  expect(receipt).toMatchObject({ status: 'REJECTED', errorCode: 'RECEIPT_TOO_LARGE', staffId: authorId, seq: null, localRef: null })
  expect(Buffer.byteLength(JSON.stringify(receipt?.resultJson), 'utf8')).toBeLessThanOrEqual(1_048_576)
  expect(terminal(await remove(input))).toEqual(terminal(reply))
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
  evidence('oversizeRollback', input, {
    deletedInside,
    inside,
    after: await orderSnapshot(input.manifest.refs.orderId),
    outcome: terminal(reply).outcome,
  })
})

test('receiptWriteFailureRollsBack after DELETE and totals; DB error remains RETRY', async () => {
  const input = await fixture()
  const suffix = randomUUID().replace(/-/g, '')
  const fn = `ga_fail_${suffix}`
  const trigger = `ga_fail_trigger_${suffix}`
  const before = await orderSnapshot(input.manifest.refs.orderId)
  let changedInside = false
  let inside: Awaited<ReturnType<typeof orderSnapshot>> | undefined
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$
      BEGIN IF NEW."idempotencyKey"='http:v1:${input.operation.id}' AND NEW.type='HTTP_OP_V1' AND NEW.status='ACKED'
      THEN RAISE EXCEPTION 'GateA receipt fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $b$`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "PosSyncIntent"
      FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
    const reply = await executeHttpOperation(input, async tx => {
      const result = await removeDomain(tx, input)
      inside = await orderSnapshot(input.manifest.refs.orderId, tx)
      changedInside =
        (await tx.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })) === 0 &&
        inside.total === 100 &&
        inside.version === 2
      return result
    })
    expect(changedInside).toBe(true)
    expect(reply).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
    expect(await stored(input)).toBeNull()
    expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
    expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
    evidence('receiptWriteRollback', input, {
      changedInside,
      inside,
      after: await orderSnapshot(input.manifest.refs.orderId),
      kind: reply.kind,
    })
  } finally {
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "PosSyncIntent"`)
    } finally {
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
    }
  }
})

test('unrelated real P2002 rolls back domain and does not become replay or rejection', async () => {
  const input = await fixture()
  const other = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  const otherBefore = await orderSnapshot(other.manifest.refs.orderId)
  const source = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: other.manifest.refs.orderServiceChargeId } })
  let fault: unknown
  let changedInside = false
  let inside: Awaited<ReturnType<typeof orderSnapshot>> | undefined
  const reply = await executeHttpOperation(input, async tx => {
    const result = await removeDomain(tx, input)
    inside = await orderSnapshot(input.manifest.refs.orderId, tx)
    changedInside =
      (await tx.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })) === 0 &&
      inside.total === 100 &&
      inside.version === 2
    try {
      await tx.orderServiceCharge.create({
        data: {
          orderId: source.orderId,
          serviceChargeId: source.serviceChargeId,
          name: source.name,
          type: source.type,
          value: source.value,
          amount: source.amount,
          taxable: source.taxable,
          isAutomatic: source.isAutomatic,
        },
      })
    } catch (error) {
      fault = error
      throw error
    }
    return result
  })
  expect(changedInside).toBe(true)
  expect(fault).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect(fault).toMatchObject({ code: 'P2002' })
  expect(isReceiptKeyCollision(fault)).toBe(false)
  expect(reply).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(input)).toBeNull()
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  expect(await orderSnapshot(other.manifest.refs.orderId)).toEqual(otherBefore)
  expect(await prisma.orderServiceCharge.count({ where: { orderId: source.orderId, serviceChargeId: source.serviceChargeId } })).toBe(1)
  evidence('unrelatedP2002Rollback', input, {
    changedInside,
    inside,
    after: await orderSnapshot(input.manifest.refs.orderId),
    faultCode: 'P2002',
    kind: reply.kind,
  })
})

async function heldTombstone(input: RemoveInput): Promise<OperationReply> {
  const envelope = serializeEnvelope({
    protocol: 'HTTP_OP_V1',
    action: input.manifest.action,
    request: {
      originalActorId: null,
      deviceId: input.operation.deviceId,
      refs: input.manifest.refs,
      payloadHash: fingerprint(input.manifest),
    },
    outcome: 'REJECTED',
    fencedByStaffId: managerId,
    rejection: { status: 409, code: 'OPERATION_NOT_APPLIED', message: 'La operación no fue aplicada' },
    affectedRefs: [
      { kind: 'Order', id: input.manifest.refs.orderId },
      { kind: 'OrderServiceCharge', id: input.manifest.refs.orderServiceChargeId },
    ],
  })
  await prisma.$transaction(
    async tx => {
      await tx.posSyncIntent.create({
        data: {
          venueId: input.venueId,
          staffId: managerId,
          deviceId: input.operation.deviceId,
          seq: null,
          localRef: null,
          idempotencyKey: `http:v1:${input.operation.id}`,
          type: 'HTTP_OP_V1',
          status: 'REJECTED',
          errorCode: 'OPERATION_NOT_APPLIED',
          resultJson: envelope as PrismaTypes.InputJsonValue,
        },
      })
    },
    { timeout: 25_000, maxWait: 5_000 },
  )
  return { kind: 'TERMINAL', envelope, appliedNow: false }
}

test('uniqueTimeoutIsRetry: held unique survives loser timeout', async () => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  let timedOut: OperationReply | undefined
  const results = await forceOrder(
    'uniqueTimeoutIsRetry',
    input,
    'REJECTED',
    () => heldTombstone(input),
    () => remove(input),
    async (_pid, loser) => {
      timedOut = await loser
      expect(timedOut).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
      // El ganador continúa sin commit mientras ya sabemos que el perdedor agotó su presupuesto real.
      expect(await stored(input)).toBeNull()
      expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
    },
  )
  expect(timedOut).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(results[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', envelope: { outcome: 'REJECTED' } } })
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { kind: 'RETRY' } })
  expect(await stored(input)).toMatchObject({ status: 'REJECTED', staffId: managerId })
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(1)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  expect(terminal(await remove(input))).toEqual(terminal(await resolveHttpOperation({ ...input, actorId: managerId })))
}, 45_000)

jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (code: string) => (_req: Request, _res: Response, next: NextFunction) => {
    mockFeatureGateCalls.push(code)
    if (mockDenyWrites) return next(new Error('Resolve invoked write feature gate'))
    next()
  },
  hasFeatureAccess: jest.fn(async () => ({ hasAccess: !mockDenyWrites, isTrialing: false, trialEndsAt: null })),
}))

const { processIntents, getRecentIntents } =
  require('@/services/mobile/sync.mobile.service') as typeof import('@/services/mobile/sync.mobile.service')
async function emptyTable() {
  return prisma.table.create({ data: { venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID() } })
}
test('HTTP seq cannot advance legacy fence; recent excludes HTTP while retaining receipts', async () => {
  const i = await fixture()
  await remove(i)
  const malformed = await prisma.posSyncIntent.create({
    data: {
      venueId,
      staffId: authorId,
      deviceId: i.operation.deviceId,
      seq: 99,
      localRef: null,
      type: 'HTTP_OP_V1',
      idempotencyKey: `malformed-${randomUUID()}`,
      status: 'ACKED',
      resultJson: { adversarial: true },
    },
  })
  const before = (await stored(i))!.resultJson,
    t = await emptyTable(),
    legacyId = randomUUID()
  const result = await processIntents({
    venueId,
    staffId: authorId,
    deviceId: i.operation.deviceId,
    intents: [{ id: legacyId, type: 'CLEAR_TABLE', seq: 1, payload: { tableId: t.id } }],
    authorizeIntent: () => true,
  })
  expect(result[0]).toMatchObject({ status: 'ACKED', result: { tableId: t.id } })
  const legacy = await prisma.posSyncIntent.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: legacyId } } })
  expect(legacy.seq).toBe(1)
  const durableId = (await stored(i))!.id
  const recent = await getRecentIntents(venueId, 200)
  expect(recent.some(x => x.id === legacy.id)).toBe(true)
  expect(recent.some(x => x.id === malformed.id || x.id === durableId)).toBe(false)
  expect((await stored(i))!.resultJson).toEqual(before)
  const mixed = await processIntents({
    venueId,
    staffId: authorId,
    deviceId: i.operation.deviceId,
    intents: [{ id: `http:v1:${i.operation.id}`, type: 'CLEAR_TABLE', payload: { tableId: t.id } }],
    authorizeIntent: () => true,
  })
  expect(mixed[0].errorCode).toBe('HTTP_OPERATION_RESERVED')
  expect((await stored(i))!.resultJson).toEqual(before)
})
test('HTTP localRef cannot resolve a legacy order alias or move its Order', async () => {
  const i = await fixture(),
    localRef = randomUUID(),
    target = await emptyTable()
  const forged = await prisma.posSyncIntent.create({
    data: {
      venueId,
      staffId: authorId,
      deviceId: randomUUID(),
      seq: null,
      localRef,
      type: 'HTTP_OP_V1',
      idempotencyKey: randomUUID(),
      status: 'ACKED',
      resultJson: { orderId: i.manifest.refs.orderId },
    },
  })
  const result = await processIntents({
    venueId,
    staffId: authorId,
    deviceId: randomUUID(),
    intents: [{ id: randomUUID(), type: 'MOVE_ORDER', seq: 1, payload: { localOrderId: localRef, targetTableId: target.id } }],
    authorizeIntent: () => true,
  })
  expect(result[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_PAYLOAD' })
  expect((await prisma.order.findUniqueOrThrow({ where: { id: i.manifest.refs.orderId } })).tableId).toBeNull()
  expect((await prisma.posSyncIntent.findUniqueOrThrow({ where: { id: forged.id } })).resultJson).toEqual({
    orderId: i.manifest.refs.orderId,
  })
})

// Step4: exercise the real legacy RETRY reservation DELETE without touching the durable HTTP receipt.
test('legacy RETRY releases only its own reservation and retains the same durable HTTP receipt', async () => {
  const i = await fixture()
  await remove(i)
  const durableBefore = await stored(i)
  const t = await emptyTable()
  const legacyId = randomUUID()
  const afterRetryId = randomUUID()
  const beforeOrder = await orderSnapshot(i.manifest.refs.orderId)
  const beforeTable = await prisma.table.findUniqueOrThrow({ where: { id: t.id } })
  const features = require('@/middlewares/checkFeatureAccess.middleware') as typeof import('@/middlewares/checkFeatureAccess.middleware')
  // Only the feature mock is faulted; Prisma, reducer, domain and receipt reads remain real.
  jest
    .spyOn(features, 'hasFeatureAccess')
    .mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Gate A transient feature lookup', { code: 'P1001', clientVersion: 'gate-a-test' }),
    )
  const result = await processIntents({
    venueId,
    staffId: authorId,
    deviceId: i.operation.deviceId,
    intents: [
      { id: legacyId, type: 'CLEAR_TABLE', seq: 1, payload: { tableId: t.id } },
      { id: afterRetryId, type: 'CLEAR_TABLE', seq: 2, payload: { tableId: t.id } },
    ],
    authorizeIntent: () => true,
  })
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ id: legacyId, status: 'RETRY', errorCode: 'P1001' })
  expect(await prisma.posSyncIntent.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: legacyId } } })).toBeNull()
  expect(await prisma.posSyncIntent.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: afterRetryId } } })).toBeNull()
  expect(await stored(i)).toEqual(durableBefore)
  expect(await orderSnapshot(i.manifest.refs.orderId)).toEqual(beforeOrder)
  expect(await prisma.table.findUniqueOrThrow({ where: { id: t.id } })).toEqual(beforeTable)
  evidence('legacyRetryRetainsHttp', i, { legacyId, afterRetryId, status: result[0].status, httpReceiptId: durableBefore!.id })
})

let mockDenyWrites = false
const mockFeatureGateCalls: string[] = []

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    Object.assign(req, {
      authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role: 'WAITER' },
    })
    next()
  },
}))

// Explicitly isolate passive Terminal/device observation; no transaction or permission mocks.
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction, _venueId: string) => next(),
}))

// ONE feature mock for Task3 + Task4. Replace/extend an existing factory, never duplicate it.

const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default
const { logAction } = require('@/services/dashboard/activity-log.service') as typeof import('@/services/dashboard/activity-log.service')
const featureAccess = require('@/middlewares/checkFeatureAccess.middleware') as typeof import('@/middlewares/checkFeatureAccess.middleware')
// integration-setup.ts already mocks logAction; reuse that single best-effort observation seam.

const httpApp = express()
httpApp.use(express.json())
httpApp.use('/api/v1/mobile', mobileRouter)
httpApp.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code })
})

beforeEach(() => {
  mockDenyWrites = false
  mockFeatureGateCalls.length = 0
  jest.mocked(logAction).mockClear()
  jest.mocked(featureAccess.hasFeatureAccess).mockClear()
})

const removePath = (input: RemoveInput) =>
  `/api/v1/mobile/venues/${input.venueId}/orders/${input.manifest.refs.orderId}/service-charges/${input.manifest.refs.orderServiceChargeId}`
const resolvePath = (input: OperationInput) => `/api/v1/mobile/venues/${input.venueId}/order-operations/${input.operation.id}/resolve`
const resolveBody = (input: OperationInput) => ({ version: 1, deviceId: input.operation.deviceId, manifest: input.manifest })

test('nativeDeleteBody: additive metadata, original snapshot replay and exactly one logAction', async () => {
  const input = await fixture()
  const applied = await request(httpApp)
    .delete(removePath(input))
    .set('x-test-actor', authorId)
    .send({ ignoredLegacyExtra: true, httpOperation: input.operation })
  expect(applied.status).toBe(200)
  expect(applied.body).toEqual({
    success: true,
    data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 },
    httpOperation: { ...input.operation, outcome: 'APPLIED' },
  })
  const receipt = await stored(input)
  expect(receipt).toMatchObject({ type: 'HTTP_OP_V1', status: 'ACKED', staffId: authorId, seq: null, localRef: null })
  expect(receipt?.resultJson).toMatchObject({
    request: { originalActorId: authorId, deviceId: input.operation.deviceId, refs: input.manifest.refs },
    originalResponse: { status: 200, body: { success: true, data: applied.body.data } },
    affectedRefs: [
      { kind: 'Order', id: input.manifest.refs.orderId },
      { kind: 'OrderServiceCharge', id: input.manifest.refs.orderServiceChargeId },
    ],
  })
  const envelope = receipt?.resultJson as unknown as HttpEnvelope
  if (envelope.outcome !== 'APPLIED') throw new Error('Se esperaba recibo aplicado')
  expect(envelope.originalResponse.body).toEqual({ success: true, data: applied.body.data })
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(0)
  await prisma.order.update({ where: { id: input.manifest.refs.orderId }, data: { total: 321, version: { increment: 1 } } })
  const later = await orderSnapshot(input.manifest.refs.orderId)
  const replay = await request(httpApp).delete(removePath(input)).set('x-test-actor', authorId).send({ httpOperation: input.operation })
  expect(replay.status).toBe(200)
  expect(replay.body).toEqual(applied.body)
  expect(await stored(input)).toEqual(receipt)
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(later)
  expect(logAction).toHaveBeenCalledTimes(1)
  expect(logAction).toHaveBeenCalledWith({
    action: 'ORDER_SERVICE_CHARGE_REMOVED',
    entity: 'Order',
    entityId: input.manifest.refs.orderId,
    staffId: authorId,
    venueId,
    data: { orderServiceChargeId: input.manifest.refs.orderServiceChargeId, name: expect.any(String) },
  })
  evidence('nativeDeleteBody', input, { status: applied.status, replayStatus: replay.status, receipt, later })
})

test('legacy DELETE without metadata preserves exact totals/body and existing audit', async () => {
  const input = await fixture()
  const response = await request(httpApp).delete(removePath(input)).set('x-test-actor', authorId).send({ oldIgnoredExtra: true })
  expect(response.status).toBe(200)
  expect(response.body).toEqual({
    success: true,
    data: { subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 2 },
  })
  expect(await stored(input)).toBeNull()
  expect(await prisma.orderServiceCharge.count({ where: { id: input.manifest.refs.orderServiceChargeId } })).toBe(0)
  expect(logAction).toHaveBeenCalledTimes(1)
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_SERVICE_CHARGE_REMOVED', staffId: authorId }))
})

const task8SupportedRoutes = [
  ['post', '/tables/missing-table/clear'],
  ['post', '/orders/:orderId/move'],
  ['post', '/orders/:orderId/merge'],
  ['delete', '/orders/:orderId'],
] as const

test.each(task8SupportedRoutes)(
  'task8SupportedRoutes %s %s: invalid metadata rejects before feature, permission/PIN or domain',
  async (method, suffix) => {
    const input = await fixture()
    const before = await orderSnapshot(input.manifest.refs.orderId)
    const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
    const path = `/api/v1/mobile/venues/${venueId}${suffix.replace(':orderId', input.manifest.refs.orderId)}`
    mockDenyWrites = true
    // VIEWER lacks write permissions; feature throws on invocation. Passing means guard precedes both.
    // Fake PIN is never consumed; permission-denial audit would also make this assertion fail.
    for (const metadata of [null, { version: 2, actorId: authorId }]) {
      const client = request(httpApp)
      const response = await client[method](path)
        .set('x-test-actor', readerId)
        .set('x-permission-override', 'gate-a-not-a-real-pin-token')
        .send({ httpOperation: metadata, reason: 'Gate A transport draft' })
      expect(response.status).toBe(400)
      expect(response.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(response.body.httpOperation).toBeUndefined()
      expect(mockFeatureGateCalls).toEqual([])
      expect(featureAccess.hasFeatureAccess).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
      expect(await stored(input)).toBeNull()
      expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
      expect(await prisma.orderServiceCharge.findUnique({ where: { id: charge.id } })).toEqual(charge)
    }
    evidence('task8SupportedRoutes', input, { method, path, variants: 2, snapshot: before })
  },
)

const invalidMetadata = [
  ['null', (_input: RemoveInput) => null],
  ['scalar', (_input: RemoveInput) => 'not-metadata'],
  ['array', (_input: RemoveInput) => []],
  ['version', (input: RemoveInput) => ({ ...input.operation, version: 2 })],
  ['id', (input: RemoveInput) => ({ ...input.operation, id: 'not-a-uuid' })],
  ['device', (input: RemoveInput) => ({ ...input.operation, deviceId: 'not-a-uuid' })],
  ['missing device', (input: RemoveInput) => ({ version: 1, id: input.operation.id })],
  ['forged actor extra', (input: RemoveInput) => ({ ...input.operation, staffId: authorId })],
] as const

test.each(invalidMetadata)('supported DELETE strict metadata %s fails before domain without terminal receipt', async (_name, build) => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
  mockDenyWrites = true
  const response = await request(httpApp)
    .delete(removePath(input))
    .set('x-test-actor', authorId)
    .send({ httpOperation: build(input) })
  expect(response.status).toBe(400)
  expect(response.body.code).toBe('HTTP_OPERATION_INVALID')
  expect(response.body.httpOperation).toBeUndefined()
  expect(mockFeatureGateCalls).toEqual([])
  expect(await stored(input)).toBeNull()
  expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
  expect(await prisma.orderServiceCharge.findUnique({ where: { id: charge.id } })).toEqual(charge)
  expect(logAction).not.toHaveBeenCalled()
})

test.each(invalidRefCases)('HTTP opt-in %s cannot accredit unverified refs', async kind => {
  const input = await invalidPostInput(kind)
  const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const chargeOrderBefore = await orderSnapshot(charge.orderId)
  const response = await request(httpApp).delete(removePath(input)).set('x-test-actor', authorId).send({ httpOperation: input.operation })
  expect(response.status).toBe(403)
  expect(response.body.httpOperation).toBeUndefined()
  expect(await stored(input)).toBeNull()
  expect(await prisma.orderServiceCharge.findUnique({ where: { id: charge.id } })).toEqual(charge)
  expect(await orderSnapshot(charge.orderId)).toEqual(chargeOrderBefore)
  expect(logAction).not.toHaveBeenCalled()
})

test('supported DELETE keeps current write permission denial without binding or terminal metadata', async () => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const access = await staffAccess(authorId)
  const reads = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read'] } })
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { permissionSetId: reads.id } })
    const response = await request(httpApp).delete(removePath(input)).set('x-test-actor', authorId).send({ httpOperation: input.operation })
    expect(response.status).toBe(403)
    expect(response.body.httpOperation).toBeUndefined()
    expect(await stored(input)).toBeNull()
    expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
    expect(await prisma.orderServiceCharge.findUnique({ where: { id: charge.id } })).toEqual(charge)
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_SERVICE_CHARGE_REMOVED' }))
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
  }
})

test('HTTP binding conflicts for actor, device and valid different refs never rewrite stored result', async () => {
  const input = await fixture()
  const other = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const otherBefore = await orderSnapshot(other.manifest.refs.orderId)
  for (const [changed, actor] of [
    [input, managerId],
    [{ ...input, operation: { ...input.operation, deviceId: randomUUID() } }, authorId],
    [{ ...input, manifest: { ...input.manifest, refs: other.manifest.refs } }, authorId],
  ] as const) {
    const response = await request(httpApp)
      .delete(removePath(changed))
      .set('x-test-actor', actor)
      .send({ httpOperation: changed.operation })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('HTTP_OPERATION_CONFLICT')
    expect(response.body.httpOperation).toBeUndefined()
    expect(await stored(input)).toEqual(receipt)
  }
  expect(await orderSnapshot(other.manifest.refs.orderId)).toEqual(otherBefore)
  expect(await prisma.orderServiceCharge.count({ where: { id: other.manifest.refs.orderServiceChargeId } })).toBe(1)
  expect(logAction).not.toHaveBeenCalled()
})

test('HTTP resolve original/delegate reads immutable original receipt while write feature invocation would fail', async () => {
  const input = await fixture()
  const committed = terminal(await remove(input))
  const receipt = await stored(input)
  await prisma.order.update({ where: { id: input.manifest.refs.orderId }, data: { total: 321, version: { increment: 1 } } })
  const later = await orderSnapshot(input.manifest.refs.orderId)
  mockDenyWrites = true
  for (const actor of [authorId, managerId]) {
    const response = await request(httpApp).post(resolvePath(input)).set('x-test-actor', actor).send(resolveBody(input))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      httpOperation: { ...input.operation, outcome: 'APPLIED' },
      receipt: committed,
      resolvedByStaffId: actor,
    })
    expect(await stored(input)).toEqual(receipt)
    expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(later)
  }
  expect(mockFeatureGateCalls).toEqual([])
  expect(featureAccess.hasFeatureAccess).not.toHaveBeenCalled()
  expect(logAction).not.toHaveBeenCalled()
})

test.each([
  ['reader only', ['orders:read']],
  ['delegate without read', ['tables:manage-all']],
] as const)('HTTP resolve %s cannot disclose another actor receipt using current PermissionSet', async (_name, permissions) => {
  const input = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const access = await staffAccess(readerId)
  const permissionSet = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: [...permissions] } })
  try {
    await prisma.staffVenue.update({
      where: { staffId_venueId: { staffId: readerId, venueId } },
      data: { permissionSetId: permissionSet.id },
    })
    const response = await request(httpApp).post(resolvePath(input)).set('x-test-actor', readerId).send(resolveBody(input))
    expect(response.status).toBe(403)
    expect(response.body.receipt).toBeUndefined()
    expect(response.body.httpOperation).toBeUndefined()
    expect(await stored(input)).toEqual(receipt)
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: access })
  }
})

test('HTTP resolve current VenueRolePermission denial blocks otherwise delegated MANAGER', async () => {
  const input = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const where = { venueId_role: { venueId, role: 'MANAGER' as const } }
  const prior = await prisma.venueRolePermission.findUnique({ where })
  try {
    await prisma.venueRolePermission.upsert({
      where,
      create: { venueId, role: 'MANAGER', permissions: [], deniedPermissions: ['tables:manage-all'], modifiedBy: managerId },
      update: { permissions: [], deniedPermissions: ['tables:manage-all'], modifiedBy: managerId },
    })
    const response = await request(httpApp).post(resolvePath(input)).set('x-test-actor', managerId).send(resolveBody(input))
    expect(response.status).toBe(403)
    expect(response.body.receipt).toBeUndefined()
    expect(await stored(input)).toEqual(receipt)
  } finally {
    if (prior) {
      await prisma.venueRolePermission.update({
        where,
        data: { permissions: prior.permissions, deniedPermissions: prior.deniedPermissions, modifiedBy: prior.modifiedBy },
      })
    } else {
      await prisma.venueRolePermission.delete({ where })
    }
  }
})

test('HTTP resolve missing row: author denial, current VIEWER delegate fence, late DELETE no domain write', async () => {
  const input = await fixture()
  const before = await orderSnapshot(input.manifest.refs.orderId)
  const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: input.manifest.refs.orderServiceChargeId } })
  const access = await staffAccess(readerId)
  const denied = await request(httpApp).post(resolvePath(input)).set('x-test-actor', authorId).send(resolveBody(input))
  expect(denied.status).toBe(403)
  expect(denied.body.receipt).toBeUndefined()
  expect(await stored(input)).toBeNull()
  const delegated = await prisma.permissionSet.create({
    data: { venueId, name: randomUUID(), permissions: ['orders:read', 'tables:manage-all'] },
  })
  const reads = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read'] } })
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: { permissionSetId: delegated.id } })
    mockDenyWrites = true
    const fence = await request(httpApp).post(resolvePath(input)).set('x-test-actor', readerId).send(resolveBody(input))
    expect(fence.status).toBe(200)
    expect(fence.body.receipt).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null }, fencedByStaffId: readerId })
    const receipt = await stored(input)
    expect(receipt).toMatchObject({ status: 'REJECTED', staffId: readerId, seq: null, localRef: null })
    expect(mockFeatureGateCalls).toEqual([])
    expect(featureAccess.hasFeatureAccess).not.toHaveBeenCalled()
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: { permissionSetId: reads.id } })
    const reread = await request(httpApp).post(resolvePath(input)).set('x-test-actor', readerId).send(resolveBody(input))
    expect(reread.status).toBe(200)
    expect(reread.body.receipt).toEqual(fence.body.receipt)
    mockDenyWrites = false
    const late = await request(httpApp).delete(removePath(input)).set('x-test-actor', authorId).send({ httpOperation: input.operation })
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('OPERATION_NOT_APPLIED')
    expect(late.body.httpOperation).toEqual({ ...input.operation, outcome: 'REJECTED' })
    expect(await stored(input)).toEqual(receipt)
    expect(await orderSnapshot(input.manifest.refs.orderId)).toEqual(before)
    expect(await prisma.orderServiceCharge.findUnique({ where: { id: charge.id } })).toEqual(charge)
    expect(logAction).not.toHaveBeenCalled()
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: access })
  }
})

test('HTTP resolve inactive author cannot disclose even its own receipt', async () => {
  const input = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const access = await staffAccess(authorId)
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { active: false } })
    const response = await request(httpApp).post(resolvePath(input)).set('x-test-actor', authorId).send(resolveBody(input))
    expect(response.status).toBe(403)
    expect(response.body.receipt).toBeUndefined()
    expect(await stored(input)).toEqual(receipt)
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
  }
})

test('HTTP resolve manifest/device binding mismatch and forged original actor never disclose or mutate receipt', async () => {
  const input = await fixture()
  const other = await fixture()
  await remove(input)
  const receipt = await stored(input)
  const otherBefore = await orderSnapshot(other.manifest.refs.orderId)
  for (const changed of [
    { ...input, operation: { ...input.operation, deviceId: randomUUID() } },
    { ...input, manifest: { ...input.manifest, refs: other.manifest.refs } },
  ]) {
    const response = await request(httpApp).post(resolvePath(changed)).set('x-test-actor', managerId).send(resolveBody(changed))
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('HTTP_OPERATION_CONFLICT')
    expect(response.body.receipt).toBeUndefined()
  }
  for (const body of [
    { ...resolveBody(input), originalActorId: authorId },
    { ...resolveBody(input), manifest: { ...input.manifest, payload: { forged: true } } },
    { ...resolveBody(input), manifest: { ...input.manifest, action: 'clearTable' } },
  ]) {
    const response = await request(httpApp).post(resolvePath(input)).set('x-test-actor', managerId).send(body)
    expect(response.status).toBe(400)
    expect(response.body.code).toBe('HTTP_OPERATION_INVALID')
    expect(response.body.receipt).toBeUndefined()
  }
  expect(await stored(input)).toEqual(receipt)
  expect(await orderSnapshot(other.manifest.refs.orderId)).toEqual(otherBefore)
  expect(logAction).not.toHaveBeenCalled()
})

test('HTTP resolve foreign refs and nonmember do not create a tombstone or disclose a receipt', async () => {
  const input = await fixture()
  const foreign = await foreignFixture()
  const malformed = { ...input, manifest: { ...input.manifest, refs: foreign.manifest.refs } }
  const foreignBefore = await orderSnapshot(foreign.manifest.refs.orderId)
  const deniedRefs = await request(httpApp).post(resolvePath(malformed)).set('x-test-actor', managerId).send(resolveBody(malformed))
  expect(deniedRefs.status).toBe(403)
  expect(deniedRefs.body.receipt).toBeUndefined()
  expect(await stored(input)).toBeNull()
  await remove(input)
  const receipt = await stored(input)
  const outsider = await prisma.staff.create({
    data: { email: `${randomUUID()}@example.test`, firstName: 'Outside', lastName: 'Gate A', active: true },
  })
  const deniedMember = await request(httpApp).post(resolvePath(input)).set('x-test-actor', outsider.id).send(resolveBody(input))
  expect(deniedMember.status).toBe(403)
  expect(deniedMember.body.receipt).toBeUndefined()
  expect(await stored(input)).toEqual(receipt)
  expect(await orderSnapshot(foreign.manifest.refs.orderId)).toEqual(foreignBefore)
  expect(await prisma.orderServiceCharge.count({ where: { id: foreign.manifest.refs.orderServiceChargeId } })).toBe(1)
})

// Task 2 verifies protocol refs/authorization only; the 14 domain routes remain unsupported.
async function clearInput(): Promise<OperationInput<'clearTable'>> {
  const table = await emptyTable()
  return {
    venueId,
    actorId: managerId,
    operation: { version: 1, id: randomUUID(), deviceId: randomUUID() },
    manifest: { action: 'clearTable', refs: { tableId: table.id }, payload: {} },
  }
}
test('clearTable requires effective tables:read and permits own fence read without delegation', async () => {
  const i = await clearInput()
  const original = await staffAccess(managerId)
  const set = await prisma.permissionSet.create({
    data: { venueId, name: randomUUID(), permissions: ['orders:read'] },
  })
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { permissionSetId: set.id } })
    await expect(resolveHttpOperation(i)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
    expect(await stored(i)).toBeNull()
    await prisma.permissionSet.update({ where: { id: set.id }, data: { permissions: ['orders:read', 'tables:manage-all'] } })
    const receipt = terminal(await resolveHttpOperation(i))
    expect(receipt).toMatchObject({
      action: 'clearTable',
      outcome: 'REJECTED',
      request: { originalActorId: null },
      fencedByStaffId: managerId,
      affectedRefs: [{ kind: 'Table', id: i.manifest.refs.tableId }],
    })
    await prisma.permissionSet.update({ where: { id: set.id }, data: { permissions: ['orders:read'] } })
    await expect(resolveHttpOperation(i)).rejects.toMatchObject({ statusCode: 403 })
    await prisma.permissionSet.update({ where: { id: set.id }, data: { permissions: ['orders:read', 'tables:read'] } })
    expect(terminal(await resolveHttpOperation(i))).toEqual(receipt)
    expect((await stored(i))!.resultJson).toEqual(receipt)
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: original })
  }
})
test('clearTable revokes effective tables:read while held unique and denies own APPLIED recovery', async () => {
  const i = await clearInput()
  const original = await staffAccess(managerId)
  const set = await prisma.permissionSet.create({
    data: { venueId, name: randomUUID(), permissions: ['orders:read', 'tables:read', 'tables:manage-all'] },
  })
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { permissionSetId: set.id } })
    const results = await forceOrder(
      'clearReadRevokedWhileUnique',
      i,
      'PROCESSING',
      () =>
        executeHttpOperation(i, async () => ({
          response: { status: 200, body: { success: true, message: 'Mesa liberada' } },
          affectedRefs: [{ kind: 'Table', id: i.manifest.refs.tableId }],
        })),
      () => resolveHttpOperation(i),
      async () => {
        await prisma.permissionSet.update({ where: { id: set.id }, data: { permissions: ['orders:read'] } })
      },
    )
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', appliedNow: true } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' } })
    expect(await stored(i)).toMatchObject({ status: 'ACKED', staffId: managerId })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: original })
  }
})
test('clearTable revoked effective table read and delegation roll back tentative own fence after unique wait', async () => {
  const i = await clearInput()
  const original = await staffAccess(managerId)
  const set = await prisma.permissionSet.create({
    data: { venueId, name: randomUUID(), permissions: ['orders:read', 'tables:read', 'tables:manage-all'] },
  })
  try {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { permissionSetId: set.id } })
    const results = await forceOrder(
      'clearOwnFenceReadRevoked',
      i,
      'REJECTED',
      () => resolveHttpOperation(i),
      () =>
        executeHttpOperation({ ...i, actorId: authorId }, async () => ({
          response: { status: 200, body: { success: true, message: 'Mesa liberada' } },
          affectedRefs: [{ kind: 'Table', id: i.manifest.refs.tableId }],
        })),
      async () => {
        await prisma.permissionSet.update({ where: { id: set.id }, data: { permissions: ['orders:read'] } })
      },
    )
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' } })
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { kind: 'TERMINAL', appliedNow: true } })
    expect(await stored(i)).toMatchObject({ status: 'ACKED', staffId: authorId })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: original })
  }
})
const missingManifests = (orderId: string) =>
  [
    { action: 'removeOrderDiscount', refs: { orderId, orderDiscountId: randomUUID() }, payload: {} },
    { action: 'compItem', refs: { orderId, itemId: randomUUID() }, payload: { reason: 'ok' } },
    { action: 'redeemLoyaltyPoints', refs: { orderId, customerId: randomUUID() }, payload: { points: 10 } },
    { action: 'updateOrderDetails', refs: { orderId }, payload: { customerId: randomUUID() } },
    { action: 'applyServiceCharge', refs: { orderId, serviceChargeId: randomUUID() }, payload: {} },
    { action: 'applyOrderDiscount', refs: { orderId, discountId: randomUUID() }, payload: {} },
    { action: 'moveOrder', refs: { orderId, targetTableId: randomUUID() }, payload: {} },
    { action: 'mergeOrders', refs: { orderId, sourceOrderId: randomUUID() }, payload: {} },
    { action: 'assignOrder', refs: { orderId, staffId: randomUUID() }, payload: {} },
    { action: 'splitOrder', refs: { orderId }, payload: { itemIds: [randomUUID(), randomUUID()] } },
  ] satisfies OperationInput['manifest'][]
test.each(Array.from({ length: 10 }, (_, index) => index))('missing new leaf %i returns RETRY without tentative rejection', async index => {
  const old = await fixture()
  const i: OperationInput = { ...old, actorId: managerId, manifest: missingManifests(old.manifest.refs.orderId)[index] }
  const before = await orderSnapshot(old.manifest.refs.orderId)
  expect(await resolveHttpOperation(i)).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(i)).toBeNull()
  expect(await orderSnapshot(old.manifest.refs.orderId)).toEqual(before)
})
test('missing root remains forbidden for order and clear manifests', async () => {
  const old = await fixture()
  const inputs: OperationInput[] = [
    { ...old, actorId: managerId, manifest: { action: 'cancelOrder', refs: { orderId: randomUUID() }, payload: { reason: null } } },
    { ...(await clearInput()), manifest: { action: 'clearTable', refs: { tableId: randomUUID() }, payload: {} } },
  ]
  for (const i of inputs) {
    await expect(resolveHttpOperation(i)).rejects.toMatchObject({ statusCode: 403 })
    expect(await stored(i)).toBeNull()
  }
})
test('foreign item, discount row, customer and catalog cannot create fences', async () => {
  const own = await fixture()
  const other = await foreignFixture()
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: other.manifest.refs.orderId } })
  const row = await prisma.orderDiscount.create({
    data: { orderId: other.manifest.refs.orderId, type: 'FIXED_AMOUNT', name: randomUUID(), value: 1, amount: 1 },
  })
  const customer = await prisma.customer.create({ data: { venueId: other.venueId, firstName: 'Foreign' } })
  const charge = await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: other.manifest.refs.orderServiceChargeId } })
  if (charge.serviceChargeId === null) throw new Error('La fixture exige un cargo de catálogo vigente')
  const catalog = await prisma.discount.create({ data: { venueId: other.venueId, type: 'FIXED_AMOUNT', name: randomUUID(), value: 1 } })
  const table = await prisma.table.create({ data: { venueId: other.venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID() } })
  const orderId = own.manifest.refs.orderId
  const manifests: OperationInput['manifest'][] = [
    { action: 'compItem', refs: { orderId, itemId: item.id }, payload: { reason: 'ok' } },
    { action: 'splitOrder', refs: { orderId }, payload: { itemIds: [item.id] } },
    { action: 'removeOrderDiscount', refs: { orderId, orderDiscountId: row.id }, payload: {} },
    { action: 'redeemLoyaltyPoints', refs: { orderId, customerId: customer.id }, payload: { points: 10 } },
    { action: 'updateOrderDetails', refs: { orderId }, payload: { customerId: customer.id } },
    { action: 'applyServiceCharge', refs: { orderId, serviceChargeId: charge.serviceChargeId }, payload: {} },
    { action: 'applyOrderDiscount', refs: { orderId, discountId: catalog.id }, payload: {} },
    { action: 'moveOrder', refs: { orderId, targetTableId: table.id }, payload: {} },
    { action: 'mergeOrders', refs: { orderId, sourceOrderId: other.manifest.refs.orderId }, payload: {} },
  ]
  for (const manifest of manifests) {
    const i: OperationInput = { ...own, actorId: managerId, operation: { ...own.operation, id: randomUUID() }, manifest }
    await expect(resolveHttpOperation(i)).rejects.toMatchObject({ statusCode: 403, code: 'HTTP_OPERATION_ACCESS_DENIED' })
    expect(await stored(i)).toBeNull()
  }
})
test('new compatible winner precedes deleted leaf and root lookups', async () => {
  const old = await fixture()
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: old.manifest.refs.orderId } })
  const i: OperationInput<'compItem'> = {
    ...old,
    manifest: { action: 'compItem', refs: { orderId: old.manifest.refs.orderId, itemId: item.id }, payload: { reason: 'ok' } },
  }
  const applied = terminal(
    await executeHttpOperation(i, async () => ({
      response: {
        status: 200,
        body: {
          success: true,
          data: { subtotal: 100, discountAmount: 100, serviceChargeAmount: 0, total: 0, version: 2, itemId: item.id, reason: 'ok' },
        },
      },
      affectedRefs: [
        { kind: 'Order', id: old.manifest.refs.orderId },
        { kind: 'OrderItem', id: item.id },
      ],
      effects: { discountBenefits: [] },
    })),
  )
  await prisma.order.delete({ where: { id: old.manifest.refs.orderId } })
  expect(terminal(await resolveHttpOperation(i))).toEqual(applied)
  const callback = jest.fn()
  expect(terminal(await executeHttpOperation(i, callback))).toEqual(applied)
  expect(callback).not.toHaveBeenCalled()
  expect((await stored(i))!.resultJson).toEqual(applied)
})
test('oversize rejection returns RETRY without truncated terminal metadata', async () => {
  const old = await fixture()
  const i: OperationInput<'splitOrder'> = {
    ...old,
    manifest: { action: 'splitOrder', refs: { orderId: old.manifest.refs.orderId }, payload: { itemIds: ['é'.repeat(524_288)] } },
  }
  expect(await resolveHttpOperation({ ...i, actorId: managerId })).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(i)).toBeNull()
  let observed = false
  const before = await orderSnapshot(old.manifest.refs.orderId)
  const reply = await executeHttpOperation(i, async tx => {
    await tx.order.update({ where: { id: old.manifest.refs.orderId }, data: { total: 42 } })
    observed = (await orderSnapshot(old.manifest.refs.orderId, tx)).total === 42
    throw new (require('@/services/mobile/http-operation.mobile.service').DomainRejected)({
      status: 400,
      code: 'TOO_BIG',
      message: 'x'.repeat(1_048_576),
    })
  })
  expect(observed).toBe(true)
  expect(reply).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
  expect(await stored(i)).toBeNull()
  expect(await orderSnapshot(old.manifest.refs.orderId)).toEqual(before)
})

// Task 3: real money fixtures, independent from the remove-service-charge cases.
async function plainOrder() {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      servedById: authorId,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      contratoDePrecio: 'IVA_INCLUIDO',
      items: {
        create: [
          { productName: 'A', quantity: 1, unitPrice: 40, total: 40, taxAmount: 0, seat: 1 },
          { productName: 'B', quantity: 1, unitPrice: 60, total: 60, taxAmount: 0, seat: 2 },
        ],
      },
    },
    include: { items: true },
  })
}
function operationInput<A extends HttpManifest['action']>(manifest: Extract<HttpManifest, { action: A }>): OperationInput<A> {
  return { venueId, actorId: authorId, operation: { version: 1, id: randomUUID(), deviceId: randomUUID() }, manifest }
}
async function callHttp<A extends HttpManifest['action']>(
  i: OperationInput<A>,
  method: 'post' | 'delete',
  suffix: string,
  body: Record<string, unknown> = {},
) {
  const client = request(httpApp)
  return client[method](`/api/v1/mobile/venues/${venueId}${suffix}`)
    .set('x-test-actor', i.actorId)
    .send({ ...body, httpOperation: i.operation })
}
async function exactReplay<A extends HttpManifest['action']>(
  i: OperationInput<A>,
  method: 'post' | 'delete',
  suffix: string,
  body: Record<string, unknown>,
  changeLater: () => Promise<unknown>,
) {
  const [a, b] = await Promise.all([callHttp(i, method, suffix, body), callHttp(i, method, suffix, body)])
  expect(a.status).toBe(200)
  expect(b.status).toBe(200)
  expect(b.body).toEqual(a.body)
  const before = (await stored(i))!.resultJson
  await changeLater()
  const resolved = await resolveHttpOperation(i)
  expect(terminal(resolved)).toEqual(before)
  expect((await stored(i))!.resultJson).toEqual(before)
  const envelope = terminal(resolved)
  if (envelope.outcome !== 'APPLIED') throw new Error('Expected original applied receipt')
  return { body: a.body, envelope }
}
test('Task3 apply charge: exact replay retains created row and original totals', async () => {
  const o = await plainOrder()
  const charge = await prisma.serviceCharge.create({
    data: { venueId, name: 'Gate A fixed', type: 'FIXED_AMOUNT', value: 10, taxable: false },
  })
  const i = operationInput({ action: 'applyServiceCharge', refs: { orderId: o.id, serviceChargeId: charge.id }, payload: {} })
  const result = await exactReplay(i, 'post', `/orders/${o.id}/service-charges`, { serviceChargeId: charge.id }, () =>
    prisma.order.update({ where: { id: o.id }, data: { total: 999, version: { increment: 1 } } }),
  )
  expect(result.body.data).toEqual({ subtotal: 100, discountAmount: 0, serviceChargeAmount: 10, total: 110, version: 2 })
  const rows = await prisma.orderServiceCharge.findMany({ where: { orderId: o.id }, take: 2 })
  expect(rows).toHaveLength(1)
  expect(result.envelope.affectedRefs).toContainEqual({ kind: 'OrderServiceCharge', id: rows[0].id })
})
test('Task3 comp one item preserves line and trims reason', async () => {
  const o = await plainOrder(),
    item = o.items.find(x => x.productName === 'A')!
  const i = operationInput({ action: 'compItem', refs: { orderId: o.id, itemId: item.id }, payload: { reason: 'Error' } })
  const r = await callHttp(i, 'post', `/orders/${o.id}/items/${item.id}/comp`, { reason: ' Error ' })
  expect(r.status).toBe(200)
  expect(r.body.data).toEqual({
    itemId: item.id,
    reason: 'Error',
    subtotal: 60,
    discountAmount: 0,
    serviceChargeAmount: 0,
    total: 60,
    version: 2,
  })
  expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ isCortesia: true, cortesiaReason: 'Error' })
  expect(Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).total)).toBe(0)
})
test('Task3 comp all replay does not comp a later added item', async () => {
  const o = await plainOrder()
  const i = operationInput({ action: 'compWholeOrder', refs: { orderId: o.id }, payload: { reason: 'Error' } })
  let laterId = ''
  const r = await exactReplay(i, 'post', `/orders/${o.id}/comp`, { reason: ' Error ' }, async () => {
    const later = await prisma.orderItem.create({
      data: { orderId: o.id, productName: 'Later', quantity: 1, unitPrice: 25, total: 25, taxAmount: 0 },
    })
    laterId = later.id
  })
  expect(r.body.data).toEqual({
    itemsComped: 2,
    compedAmount: 100,
    reason: 'Error',
    subtotal: 0,
    discountAmount: 0,
    serviceChargeAmount: 0,
    total: 0,
    version: 2,
  })
  expect(
    r.envelope.affectedRefs
      .filter(x => x.kind === 'OrderItem')
      .map(x => x.id)
      .sort(),
  ).toEqual(o.items.map(x => x.id).sort())
  expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: laterId } })).isCortesia).toBe(false)
})

async function assertReceiptRollback<A extends HttpManifest['action']>(
  i: OperationInput<A>,
  domain: (tx: PrismaTypes.TransactionClient) => Promise<DomainResult<A>>,
  snapshot: (tx: PrismaTypes.TransactionClient) => Promise<unknown>,
  assertInside: (tx: PrismaTypes.TransactionClient) => Promise<void>,
) {
  const suffix = randomUUID().replace(/-/g, ''),
    fn = `ga_receipt_fail_${suffix}`,
    trigger = `ga_receipt_fail_trigger_${suffix}`
  const before = await snapshot(prisma)
  let observed = false
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$
    BEGIN IF NEW."idempotencyKey"='http:v1:${i.operation.id}' AND NEW.type='HTTP_OP_V1' AND NEW.status='ACKED'
    THEN RAISE EXCEPTION 'Gate A receipt fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $b$`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "PosSyncIntent" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
    const result = await executeHttpOperation(i, async tx => {
      const value = await domain(tx)
      expect(await snapshot(tx)).not.toEqual(before)
      await assertInside(tx)
      observed = true
      return value
    })
    expect(observed).toBe(true)
    expect(result).toEqual({ kind: 'RETRY', code: 'OPERATION_OUTCOME_PENDING' })
    expect(await snapshot(prisma)).toEqual(before)
    expect(await stored(i)).toBeNull()
    evidence(`${i.manifest.action}-receiptRollback`, i, { observed, sqlstate: '23514', kind: result.kind, exactRestoration: true })
  } finally {
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "PosSyncIntent"`)
    } finally {
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
    }
  }
}

describe('Task7 native split identity and authorization', () => {
  test('Task7 split retains actual child ID and original DTO after child deletion', async () => {
    const o = await plainOrder(),
      item = o.items.find(x => x.seat === 2)!
    const i = operationInput({ action: 'splitOrder', refs: { orderId: o.id }, payload: { itemIds: [item.id] } })
    const a = await callHttp(i, 'post', `/orders/${o.id}/split`, { itemIds: [item.id] })
    expect(a.status).toBe(200)
    expect(a.body.data.source).toEqual({ id: o.id, orderNumber: o.orderNumber, total: 40, version: 2 })
    const child = await prisma.order.findUniqueOrThrow({ where: { id: a.body.data.created.id } })
    expect(a.body.data.created).toEqual({ id: child.id, orderNumber: child.orderNumber, total: 60, version: 2 })
    expect(child.shiftId).toBe(o.shiftId)
    expect(child.contratoDePrecio).toBe(o.contratoDePrecio)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).orderId).toBe(child.id)
    const saved = (await stored(i))!.resultJson
    expect(terminal(await resolveHttpOperation(i)).affectedRefs).toContainEqual({ kind: 'Order', id: child.id })
    await prisma.orderItem.deleteMany({ where: { orderId: child.id } })
    await prisma.order.delete({ where: { id: child.id } })
    expect(terminal(await resolveHttpOperation(i))).toEqual(saved)
    const b = await callHttp(i, 'post', `/orders/${o.id}/split`, { itemIds: [item.id] })
    expect(b.body).toEqual(a.body)
  })
  test.each(['duplicate', 'foreign', 'missing'] as const)('Task7 strict %s requested item rolls back the whole selection', async kind => {
    const o = await plainOrder(),
      other = await plainOrder(),
      own = o.items[0].id
    const ids = kind === 'duplicate' ? [own, own] : [own, kind === 'foreign' ? other.items[0].id : randomUUID()]
    const i = operationInput({ action: 'splitOrder', refs: { orderId: o.id }, payload: { itemIds: ids } })
    const before = await orderSnapshot(o.id),
      count = await prisma.order.count({ where: { venueId } })
    const r = await callHttp(i, 'post', `/orders/${o.id}/split`, { itemIds: ids })
    expect(r.status).toBe(kind === 'duplicate' ? 400 : kind === 'foreign' ? 403 : 503)
    expect(await orderSnapshot(o.id)).toEqual(before)
    expect(await prisma.order.count({ where: { venueId } })).toBe(count)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: own } })).orderId).toBe(o.id)
    if (kind === 'duplicate') expect(r.body.code).toBe('SPLIT_DUPLICATE_ITEM_IDS')
    else expect(await stored(i)).toBeNull()
  })
  test('Task7 by seat returns every real child and keeps lowest plus unseated without adding version', async () => {
    const o = await plainOrder()
    const third = await prisma.orderItem.create({
      data: { orderId: o.id, productName: 'C', quantity: 1, unitPrice: 30, total: 30, taxAmount: 0, seat: 3 },
    })
    const shared = await prisma.orderItem.create({
      data: { orderId: o.id, productName: 'Shared', quantity: 1, unitPrice: 20, total: 20, taxAmount: 0, seat: null },
    })
    const i = operationInput({ action: 'splitOrderBySeat', refs: { orderId: o.id }, payload: {} })
    const r = await callHttp(i, 'post', `/orders/${o.id}/split-by-seat`)
    expect(r.status).toBe(200)
    expect(r.body.data.source).toEqual({ id: o.id, orderNumber: o.orderNumber, total: 60, seat: 1 })
    expect(r.body.data.created.map((x: { seat: number; total: number }) => [x.seat, x.total])).toEqual([
      [2, 60],
      [3, 30],
    ])
    const refs = terminal(await resolveHttpOperation(i)).affectedRefs
    for (const child of r.body.data.created) {
      expect(Object.keys(child).sort()).toEqual(['id', 'orderNumber', 'seat', 'total'])
      expect(refs).toContainEqual({ kind: 'Order', id: child.id })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: child.id } })).covers).toBe(1)
    }
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: shared.id } })).orderId).toBe(o.id)
    expect(refs).toContainEqual({ kind: 'OrderItem', id: third.id })
  })
})

describe('Task7 complete native split receipts', () => {
  type SplitAction = 'splitOrder' | 'splitOrderBySeat'
  type SplitInput = OperationInput<SplitAction>
  const actions: SplitAction[] = ['splitOrder', 'splitOrderBySeat']
  async function splitFixture(action: SplitAction, promotion = false) {
    const order = await plainOrder()
    const table = await prisma.table.create({
      data: { venueId, number: randomUUID(), capacity: 4, qrCode: randomUUID(), status: 'OCCUPIED', currentOrderId: order.id },
    })
    const shift = await prisma.shift.create({
      data: {
        venueId,
        staffId: authorId,
        status: 'CLOSED',
        startTime: new Date(Date.now() - 7200000),
        endTime: new Date(Date.now() - 3600000),
      },
    })
    await prisma.order.update({
      where: { id: order.id },
      data: {
        tableId: table.id,
        shiftId: shift.id,
        covers: 4,
        customerName: 'Do not clone me',
        specialRequests: 'Original only',
        externalId: randomUUID(),
        posRawData: { historical: true },
      },
    })
    const selected = order.items.find(x => x.seat === 2)!
    await prisma.orderItem.update({
      where: { id: selected.id },
      data: {
        productSku: 'Historic SKU',
        categoryName: 'Historical category',
        quantity: 2,
        unitPrice: 35,
        discountAmount: 10,
        total: 60,
        notes: 'Historical note',
        course: 'Histórico',
        posRawData: { original: ['line', 7], nested: { option: 'unchanged' } },
        externalId: randomUUID(),
        sequence: 19,
        lastSyncAt: new Date(Date.now() - 7200000),
        sentToKitchenAt: new Date(Date.now() - 3600000),
        preparedAt: new Date(Date.now() - 1800000),
        externalLineId: 'Original external line',
        removedAt: new Date(Date.now() - 900000),
        weightQuantity: '2.500',
      },
    })
    await prisma.orderItemModifier.create({ data: { orderItemId: selected.id, name: 'Historical extra', quantity: 2, price: '3.25' } })
    let itemIds = [selected.id],
      promotionId: string | null = null
    if (promotion) {
      const category = await prisma.menuCategory.create({ data: { venueId, name: 'Task7', slug: randomUUID() } })
      const product = await prisma.product.create({
        data: { venueId, categoryId: category.id, name: 'Same product', sku: randomUUID(), price: 80, tags: [] },
      })
      const catalog = await prisma.promotion.create({
        data: {
          venueId,
          name: 'Task7 historical bundle',
          type: 'BUNDLE',
          pricingMode: 'FIXED_TOTAL',
          priceCents: 9900,
          daysOfWeek: [],
          status: 'PUBLISHED',
          groups: {
            create: [0, 1].map(displayOrder => ({
              name: `Task7 group ${displayOrder}`,
              displayOrder,
              options: { create: { productId: product.id, quantity: 1, chargedQuantity: 1 } },
            })),
          },
        },
        include: { groups: { orderBy: { displayOrder: 'asc' }, include: { options: true } } },
      })
      const { applyPromotionToOrder } = await import('@/services/promotions/promotion.service')
      const sold = await applyPromotionToOrder({
        venueId,
        orderId: order.id,
        promotionId: catalog.id,
        instanceId: randomUUID(),
        soldAt: new Date(),
        selections: catalog.groups.map(g => ({
          groupId: g.id,
          optionId: g.options[0].id,
        })),
      })
      promotionId = sold.orderPromotionId
      const lines = await prisma.orderItem.findMany({
        where: { orderId: order.id, orderPromotionId: promotionId },
        orderBy: { id: 'asc' },
        take: 3,
      })
      expect(lines).toHaveLength(2)
      itemIds = lines.map(x => x.id)
      for (let index = 0; index < lines.length; index++)
        await prisma.orderItem.update({ where: { id: lines[index].id }, data: { seat: index + 2 } })
      await prisma.orderItemModifier.create({
        data: { orderItemId: lines[0].id, name: 'Promo historic extra', quantity: 1, price: '1.25' },
      })
    } else if (action === 'splitOrderBySeat') {
      const extra = await prisma.orderItem.create({
        data: { orderId: order.id, productName: 'Third', quantity: 1, unitPrice: 30, total: 30, taxAmount: 0, seat: 3 },
      })
      itemIds.push(extra.id)
      await prisma.orderItem.create({
        data: { orderId: order.id, productName: 'Unseated', quantity: 1, unitPrice: 20, total: 20, taxAmount: 0 },
      })
    }
    const input =
      action === 'splitOrder'
        ? operationInput<SplitAction>({ action, refs: { orderId: order.id }, payload: { itemIds } })
        : operationInput<SplitAction>({ action, refs: { orderId: order.id }, payload: {} })
    return { order, table, shift, itemIds, promotionId, input }
  }
  type SplitFixture = Awaited<ReturnType<typeof splitFixture>>
  test.each(actions)('Task7 %s missing venue keeps the original public NotFound message', async action => {
    const service = await import('@/services/mobile/order.mobile.service')
    const invoke =
      action === 'splitOrder'
        ? service.splitOrderItems(`missing-${randomUUID()}`, randomUUID(), [randomUUID()])
        : service.splitOrderBySeat(`missing-${randomUUID()}`, randomUUID())
    await expect(invoke).rejects.toMatchObject({ statusCode: 404, message: 'Order not found' })
  })
  const path = (i: SplitInput) => `/orders/${i.manifest.refs.orderId}/${i.manifest.action === 'splitOrder' ? 'split' : 'split-by-seat'}`
  const body = (i: SplitInput) => (i.manifest.action === 'splitOrder' ? { itemIds: i.manifest.payload.itemIds } : {})
  async function snapshot(f: SplitFixture, tx: PrismaTypes.TransactionClient = prisma) {
    const orders = await tx.order.findMany({ where: { venueId, tableId: f.table.id }, orderBy: { id: 'asc' }, take: 1000 })
    const items = []
    let cursor: string | undefined
    for (;;) {
      const page = await tx.orderItem.findMany({
        where: { order: { venueId, tableId: f.table.id }, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 100,
      })
      items.push(...page)
      if (page.length < 100) break
      cursor = page[page.length - 1].id
    }
    expect(orders.length).toBe(await tx.order.count({ where: { venueId, tableId: f.table.id } }))
    expect(items.length).toBe(await tx.orderItem.count({ where: { order: { venueId, tableId: f.table.id } } }))
    return {
      orders,
      items,
      table: await tx.table.findUniqueOrThrow({ where: { id: f.table.id } }),
      promotions: await tx.orderPromotion.findMany({ where: { order: { venueId, tableId: f.table.id } }, orderBy: { id: 'asc' }, take: 3 }),
      discounts: await tx.orderDiscount.findMany({ where: { order: { venueId, tableId: f.table.id } }, orderBy: { id: 'asc' }, take: 3 }),
      charges: await tx.orderServiceCharge.findMany({
        where: { order: { venueId, tableId: f.table.id } },
        orderBy: { id: 'asc' },
        take: 3,
      }),
      modifiers: await tx.orderItemModifier.findMany({
        where: { orderItem: { order: { venueId, tableId: f.table.id } } },
        orderBy: { id: 'asc' },
        take: 3,
      }),
    }
  }
  async function domain(tx: PrismaTypes.TransactionClient, i: SplitInput): Promise<DomainResult<SplitAction>> {
    const service = await import('@/services/mobile/order.mobile.service')
    const m = i.manifest
    if (m.action === 'splitOrder') {
      const r = await service.splitOrderItemsInTransaction(tx, venueId, m.refs.orderId, m.payload.itemIds, i.actorId, true)
      return {
        response: {
          status: 200,
          body: {
            success: true,
            data: {
              source: { id: r.source.id, orderNumber: r.source.orderNumber, total: r.sourceTotals.total, version: r.sourceTotals.version },
              created: { id: r.newOrder.id, orderNumber: r.newOrder.orderNumber, total: r.newTotals.total, version: r.newTotals.version },
            },
          },
        },
        affectedRefs: [
          { kind: 'Order', id: r.source.id },
          { kind: 'Order', id: r.newOrder.id },
          ...r.movedItemIds.map(id => ({ kind: 'OrderItem' as const, id })),
          ...r.movedPromotionIds.map(id => ({ kind: 'OrderPromotion' as const, id })),
        ],
      }
    }
    const r = await service.splitOrderBySeatInTransaction(tx, venueId, m.refs.orderId, i.actorId)
    return {
      response: {
        status: 200,
        body: {
          success: true,
          data: {
            source: { id: r.source.id, orderNumber: r.source.orderNumber, total: r.sourceTotals.total, seat: r.seats[0] },
            created: r.results,
          },
        },
      },
      affectedRefs: [
        { kind: 'Order', id: r.source.id },
        ...r.results.map(x => ({ kind: 'Order' as const, id: x.id })),
        ...r.movedItemIds.map(id => ({ kind: 'OrderItem' as const, id })),
      ],
    }
  }
  async function automaticCharges(f: SplitFixture) {
    for (const [type, value, amount] of [
      ['PERCENTAGE', 10, 10],
      ['FIXED_AMOUNT', 7, 7],
    ] as const) {
      const catalog = await prisma.serviceCharge.create({ data: { venueId, name: `Task7 ${type}`, type, value, taxable: false } })
      await prisma.orderServiceCharge.create({
        data: {
          orderId: f.order.id,
          serviceChargeId: catalog.id,
          name: catalog.name,
          type,
          value,
          amount,
          isAutomatic: true,
          taxable: false,
        },
      })
    }
    const { recalculateOrderTotals } = await import('@/services/mobile/comp-item.mobile.service')
    await prisma.$transaction(tx => recalculateOrderTotals(f.order.id, 0, 0, tx))
  }
  test.each(actions)('Task7 %s legacy HTTP has the exact original body and no receipt', async action => {
    const f = await splitFixture(action)
    const inputBody = action === 'splitOrder' ? { itemIds: [f.itemIds[0], randomUUID()], ignored: true } : { ignored: true }
    const r = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}${path(f.input)}`)
      .set('x-test-actor', authorId)
      .send(inputBody)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['data', 'success'])
    expect(Object.keys(r.body.data).sort()).toEqual(['created', 'source'])
    if (action === 'splitOrder') {
      expect(r.body.data.source).toEqual({ id: f.order.id, orderNumber: f.order.orderNumber, total: 40, version: 2 })
      expect(Object.keys(r.body.data.created).sort()).toEqual(['id', 'orderNumber', 'total', 'version'])
    } else {
      expect(r.body.data.source).toEqual({ id: f.order.id, orderNumber: f.order.orderNumber, total: 60, seat: 1 })
      expect(r.body.data.created.map((x: { seat: number; total: number }) => [x.seat, x.total])).toEqual([
        [2, 60],
        [3, 30],
      ])
    }
    expect(await stored(f.input)).toBeNull()
  })
  test.each(actions)('Task7 %s invalid present metadata never falls through to legacy', async action => {
    const f = await splitFixture(action),
      before = await snapshot(f)
    for (const metadata of [null, { ...f.input.operation, version: 2 }]) {
      const r = await request(httpApp)
        .post(`/api/v1/mobile/venues/${venueId}${path(f.input)}`)
        .set('x-test-actor', authorId)
        .send({ ...body(f.input), httpOperation: metadata })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(r.body.httpOperation).toBeUndefined()
      expect(await snapshot(f)).toEqual(before)
      expect(await stored(f.input)).toBeNull()
    }
  })
  test.each(actions)('Task7 %s preserves all line JSON/modifiers and exact private child fields plus automatic charges', async action => {
    const f = await splitFixture(action)
    await automaticCharges(f)
    const before = await snapshot(f)
    const first = await callHttp(f.input, 'post', path(f.input), body(f.input))
    expect(first.status).toBe(200)
    const after = await snapshot(f),
      children = after.orders.filter(x => x.id !== f.order.id)
    expect(children).toHaveLength(action === 'splitOrder' ? 1 : 2)
    const refs = terminal(await resolveHttpOperation(f.input)).affectedRefs
    for (const child of children) {
      expect(child).toMatchObject({
        venueId,
        shiftId: f.shift.id,
        tableId: f.table.id,
        servedById: authorId,
        type: 'DINE_IN',
        contratoDePrecio: 'IVA_INCLUIDO',
        covers: action === 'splitOrder' ? 4 : 1,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        kitchenStatus: 'PENDING',
        version: 2,
        specialRequests: null,
        externalId: null,
        posRawData: null,
        customerId: null,
      })
      expect(child.customerName).toBe(action === 'splitOrder' ? null : `Asiento ${after.items.find(x => x.orderId === child.id)!.seat}`)
      expect(Number(child.serviceChargeAmount)).toBe(0)
      expect(refs).toContainEqual({ kind: 'Order', id: child.id })
    }
    for (const original of before.items) {
      const moved = after.items.find(x => x.id === original.id)!
      const { orderId: oldOrder, updatedAt: oldUpdated, ...oldFields } = original
      const { orderId: newOrder, updatedAt: newUpdated, ...newFields } = moved
      expect(newFields).toEqual(oldFields)
      expect(newOrder === oldOrder).toBe(!f.itemIds.includes(original.id))
      if (f.itemIds.includes(original.id)) expect(refs).toContainEqual({ kind: 'OrderItem', id: original.id })
    }
    expect(after.modifiers).toEqual(before.modifiers)
    expect(after.table).toEqual(before.table)
    expect(after.charges.map(x => [x.id, x.orderId, x.type, Number(x.amount)])).toEqual(
      before.charges.map(x => [x.id, f.order.id, x.type, x.type === 'PERCENTAGE' ? (action === 'splitOrder' ? 4 : 6) : 7]),
    )
    expect(refs.some(x => x.kind === 'OrderServiceCharge')).toBe(false)
    const saved = (await stored(f.input))!.resultJson
    await prisma.orderItem.deleteMany({ where: { orderId: { in: children.map(x => x.id) } } })
    await prisma.order.deleteMany({ where: { id: { in: children.map(x => x.id) } } })
    expect(terminal(await resolveHttpOperation(f.input))).toEqual(saved)
    expect((await callHttp(f.input, 'post', path(f.input), body(f.input))).body).toEqual(first.body)
  })
  test.each(actions)('Task7 %s promotion identity and historical selection courses follow only the legacy algorithm', async action => {
    const f = await splitFixture(action, true),
      before = await snapshot(f)
    const response = await callHttp(f.input, 'post', path(f.input), body(f.input))
    expect(response.status).toBe(200)
    const after = await snapshot(f),
      prior = before.promotions[0],
      current = after.promotions[0]
    const { orderId: oldId, ...oldFields } = prior,
      { orderId: newId, ...newFields } = current
    expect(newFields).toEqual(oldFields)
    expect(newId === oldId).toBe(action === 'splitOrderBySeat')
    for (const id of f.itemIds) {
      const old = before.items.find(x => x.id === id)!,
        now = after.items.find(x => x.id === id)!
      expect(now.orderPromotionId).toBe(prior.id)
      expect(now.course).toBe(old.course)
      expect(now.orderId).not.toBe(f.order.id)
      const { orderId: oldOrder, updatedAt: oldTime, ...oldLine } = old,
        { orderId: newOrder, updatedAt: newTime, ...newLine } = now
      expect(newLine).toEqual(oldLine)
    }
    expect(after.modifiers).toEqual(before.modifiers)
    const refs = terminal(await resolveHttpOperation(f.input)).affectedRefs
    expect(refs.filter(x => x.kind === 'OrderPromotion')).toEqual(action === 'splitOrder' ? [{ kind: 'OrderPromotion', id: prior.id }] : [])
  })
  test('Task7 selection rejects incomplete promotion before creating any child', async () => {
    const f = await splitFixture('splitOrder', true),
      before = await snapshot(f)
    const ids = [f.itemIds[0]],
      i = operationInput<SplitAction>({ action: 'splitOrder', refs: { orderId: f.order.id }, payload: { itemIds: ids } })
    const r = await callHttp(i, 'post', path(i), { itemIds: ids })
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/completa/)
    expect(await snapshot(f)).toEqual(before)
  })
  test.each(actions)(
    'Task7 %s ACK fault after every child write restores items/promotions/charges and removes all children',
    async action => {
      const f = await splitFixture(action, true)
      await automaticCharges(f)
      const observedIds: string[] = []
      await assertReceiptRollback(
        f.input,
        tx => domain(tx, f.input),
        tx => snapshot(f, tx),
        async tx => {
          const inside = await snapshot(f, tx),
            children = inside.orders.filter(x => x.id !== f.order.id)
          expect(children).toHaveLength(action === 'splitOrder' ? 1 : 2)
          observedIds.push(...children.map(x => x.id))
          for (const child of children) expect(inside.items.some(x => x.orderId === child.id)).toBe(true)
          for (const id of f.itemIds) expect(inside.items.find(x => x.id === id)!.orderId).not.toBe(f.order.id)
          expect(Number(inside.charges.find(x => x.type === 'PERCENTAGE')!.amount)).toBe(action === 'splitOrder' ? 10 : 4)
        },
      )
      expect(observedIds.length).toBe(action === 'splitOrder' ? 1 : 2)
      expect(await prisma.order.count({ where: { id: { in: observedIds } } })).toBe(0)
      evidence(`Task7-${action}-allChildrenRollback`, f.input, { children: observedIds, itemIds: f.itemIds, count: observedIds.length })
    },
  )
  test.each(actions)('Task7 %s same UUID applies once, actual POST wins unique then tombstone wins without writes', async action => {
    const f = await splitFixture(action)
    jest.mocked(logAction).mockClear()
    const [first, second] = await Promise.all([
      callHttp(f.input, 'post', path(f.input), body(f.input)),
      callHttp(f.input, 'post', path(f.input), body(f.input)),
    ])
    expect(first.status).toBe(200)
    expect(second.body).toEqual(first.body)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: action === 'splitOrder' ? 'ORDER_SPLIT' : 'ORDER_SPLIT_BY_SEAT',
        entityId: f.order.id,
        staffId: authorId,
      }),
    )
    expect((await snapshot(f)).orders).toHaveLength(action === 'splitOrder' ? 2 : 3)
    const post = await splitFixture(action)
    const postRace = await forceOrder(
      `Task7-${action}-postWins`,
      post.input,
      'PROCESSING',
      () => executeHttpOperation(post.input, tx => domain(tx, post.input)),
      () => resolveHttpOperation({ ...post.input, actorId: managerId }),
    )
    if (postRace[0].status !== 'fulfilled' || postRace[1].status !== 'fulfilled') throw new Error('Both racers must finish')
    expect(terminal(postRace[1].value)).toEqual(terminal(postRace[0].value))
    expect((await snapshot(post)).orders).toHaveLength(action === 'splitOrder' ? 2 : 3)
    const fenced = await splitFixture(action),
      before = await snapshot(fenced)
    const fenceRace = await forceOrder(
      `Task7-${action}-tombstoneWins`,
      fenced.input,
      'REJECTED',
      () => resolveHttpOperation({ ...fenced.input, actorId: managerId }),
      () => executeHttpOperation(fenced.input, tx => domain(tx, fenced.input)),
    )
    if (fenceRace[0].status !== 'fulfilled' || fenceRace[1].status !== 'fulfilled') throw new Error('Both racers must finish')
    expect(terminal(fenceRace[0].value).outcome).toBe('REJECTED')
    expect(terminal(fenceRace[1].value)).toEqual(terminal(fenceRace[0].value))
    expect(await snapshot(fenced)).toEqual(before)
    expect((await callHttp(fenced.input, 'post', path(fenced.input), body(fenced.input))).body.httpOperation.outcome).toBe('REJECTED')
    expect(await snapshot(fenced)).toEqual(before)
  })
  test.each(
    actions.flatMap(action =>
      ['PAID', 'PARTIAL', 'IMPORTED', 'DISCOUNT', 'MANUAL_CHARGE', 'COMPLETED', 'CANCELLED', 'DELETED'].map(guard => ({ action, guard })),
    ),
  )('Task7 $action preserves $guard guard and no child', async ({ action, guard }) => {
    const f = await splitFixture(action)
    if (guard === 'PAID' || guard === 'PARTIAL') await prisma.order.update({ where: { id: f.order.id }, data: { paymentStatus: guard } })
    else if (guard === 'IMPORTED') await prisma.order.update({ where: { id: f.order.id }, data: { originSystem: 'POS_SOFTRESTAURANT' } })
    else if (guard === 'DISCOUNT')
      await prisma.orderDiscount.create({
        data: { orderId: f.order.id, name: 'Original discount', type: 'FIXED_AMOUNT', value: 10, amount: 10 },
      })
    else if (guard === 'MANUAL_CHARGE')
      await prisma.orderServiceCharge.create({
        data: { orderId: f.order.id, name: 'Manual', type: 'FIXED_AMOUNT', value: 10, amount: 10, taxable: false, isAutomatic: false },
      })
    else if (guard === 'COMPLETED' || guard === 'CANCELLED' || guard === 'DELETED')
      await prisma.order.update({ where: { id: f.order.id }, data: { status: guard } })
    const before = await snapshot(f),
      r = await callHttp(f.input, 'post', path(f.input), body(f.input))
    expect(r.status).toBe(400)
    expect(r.body.httpOperation?.outcome).not.toBe('APPLIED')
    expect(await snapshot(f)).toEqual(before)
  })
  test.each([101, 501])('Task7 selection retains every one of %i ordinary requested items across ref pages', async count => {
    const f = await splitFixture('splitOrder'),
      added = Array.from({ length: count - 1 }, (_, index) => ({
        id: randomUUID(),
        orderId: f.order.id,
        productName: `Task7 ${index}`,
        quantity: 1,
        unitPrice: 1,
        total: 1,
        taxAmount: 0,
        seat: 2,
      }))
    await prisma.orderItem.createMany({ data: added })
    const ids = [...f.itemIds, ...added.map(x => x.id)],
      i = operationInput<SplitAction>({ action: 'splitOrder', refs: { orderId: f.order.id }, payload: { itemIds: ids } })
    const r = await callHttp(i, 'post', path(i), { itemIds: ids })
    expect(r.status).toBe(200)
    const refs = terminal(await resolveHttpOperation(i))
      .affectedRefs.filter(x => x.kind === 'OrderItem')
      .map(x => x.id)
    expect(refs.sort()).toEqual([...ids].sort())
    expect(await prisma.orderItem.count({ where: { orderId: r.body.data.created.id } })).toBe(count)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: ids[ids.length - 1] } })).orderId).toBe(r.body.data.created.id)
    evidence('Task7-selection-volume', i, {
      requested: count,
      sourceBeforeCount: count + 1,
      moved: refs.length,
      lastId: ids[ids.length - 1],
    })
  })
  test('Task7 bySeat returns all 101 children and every ordinary original item without truncation', async () => {
    const f = await splitFixture('splitOrderBySeat')
    const added = Array.from({ length: 99 }, (_, index) => ({
      id: randomUUID(),
      orderId: f.order.id,
      productName: `Seat ${index + 4}`,
      quantity: 1,
      unitPrice: 1,
      total: 1,
      taxAmount: 0,
      seat: index + 4,
    }))
    await prisma.orderItem.createMany({ data: added })
    const r = await callHttp(f.input, 'post', path(f.input))
    expect(r.status).toBe(200)
    expect(r.body.data.created).toHaveLength(101)
    expect(r.body.data.created.map((x: { seat: number }) => x.seat)).toEqual(Array.from({ length: 101 }, (_, index) => index + 2))
    const s = await snapshot(f),
      children = s.orders.filter(x => x.id !== f.order.id),
      refs = terminal(await resolveHttpOperation(f.input)).affectedRefs
    expect(children.map(x => x.id).sort()).toEqual(r.body.data.created.map((x: { id: string }) => x.id).sort())
    expect(
      refs
        .filter(x => x.kind === 'Order')
        .map(x => x.id)
        .sort(),
    ).toEqual(s.orders.map(x => x.id).sort())
    expect(
      refs
        .filter(x => x.kind === 'OrderItem')
        .map(x => x.id)
        .sort(),
    ).toEqual([...f.itemIds, ...added.map(x => x.id)].sort())
    evidence('Task7-bySeat-volume', f.input, {
      childCount: 101,
      orderRefs: 102,
      movedItemRefs: 101,
      lastChildId: r.body.data.created[100].id,
    })
  })
  test.each(actions)('Task7 %s real controller response over 1MiB rolls back all children and fences only rejection', async action => {
    const f = await splitFixture(action, true)
    await automaticCharges(f)
    await prisma.order.update({ where: { id: f.order.id }, data: { orderNumber: 'é'.repeat(524289) } })
    const before = await snapshot(f),
      service = await import('@/services/mobile/http-operation.mobile.service'),
      original = service.executeHttpOperation
    let invocations = 0,
      observed: Awaited<ReturnType<typeof snapshot>> | undefined,
      bytes = 0
    const spy = jest.spyOn(service, 'executeHttpOperation').mockImplementation(async (input, mutate) =>
      original(input, async tx => {
        const result = await mutate(tx)
        invocations++
        bytes = Buffer.byteLength(JSON.stringify(result.response), 'utf8')
        observed = await snapshot(f, tx)
        return result
      }),
    )
    let r
    try {
      r = await callHttp(f.input, 'post', path(f.input), body(f.input))
    } finally {
      spy.mockRestore()
    }
    expect(invocations).toBe(1)
    expect(bytes).toBeGreaterThan(1048576)
    if (!observed) throw new Error('Actual controller callback was not observed')
    const children = observed.orders.filter(x => x.id !== f.order.id)
    expect(children).toHaveLength(action === 'splitOrder' ? 1 : 2)
    for (const child of children) expect(observed.items.some(x => x.orderId === child.id)).toBe(true)
    for (const id of f.itemIds) expect(observed.items.find(x => x.id === id)!.orderId).not.toBe(f.order.id)
    expect(r.status).toBe(413)
    expect(r.body.code).toBe('RECEIPT_TOO_LARGE')
    expect(await snapshot(f)).toEqual(before)
    expect(await prisma.order.count({ where: { id: { in: children.map(x => x.id) } } })).toBe(0)
    expect(await stored(f.input)).toMatchObject({ status: 'REJECTED', errorCode: 'RECEIPT_TOO_LARGE' })
    const saved = (await stored(f.input))!.resultJson
    expect(Buffer.byteLength(JSON.stringify(saved), 'utf8')).toBeLessThanOrEqual(1048576)
    expect((await callHttp(f.input, 'post', path(f.input), body(f.input))).body).toEqual(r.body)
    expect(await snapshot(f)).toEqual(before)
    evidence(`Task7-${action}-realResponseOverflow`, f.input, {
      responseBytes: bytes,
      responseIsEnvelopeLowerBound: true,
      childIds: children.map(x => x.id),
      callbackInvocations: invocations,
      exactRollback: true,
    })
  })
})

// Native receipt coverage, activated after observing the three genuine unsupported HTTP RED cases.
describe('Task3 receipt coverage', () => {
  type MoneyAction = 'applyServiceCharge' | 'compItem' | 'compWholeOrder'
  type MoneyInput = OperationInput<MoneyAction>
  const moneyActions: MoneyAction[] = ['applyServiceCharge', 'compItem', 'compWholeOrder']
  const compActions = ['compItem', 'compWholeOrder'] as const
  async function moneyFixture(action: MoneyAction) {
    const order = await plainOrder()
    if (action === 'applyServiceCharge') {
      const charge = await prisma.serviceCharge.create({
        data: { venueId, name: `Task3-${randomUUID()}`, type: 'FIXED_AMOUNT', value: 10, taxable: false },
      })
      return { order, input: operationInput<MoneyAction>({ action, refs: { orderId: order.id, serviceChargeId: charge.id }, payload: {} }) }
    }
    return { order, input: compInput(action, order.id, order.items.find(x => x.productName === 'A')!.id) }
  }
  function compInput(action: (typeof compActions)[number], orderId: string, itemId: string): MoneyInput {
    return action === 'compItem'
      ? operationInput<MoneyAction>({ action, refs: { orderId, itemId }, payload: { reason: 'Error' } })
      : operationInput<MoneyAction>({ action, refs: { orderId }, payload: { reason: 'Error' } })
  }
  function moneyPath(i: MoneyInput) {
    const m = i.manifest
    return m.action === 'applyServiceCharge'
      ? `/orders/${m.refs.orderId}/service-charges`
      : m.action === 'compItem'
        ? `/orders/${m.refs.orderId}/items/${m.refs.itemId}/comp`
        : `/orders/${m.refs.orderId}/comp`
  }
  function moneyBody(i: MoneyInput): Record<string, unknown> {
    return i.manifest.action === 'applyServiceCharge'
      ? { serviceChargeId: i.manifest.refs.serviceChargeId }
      : { reason: i.manifest.payload.reason }
  }
  async function moneySnapshot(i: MoneyInput, tx: PrismaTypes.TransactionClient = prisma) {
    const orderId = i.manifest.refs.orderId
    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: orderId } }),
      items: await tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
      discounts: await tx.orderDiscount.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
      charges: await tx.orderServiceCharge.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
    }
  }
  async function compRefundFixture() {
    const { redeemPointsToOrder } = await import('@/services/mobile/loyalty.mobile.service')
    const { comoJson, nuevoRepartoDirigido } = await import('@/services/shared/repartoDescuento')
    await prisma.loyaltyConfig.upsert({
      where: { venueId },
      create: { venueId, active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
      update: { active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
    })
    const customer = await prisma.customer.create({ data: { venueId, firstName: 'Comp refund', loyaltyPoints: 10000 } })
    const order = await plainOrder(),
      item = order.items.find(x => x.productName === 'A')!
    await redeemPointsToOrder(venueId, order.id, customer.id, 1000, authorId)
    const discount = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: order.id } })
    await prisma.orderDiscount.update({
      where: { id: discount.id },
      data: { appliedToItemIds: [item.id], reparto: comoJson(nuevoRepartoDirigido(10, { [item.id]: 40 }, { espejo: false })) },
    })
    return { customer, order, item, discount }
  }
  async function compStampFixture() {
    const { redeemStampReward } = await import('@/services/wallet/redeemStampReward.service')
    const customer = await prisma.customer.create({ data: { venueId, firstName: 'Comp stamp' } })
    const order = await plainOrder(),
      item = order.items.find(x => x.productName === 'B')!
    await prisma.order.update({ where: { id: order.id }, data: { customerId: customer.id } })
    const card = await prisma.stampCard.create({
      data: { customerId: customer.id, venueId, cycle: 1, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
    })
    const reward = await prisma.stampReward.create({
      data: { stampCardId: card.id, customerId: customer.id, venueId, rewardType: 'FREE_PRODUCT', rewardLabel: 'Café gratis' },
    })
    await redeemStampReward(venueId, order.id, reward.id, { staffId: authorId })
    const discount = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: order.id } })
    expect(Number(discount.amount)).toBe(60)
    expect(discount.reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { [item.id]: 6000 } })
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: reward.id } })).toMatchObject({
      status: 'REDEEMED',
      orderDiscountId: discount.id,
    })
    return { customer, order, item, discount, card, reward }
  }
  async function moneyDomain(tx: PrismaTypes.TransactionClient, i: MoneyInput): Promise<DomainResult<MoneyAction>> {
    const m = i.manifest
    if (m.action === 'applyServiceCharge') {
      const { applyServiceChargeInTransaction } = await import('@/services/mobile/service-charge.mobile.service')
      const r = await applyServiceChargeInTransaction(tx, venueId, m.refs.orderId, m.refs.serviceChargeId, authorId)
      return {
        response: { status: 200, body: { success: true, data: r.totals } },
        affectedRefs: [
          { kind: 'Order', id: m.refs.orderId },
          { kind: 'OrderServiceCharge', id: r.row.id },
        ],
      }
    }
    const { compOrderItemInTransaction, compWholeOrderInTransaction } = await import('@/services/mobile/comp-item.mobile.service')
    const r =
      m.action === 'compItem'
        ? await compOrderItemInTransaction(tx, {
            venueId,
            orderId: m.refs.orderId,
            itemId: m.refs.itemId,
            reason: m.payload.reason,
            staffId: authorId,
            captureBenefits: true,
          })
        : await compWholeOrderInTransaction(tx, {
            venueId,
            orderId: m.refs.orderId,
            reason: m.payload.reason,
            staffId: authorId,
            captureBenefits: true,
          })
    if (!r.recorte.benefits) throw new Error('Missing in-transaction benefit capture')
    const affectedRefs: HttpEnvelope['affectedRefs'] = [
      { kind: 'Order', id: m.refs.orderId },
      ...('item' in r ? [{ kind: 'OrderItem' as const, id: r.item.id }] : r.items.map(x => ({ kind: 'OrderItem' as const, id: x.id }))),
      ...r.recorte.retiradas.map(d => ({ kind: 'OrderDiscount' as const, id: d.id })),
      ...r.recorte.benefits.flatMap(b => [
        ...(b.loyaltyRefund
          ? [
              { kind: 'Customer' as const, id: b.loyaltyRefund.customerId },
              { kind: 'LoyaltyTransaction' as const, id: b.loyaltyRefund.transactionId },
            ]
          : []),
        ...(b.stampRefund
          ? [
              { kind: 'Customer' as const, id: b.stampRefund.customerId },
              { kind: 'StampReward' as const, id: b.stampRefund.rewardId },
            ]
          : []),
      ]),
    ]
    return 'item' in r
      ? {
          response: { status: 200, body: { success: true, data: { itemId: r.item.id, reason: m.payload.reason, ...r.totals } } },
          effects: { discountBenefits: r.recorte.benefits },
          affectedRefs,
        }
      : {
          response: {
            status: 200,
            body: {
              success: true,
              data: { itemsComped: r.items.length, compedAmount: r.compedAmount, reason: m.payload.reason, ...r.totals },
            },
          },
          effects: { discountBenefits: r.recorte.benefits },
          affectedRefs,
        }
  }

  test.each(moneyActions)('Task3 %s exact native success/replay, immutable snapshot and one audit', async action => {
    const { order, input } = await moneyFixture(action)
    const replay = await exactReplay(input, 'post', moneyPath(input), { ...moneyBody(input), ignoredLegacyExtra: true }, () =>
      prisma.order.update({ where: { id: order.id }, data: { total: 777, version: { increment: 1 } } }),
    )
    const totals = {
      subtotal: action === 'applyServiceCharge' ? 100 : action === 'compItem' ? 60 : 0,
      discountAmount: 0,
      serviceChargeAmount: action === 'applyServiceCharge' ? 10 : 0,
      total: action === 'applyServiceCharge' ? 110 : action === 'compItem' ? 60 : 0,
      version: 2,
    }
    const expected =
      action === 'applyServiceCharge'
        ? totals
        : action === 'compItem'
          ? { itemId: order.items.find(x => x.productName === 'A')!.id, reason: 'Error', ...totals }
          : { itemsComped: 2, compedAmount: 100, reason: 'Error', ...totals }
    expect(replay.body).toEqual({ success: true, data: expected, httpOperation: { ...input.operation, outcome: 'APPLIED' } })
    expect(replay.envelope.originalResponse).toEqual({ status: 200, body: { success: true, data: expected } })
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action:
          action === 'applyServiceCharge' ? 'ORDER_SERVICE_CHARGE_APPLIED' : action === 'compItem' ? 'ORDER_ITEM_COMPED' : 'ORDER_COMPED',
        staffId: authorId,
        venueId,
      }),
    )
    expect(await stored(input)).toMatchObject({ status: 'ACKED', type: 'HTTP_OP_V1', seq: null, localRef: null })
    const refs: HttpEnvelope['affectedRefs'] = [{ kind: 'Order', id: order.id }]
    if (action === 'applyServiceCharge') {
      const rows = await prisma.orderServiceCharge.findMany({ where: { orderId: order.id }, take: 2 })
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].amount)).toBe(10)
      const membership = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId: authorId, venueId } } })
      expect(rows[0].appliedById).toBe(membership.id)
      expect(logAction).toHaveBeenCalledWith({
        action: 'ORDER_SERVICE_CHARGE_APPLIED',
        entity: 'Order',
        entityId: order.id,
        staffId: authorId,
        venueId,
        data: { serviceChargeId: rows[0].serviceChargeId, name: rows[0].name, amount: 10 },
      })

      refs.push({ kind: 'OrderServiceCharge', id: rows[0].id })
    } else {
      const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' }, take: 2 })
      expect(items).toHaveLength(2)
      const comped = items.filter(x => x.isCortesia)
      expect(logAction).toHaveBeenCalledWith(
        action === 'compItem'
          ? {
              action: 'ORDER_ITEM_COMPED',
              entity: 'OrderItem',
              entityId: order.items.find(x => x.productName === 'A')!.id,
              staffId: authorId,
              venueId,
              data: { orderId: order.id, reason: 'Error', productName: 'A', amount: 40 },
            }
          : {
              action: 'ORDER_COMPED',
              entity: 'Order',
              entityId: order.id,
              staffId: authorId,
              venueId,
              data: { reason: 'Error', items: 2, amount: 100, orderNumber: order.orderNumber },
            },
      )

      expect(comped).toHaveLength(action === 'compItem' ? 1 : 2)
      for (const item of comped) {
        expect(item.cortesiaReason).toBe('Error')
        expect(Number(item.total)).toBe(0)
        expect(Number(item.discountAmount)).toBe(item.productName === 'A' ? 40 : 60)
        expect(item.appliedDiscountId).toBeNull()
        refs.push({ kind: 'OrderItem', id: item.id })
      }
    }
    expect(replay.envelope.affectedRefs.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      refs.sort((a, b) => a.id.localeCompare(b.id)),
    )

    if (action !== 'applyServiceCharge') expect(replay.envelope).toMatchObject({ effects: { discountBenefits: [] } })
    evidence(`Task3-${action}-nativeReplay`, input, { data: expected, affectedRefs: replay.envelope.affectedRefs, auditCalls: 1 })
  })
  test.each(moneyActions)('Task3 %s legacy without token preserves DTO and no receipt', async action => {
    const { order, input } = await moneyFixture(action)
    const response = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}${moneyPath(input)}`)
      .set('x-test-actor', authorId)
      .send(moneyBody(input))
    expect(response.status).toBe(200)
    const totals = {
      subtotal: action === 'applyServiceCharge' ? 100 : action === 'compItem' ? 60 : 0,
      discountAmount: 0,
      serviceChargeAmount: action === 'applyServiceCharge' ? 10 : 0,
      total: action === 'applyServiceCharge' ? 110 : action === 'compItem' ? 60 : 0,
      version: 2,
    }
    const expected =
      action === 'applyServiceCharge'
        ? totals
        : action === 'compItem'
          ? { itemId: order.items.find(x => x.productName === 'A')!.id, reason: 'Error', ...totals }
          : { itemsComped: 2, compedAmount: 100, reason: 'Error', ...totals }
    expect(response.body).toEqual({ success: true, data: expected })
    expect(await stored(input)).toBeNull()
    expect(logAction).toHaveBeenCalledTimes(1)
  })
  test.each(moneyActions)('Task3 %s permission denial precedes binding/economic mutation', async action => {
    const { input } = await moneyFixture(action),
      before = await moneySnapshot(input),
      access = await staffAccess(authorId)
    const reads = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read'] } })
    try {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { permissionSetId: reads.id } })
      const r = await callHttp(input, 'post', moneyPath(input), moneyBody(input))
      expect(r.status).toBe(403)
      expect(r.body.httpOperation).toBeUndefined()
      expect(await stored(input)).toBeNull()
      expect(await moneySnapshot(input)).toEqual(before)
    } finally {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
    }
  })
  test.each(moneyActions)('Task3 %s invalid metadata and consumed payload never falls to legacy', async action => {
    const { input } = await moneyFixture(action),
      before = await moneySnapshot(input)
    for (const [, build] of invalidMetadata) {
      const removeInput = await fixture()
      const r = await request(httpApp)
        .post(`/api/v1/mobile/venues/${venueId}${moneyPath(input)}`)
        .set('x-test-actor', authorId)
        .send({ ...moneyBody(input), httpOperation: build(removeInput) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(r.body.httpOperation).toBeUndefined()
    }
    const r = await callHttp(input, 'post', moneyPath(input), action === 'applyServiceCharge' ? { serviceChargeId: 27 } : { reason: 27 })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
    expect(await stored(input)).toBeNull()
    expect(await moneySnapshot(input)).toEqual(before)
  })
  test.each(moneyActions)('Task3 %s actor/device/ref/payload binding conflicts preserve receipts', async action => {
    const { input } = await moneyFixture(action),
      other = await moneyFixture(action)
    expect((await callHttp(input, 'post', moneyPath(input), moneyBody(input))).status).toBe(200)
    const receipt = await stored(input),
      before = await moneySnapshot(input),
      otherBefore = await moneySnapshot(other.input)
    const variants = [
      { ...input, actorId: managerId },
      { ...input, operation: { ...input.operation, deviceId: randomUUID() } },
      { ...other.input, operation: input.operation },
    ]
    if (action !== 'applyServiceCharge')
      variants.push({
        ...input,
        manifest:
          input.manifest.action === 'compItem'
            ? { ...input.manifest, payload: { reason: 'Other' } }
            : input.manifest.action === 'compWholeOrder'
              ? { ...input.manifest, payload: { reason: 'Other' } }
              : input.manifest,
      })
    for (const v of variants) {
      const r = await callHttp(v, 'post', moneyPath(v), moneyBody(v))
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('HTTP_OPERATION_CONFLICT')
      expect(r.body.httpOperation).toBeUndefined()
      expect(await stored(input)).toEqual(receipt)
    }
    expect(await moneySnapshot(input)).toEqual(before)
    expect(await moneySnapshot(other.input)).toEqual(otherBefore)
  })
  test.each(moneyActions)('Task3 %s receipt failure restores real charge/lines/totals', async action => {
    const { input } = await moneyFixture(action)
    await assertReceiptRollback(
      input,
      tx => moneyDomain(tx, input),
      tx => moneySnapshot(input, tx),
      async tx => {
        const s = await moneySnapshot(input, tx)
        expect(s.order.version).toBe(2)
        if (action === 'applyServiceCharge') {
          expect(s.charges).toHaveLength(1)
          expect(Number(s.order.total)).toBe(110)
        } else {
          expect(s.items.filter(x => x.isCortesia)).toHaveLength(action === 'compItem' ? 1 : 2)
          expect(Number(s.order.total)).toBe(action === 'compItem' ? 60 : 0)
        }
      },
    )
  })

  test.each(compActions)('Task3 %s points benefit uses original ADJUST and never refunds twice', async action => {
    const f = await compRefundFixture(),
      i = compInput(action, f.order.id, f.item.id)
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: f.customer.id } })
    expect(before.loyaltyPoints).toBe(9000)
    const r = await exactReplay(i, 'post', moneyPath(i), moneyBody(i), () =>
      prisma.customer.update({ where: { id: f.customer.id }, data: { loyaltyPoints: { increment: 17 } } }),
    )
    const adjusts = await prisma.loyaltyTransaction.findMany({ where: { orderId: f.order.id, type: 'ADJUST' }, take: 2 })
    expect(adjusts).toHaveLength(1)
    expect(r.envelope).toMatchObject({
      effects: {
        discountBenefits: [
          {
            orderDiscountId: f.discount.id,
            loyaltyRefund: { pointsRefunded: 1000, customerId: f.customer.id, transactionId: adjusts[0].id },
            stampRefund: null,
          },
        ],
      },
    })
    for (const ref of [
      { kind: 'Customer', id: f.customer.id },
      { kind: 'LoyaltyTransaction', id: adjusts[0].id },
      { kind: 'OrderDiscount', id: f.discount.id },
    ])
      expect(r.envelope.affectedRefs).toContainEqual(ref)
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: f.customer.id } })).loyaltyPoints).toBe(10017)
    expect(await prisma.orderDiscount.findUnique({ where: { id: f.discount.id } })).toBeNull()
    const snapshot = await moneySnapshot(i)
    expect(Number(snapshot.order.total)).toBe(action === 'compItem' ? 60 : 0)
    expect(snapshot.items.filter(x => x.isCortesia)).toHaveLength(action === 'compItem' ? 1 : 2)
    evidence(`Task3-${action}-pointsReplay`, i, {
      originalAdjustmentId: adjusts[0].id,
      benefits: 'effects' in r.envelope ? r.envelope.effects : undefined,
      pointsAfter: 10017,
    })
  })
  test.each(compActions)('Task3 %s stamp benefit preserves original ID/customer/label after later reward mutation', async action => {
    const f = await compStampFixture(),
      i = compInput(action, f.order.id, f.item.id)
    const r = await exactReplay(i, 'post', moneyPath(i), moneyBody(i), () =>
      prisma.stampReward.update({ where: { id: f.reward.id }, data: { status: 'EXPIRED', rewardLabel: 'Later label' } }),
    )
    expect(r.envelope).toMatchObject({
      effects: {
        discountBenefits: [
          {
            orderDiscountId: f.discount.id,
            loyaltyRefund: null,
            stampRefund: { rewardId: f.reward.id, customerId: f.customer.id, rewardLabel: 'Café gratis' },
          },
        ],
      },
    })
    for (const ref of [
      { kind: 'Customer', id: f.customer.id },
      { kind: 'StampReward', id: f.reward.id },
      { kind: 'OrderDiscount', id: f.discount.id },
    ])
      expect(r.envelope.affectedRefs).toContainEqual(ref)
    expect(await prisma.stampReward.findUniqueOrThrow({ where: { id: f.reward.id } })).toMatchObject({
      status: 'EXPIRED',
      rewardLabel: 'Later label',
      orderDiscountId: null,
      redeemedAt: null,
    })
    expect(await prisma.orderDiscount.findUnique({ where: { id: f.discount.id } })).toBeNull()
    expect(Number((await moneySnapshot(i)).order.total)).toBe(action === 'compItem' ? 40 : 0)
    evidence(`Task3-${action}-stampReplay`, i, {
      rewardId: f.reward.id,
      originalLabel: 'Café gratis',
      laterLabel: 'Later label',
      benefits: 'effects' in r.envelope ? r.envelope.effects : undefined,
    })
  })
  test.each(compActions)('Task3 %s points receipt failure restores discount, points and transaction history', async action => {
    const f = await compRefundFixture(),
      i = compInput(action, f.order.id, f.item.id)
    const snapshot = async (tx: PrismaTypes.TransactionClient) => ({
      ...(await moneySnapshot(i, tx)),
      customer: await tx.customer.findUniqueOrThrow({ where: { id: f.customer.id } }),
      transactions: await tx.loyaltyTransaction.findMany({ where: { orderId: f.order.id }, orderBy: { id: 'asc' }, take: 3 }),
    })
    expect((await snapshot(prisma)).customer.loyaltyPoints).toBe(9000)
    await assertReceiptRollback(
      i,
      tx => moneyDomain(tx, i),
      snapshot,
      async tx => {
        const inside = await snapshot(tx)
        expect(inside.discounts).toEqual([])
        expect(inside.customer.loyaltyPoints).toBe(10000)
        expect(inside.transactions.filter(x => x.type === 'ADJUST')).toHaveLength(1)
        expect(inside.items.filter(x => x.isCortesia)).toHaveLength(action === 'compItem' ? 1 : 2)
      },
    )
  })
  test.each(compActions)('Task3 %s stamp receipt failure restores full reward association and original label', async action => {
    const f = await compStampFixture(),
      i = compInput(action, f.order.id, f.item.id)
    const snapshot = async (tx: PrismaTypes.TransactionClient) => ({
      ...(await moneySnapshot(i, tx)),
      customer: await tx.customer.findUniqueOrThrow({ where: { id: f.customer.id } }),
      reward: await tx.stampReward.findUniqueOrThrow({ where: { id: f.reward.id } }),
      card: await tx.stampCard.findUniqueOrThrow({ where: { id: f.card.id } }),
    })
    const before = await snapshot(prisma)
    expect(before.reward).toMatchObject({
      status: 'REDEEMED',
      orderDiscountId: f.discount.id,
      rewardLabel: 'Café gratis',
      stampCardId: f.card.id,
      customerId: f.customer.id,
    })
    expect(before.reward.redeemedAt).not.toBeNull()
    await assertReceiptRollback(
      i,
      tx => moneyDomain(tx, i),
      snapshot,
      async tx => {
        const inside = await snapshot(tx)
        expect(inside.discounts).toEqual([])
        expect(inside.reward).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null, rewardLabel: 'Café gratis' })
        expect(inside.items.filter(x => x.isCortesia)).toHaveLength(action === 'compItem' ? 1 : 2)
      },
    )
  })
  test.each(moneyActions)('Task3 %s POST wins unique race and resolver reads original real result', async action => {
    const { input } = await moneyFixture(action)
    const results = await forceOrder(
      `Task3-${action}-postWins`,
      input,
      'PROCESSING',
      () => executeHttpOperation(input, tx => moneyDomain(tx, input)),
      () => resolveHttpOperation({ ...input, actorId: managerId }),
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(results[0].value).toMatchObject({ kind: 'TERMINAL', appliedNow: true })
    expect(results[1].value).toMatchObject({ kind: 'TERMINAL', appliedNow: false })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    expect((await moneySnapshot(input)).order.version).toBe(2)
  })
  test.each(moneyActions)('Task3 %s tombstone wins unique race and POST writes no domain', async action => {
    const { input } = await moneyFixture(action),
      before = await moneySnapshot(input)
    const results = await forceOrder(
      `Task3-${action}-tombstoneWins`,
      input,
      'REJECTED',
      () => resolveHttpOperation({ ...input, actorId: managerId }),
      () => executeHttpOperation(input, tx => moneyDomain(tx, input)),
      async () => {
        expect(await moneySnapshot(input)).toEqual(before)
      },
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(terminal(results[0].value)).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null } })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    expect(await moneySnapshot(input)).toEqual(before)
    expect(terminal(await executeHttpOperation(input, tx => moneyDomain(tx, input)))).toEqual(terminal(results[0].value))
  })
})

// Task4 money TDD: these real routes must stop returning HTTP_OPERATION_UNSUPPORTED.
test('Task4 apply discount exact created amount and totals survive catalog/order mutations', async () => {
  const o = await plainOrder()
  const discount = await prisma.discount.create({
    data: { venueId, name: 'Task4 fixed10', type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', maxTotalUses: 5 },
  })
  const i = operationInput({ action: 'applyOrderDiscount', refs: { orderId: o.id, discountId: discount.id }, payload: {} })
  const r = await exactReplay(i, 'post', `/orders/${o.id}/discounts`, { discountId: discount.id }, async () => {
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: discount.id } })).currentUses).toBe(0)
    await prisma.discount.update({ where: { id: discount.id }, data: { currentUses: 5, name: 'Later', value: 20 } })
    await prisma.order.update({ where: { id: o.id }, data: { total: 777, version: { increment: 1 } } })
  })
  const rows = await prisma.orderDiscount.findMany({ where: { orderId: o.id }, take: 2 })
  expect(rows).toHaveLength(1)
  expect(r.body.data).toEqual({
    orderDiscountId: rows[0].id,
    name: 'Task4 fixed10',
    amount: 10,
    subtotal: 100,
    discountAmount: 10,
    serviceChargeAmount: 0,
    total: 90,
    version: 2,
  })
  expect(r.envelope.affectedRefs).toEqual([
    { kind: 'Order', id: o.id },
    { kind: 'OrderDiscount', id: rows[0].id },
  ])
  expect((await prisma.discount.findUniqueOrThrow({ where: { id: discount.id } })).currentUses).toBe(5)
  expect(logAction).toHaveBeenCalledTimes(1)
  expect(logAction).toHaveBeenCalledWith({
    action: 'ORDER_DISCOUNT_APPLIED',
    entity: 'Order',
    entityId: o.id,
    staffId: authorId,
    venueId,
    data: { discountId: discount.id, name: 'Task4 fixed10', amount: 10 },
  })
})
test('Task4 loyalty receipt keeps exact balance after later customer changes', async () => {
  await prisma.loyaltyConfig.upsert({
    where: { venueId },
    create: { venueId, active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
    update: { active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
  })
  const c = await prisma.customer.create({ data: { venueId, firstName: 'Gate A', loyaltyPoints: 20000 } }),
    o = await plainOrder()
  const i = operationInput({ action: 'redeemLoyaltyPoints', refs: { orderId: o.id, customerId: c.id }, payload: { points: 1000 } })
  const r = await exactReplay(i, 'post', `/orders/${o.id}/loyalty/redeem`, { customerId: c.id, points: 1000 }, () =>
    prisma.customer.update({ where: { id: c.id }, data: { loyaltyPoints: { increment: 77 } } }),
  )
  expect(r.body.data).toEqual({
    pointsRedeemed: 1000,
    discountAmount: 10,
    newBalance: 19000,
    order: { subtotal: 100, discountAmount: 10, serviceChargeAmount: 0, total: 90, version: 2 },
  })
  const rows = await prisma.orderDiscount.findMany({ where: { orderId: o.id }, take: 2 })
  expect(rows).toHaveLength(1)
  expect(r.envelope.affectedRefs).toContainEqual({ kind: 'OrderDiscount', id: rows[0].id })
  expect(r.envelope.affectedRefs).toContainEqual({ kind: 'LoyaltyTransaction', id: rows[0].loyaltyTransactionId! })
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).loyaltyPoints).toBe(19077)
  expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'REDEEM' } })).toBe(1)
  expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).customerId).toBeNull()
  expect(logAction).toHaveBeenCalledTimes(1)
  expect(logAction).toHaveBeenCalledWith({
    action: 'LOYALTY_POINTS_REDEEMED',
    entity: 'Order',
    entityId: o.id,
    staffId: authorId,
    venueId,
    data: { customerId: c.id, points: 1000, discountAmount: 10 },
  })
})
test('Task4 remove discount stores original refund amount and created ADJUST id once', async () => {
  const { redeemPointsToOrder } = await import('@/services/mobile/loyalty.mobile.service')
  await prisma.loyaltyConfig.upsert({
    where: { venueId },
    create: { venueId, active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
    update: { active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
  })
  const c = await prisma.customer.create({ data: { venueId, firstName: 'Refund', loyaltyPoints: 10000 } }),
    o = await plainOrder()
  await redeemPointsToOrder(venueId, o.id, c.id, 1000, authorId)
  const row = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: o.id } })
  const i = operationInput({ action: 'removeOrderDiscount', refs: { orderId: o.id, orderDiscountId: row.id }, payload: {} })
  const r = await exactReplay(i, 'delete', `/orders/${o.id}/discounts/${row.id}`, {}, () =>
    prisma.customer.update({ where: { id: c.id }, data: { loyaltyPoints: { increment: 17 } } }),
  )
  expect(r.body.data).toEqual({ subtotal: 100, discountAmount: 0, serviceChargeAmount: 0, total: 100, version: 3 })
  const adjustments = await prisma.loyaltyTransaction.findMany({ where: { orderId: o.id, type: 'ADJUST' }, take: 2 })
  expect(adjustments).toHaveLength(1)
  expect(r.envelope).toMatchObject({
    effects: { loyaltyRefund: { pointsRefunded: 1000, customerId: c.id, transactionId: adjustments[0].id }, stampRefund: null },
  })
  expect(r.envelope.affectedRefs).toContainEqual({ kind: 'LoyaltyTransaction', id: adjustments[0].id })
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).loyaltyPoints).toBe(10017)
})

describe('Task4 receipt coverage', () => {
  type DiscountAction = 'applyOrderDiscount' | 'removeOrderDiscount' | 'redeemLoyaltyPoints'
  type DiscountInput = OperationInput<DiscountAction>
  const actions: DiscountAction[] = ['applyOrderDiscount', 'removeOrderDiscount', 'redeemLoyaltyPoints']
  async function activeConfig() {
    return prisma.loyaltyConfig.upsert({
      where: { venueId },
      create: { venueId, active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
      update: { active: true, minPointsRedeem: 100, redemptionRate: 0.01 },
    })
  }
  async function discountFixture(action: DiscountAction) {
    const order = await plainOrder()
    if (action === 'applyOrderDiscount') {
      const discount = await prisma.discount.create({
        data: { venueId, name: 'Task4 fixed', type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', maxTotalUses: 5 },
      })
      return {
        order,
        input: operationInput<DiscountAction>({ action, refs: { orderId: order.id, discountId: discount.id }, payload: {} }),
        customerId: null,
        rewardId: null,
        cardId: null,
      }
    }
    await activeConfig()
    const customer = await prisma.customer.create({
      data: { venueId, firstName: 'Task4 customer', loyaltyPoints: action === 'redeemLoyaltyPoints' ? 20000 : 10000 },
    })
    if (action === 'redeemLoyaltyPoints')
      return {
        order,
        input: operationInput<DiscountAction>({ action, refs: { orderId: order.id, customerId: customer.id }, payload: { points: 1000 } }),
        customerId: customer.id,
        rewardId: null,
        cardId: null,
      }
    const { redeemPointsToOrder } = await import('@/services/mobile/loyalty.mobile.service')
    await redeemPointsToOrder(venueId, order.id, customer.id, 1000, authorId)
    const discount = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: order.id } })
    const card = await prisma.stampCard.create({
      data: { customerId: customer.id, venueId, cycle: 1, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
    })
    const reward = await prisma.stampReward.create({
      data: {
        stampCardId: card.id,
        customerId: customer.id,
        venueId,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 10,
        rewardLabel: 'Task4 original café',
        status: 'REDEEMED',
        redeemedAt: new Date(),
        orderDiscountId: discount.id,
      },
    })
    // Both real benefit associations deliberately coexist on the same row to observe both refunds atomically.
    return {
      order,
      input: operationInput<DiscountAction>({ action, refs: { orderId: order.id, orderDiscountId: discount.id }, payload: {} }),
      customerId: customer.id,
      rewardId: reward.id,
      cardId: card.id,
    }
  }
  type DiscountFixture = Awaited<ReturnType<typeof discountFixture>>
  function discountPath(i: Pick<DiscountInput, 'manifest'>) {
    const m = i.manifest
    return m.action === 'applyOrderDiscount'
      ? `/orders/${m.refs.orderId}/discounts`
      : m.action === 'removeOrderDiscount'
        ? `/orders/${m.refs.orderId}/discounts/${m.refs.orderDiscountId}`
        : `/orders/${m.refs.orderId}/loyalty/redeem`
  }
  function discountBody(i: Pick<DiscountInput, 'manifest'>): Record<string, unknown> {
    const m = i.manifest
    return m.action === 'applyOrderDiscount'
      ? { discountId: m.refs.discountId }
      : m.action === 'redeemLoyaltyPoints'
        ? { customerId: m.refs.customerId, points: m.payload.points }
        : {}
  }
  function method(i: DiscountInput) {
    return i.manifest.action === 'removeOrderDiscount' ? ('delete' as const) : ('post' as const)
  }
  async function discountSnapshot(f: DiscountFixture, tx: PrismaTypes.TransactionClient = prisma) {
    const orderId = f.order.id
    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: orderId } }),
      items: await tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
      discounts: await tx.orderDiscount.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
      charges: await tx.orderServiceCharge.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 3 }),
      customer: f.customerId ? await tx.customer.findUniqueOrThrow({ where: { id: f.customerId } }) : null,
      transactions: await tx.loyaltyTransaction.findMany({ where: { orderId }, orderBy: { id: 'asc' }, take: 4 }),
      reward: f.rewardId ? await tx.stampReward.findUnique({ where: { id: f.rewardId } }) : null,
      card: f.cardId ? await tx.stampCard.findUniqueOrThrow({ where: { id: f.cardId } }) : null,
      config: await tx.loyaltyConfig.findUnique({ where: { venueId } }),
      catalog:
        f.input.manifest.action === 'applyOrderDiscount'
          ? await tx.discount.findUnique({ where: { id: f.input.manifest.refs.discountId } })
          : null,
    }
  }
  async function discountDomain(tx: PrismaTypes.TransactionClient, i: DiscountInput): Promise<DomainResult<DiscountAction>> {
    const m = i.manifest
    if (m.action === 'applyOrderDiscount') {
      const { applyOrderDiscountInTransaction } = await import('@/services/mobile/order.mobile.service')
      const r = await applyOrderDiscountInTransaction(tx, venueId, m.refs.orderId, m.refs.discountId, i.actorId)
      return {
        response: {
          status: 200,
          body: { success: true, data: { orderDiscountId: r.row.id, name: r.row.name, amount: Number(r.row.amount), ...r.totals } },
        },
        affectedRefs: [
          { kind: 'Order', id: m.refs.orderId },
          { kind: 'OrderDiscount', id: r.row.id },
        ],
      }
    }
    if (m.action === 'removeOrderDiscount') {
      const { removeOrderDiscountInTransaction } = await import('@/services/mobile/order.mobile.service')
      const r = await removeOrderDiscountInTransaction(tx, venueId, m.refs.orderId, m.refs.orderDiscountId, i.actorId)
      return {
        response: { status: 200, body: { success: true, data: r.totals } },
        effects: { loyaltyRefund: r.refund, stampRefund: r.stampRefund },
        affectedRefs: [
          { kind: 'Order', id: m.refs.orderId },
          { kind: 'OrderDiscount', id: r.row.id },
          ...(r.refund
            ? [
                { kind: 'Customer' as const, id: r.refund.customerId },
                { kind: 'LoyaltyTransaction' as const, id: r.refund.transactionId },
              ]
            : []),
          ...(r.stampRefund
            ? [
                { kind: 'StampReward' as const, id: r.stampRefund.rewardId },
                { kind: 'Customer' as const, id: r.stampRefund.customerId },
              ]
            : []),
        ],
      }
    }
    const { redeemPointsToOrderInTransaction } = await import('@/services/mobile/loyalty.mobile.service')
    const r = await redeemPointsToOrderInTransaction(tx, venueId, m.refs.orderId, m.refs.customerId, m.payload.points, i.actorId)
    return {
      response: {
        status: 200,
        body: {
          success: true,
          data: { pointsRedeemed: r.pointsToBurn, discountAmount: r.discountAmount, newBalance: r.newBalance, order: r.totals },
        },
      },
      affectedRefs: [
        { kind: 'Order', id: m.refs.orderId },
        { kind: 'Customer', id: m.refs.customerId },
        { kind: 'OrderDiscount', id: r.row.id },
        { kind: 'LoyaltyTransaction', id: r.transaction.id },
      ],
    }
  }
  async function assertAppliedDomain(f: DiscountFixture) {
    const s = await discountSnapshot(f),
      action = f.input.manifest.action
    expect(s.order.version).toBe(action === 'removeOrderDiscount' ? 3 : 2)
    expect(Number(s.order.total)).toBe(action === 'removeOrderDiscount' ? 100 : 90)
    expect(Number(s.order.discountAmount)).toBe(action === 'removeOrderDiscount' ? 0 : 10)
    expect(s.transactions.filter(x => x.type === 'REDEEM')).toHaveLength(action === 'applyOrderDiscount' ? 0 : 1)
    expect(s.transactions.filter(x => x.type === 'ADJUST')).toHaveLength(action === 'removeOrderDiscount' ? 1 : 0)
    expect(s.discounts).toHaveLength(action === 'removeOrderDiscount' ? 0 : 1)
    if (s.customer) expect(s.customer.loyaltyPoints).toBe(action === 'removeOrderDiscount' ? 10000 : 19000)
    if (s.reward)
      expect(s.reward).toMatchObject({ status: 'PENDING', redeemedAt: null, orderDiscountId: null, rewardLabel: 'Task4 original café' })
    if (s.catalog) expect(s.catalog.currentUses).toBe(0)
    return s
  }
  test.each(actions)('Task4 %s legacy DTO, no receipt, original audit attribution', async action => {
    const f = await discountFixture(action)
    jest.mocked(logAction).mockClear()
    const client = request(httpApp)
    const r = await client[method(f.input)](`/api/v1/mobile/venues/${venueId}${discountPath(f.input)}`)
      .set('x-test-actor', authorId)
      .send(discountBody(f.input))
    expect(r.status).toBe(200)
    const s = await assertAppliedDomain(f),
      totals = {
        subtotal: 100,
        discountAmount: action === 'removeOrderDiscount' ? 0 : 10,
        serviceChargeAmount: 0,
        total: action === 'removeOrderDiscount' ? 100 : 90,
        version: action === 'removeOrderDiscount' ? 3 : 2,
      }
    const expected =
      action === 'applyOrderDiscount'
        ? { orderDiscountId: s.discounts[0].id, name: 'Task4 fixed', amount: 10, ...totals }
        : action === 'removeOrderDiscount'
          ? totals
          : { pointsRedeemed: 1000, discountAmount: 10, newBalance: 19000, order: totals }
    expect(r.body).toEqual({ success: true, data: expected })
    expect(await stored(f.input)).toBeNull()
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: authorId, venueId, entity: 'Order', entityId: f.order.id }))
    if (action === 'redeemLoyaltyPoints') expect(s.order.customerId).toBeNull()
  })
  test.each(actions)('Task4 %s permission denial occurs before claim/effect', async action => {
    const f = await discountFixture(action),
      before = await discountSnapshot(f),
      access = await staffAccess(authorId)
    const permissionSet = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read'] } })
    try {
      await prisma.staffVenue.update({
        where: { staffId_venueId: { staffId: authorId, venueId } },
        data: { permissionSetId: permissionSet.id },
      })
      const r = await callHttp(f.input, method(f.input), discountPath(f.input), discountBody(f.input))
      expect(r.status).toBe(403)
      expect(r.body.httpOperation).toBeUndefined()
      expect(await stored(f.input)).toBeNull()
      expect(await discountSnapshot(f)).toEqual(before)
    } finally {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
    }
  })
  test.each(actions)('Task4 %s malformed metadata cannot fall into legacy', async action => {
    const f = await discountFixture(action),
      before = await discountSnapshot(f),
      dummy = await fixture()
    for (const [, build] of invalidMetadata) {
      const client = request(httpApp)
      const r = await client[method(f.input)](`/api/v1/mobile/venues/${venueId}${discountPath(f.input)}`)
        .set('x-test-actor', authorId)
        .send({ ...discountBody(f.input), httpOperation: build(dummy) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(r.body.httpOperation).toBeUndefined()
    }
    expect(await stored(f.input)).toBeNull()
    expect(await discountSnapshot(f)).toEqual(before)
  })
  test.each(['1000', 1.5, 0, Infinity, null, 'comp'])('Task4 malformed points %s cannot produce APPLIED', async points => {
    const f = await discountFixture('redeemLoyaltyPoints'),
      before = await discountSnapshot(f)
    const body = points === 'comp' ? { reason: 'Comp this check' } : { customerId: f.customerId, points }
    const r = await callHttp(f.input, 'post', discountPath(f.input), body)
    expect(r.status).toBe(400)
    expect(r.body.httpOperation?.outcome).not.toBe('APPLIED')
    expect(await stored(f.input)).toBeNull()
    expect(await discountSnapshot(f)).toEqual(before)
  })
  test.each(actions)('Task4 %s effect observed before native ACK 23514 fully rolls back', async action => {
    const f = await discountFixture(action)
    await assertReceiptRollback(
      f.input,
      tx => discountDomain(tx, f.input),
      tx => discountSnapshot(f, tx),
      async tx => {
        const s = await discountSnapshot(f, tx)
        expect(s.order.version).toBe(action === 'removeOrderDiscount' ? 3 : 2)
        expect(Number(s.order.total)).toBe(action === 'removeOrderDiscount' ? 100 : 90)
        expect(s.discounts).toHaveLength(action === 'removeOrderDiscount' ? 0 : 1)
        if (s.customer) expect(s.customer.loyaltyPoints).toBe(action === 'removeOrderDiscount' ? 10000 : 19000)
        expect(s.transactions.filter(x => x.type === 'REDEEM')).toHaveLength(action === 'applyOrderDiscount' ? 0 : 1)
        expect(s.transactions.filter(x => x.type === 'ADJUST')).toHaveLength(action === 'removeOrderDiscount' ? 1 : 0)
        if (s.reward)
          expect(s.reward).toMatchObject({
            status: 'PENDING',
            redeemedAt: null,
            orderDiscountId: null,
            rewardLabel: 'Task4 original café',
            stampCardId: f.cardId,
            customerId: f.customerId,
          })
      },
    )
  })
  test.each(actions)('Task4 %s POST wins unique race with one actual economic effect', async action => {
    const f = await discountFixture(action)
    const results = await forceOrder(
      `Task4-${action}-postWins`,
      f.input,
      'PROCESSING',
      () => executeHttpOperation(f.input, tx => discountDomain(tx, f.input)),
      () => resolveHttpOperation({ ...f.input, actorId: managerId }),
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(results[0].value).toMatchObject({ kind: 'TERMINAL', appliedNow: true })
    expect(results[1].value).toMatchObject({ kind: 'TERMINAL', appliedNow: false })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    const s = await assertAppliedDomain(f)
    evidence(`Task4-${action}-economicUnique`, f.input, {
      redeemCount: s.transactions.filter(x => x.type === 'REDEEM').length,
      adjustCount: s.transactions.filter(x => x.type === 'ADJUST').length,
      points: s.customer?.loyaltyPoints,
    })
  })
  test.each(actions)('Task4 %s tombstone wins unique race, late POST has no effect', async action => {
    const f = await discountFixture(action),
      before = await discountSnapshot(f)
    const results = await forceOrder(
      `Task4-${action}-tombstoneWins`,
      f.input,
      'REJECTED',
      () => resolveHttpOperation({ ...f.input, actorId: managerId }),
      () => executeHttpOperation(f.input, tx => discountDomain(tx, f.input)),
      async () => {
        expect(await discountSnapshot(f)).toEqual(before)
      },
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(terminal(results[0].value)).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null } })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    expect(await discountSnapshot(f)).toEqual(before)
    const r = await callHttp(f.input, method(f.input), discountPath(f.input), discountBody(f.input))
    expect(r.body.httpOperation.outcome).toBe('REJECTED')
    expect(await discountSnapshot(f)).toEqual(before)
  })
  test('Task4 remove captures original ADJUST and StampReward before relink then delete', async () => {
    const f = await discountFixture('removeOrderDiscount'),
      before = await discountSnapshot(f)
    expect(before.reward?.redeemedAt).not.toBeNull()
    expect(before.reward).toMatchObject({
      status: 'REDEEMED',
      customerId: f.customerId,
      stampCardId: f.cardId,
      orderDiscountId: f.input.manifest.action === 'removeOrderDiscount' ? f.input.manifest.refs.orderDiscountId : '',
    })
    jest.mocked(logAction).mockClear()
    const first = await callHttp(f.input, 'delete', discountPath(f.input), {})
    expect(first.status).toBe(200)
    const after = await assertAppliedDomain(f)
    expect(after.card).toEqual(before.card)
    const adjustment = after.transactions.find(x => x.type === 'ADJUST')!
    expect(adjustment.points).toBe(1000)
    const original = terminal(await resolveHttpOperation(f.input))
    expect(original).toMatchObject({
      effects: {
        loyaltyRefund: { pointsRefunded: 1000, customerId: f.customerId, transactionId: adjustment.id },
        stampRefund: { rewardId: f.rewardId, customerId: f.customerId, rewardLabel: 'Task4 original café' },
      },
    })
    expect(original.affectedRefs).toEqual([
      { kind: 'Order', id: f.order.id },
      { kind: 'OrderDiscount', id: before.discounts[0].id },
      { kind: 'Customer', id: f.customerId },
      { kind: 'LoyaltyTransaction', id: adjustment.id },
      { kind: 'StampReward', id: f.rewardId },
      { kind: 'Customer', id: f.customerId },
    ])
    const otherCustomer = await prisma.customer.create({ data: { venueId, firstName: 'Later holder' } }),
      otherOrder = await plainOrder()
    const laterDiscount = await prisma.orderDiscount.create({
      data: { orderId: otherOrder.id, type: 'FIXED_AMOUNT', name: 'Later', value: 1, amount: 1 },
    })
    await prisma.stampReward.update({
      where: { id: f.rewardId! },
      data: {
        customerId: otherCustomer.id,
        orderDiscountId: laterDiscount.id,
        status: 'REDEEMED',
        rewardLabel: 'Changed label',
        redeemedAt: new Date(),
      },
    })
    await prisma.loyaltyTransaction.update({ where: { id: adjustment.id }, data: { points: 17, reason: 'Later bookkeeping' } })
    expect(terminal(await resolveHttpOperation(f.input))).toEqual(original)
    expect((await callHttp(f.input, 'delete', discountPath(f.input), {})).body).toEqual(first.body)
    await prisma.stampReward.delete({ where: { id: f.rewardId! } })
    await prisma.loyaltyTransaction.delete({ where: { id: adjustment.id } })
    expect(terminal(await resolveHttpOperation(f.input))).toEqual(original)
    expect((await callHttp(f.input, 'delete', discountPath(f.input), {})).body).toEqual(first.body)
    expect(logAction).toHaveBeenCalledTimes(1)
    expect(logAction).toHaveBeenCalledWith({
      action: 'ORDER_DISCOUNT_REMOVED',
      entity: 'Order',
      entityId: f.order.id,
      staffId: authorId,
      venueId,
      data: {
        orderDiscountId: before.discounts[0].id,
        name: before.discounts[0].name,
        pointsRefunded: 1000,
        stampRewardReturned: f.rewardId,
        taxReturned: 0,
      },
    })
  })
  test('Task4 missing opt-in config rolls back; tombstone and late POST never lazy-create; legacy still inactive lazy-create', async () => {
    const f = await discountFixture('redeemLoyaltyPoints')
    await prisma.loyaltyConfig.delete({ where: { venueId } })
    const before = await discountSnapshot(f)
    const rejected = await callHttp(f.input, 'post', discountPath(f.input), discountBody(f.input))
    expect(rejected.status).toBe(400)
    expect(rejected.body.httpOperation.outcome).toBe('REJECTED')
    expect(await prisma.loyaltyConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await discountSnapshot(f)).toEqual(before)
    const o = await plainOrder(),
      i = operationInput({ action: 'redeemLoyaltyPoints', refs: { orderId: o.id, customerId: f.customerId! }, payload: { points: 1000 } })
    const tombstone = terminal(await resolveHttpOperation({ ...i, actorId: managerId }))
    const late = await callHttp(i, 'post', discountPath(i), discountBody(i))
    expect(late.body.httpOperation.outcome).toBe('REJECTED')
    expect(terminal(await resolveHttpOperation({ ...i, actorId: managerId }))).toEqual(tombstone)
    expect(await prisma.loyaltyConfig.findUnique({ where: { venueId } })).toBeNull()
    const legacy = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}${discountPath(i)}`)
      .set('x-test-actor', authorId)
      .send(discountBody(i))
    expect(legacy.status).toBe(400)
    expect(legacy.body.httpOperation).toBeUndefined()
    expect(await prisma.loyaltyConfig.findUniqueOrThrow({ where: { venueId } })).toMatchObject({
      active: false,
      minPointsRedeem: 100,
      pointsPerVisit: 0,
      pointsExpireDays: 365,
    })
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id } })).toBe(0)
  })
  test('Task4 same customer on two orders cannot burn more than starting points: both CAS waits observed', async () => {
    await activeConfig()
    const customer = await prisma.customer.create({ data: { venueId, firstName: 'CAS race', loyaltyPoints: 1500 } })
    const orders = [await plainOrder(), await plainOrder()]
    const inputs = orders.map(order =>
      operationInput({ action: 'redeemLoyaltyPoints', refs: { orderId: order.id, customerId: customer.id }, payload: { points: 1000 } }),
    )
    const blocker = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
    let release!: () => void, acquired!: (pid: number) => void
    const unlock = new Promise<void>(resolve => {
        release = resolve
      }),
      held = new Promise<number>(resolve => {
        acquired = resolve
      })
    let hold: Promise<void> | undefined
    const pending: Array<ReturnType<typeof callHttp>> = []
    try {
      hold = blocker.$transaction(
        async tx => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
          // A REDEEM FK's KEY SHARE must pass so the held lock blocks the CAS itself.
          await tx.$queryRaw`SELECT id FROM "Customer" WHERE id=${customer.id} FOR NO KEY UPDATE`
          acquired(pid)
          await unlock
        },
        { timeout: 30000 },
      )
      const holderPid = await held
      for (const input of inputs) pending.push(callHttp(input, 'post', discountPath(input), discountBody(input)))
      const running = pending.map(request => request.then(r => r))
      const waits = await eventually(async () => {
        const rows = await prisma.$queryRaw<Array<{ pid: number; blockers: number[]; wait_event_type: string; query: string }>>`
          WITH RECURSIVE blocked AS (
            SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int=ANY(pg_blocking_pids(pid))
            UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
          )
          SELECT a.pid, pg_blocking_pids(a.pid) AS blockers, a.wait_event_type, a.query
          FROM pg_stat_activity a JOIN blocked b ON b.pid=a.pid
          WHERE a.datname=current_database() AND a.query LIKE '%UPDATE%"Customer"%' AND a.wait_event_type='Lock'`
        return rows.length === 2 ? rows : undefined
      })
      for (const wait of waits) {
        expect(wait.blockers.length).toBeGreaterThan(0)
        expect(await writtenTables(wait.pid)).toContain('LoyaltyTransaction')
        expect(await writtenTables(wait.pid)).toContain('Customer')
      }
      evidence('Task4-customerCAS-blocked', inputs[0], {
        holderPid,
        waitingPids: waits.map(w => w.pid),
        stage: 'Customer UPDATE after REDEEM insert',
        lockMode: 'FOR NO KEY UPDATE',
      })
      release()
      await hold
      const results = await Promise.all(running)
      expect(results.map(r => r.status).sort()).toEqual([200, 400])
      expect(results.filter(r => r.body.httpOperation?.outcome === 'APPLIED')).toHaveLength(1)
      expect(results.filter(r => r.body.httpOperation?.outcome === 'REJECTED')).toHaveLength(1)
      const transactions = await prisma.loyaltyTransaction.findMany({ where: { customerId: customer.id, type: 'REDEEM' }, take: 3 })
      expect(transactions).toHaveLength(1)
      const burned = -transactions.reduce((sum, t) => sum + t.points, 0)
      expect(burned).toBe(1000)
      expect(burned).toBeLessThanOrEqual(1500)
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints).toBe(500)
      expect(await prisma.orderDiscount.count({ where: { orderId: { in: orders.map(o => o.id) } } })).toBe(1)
      expect((await prisma.order.findMany({ where: { id: { in: orders.map(o => o.id) } }, take: 2 })).map(o => o.version).sort()).toEqual([
        1, 2,
      ])
      evidence('Task4-customerCAS-settled', inputs[0], {
        startingPoints: 1500,
        burned,
        pointsAfter: 500,
        redeemCount: transactions.length,
        outcomes: results.map(r => r.body.httpOperation.outcome),
      })
    } finally {
      release()
      await Promise.allSettled([hold ?? Promise.resolve(), ...pending.map(request => request.then(r => r))])
      await blocker.$disconnect()
    }
  })
  test('Task4 ACK gate proves original newBalance captured before second customer commit', async () => {
    await activeConfig()
    const customer = await prisma.customer.create({ data: { venueId, firstName: 'ACK original balance', loyaltyPoints: 20000 } })
    const firstOrder = await plainOrder(),
      secondOrder = await plainOrder()
    const firstInput = operationInput({
      action: 'redeemLoyaltyPoints',
      refs: { orderId: firstOrder.id, customerId: customer.id },
      payload: { points: 1000 },
    })
    const secondInput = operationInput({
      action: 'redeemLoyaltyPoints',
      refs: { orderId: secondOrder.id, customerId: customer.id },
      payload: { points: 1000 },
    })
    const suffix = randomUUID().replace(/-/g, ''),
      fn = `ga_t4_ack_${suffix}`,
      trigger = `ga_t4_ack_trigger_${suffix}`,
      gate = randomInt(1, 2000000000)
    const blocker = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
    let release!: () => void, acquired!: () => void
    const unlock = new Promise<void>(resolve => {
        release = resolve
      }),
      held = new Promise<void>(resolve => {
        acquired = resolve
      })
    let hold: Promise<void> | undefined,
      first: Promise<Awaited<ReturnType<typeof callHttp>>> | undefined,
      second: Promise<Awaited<ReturnType<typeof callHttp>>> | undefined
    try {
      await prisma.$executeRawUnsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$
        BEGIN IF NEW."idempotencyKey"='http:v1:${firstInput.operation.id}' AND NEW.type='HTTP_OP_V1' AND NEW.status='ACKED'
        THEN PERFORM pg_advisory_xact_lock(${gate}::bigint); END IF; RETURN NEW; END $b$`)
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "PosSyncIntent" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
      hold = blocker.$transaction(
        async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${gate}::bigint)`
          acquired()
          await unlock
        },
        { timeout: 30000 },
      )
      await held
      first = callHttp(firstInput, 'post', discountPath(firstInput), discountBody(firstInput)).then(r => r)
      const firstPid = await eventually(async () => {
        const rows = await prisma.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=${gate}::oid AND NOT granted`
        return rows[0]?.pid
      })
      expect(await writtenTables(firstPid)).toEqual(
        expect.arrayContaining(['Customer', 'LoyaltyTransaction', 'OrderDiscount', 'Order', 'PosSyncIntent']),
      )
      second = callHttp(secondInput, 'post', discountPath(secondInput), discountBody(secondInput)).then(r => r)
      const secondWait = await eventually(async () => {
        const rows = await prisma.$queryRaw<Array<{ pid: number; blockers: number[] }>>`
          SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE ${firstPid}::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%UPDATE%"Customer"%' AND wait_event_type='Lock'`
        return rows[0]
      })
      expect(secondWait.blockers).toContain(firstPid)
      expect(await writtenTables(secondWait.pid)).toContain('LoyaltyTransaction')
      // First transaction holds its changed customer through ACK; the committed balance is still the pre-burn value.
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints).toBe(20000)
      evidence('Task4-ACK-balance-blocked', firstInput, {
        firstPid,
        secondPid: secondWait.pid,
        secondBlockedBy: secondWait.blockers,
        stage: 'first BEFORE ACK UPDATE after helper; second Customer CAS',
      })
      release()
      await hold
      const [a, b] = await Promise.all([first, second])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(a.body.data.newBalance).toBe(19000)
      expect(b.body.data.newBalance).toBe(18000)
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints).toBe(18000)
      const resolved = terminal(await resolveHttpOperation(firstInput))
      expect(resolved).toMatchObject({ originalResponse: { body: { data: { newBalance: 19000 } } } })
      expect((await callHttp(firstInput, 'post', discountPath(firstInput), discountBody(firstInput))).body).toEqual(a.body)
      expect(await prisma.loyaltyTransaction.count({ where: { customerId: customer.id, type: 'REDEEM' } })).toBe(2)
      evidence('Task4-ACK-balance-settled', firstInput, {
        firstBalance: 19000,
        secondBalance: 18000,
        currentBalance: 18000,
        secondCommitObserved: true,
      })
    } finally {
      release()
      await Promise.allSettled([hold ?? Promise.resolve(), first ?? Promise.resolve(), second ?? Promise.resolve()])
      try {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "PosSyncIntent"`)
      } finally {
        try {
          await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
        } finally {
          await blocker.$disconnect()
        }
      }
    }
  })
})

test('Task5 details no-covers shares receipt TX and preserves clear/null original DTO', async () => {
  const o = await plainOrder()
  await prisma.order.update({ where: { id: o.id }, data: { customerName: 'Old', specialRequests: 'Keep' } })
  const i = operationInput({ action: 'updateOrderDetails', refs: { orderId: o.id }, payload: { name: '' } })
  const r = await exactReplay(i, 'post', `/orders/${o.id}/details`, { name: '  ', notes: null }, () =>
    prisma.order.update({ where: { id: o.id }, data: { customerName: 'New', specialRequests: 'Later' } }),
  )
  expect(r.body.data).toEqual({ name: null, notes: 'Keep', customerId: null, covers: null, orderType: o.type })
  expect(Object.keys(r.body.data).sort()).toEqual(['covers', 'customerId', 'name', 'notes', 'orderType'])
})
test('Task5 assign returns original staffName and auth actor after later Order and Staff changes', async () => {
  const o = await plainOrder()
  const staff = await prisma.staff.findUniqueOrThrow({ where: { id: managerId } })
  const i = operationInput({ action: 'assignOrder', refs: { orderId: o.id, staffId: managerId }, payload: {} })
  try {
    const r = await exactReplay(i, 'post', `/orders/${o.id}/assign`, { staffId: managerId }, async () => {
      await prisma.order.update({ where: { id: o.id }, data: { servedById: authorId } })
      await prisma.staff.update({ where: { id: managerId }, data: { firstName: 'Later', lastName: 'Name' } })
    })
    expect(r.body.data).toEqual({ staffName: `${staff.firstName} ${staff.lastName}`.trim() })
    expect(r.envelope.request.originalActorId).toBe(authorId)
    expect(r.envelope.affectedRefs).toEqual([
      { kind: 'Order', id: o.id },
      { kind: 'Staff', id: managerId },
    ])
  } finally {
    await prisma.staff.update({ where: { id: managerId }, data: { firstName: staff.firstName, lastName: staff.lastName } })
  }
})

describe('Task5 receipt coverage', () => {
  type DetailsAction = 'updateOrderDetails' | 'assignOrder'
  type DetailsInput = OperationInput<DetailsAction>
  const actions: DetailsAction[] = ['updateOrderDetails', 'assignOrder']
  async function detailsFixture(action: DetailsAction) {
    const o = await plainOrder()
    const customer = await prisma.customer.create({ data: { venueId, firstName: 'Task5', lastName: 'Customer' } })
    await prisma.order.update({ where: { id: o.id }, data: { customerName: 'Old', specialRequests: 'Keep', covers: 1 } })
    const input = operationInput<DetailsAction>(
      action === 'assignOrder'
        ? { action, refs: { orderId: o.id, staffId: managerId }, payload: {} }
        : { action, refs: { orderId: o.id }, payload: { name: 'New', notes: 'Notes', customerId: customer.id, orderType: 'TAKEOUT' } },
    )
    return { o, input, customer }
  }
  type DetailsFixture = Awaited<ReturnType<typeof detailsFixture>>
  function detailsPath(i: Pick<DetailsInput, 'manifest'>) {
    return `/orders/${i.manifest.refs.orderId}/${i.manifest.action === 'assignOrder' ? 'assign' : 'details'}`
  }
  function detailsBody(i: Pick<DetailsInput, 'manifest'>): Record<string, unknown> {
    return i.manifest.action === 'assignOrder' ? { staffId: i.manifest.refs.staffId } : i.manifest.payload
  }
  async function detailsSnapshot(f: DetailsFixture, tx: PrismaTypes.TransactionClient = prisma, chargeTake = 3) {
    return {
      order: await tx.order.findUniqueOrThrow({ where: { id: f.o.id } }),
      items: await tx.orderItem.findMany({ where: { orderId: f.o.id }, orderBy: { id: 'asc' }, take: 3 }),
      discounts: await tx.orderDiscount.findMany({ where: { orderId: f.o.id }, orderBy: { id: 'asc' }, take: 3 }),
      charges: await tx.orderServiceCharge.findMany({ where: { orderId: f.o.id }, orderBy: { id: 'asc' }, take: chargeTake }),
      customer: await tx.customer.findUniqueOrThrow({ where: { id: f.customer.id } }),
    }
  }
  async function detailsDomain(tx: PrismaTypes.TransactionClient, i: DetailsInput): Promise<DomainResult<DetailsAction>> {
    const m = i.manifest
    if (m.action === 'assignOrder') {
      const { assignOrderWaiterInTransaction } = await import('@/services/tpv/table.tpv.service')
      const r = await assignOrderWaiterInTransaction(tx, venueId, m.refs.orderId, m.refs.staffId)
      return {
        response: { status: 200, body: { success: true, data: r.data } },
        affectedRefs: [
          { kind: 'Order', id: m.refs.orderId },
          { kind: 'Staff', id: m.refs.staffId },
        ],
      }
    }
    const { updateOrderDetailsInTransaction } = await import('@/services/mobile/order.mobile.service')
    const r = await updateOrderDetailsInTransaction(tx, venueId, m.refs.orderId, m.payload)
    return {
      response: { status: 200, body: { success: true, data: r.data } },
      affectedRefs: [
        { kind: 'Order', id: m.refs.orderId },
        ...r.affectedServiceChargeIds.map(id => ({ kind: 'OrderServiceCharge' as const, id })),
        ...(m.payload.customerId ? [{ kind: 'Customer' as const, id: m.payload.customerId }] : []),
      ],
    }
  }
  async function assertDetailsApplied(f: DetailsFixture, tx: PrismaTypes.TransactionClient = prisma) {
    const s = await detailsSnapshot(f, tx)
    if (f.input.manifest.action === 'assignOrder') expect(s.order.servedById).toBe(managerId)
    else
      expect(s.order).toMatchObject({
        customerName: 'New',
        specialRequests: 'Notes',
        customerId: f.customer.id,
        type: 'TAKEOUT',
        covers: 1,
      })
    expect(Number(s.order.total)).toBe(100)
    expect(Number(s.order.remainingBalance)).toBe(100)
    expect(s.items).toHaveLength(2)
    expect(s.discounts).toEqual([])
    expect(s.charges).toEqual([])
    return s
  }
  test.each(actions)('Task5 %s legacy exact DTO, no receipt and one real business change', async action => {
    const f = await detailsFixture(action)
    const r = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}${detailsPath(f.input)}`)
      .set('x-test-actor', authorId)
      .send({ ...detailsBody(f.input), ignoredExtra: true })
    expect(r.status).toBe(200)
    await assertDetailsApplied(f)
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: managerId } })
    expect(r.body).toEqual({
      success: true,
      data:
        action === 'assignOrder'
          ? { staffName: `${staff.firstName} ${staff.lastName}`.trim() }
          : { name: 'New', notes: 'Notes', customerId: f.customer.id, orderType: 'TAKEOUT', covers: 1 },
    })
    expect(await stored(f.input)).toBeNull()
  })
  test.each(actions)('Task5 %s current permission denial precedes claim and effect', async action => {
    const f = await detailsFixture(action),
      before = await detailsSnapshot(f),
      access = await staffAccess(authorId)
    const set = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read'] } })
    try {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { permissionSetId: set.id } })
      expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).status).toBe(403)
      expect(await stored(f.input)).toBeNull()
      expect(await detailsSnapshot(f)).toEqual(before)
    } finally {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
    }
  })
  test.each(actions)('Task5 %s invalid metadata never invokes legacy', async action => {
    const f = await detailsFixture(action),
      before = await detailsSnapshot(f),
      dummy = await fixture()
    for (const [, build] of invalidMetadata) {
      const r = await request(httpApp)
        .post(`/api/v1/mobile/venues/${venueId}${detailsPath(f.input)}`)
        .set('x-test-actor', authorId)
        .send({ ...detailsBody(f.input), httpOperation: build(dummy) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(r.body.httpOperation).toBeUndefined()
    }
    expect(await stored(f.input)).toBeNull()
    expect(await detailsSnapshot(f)).toEqual(before)
  })
  test.each(actions)('Task5 %s malformed consumed payload cannot apply', async action => {
    const f = await detailsFixture(action),
      before = await detailsSnapshot(f)
    for (const body of action === 'assignOrder'
      ? [{ staffId: 27 }, { staffId: '' }, { reason: 'Wrong action' }]
      : [{ name: 27 }, { covers: '8' }, { orderType: 'MANUAL_ENTRY' }, { customerId: 27 }]) {
      const r = await callHttp(f.input, 'post', detailsPath(f.input), body)
      expect(r.status).toBe(400)
      expect(r.body.httpOperation?.outcome).not.toBe('APPLIED')
      expect(await stored(f.input)).toBeNull()
    }
    expect(await detailsSnapshot(f)).toEqual(before)
  })
  test.each(actions)('Task5 %s native ACK23514 follows observed real domain mutation and full rollback', async action => {
    const f = await detailsFixture(action)
    const tableService = await import('@/services/tpv/table.tpv.service')
    const publisher = jest.spyOn(tableService, 'publishOrderWaiterAssignment')
    await assertReceiptRollback(
      f.input,
      tx => detailsDomain(tx, f.input),
      tx => detailsSnapshot(f, tx),
      async tx => {
        await assertDetailsApplied(f, tx)
      },
    )
    expect(publisher).not.toHaveBeenCalled()
  })
  test.each(actions)('Task5 %s POST wins unique race with actual full business effect', async action => {
    const f = await detailsFixture(action)
    const results = await forceOrder(
      `Task5-${action}-postWins`,
      f.input,
      'PROCESSING',
      () => executeHttpOperation(f.input, tx => detailsDomain(tx, f.input)),
      () => resolveHttpOperation({ ...f.input, actorId: managerId }),
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(results[0].value).toMatchObject({ kind: 'TERMINAL', appliedNow: true })
    expect(results[1].value).toMatchObject({ kind: 'TERMINAL', appliedNow: false })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    const s = await assertDetailsApplied(f)
    evidence(`Task5-${action}-uniqueBusiness`, f.input, {
      servedById: s.order.servedById,
      customerId: s.order.customerId,
      name: s.order.customerName,
      total: Number(s.order.total),
    })
  })
  test.each(actions)('Task5 %s tombstone wins unique and late POST preserves full business snapshot', async action => {
    const f = await detailsFixture(action),
      before = await detailsSnapshot(f)
    const tableService = await import('@/services/tpv/table.tpv.service')
    const publisher = jest.spyOn(tableService, 'publishOrderWaiterAssignment')
    const results = await forceOrder(
      `Task5-${action}-tombstoneWins`,
      f.input,
      'REJECTED',
      () => resolveHttpOperation({ ...f.input, actorId: managerId }),
      () => executeHttpOperation(f.input, tx => detailsDomain(tx, f.input)),
      async () => {
        expect(await detailsSnapshot(f)).toEqual(before)
      },
    )
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled') throw new Error('Both sides must finish')
    expect(terminal(results[0].value)).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null } })
    expect(terminal(results[1].value)).toEqual(terminal(results[0].value))
    expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).body.httpOperation.outcome).toBe('REJECTED')
    expect(await detailsSnapshot(f)).toEqual(before)
    expect(publisher).not.toHaveBeenCalled()
  })
  test.each([
    [
      { name: null, notes: null, customerId: null, orderType: null, covers: null },
      { name: 'Old', notes: 'Keep', customerId: null, orderType: 'DINE_IN', covers: 1 },
      false,
    ],
    [{ name: '', notes: '' }, { name: null, notes: null, customerId: null, orderType: 'DINE_IN', covers: 1 }, true],
    [{ name: '  ', notes: '  ' }, { name: null, notes: null, customerId: null, orderType: 'DINE_IN', covers: 1 }, true],
    [
      { name: ' New ', notes: ' Notes ', orderType: 'PICKUP' },
      { name: 'New', notes: 'Notes', customerId: null, orderType: 'PICKUP', covers: 1 },
      true,
    ],
    [
      { notes: 'changed', customerId: '', orderType: '' },
      { name: 'Old', notes: 'changed', customerId: null, orderType: 'DINE_IN', covers: 1 },
      true,
    ],
  ] as const)('Task5 details exact null/clear/whitespace/omitted semantics %j', async (payload, expected, applies) => {
    const f = await detailsFixture('updateOrderDetails')
    const { manifestSchema } = await import('@/services/mobile/http-operation.mobile.service')
    const manifest = manifestSchema.parse({ action: 'updateOrderDetails', refs: { orderId: f.o.id }, payload })
    if (manifest.action !== 'updateOrderDetails') throw new Error('Expected details manifest')
    const i = operationInput(manifest)
    const r = await callHttp(i, 'post', `/orders/${f.o.id}/details`, payload)
    expect(r.status).toBe(applies ? 200 : 400)
    if (applies) expect(r.body.data).toEqual(expected)
    else {
      expect(r.body.message).toBe('Nada que actualizar')
      expect((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).customerName).toBe('Old')
    }
  })
  test('Task5 current MANUAL_ENTRY response stays valid while attach follows only missing name and detach preserves name', async () => {
    const f = await detailsFixture('updateOrderDetails')
    await prisma.order.update({ where: { id: f.o.id }, data: { type: 'MANUAL_ENTRY', customerName: null } })
    const attach = operationInput({ action: 'updateOrderDetails', refs: { orderId: f.o.id }, payload: { customerId: f.customer.id } })
    const a = await callHttp(attach, 'post', detailsPath(attach), { customerId: f.customer.id, name: null })
    expect(a.body.data).toEqual({ name: 'Task5 Customer', notes: 'Keep', covers: 1, customerId: f.customer.id, orderType: 'MANUAL_ENTRY' })
    expect(terminal(await resolveHttpOperation(attach)).affectedRefs).toContainEqual({ kind: 'Customer', id: f.customer.id })
    const explicit = operationInput({
      action: 'updateOrderDetails',
      refs: { orderId: f.o.id },
      payload: { name: 'Custom', customerId: f.customer.id },
    })
    expect((await callHttp(explicit, 'post', detailsPath(explicit), explicit.manifest.payload)).body.data.name).toBe('Custom')
    const preserve = operationInput({ action: 'updateOrderDetails', refs: { orderId: f.o.id }, payload: { customerId: f.customer.id } })
    expect((await callHttp(preserve, 'post', detailsPath(preserve), { customerId: f.customer.id, name: null })).body.data.name).toBe(
      'Custom',
    )
    const detach = operationInput({ action: 'updateOrderDetails', refs: { orderId: f.o.id }, payload: { customerId: '' } })
    expect((await callHttp(detach, 'post', detailsPath(detach), { customerId: '' })).body.data).toEqual({
      name: 'Custom',
      notes: 'Keep',
      covers: 1,
      customerId: null,
      orderType: 'MANUAL_ENTRY',
    })
    expect((await callHttp(attach, 'post', detailsPath(attach), { customerId: f.customer.id })).body).toEqual(a.body)
  })
  test('Task5 fractional covers1.5 preserves actual legacy DTO and persisted Int behavior', async () => {
    const legacy = await plainOrder(),
      current = await plainOrder()
    const i = operationInput({ action: 'updateOrderDetails', refs: { orderId: current.id }, payload: { covers: 1.5 } })
    const a = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}/orders/${legacy.id}/details`)
      .set('x-test-actor', authorId)
      .send({ covers: 1.5 })
    const b = await callHttp(i, 'post', `/orders/${current.id}/details`, { covers: 1.5 })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.data).toEqual({ name: null, notes: null, covers: 1, customerId: null, orderType: current.type })
    expect(b.body.data).toEqual(a.body.data)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: current.id } })).covers).toBe(1)
    evidence('Task5-fractional-covers', i, {
      legacyStatus: a.status,
      optInStatus: b.status,
      legacyData: a.body.data,
      optInData: b.body.data,
    })
  })
  test('Task5 assignment publisher runs once only for APPLIED; replay/resolve/failure publish zero', async () => {
    const f = await detailsFixture('assignOrder')
    const tableService = await import('@/services/tpv/table.tpv.service')
    const publisher = jest.spyOn(tableService, 'publishOrderWaiterAssignment')
    await exactReplay(f.input, 'post', detailsPath(f.input), detailsBody(f.input), () =>
      prisma.order.update({ where: { id: f.o.id }, data: { servedById: authorId } }),
    )
    expect(publisher).toHaveBeenCalledTimes(1)
    expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).status).toBe(200)
    await resolveHttpOperation(f.input)
    expect(publisher).toHaveBeenCalledTimes(1)
    const closed = await detailsFixture('assignOrder')
    await prisma.order.update({ where: { id: closed.o.id }, data: { status: 'COMPLETED' } })
    expect((await callHttp(closed.input, 'post', detailsPath(closed.input), detailsBody(closed.input))).status).toBe(400)
    expect(publisher).toHaveBeenCalledTimes(1)
  })
  test('Task5 notification exception after commit retains native APPLIED response and receipt', async () => {
    const f = await detailsFixture('assignOrder')
    const socket = (await import('@/communication/sockets')).default
    jest.spyOn(socket, 'getBroadcastingService').mockImplementation(() => {
      throw new Error('Task5 socket fault')
    })
    const r = await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))
    expect(r.status).toBe(200)
    expect(r.body.httpOperation.outcome).toBe('APPLIED')
    await assertDetailsApplied(f)
    expect(terminal(await resolveHttpOperation(f.input)).outcome).toBe('APPLIED')
  })
  test.each(['PAID', 'PARTIAL'] as const)(
    'Task5 %s details and assign preserve current allowed metadata/recipient changes',
    async paymentStatus => {
      for (const action of actions) {
        const f = await detailsFixture(action)
        await prisma.order.update({ where: { id: f.o.id }, data: { paymentStatus } })
        expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).status).toBe(200)
        await assertDetailsApplied(f)
      }
    },
  )
  async function coversFixture(removal = false) {
    await prisma.serviceCharge.updateMany({ where: { venueId, autoApplyMinCovers: { not: null } }, data: { active: false } })
    const f = await detailsFixture('updateOrderDetails')
    const rule = await prisma.serviceCharge.create({
      data: { venueId, name: 'Task5 automatic', type: 'FIXED_AMOUNT', value: 10, taxable: false, autoApplyMinCovers: 8 },
    })
    const manual = await prisma.orderServiceCharge.create({
      data: {
        orderId: f.o.id,
        name: 'Task5 manual percentage',
        type: 'PERCENTAGE',
        value: 10,
        amount: 1,
        taxable: false,
        isAutomatic: false,
      },
    })
    await prisma.order.update({ where: { id: f.o.id }, data: { serviceChargeAmount: 1, total: 101, remainingBalance: 101 } })
    if (removal) {
      const { updateOrderDetails } = await import('@/services/mobile/order.mobile.service')
      await updateOrderDetails(venueId, f.o.id, { covers: 8 })
    }
    const automatic = await prisma.orderServiceCharge.findUnique({
      where: { orderId_serviceChargeId: { orderId: f.o.id, serviceChargeId: rule.id } },
    })
    const input = operationInput<DetailsAction>({
      action: 'updateOrderDetails',
      refs: { orderId: f.o.id },
      payload: { covers: removal ? 1 : 8 },
    })
    return { ...f, input, rule, manual, automatic }
  }
  async function largeCoversFixture() {
    const f = await coversFixture()
    const survivorIds: string[] = Array.from({ length: 102 }, () => randomUUID())
    await prisma.orderServiceCharge.createMany({
      data: survivorIds.map(id => ({
        id,
        orderId: f.o.id,
        name: 'Task5 page survivor',
        type: 'PERCENTAGE' as const,
        value: 1,
        amount: 0.1,
        taxable: false,
        isAutomatic: false,
      })),
    })
    await prisma.order.update({ where: { id: f.o.id }, data: { serviceChargeAmount: 11.2, total: 111.2, remainingBalance: 111.2 } })
    return { ...f, survivorIds }
  }
  test('Task5 capture preserves every changed persisted ID beyond first 100 survivors and immutable replay', async () => {
    const f = await largeCoversFixture()
    const r = await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))
    expect(r.status).toBe(200)
    const s = await detailsSnapshot(f, prisma, 105)
    expect(s.charges).toHaveLength(104)
    expect(s.charges.filter(row => f.survivorIds.includes(row.id)).every(row => Number(row.amount) === 1)).toBe(true)
    expect(Number(s.charges.find(row => row.id === f.manual.id)!.amount)).toBe(10)
    expect(Number(s.order.total)).toBe(222)
    expect(Number(s.order.serviceChargeAmount)).toBe(122)
    const created = s.charges.find(row => row.serviceChargeId === f.rule.id)!
    const original = terminal(await resolveHttpOperation(f.input))
    expect(
      original.affectedRefs
        .filter(ref => ref.kind === 'OrderServiceCharge')
        .map(ref => ref.id)
        .sort(),
    ).toEqual([f.manual.id, ...f.survivorIds, created.id].sort())
    expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).body).toEqual(r.body)
    expect(await detailsSnapshot(f, prisma, 105)).toEqual(s)
    expect(terminal(await resolveHttpOperation(f.input))).toEqual(original)
    evidence('Task5-capture-page-complete', f.input, {
      chargeCount: s.charges.length,
      affectedIds: original.affectedRefs,
      total: s.order.total,
    })
  })
  test('Task5 more than 100 actual changed survivors precede ACK23514 and full business snapshot rollback', async () => {
    const f = await largeCoversFixture()
    await assertReceiptRollback(
      f.input,
      tx => detailsDomain(tx, f.input),
      tx => detailsSnapshot(f, tx, 105),
      async tx => {
        const s = await detailsSnapshot(f, tx, 105)
        expect(s.charges).toHaveLength(104)
        expect(s.charges.filter(row => f.survivorIds.includes(row.id)).every(row => Number(row.amount) === 1)).toBe(true)
        expect(Number(s.charges.find(row => row.id === f.manual.id)!.amount)).toBe(10)
        expect(Number(s.order.total)).toBe(222)
        expect(Number(s.order.serviceChargeAmount)).toBe(122)
        expect(s.order.covers).toBe(8)
      },
    )
  })
  test.each([false, true])(
    'Task5 threshold removal=%s exact actual created/deleted and changed manual IDs stay immutable',
    async removal => {
      const f = await coversFixture(removal)
      const r = await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))
      expect(r.status).toBe(200)
      const s = await detailsSnapshot(f)
      const created = s.charges.find(x => x.serviceChargeId === f.rule.id)
      expect(s.order.covers).toBe(removal ? 1 : 8)
      expect(Number(s.order.total)).toBe(removal ? 110 : 120)
      expect(Number(s.order.serviceChargeAmount)).toBe(removal ? 10 : 20)
      expect(Number(s.charges.find(x => x.id === f.manual.id)!.amount)).toBe(10)
      const original = terminal(await resolveHttpOperation(f.input))
      expect(
        original.affectedRefs
          .filter(x => x.kind === 'OrderServiceCharge')
          .map(x => x.id)
          .sort(),
      ).toEqual(removal ? [f.automatic!.id] : [created!.id, f.manual.id].sort())
      const { updateOrderDetails } = await import('@/services/mobile/order.mobile.service')
      await updateOrderDetails(venueId, f.o.id, { covers: removal ? 8 : 1 })
      if (removal) {
        const recreated = await prisma.orderServiceCharge.findUniqueOrThrow({
          where: { orderId_serviceChargeId: { orderId: f.o.id, serviceChargeId: f.rule.id } },
        })
        expect(recreated.id).not.toBe(f.automatic!.id)
      } else expect(await prisma.orderServiceCharge.findUnique({ where: { id: created!.id } })).toBeNull()
      expect(terminal(await resolveHttpOperation(f.input))).toEqual(original)
      expect((await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))).body).toEqual(r.body)
    },
  )
  test.each([false, true])('Task5 threshold removal=%s observes covers and row/totals before ACK23514 then restores all', async removal => {
    const f = await coversFixture(removal)
    await assertReceiptRollback(
      f.input,
      tx => detailsDomain(tx, f.input),
      tx => detailsSnapshot(f, tx),
      async tx => {
        const s = await detailsSnapshot(f, tx)
        expect(s.order.covers).toBe(removal ? 1 : 8)
        expect(Number(s.order.total)).toBe(removal ? 110 : 120)
        expect(s.charges.some(x => x.serviceChargeId === f.rule.id)).toBe(!removal)
        expect(Number(s.charges.find(x => x.id === f.manual.id)!.amount)).toBe(10)
        if (removal) expect(await tx.orderServiceCharge.findUnique({ where: { id: f.automatic!.id } })).toBeNull()
      },
    )
  })
  test('Task5 preexisting manual composite duplicate stays same row and unchanged flag never recalculates', async () => {
    const f = await coversFixture()
    const existing = await prisma.orderServiceCharge.create({
      data: {
        orderId: f.o.id,
        serviceChargeId: f.rule.id,
        name: 'Manual duplicate',
        type: 'FIXED_AMOUNT',
        value: 10,
        amount: 10,
        taxable: false,
        isAutomatic: false,
      },
    })
    const before = await detailsSnapshot(f)
    const r = await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))
    expect(r.status).toBe(200)
    const after = await detailsSnapshot(f)
    expect(after.charges).toEqual(before.charges)
    expect(Number(after.order.total)).toBe(101)
    expect(after.order.version).toBe(before.order.version)
    expect(terminal(await resolveHttpOperation(f.input)).affectedRefs).toEqual([{ kind: 'Order', id: f.o.id }])
    const { updateOrderDetails } = await import('@/services/mobile/order.mobile.service')
    await updateOrderDetails(venueId, f.o.id, { covers: 1 })
    expect(await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existing)
  })
  test('Task5 threshold captures changed surviving automatic percentage plus manual and actual created ID', async () => {
    const f = await coversFixture()
    const rule = await prisma.serviceCharge.create({
      data: { venueId, name: 'Surviving percentage', type: 'PERCENTAGE', value: 5, taxable: false, autoApplyMinCovers: 1 },
    })
    const survivor = await prisma.orderServiceCharge.create({
      data: {
        orderId: f.o.id,
        serviceChargeId: rule.id,
        name: rule.name,
        type: rule.type,
        value: rule.value,
        amount: 0.5,
        taxable: false,
        isAutomatic: true,
      },
    })
    const r = await callHttp(f.input, 'post', detailsPath(f.input), detailsBody(f.input))
    expect(r.status).toBe(200)
    const created = await prisma.orderServiceCharge.findUniqueOrThrow({
      where: { orderId_serviceChargeId: { orderId: f.o.id, serviceChargeId: f.rule.id } },
    })
    expect(
      terminal(await resolveHttpOperation(f.input))
        .affectedRefs.filter(x => x.kind === 'OrderServiceCharge')
        .map(x => x.id)
        .sort(),
    ).toEqual([f.manual.id, survivor.id, created.id].sort())
    expect(Number((await prisma.orderServiceCharge.findUniqueOrThrow({ where: { id: survivor.id } })).amount)).toBe(5)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).total)).toBe(125)
  })
})

// Task8: native RED and immutable TPV compatibility controls, before domain extraction.
describe('Task8 native move clear merge cancel', () => {
  test('move commits source sibling reconciliation with original receipt', async () => {
    const source = await emptyTable(),
      target = await emptyTable(),
      o = await plainOrder(),
      sibling = await plainOrder()
    await prisma.order.updateMany({ where: { id: { in: [o.id, sibling.id] } }, data: { tableId: source.id } })
    await prisma.table.update({ where: { id: source.id }, data: { status: 'OCCUPIED', currentOrderId: o.id } })
    const i = operationInput({ action: 'moveOrder', refs: { orderId: o.id, targetTableId: target.id }, payload: {} })
    const r = await exactReplay(i, 'post', `/orders/${o.id}/move`, { targetTableId: target.id }, () =>
      prisma.order.update({ where: { id: o.id }, data: { customerName: 'later' } }),
    )
    expect(r.body).toEqual({ success: true, httpOperation: { ...i.operation, outcome: 'APPLIED' } })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
      status: 'OCCUPIED',
      currentOrderId: sibling.id,
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: o.id })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).tableId).toBe(target.id)
  })
  test('clear examines every open sibling rather than current pointer', async () => {
    const table = await emptyTable(),
      paid = await plainOrder(),
      unpaid = await plainOrder()
    await prisma.order.update({ where: { id: paid.id }, data: { tableId: table.id, paymentStatus: 'PAID' } })
    await prisma.order.update({ where: { id: unpaid.id }, data: { tableId: table.id } })
    await prisma.table.update({ where: { id: table.id }, data: { status: 'OCCUPIED', currentOrderId: paid.id } })
    const i = operationInput({ action: 'clearTable', refs: { tableId: table.id }, payload: {} })
    const r = await callHttp(i, 'post', `/tables/${table.id}/clear`)
    expect(r.status).toBe(400)
    expect(r.body.message).toContain(unpaid.orderNumber)
    expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).status).toBe('OCCUPIED')
    await prisma.order.update({ where: { id: unpaid.id }, data: { paymentStatus: 'PAID' } })
    const next = { ...i, operation: { ...i.operation, id: randomUUID() } }
    const applied = await exactReplay(next, 'post', `/tables/${table.id}/clear`, {}, () =>
      prisma.table.update({ where: { id: table.id }, data: { number: randomUUID() } }),
    )
    expect(applied.body).toEqual({ success: true, message: 'Mesa liberada', httpOperation: { ...next.operation, outcome: 'APPLIED' } })
  })
  test('merge returns exact identities and target original admission policy', async () => {
    const source = await plainOrder(),
      target = await plainOrder()
    const i = {
      ...operationInput({ action: 'mergeOrders', refs: { orderId: target.id, sourceOrderId: source.id }, payload: {} }),
      actorId: managerId,
    }
    const r = await exactReplay(i, 'post', `/orders/${target.id}/merge`, { sourceOrderId: source.id }, () =>
      prisma.order.update({ where: { id: target.id }, data: { customerName: 'later' } }),
    )
    expect(r.body.data).toEqual({
      target: { id: target.id, orderNumber: target.orderNumber, total: 200, version: 2 },
      merged: { id: source.id, orderNumber: source.orderNumber, items: 2 },
      tableFreed: false,
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('CANCELLED')
    expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(4)
  })
  test('cancel DELETE transports exact reason and leaves sibling occupied', async () => {
    const table = await emptyTable(),
      o = await plainOrder(),
      sibling = await plainOrder()
    await prisma.order.updateMany({ where: { id: { in: [o.id, sibling.id] } }, data: { tableId: table.id } })
    await prisma.table.update({ where: { id: table.id }, data: { status: 'OCCUPIED', currentOrderId: o.id } })
    const i = operationInput({ action: 'cancelOrder', refs: { orderId: o.id }, payload: { reason: '  keep spaces  ' } })
    const r = await exactReplay(i, 'delete', `/orders/${o.id}`, { reason: '  keep spaces  ' }, () =>
      prisma.order.update({ where: { id: o.id }, data: { customerName: 'later' } }),
    )
    expect(r.body).toEqual({
      success: true,
      message: 'Orden cancelada exitosamente',
      httpOperation: { ...i.operation, outcome: 'APPLIED' },
    })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      status: 'CANCELLED',
      specialRequests: 'Cancelled:   keep spaces  ',
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).toMatchObject({
      status: 'OCCUPIED',
      currentOrderId: sibling.id,
    })
  })
  test.each(['cancel', 'merge'] as const)('TPV %s legacy exact tableFreed normal, discordant and null', async action => {
    const controller = await import('@/controllers/tpv/order-table.tpv.controller')
    for (const shape of ['normal', 'discordant', 'null'] as const) {
      const own = await emptyTable(),
        pointer = shape === 'normal' ? own : await emptyTable()
      const source = await plainOrder(),
        target = await plainOrder()
      await prisma.order.update({ where: { id: source.id }, data: { tableId: shape === 'null' ? null : own.id } })
      await prisma.table.update({ where: { id: pointer.id }, data: { status: 'OCCUPIED', currentOrderId: source.id } })
      if (shape === 'discordant') {
        const sibling = await plainOrder()
        await prisma.order.update({ where: { id: sibling.id }, data: { tableId: own.id } })
        await prisma.table.update({ where: { id: own.id }, data: { status: 'OCCUPIED', currentOrderId: sibling.id } })
      }
      let status = 0,
        body: unknown
      const res = {
        status(n: number) {
          status = n
          return res
        },
        json(v: unknown) {
          body = v
          return res
        },
      }
      const req = {
        params: { venueId, orderId: action === 'cancel' ? source.id : target.id },
        body: action === 'cancel' ? { reason: '  exact  ' } : { sourceOrderId: source.id },
        authContext: { userId: authorId },
      }
      if (action === 'cancel') await controller.cancelOrder(req as unknown as Request, res as unknown as Response)
      else await controller.mergeOrders(req as unknown as Request, res as unknown as Response)
      expect(status).toBe(200)
      expect(body).toEqual({
        success: true,
        data:
          action === 'cancel'
            ? { tableFreed: shape === 'normal' }
            : {
                target: { id: target.id, orderNumber: target.orderNumber, total: 200, version: 2 },
                merged: { id: source.id, orderNumber: source.orderNumber, items: 2 },
                tableFreed: shape === 'normal',
              },
      })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: source.id } })).tableId).toBe(shape === 'null' ? null : own.id)
      expect(await prisma.table.findUniqueOrThrow({ where: { id: pointer.id } })).toMatchObject({
        status: 'AVAILABLE',
        currentOrderId: null,
      })
      if (shape === 'discordant') expect((await prisma.table.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('OCCUPIED')
      evidence(
        `Task8 TPV-${action}-baseline-${shape}`,
        operationInput({ action: 'cancelOrder', refs: { orderId: source.id }, payload: { reason: null } }),
        { status, body, shape },
      )
    }
  })
})

async function task8Pages<T extends { id: string }>(read: (cursor?: string) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await read(cursor)
    rows.push(...page)
    if (page.length < 100) return rows
    cursor = page[page.length - 1].id
  }
}
async function task8Snapshot(orderIds: string[], tableIds: string[], tx: PrismaTypes.TransactionClient | typeof prisma = prisma) {
  const page = (cursor?: string) => ({ orderBy: { id: 'asc' as const }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })
  const orders = await task8Pages(cursor => tx.order.findMany({ where: { id: { in: orderIds } }, ...page(cursor) }))
  const tables = await task8Pages(cursor => tx.table.findMany({ where: { id: { in: tableIds } }, ...page(cursor) }))
  const items = await task8Pages(cursor => tx.orderItem.findMany({ where: { orderId: { in: orderIds } }, ...page(cursor) }))
  const charges = await task8Pages(cursor => tx.orderServiceCharge.findMany({ where: { orderId: { in: orderIds } }, ...page(cursor) }))
  const promotions = await task8Pages(cursor => tx.orderPromotion.findMany({ where: { orderId: { in: orderIds } }, ...page(cursor) }))
  const kds = await task8Pages(cursor => tx.kdsOrder.findMany({ where: { venueId, orderId: { in: orderIds } }, ...page(cursor) }))
  const kdsItems = await task8Pages(cursor =>
    tx.kdsOrderItem.findMany({ where: { kdsOrder: { venueId, orderId: { in: orderIds } } }, ...page(cursor) }),
  )
  expect(kds.length).toBe(await tx.kdsOrder.count({ where: { venueId, orderId: { in: orderIds } } }))
  expect(kdsItems.length).toBe(await tx.kdsOrderItem.count({ where: { kdsOrder: { venueId, orderId: { in: orderIds } } } }))
  return { orders, tables, items, charges, promotions, kds, kdsItems }
}
// Round1 fixture only: actual persisted promotion/charges; no product policy change.
async function task8MergeRollbackSeed(sourceId: string, targetId: string, targetTableId: string) {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Task8 rollback', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId, categoryId: category.id, name: 'Task8 rollback component', sku: randomUUID(), price: 80, tags: [] },
  })
  const promotion = await prisma.promotion.create({
    data: {
      venueId,
      name: 'Task8 rollback bundle',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9900,
      daysOfWeek: [],
      status: 'PUBLISHED',
      groups: {
        create: [0, 1].map(displayOrder => ({
          name: `Task8 rollback group ${displayOrder}`,
          displayOrder,
          options: { create: { productId: product.id, quantity: 1, chargedQuantity: 1 } },
        })),
      },
    },
    include: { groups: { orderBy: { displayOrder: 'asc' }, include: { options: true } } },
  })
  const { applyPromotionToOrder } = await import('@/services/promotions/promotion.service')
  const sold = await applyPromotionToOrder({
    venueId,
    orderId: sourceId,
    promotionId: promotion.id,
    instanceId: randomUUID(),
    soldAt: new Date(),
    selections: promotion.groups.map(group => ({ groupId: group.id, optionId: group.options[0].id })),
  })
  expect(sold).toMatchObject({ created: true, netCents: 9900 })
  await prisma.order.update({ where: { id: sourceId }, data: { covers: 1 } })
  await prisma.order.update({ where: { id: targetId }, data: { covers: 2, tableId: targetTableId } })
  await prisma.table.update({ where: { id: targetTableId }, data: { currentOrderId: targetId, status: 'OCCUPIED' } })
  const survivorRule = await prisma.serviceCharge.create({
    data: { venueId, name: `Task8 survivor ${randomUUID()}`, type: 'PERCENTAGE', value: 5, taxable: false, autoApplyMinCovers: 1 },
  })
  const removedRule = await prisma.serviceCharge.create({
    data: { venueId, name: `Task8 obsolete ${randomUUID()}`, type: 'FIXED_AMOUNT', value: 11, taxable: false, autoApplyMinCovers: 2 },
  })
  const { syncAutomaticServiceCharges } = await import('@/services/mobile/service-charge.mobile.service')
  await syncAutomaticServiceCharges(venueId, sourceId)
  await syncAutomaticServiceCharges(venueId, targetId)
  // Persist the legitimate earlier 2-cover charge, then lower covers before the next sync.
  // Merge's existing automatic sync must remove this now-nonqualifying historical row.
  await prisma.order.update({ where: { id: targetId }, data: { covers: 1 } })
  // New qualifying rule arrives after the previous sync; merge must create its target row.
  const createdRule = await prisma.serviceCharge.create({
    data: {
      venueId,
      name: `Task8 newly qualifying ${randomUUID()}`,
      type: 'FIXED_AMOUNT',
      value: 7,
      taxable: false,
      autoApplyMinCovers: 1,
    },
  })
  return { promotionId: sold.orderPromotionId, survivorRule, removedRule, createdRule }
}

async function task8Kitchen(count: number) {
  const table = await emptyTable(),
    order = await plainOrder(),
    at = new Date(),
    round = randomUUID()
  const station =
    (await prisma.printStation.findFirst({ where: { venueId, name: 'Gate8 native authoring fixture', isDefault: true } })) ??
    (await prisma.printStation.create({
      data: {
        venueId,
        name: 'Gate8 native authoring fixture',
        active: true,
        isDefault: true,
        hasKitchenDisplay: true,
        kitchenDisplaySince: new Date(at.getTime() - 3_600_000),
      },
    }))
  const category = await prisma.menuCategory.create({ data: { venueId, name: randomUUID(), slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId, name: 'Gate8 kitchen', sku: randomUUID(), categoryId: category.id, price: 50, printStationId: station.id },
  })
  await prisma.order.update({
    where: { id: order.id },
    data: { tableId: table.id, subtotal: 100 + 50 * (count + 1), total: 100 + 50 * (count + 1), remainingBalance: 100 + 50 * (count + 1) },
  })
  await prisma.table.update({ where: { id: table.id }, data: { currentOrderId: order.id, status: 'OCCUPIED' } })
  await prisma.orderItem.createMany({
    data: Array.from({ length: count + 1 }, (_, n) => ({
      orderId: order.id,
      productId: product.id,
      productName: product.name,
      quantity: 1,
      unitPrice: 50,
      total: 50,
      taxAmount: 0,
      externalId: `sync:${round}-r${n}:0`,
      sentToKitchenAt: at,
      createdAt: at,
    })),
  })
  const { authorKitchenTickets, markKitchenTicket } = await import('@/services/kds/kitchenTicketAuthoring.service')
  const authored = await authorKitchenTickets({ venueId, orderId: order.id, trigger: 'ROUND' })
  expect(authored.ticketIds).toHaveLength(count + 1)
  await markKitchenTicket({
    venueId,
    sourceKey: `round:${round}-r${count}:${station.id}`,
    stationId: station.id,
    action: 'BUMP',
    label: 'Gate8 completed',
    at,
  })
  return { table, order }
}

describe('Task8 native guard controls and observed rollback TDD', () => {
  test.each(['cancel', 'merge'] as const)(
    'Task8 legacy %s retains PAID PARTIAL and live-terminal guards before extraction',
    async action => {
      for (const guard of ['PAID', 'PARTIAL', 'LIVE'] as const) {
        const source = await plainOrder(),
          target = await plainOrder()
        if (guard !== 'LIVE') await prisma.order.update({ where: { id: source.id }, data: { paymentStatus: guard } })
        else
          await prisma.terminalPaymentRequest.create({
            data: {
              venueId,
              orderId: source.id,
              requestId: randomUUID(),
              terminalId: randomUUID(),
              status: 'UNKNOWN',
              amountCents: 10_000,
              requestedById: authorId,
              expiresAt: new Date(Date.now() + 60_000),
            },
          })
        const before = await task8Snapshot([source.id, target.id], [])
        const client = request(httpApp),
          suffix = action === 'cancel' ? `/orders/${source.id}` : `/orders/${target.id}/merge`
        const response = await client[action === 'cancel' ? 'delete' : 'post'](`/api/v1/mobile/venues/${venueId}${suffix}`)
          .set('x-test-actor', managerId)
          .send(action === 'cancel' ? { reason: 'guard' } : { sourceOrderId: source.id })
        expect(response.status).toBe(guard === 'LIVE' ? 409 : 400)
        expect(await task8Snapshot([source.id, target.id], [])).toEqual(before)
        if (guard === 'LIVE') expect(response.body.code).toBe('ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE')
        evidence(
          `Task8 ${action}-legacy-${guard}`,
          operationInput({ action: 'cancelOrder', refs: { orderId: source.id }, payload: { reason: null } }),
          {
            status: response.status,
            body: response.body,
          },
        )
      }
    },
  )
  test('Task8 legacy merge target live-terminal G3 remains accepted', async () => {
    const source = await plainOrder(),
      target = await plainOrder()
    await prisma.terminalPaymentRequest.create({
      data: {
        venueId,
        orderId: target.id,
        requestId: randomUUID(),
        terminalId: randomUUID(),
        status: 'UNKNOWN',
        amountCents: 10_000,
        requestedById: authorId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const response = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}/orders/${target.id}/merge`)
      .set('x-test-actor', managerId)
      .send({ sourceOrderId: source.id })
    expect(response.status).toBe(200)
    expect(response.body.data.target).toEqual({ id: target.id, orderNumber: target.orderNumber, total: 200, version: 2 })
  })
  test.each(['shared', 'tpv'] as const)(
    'Task8 %s merge ordinary same-table sibling preserves its distinct legacy boolean',
    async boundary => {
      const table = await emptyTable(),
        source = await plainOrder(),
        target = await plainOrder()
      await prisma.order.updateMany({ where: { id: { in: [source.id, target.id] } }, data: { tableId: table.id } })
      await prisma.table.update({ where: { id: table.id }, data: { currentOrderId: source.id, status: 'OCCUPIED' } })
      let data: unknown
      if (boundary === 'shared')
        data = await (await import('@/services/mobile/order.mobile.service')).mergeOrders(venueId, target.id, source.id, authorId)
      else {
        let status = 0
        const res = {
          status(n: number) {
            status = n
            return res
          },
          json(body: { data: unknown }) {
            data = body.data
            return res
          },
        }
        await (
          await import('@/controllers/tpv/order-table.tpv.controller')
        ).mergeOrders(
          {
            params: { venueId, orderId: target.id },
            body: { sourceOrderId: source.id },
            authContext: { userId: authorId },
          } as unknown as Request,
          res as unknown as Response,
        )
        expect(status).toBe(200)
      }
      expect(data).toEqual({
        target: { id: target.id, orderNumber: target.orderNumber, total: 200, version: 2 },
        merged: { id: source.id, orderNumber: source.orderNumber, items: 2 },
        tableFreed: boundary === 'shared',
      })
      expect(await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).toMatchObject({
        status: 'OCCUPIED',
        currentOrderId: target.id,
      })
    },
  )
  test.each(['missingVenue', 'missingTable', 'foreignTable'] as const)(
    'Task8 clear public wrapper retains legacy404 Table message for %s',
    async scenario => {
      const table = await emptyTable()
      const missingVenueId = `gate-a-absent-${randomUUID()}`
      const foreignVenueId = `gate-a-foreign-${randomUUID()}`
      if (scenario === 'foreignTable') {
        await prisma.venue.create({ data: { id: foreignVenueId, organizationId: venueId, name: 'Task8 foreign', slug: foreignVenueId } })
      }
      const { clearTable } = await import('@/services/tpv/table.tpv.service')
      await expect(
        clearTable(
          scenario === 'missingVenue' ? missingVenueId : scenario === 'foreignTable' ? foreignVenueId : venueId,
          scenario === 'missingTable' ? randomUUID() : table.id,
          authorId,
        ),
      ).rejects.toMatchObject({ statusCode: 404, message: 'Table not found or does not belong to this venue' })
      expect(await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).toEqual(table)
    },
  )
  test.each(['moveOrder', 'clearTable', 'mergeOrders', 'cancelOrder'] as const)(
    'Task8 %s observes full real domain change before ACK23514 then restores every scalar row',
    async action => {
      const sourceTable = await emptyTable(),
        targetTable = await emptyTable(),
        source = await plainOrder(),
        target = await plainOrder(),
        sibling = await plainOrder()
      await prisma.order.updateMany({
        where: { id: { in: [source.id, sibling.id] } },
        data: { tableId: sourceTable.id, ...(action === 'clearTable' ? { paymentStatus: 'PAID' } : {}) },
      })
      await prisma.table.update({ where: { id: sourceTable.id }, data: { currentOrderId: source.id, status: 'OCCUPIED' } })
      const mergeFixture = action === 'mergeOrders' ? await task8MergeRollbackSeed(source.id, target.id, targetTable.id) : null
      const i = operationInput<'clearTable' | 'moveOrder' | 'mergeOrders' | 'cancelOrder'>(
        action === 'clearTable'
          ? { action, refs: { tableId: sourceTable.id }, payload: {} }
          : action === 'moveOrder'
            ? { action, refs: { orderId: source.id, targetTableId: targetTable.id }, payload: {} }
            : action === 'mergeOrders'
              ? { action, refs: { orderId: target.id, sourceOrderId: source.id }, payload: {} }
              : { action, refs: { orderId: source.id }, payload: { reason: '  exact  ' } },
      )
      const snapshot = (tx?: PrismaTypes.TransactionClient) =>
        task8Snapshot([source.id, target.id, sibling.id], [sourceTable.id, targetTable.id], tx)
      const before = await snapshot(prisma)
      let capturedRefs: HttpEnvelope['affectedRefs'] = []
      try {
        await assertReceiptRollback(
          i,
          async tx => {
            const mobile = await import('@/services/mobile/order.mobile.service'),
              tables = await import('@/services/tpv/table.tpv.service')
            if (action === 'moveOrder') {
              const r = await tables.moveOrderToTableInTransaction(tx, venueId, source.id, targetTable.id)
              capturedRefs = r.affectedRefs
              return { response: { status: 200, body: { success: true } }, affectedRefs: r.affectedRefs }
            }
            if (action === 'clearTable') {
              const r = await tables.clearTableInTransaction(tx, venueId, sourceTable.id)
              capturedRefs = r.affectedRefs
              return { response: { status: 200, body: { success: true, message: 'Mesa liberada' } }, affectedRefs: r.affectedRefs }
            }
            if (action === 'mergeOrders') {
              const r = await mobile.mergeOrdersInTransaction(tx, venueId, target.id, source.id, authorId)
              capturedRefs = r.affectedRefs
              return { response: { status: 200, body: { success: true, data: r.data } }, affectedRefs: r.affectedRefs }
            }
            const r = await mobile.cancelOrderInTransaction(tx, venueId, source.id, '  exact  ', authorId)
            return {
              response: { status: 200, body: { success: true, message: 'Orden cancelada exitosamente' } },
              affectedRefs: r.affectedRefs,
            }
          },
          snapshot,
          async tx => {
            const after = await snapshot(tx)
            const beforeSource = before.orders.find(row => row.id === source.id)!,
              afterSource = after.orders.find(row => row.id === source.id)!,
              beforeTarget = before.orders.find(row => row.id === target.id)!,
              afterTarget = after.orders.find(row => row.id === target.id)!
            const afterSourceTable = after.tables.find(row => row.id === sourceTable.id)!,
              afterTargetTable = after.tables.find(row => row.id === targetTable.id)!
            const refKeys = (refs: HttpEnvelope['affectedRefs']) => refs.map(ref => `${ref.kind}:${ref.id}`).sort()
            if (action === 'moveOrder') {
              expect(afterSource).toEqual({ ...beforeSource, tableId: targetTable.id, updatedAt: afterSource.updatedAt })
              expect(afterSourceTable).toMatchObject({ status: 'OCCUPIED', currentOrderId: sibling.id })
              expect(afterTargetTable).toMatchObject({ status: 'OCCUPIED', currentOrderId: source.id })
              expect(after.orders.filter(row => row.id !== source.id)).toEqual(before.orders.filter(row => row.id !== source.id))
              expect(after.items).toEqual(before.items)
              expect(after.promotions).toEqual(before.promotions)
              expect(after.charges).toEqual(before.charges)
              expect(refKeys(capturedRefs)).toEqual(
                refKeys([
                  { kind: 'Order', id: source.id },
                  { kind: 'Table', id: sourceTable.id },
                  { kind: 'Table', id: targetTable.id },
                ]),
              )
            } else if (action === 'clearTable') {
              expect(afterSourceTable).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
              expect(afterTargetTable).toEqual(before.tables.find(row => row.id === targetTable.id))
              expect(after.orders).toEqual(before.orders)
              expect(after.items).toEqual(before.items)
              expect(after.promotions).toEqual(before.promotions)
              expect(after.charges).toEqual(before.charges)
              expect(refKeys(capturedRefs)).toEqual(
                refKeys([
                  { kind: 'Table', id: sourceTable.id },
                  { kind: 'Order', id: source.id },
                  { kind: 'Order', id: sibling.id },
                ]),
              )
            } else if (action === 'mergeOrders') {
              if (!mergeFixture) throw new Error('Missing populated merge rollback fixture')
              const sourceItems = before.items.filter(row => row.orderId === source.id)
              const sourceCharges = before.charges.filter(row => row.orderId === source.id)
              const targetCharges = before.charges.filter(row => row.orderId === target.id)
              const obsolete = targetCharges.find(row => row.serviceChargeId === mergeFixture.removedRule.id)!
              const surviving = targetCharges.filter(row => row.id !== obsolete.id)
              const newCharge = after.charges.find(row => row.serviceChargeId === mergeFixture.createdRule.id)!
              expect(sourceItems.filter(row => row.orderPromotionId === mergeFixture.promotionId)).toHaveLength(2)
              expect(sourceCharges.length).toBeGreaterThan(0)
              expect(sourceCharges.every(row => row.isAutomatic)).toBe(true)
              expect(targetCharges.every(row => row.isAutomatic)).toBe(true)
              expect(before.promotions).toHaveLength(1)
              expect(before.promotions[0]).toMatchObject({ id: mergeFixture.promotionId, orderId: source.id, netCents: 9900 })
              expect(Number(beforeSource.subtotal)).toBe(199)
              expect(Number(beforeTarget.subtotal)).toBe(100)
              expect(Number(sourceCharges.find(row => row.serviceChargeId === mergeFixture.survivorRule.id)!.amount)).toBe(9.95)
              expect(Number(targetCharges.find(row => row.serviceChargeId === mergeFixture.survivorRule.id)!.amount)).toBe(5)
              expect(Number(obsolete.amount)).toBe(11)
              expect(before.charges.some(row => row.serviceChargeId === mergeFixture.createdRule.id)).toBe(false)
              const expectedSurvivors = surviving.map(row => ({
                ...row,
                amount: row.type === 'PERCENTAGE' ? new Prisma.Decimal(Math.round(299 * Number(row.value)) / 100) : row.amount,
              }))
              const expectedChargeAmount = expectedSurvivors.reduce((sum, row) => sum + Number(row.amount), 7)
              expect(afterSource).toEqual({
                ...beforeSource,
                status: 'CANCELLED',
                specialRequests: `Fusionada en ${target.orderNumber}`,
                subtotal: new Prisma.Decimal(0),
                discountAmount: new Prisma.Decimal(0),
                serviceChargeAmount: new Prisma.Decimal(0),
                taxAmount: new Prisma.Decimal(0),
                total: new Prisma.Decimal(0),
                version: beforeSource.version + 1,
                updatedAt: afterSource.updatedAt,
              })
              expect(afterTarget).toEqual({
                ...beforeTarget,
                subtotal: new Prisma.Decimal(299),
                discountAmount: new Prisma.Decimal(0),
                serviceChargeAmount: new Prisma.Decimal(expectedChargeAmount),
                total: new Prisma.Decimal(299 + expectedChargeAmount),
                remainingBalance: new Prisma.Decimal(299 + expectedChargeAmount),
                version: beforeTarget.version + 2,
                updatedAt: afterTarget.updatedAt,
              })
              expect(after.items).toEqual(
                before.items.map(row =>
                  row.orderId === source.id
                    ? {
                        ...row,
                        orderId: target.id,
                        updatedAt: after.items.find(current => current.id === row.id)!.updatedAt,
                      }
                    : row,
                ),
              )
              for (const row of sourceItems) {
                expect(after.items.find(current => current.id === row.id)!.updatedAt.getTime()).toBeGreaterThanOrEqual(
                  row.updatedAt.getTime(),
                )
              }
              // Baseline algorithm retains the historical parent; item associations move, snapshots do not.
              expect(after.promotions).toEqual(before.promotions)
              expect(after.charges.filter(row => row.id !== newCharge.id)).toEqual(
                expectedSurvivors.sort((a, b) => a.id.localeCompare(b.id)),
              )
              expect(newCharge).toMatchObject({
                orderId: target.id,
                serviceChargeId: mergeFixture.createdRule.id,
                name: mergeFixture.createdRule.name,
                type: 'FIXED_AMOUNT',
                value: new Prisma.Decimal(7),
                amount: new Prisma.Decimal(7),
                taxable: false,
                isAutomatic: true,
                appliedById: null,
              })
              expect(after.charges.some(row => row.orderId === source.id || row.id === obsolete.id)).toBe(false)
              expect(after.charges.find(row => row.serviceChargeId === mergeFixture.survivorRule.id)!.amount).toEqual(
                new Prisma.Decimal(14.95),
              )
              expect(afterSourceTable).toMatchObject({ status: 'OCCUPIED', currentOrderId: sibling.id })
              expect(afterTargetTable).toEqual(before.tables.find(row => row.id === targetTable.id))
              expect(after.orders.find(row => row.id === sibling.id)).toEqual(before.orders.find(row => row.id === sibling.id))
              const changedTargetIds = expectedSurvivors
                .filter(row => !row.amount.equals(targetCharges.find(old => old.id === row.id)!.amount))
                .map(row => row.id)
              expect(refKeys(capturedRefs)).toEqual(
                refKeys([
                  { kind: 'Order', id: source.id },
                  { kind: 'Order', id: target.id },
                  ...sourceItems.map<HttpEnvelope['affectedRefs'][number]>(row => ({ kind: 'OrderItem', id: row.id })),
                  { kind: 'OrderPromotion', id: mergeFixture.promotionId },
                  ...[...sourceCharges.map(row => row.id), obsolete.id, newCharge.id, ...changedTargetIds].map(id => ({
                    kind: 'OrderServiceCharge' as const,
                    id,
                  })),
                  { kind: 'Table', id: sourceTable.id },
                ]),
              )
            }
            expect(after.kds).toEqual(before.kds)
            expect(after.kdsItems).toEqual(before.kdsItems)
          },
        )
      } finally {
        if (mergeFixture) {
          await prisma.serviceCharge.updateMany({
            where: { id: { in: [mergeFixture.survivorRule.id, mergeFixture.removedRule.id, mergeFixture.createdRule.id] }, venueId },
            data: { active: false },
          })
        }
      }
    },
  )
  test.each([101, 501, 1001])(
    'Task8 cancel captures every %i pending KDS header/item before delete, retains COMPLETED and rolls back all rows after ACK23514',
    async count => {
      const f = await task8Kitchen(count),
        i = operationInput({ action: 'cancelOrder', refs: { orderId: f.order.id }, payload: { reason: '  keep spaces  ' } })
      const before = await task8Snapshot([f.order.id], [f.table.id])
      const pending = before.kds.filter(row => row.status !== 'COMPLETED'),
        completed = before.kds.filter(row => row.status === 'COMPLETED')
      const pendingIds = pending.map(row => row.id).sort(),
        pendingItems = before.kdsItems
          .filter(row => pendingIds.includes(row.kdsOrderId))
          .map(row => row.id)
          .sort()
      expect(pending).toHaveLength(count)
      expect(pendingItems).toHaveLength(count)
      expect(completed).toHaveLength(1)
      const snapshot = (tx?: PrismaTypes.TransactionClient) => task8Snapshot([f.order.id], [f.table.id], tx)
      await assertReceiptRollback(
        i,
        async tx => {
          const r = await (
            await import('@/services/mobile/order.mobile.service')
          ).cancelOrderInTransaction(tx, venueId, f.order.id, '  keep spaces  ', authorId)
          expect(
            r.affectedRefs
              .filter(x => x.kind === 'KdsOrder')
              .map(x => x.id)
              .sort(),
          ).toEqual(pendingIds)
          expect(
            r.affectedRefs
              .filter(x => x.kind === 'KdsOrderItem')
              .map(x => x.id)
              .sort(),
          ).toEqual(pendingItems)
          return {
            response: { status: 200, body: { success: true, message: 'Orden cancelada exitosamente' } },
            affectedRefs: r.affectedRefs,
          }
        },
        snapshot,
        async tx => {
          const inside = await snapshot(tx)
          expect(inside.kds).toEqual(completed)
          expect(inside.kdsItems).toEqual(before.kdsItems.filter(row => row.kdsOrderId === completed[0].id))
          expect(inside.items).toEqual(before.items)
          expect(inside.orders[0]).toMatchObject({ status: 'CANCELLED', specialRequests: 'Cancelled:   keep spaces  ' })
          expect(inside.tables[0]).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
        },
      )
    },
    120_000,
  )
})

function task8Deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
async function task8Eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 3000
  while (Date.now() < end) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(r => setTimeout(r, 15))
  }
  throw new Error('INCONCLUSO: required native lock observation absent')
}
async function task8ObserveWait(key: number) {
  return task8Eventually(
    async () =>
      (
        await prisma.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=${key}::oid AND NOT granted`
      )[0]?.pid,
  )
}
async function task8ObserveBlockedBy(pid: number) {
  return task8Eventually(
    async () =>
      (
        await prisma.$queryRaw<
          Array<{ pid: number; blockers: number[]; query: string }>
        >`SELECT pid,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`
      )[0],
  )
}
async function task8NativeGate(
  relation: 'Order' | 'Table' | 'Payment' | 'TerminalPaymentRequest' | 'KdsOrder',
  timing: 'BEFORE INSERT' | 'AFTER UPDATE' | 'BEFORE INSERT OR UPDATE',
  condition: string,
) {
  const suffix = randomUUID().replace(/-/g, '')
  const fn = `g8_fn_${suffix}`
  const trigger = `g8_tr_${suffix}`
  const key = randomInt(1, 2_000_000_000)
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const ready = task8Deferred()
  const release = task8Deferred()
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $b$`,
  )
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" ${timing} ON "${relation}" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`)
  const hold = holder.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`
      ready.resolve()
      await release.promise
    },
    { timeout: 30_000 },
  )
  await Promise.race([
    ready.promise,
    hold.then(() => {
      throw new Error('INCONCLUSO: gate holder ended')
    }),
  ])
  return {
    key,
    release: release.resolve,
    async cleanup(pending: Promise<unknown>[]) {
      release.resolve()
      await Promise.allSettled([hold, ...pending])
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${relation}"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${fn}"()`)
      await holder.$disconnect()
    },
  }
}

async function task8Bind(orderId: string, tableId: string, paymentStatus: 'PENDING' | 'PAID' = 'PENDING') {
  await prisma.order.update({ where: { id: orderId }, data: { tableId, paymentStatus } })
  await prisma.table.update({ where: { id: tableId }, data: { status: 'OCCUPIED', currentOrderId: orderId } })
}
async function task8WaiterGraph(holderPid: number, expected: number) {
  return task8Eventually(async () => {
    const rows = await prisma.$queryRaw<Array<{ pid: number; blockers: number[]; query: string }>>`
      WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
      ) SELECT a.pid,pg_blocking_pids(a.pid) blockers,a.query FROM pg_stat_activity a JOIN blocked b ON b.pid=a.pid
      WHERE a.datname=current_database() AND a.wait_event_type='Lock'`
    return rows.length >= expected ? rows : undefined
  })
}
async function task8HoldOrders(ids: string[]) {
  const holder = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
  const ready = task8Deferred(),
    release = task8Deferred()
  let pid = 0
  const hold = holder.$transaction(
    async tx => {
      pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int pid`)[0].pid
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "venueId"=${venueId} AND id=ANY(${ids}::text[]) ORDER BY id FOR UPDATE`
      ready.resolve()
      await release.promise
    },
    { timeout: 30000 },
  )
  await ready.promise
  return {
    pid,
    release: release.resolve,
    async cleanup(pending: Promise<unknown>[]) {
      release.resolve()
      await Promise.allSettled([hold, ...pending])
      await holder.$disconnect()
    },
  }
}
test('Task8 opposing occupied moves: both integrated HTTP bodies wait on scoped Orders, then reject without changing siblings', async () => {
  const a = await plainOrder(),
    b = await plainOrder(),
    x = await emptyTable(),
    y = await emptyTable()
  await task8Bind(a.id, x.id)
  await task8Bind(b.id, y.id)
  const before = await task8Snapshot([a.id, b.id], [x.id, y.id]),
    gate = await task8HoldOrders([a.id, b.id]),
    pending: Promise<unknown>[] = []
  const i = operationInput({ action: 'moveOrder', refs: { orderId: a.id, targetTableId: y.id }, payload: {} })
  try {
    const first = callHttp(i, 'post', `/orders/${a.id}/move`, { targetTableId: y.id })
    pending.push(first)
    await task8ObserveBlockedBy(gate.pid)
    const j = operationInput({ action: 'moveOrder', refs: { orderId: b.id, targetTableId: x.id }, payload: {} })
    const second = callHttp(j, 'post', `/orders/${b.id}/move`, { targetTableId: x.id })
    pending.push(second)
    const waits = await task8WaiterGraph(gate.pid, 2)
    expect(waits.filter(w => w.query.includes('FROM "Order"')).length).toBe(2)
    evidence('Task8-opposing-moves-native', i, { holderPid: gate.pid, waits })
    gate.release()
    for (const r of await Promise.all([first, second])) {
      expect(r.status).toBe(400)
      expect(r.body.httpOperation.outcome).toBe('REJECTED')
    }
    expect(await task8Snapshot([a.id, b.id], [x.id, y.id])).toEqual(before)
  } finally {
    await gate.cleanup(pending)
  }
})
test('Task8 two integrated moves to one target serialize the real Table claim and preserve every item', async () => {
  const a = await plainOrder(),
    b = await plainOrder(),
    x = await emptyTable(),
    y = await emptyTable(),
    target = await emptyTable()
  await task8Bind(a.id, x.id)
  await task8Bind(b.id, y.id)
  const items = [...a.items, ...b.items].map(r => r.id).sort()
  const gate = await task8NativeGate('Table', 'AFTER UPDATE', `NEW.id='${target.id}' AND NEW."currentOrderId"='${a.id}'`),
    pending: Promise<unknown>[] = []
  const i = operationInput({ action: 'moveOrder', refs: { orderId: a.id, targetTableId: target.id }, payload: {} })
  try {
    const first = callHttp(i, 'post', `/orders/${a.id}/move`, { targetTableId: target.id })
    pending.push(first)
    const firstPid = await task8ObserveWait(gate.key)
    const j = operationInput({ action: 'moveOrder', refs: { orderId: b.id, targetTableId: target.id }, payload: {} })
    const second = callHttp(j, 'post', `/orders/${b.id}/move`, { targetTableId: target.id })
    pending.push(second)
    const waiter = await task8ObserveBlockedBy(firstPid)
    expect(waiter.query).toContain('FROM "Table"')
    evidence('Task8-two-moves-one-target-native', i, { firstPid, waiter })
    gate.release()
    expect((await first).status).toBe(200)
    const initial = await second
    expect(initial.status).toBe(503)
    expect(initial.body.code).toBe('OPERATION_OUTCOME_PENDING')
    expect(await stored(j)).toBeNull()
    const retry = await callHttp(j, 'post', `/orders/${b.id}/move`, { targetTableId: target.id })
    expect(retry.status).toBe(400)
    expect(retry.body.httpOperation.outcome).toBe('REJECTED')
    expect(await prisma.table.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: a.id })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: y.id } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: b.id })
    expect(
      (
        await task8Pages(cursor =>
          prisma.orderItem.findMany({
            where: { orderId: { in: [a.id, b.id] } },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          }),
        )
      )
        .map(r => r.id)
        .sort(),
    ).toEqual(items)
  } finally {
    await gate.cleanup(pending)
  }
})

async function task8Reservation(tableId: string) {
  const category = await prisma.menuCategory.create({ data: { venueId, name: 'Task8 reservation', slug: randomUUID() } })
  const product = await prisma.product.create({
    data: { venueId, categoryId: category.id, sku: randomUUID(), name: 'Task8 service', price: 100, type: 'SERVICE' },
  })
  return prisma.reservation.create({
    data: {
      venueId,
      tableId,
      productId: product.id,
      confirmationCode: randomUUID(),
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600000),
      blockedEndsAt: new Date(Date.now() + 3600000),
      duration: 60,
      status: 'CONFIRMED',
      guestName: 'Task8',
    },
  })
}
async function task8OpenShift() {
  return (
    (await prisma.shift.findFirst({ where: { venueId, status: 'OPEN' }, orderBy: { id: 'asc' } })) ??
    (await prisma.shift.create({
      data: { venueId, staffId: authorId, startTime: new Date(), status: 'OPEN', externalId: `g8-${randomUUID()}` },
    }))
  )
}
test.each(['assign', 'free-cart', 'simple-tpv', 'mobile', 'reservation', 'check-in', 'pos', 'reopen', 'move'] as const)(
  'Task8 clear versus real %s body: native Order wait precedes Table claim and retry preserves all members',
  async creator => {
    await prisma.venue.update({ where: { id: venueId }, data: { salesEnabled: true } })
    const table = await emptyTable(),
      paid = await plainOrder()
    await task8Bind(paid.id, table.id, 'PAID')
    if (creator === 'reopen') await prisma.order.update({ where: { id: paid.id }, data: { status: 'COMPLETED', paymentStatus: 'PENDING' } })
    const reservation = creator === 'reservation' || creator === 'check-in' ? await task8Reservation(table.id) : null
    const shift = await task8OpenShift()
    if (creator !== 'reopen') {
      await prisma.order.update({ where: { id: paid.id }, data: { paidAmount: 100, remainingBalance: 0 } })
      await prisma.payment.create({
        data: {
          venueId,
          orderId: paid.id,
          shiftId: shift.id,
          processedById: authorId,
          amount: 100,
          tipAmount: 0,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 100,
          method: 'CASH',
          source: 'APP',
          status: 'COMPLETED',
          type: 'REGULAR',
        },
      })
    }
    await prisma.kdsOrder.create({
      data: {
        venueId,
        orderId: paid.id,
        orderNumber: paid.orderNumber,
        status: 'COMPLETED',
        completedAt: new Date(),
        items: { create: { orderItemId: paid.items[0].id, productName: paid.items[0].productName!, quantity: 1 } },
      },
    })
    const sourceBefore = await task8Snapshot([paid.id], [])
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: paid.id }, orderBy: { id: 'asc' }, take: 100 })
    const staffKey = `g8-${randomUUID()}`
    if (creator === 'pos')
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { posStaffId: staffKey } })
    const moved = creator === 'move' ? await plainOrder() : null
    const externalId = randomUUID(),
      orderNumber = randomUUID()
    const run = async () => {
      switch (creator) {
        case 'assign':
          return (await import('@/services/tpv/table.tpv.service')).assignTable(venueId, table.id, authorId, 2)
        case 'free-cart':
          return (await import('@/services/tpv/order.tpv.service')).createOrderWithItems(venueId, {
            staffId: authorId,
            tableId: table.id,
            externalId,
            source: 'TPV',
            orderType: 'DINE_IN',
            items: [{ name: 'Task8 zero', quantity: 1, unitPrice: 0 }],
            subtotal: 0,
            total: 0,
            taxAmount: 0,
            tip: 0,
            discount: 0,
          })
        case 'simple-tpv':
          return (await import('@/services/tpv/order.tpv.service')).createOrder(venueId, { tableId: table.id, waiterId: authorId })
        case 'mobile':
          return (await import('@/services/mobile/order.mobile.service')).createOrderWithItems(venueId, {
            tableId: table.id,
            staffId: authorId,
            externalId,
            items: [{ name: 'Task8 mobile', unitPrice: 10000, quantity: 1 }],
          })
        case 'reservation':
          return prisma.$transaction(tx =>
            (
              require('@/services/reservation/createOrderFromReservation') as typeof import('@/services/reservation/createOrderFromReservation')
            ).createOrderFromReservation(tx, { venueId, reservationId: reservation!.id, createdByStaffId: authorId }),
          )
        case 'check-in':
          return (await import('@/services/reservation/checkIn.service')).checkInReservationAndOpenOrder({
            venueId,
            reservationId: reservation!.id,
            actor: { type: 'HUMAN', staffId: authorId },
            source: 'POS_IOS',
            now: new Date(),
          })
        case 'pos':
          return (await import('@/services/pos-sync/posSyncOrder.service')).processPosOrderEvent({
            venueId,
            orderData: {
              externalId: `gate8:1:${externalId}`,
              orderNumber,
              status: 'PENDING',
              paymentStatus: 'PENDING',
              subtotal: 100,
              total: 100,
              taxAmount: 0,
              discountAmount: 0,
              tipAmount: 0,
              createdAt: new Date().toISOString(),
              completedAt: null,
              posRawData: { test: 'gate8' },
            },
            staffData: { externalId: staffKey, name: 'Task8', pin: null },
            tableData: { externalId: table.number },
            shiftData: { externalId: shift.externalId!, startTime: null },
            payments: [],
            paymentMethodsCatalog: [],
          })
        case 'reopen':
          return (await import('@/services/dashboard/order.dashboard.service')).updateOrder(venueId, paid.id, { status: 'PENDING' })
        case 'move':
          return (await import('@/services/tpv/table.tpv.service')).moveOrderToTable(venueId, moved!.id, table.id)
      }
    }
    const gate = await task8NativeGate(
        'Table',
        'AFTER UPDATE',
        `NEW.id='${table.id}' AND NEW.status='AVAILABLE' AND OLD.status='OCCUPIED'`,
      ),
      pending: Promise<unknown>[] = []
    const input = operationInput({ action: 'clearTable', refs: { tableId: table.id }, payload: {} })
    try {
      const clear = callHttp(input, 'post', `/tables/${table.id}/clear`)
      pending.push(clear)
      const clearPid = await task8ObserveWait(gate.key)
      const created = run()
      pending.push(created)
      void created.catch(() => undefined)
      const waiter = await task8ObserveBlockedBy(clearPid)
      expect(waiter.query).toContain('FROM "Order"')
      evidence(`Task8-clear-${creator}-native`, input, { clearPid, waiter, sourceId: paid.id })
      gate.release()
      expect((await clear).status).toBe(200)
      const result = await created.then(
        value => ({ value }),
        error => ({ error }),
      )
      if ('error' in result) {
        expect(String(result.error)).toContain('ORDER_TABLE_TOPOLOGY_CHANGED')
        await run()
      }
      const all = await task8Pages(cursor =>
        prisma.order.findMany({
          where: { venueId, tableId: table.id },
          orderBy: { id: 'asc' },
          take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      )
      expect(all.some(row => row.id === paid.id)).toBe(creator !== 'assign')
      expect(all.length).toBe(creator === 'reopen' || creator === 'assign' ? 1 : 2)
      const sourceAfter = await task8Snapshot([paid.id], [])
      const { updatedAt: beforeUpdated, tableId: beforeTable, status: beforeStatus, ...beforeFields } = sourceBefore.orders[0]
      const { updatedAt: afterUpdated, tableId: afterTable, status: afterStatus, ...afterFields } = sourceAfter.orders[0]
      expect(afterTable).toBe(creator === 'assign' ? null : table.id)
      expect(afterStatus).toBe(creator === 'reopen' ? 'PENDING' : beforeStatus)
      expect(afterFields).toEqual(beforeFields)
      expect(sourceAfter.items).toEqual(sourceBefore.items)
      expect(sourceAfter.kds).toEqual(sourceBefore.kds)
      expect(sourceAfter.kdsItems).toEqual(sourceBefore.kdsItems)
      expect(await prisma.payment.findMany({ where: { orderId: paid.id }, orderBy: { id: 'asc' }, take: 100 })).toEqual(paymentsBefore)
      expect(await prisma.orderItem.count({ where: { orderId: paid.id } })).toBe(2)
      const unpaid = all.filter(row => !['COMPLETED', 'CANCELLED', 'DELETED'].includes(row.status) && row.paymentStatus !== 'PAID')
      const next = operationInput({ action: 'clearTable', refs: { tableId: table.id }, payload: {} })
      const checked = await callHttp(next, 'post', `/tables/${table.id}/clear`)
      expect(checked.status).toBe(unpaid.length ? 400 : 200)
      if (unpaid.length) expect(checked.body.message).toContain(unpaid[0].orderNumber)
      evidence(`Task8-clear-${creator}-final`, input, {
        orderIds: all.map(row => row.id),
        unpaidIds: unpaid.map(row => row.id),
        checkedStatus: checked.status,
        table: await prisma.table.findUniqueOrThrow({ where: { id: table.id } }),
      })
    } finally {
      await gate.cleanup(pending)
    }
  },
)

test.each(['author', 'void', 'dashboard-delete'] as const)(
  'Task8 cancel versus real %s: observed kitchen advisory serializes KDS and preserves completed tickets',
  async rival => {
    const f = await task8Kitchen(1),
      i = operationInput({ action: 'cancelOrder', refs: { orderId: f.order.id }, payload: { reason: 'native race' } })
    const completed = await prisma.kdsOrder.findFirstOrThrow({ where: { venueId, orderId: f.order.id, status: 'COMPLETED' } })
    const completedItems = await task8Pages(cursor =>
      prisma.kdsOrderItem.findMany({
        where: { kdsOrderId: completed.id },
        orderBy: { id: 'asc' },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    )
    const gate = await task8NativeGate(
        'Order',
        'AFTER UPDATE',
        `NEW.id='${f.order.id}' AND NEW.status='CANCELLED' AND OLD.status<>'CANCELLED'`,
      ),
      pending: Promise<unknown>[] = []
    try {
      const cancellation = callHttp(i, 'delete', `/orders/${f.order.id}`, { reason: 'native race' })
      pending.push(cancellation)
      const cancelPid = await task8ObserveWait(gate.key)
      const other =
        rival === 'author'
          ? (await import('@/services/kds/kitchenTicketAuthoring.service')).authorKitchenTickets({
              venueId,
              orderId: f.order.id,
              trigger: 'ROUND',
            })
          : rival === 'void'
            ? (await import('@/services/tpv/order.tpv.service')).voidItems(venueId, f.order.id, {
                itemIds: [f.order.items[0].id],
                reason: 'native isolated un-routed item',
                staffId: authorId,
                expectedVersion: 1,
              })
            : (await import('@/services/dashboard/order.dashboard.service')).deleteOrder(venueId, f.order.id)
      pending.push(other)
      void other.catch(() => undefined)
      const waiter = await task8ObserveBlockedBy(cancelPid)
      expect(waiter.query).toContain('pg_advisory_xact_lock')
      evidence(`Task8-cancel-${rival}-native`, i, { cancelPid, waiter })
      gate.release()
      expect((await cancellation).status).toBe(200)
      const receipt = (await stored(i))!.resultJson
      const result = await other
      if (rival === 'author') expect((result as { ticketIds: string[] }).ticketIds).toEqual([])
      expect(await prisma.kdsOrder.count({ where: { venueId, orderId: f.order.id, status: { not: 'COMPLETED' } } })).toBe(0)
      expect(await prisma.kdsOrder.findUniqueOrThrow({ where: { id: completed.id } })).toEqual(completed)
      expect(
        await task8Pages(cursor =>
          prisma.kdsOrderItem.findMany({
            where: { kdsOrderId: completed.id },
            orderBy: { id: 'asc' },
            take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          }),
        ),
      ).toEqual(completedItems)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status).toBe('CANCELLED')
      expect(terminal(await resolveHttpOperation(i))).toEqual(receipt)
    } finally {
      await gate.cleanup(pending)
    }
  },
)

test.each(['cancelOrder', 'mergeOrders'] as const)(
  'Task8 real cash admission versus %s: money commits under native wait and source cancellation rejects',
  async action => {
    const source = await plainOrder(),
      target = action === 'mergeOrders' ? await plainOrder() : null
    const shift = await task8OpenShift()
    await prisma.order.update({ where: { id: source.id }, data: { shiftId: shift.id } })
    const i = operationInput<'cancelOrder' | 'mergeOrders'>(
      action === 'cancelOrder'
        ? { action, refs: { orderId: source.id }, payload: { reason: null } }
        : { action, refs: { orderId: target!.id, sourceOrderId: source.id }, payload: {} },
    )
    if (action === 'mergeOrders') i.actorId = managerId
    const gate = await task8NativeGate(
        'Order',
        'AFTER UPDATE',
        `NEW.id='${source.id}' AND NEW.version=OLD.version+1 AND NEW."paidAmount">OLD."paidAmount"`,
      ),
      pending: Promise<unknown>[] = []
    try {
      const cash = (await import('@/services/mobile/order.mobile.service')).payCashOrder(venueId, source.id, {
        amount: 10000,
        tip: 0,
        staffId: authorId,
        method: 'CASH',
        idempotencyKey: randomUUID(),
      })
      pending.push(cash)
      void cash.catch(() => undefined)
      const cashPid = await task8ObserveWait(gate.key)
      const rejected =
        action === 'cancelOrder'
          ? callHttp(i, 'delete', `/orders/${source.id}`)
          : callHttp(i, 'post', `/orders/${target!.id}/merge`, { sourceOrderId: source.id })
      pending.push(rejected)
      const waiter = await task8ObserveBlockedBy(cashPid)
      expect(waiter.query).toContain('FROM "Order"')
      evidence(`Task8-cash-${action}-native`, i, { cashPid, waiter })
      gate.release()
      await cash
      const initial = await rejected
      expect(initial.status).toBe(503)
      expect(initial.body).toEqual({
        success: false,
        code: 'OPERATION_OUTCOME_PENDING',
        httpOperation: { ...i.operation, outcome: 'RETRY' },
      })
      expect(await stored(i)).toBeNull()
      const afterCash = await task8Snapshot([source.id, ...(target ? [target.id] : [])], [])
      const response =
        action === 'cancelOrder'
          ? await callHttp(i, 'delete', `/orders/${source.id}`)
          : await callHttp(i, 'post', `/orders/${target!.id}/merge`, { sourceOrderId: source.id })
      expect(response.status).toBe(400)
      expect(response.body.httpOperation.outcome).toBe('REJECTED')
      expect(await task8Snapshot([source.id, ...(target ? [target.id] : [])], [])).toEqual(afterCash)
      expect((await stored(i))!.status).toBe('REJECTED')
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: source.id, status: 'COMPLETED' } })
      expect(payment.amount).toEqual(new Prisma.Decimal(100))
      evidence(`Task8-cash-${action}-retry`, i, {
        initialStatus: initial.status,
        retryStatus: response.status,
        paymentId: payment.id,
        amount: Number(payment.amount),
        sameOperationId: true,
      })
      expect(await prisma.order.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
        paymentStatus: 'PAID',
        paidAmount: new Prisma.Decimal(100),
        remainingBalance: new Prisma.Decimal(0),
      })
      expect(await prisma.payment.count({ where: { orderId: source.id, status: 'COMPLETED' } })).toBe(1)
      expect(await prisma.orderItem.count({ where: { orderId: source.id } })).toBe(2)
      if (target) expect(await prisma.orderItem.count({ where: { orderId: target.id } })).toBe(2)
    } finally {
      await gate.cleanup(pending)
    }
  },
)

test.each(['cancelOrder', 'mergeOrders'] as const)(
  'Task8 real terminal admission versus %s: pending slot commits before source guard without hardware delivery',
  async action => {
    const source = await plainOrder(),
      target = action === 'mergeOrders' ? await plainOrder() : null
    const terminalId = `g8-${randomUUID()}`,
      socketId = `g8-${randomUUID()}`,
      requestId = randomUUID()
    const { terminalRegistry } = await import('@/communication/sockets/terminal-registry')
    terminalRegistry.register(terminalId, socketId, venueId)
    // Transport-only isolation: admission, locks, slot insert and UNKNOWN persistence are real.
    // Missing direct socket resolves delivery as UNKNOWN without speaking to any apparatus.
    const socketManager = (await import('@/communication/sockets/managers/socketManager')).default
    const transport = jest.spyOn(socketManager, 'getServer').mockReturnValue({ sockets: { sockets: new Map() } } as any)
    const i = operationInput<'cancelOrder' | 'mergeOrders'>(
      action === 'cancelOrder'
        ? { action, refs: { orderId: source.id }, payload: { reason: null } }
        : { action, refs: { orderId: target!.id, sourceOrderId: source.id }, payload: {} },
    )
    if (action === 'mergeOrders') i.actorId = managerId
    const pending: Promise<unknown>[] = []
    // A separate native INSERT gate pauses the actual reservation after its Order FOR UPDATE.
    const insertGate = await task8NativeGate('TerminalPaymentRequest', 'BEFORE INSERT', `NEW."requestId"='${requestId}'`)
    try {
      const sender = (await import('@/services/terminal-payment.service')).terminalPaymentService.sendPaymentToTerminal({
        terminalId,
        venueId,
        orderId: source.id,
        amountCents: 10000,
        requestedBy: authorId,
        requestId,
      })
      pending.push(sender)
      void sender.catch(() => undefined)
      const admissionPid = await task8ObserveWait(insertGate.key)
      const rejected =
        action === 'cancelOrder'
          ? callHttp(i, 'delete', `/orders/${source.id}`)
          : callHttp(i, 'post', `/orders/${target!.id}/merge`, { sourceOrderId: source.id })
      pending.push(rejected)
      const waiter = await task8ObserveBlockedBy(admissionPid)
      expect(waiter.query).toContain('FROM "Order"')
      evidence(`Task8-terminal-${action}-native`, i, { admissionPid, waiter, requestId, transport: 'missing-direct-socket; no hardware' })
      insertGate.release()
      expect((await sender).status).toBe('timeout')
      const response = await rejected
      expect(response.status).toBe(409)
      expect(response.body.code).toBe('ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE')
      const row = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId } })
      expect(row).toMatchObject({ orderId: source.id, requestedById: authorId, status: 'UNKNOWN', amountCents: 10000 })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: source.id } })).status).toBe('PENDING')
      expect(await prisma.payment.count({ where: { orderId: source.id } })).toBe(0)
    } finally {
      await insertGate.cleanup(pending)
      terminalRegistry.unregisterBySocketId(socketId)
      transport.mockRestore()
    }
  },
)

test.each([101, 501, 1001])(
  'Task8 clear %i participants: last unpaid is found, all audit members and receipt refs retained, native EXISTS plan recorded',
  async count => {
    const table = await emptyTable(),
      ids = Array.from({ length: count }, () => randomUUID()),
      at = new Date('2026-10-01T00:00:00Z')
    for (let offset = 0; offset < count; offset += 100)
      await prisma.order.createMany({
        data: ids.slice(offset, offset + 100).map((id, index) => ({
          id,
          venueId,
          tableId: table.id,
          orderNumber: `g8-${id}`,
          createdAt: new Date(at.getTime() + offset + index),
          paymentStatus: offset + index === count - 1 ? 'PENDING' : 'PAID',
          subtotal: 100,
          total: 100,
          taxAmount: 0,
          remainingBalance: offset + index === count - 1 ? 100 : 0,
          paidAmount: offset + index === count - 1 ? 0 : 100,
          contratoDePrecio: 'IVA_INCLUIDO',
        })),
      })
    await prisma.table.update({ where: { id: table.id }, data: { status: 'OCCUPIED', currentOrderId: ids[0] } })
    const i = operationInput({ action: 'clearTable', refs: { tableId: table.id }, payload: {} })
    const rejected = await callHttp(i, 'post', `/tables/${table.id}/clear`)
    expect(rejected.status).toBe(400)
    expect(rejected.body.message).toContain(`g8-${ids[count - 1]}`)
    const plan =
      await prisma.$queryRaw`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT "orderNumber" FROM "Order" WHERE "venueId"=${venueId} AND "tableId"=${table.id} AND status NOT IN ('COMPLETED','CANCELLED','DELETED') AND "paymentStatus"<>'PAID' ORDER BY "createdAt",id LIMIT 1`
    const indexes = await prisma.$queryRaw<
      Array<{ name: string; definition: string }>
    >`SELECT indexname name,indexdef definition FROM pg_indexes WHERE schemaname='public' AND tablename='Order' ORDER BY indexname`
    expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).currentOrderId).toBe(ids[0])
    await prisma.order.update({ where: { id: ids[count - 1] }, data: { paymentStatus: 'PAID', paidAmount: 100, remainingBalance: 0 } })
    const next = { ...i, operation: { ...i.operation, id: randomUUID() } }
    const applied = await callHttp(next, 'post', `/tables/${table.id}/clear`)
    expect(applied.status).toBe(200)
    const receipt = (await stored(next))!.resultJson as unknown as HttpEnvelope
    expect(
      receipt.affectedRefs
        .filter(ref => ref.kind === 'Order')
        .map(ref => ref.id)
        .sort(),
    ).toEqual([...ids].sort())
    expect(receipt.affectedRefs.filter(ref => ref.kind === 'Table')).toEqual([{ kind: 'Table', id: table.id }])
    const audit = jest.mocked(logAction).mock.calls.find(args => args[0].action === 'TABLE_CLEARED' && args[0].entityId === table.id)![0]
    const auditData = audit.data
    if (!auditData || typeof auditData !== 'object' || !('ordersCleared' in auditData) || !Array.isArray(auditData.ordersCleared)) {
      throw new Error('TABLE_CLEARED audit must capture ordersCleared')
    }
    expect([...auditData.ordersCleared].sort()).toEqual(ids.map(id => `g8-${id}`).sort())
    expect(terminal(await resolveHttpOperation(i)).outcome).toBe('REJECTED')
    evidence(`Task8-clear-${count}-EXPLAIN`, next, {
      count,
      orderIds: ids,
      refCount: receipt.affectedRefs.length,
      receiptBytes: Buffer.byteLength(JSON.stringify(receipt)),
      plan,
      indexes,
    })
  },
  120000,
)

async function task8Route(action: 'moveOrder' | 'clearTable' | 'mergeOrders' | 'cancelOrder') {
  const source = await plainOrder(),
    target = await plainOrder(),
    table = await emptyTable(),
    destination = await emptyTable()
  await task8Bind(source.id, table.id, action === 'clearTable' ? 'PAID' : 'PENDING')
  const input = operationInput<'moveOrder' | 'clearTable' | 'mergeOrders' | 'cancelOrder'>(
    action === 'moveOrder'
      ? { action, refs: { orderId: source.id, targetTableId: destination.id }, payload: {} }
      : action === 'clearTable'
        ? { action, refs: { tableId: table.id }, payload: {} }
        : action === 'mergeOrders'
          ? { action, refs: { orderId: target.id, sourceOrderId: source.id }, payload: {} }
          : { action, refs: { orderId: source.id }, payload: { reason: '  legacy exact  ' } },
  )
  if (action === 'mergeOrders') input.actorId = managerId
  const method = action === 'cancelOrder' ? 'delete' : 'post',
    path =
      action === 'clearTable'
        ? `/tables/${table.id}/clear`
        : action === 'moveOrder'
          ? `/orders/${source.id}/move`
          : action === 'mergeOrders'
            ? `/orders/${target.id}/merge`
            : `/orders/${source.id}`
  const body =
    action === 'moveOrder'
      ? { targetTableId: destination.id }
      : action === 'mergeOrders'
        ? { sourceOrderId: source.id }
        : action === 'cancelOrder'
          ? { reason: '  legacy exact  ' }
          : {}
  return {
    input,
    source,
    target,
    table,
    destination,
    method: method as 'post' | 'delete',
    path,
    body,
    snapshot: () => task8Snapshot([source.id, target.id], [table.id, destination.id]),
  }
}
test.each(['moveOrder', 'clearTable', 'mergeOrders', 'cancelOrder'] as const)(
  'Task8 %s real PermissionSet denial precedes claim and every scalar effect',
  async action => {
    const f = await task8Route(action),
      before = await f.snapshot(),
      access = await staffAccess(authorId)
    const set = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read', 'tables:read'] } })
    try {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: { permissionSetId: set.id } })
      const denied = await callHttp({ ...f.input, actorId: authorId }, f.method, f.path, f.body)
      expect(denied.status).toBe(403)
      expect(denied.body.httpOperation).toBeUndefined()
      expect(await stored(f.input)).toBeNull()
      expect(await f.snapshot()).toEqual(before)
    } finally {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: authorId, venueId } }, data: access })
    }
  },
)
test.each(['moveOrder', 'clearTable', 'mergeOrders', 'cancelOrder'] as const)(
  'Task8 %s all malformed operation variants cannot enter legacy',
  async action => {
    const f = await task8Route(action),
      before = await f.snapshot(),
      dummy = await fixture()
    for (const [, build] of invalidMetadata) {
      const client = request(httpApp),
        r = await client[f.method](`/api/v1/mobile/venues/${venueId}${f.path}`)
          .set('x-test-actor', authorId)
          .send({ ...f.body, httpOperation: build(dummy) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('HTTP_OPERATION_INVALID')
      expect(r.body.httpOperation).toBeUndefined()
    }
    expect(await stored(f.input)).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  },
)
test.each(['moveOrder', 'clearTable', 'mergeOrders', 'cancelOrder'] as const)(
  'Task8 %s publishes once after appliedNow; notification failure leaves committed body and replay/resolve publishes zero',
  async action => {
    const f = await task8Route(action),
      mobile = await import('@/services/mobile/order.mobile.service'),
      tables = await import('@/services/tpv/table.tpv.service')
    const publish =
      action === 'moveOrder'
        ? jest.spyOn(tables, 'publishMovedOrder')
        : action === 'clearTable'
          ? jest.spyOn(tables, 'publishClearedTable')
          : action === 'mergeOrders'
            ? jest.spyOn(mobile, 'publishMergedOrders')
            : jest.spyOn(mobile, 'publishCancelledOrder')
    let committed = false
    publish.mockImplementation(async () => {
      committed = (await stored(f.input))?.status === 'ACKED'
      throw new Error('Task8 isolated postcommit notification failure')
    })
    const applied = await callHttp(f.input, f.method, f.path, f.body)
    expect(applied.status).toBe(200)
    expect(applied.body.httpOperation.outcome).toBe('APPLIED')
    expect(committed).toBe(true)
    const after = await f.snapshot(),
      receipt = (await stored(f.input))!.resultJson
    expect((await callHttp(f.input, f.method, f.path, f.body)).body).toEqual(applied.body)
    expect(terminal(await resolveHttpOperation(f.input))).toEqual(receipt)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await f.snapshot()).toEqual(after)
  },
)
test('Task8 legacy cancel DELETE body preserves exact reason and audit without creating a receipt', async () => {
  const f = await task8Route('cancelOrder')
  const r = await request(httpApp).delete(`/api/v1/mobile/venues/${venueId}${f.path}`).set('x-test-actor', authorId).send(f.body)
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ success: true, message: 'Orden cancelada exitosamente' })
  expect(await stored(f.input)).toBeNull()
  expect(await prisma.order.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({
    status: 'CANCELLED',
    specialRequests: 'Cancelled:   legacy exact  ',
  })
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_CANCELLED', staffId: authorId, entityId: f.source.id }))
})
test('Task8 real PIN override preserves auth actor in merge receipt; resolve consumes no PIN token', async () => {
  const f = await task8Route('mergeOrders'),
    access = await staffAccess(readerId),
    prior = await prisma.venueSettings.findUnique({ where: { venueId } }),
    manager = await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId: managerId, venueId } } })
  const set = await prisma.permissionSet.create({ data: { venueId, name: randomUUID(), permissions: ['orders:read', 'tables:read'] } })
  const { createPermissionOverride } = await import('@/services/mobile/permission-override.mobile.service')
  try {
    await prisma.venueSettings.upsert({
      where: { venueId },
      create: { venueId, managerPinOverrideEnabled: true },
      update: { managerPinOverrideEnabled: true },
    })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { pin: '768912' } })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: { permissionSetId: set.id } })
    const pin = await createPermissionOverride({ venueId, pin: '768912', permission: 'orders:merge', requestedById: readerId })
    const second = await createPermissionOverride({ venueId, pin: '768912', permission: 'orders:merge', requestedById: readerId })
    const r = await request(httpApp)
      .post(`/api/v1/mobile/venues/${venueId}${f.path}`)
      .set('x-test-actor', readerId)
      .set('x-permission-override', pin.token)
      .send({ ...f.body, httpOperation: f.input.operation })
    expect(r.status).toBe(200)
    const receipt = (await stored(f.input))!.resultJson as unknown as HttpEnvelope
    expect(receipt.request.originalActorId).toBe(readerId)
    expect((await stored(f.input))!.staffId).toBe(readerId)
    expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: pin.token } })).consumedAt).not.toBeNull()
    const resolveInput = { ...f.input }
    const resolved = await request(httpApp)
      .post(resolvePath(resolveInput))
      .set('x-test-actor', readerId)
      .set('x-permission-override', second.token)
      .send(resolveBody(resolveInput))
    expect(resolved.status).toBe(200)
    expect(resolved.body.receipt).toEqual(receipt)
    expect((await prisma.permissionOverride.findUniqueOrThrow({ where: { token: second.token } })).consumedAt).toBeNull()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PERMISSION_OVERRIDE_USED', staffId: readerId }))
    evidence('Task8-PIN-auth-actor', f.input, { originalActorId: readerId, authorizerStaffId: managerId, resolveConsumesOverride: false })
  } finally {
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: readerId, venueId } }, data: access })
    await prisma.staffVenue.update({ where: { staffId_venueId: { staffId: managerId, venueId } }, data: { pin: manager.pin } })
    if (prior)
      await prisma.venueSettings.update({ where: { venueId }, data: { managerPinOverrideEnabled: prior.managerPinOverrideEnabled } })
    else await prisma.venueSettings.delete({ where: { venueId } })
  }
})

type Task9TopologyAction = 'moveOrder' | 'clearTable' | 'mergeOrders' | 'cancelOrder'
const task9UniqueCells = (['moveOrder', 'clearTable', 'mergeOrders', 'cancelOrder'] as const).flatMap(action =>
  (['postWins', 'tombstoneWins'] as const).map(ordering => ({ action, ordering })),
)
test.each(task9UniqueCells)('Task9 I1 $action $ordering: real callback behind observed unique claim', async ({ action, ordering }) => {
  const caseId = randomUUID()
  const kitchen = action === 'cancelOrder' ? await task8Kitchen(2) : null
  const sourceTable = kitchen?.table ?? (await emptyTable()),
    targetTable = await emptyTable(),
    source = kitchen?.order ?? (await plainOrder()),
    target = await plainOrder(),
    sibling = await plainOrder()
  await prisma.order.updateMany({
    where: { id: { in: [source.id, sibling.id] } },
    data: { tableId: sourceTable.id, ...(action === 'clearTable' ? { paymentStatus: 'PAID' } : {}) },
  })
  await prisma.table.update({ where: { id: sourceTable.id }, data: { currentOrderId: source.id, status: 'OCCUPIED' } })
  const mergeFixture = action === 'mergeOrders' ? await task8MergeRollbackSeed(source.id, target.id, targetTable.id) : null
  const input = operationInput<Task9TopologyAction>(
    action === 'clearTable'
      ? { action, refs: { tableId: sourceTable.id }, payload: {} }
      : action === 'moveOrder'
        ? { action, refs: { orderId: source.id, targetTableId: targetTable.id }, payload: {} }
        : action === 'mergeOrders'
          ? { action, refs: { orderId: target.id, sourceOrderId: source.id }, payload: {} }
          : { action, refs: { orderId: source.id }, payload: { reason: '  exact  ' } },
  )
  if (action === 'mergeOrders') input.actorId = managerId
  const snapshot = (tx?: PrismaTypes.TransactionClient) =>
    task8Snapshot([source.id, target.id, sibling.id], [sourceTable.id, targetTable.id], tx)
  const before = await snapshot()
  const counts = (state: typeof before) => Object.fromEntries(Object.entries(state).map(([name, rows]) => [name, rows.length]))
  const name = `Task9-I1-${action}-${ordering}`
  let domainCalls = 0
  let winnerState: typeof before | undefined
  let domainResult: DomainResult<Task9TopologyAction> | undefined
  const post = () =>
    executeHttpOperation(input, async tx => {
      domainCalls++
      const tables = await import('@/services/tpv/table.tpv.service'),
        mobile = await import('@/services/mobile/order.mobile.service')
      if (action === 'moveOrder') {
        const r = await tables.moveOrderToTableInTransaction(tx, venueId, source.id, targetTable.id)
        domainResult = { response: { status: 200, body: { success: true } }, affectedRefs: r.affectedRefs }
      } else if (action === 'clearTable') {
        const r = await tables.clearTableInTransaction(tx, venueId, sourceTable.id)
        domainResult = { response: { status: 200, body: { success: true, message: 'Mesa liberada' } }, affectedRefs: r.affectedRefs }
      } else if (action === 'mergeOrders') {
        const r = await mobile.mergeOrdersInTransaction(tx, venueId, target.id, source.id, input.actorId)
        domainResult = { response: { status: 200, body: { success: true, data: r.data } }, affectedRefs: r.affectedRefs }
      } else {
        const r = await mobile.cancelOrderInTransaction(tx, venueId, source.id, '  exact  ', input.actorId)
        domainResult = {
          response: { status: 200, body: { success: true, message: 'Orden cancelada exitosamente' } },
          affectedRefs: r.affectedRefs,
        }
      }
      winnerState = await snapshot(tx)
      return domainResult
    })
  const resolve = () => resolveHttpOperation({ ...input, actorId: managerId })
  try {
    const postWins = ordering === 'postWins'
    const results = await forceOrder(
      name,
      input,
      postWins ? 'PROCESSING' : 'REJECTED',
      postWins ? post : resolve,
      postWins ? resolve : post,
      async pid => {
        expect(domainCalls).toBe(0)
        expect(await snapshot()).toEqual(before)
        const loserWriteTables = await writtenTables(pid)
        for (const table of ['Order', 'Table', 'OrderItem', 'OrderPromotion', 'OrderServiceCharge', 'KdsOrder', 'KdsOrderItem'])
          expect(loserWriteTables).not.toContain(table)
        evidence(name, input, { caseId, phase: 'domain-pristine-before-claim', domainCalls, counts: counts(before), loserWriteTables })
      },
    )
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    if (results[0].status !== 'fulfilled' || results[1].status !== 'fulfilled')
      throw new Error('Both native claim participants must settle')
    const envelope = terminal(results[0].value)
    expect(terminal(results[1].value)).toEqual(envelope)
    expect(results[0].value).toMatchObject({ kind: 'TERMINAL', appliedNow: postWins })
    expect(results[1].value).toMatchObject({ kind: 'TERMINAL', appliedNow: false })
    expect(domainCalls).toBe(postWins ? 1 : 0)
    const after = await snapshot()
    const receipt = await stored(input)
    expect(receipt).toMatchObject({
      status: postWins ? 'ACKED' : 'REJECTED',
      staffId: postWins ? input.actorId : managerId,
      resultJson: envelope,
    })
    expect(
      await prisma.posSyncIntent.count({ where: { venueId, idempotencyKey: `http:v1:${input.operation.id}`, type: 'HTTP_OP_V1' } }),
    ).toBe(1)
    if (!postWins) {
      expect(envelope).toMatchObject({ outcome: 'REJECTED', request: { originalActorId: null }, fencedByStaffId: managerId })
      expect(after).toEqual(before)
      expect(counts(after)).toEqual(counts(before))
      expect(winnerState).toBeUndefined()
      expect(domainResult).toBeUndefined()
    } else {
      expect(envelope.outcome).toBe('APPLIED')
      if (envelope.outcome !== 'APPLIED') throw new Error('POST winner must yield APPLIED')
      expect(envelope.request.originalActorId).toBe(input.actorId)
      expect(envelope.originalResponse).toEqual(domainResult!.response)
      expect(envelope.affectedRefs).toEqual(domainResult!.affectedRefs)
      expect(after).toEqual(winnerState)
      const oldSource = before.orders.find(row => row.id === source.id)!,
        newSource = after.orders.find(row => row.id === source.id)!,
        oldTarget = before.orders.find(row => row.id === target.id)!,
        newTarget = after.orders.find(row => row.id === target.id)!
      const sourceState = after.tables.find(row => row.id === sourceTable.id)!,
        targetState = after.tables.find(row => row.id === targetTable.id)!
      expect(after.orders.find(row => row.id === sibling.id)).toEqual(before.orders.find(row => row.id === sibling.id))
      if (action === 'moveOrder') {
        expect(newSource).toEqual({ ...oldSource, tableId: targetTable.id, updatedAt: newSource.updatedAt })
        expect(newTarget).toEqual(oldTarget)
        expect(sourceState).toMatchObject({ status: 'OCCUPIED', currentOrderId: sibling.id })
        expect(targetState).toMatchObject({ status: 'OCCUPIED', currentOrderId: source.id })
        expect(counts(after)).toEqual(counts(before))
      } else if (action === 'clearTable') {
        expect(sourceState).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
        expect(targetState).toEqual(before.tables.find(row => row.id === targetTable.id))
        expect(after.orders).toEqual(before.orders)
        expect(counts(after)).toEqual(counts(before))
      } else if (action === 'mergeOrders') {
        if (!mergeFixture) throw new Error('Missing real promotion/charge fixture')
        const targetChargesBefore = before.charges.filter(row => row.orderId === target.id),
          removed = targetChargesBefore.find(row => row.serviceChargeId === mergeFixture.removedRule.id)!,
          survivor = targetChargesBefore.find(row => row.serviceChargeId === mergeFixture.survivorRule.id)!,
          targetSurvivors = targetChargesBefore.filter(row => row.id !== removed.id)
        // The earlier Task5 fixture retains its own 5% rule alongside this fixture's 5% rule.
        // Independent cents oracle: both configured percentages apply to 299, then the new fixed 7.
        expect(targetSurvivors).toHaveLength(2)
        expect(targetSurvivors.find(row => row.name === 'Surviving percentage')).toBeDefined()
        for (const row of targetSurvivors)
          expect(row).toMatchObject({ type: 'PERCENTAGE', value: new Prisma.Decimal(5), isAutomatic: true })
        const expectedSurvivors = targetSurvivors.map(row => ({
          ...row,
          amount: new Prisma.Decimal(Math.round(299 * Number(row.value))).div(100),
        }))
        const expectedChargeCents = targetSurvivors.reduce((sum, row) => sum + Math.round(299 * Number(row.value)), 700),
          expectedServiceCharge = new Prisma.Decimal(expectedChargeCents).div(100),
          expectedTotal = new Prisma.Decimal(29900 + expectedChargeCents).div(100)
        expect(newSource).toEqual({
          ...oldSource,
          status: 'CANCELLED',
          specialRequests: `Fusionada en ${target.orderNumber}`,
          subtotal: new Prisma.Decimal(0),
          discountAmount: new Prisma.Decimal(0),
          serviceChargeAmount: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
          version: oldSource.version + 1,
          updatedAt: newSource.updatedAt,
        })
        expect(newTarget).toEqual({
          ...oldTarget,
          subtotal: new Prisma.Decimal(299),
          discountAmount: new Prisma.Decimal(0),
          serviceChargeAmount: expectedServiceCharge,
          total: expectedTotal,
          remainingBalance: expectedTotal,
          version: oldTarget.version + 2,
          updatedAt: newTarget.updatedAt,
        })
        expect(after.items).toEqual(
          before.items.map(row =>
            row.orderId === source.id
              ? { ...row, orderId: target.id, updatedAt: after.items.find(current => current.id === row.id)!.updatedAt }
              : row,
          ),
        )
        expect(after.items.filter(row => row.orderId === source.id)).toHaveLength(0)
        expect(after.items.filter(row => row.orderId === target.id)).toHaveLength(6)
        expect(after.promotions).toEqual(before.promotions)
        const created = after.charges.find(row => row.serviceChargeId === mergeFixture.createdRule.id)!
        expect(after.charges.filter(row => row.orderId === source.id || row.id === removed.id)).toHaveLength(0)
        expect(after.charges).toHaveLength(expectedSurvivors.length + 1)
        expect(after.charges.filter(row => row.id !== created.id)).toEqual(expectedSurvivors)
        expect(after.charges.find(row => row.id === survivor.id)).toEqual({ ...survivor, amount: new Prisma.Decimal(14.95) })
        expect(created).toMatchObject({
          orderId: target.id,
          serviceChargeId: mergeFixture.createdRule.id,
          name: mergeFixture.createdRule.name,
          type: 'FIXED_AMOUNT',
          value: new Prisma.Decimal(7),
          amount: new Prisma.Decimal(7),
          taxable: false,
          isAutomatic: true,
          appliedById: null,
        })
        expect(sourceState).toMatchObject({ status: 'OCCUPIED', currentOrderId: sibling.id })
        expect(targetState).toEqual(before.tables.find(row => row.id === targetTable.id))
        expect(envelope.originalResponse.body).toEqual({
          success: true,
          data: {
            target: { id: target.id, orderNumber: target.orderNumber, total: Number(expectedTotal), version: oldTarget.version + 2 },
            merged: { id: source.id, orderNumber: source.orderNumber, items: 4 },
            tableFreed: true,
          },
        })
      } else {
        expect(newSource).toMatchObject({ status: 'CANCELLED', specialRequests: 'Cancelled:   exact  ' })
        expect(newTarget).toEqual(oldTarget)
        expect(sourceState).toMatchObject({ status: 'OCCUPIED', currentOrderId: sibling.id })
        expect(targetState).toEqual(before.tables.find(row => row.id === targetTable.id))
        const completed = before.kds.filter(row => row.status === 'COMPLETED')
        expect(before.kds).toHaveLength(3)
        expect(completed).toHaveLength(1)
        expect(after.kds).toEqual(completed)
        expect(after.kdsItems).toEqual(before.kdsItems.filter(row => row.kdsOrderId === completed[0].id))
        expect(counts(after)).toEqual({ ...counts(before), kds: 1, kdsItems: 1 })
      }
      if (action !== 'mergeOrders') {
        expect(after.items).toEqual(before.items)
        expect(after.charges).toEqual(before.charges)
        expect(after.promotions).toEqual(before.promotions)
      }
      if (action !== 'cancelOrder') {
        expect(after.kds).toEqual(before.kds)
        expect(after.kdsItems).toEqual(before.kdsItems)
      }
    }
    expect(terminal(await post())).toEqual(envelope)
    expect(terminal(await resolve())).toEqual(envelope)
    expect(domainCalls).toBe(postWins ? 1 : 0)
    expect(await stored(input)).toEqual(receipt)
    expect(await snapshot()).toEqual(after)
    evidence(name, input, {
      caseId,
      phase: 'eight-cell-closed',
      ordering,
      domainCalls,
      beforeCounts: counts(before),
      afterCounts: counts(after),
      receiptId: receipt!.id,
      receiptStatus: receipt!.status,
      receiptExact: true,
      replayExact: true,
      originalResponse: envelope.outcome === 'APPLIED' ? envelope.originalResponse : undefined,
      affectedRefs: envelope.affectedRefs,
    })
  } finally {
    if (mergeFixture)
      await prisma.serviceCharge.updateMany({
        where: { id: { in: [mergeFixture.survivorRule.id, mergeFixture.removedRule.id, mergeFixture.createdRule.id] }, venueId },
        data: { active: false },
      })
  }
})
