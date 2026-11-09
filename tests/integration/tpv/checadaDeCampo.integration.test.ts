/**
 * La checada del celular (App de campo, bloque 0, Tarea 6) por la RUTA real (app + token) y contra Postgres REAL.
 *
 * Lo que el unit no puede probar: el candado de la persona en Postgres (dos entradas a la vez), los dos únicos de las
 * llaves, `requireVenueMembership` contra la base (dada de baja en la sucursal con token vivo) y el reemplazo de un cierre
 * automático con filas de verdad (descanso y nota; la bitácora, por la llamada a `logAction`, que el setup mockea).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "tpv/checadaDeCampo" --detectOpenHandles=false --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
let server: Server
let orgId: string
let venueId: string
let otraSucursalId: string
let promotorId: string

const H = 60 * 60 * 1000
/** «Las 09:00 de ayer»: una hora en punto de hace ~30 h, para que la salida de las «17:00» y el cierre de las «03:00» ya pasaron. */
const base = new Date(Math.floor((Date.now() - 30 * H) / H) * H)
const a = (horas: number) => new Date(base.getTime() + horas * H)

const token = () =>
  jwt.sign({ sub: promotorId, orgId, venueId, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })

const checar = (cual: 'entrada' | 'salida', body: Record<string, unknown>, sucursal = venueId) =>
  request(server).post(`/api/v1/tpv/campo/venues/${sucursal}/checadas/${cual}`).set('Authorization', `Bearer ${token()}`).send(body)

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Checada ${sufijo}`, email: `checada-${sufijo}@example.test`, phone: '5500000000' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Checada ${sufijo}`, slug: `checada-${sufijo}` } })).id
  otraSucursalId = (
    await prisma.venue.create({ data: { organizationId: orgId, name: `Checada B ${sufijo}`, slug: `checada-b-${sufijo}` } })
  ).id
  promotorId = (
    await prisma.staff.create({
      data: {
        email: `checada-promotor-${sufijo}@example.test`,
        firstName: 'Promotor',
        lastName: 'Checada',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        // Dado de baja en la otra sucursal: su token sigue vivo, pero ahí ya no checa.
        venues: {
          create: [
            { venueId, role: 'CASHIER', active: true },
            { venueId: otraSucursalId, role: 'CASHIER', active: false },
          ],
        },
      },
    })
  ).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

beforeEach(() => prisma.timeEntry.deleteMany({ where: { staffId: promotorId } }))

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  const sucursales = [venueId, otraSucursalId]
  await prisma.timeEntry.deleteMany({ where: { staffId: promotorId } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: sucursales } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: promotorId } })
  await prisma.venue.deleteMany({ where: { id: { in: sucursales } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('POST /tpv/campo/venues/:venueId/checadas/*', () => {
  it('entrada y salida con la hora del celular; la misma llave otra vez devuelve lo mismo; el descanso abierto cierra con la salida', async () => {
    const llaveEntrada = randomUUID()
    const cuerpo = { llave: llaveEntrada, ocurrioAt: a(0).toISOString(), origenHora: 'RELOJ_ANCLADO', ubicacionFalsa: true, latitude: 19.4 }

    const res = await checar('entrada', cuerpo)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ timeEntryId: expect.any(String), repetida: false, hora: a(0).toISOString() })
    const otra = await checar('entrada', cuerpo)
    expect(otra.status).toBe(200)
    expect(otra.body).toEqual({ ...res.body, repetida: true })
    const fila = await prisma.timeEntry.findUniqueOrThrow({ where: { id: res.body.timeEntryId } })
    expect(fila).toMatchObject({
      staffId: promotorId,
      venueId,
      clockInTime: a(0),
      status: 'CLOCKED_IN',
      llaveEntrada,
      clockInOrigenHora: 'RELOJ_ANCLADO',
      clockInUbicacionFalsa: true,
      clockInLatitude: 19.4,
    })
    expect(await prisma.timeEntry.count({ where: { staffId: promotorId } })).toBe(1)

    // Un descanso abierto a las «12:00» (lo abrió la PAX): la salida de las «17:00» lo cierra ahí.
    const brk = await prisma.timeEntryBreak.create({ data: { timeEntryId: fila.id, startTime: a(3) } })
    await prisma.timeEntry.update({ where: { id: fila.id }, data: { status: 'ON_BREAK' } })
    // La salida guardada sin señal nombra su entrada por la llave.
    const salida = { llave: randomUUID(), llaveEntrada, ocurrioAt: a(8).toISOString(), origenHora: 'RELOJ_ANCLADO' }
    const antes = Date.now()

    const sal = await checar('salida', salida)

    expect(sal.status).toBe(200)
    expect(sal.body).toEqual({ timeEntryId: fila.id, repetida: false, hora: a(8).toISOString(), totalHours: 3 })
    const cerrada = await prisma.timeEntry.findUniqueOrThrow({ where: { id: fila.id } })
    expect(cerrada).toMatchObject({
      clockOutTime: a(8),
      status: 'CLOCKED_OUT',
      breakMinutes: 300,
      llaveSalida: salida.llave,
      clockOutOrigenHora: 'RELOJ_ANCLADO',
      autoClockOut: false,
    })
    expect(Number(cerrada.totalHours)).toBe(3)
    expect(cerrada.clockOutRecibidaAt!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
    expect((await prisma.timeEntryBreak.findUniqueOrThrow({ where: { id: brk.id } })).endTime).toEqual(a(8))

    const repetida = await checar('salida', salida)
    expect(repetida.status).toBe(200)
    expect(repetida.body).toEqual({ ...sal.body, repetida: true })
  })

  it('dos entradas a la vez con llaves distintas dejan UNA sola; la otra recibe 409 YA_TIENE_ENTRADA con su id, sucursal y hora', async () => {
    const [x, y] = await Promise.all([checar('entrada', { llave: randomUUID() }), checar('entrada', { llave: randomUUID() })])

    expect([x.status, y.status].sort()).toEqual([201, 409])
    const [creada, rechazo] = x.status === 201 ? [x, y] : [y, x]
    const filas = await prisma.timeEntry.findMany({ where: { staffId: promotorId } })
    expect(filas).toHaveLength(1)
    expect(rechazo.body).toMatchObject({
      code: 'YA_TIENE_ENTRADA',
      timeEntryId: creada.body.timeEntryId,
      venueId,
      clockInTime: filas[0].clockInTime.toISOString(),
    })
  })

  it('una entrada guardada sin señal que cae dentro de un turno ya cerrado (PAX) → 409 ENTRADA_SE_ENCIMA con los datos del turno al mismo nivel', async () => {
    const pax = await prisma.timeEntry.create({
      data: { staffId: promotorId, venueId: otraSucursalId, clockInTime: a(0), clockOutTime: a(8), status: 'CLOCKED_OUT', totalHours: 8 },
    })

    const res = await checar('entrada', { llave: randomUUID(), ocurrioAt: new Date(a(0).getTime() - 5 * 60 * 1000).toISOString() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'ENTRADA_SE_ENCIMA',
      timeEntryId: pax.id,
      venueId: otraSucursalId,
      clockInTime: a(0).toISOString(),
      clockOutTime: a(8).toISOString(),
    })
    expect(await prisma.timeEntry.count({ where: { staffId: promotorId } })).toBe(1)
    // Justo a la hora de su salida sí se puede.
    expect((await checar('entrada', { llave: randomUUID(), ocurrioAt: a(8).toISOString() })).status).toBe(201)
  })

  it('la misma llave en otra sucursal o para otra entrada → 409 LLAVE_REUSADA (Codex C5); la salida guarda depósito y motivo (O2)', async () => {
    // Una entrada de OTRA sucursal con esta llave (de una PAX o de una subida anterior): no es esta checada.
    const llaveAjena = randomUUID()
    await prisma.timeEntry.create({
      data: {
        staffId: promotorId,
        venueId: otraSucursalId,
        clockInTime: a(-20),
        clockOutTime: a(-19),
        status: 'CLOCKED_OUT',
        llaveEntrada: llaveAjena,
      },
    })
    const ajena = await checar('entrada', { llave: llaveAjena, ocurrioAt: a(0).toISOString() })
    expect(ajena.status).toBe(409)
    expect(ajena.body.code).toBe('LLAVE_REUSADA')

    const e1 = await checar('entrada', { llave: randomUUID(), ocurrioAt: a(0).toISOString() })
    const llaveSalida = randomUUID()
    const s1 = await checar('salida', {
      llave: llaveSalida,
      timeEntryId: e1.body.timeEntryId,
      ocurrioAt: a(8).toISOString(),
      depositPhotoUrl: 'https://fotos.test/deposito.jpg',
      skipReason: 'No hubo ventas',
    })
    expect(s1.status).toBe(200)
    expect(await prisma.timeEntry.findUniqueOrThrow({ where: { id: e1.body.timeEntryId } })).toMatchObject({
      depositPhotoUrl: 'https://fotos.test/deposito.jpg',
      checkoutSkipReason: 'No hubo ventas',
    })

    // La misma llave de salida, pero nombrando OTRA entrada: no es la salida que se hizo.
    const e2 = await checar('entrada', { llave: randomUUID(), ocurrioAt: a(9).toISOString() })
    const otra = await checar('salida', { llave: llaveSalida, timeEntryId: e2.body.timeEntryId, ocurrioAt: a(10).toISOString() })
    expect(otra.status).toBe(409)
    expect(otra.body.code).toBe('LLAVE_REUSADA')
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: e2.body.timeEntryId } })).clockOutTime).toBeNull()
  })

  it('una persona dada de baja en la sucursal de la dirección, con su token vivo → 403 en entrada y salida, y nada se escribe', async () => {
    const entrada = await checar('entrada', { llave: randomUUID() }, otraSucursalId)
    const salida = await checar('salida', { llave: randomUUID(), llaveEntrada: randomUUID() }, otraSucursalId)

    expect([entrada.status, salida.status]).toEqual([403, 403])
    expect(await prisma.timeEntry.count({ where: { staffId: promotorId } })).toBe(0)
  })

  it('el cierre automático cerró a las «03:00» la entrada y su descanso de las «12:00»: la salida real de las «17:00» lo reemplaza, con nota y bitácora; otra salida después → 409 YA_TIENE_SALIDA', async () => {
    const auto = await prisma.timeEntry.create({
      data: {
        staffId: promotorId,
        venueId,
        clockInTime: a(0),
        clockOutTime: a(18),
        status: 'CLOCKED_OUT',
        totalHours: 18,
        autoClockOut: true,
        autoClockOutNote: '[Sistema] Salida automática: Hora de cierre programada (03:00)',
        breaks: { create: { startTime: a(3), endTime: a(18) } },
      },
      include: { breaks: true },
    })

    const res = await checar('salida', { llave: randomUUID(), timeEntryId: auto.id, ocurrioAt: a(8).toISOString() })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ timeEntryId: auto.id, repetida: false, hora: a(8).toISOString(), totalHours: 3 })
    const fila = await prisma.timeEntry.findUniqueOrThrow({ where: { id: auto.id }, include: { breaks: true } })
    expect(fila).toMatchObject({ clockOutTime: a(8), autoClockOut: false, breakMinutes: 300 })
    expect(Number(fila.totalHours)).toBe(3)
    // En la zona del negocio (la sucursal nace con America/Mexico_City), p. ej. «03:00 del 4-nov (America/Mexico_City)».
    expect(fila.notes).toMatch(
      /^Salida real del celular; reemplazó el cierre automático de \d{2}:\d{2} del \d{1,2}-[a-z]{3} \(America\/Mexico_City\)$/,
    )
    expect(fila.breaks[0]).toMatchObject({ startTime: a(3), endTime: a(8) })
    // `logAction` lo mockea el setup de integración (tests/__helpers__/integration-setup.ts): se revisa la llamada.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: promotorId,
        venueId,
        action: 'TIME_ENTRY_AUTO_CLOCKOUT_REPLACED',
        entity: 'TimeEntry',
        entityId: auto.id,
      }),
    )

    const otra = await checar('salida', { llave: randomUUID(), timeEntryId: auto.id, ocurrioAt: a(9).toISOString() })
    expect(otra.status).toBe(409)
    expect(otra.body.code).toBe('YA_TIENE_SALIDA')
  })
})
