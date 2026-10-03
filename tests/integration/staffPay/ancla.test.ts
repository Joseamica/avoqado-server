// tests/integration/staffPay/ancla.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, periodoCerrado, tablaMindform, TZ } from './_mundo'

let m: Mundo
let v1: string
let agosto: string
const AHORA = new Date('2026-10-01T12:00:00Z')
const rango = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
const filtro = (claseIds: string[], modo: 'vivo' | 'periodo' = 'periodo') => ({
  venueId: m.venueId,
  organizationId: m.orgId,
  tz: TZ,
  desde: rango.from,
  hasta: rango.to,
  ahora: AHORA,
  claseIds,
  modo,
  periodId: agosto,
})
const una = async (id: string, modo: 'vivo' | 'periodo' = 'periodo') => (await valorarClases(prisma, filtro([id], modo), { limite: 5 }))[0]

async function anclar(classSessionId: string, valuationDate: string, valuationVersionId: string | null) {
  await prisma.classSessionPayState.upsert({
    where: { classSessionId },
    create: { classSessionId, originPeriodId: agosto, valuationDate: fechaComoDbDate(valuationDate), valuationVersionId },
    update: { originPeriodId: agosto, valuationDate: fechaComoDbDate(valuationDate), valuationVersionId },
  })
}
async function lineaService(classSessionId: string, staffId: string, payLevelId: string, payLevelName: string, amount: number) {
  await prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: m.venueId,
      periodId: agosto,
      staffId,
      concept: 'SERVICE',
      sourceType: 'CLASS_SESSION',
      sourceId: classSessionId,
      payLevelId,
      payLevelName,
      amount: new Prisma.Decimal(amount),
      descriptor: {},
    },
  })
}

beforeAll(async () => {
  m = await crearMundo('ancla')
  v1 = (await tablaMindform(m)).versionId
  agosto = (await periodoCerrado(m, '2026-08-01', '2026-08-31')).id
})
afterAll(() => borrarMundo(m))

describe('valoración con ancla (spec §6.1)', () => {
  it('el modo vivo no ve clases ancladas; el modo periodo sí', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-10T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-10', v1)
    expect(await una(id, 'vivo')).toBeUndefined()
    expect(await una(id)).toMatchObject({ estado: 'OK', conteo: 8, periodoOrigen: agosto, tableVersionId: v1 })
  })

  it('una versión nueva NO cambia una clase anclada con la versión vieja', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-11T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-11', v1)
    const t2 = await prisma.servicePayTableVersion.create({
      data: {
        tableId: (await prisma.servicePayTableVersion.findUniqueOrThrow({ where: { id: v1 } })).tableId,
        effectiveFrom: fechaComoDbDate('2026-08-01'),
        revision: 2,
        maxCount: 10,
      },
    })
    await prisma.servicePayTableCell.createMany({
      data: [{ versionId: t2.id, payLevelId: m.hc, count: 8, amount: new Prisma.Decimal(999) }],
    })
    expect(Number((await una(id)).monto)).toBe(570)
    await prisma.servicePayTableVersion.delete({ where: { id: t2.id } })
  })

  it('una clase movida de fecha conserva su periodo y su tarifa de origen', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-12T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-12', v1)
    await prisma.classSession.update({
      where: { id },
      data: { startsAt: new Date('2026-09-20T14:00:00Z'), endsAt: new Date('2026-09-20T14:50:00Z') },
    })
    expect(await una(id)).toMatchObject({ estado: 'OK', fechaValoracion: '2026-08-12', periodoOrigen: agosto })
  })

  it('una revisión de nivel con fecha vieja no reescribe a quien ya tiene una línea en la clase', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-13T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-13', v1)
    await lineaService(id, m.ana, m.hc, 'Head Coach', 570)
    await prisma.staffPayLevelAssignment.create({
      data: { organizationId: m.orgId, staffId: m.ana, payLevelId: m.coach, effectiveFrom: fechaComoDbDate('2026-08-01'), revision: 2 },
    })
    expect(await una(id)).toMatchObject({ payLevelName: 'Head Coach' })
    expect(Number((await una(id)).monto)).toBe(570)
    await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: m.orgId, staffId: m.ana, revision: 2 } })
  })

  it('una suplente sin líneas se valora con SU nivel vigente en la fecha de valoración', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-14T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-14', v1)
    await lineaService(id, m.ana, m.hc, 'Head Coach', 570)
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia } })
    expect(await una(id)).toMatchObject({ staffId: m.sofia, payLevelName: 'Coach' })
    expect(Number((await una(id)).monto)).toBe(480)
  })

  it('una clase cancelada después del cierre vale $0 (EXCLUIDA) en modo periodo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-15T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-15', v1)
    await prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } })
    expect(await una(id)).toMatchObject({ estado: 'EXCLUIDA', monto: null, cancelada: true })
  })

  it('a la versión anclada le falta la celda del conteo corregido ⇒ excepción, nunca cero', async () => {
    const t = await prisma.servicePayTable.create({ data: { venueId: m.venueId, name: 'Corta', productIds: [m.productId] } })
    const corta = await prisma.servicePayTableVersion.create({
      data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 10 },
    })
    await prisma.servicePayTableCell.createMany({
      data: [{ versionId: corta.id, payLevelId: m.hc, count: 8, amount: new Prisma.Decimal(570) }],
    })
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-16T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-16', corta.id)
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    expect(await una(id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_MONTO_PARA_ESE_CONTEO', monto: null })
    // La tabla específica no puede quedarse: desplazaría a la general en las pruebas siguientes (Codex R1-13).
    // Su versión la referencia el ancla con `onDelete: Restrict` (Codex R2-R1-13): primero el ancla, las reservas y la
    // clase de prueba; después la tabla (que se lleva su versión en cascada).
    await prisma.classSessionPayState.delete({ where: { classSessionId: id } })
    await prisma.reservation.deleteMany({ where: { classSessionId: id } })
    await prisma.classSession.delete({ where: { id } })
    await prisma.servicePayTable.delete({ where: { id: t.id } })
  })

  it('si la primera línea se cerró SIN nivel (monto ajustado), una asignación posterior no le pone tarifa', async () => {
    const id = await clase(m, { staffId: m.carla, inicioIso: '2026-08-17T14:00:00Z', reservas: confirmadas(8) })
    await anclar(id, '2026-08-17', v1)
    await prisma.serviceEarning.create({
      data: {
        organizationId: m.orgId,
        venueId: m.venueId,
        periodId: agosto,
        staffId: m.carla,
        concept: 'SERVICE',
        sourceType: 'CLASS_SESSION',
        sourceId: id,
        payLevelId: null,
        payLevelName: null,
        amount: new Prisma.Decimal(500),
        descriptor: {},
      },
    })
    // Carla ya tiene nivel Coach desde enero; aun así, su primera línea en esta clase fue sin nivel.
    expect(await una(id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'COACH_SIN_NIVEL', payLevelName: null })
  })

  it('una clase sin ancla en las fechas del periodo cerrado (llegó tarde) sí es candidata', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
    expect(await una(id)).toMatchObject({ estado: 'OK', periodoOrigen: null })
    expect(await una(id, 'vivo')).toMatchObject({ estado: 'OK' })
  })
})
