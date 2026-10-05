import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { pagoDeClase, guardarAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'

const key = `ajustes-${process.pid}-${Date.now()}`
let org: string, venue: string, product: string, ana: string, claseId: string

beforeAll(async () => {
  org = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venue = (await prisma.venue.create({ data: { organizationId: org, name: key, slug: key, timezone: 'America/Mexico_City' } })).id
  const cat = await prisma.menuCategory.create({ data: { venueId: venue, name: 'C', slug: `${key}-c`, availableDays: [] } })
  product = (
    await prisma.product.create({
      data: {
        venueId: venue,
        categoryId: cat.id,
        sku: `${key}-p`,
        name: 'Reformer',
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
  ).id
  const hc = (await prisma.staffPayLevel.create({ data: { organizationId: org, name: 'Head Coach' } })).id
  ana = (await prisma.staff.create({ data: { email: `${key}@example.test`, firstName: 'Ana', lastName: 'T', active: true } })).id
  await prisma.staffPayLevelAssignment.create({
    data: { organizationId: org, staffId: ana, payLevelId: hc, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1 },
  })
  const t = await prisma.servicePayTable.create({ data: { venueId: venue, name: 'Todas', productIds: [] } })
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 10 },
  })
  await prisma.servicePayTableCell.createMany({
    data: [0, 7, 8, 9].map(count => ({ versionId: v.id, payLevelId: hc, count, amount: new Prisma.Decimal(count * 70) })),
  })
  const s = new Date(Date.now() - 86400000)
  claseId = (
    await prisma.classSession.create({
      data: {
        venueId: venue,
        productId: product,
        startsAt: s,
        endsAt: new Date(s.getTime() + 3000000),
        duration: 50,
        capacity: 10,
        assignedStaffId: ana,
      },
    })
  ).id
  await prisma.reservation.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({
      venueId: venue,
      classSessionId: claseId,
      productId: product,
      confirmationCode: `${key}-${i}`,
      status: 'CONFIRMED' as const,
      startsAt: s,
      endsAt: new Date(s.getTime() + 3000000),
      duration: 50,
      blockedEndsAt: new Date(s.getTime() + 3000000),
      partySize: 1,
      confirmedAt: s,
    })),
  })
})
afterAll(async () => {
  if (!org) return
  if (venue) await prisma.activityLog.deleteMany({ where: { venueId: venue } })
  await prisma.venue.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: org } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: org } })
})

describe('ajustes de clase — feature nueva', () => {
  it('la tarjeta muestra conteo, nivel y monto', async () => {
    expect(await pagoDeClase(venue, claseId)).toMatchObject({
      estado: 'OK',
      conteo: 7,
      monto: '490.00',
      payLevelName: 'Head Coach',
      ajuste: null,
    })
  })
  it('corregir conteo deja ActivityLog en la tx con antes y después', async () => {
    const r = await guardarAjusteDeClase({
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: 8,
      payAmountOverride: null,
      payExcluded: false,
      reason: 'eran 8',
      actorId: ana,
    })
    expect(r).toMatchObject({ conteo: 8, conteoCalculado: 7, monto: '560.00' })
    const log = await prisma.activityLog.findFirstOrThrow({
      where: { entity: 'ClassSession', entityId: claseId, action: 'SERVICE_PAY_CLASS_ADJUSTED' },
    })
    expect(log.staffId).toBe(ana)
    expect(log.data).toMatchObject({ antes: null, despues: { payCountOverride: 8 } })
  })
  it('quitar todos los ajustes vuelve al cálculo', async () => {
    const r = await guardarAjusteDeClase({
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: null,
      payAmountOverride: null,
      payExcluded: false,
      reason: 'quitar ajuste',
      actorId: ana,
    })
    expect(r).toMatchObject({ conteo: 7, ajuste: null })
  })
  it('ajustar el monto lo usa tal cual y la tarjeta muestra el ajuste con su motivo', async () => {
    const r = await guardarAjusteDeClase({
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: null,
      payAmountOverride: 612.5,
      payExcluded: false,
      reason: '  bono por suplencia  ',
      actorId: ana,
    })
    expect(r).toMatchObject({
      estado: 'OK',
      monto: '612.50',
      conteo: 7,
      ajuste: { payCountOverride: null, payAmountOverride: '612.50', payExcluded: false, reason: 'bono por suplencia' },
    })
    expect(r.ajuste?.at).toBeInstanceOf(Date)
  })
  it('excluir la clase la deja EXCLUIDA y sin monto; el log guarda el antes', async () => {
    const r = await guardarAjusteDeClase({
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: null,
      payAmountOverride: null,
      payExcluded: true,
      reason: 'clase de prueba',
      actorId: ana,
    })
    expect(r).toMatchObject({ estado: 'EXCLUIDA', monto: null, ajuste: { payExcluded: true } })
    const log = await prisma.activityLog.findFirstOrThrow({
      where: {
        entity: 'ClassSession',
        entityId: claseId,
        action: 'SERVICE_PAY_CLASS_ADJUSTED',
        data: { path: ['motivo'], equals: 'clase de prueba' },
      },
    })
    expect(log.data).toMatchObject({
      antes: { payAmountOverride: '612.50' },
      despues: { payExcluded: true, payAmountOverride: null },
      motivo: 'clase de prueba',
    })
    // Deja la clase como al principio para las demás pruebas.
    await guardarAjusteDeClase({
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: null,
      payAmountOverride: null,
      payExcluded: false,
      reason: 'quitar ajuste',
      actorId: ana,
    })
  })
})

describe('ajustes de clase — regresión', () => {
  it('otra sede no puede leer ni ajustar la clase', async () => {
    const otra = (
      await prisma.venue.create({ data: { organizationId: org, name: `${key}-x`, slug: `${key}-x`, timezone: 'America/Mexico_City' } })
    ).id
    await expect(pagoDeClase(otra, claseId)).rejects.toThrow('Clase no encontrada')
    await expect(
      guardarAjusteDeClase({
        venueId: otra,
        classSessionId: claseId,
        payCountOverride: 1,
        payAmountOverride: null,
        payExcluded: false,
        reason: 'x',
        actorId: ana,
      }),
    ).rejects.toThrow('Clase no encontrada')
  })
  it('una clase que no ha terminado dice NO_TERMINADA', async () => {
    const f = new Date(Date.now() + 86400000)
    const id = (
      await prisma.classSession.create({
        data: {
          venueId: venue,
          productId: product,
          startsAt: f,
          endsAt: new Date(f.getTime() + 3000000),
          duration: 50,
          capacity: 10,
          assignedStaffId: ana,
        },
      })
    ).id
    expect((await pagoDeClase(venue, id)).estado).toBe('NO_TERMINADA')
  })
  it('una clase cancelada dice CANCELADA', async () => {
    const s = new Date(Date.now() - 2 * 86400000)
    const id = (
      await prisma.classSession.create({
        data: {
          venueId: venue,
          productId: product,
          startsAt: s,
          endsAt: new Date(s.getTime() + 3000000),
          duration: 50,
          capacity: 10,
          assignedStaffId: ana,
          status: 'CANCELLED',
        },
      })
    ).id
    expect((await pagoDeClase(venue, id)).estado).toBe('CANCELADA')
  })
  it('el service revalida la forma (lo llamará el MCP sin la ruta) y no guarda nada', async () => {
    const base = {
      venueId: venue,
      classSessionId: claseId,
      payCountOverride: null,
      payAmountOverride: null,
      payExcluded: false,
      actorId: ana,
    }
    const logsAntes = await prisma.activityLog.count({ where: { entityId: claseId, action: 'SERVICE_PAY_CLASS_ADJUSTED' } })
    const estadoAntes = await prisma.classSessionPayState.findUnique({ where: { classSessionId: claseId } })
    await expect(guardarAjusteDeClase({ ...base, reason: '  ab  ' })).rejects.toThrow('Escribe el motivo (mínimo 3 letras)')
    await expect(guardarAjusteDeClase({ ...base, reason: 'x'.repeat(301) })).rejects.toThrow('Máximo 300 caracteres')
    await expect(guardarAjusteDeClase({ ...base, payCountOverride: -1, reason: 'conteo malo' })).rejects.toThrow('entero')
    await expect(guardarAjusteDeClase({ ...base, payCountOverride: 1.5, reason: 'conteo malo' })).rejects.toThrow('entero')
    await expect(guardarAjusteDeClase({ ...base, payCountOverride: 501, reason: 'conteo malo' })).rejects.toThrow('entero')
    await expect(guardarAjusteDeClase({ ...base, payAmountOverride: -1, reason: 'monto malo' })).rejects.toThrow('monto')
    await expect(guardarAjusteDeClase({ ...base, payAmountOverride: Number.NaN, reason: 'monto malo' })).rejects.toThrow('monto')
    await expect(guardarAjusteDeClase({ ...base, payAmountOverride: 2_000_000, reason: 'monto malo' })).rejects.toThrow('monto')
    await expect(guardarAjusteDeClase({ ...base, payExcluded: 'si' as unknown as boolean, reason: 'excluir mal' })).rejects.toThrow(
      'Excluir',
    )
    expect(await prisma.activityLog.count({ where: { entityId: claseId, action: 'SERVICE_PAY_CLASS_ADJUSTED' } })).toBe(logsAntes)
    expect(await prisma.classSessionPayState.findUnique({ where: { classSessionId: claseId } })).toEqual(estadoAntes)
  })
})
