// tests/integration/reservations/marcaFuentes.integration.test.ts
//
// Marca de reservaciones, por la ruta real (autenticación, candado de RESERVATIONS, validación, servicio y Postgres):
// guardar «Outfit» contestaba 400 porque el esquema validaba contra la lista vieja de 28 fuentes y el DASHBOARD ofrece 40
// (hz:a702b284:D3, 22-nov-2026).
import { randomUUID } from 'crypto'
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

// Antes de sembrar o limpiar: nunca la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(testDatabase.hostname) || !isDisposableH1Url(testDatabase)) {
  throw new Error('Esta suite exige una base de pruebas desechable validada.')
}

describe('Marca de reservaciones: fuentes (integración)', () => {
  const etiqueta = randomUUID().slice(0, 8)
  let server: Server
  let organizationId = ''
  let venueId = ''
  let staffId = ''
  let token = ''

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))
    const org = await prisma.organization.create({
      data: { name: `Marca ${etiqueta}`, email: `marca-${etiqueta}@example.test`, phone: '5555555555' },
    })
    organizationId = org.id
    const venue = await prisma.venue.create({
      data: { organizationId, name: `Marca ${etiqueta}`, slug: `marca-${etiqueta}`, seatCapExempt: true },
    })
    venueId = venue.id
    const staff = await prisma.staff.create({
      data: { email: `marca-${etiqueta}@example.test`, firstName: 'Dueña', lastName: 'Prueba', active: true },
    })
    staffId = staff.id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    token = jwt.sign({ sub: staffId, orgId: organizationId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  afterAll(async () => {
    await new Promise<void>(listo => server.close(() => listo()))
    if (!venueId) return
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.staff.deleteMany({ where: { id: staffId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  const ruta = () => `/api/v1/dashboard/venues/${venueId}/reservations/branding/config`
  const guardar = (body: object) => request(server).put(ruta()).set('Authorization', `Bearer ${token}`).send(body)
  const leer = () => request(server).get(ruta()).set('Authorization', `Bearer ${token}`)

  it('guarda «Outfit» y la vuelve a leer', async () => {
    const res = await guardar({ fontFamily: 'Outfit', accentColor: '#793a2a', buttonShape: 'square' })
    expect(res.status).toBe(200)
    const leida = await leer()
    expect(leida.status).toBe(200)
    expect(JSON.stringify(leida.body)).toContain('"fontFamily":"Outfit"')
  })

  it('una fuente fuera de la lista sigue contestando 400 con el motivo', async () => {
    const res = await guardar({ fontFamily: 'Comic Sans MS' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Error de validación/)
    const leida = await leer()
    expect(JSON.stringify(leida.body)).toContain('"fontFamily":"Outfit"')
  })
})
