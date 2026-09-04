/**
 * Equipo de la organización: la pantalla tiene que decir la VERDAD.
 *
 * Nació de un incidente real (Asana 1218125347443126, 4-sep-2026): la terminal
 * `AVQD-2840744306` de BAE CANDILES respondía «Pin Incorrecto» durante dos días.
 * El PIN estaba bien y la membresía estaba activa — lo apagado era `Staff.active`,
 * la CUENTA. El login de la TPV exige las tres cosas y devuelve el mismo 404 para
 * las tres, a propósito, para que nadie pueda enumerar PINes.
 *
 * El operador no tenía forma de saberlo porque esta pantalla —la única que podía
 * decírselo— devolvía `status: 'ACTIVE'` escrito a mano, y su botón de activar
 * sólo toca `StaffVenue`. Cambió el PIN dos veces contra la única de las tres
 * condiciones que ya estaba bien.
 *
 * Estas pruebas fijan que la respuesta no pueda volver a mentir.
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

jest.mock('@/services/dashboard/commission/goal-resolution.service', () => ({
  getOrgGoals: jest.fn(),
  createOrgGoal: jest.fn(),
  updateOrgGoal: jest.fn(),
  deleteOrgGoal: jest.fn(),
}))

jest.mock('@/services/organization-dashboard/organizationDashboard.service', () => ({
  organizationDashboardService: {
    getOrgAttendanceConfig: jest.fn(),
    upsertOrgAttendanceConfig: jest.fn(),
    deleteOrgAttendanceConfig: jest.fn(),
    getOrgTpvDefaults: jest.fn(),
    upsertOrgTpvDefaults: jest.fn(),
    getOrgTpvStats: jest.fn(),
  },
}))

import organizationConfigRouter from '@/routes/dashboard/organizationConfig.routes'

const ORG_ID = 'org-test-123'
const VENUE_A = 'venue-aaa'
const VENUE_B = 'venue-bbb'
const STAFF_ID = 'staff-isaac-promotor'

const superadminContext = { userId: 'user-1', orgId: ORG_ID, venueId: VENUE_A, role: 'SUPERADMIN' }
const header = ['x-test-auth-context', JSON.stringify(superadminContext)] as [string, string]

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/dashboard/organizations/:orgId', organizationConfigRouter)
  return app
}

/** Fila de `StaffOrganization` tal como la arma el include del handler. */
function staffOrgFixture(staffActive: boolean, venues: Array<{ id: string; name: string; active: boolean; pin: string | null }>) {
  return {
    staffId: STAFF_ID,
    organizationId: ORG_ID,
    isActive: true,
    role: 'MEMBER',
    staff: {
      id: STAFF_ID,
      firstName: 'Isaac',
      lastName: 'Promotor',
      email: 'isaac@internal.avoqado.io',
      phone: null,
      photoUrl: null,
      employeeCode: null,
      active: staffActive,
      venues: venues.map((v, i) => ({
        id: `sv-${i}`,
        role: 'WAITER',
        active: v.active,
        pin: v.pin,
        venue: { id: v.id, name: v.name, slug: v.name.toLowerCase() },
      })),
    },
  }
}

describe('Equipo de la organización — la respuesta no puede mentir', () => {
  let server: Server

  beforeAll(() => {
    server = createApp().listen(0)
  })

  afterAll(done => {
    server.close(done)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. GET /team — el estado sale de Staff.active, no de una cadena fija
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET /team', () => {
    it('reporta INACTIVE cuando la CUENTA está desactivada (el caso de Isaac Promotor)', async () => {
      prismaMock.staffOrganization.findMany.mockResolvedValue([
        staffOrgFixture(false, [{ id: VENUE_A, name: 'BAE CANDILES', active: true, pin: '1292' }]),
      ] as any)

      const res = await request(server).get(`/dashboard/organizations/${ORG_ID}/team`).set(...header)

      expect(res.status).toBe(200)
      const miembro = res.body.data[0]
      // 🔴 Lo que costó dos días: la membresía está activa y aun así NO puede entrar.
      expect(miembro.venues[0].active).toBe(true)
      expect(miembro.status).toBe('INACTIVE')
      expect(miembro.accountActive).toBe(false)
    })

    it('reporta ACTIVE cuando la cuenta está activa (regresión)', async () => {
      prismaMock.staffOrganization.findMany.mockResolvedValue([
        staffOrgFixture(true, [{ id: VENUE_A, name: 'BAE CANDILES', active: true, pin: '1292' }]),
      ] as any)

      const res = await request(server).get(`/dashboard/organizations/${ORG_ID}/team`).set(...header)

      expect(res.status).toBe(200)
      expect(res.body.data[0].status).toBe('ACTIVE')
      expect(res.body.data[0].accountActive).toBe(true)
    })

    it('sigue entregando las sucursales con su rol y su PIN (regresión del contrato)', async () => {
      prismaMock.staffOrganization.findMany.mockResolvedValue([
        staffOrgFixture(true, [
          { id: VENUE_A, name: 'BAE CANDILES', active: true, pin: '1292' },
          { id: VENUE_B, name: 'BAE QUINTANA', active: false, pin: null },
        ]),
      ] as any)

      const res = await request(server).get(`/dashboard/organizations/${ORG_ID}/team`).set(...header)

      const venues = res.body.data[0].venues
      expect(venues).toHaveLength(2)
      expect(venues[0]).toMatchObject({ id: VENUE_A, name: 'BAE CANDILES', role: 'WAITER', active: true, pin: '1292' })
      expect(venues[1]).toMatchObject({ id: VENUE_B, active: false, pin: null })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. PATCH /status — avisa cuando encender la membresía NO alcanza
  // ═══════════════════════════════════════════════════════════════════════

  describe('PATCH /team/:staffId/status', () => {
    beforeEach(() => {
      prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: STAFF_ID } as any)
      prismaMock.venue.findMany.mockResolvedValue([{ id: VENUE_A }, { id: VENUE_B }] as any)
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 2 } as any)
    })

    it('activar con la CUENTA apagada devuelve 200 pero lo DICE', async () => {
      prismaMock.staff.findUnique.mockResolvedValue({ id: STAFF_ID, active: false } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/status`)
        .set(...header)
        .send({ active: true })

      expect(res.status).toBe(200)
      expect(res.body.data.accountActive).toBe(false)
      // No basta con que exista el campo: el operador tiene que leer qué hacer.
      expect(res.body.data.warning).toEqual(expect.stringContaining('cuenta'))
      expect(res.body.data.venuesUpdated).toBe(2)
    })

    it('activar con la cuenta viva no inventa advertencias', async () => {
      prismaMock.staff.findUnique.mockResolvedValue({ id: STAFF_ID, active: true } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/status`)
        .set(...header)
        .send({ active: true })

      expect(res.status).toBe(200)
      expect(res.body.data.accountActive).toBe(true)
      expect(res.body.data.warning).toBeNull()
    })

    it('🔴 NUNCA escribe Staff.active: esa persona puede trabajar en otras organizaciones', async () => {
      prismaMock.staff.findUnique.mockResolvedValue({ id: STAFF_ID, active: false } as any)

      await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/status`)
        .set(...header)
        .send({ active: true })

      expect(prismaMock.staff.update).not.toHaveBeenCalled()
      expect(prismaMock.staff.updateMany).not.toHaveBeenCalled()
    })

    it('desactivar no consulta la cuenta ni advierte (sólo aplica al encender)', async () => {
      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/status`)
        .set(...header)
        .send({ active: false })

      expect(res.status).toBe(200)
      expect(res.body.data.warning).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. PATCH /pin — un 200 que no dice CUÁNTAS sucursales tocó es un 200 mudo
  // ═══════════════════════════════════════════════════════════════════════

  describe('PATCH /team/:staffId/pin', () => {
    beforeEach(() => {
      prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: STAFF_ID } as any)
      prismaMock.venue.findMany.mockResolvedValue([{ id: VENUE_A }, { id: VENUE_B }] as any)
      prismaMock.staffVenue.findFirst.mockResolvedValue(null) // sin conflicto de PIN
    })

    it('devuelve en cuántas sucursales quedó el PIN', async () => {
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 2 } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/pin`)
        .set(...header)
        .send({ pin: '4321' })

      expect(res.status).toBe(200)
      expect(res.body.data.venuesUpdated).toBe(2)
      expect(res.body.data.warning).toBeNull()
    })

    it('🔴 CERO sucursales se avisa: poner el PIN antes de asignar la tienda no hace nada', async () => {
      prismaMock.staffVenue.updateMany.mockResolvedValue({ count: 0 } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/pin`)
        .set(...header)
        .send({ pin: '4321' })

      expect(res.status).toBe(200)
      expect(res.body.data.venuesUpdated).toBe(0)
      expect(res.body.data.warning).toEqual(expect.stringContaining('sucursal'))
    })

    it('sigue rechazando un PIN con formato inválido (regresión)', async () => {
      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/pin`)
        .set(...header)
        .send({ pin: 'abc' })

      expect(res.status).toBe(400)
      expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. PATCH /venues — una membresía nueva nace SIN PIN y hay que decirlo
  // ═══════════════════════════════════════════════════════════════════════

  describe('PATCH /team/:staffId/venues', () => {
    beforeEach(() => {
      prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: STAFF_ID } as any)
      prismaMock.venue.findMany.mockResolvedValue([
        { id: VENUE_A, name: 'BAE CANDILES' },
        { id: VENUE_B, name: 'BAE QUINTANA' },
      ] as any)
      prismaMock.timeEntry.findMany.mockResolvedValue([] as any)
      prismaMock.shift.findMany.mockResolvedValue([] as any)
    })

    it('🔴 avisa qué sucursales quedaron SIN PIN — ahí nadie puede entrar a la TPV', async () => {
      // Sólo tiene CANDILES (con PIN). Se le añade QUINTANA, que nace sin PIN.
      prismaMock.staffVenue.findMany.mockResolvedValue([
        { id: 'sv-a', venueId: VENUE_A, active: true, pin: '1292', role: 'WAITER', venue: { name: 'BAE CANDILES' } },
      ] as any)
      prismaMock.staffVenue.upsert.mockResolvedValue({ id: 'sv-b', venueId: VENUE_B, pin: null } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/venues`)
        .set(...header)
        .send({ venueIds: [VENUE_A, VENUE_B] })

      expect(res.status).toBe(200)
      expect(res.body.data.added).toBe(1)
      expect(res.body.data.addedWithoutPin).toEqual([{ venueId: VENUE_B, venueName: 'BAE QUINTANA' }])
    })

    it('una sucursal reasignada que CONSERVÓ su PIN no se reporta como huérfana', async () => {
      prismaMock.staffVenue.findMany.mockResolvedValue([
        { id: 'sv-b', venueId: VENUE_B, active: false, pin: '7777', role: 'WAITER', venue: { name: 'BAE QUINTANA' } },
      ] as any)
      prismaMock.staffVenue.upsert.mockResolvedValue({ id: 'sv-b', venueId: VENUE_B, pin: '7777' } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/venues`)
        .set(...header)
        .send({ venueIds: [VENUE_B] })

      expect(res.status).toBe(200)
      expect(res.body.data.added).toBe(1)
      expect(res.body.data.addedWithoutPin).toEqual([])
    })

    it('quitar una sucursal sigue liberando su PIN (regresión del @@unique)', async () => {
      prismaMock.staffVenue.findMany.mockResolvedValue([
        { id: 'sv-a', venueId: VENUE_A, active: true, pin: '1292', role: 'WAITER', venue: { name: 'BAE CANDILES' } },
      ] as any)
      prismaMock.staffVenue.update.mockResolvedValue({ id: 'sv-a' } as any)

      const res = await request(server)
        .patch(`/dashboard/organizations/${ORG_ID}/team/${STAFF_ID}/venues`)
        .set(...header)
        .send({ venueIds: [] })

      expect(res.status).toBe(200)
      expect(res.body.data.removed).toBe(1)
      expect(prismaMock.staffVenue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { active: false, pin: null } }),
      )
    })
  })
})
