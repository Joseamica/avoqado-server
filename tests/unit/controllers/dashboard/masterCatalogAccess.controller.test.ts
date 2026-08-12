import type { Request, Response } from 'express'

jest.mock('@/services/master-catalog/catalogAuthorization.service', () => ({
  authorizeCatalogRequest: jest.fn(),
}))
jest.mock('@/services/master-catalog/masterCatalogAccess.service', () => ({
  resolveMasterCatalogAccess: jest.fn(),
}))

import { getAccess } from '@/controllers/dashboard/masterCatalog.dashboard.controller'
import { authorizeCatalogRequest } from '@/services/master-catalog/catalogAuthorization.service'
import { resolveMasterCatalogAccess } from '@/services/master-catalog/masterCatalogAccess.service'

const mockedAuthorize = jest.mocked(authorizeCatalogRequest)
const mockedResolve = jest.mocked(resolveMasterCatalogAccess)

const ORG_ID = 'cmsq3py1n0000c9a0m1qt2q38'

function responseDouble() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: any }
}

function request() {
  return {
    params: { orgId: ORG_ID },
    query: {},
    authContext: { userId: 'staff-1', orgId: ORG_ID, venueId: 'venue-1', role: 'OWNER' },
  } as unknown as Request
}

/**
 * The access envelope is what the dashboard uses to decide whether to render a
 * writer surface at all, so every capability it reports has to be resolved for
 * real. Reporting one capability's verdict under another capability's question
 * is how a screen ends up permanently read-only for everyone.
 */
function accessFor(capability: string) {
  const mutating = capability === 'MUTATE_CONTENT' || capability === 'MANAGE_PROFILE'
  return {
    organizationId: ORG_ID,
    orgRole: 'OWNER' as const,
    entitlementActive: true,
    moduleActive: true,
    config: {
      schemaVersion: 1 as const,
      catalogCoreEnabled: true,
      identifiersEnabled: false,
      regionalPricingEnabled: false,
      governanceMode: 'ADVISORY' as const,
    },
    reasonCode: 'ACCESSIBLE' as const,
    canRead: capability === 'READ_CONTENT',
    canMutateContent: mutating,
    canConfigureControlPlane: false,
  }
}

/**
 * The route wrapper is deliberately not async — it fires the handler and hands
 * rejections to `next`. Awaiting the call itself would assert before the
 * handler ran, so the pending microtasks have to be flushed explicitly.
 */
async function invoke(res: Response) {
  const failures: unknown[] = []
  getAccess(request(), res, ((error: unknown) => failures.push(error)) as never)
  await new Promise(resolve => setImmediate(resolve))
  if (failures.length) throw failures[0]
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedAuthorize.mockResolvedValue({ organizationId: ORG_ID, actor: { type: 'HUMAN', staffId: 'staff-1', impersonating: false } } as never)
  mockedResolve.mockImplementation((async (input: any) => accessFor(input.capability)) as never)
})

describe('GET /organizations/:orgId/master-catalog/access', () => {
  it('resolves the write capability instead of inferring it from the read answer', async () => {
    const res = responseDouble()
    await invoke(res)

    const asked = mockedResolve.mock.calls.map(call => (call[0] as any).capability)
    expect(asked).toContain('READ_CONTENT')
    expect(asked).toContain('MUTATE_CONTENT')
  })

  it('reports canMutateContent for an OWNER, so the writer surfaces render', async () => {
    const res = responseDouble()
    await invoke(res)

    expect(res.statusCode).toBe(200)
    expect(res.body.data.canRead).toBe(true)
    expect(res.body.data.canMutateContent).toBe(true)
    expect(res.body.data.reasonCode).toBe('ACCESSIBLE')
    expect(res.body.data.orgRole).toBe('OWNER')
  })

  it('keeps a VIEWER read-only', async () => {
    mockedResolve.mockImplementation((async (input: any) => {
      const base = accessFor(input.capability)
      return { ...base, orgRole: 'VIEWER' as const, canMutateContent: false }
    }) as never)

    const res = responseDouble()
    await invoke(res)

    expect(res.body.data.canRead).toBe(true)
    expect(res.body.data.canMutateContent).toBe(false)
  })

  it('never grants write when read itself was denied', async () => {
    // Fail closed: a caller that cannot read the catalog cannot write it either,
    // whatever the mutation resolver happens to answer in isolation.
    mockedResolve.mockImplementation((async (input: any) => {
      const base = accessFor(input.capability)
      if (input.capability === 'READ_CONTENT') return { ...base, canRead: false, reasonCode: 'ROLE_DENIED' as const }
      return base
    }) as never)

    const res = responseDouble()
    await invoke(res)

    expect(res.body.data.canRead).toBe(false)
    expect(res.body.data.canMutateContent).toBe(false)
  })

  it('never reports control-plane configuration from this endpoint', async () => {
    const res = responseDouble()
    await invoke(res)

    expect(res.body.data.canConfigureControlPlane).toBe(false)
  })
})
