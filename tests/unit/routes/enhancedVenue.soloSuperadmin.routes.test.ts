/**
 * POST /dashboard/venues/enhanced (alta avanzada de negocio) es SÓLO de superadmin — decisión «A» del founder, 17-nov-2026
 * (hz:nube0000:na5adb84). Con `venues:manage` un dueño o un administrador podía crear un negocio ligado a la cuenta de cobro de
 * otro negocio (1b) y fijarse su propia tarifa desde 0 % (P1 de la deuda). Ahora el guardia es el de las rutas de superadmin
 * (`authorizeRole([StaffRole.SUPERADMIN])`, que relee el rol de la base): 403 en español para todos los demás.
 *
 * Corre el guardia REAL de la ruta (sólo la base va simulada).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import router from '@/routes/dashboard.routes'

function guardiaDelAlta() {
  const capa = (router as any).stack.find((l: any) => l.route?.path === '/venues/enhanced' && l.route.methods?.post)
  expect(capa).toBeDefined()
  // [autenticación, guardia, validación, controlador]
  return capa.route.stack[1].handle as (req: any, res: any, next: () => void) => Promise<void>
}

async function correr(rol: 'OWNER' | 'ADMIN', esSuperadmin = false) {
  prismaMock.staff.findUnique.mockResolvedValue({ active: true })
  prismaMock.staffVenue.findFirst.mockImplementation(async ({ where }: any) => {
    if (where?.role === 'SUPERADMIN') return esSuperadmin ? { id: 'sv-sa' } : null
    return !where?.role || where.role === rol ? { id: 'sv-1', role: rol } : null
  })
  prismaMock.staffVenue.findUnique.mockResolvedValue({ role: rol, active: true, permissionSetId: null, permissionSet: null })
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' })
  prismaMock.staffOrganization.findUnique.mockResolvedValue({ isActive: true, role: rol === 'OWNER' ? 'OWNER' : 'MEMBER' })
  prismaMock.staffOrganization.findFirst.mockResolvedValue(rol === 'OWNER' ? { id: 'so-1' } : null)

  const req: any = {
    method: 'POST',
    originalUrl: '/api/v1/dashboard/venues/enhanced',
    params: {},
    headers: {},
    body: {},
    authContext: { userId: 'u1', orgId: 'org-1', venueId: 'v1', role: esSuperadmin ? 'SUPERADMIN' : rol },
    get: () => undefined,
  }
  const out: { status?: number; json?: any; next: boolean } = { next: false }
  const res: any = { status: (s: number) => ((out.status = s), res), json: (j: unknown) => ((out.json = j), res) }
  await guardiaDelAlta()(req, res, () => {
    out.next = true
  })
  return out
}

describe('alta avanzada de negocio · sólo superadmin (decisión «A», na5adb84)', () => {
  it.each(['OWNER', 'ADMIN'] as const)('🔴 un %s con venues:manage recibe 403 en español y no pasa', async rol => {
    const out = await correr(rol)

    expect(out.next).toBe(false)
    expect(out.status).toBe(403)
    expect(out.json?.message).toMatch(/Acceso denegado/)
  })

  it('control — un superadmin pasa', async () => {
    const out = await correr('OWNER', true)

    expect(out.next).toBe(true)
    expect(out.status).toBeUndefined()
  })
})
