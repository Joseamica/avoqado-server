import {
  issueOrgPickToken,
  verifyOrgPickToken,
  verificarTokenDelSelector,
  listActiveOrganizations,
  tokenParaElSelector,
} from '../../../src/mcp/oauth/orgPick'
import { renderLoginPage } from '../../../src/mcp/oauth/loginPage'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffOrganization: { findMany: jest.fn() }, staff: { findUnique: jest.fn() } },
}))
// El corte de sesión (cambio de contraseña / cerrar todo) lo decide la regla real; aquí su veredicto.
let mockCorte: string | null = null
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeConcesionInvalidada: async () => mockCorte,
  emisionDelToken: jest.requireActual('@/utils/passwordChangeGuard').emisionDelToken,
}))
const m = prisma as unknown as { staffOrganization: { findMany: jest.Mock }; staff: { findUnique: jest.Mock } }

beforeEach(() => {
  mockCorte = null
  m.staff.findUnique.mockReset().mockResolvedValue({ active: true })
})

describe('org-pick token (carries step-1 identity to step-2 consent)', () => {
  it('round-trips the staffId', async () => {
    const token = issueOrgPickToken('staff-123')
    expect(await verifyOrgPickToken(token)).toBe('staff-123')
  })

  it('rejects a tampered token', async () => {
    const token = issueOrgPickToken('staff-123')
    expect(await verifyOrgPickToken(token.slice(0, -3) + 'xxx')).toBeNull()
    expect(await verifyOrgPickToken('garbage')).toBeNull()
  })

  // H4 (Codex gpt-6-astra, 2ª pasada): el token sólo llevaba identidad y caducidad.
  it('🔴 si la persona cambió su contraseña o cerró sus sesiones DESPUÉS de emitirse, ya no sirve', async () => {
    const token = issueOrgPickToken('staff-123')
    mockCorte = 'PASSWORD_CHANGED'
    expect(await verifyOrgPickToken(token)).toBeNull()
  })

  it('🔴 una cuenta desactivada ya no sirve', async () => {
    const token = issueOrgPickToken('staff-123')
    m.staff.findUnique.mockResolvedValue({ active: false })
    expect(await verifyOrgPickToken(token)).toBeNull()
  })
})

describe('tokenParaElSelector (H4: no se renueva)', () => {
  it('🔴 si ya venía de un token de selección, se reusa ESE (no se emite uno nuevo con reloj nuevo)', () => {
    // Distinguible a propósito: dos tokens de la misma persona en el mismo segundo salen IDÉNTICOS,
    // y la prueba pasaría aunque se reemitiera.
    const previo = 'token-de-seleccion-previo'
    expect(tokenParaElSelector(previo, 'staff-123')).toBe(previo)
  })

  it('en el paso 1 (sin token previo) se emite uno', async () => {
    const nuevo = tokenParaElSelector(undefined, 'staff-9')
    expect(await verifyOrgPickToken(nuevo)).toBe('staff-9')
  })
})

describe('listActiveOrganizations', () => {
  it('maps active memberships (primary first) to picker options', async () => {
    m.staffOrganization.findMany.mockResolvedValueOnce([
      { role: 'OWNER', organization: { id: 'org-a', name: 'Grupo Avoqado Prime' } },
      { role: 'MEMBER', organization: { id: 'org-b', name: 'PlayTelecom' } },
    ])
    const orgs = await listActiveOrganizations('staff-1')
    expect(orgs).toEqual([
      { id: 'org-a', name: 'Grupo Avoqado Prime', role: 'OWNER' },
      { id: 'org-b', name: 'PlayTelecom', role: 'MEMBER' },
    ])
    expect(m.staffOrganization.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { staffId: 'staff-1', isActive: true } }))
  })
})

describe('renderLoginPage orgPick variant', () => {
  const params = { clientId: 'c1', redirectUri: 'https://claude.ai/cb', codeChallenge: 'x', clientName: 'Claude' }

  it('renders one radio per org (first checked), the pick token, and the OAuth params', () => {
    const html = renderLoginPage(params, {
      orgPick: {
        orgs: [
          { id: 'org-a', name: 'Grupo Avoqado Prime', role: 'OWNER' },
          { id: 'org-b', name: 'PlayTelecom', role: 'MEMBER' },
        ],
        token: 'pick-token-abc',
      },
    })
    expect(html).toContain('Elige la organización')
    expect((html.match(/type="radio" name="org"/g) ?? []).length).toBe(2)
    expect(html).toContain('value="org-a" checked')
    expect(html).toContain('Grupo Avoqado Prime')
    expect(html).toContain('name="orgPickToken" value="pick-token-abc"')
    expect(html).toContain('name="client_id" value="c1"') // OAuth params still travel with the pick
    expect(html).not.toContain('type="password"') // step 2 never asks for credentials again
  })
})

// ─── Codex ronda 9, P1: la autorización nacía con la hora del INSERT, no con la de la identidad ──
// Validar el selector → cambiar la contraseña → crear el código: el código (y toda su cadena) quedaba
// «posterior» al corte. Ahora el selector lleva la hora en que se VERIFICÓ la identidad, y la entrega.
describe('Codex ronda 9 — el selector lleva la hora de la verificación, no la de su emisión', () => {
  it('el token del selector conserva la hora en que se verificó la contraseña o la sesión', async () => {
    const verificada = new Date(Date.now() - 60_000)
    const token = issueOrgPickToken('staff-123', verificada)
    expect(await verificarTokenDelSelector(token)).toEqual({ staffId: 'staff-123', verificadoEn: verificada })
  })

  it('reusarlo NO cambia esa hora', async () => {
    const verificada = new Date(Date.now() - 60_000)
    const previo = issueOrgPickToken('staff-123', verificada)
    const reusado = tokenParaElSelector(previo, 'staff-123', new Date())
    expect((await verificarTokenDelSelector(reusado))?.verificadoEn).toEqual(verificada)
  })

  it('en el paso 1 se emite con la hora de verificación que le pasen', async () => {
    const verificada = new Date(Date.now() - 30_000)
    const token = tokenParaElSelector(undefined, 'staff-123', verificada)
    expect((await verificarTokenDelSelector(token))?.verificadoEn).toEqual(verificada)
  })
})
