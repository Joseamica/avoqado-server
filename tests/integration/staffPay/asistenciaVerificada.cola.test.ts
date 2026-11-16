import prisma from '@/utils/prismaClient'
import { checkInByIdentifier } from '@/services/reservation/kioskCheckIn.service'
import { borrarMundo, crearMundo, Mundo } from './_mundo'

/**
 * Asistencia verificada (Codex r4, rediseño): la llegada de la cola sin red del kiosco tiene su RECIBO (`KioskCheckInOp`)
 * en la misma transacción. Contra Postgres de verdad: `ON CONFLICT` y el rollback no se prueban con dobles.
 */
let m: Mundo
const TEL = '+525511112222'

async function reserva(minutosDesdeAhora: number) {
  const startsAt = new Date(Date.now() + minutosDesdeAhora * 60_000)
  const endsAt = new Date(startsAt.getTime() + 50 * 60_000)
  return prisma.reservation.create({
    data: {
      venueId: m.venueId,
      productId: m.productId,
      confirmationCode: `${m.key}-${minutosDesdeAhora}`,
      status: 'CONFIRMED',
      startsAt,
      endsAt,
      blockedEndsAt: endsAt,
      duration: 50,
      guestName: 'Ana Ruiz',
      guestPhone: TEL,
      confirmedAt: new Date(),
    },
  })
}

const llegada = (opId: string) =>
  checkInByIdentifier({
    venueId: m.venueId,
    terminalId: null,
    stationKey: 'B',
    identifier: TEL,
    now: new Date(),
    occurredAt: new Date(Date.now() - 1000),
    opId,
  })

beforeAll(async () => {
  m = await crearMundo('asistencia-cola')
})
afterAll(async () => {
  if (!m) return
  // Las llegadas dejan su ActivityLog (con FK a la organización): se borra antes que el mundo.
  await prisma.activityLog.deleteMany({ where: { organizationId: m.orgId } })
  await borrarMundo(m)
})

describe('Recibo idempotente de la cola del teléfono', () => {
  it('🔴 la gerente deshace la llegada y la cola reintenta la misma fila ⇒ no se vuelve a marcar', async () => {
    const r = await reserva(5)
    const primero = await llegada(`${m.key}-op-1`)
    expect(primero.outcome).toBe('CHECKED_IN')
    expect(await prisma.kioskCheckInOp.findUnique({ where: { opId: `${m.key}-op-1` } })).toMatchObject({ reservationId: r.id })

    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'CONFIRMED', checkedInAt: null, checkInMethod: null } })
    const reintento = await llegada(`${m.key}-op-1`)
    expect(reintento).toMatchObject({ outcome: 'ALREADY_CHECKED_IN', reservationId: r.id })
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('CONFIRMED')
  })

  it('🔴 la primera clase se completó y el reintento ya no la encuentra ⇒ NO marca la siguiente clase', async () => {
    await prisma.reservation.deleteMany({ where: { venueId: m.venueId } })
    const primera = await reserva(2)
    const segunda = await reserva(15)
    await llegada(`${m.key}-op-2`)
    await prisma.reservation.update({ where: { id: primera.id }, data: { status: 'COMPLETED' } })
    const reintento = await llegada(`${m.key}-op-2`)
    expect(reintento.reservationId).toBe(primera.id)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: segunda.id } })).status).toBe('CONFIRMED')
  })

  it('una llegada que ya estaba (por QR) también deja su recibo', async () => {
    await prisma.reservation.deleteMany({ where: { venueId: m.venueId } })
    const r = await reserva(5)
    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'CHECKED_IN', checkInMethod: 'QR' } })
    expect((await llegada(`${m.key}-op-3`)).outcome).toBe('ALREADY_CHECKED_IN')
    expect(await prisma.kioskCheckInOp.findUnique({ where: { opId: `${m.key}-op-3` } })).toMatchObject({ reservationId: r.id })
  })
})
