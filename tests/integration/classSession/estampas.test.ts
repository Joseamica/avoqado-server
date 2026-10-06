// tests/integration/classSession/estampas.test.ts — estampas de pago por servicio en los escritores de ClassSession
// (spec fase 3 §7.2). Contra la base real: el servicio de verdad, sin mocks de Prisma.
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import {
  cancelClassSession,
  createClassSession,
  createClassSessionsBulk,
  updateClassSession,
} from '@/services/dashboard/classSession.dashboard.service'
import * as activityAudit from '@/services/activityAudit.service'
import { barreraDeLaFilaDeClase, borrarMundo, clase, crearMundo, Mundo, TZ } from '../staffPay/_mundo'

const H = 3_600_000
let m: Mundo
beforeEach(async () => {
  m = await crearMundo('estampas')
})
afterEach(() => borrarMundo(m))

const nueva = (staffId: string | null, horasDesdeAhora = 48) => {
  const inicio = new Date(Date.now() + horasDesdeAhora * H)
  return createClassSession(
    m.venueId,
    {
      productId: m.productId,
      startsAt: inicio.toISOString(),
      endsAt: new Date(inicio.getTime() + 50 * 60_000).toISOString(),
      capacity: 10,
      assignedStaffId: staffId,
      internalNotes: null,
    },
    m.owner,
  )
}
const estampas = (id: string) =>
  prisma.classSession.findUniqueOrThrow({
    where: { id },
    select: { status: true, assignedStaffId: true, originalStaffId: true, staffAssignedAt: true, cancelledAt: true },
  })

describe('estampas al crear y editar (spec fase 3 §7.2)', () => {
  it('crear con coach estampa a la original y cuándo se asignó; sin coach no estampa nada', async () => {
    const antes = Date.now()
    const con = await nueva(m.ana)
    const sin = await nueva(null, 72)
    const e = await estampas(con.id)
    expect(e).toMatchObject({ assignedStaffId: m.ana, originalStaffId: m.ana, cancelledAt: null })
    expect(e.staffAssignedAt!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
    expect(await estampas(sin.id)).toMatchObject({ assignedStaffId: null, originalStaffId: null, staffAssignedAt: null })
  })

  it('creación masiva → sustitución: la de hoy ya no es la original (suplencia) y la asignación es la del cambio', async () => {
    const startDate = new Date(Date.now() + 3 * 24 * H).toLocaleDateString('en-CA', { timeZone: TZ }) // YYYY-MM-DD local
    const weekday = new Date(`${startDate}T12:00:00Z`).getUTCDay()
    const antesDelLote = Date.now()
    const r = await createClassSessionsBulk(
      m.venueId,
      {
        productId: m.productId,
        startDate,
        startTime: '10:00',
        endTime: '10:50',
        weekdays: [weekday],
        occurrences: 2,
        capacity: 10,
        assignedStaffId: m.ana,
        internalNotes: null,
      },
      m.owner,
      TZ,
    )
    expect(r.count).toBe(2)
    const creada = (await estampas(r.created[0].id)).staffAssignedAt!
    // La serie también estampa cuándo se asignó (si quedara null, `creada` null haría pasar el resto en falso).
    expect(creada?.getTime()).toBeGreaterThanOrEqual(antesDelLote - 1000)
    for (const c of r.created)
      expect(await estampas(c.id)).toMatchObject({ assignedStaffId: m.ana, originalStaffId: m.ana, staffAssignedAt: creada })

    const antesDelCambio = Date.now()
    await updateClassSession(m.venueId, r.created[0].id, { assignedStaffId: m.sofia }, m.owner)
    const e = await estampas(r.created[0].id)
    expect(e).toMatchObject({ assignedStaffId: m.sofia, originalStaffId: m.ana })
    // Sin margen: checkedAt sale del mismo reloj de Node, así que una estampa vieja (la del lote) no pasa.
    expect(e.staffAssignedAt!.getTime()).toBeGreaterThanOrEqual(antesDelCambio)
    // La otra clase de la serie no se tocó.
    expect(await estampas(r.created[1].id)).toMatchObject({ assignedStaffId: m.ana, originalStaffId: m.ana, staffAssignedAt: creada })
  })

  it('Ana → Bea → Ana: vuelve la original (no es suplencia) y cada cambio renueva staffAssignedAt', async () => {
    const c = await nueva(m.ana)
    await updateClassSession(m.venueId, c.id, { assignedStaffId: m.sofia }, m.owner)
    const conBea = await estampas(c.id)
    await updateClassSession(m.venueId, c.id, { assignedStaffId: m.ana }, m.owner)
    const e = await estampas(c.id)
    expect(e).toMatchObject({ assignedStaffId: m.ana, originalStaffId: m.ana })
    expect(e.staffAssignedAt!.getTime()).toBeGreaterThanOrEqual(conBea.staffAssignedAt!.getTime())
  })

  it('sin coach al crear: la primera asignación llena la original; quitarla no borra las estampas', async () => {
    const c = await nueva(null)
    await updateClassSession(m.venueId, c.id, { assignedStaffId: m.carla }, m.owner)
    const conCarla = await estampas(c.id)
    expect(conCarla).toMatchObject({ assignedStaffId: m.carla, originalStaffId: m.carla })
    expect(conCarla.staffAssignedAt).not.toBeNull()
    await updateClassSession(m.venueId, c.id, { assignedStaffId: null }, m.owner)
    expect(await estampas(c.id)).toMatchObject({
      assignedStaffId: null,
      originalStaffId: m.carla,
      staffAssignedAt: conCarla.staffAssignedAt,
    })
  })

  it('clase con coach pero sin original (escrita directo, sin estampas): el cambio deja como original a la PRIMERA coach', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: new Date(Date.now() + 48 * H).toISOString() })
    expect(await estampas(id)).toMatchObject({ assignedStaffId: m.ana, originalStaffId: null, staffAssignedAt: null })
    const antesDelCambio = Date.now()
    await updateClassSession(m.venueId, id, { assignedStaffId: m.sofia }, m.owner)
    const e = await estampas(id)
    expect(e).toMatchObject({ assignedStaffId: m.sofia, originalStaffId: m.ana })
    expect(e.staffAssignedAt!.getTime()).toBeGreaterThanOrEqual(antesDelCambio)
  })

  it('cambiar capacidad o notas, o «asignar» a la misma coach, no toca las estampas', async () => {
    const c = await nueva(m.ana)
    const antes = await estampas(c.id)
    await updateClassSession(m.venueId, c.id, { capacity: 8, internalNotes: 'sin cambio de coach', assignedStaffId: m.ana }, m.owner)
    expect(await estampas(c.id)).toEqual(antes)
  })
})

describe('cancelar (spec fase 3 §7.2)', () => {
  it('estampa cancelledAt, su ActivityLog lleva a quien canceló, y una segunda cancelación es 409 sin pisar el instante', async () => {
    const c = await nueva(m.ana)
    const antes = Date.now()
    const r = await cancelClassSession(m.venueId, c.id, m.owner)
    const e = await estampas(c.id)
    expect(e.status).toBe('CANCELLED')
    expect(e.cancelledAt!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
    expect(r.cancelledAt).toEqual(e.cancelledAt)
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'CLASS_SESSION_CANCELLED', entityId: c.id } })
    expect(log.staffId).toBe(m.owner)
    expect(log.data).toMatchObject({ cancelledAt: e.cancelledAt!.toISOString() })
    await expect(cancelClassSession(m.venueId, c.id, m.owner)).rejects.toMatchObject({ statusCode: 409 })
    expect((await estampas(c.id)).cancelledAt).toEqual(e.cancelledAt)
  })

  it('la auditoría va en la misma transacción: si falla, la clase sigue sin cancelar', async () => {
    const c = await nueva(m.ana)
    const spy = jest.spyOn(activityAudit, 'writeLegacyActivityAuditTx').mockRejectedValueOnce(new Error('auditoría caída'))
    try {
      await expect(cancelClassSession(m.venueId, c.id, m.owner)).rejects.toThrow('auditoría caída')
    } finally {
      spy.mockRestore()
    }
    expect(await estampas(c.id)).toMatchObject({ status: 'SCHEDULED', cancelledAt: null })
  })

  it('la auditoría se escribe con la transacción: si algo falla después de escribirla, no queda rastro de una cancelación que no pasó', async () => {
    const c = await nueva(m.ana)
    const real = activityAudit.writeLegacyActivityAuditTx
    const spy = jest.spyOn(activityAudit, 'writeLegacyActivityAuditTx').mockImplementationOnce(async (db, input) => {
      await real(db, input)
      throw new Error('falla después de auditar')
    })
    try {
      await expect(cancelClassSession(m.venueId, c.id, m.owner)).rejects.toThrow('falla después de auditar')
    } finally {
      spy.mockRestore()
    }
    expect(await estampas(c.id)).toMatchObject({ status: 'SCHEDULED', cancelledAt: null })
    expect(await prisma.activityLog.count({ where: { action: 'CLASS_SESSION_CANCELLED', entityId: c.id } })).toBe(0)
  })

  it('dos cancelaciones simultáneas: una gana, la otra 409, y queda el instante de la que ganó (barrera real)', async () => {
    const c = await nueva(m.ana)
    const barrera = await barreraDeLaFilaDeClase(c.id)
    const carrera = Promise.allSettled([cancelClassSession(m.venueId, c.id, m.owner), cancelClassSession(m.venueId, c.id, m.sofia)])
    try {
      await barrera.esperarA(2) // las dos detenidas en el UPDATE del reclamo
    } finally {
      await barrera.soltar()
    }
    const resultados = await carrera
    const ganadoras = resultados.filter(
      (x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof cancelClassSession>>> => x.status === 'fulfilled',
    )
    expect(ganadoras).toHaveLength(1)
    expect(resultados.find(x => x.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
    expect((await estampas(c.id)).cancelledAt).toEqual(ganadoras[0].value.cancelledAt)
    expect(await prisma.activityLog.count({ where: { action: 'CLASS_SESSION_CANCELLED', entityId: c.id } })).toBe(1)
  })
})
