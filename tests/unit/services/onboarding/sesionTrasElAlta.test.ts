/**
 * H0 (28-oct-2026): qué sucursal le toca a la sesión del alta cuando el alta ya terminó sin el navegador. La renovación
 * en sí (`renovarSesionConLaSucursal`) se prueba con «Entrar» en tests/unit/controllers/onboarding/sesionTrasElAlta.test.ts.
 */
import { sucursalDelAltaTerminada } from '@/services/onboarding/sesionTrasElAlta'
import { prismaMock } from '@tests/__helpers__/setup'

beforeEach(() => jest.clearAllMocks())

describe('sucursalDelAltaTerminada', () => {
  it('con el alta terminada (las dos marcas) devuelve la primera sucursal activa de esa persona en la organización', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      completedAt: new Date(),
      organization: { onboardingCompletedAt: new Date() },
    })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ venueId: 'venue-9' })

    await expect(sucursalDelAltaTerminada('staff-1', 'org-1')).resolves.toBe('venue-9')
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith({
      where: { staffId: 'staff-1', active: true, venue: { organizationId: 'org-1', status: { not: 'ONBOARDING' } } },
      orderBy: { venue: { createdAt: 'asc' } },
      select: { venueId: true },
    })
  })

  it.each([
    ['sin progreso de alta', null],
    ['progreso sin terminar', { completedAt: null, organization: { onboardingCompletedAt: null } }],
    ['🔴 marca temprana sin la organización', { completedAt: new Date(), organization: { onboardingCompletedAt: null } }],
  ])('%s → ninguna', async (_n, progreso) => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso)
    await expect(sucursalDelAltaTerminada('staff-1', 'org-1')).resolves.toBeNull()
    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
  })

  it('sin sucursal activa de esa persona → ninguna', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      completedAt: new Date(),
      organization: { onboardingCompletedAt: new Date() },
    })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    await expect(sucursalDelAltaTerminada('staff-1', 'org-1')).resolves.toBeNull()
  })

  it('sin organización en el token → ninguna, sin consultar', async () => {
    await expect(sucursalDelAltaTerminada('staff-1', undefined)).resolves.toBeNull()
    expect(prismaMock.onboardingProgress.findUnique).not.toHaveBeenCalled()
  })
})
