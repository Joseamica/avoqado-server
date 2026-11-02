import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { cancelOrder } from '@/controllers/mobile/order.mobile.controller'
import { resolveHttpOperation, HTTP_PREFIX, type OperationInput } from '@/services/mobile/http-operation.mobile.service'
import { drainPendingCancellationEffects } from '@/services/mobile/cancelOrderEffects.service'
import * as referral from '@/services/referrals/referralRefund.service'

const mockBroadcast = jest.fn(() => true)
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastToVenue: mockBroadcast })) },
}))

let venueId: string
let organizationId: string
let authorId: string
let managerId: string
beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({
      data: {
        name: 'ITEST D7',
        email: `d7-${randomUUID()}@example.test`,
        phone: '5550000000',
      },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: {
        organizationId,
        name: 'ITEST D7',
        slug: `itest-d7-${randomUUID()}`,
        seatCapExempt: true,
      },
    })
  ).id
  for (const firstName of ['Autor', 'Gerente']) {
    const staff = await prisma.staff.create({ data: { firstName, lastName: 'D7', email: `${randomUUID()}@example.test` } })
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId, role: 'MANAGER' } })
    if (firstName === 'Autor') authorId = staff.id
    else managerId = staff.id
  }
})
afterEach(() => {
  jest.restoreAllMocks()
  mockBroadcast.mockReset().mockReturnValue(true)
})
afterAll(async () => {
  if (!venueId) return
  await prisma.posSyncIntent.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.table.updateMany({ where: { venueId }, data: { currentOrderId: null } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: [authorId, managerId] } } })
  await prisma.organization.delete({ where: { id: organizationId } })
})

async function fixture(actorId = authorId): Promise<OperationInput<'cancelOrder'>> {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `d7-${randomUUID()}`,
      servedById: actorId,
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      contratoDePrecio: 'IVA_INCLUIDO',
    },
  })
  return {
    venueId,
    actorId,
    operation: { version: 1, id: randomUUID(), deviceId: randomUUID() },
    manifest: { action: 'cancelOrder', refs: { orderId: order.id }, payload: { reason: 'motivo original' } },
  }
}
async function requestCancel(input: OperationInput<'cancelOrder'>) {
  const response = { status: 200, body: undefined as any }
  const res = {
    status: (code: number) => {
      response.status = code
      return res
    },
    json: (body: unknown) => {
      response.body = body
      return res
    },
  }
  await cancelOrder(
    {
      params: { venueId: input.venueId, orderId: input.manifest.refs.orderId },
      body: { reason: input.manifest.payload.reason, httpOperation: input.operation },
      authContext: { userId: input.actorId },
    } as unknown as Request,
    res as unknown as Response,
    ((error: unknown) => {
      throw error
    }) as NextFunction,
  )
  return response
}
const receipt = (input: OperationInput<'cancelOrder'>) =>
  prisma.posSyncIntent.findUniqueOrThrow({
    where: { venueId_idempotencyKey: { venueId: input.venueId, idempotencyKey: HTTP_PREFIX + input.operation.id } },
  })
const audit = (input: OperationInput<'cancelOrder'>) =>
  prisma.activityLog.findMany({
    where: { venueId: input.venueId, entityId: input.manifest.refs.orderId, action: 'ORDER_CANCELLED' },
    take: 10,
  })

it.each(['replay', 'resolve', 'barrido'] as const)(
  'D7: commit confirmado con ACK perdido recupera la bitácora por %s una sola vez',
  async recovery => {
    const input = await fixture()
    const transaction = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (...args: any[]) => {
      await (transaction as any)(...args)
      throw new Error('D7: se perdió el ACK después del COMMIT real')
    }) as any)
    expect((await requestCancel(input)).status).toBe(503)
    const saved = (await receipt(input)).resultJson
    expect((await prisma.order.findUniqueOrThrow({ where: { id: input.manifest.refs.orderId } })).status).toBe('CANCELLED')
    expect(saved).toMatchObject({ outcome: 'APPLIED', request: { originalActorId: authorId } })
    expect(await audit(input)).toHaveLength(0)

    if (recovery === 'replay') expect((await requestCancel(input)).status).toBe(200)
    else if (recovery === 'resolve')
      expect(await resolveHttpOperation({ ...input, actorId: managerId })).toMatchObject({ kind: 'TERMINAL', envelope: saved })
    else await drainPendingCancellationEffects()
    expect(await audit(input)).toEqual([expect.objectContaining({ staffId: authorId, data: { reason: 'motivo original' } })])
    await requestCancel(input)
    await resolveHttpOperation({ ...input, actorId: managerId })
    expect(await audit(input)).toHaveLength(1)
    expect((await receipt(input)).resultJson).toEqual(saved)
  },
)

it('D7: un aviso fallido conserva AUDITED; replay/resolve/barrido simultáneos no repiten bitácora ni referido', async () => {
  const input = await fixture()
  const referrer = await prisma.customer.create({ data: { venueId, firstName: 'Referente D7', referralCount: 1 } })
  const referred = await prisma.customer.create({ data: { venueId, firstName: 'Referido D7' } })
  const ref = await prisma.referral.create({
    data: {
      venueId,
      qualifyingOrderId: input.manifest.refs.orderId,
      status: 'QUALIFIED',
      referrerCustomerId: referrer.id,
      referredCustomerId: referred.id,
    },
  })
  mockBroadcast.mockReturnValue(false)
  expect((await requestCancel(input)).status).toBe(200)
  expect((await receipt(input)).cancelEffectsJson).toMatchObject({ phase: 'AUDITED' })
  expect(await audit(input)).toHaveLength(1)
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: referrer.id } })).referralCount).toBe(0)
  mockBroadcast.mockReturnValue(true)
  await Promise.all([requestCancel(input), resolveHttpOperation({ ...input, actorId: managerId }), drainPendingCancellationEffects()])
  expect(await audit(input)).toHaveLength(1)
  expect((await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe('VOID')
  expect((await prisma.customer.findUniqueOrThrow({ where: { id: referrer.id } })).referralCount).toBe(0)
  expect((await receipt(input)).cancelEffectsJson).toBeNull()
})

it('D7: si falla el referido estricto, el recibo sigue APPLIED y la obligación PENDING hasta recuperarse', async () => {
  const input = await fixture()
  jest.spyOn(referral, 'revertQualifiedReferral').mockRejectedValueOnce(new Error('D7 fallo transitorio del referido'))
  const response = await requestCancel(input)
  expect(response.body.httpOperation.outcome).toBe('APPLIED')
  expect(await audit(input)).toHaveLength(0)
  expect((await receipt(input)).cancelEffectsJson).toMatchObject({ phase: 'PENDING' })
  await drainPendingCancellationEffects()
  expect(await audit(input)).toHaveLength(1)
})

it('D7: fallo real al marcar AUDITED revierte también la bitácora anterior; después se recupera sin duplicados', async () => {
  const input = await fixture()
  await prisma.$executeRawUnsafe(`CREATE FUNCTION d7_fail_audited() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."venueId" = '${venueId}' AND NEW."cancelEffectsJson"->>'phase' = 'AUDITED'
    THEN RAISE EXCEPTION 'D7 sabotage after audit insert'; END IF; RETURN NEW; END $$`)
  await prisma.$executeRawUnsafe(
    'CREATE TRIGGER d7_fail_audited BEFORE UPDATE ON "PosSyncIntent" FOR EACH ROW EXECUTE FUNCTION d7_fail_audited()',
  )
  try {
    expect((await requestCancel(input)).body.httpOperation.outcome).toBe('APPLIED')
    expect(await audit(input)).toHaveLength(0)
    expect((await receipt(input)).cancelEffectsJson).toMatchObject({ phase: 'PENDING' })
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER d7_fail_audited ON "PosSyncIntent"')
    await prisma.$executeRawUnsafe('DROP FUNCTION d7_fail_audited()')
  }
  await drainPendingCancellationEffects()
  expect(await audit(input)).toHaveLength(1)
  expect((await receipt(input)).cancelEffectsJson).toBeNull()
})

it('D7: un autor bloqueado no hace esperar la cancelación; el pendiente se completa al soltarse', async () => {
  const input = await fixture()
  let unlock!: () => void
  let acquired!: () => void
  const release = new Promise<void>(resolve => {
    unlock = resolve
  })
  const ready = new Promise<void>(resolve => {
    acquired = resolve
  })
  const hold = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "Staff" WHERE id = ${authorId} FOR UPDATE`
      acquired()
      await release
    },
    { timeout: 30000 },
  )
  await ready
  try {
    expect((await requestCancel(input)).status).toBe(200)
    expect((await receipt(input)).cancelEffectsJson).toMatchObject({ phase: 'PENDING' })
    expect(await audit(input)).toHaveLength(0)
  } finally {
    unlock()
    await hold
  }
  await drainPendingCancellationEffects()
  expect(await audit(input)).toHaveLength(1)
})

it('D7: al recuperar conserva el estado actual de la venta y de una mesa reutilizada', async () => {
  const input = await fixture()
  const table = await prisma.table.create({
    data: {
      venueId,
      number: `D7-${randomUUID()}`,
      capacity: 2,
      qrCode: randomUUID(),
      status: 'OCCUPIED',
      currentOrderId: input.manifest.refs.orderId,
    },
  })
  await prisma.order.update({ where: { id: input.manifest.refs.orderId }, data: { tableId: table.id } })
  mockBroadcast.mockReturnValue(false)
  await requestCancel(input)
  const next = await fixture()
  await prisma.order.update({ where: { id: input.manifest.refs.orderId }, data: { status: 'CONFIRMED' } })
  await prisma.order.update({ where: { id: next.manifest.refs.orderId }, data: { tableId: table.id } })
  await prisma.table.update({ where: { id: table.id }, data: { status: 'OCCUPIED', currentOrderId: next.manifest.refs.orderId } })
  mockBroadcast.mockReset().mockReturnValue(true)
  await drainPendingCancellationEffects()
  expect(mockBroadcast).toHaveBeenCalledWith(venueId, 'order_updated', { orderId: input.manifest.refs.orderId, status: 'CONFIRMED' })
  expect(mockBroadcast).toHaveBeenCalledWith(
    venueId,
    'table_status_change',
    expect.objectContaining({ tableId: table.id, status: 'OCCUPIED', orderId: next.manifest.refs.orderId }),
  )
})

it('D7: autor borrado después del commit conserva su identidad en la bitácora y no pierde la obligación', async () => {
  const actor = await prisma.staff.create({ data: { firstName: 'Autor borrado', lastName: 'D7', email: `${randomUUID()}@example.test` } })
  await prisma.staffVenue.create({ data: { venueId, staffId: actor.id, role: 'MANAGER' } })
  const input = await fixture(actor.id)
  jest.spyOn(referral, 'revertQualifiedReferral').mockRejectedValueOnce(new Error('D7 pausa antes de auditoría'))
  await requestCancel(input)
  await prisma.staff.delete({ where: { id: actor.id } })
  await resolveHttpOperation({ ...input, actorId: managerId })
  expect(await audit(input)).toEqual([
    expect.objectContaining({ staffId: null, data: { reason: 'motivo original', unknownStaffId: actor.id } }),
  ])
  expect((await receipt(input)).cancelEffectsJson).toBeNull()
})
