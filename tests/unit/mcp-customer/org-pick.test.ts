import { issueOrgPickToken, verifyOrgPickToken, listActiveOrganizations } from '../../../src/mcp/oauth/orgPick'
import { renderLoginPage } from '../../../src/mcp/oauth/loginPage'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffOrganization: { findMany: jest.fn() } },
}))
const m = prisma as unknown as { staffOrganization: { findMany: jest.Mock } }

describe('org-pick token (carries step-1 identity to step-2 consent)', () => {
  it('round-trips the staffId', () => {
    const token = issueOrgPickToken('staff-123')
    expect(verifyOrgPickToken(token)).toBe('staff-123')
  })

  it('rejects a tampered token', () => {
    const token = issueOrgPickToken('staff-123')
    expect(verifyOrgPickToken(token.slice(0, -3) + 'xxx')).toBeNull()
    expect(verifyOrgPickToken('garbage')).toBeNull()
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
