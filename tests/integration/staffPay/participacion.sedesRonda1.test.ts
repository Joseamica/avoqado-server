// tests/integration/staffPay/participacion.sedesRonda1.test.ts — fase 3, B13 ronda 1 (R7): lo que faltaba probar.
// (a) La vista previa del ajuste manual por la RUTA REAL (app + token): quien sólo lee recibe 403 y no ve el aviso; el dueño, 200.
// (b) Dos sedes en zonas distintas (CDMX y Tijuana) en la pantalla de sedes: cada una con SU «hoy» (de noche, las 23:30 del 31-oct
//     en Tijuana ya son el 1-nov en CDMX) y el periodo de la sede que pregunta. Permisos reales; sólo el plan va simulado.
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { borrarMundo, crearMundo, crearSede, Mundo } from './_mundo'
import { activar, cobro, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  organizacionTieneServicePay: jest.fn(async () => ((global as any).__sedes ?? []).length > 0),
  venueHasServicePayAccess: jest.fn(async (v: string) => ((global as any).__sedes ?? []).includes(v)),
}))

let server: Server
let m: Mundo
let A: string
let B: string
let T: string

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
beforeEach(async () => {
  m = await crearMundo('part-sedes-r1')
  A = m.venueId
  B = (await crearSede(m.orgId, m.key, 'b')).venueId
  T = (await crearSede(m.orgId, m.key, 't')).venueId
  await prisma.venue.update({ where: { id: T }, data: { timezone: 'America/Tijuana' } })
  await prisma.staffVenue.createMany({
    data: [
      { staffId: m.owner, venueId: B, role: 'OWNER', active: true },
      { staffId: m.owner, venueId: T, role: 'OWNER', active: true },
    ],
  })
  ;(global as any).__sedes = [A, B, T]
})
afterEach(() => borrarMundo(m))

describe('(a) GET /adjustments/preview por la ruta real', () => {
  const token = (staffId: string, role: string) =>
    jwt.sign({ sub: staffId, orgId: m.orgId, venueId: A, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
  const pedir = (staffId: string, role: string) =>
    request(server)
      .get(`/api/v1/dashboard/venues/${A}/staff-pay/adjustments/preview`)
      .query({ sede: A, staffId: m.carla, amount: '-50', reason: 'Devolución de propina' })
      .set('Authorization', `Bearer ${token(staffId, role)}`)

  it('quien sólo lee (ADMIN: staffpay:read sin cerrar) ⇒ 403 del service; sin staffpay:read (MANAGER) ⇒ 403 de la ruta; el dueño ⇒ 200 con el aviso', async () => {
    await activar(m, { desde: '2026-07-01', sedes: [A], propinasDesde: '2026-07-01T06:00:00Z' })
    const lector = (await prisma.staff.create({ data: { email: `${m.key}-lector@example.test`, firstName: 'Lector', lastName: 'QA' } })).id
    await prisma.staffVenue.create({ data: { staffId: lector, venueId: A, role: 'ADMIN', active: true } })

    const soloLee = await pedir(lector, 'ADMIN')
    expect(soloLee.status).toBe(403)
    expect(soloLee.body.message).toBe('Para agregar un ajuste necesitas el permiso de cerrar periodos en esa sede')
    expect(soloLee.body.avisoPendientes).toBeUndefined()

    const sinLeer = await pedir(m.ana, 'MANAGER') // MANAGER en A: sin ningún permiso de pago al personal
    expect(sinLeer.status).toBe(403)
    expect(sinLeer.body.avisoPendientes).toBeUndefined()

    const dueno = await pedir(m.owner, 'OWNER')
    expect(dueno.status).toBe(200)
    expect(dueno.body).toMatchObject({ staffId: m.carla, amount: '-50.00', avisoPendientes: { n: 0, total: '0.00' } })
  })
})

describe('(b) dos sedes en zonas distintas en la pantalla de sedes', () => {
  it('a las 23:30 del 31-oct en Tijuana (00:30 del 1-nov en CDMX): cada sede con SU «hoy»; el periodo, el de quien pregunta', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    // B (CDMX) y T (Tijuana), las dos activas del 15 al 31-oct.
    await sedeActiva(m, B, '2026-10-15', '2026-10-31')
    await sedeActiva(m, T, '2026-10-15', '2026-10-31')
    // 00:10 del 1-nov en CDMX: un día que para B ya quedó fuera (y que todavía puede meter, activándola desde hoy).
    await cobro(m, { iso: '2026-11-01T06:10:00Z', propina: 25, servedById: m.carla, venueId: B })
    const ahora = new Date('2026-11-01T06:30:00Z') // Tijuana todavía en horario de verano (UTC−7): 23:30 del 31-oct

    const desdeCdmx = await estadoSedes({ userId: m.owner, venueId: A, ahora })
    const desdeTijuana = await estadoSedes({ userId: m.owner, venueId: T, ahora })
    expect(desdeCdmx.periodo).toEqual({ start: '2026-11-01', end: '2026-11-30' })
    expect(desdeTijuana.periodo).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    // Las sedes no dependen de quién pregunta: cada una con SU «hoy».
    expect(desdeTijuana.sedes).toEqual(desdeCdmx.sedes)
    const de = (venueId: string) => desdeCdmx.sedes.find(s => s.venueId === venueId)!
    // Tijuana: hoy es el 31-oct, su último día ⇒ ACTIVA; activarla otra vez sería desde mañana ⇒ hoy no se puede; nada fuera.
    expect(de(T)).toMatchObject({
      zona: 'America/Tijuana',
      estado: 'ACTIVA',
      desde: '2026-10-15',
      hasta: '2026-10-31',
      minimo: null,
      puedeActivar: false,
      puedeDesactivar: false,
      fueraEstePeriodo: { propinas: { n: 0, total: '0.00' } },
    })
    // CDMX: hoy ya es el 1-nov ⇒ SIN_ACTIVAR, se puede activar desde hoy y la propina de las 00:10 queda fuera.
    expect(de(B)).toMatchObject({
      zona: 'America/Mexico_City',
      estado: 'SIN_ACTIVAR',
      minimo: '2026-11-01',
      puedeActivar: true,
      fueraEstePeriodo: { propinas: { n: 1, total: '25.00' } },
    })
  })
})
