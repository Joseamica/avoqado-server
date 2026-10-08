/**
 * I4 (revisión final de la fase 3 «Pago al personal»): `PUT /organizations/:orgId` escribía el cuerpo tal cual.
 *
 * Escenario: un OWNER manda `{ "staffPayStartDate": null }` (rompe el «no vuelve a cambiar» del que dependen el barrido,
 * ANTES_DEL_INICIO y el aborto de la migración …000230) o `{ "seatCapExempt": true }` (el plan entero gratis, SERVICE_PAY
 * incluida). Hermano: `PUT /dashboard/venues/:venueId` también pasa el cuerpo casi entero (`Venue.seatCapExempt`,
 * `servicePayTables` anidadas). Arreglo MÍNIMO: esos campos responden 400 y nada se escribe. La lista blanca general de
 * las dos rutas es aparte (task_370d0fa6).
 */
import { updateOrganization } from '@/controllers/organization/organization.controller'
import { updateVenue } from '@/controllers/dashboard/venue.dashboard.controller'
import * as organizationService from '@/services/organization/organization.service'
import * as venueDashboardService from '@/services/dashboard/venue.dashboard.service'

jest.mock('@/services/organization/organization.service', () => ({ updateOrganization: jest.fn() }))
jest.mock('@/services/dashboard/venue.dashboard.service', () => ({ updateVenue: jest.fn() }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false) }))

const res = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() }) as any

async function organizacion(body: unknown) {
  const next = jest.fn()
  const r = res()
  await updateOrganization({ params: { orgId: 'org-1' }, body } as any, r, next)
  return { next, r }
}

async function sede(body: unknown) {
  const next = jest.fn()
  const r = res()
  await updateVenue({ params: { venueId: 'venue-1' }, body, authContext: { orgId: 'org-1', userId: 'u-1', role: 'OWNER' } } as any, r, next)
  return { next, r }
}

const rechazo = (next: jest.Mock) => next.mock.calls[0]?.[0]

beforeEach(() => {
  jest.clearAllMocks()
  ;(organizationService.updateOrganization as jest.Mock).mockResolvedValue({ id: 'org-1' })
  ;(venueDashboardService.updateVenue as jest.Mock).mockResolvedValue({ id: 'venue-1' })
})

describe('PUT /organizations/:orgId no escribe Pago al personal ni la exención de plan', () => {
  it.each([
    ['la fecha de inicio a null', { staffPayStartDate: null }, 'staffPayStartDate'],
    ['la fecha de inicio meses atrás', { name: 'Mindform', staffPayStartDate: '2026-01-01' }, 'staffPayStartDate'],
    ['la periodicidad', { servicePayPeriodicity: 'WEEKLY' }, 'servicePayPeriodicity'],
    ['el plan gratis', { seatCapExempt: true }, 'seatCapExempt'],
    [
      'relaciones anidadas',
      { staffPayLevels: { deleteMany: {} }, servicePayPeriods: { deleteMany: {} } },
      'staffPayLevels, servicePayPeriods',
    ],
  ])('rechaza %s con 400 y no escribe nada', async (_caso, body, campos) => {
    const { next, r } = await organizacion(body)
    expect(organizationService.updateOrganization).not.toHaveBeenCalled()
    expect(r.json).not.toHaveBeenCalled()
    expect(rechazo(next)).toMatchObject({ statusCode: 400, code: 'CAMPOS_RESERVADOS' })
    expect(rechazo(next).message).toContain(campos)
  })

  it('los datos de siempre se siguen guardando igual (regresión)', async () => {
    const body = { name: 'Mindform', email: 'hola@mindform.mx', phone: '555', taxId: null, billingEmail: null, billingAddress: null }
    const { next, r } = await organizacion(body)
    expect(organizationService.updateOrganization).toHaveBeenCalledWith('org-1', body)
    expect(r.json).toHaveBeenCalledWith({ id: 'org-1' })
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Hermano: PUT /dashboard/venues/:venueId tampoco', () => {
  it.each([
    ['el plan gratis de la sede', { seatCapExempt: true }, 'seatCapExempt'],
    ['las tablas de pago anidadas', { name: 'Sede', servicePayTables: { deleteMany: {} } }, 'servicePayTables'],
  ])('rechaza %s con 400 y no escribe nada', async (_caso, body, campos) => {
    const { next, r } = await sede(body)
    expect(venueDashboardService.updateVenue).not.toHaveBeenCalled()
    expect(r.json).not.toHaveBeenCalled()
    expect(rechazo(next)).toMatchObject({ statusCode: 400, code: 'CAMPOS_RESERVADOS' })
    expect(rechazo(next).message).toContain(campos)
  })

  it('editar la sede como lo hace el dashboard sigue igual (regresión)', async () => {
    const body = { name: 'Sede', timezone: 'America/Mexico_City', salesEnabled: true }
    const { next, r } = await sede(body)
    expect(venueDashboardService.updateVenue).toHaveBeenCalledWith('org-1', 'venue-1', body, { skipOrgCheck: false })
    expect(r.status).toHaveBeenCalledWith(200)
    expect(next).not.toHaveBeenCalled()
  })
})
