/**
 * hz:f26b3afc:D4 (Codex r1-r3) — El asistente de alta de SUPERADMIN da la membresía de la organización ANTES de que la
 * invitación se acepte. Si el dueño invitado era el correo de un usuario demo (contraseña pública, va en el PDF), cualquiera
 * entraba con ella a ese negocio real. Prueba de comportamiento, no de texto: con un correo demo en el equipo, el paso de
 * invitaciones falla entero y no escribe membresía ni invitación (Codex r3 pidió esto en vez de ampliar la guardia).
 */
import cuid from 'cuid'
jest.mock('@/services/access/basePlan.service', () => ({ PAID_PLAN_TIER_CODES: [] }))
jest.mock('@/services/access/concederPlan', () => ({ exigirQueSePuedaConceder: jest.fn() }))
jest.mock('@/services/access/concederPlanDecision', () => ({ planesPedidos: jest.fn() }))
jest.mock('@/services/superadmin/settlementConfiguration.service', () => ({ bulkCreateSettlementConfigurations: jest.fn() }))
jest.mock('@/services/organization-payment-config.service', () => ({ getEffectivePaymentConfig: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: { enableModule: jest.fn() } }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendTeamInvitation: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/privateStorage.service', () => ({ signPrivateAttachmentUrl: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { createVenueWizard } from '@/controllers/superadmin/onboarding.controller'

const venueId = cuid()
const organizationId = cuid()
const p = prisma as any

const payload = (dueno: string) => ({
  organization: { mode: 'new', name: 'Negocio Real', email: 'a@example.org', phone: '5512345678' },
  venue: { name: 'Negocio Real', venueType: 'SALON' },
  team: {
    owner: { email: dueno, firstName: 'Dueña', lastName: 'X', role: 'OWNER' },
    additionalStaff: [{ email: 'ana@negocio.mx', firstName: 'Ana', lastName: 'Ruiz', role: 'WAITER' }],
  },
})

let res: any
beforeEach(() => {
  jest.clearAllMocks()
  const tx = {
    $executeRaw: jest.fn(),
    organization: { create: jest.fn().mockResolvedValue({ id: organizationId }) },
    venue: { create: jest.fn().mockResolvedValue({ id: venueId, slug: 'negocio-real' }) },
    venueSettings: { create: jest.fn() },
  }
  p.$transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx))
  p.venue.findUnique.mockResolvedValue(null)
  p.organization.findUnique.mockResolvedValue({ name: 'Negocio Real' })
  p.staff.findUnique.mockImplementation(async (args: any) =>
    args.where?.email === 'bloom@demo.avoqado.io' ? { id: 'staff-bloom', email: 'bloom@demo.avoqado.io' } : null,
  )
  p.staff.create.mockImplementation(async (args: any) => ({ id: cuid(), ...args.data }))
  p.staffOrganization.findUnique.mockResolvedValue(null)
  p.staffOrganization.create.mockResolvedValue({})
  p.invitation.create.mockResolvedValue({})
  res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
})

it('🔴 con un correo demo en el equipo, el paso de invitaciones falla y no escribe membresía ni invitación', async () => {
  await createVenueWizard({ body: payload('bloom@demo.avoqado.io'), authContext: { userId: cuid() } } as any, res, jest.fn())

  expect(p.staffOrganization.create).not.toHaveBeenCalled()
  expect(p.invitation.create).not.toHaveBeenCalled()
  const respuesta = res.json.mock.calls.at(-1)?.[0]
  expect(respuesta.steps).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'invitations', status: 'error' })]))
})

it('regresión: sin correos demo, invita al dueño y al equipo', async () => {
  await createVenueWizard({ body: payload('duena@negocio.mx'), authContext: { userId: cuid() } } as any, res, jest.fn())

  expect(p.invitation.create).toHaveBeenCalledTimes(2)
  expect(res.json.mock.calls.at(-1)?.[0].steps).toEqual(
    expect.arrayContaining([expect.objectContaining({ step: 'invitations', status: 'success' })]),
  )
})
