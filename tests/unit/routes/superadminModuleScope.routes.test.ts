import express from 'express'
import type { Server } from 'http'
import request from 'supertest'

const mockModuleFindUnique = jest.fn()
const mockModuleFindMany = jest.fn()
const mockModuleCreate = jest.fn()
const mockModuleUpdate = jest.fn()
const mockModuleDelete = jest.fn()
const mockVenueFindUnique = jest.fn()
const mockVenueFindMany = jest.fn()
const mockOrganizationFindUnique = jest.fn()
const mockOrganizationFindMany = jest.fn()
const mockVenueModuleFindFirst = jest.fn()
const mockVenueModuleFindUnique = jest.fn()
const mockVenueModuleFindMany = jest.fn()
const mockVenueModuleCount = jest.fn()
const mockVenueModuleUpsert = jest.fn()
const mockVenueModuleUpdate = jest.fn()
const mockVenueModuleDelete = jest.fn()
const mockOrganizationModuleFindUnique = jest.fn()
const mockOrganizationModuleFindMany = jest.fn()
const mockOrganizationModuleCount = jest.fn()
const mockOrganizationModuleUpsert = jest.fn()
const mockOrganizationModuleUpdate = jest.fn()
const mockQueryRaw = jest.fn()
const mockTransaction = jest.fn()

const transactionClient = {
  module: {
    findUnique: (...args: unknown[]) => mockModuleFindUnique(...(args as [])),
    update: (...args: unknown[]) => mockModuleUpdate(...(args as [])),
    delete: (...args: unknown[]) => mockModuleDelete(...(args as [])),
  },
  venueModule: {
    findUnique: (...args: unknown[]) => mockVenueModuleFindUnique(...(args as [])),
    count: (...args: unknown[]) => mockVenueModuleCount(...(args as [])),
    upsert: (...args: unknown[]) => mockVenueModuleUpsert(...(args as [])),
    update: (...args: unknown[]) => mockVenueModuleUpdate(...(args as [])),
  },
  organizationModule: {
    findUnique: (...args: unknown[]) => mockOrganizationModuleFindUnique(...(args as [])),
    count: (...args: unknown[]) => mockOrganizationModuleCount(...(args as [])),
    upsert: (...args: unknown[]) => mockOrganizationModuleUpsert(...(args as [])),
    update: (...args: unknown[]) => mockOrganizationModuleUpdate(...(args as [])),
  },
  $queryRaw: (...args: unknown[]) => mockQueryRaw(...(args as [])),
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    module: {
      findUnique: (...args: unknown[]) => mockModuleFindUnique(...(args as [])),
      findMany: (...args: unknown[]) => mockModuleFindMany(...(args as [])),
      create: (...args: unknown[]) => mockModuleCreate(...(args as [])),
      update: (...args: unknown[]) => mockModuleUpdate(...(args as [])),
      delete: (...args: unknown[]) => mockModuleDelete(...(args as [])),
    },
    venue: {
      findUnique: (...args: unknown[]) => mockVenueFindUnique(...(args as [])),
      findMany: (...args: unknown[]) => mockVenueFindMany(...(args as [])),
    },
    organization: {
      findUnique: (...args: unknown[]) => mockOrganizationFindUnique(...(args as [])),
      findMany: (...args: unknown[]) => mockOrganizationFindMany(...(args as [])),
    },
    venueModule: {
      findFirst: (...args: unknown[]) => mockVenueModuleFindFirst(...(args as [])),
      findUnique: (...args: unknown[]) => mockVenueModuleFindUnique(...(args as [])),
      findMany: (...args: unknown[]) => mockVenueModuleFindMany(...(args as [])),
      count: (...args: unknown[]) => mockVenueModuleCount(...(args as [])),
      upsert: (...args: unknown[]) => mockVenueModuleUpsert(...(args as [])),
      update: (...args: unknown[]) => mockVenueModuleUpdate(...(args as [])),
      delete: (...args: unknown[]) => mockVenueModuleDelete(...(args as [])),
      deleteMany: jest.fn(),
    },
    organizationModule: {
      findUnique: (...args: unknown[]) => mockOrganizationModuleFindUnique(...(args as [])),
      findMany: (...args: unknown[]) => mockOrganizationModuleFindMany(...(args as [])),
      count: (...args: unknown[]) => mockOrganizationModuleCount(...(args as [])),
      upsert: (...args: unknown[]) => mockOrganizationModuleUpsert(...(args as [])),
      update: (...args: unknown[]) => mockOrganizationModuleUpdate(...(args as [])),
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...(args as [])),
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [])),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))

import moduleRoutes from '@/routes/superadmin/module.routes'
import {
  enableModuleForOrganization,
  getAllOrganizations,
  getModulesForOrganization,
} from '@/controllers/dashboard/organizations.superadmin.controller'
import { moduleService } from '@/services/modules/module.service'

type Scope = 'BOTH' | 'ORGANIZATION_ONLY' | 'VENUE_ONLY'

const MODULE_ID = 'c123456789012345678901234'
const VENUE_ID = 'c223456789012345678901234'
const ORGANIZATION_ID = 'c323456789012345678901234'

function scopeAllows(condition: any, scope: Scope): boolean {
  if (!condition) return true
  if (typeof condition === 'string') return condition === scope
  if (Array.isArray(condition.in)) return condition.in.includes(scope)
  if (Array.isArray(condition.notIn)) return !condition.notIn.includes(scope)
  if (typeof condition.not === 'string') return condition.not !== scope
  return true
}

function definition(code: string, scope: Scope, overrides: Record<string, unknown> = {}) {
  return {
    id: code === 'MASTER_CATALOG' ? MODULE_ID : `c${code.toLowerCase().padEnd(24, '0').slice(0, 24)}`,
    code,
    name: code,
    description: null,
    scope,
    defaultConfig: {},
    presets: {},
    configSchema: {},
    active: true,
    venueModules: [],
    organizationModules: [],
    ...overrides,
  }
}

let moduleById: ReturnType<typeof definition>
let moduleByCode: ReturnType<typeof definition>
let lockedModule: ReturnType<typeof definition>
let moduleCandidates: Array<ReturnType<typeof definition>>

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/modules', moduleRoutes)
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(error.statusCode || 500).json({ message: error.message, code: error.code })
  })
  return app
}

function mockResponse() {
  const response: any = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((statusCode: number) => {
      response.statusCode = statusCode
      return response
    }),
    json: jest.fn((body: unknown) => {
      response.body = body
      return response
    }),
  }
  return response
}

async function callController(controller: any, requestShape: Record<string, unknown>) {
  const response = mockResponse()
  let forwarded: any
  await controller(requestShape, response, (error: unknown) => {
    forwarded = error
  })
  if (forwarded) throw forwarded
  return response
}

let server: Server

beforeAll(() => {
  server = createApp().listen(0)
})

afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  jest.clearAllMocks()
  moduleById = definition('SERIALIZED_INVENTORY', 'BOTH', { id: MODULE_ID })
  moduleByCode = definition('SERIALIZED_INVENTORY', 'BOTH', { id: MODULE_ID })
  lockedModule = moduleById
  moduleCandidates = [moduleById]

  mockModuleFindUnique.mockImplementation(async ({ where }: any) => (where.id ? moduleById : moduleByCode))
  mockModuleFindMany.mockImplementation(async ({ where }: any = {}) =>
    moduleCandidates.filter(candidate => scopeAllows(where?.scope, candidate.scope)),
  )
  mockModuleCreate.mockImplementation(async ({ data }: any) => definition(data.code, data.scope ?? 'BOTH', { ...data, id: MODULE_ID }))
  mockModuleUpdate.mockImplementation(async ({ data }: any) => ({ ...moduleById, ...data }))
  mockModuleDelete.mockResolvedValue(moduleById)
  mockVenueFindUnique.mockResolvedValue({ id: VENUE_ID, name: 'Venue test', organizationId: ORGANIZATION_ID })
  mockVenueFindMany.mockResolvedValue([])
  mockOrganizationFindUnique.mockResolvedValue({ id: ORGANIZATION_ID, name: 'Organization test', slug: 'organization-test' })
  mockOrganizationFindMany.mockResolvedValue([])
  mockVenueModuleFindFirst.mockResolvedValue(null)
  mockVenueModuleFindUnique.mockResolvedValue(null)
  mockVenueModuleFindMany.mockResolvedValue([])
  mockVenueModuleCount.mockResolvedValue(0)
  mockVenueModuleDelete.mockResolvedValue({ id: 'venue-module-stale' })
  mockOrganizationModuleFindUnique.mockResolvedValue(null)
  mockOrganizationModuleFindMany.mockResolvedValue([])
  mockOrganizationModuleCount.mockResolvedValue(0)
  mockQueryRaw.mockImplementation(async () => [lockedModule])
  mockTransaction.mockImplementation(async (callback: (tx: typeof transactionClient) => unknown) => callback(transactionClient))
})

describe('dedicated module definition routes — additive scope', () => {
  it('rejects an unknown scope through the real Zod boundary with a Spanish message', async () => {
    const response = await request(server).post('/modules').send({ code: 'NEW_MODULE', name: 'New', scope: 'GLOBAL' })

    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/alcance/i)
  })

  it('creates an explicit scope and configSchema while omitted scope remains BOTH', async () => {
    moduleByCode = null as never
    const explicit = await request(server)
      .post('/modules')
      .send({
        code: 'MASTER_CATALOG',
        name: 'Catálogo maestro',
        scope: 'ORGANIZATION_ONLY',
        defaultConfig: {},
        configSchema: { type: 'object' },
      })
    const legacy = await request(server).post('/modules').send({ code: 'LEGACY_MODULE', name: 'Legacy' })

    expect(explicit.status).toBe(201)
    expect(explicit.body.module.scope).toBe('ORGANIZATION_ONLY')
    expect(explicit.body.module.configSchema).toEqual({ type: 'object' })
    expect(legacy.status).toBe(201)
    expect(legacy.body.module.scope).toBe('BOTH')
  })

  it('locks then rejects narrowing to ORGANIZATION_ONLY when even a disabled VenueModule exists', async () => {
    mockVenueModuleCount.mockResolvedValue(1)

    const response = await request(server).patch(`/modules/${MODULE_ID}`).send({ scope: 'ORGANIZATION_ONLY' })

    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/VenueModule/i)
    expect(mockModuleUpdate).not.toHaveBeenCalled()
  })

  it('locks then rejects narrowing to VENUE_ONLY when even a disabled OrganizationModule exists', async () => {
    mockOrganizationModuleCount.mockResolvedValue(1)

    const response = await request(server).patch(`/modules/${MODULE_ID}`).send({ scope: 'VENUE_ONLY' })

    expect(response.status).toBe(400)
    expect(response.body.message ?? response.body.error).toMatch(/OrganizationModule/i)
    expect(mockModuleUpdate).not.toHaveBeenCalled()
  })

  it('rejects an unknown scope on PATCH before any transition query', async () => {
    const response = await request(server).patch(`/modules/${MODULE_ID}`).send({ scope: 'GLOBAL' })

    expect(response.status).toBe(400)
    expect(response.body.message).toMatch(/alcance/i)
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  it('updates scope and configSchema atomically when no incompatible assignment exists', async () => {
    const response = await request(server)
      .patch(`/modules/${MODULE_ID}`)
      .send({ scope: 'ORGANIZATION_ONLY', configSchema: { type: 'object' } })

    expect(response.status).toBe(200)
    expect(response.body.module.scope).toBe('ORGANIZATION_ONLY')
    expect(response.body.module.configSchema).toEqual({ type: 'object' })
    expect(mockQueryRaw).toHaveBeenCalled()
  })

  it('serializes scope narrowing against assignment creation and makes the losing writer revalidate', async () => {
    let releaseCount!: () => void
    let notifyCountEntered!: () => void
    const countEntered = new Promise<void>(resolve => {
      notifyCountEntered = resolve
    })
    const countGate = new Promise<void>(resolve => {
      releaseCount = resolve
    })
    let lockTail = Promise.resolve()

    // The fake transaction lock models PostgreSQL FOR UPDATE: each callback releases
    // only after its transaction ends, so the second writer observes the first scope.
    mockTransaction.mockImplementation(async (callback: (tx: any) => unknown) => {
      let releaseLock: (() => void) | undefined
      const tx = {
        ...transactionClient,
        $queryRaw: async (...args: unknown[]) => {
          const previous = lockTail
          lockTail = new Promise<void>(resolve => {
            releaseLock = resolve
          })
          await previous
          return mockQueryRaw(...args)
        },
      }
      try {
        return await callback(tx)
      } finally {
        releaseLock?.()
      }
    })
    mockVenueModuleCount.mockImplementation(async () => {
      notifyCountEntered()
      await countGate
      return 0
    })
    mockModuleUpdate.mockImplementation(async ({ data }: any) => {
      lockedModule = { ...lockedModule, ...data }
      moduleById = lockedModule
      moduleByCode = lockedModule
      return lockedModule
    })

    const transitionPromise = request(server)
      .patch(`/modules/${MODULE_ID}`)
      .send({ scope: 'ORGANIZATION_ONLY' })
      .then(response => response)
    const reachedLockedCount = await Promise.race([countEntered.then(() => true), transitionPromise.then(() => false)])
    if (!reachedLockedCount) {
      expect(reachedLockedCount).toBe(true)
      return
    }
    const assignmentPromise = moduleService.enableModule(VENUE_ID, 'SERIALIZED_INVENTORY', 'staff-1')
    const assignmentRejection = expect(assignmentPromise).rejects.toThrow(/organization/i)
    releaseCount()

    const transition = await transitionPromise
    expect(transition.status).toBe(200)
    await assignmentRejection
    expect(mockVenueModuleUpsert).not.toHaveBeenCalled()
  })

  it('returns scope additively from the generic module list', async () => {
    moduleCandidates = [definition('MASTER_CATALOG', 'ORGANIZATION_ONLY')]

    const response = await request(server).get('/modules')

    expect(response.status).toBe(200)
    expect(response.body.modules[0].scope).toBe('ORGANIZATION_ONLY')
  })
})

describe('venue module HTTP boundaries — ORGANIZATION_ONLY never leaks', () => {
  beforeEach(() => {
    moduleByCode = definition('MASTER_CATALOG', 'ORGANIZATION_ONLY')
    moduleCandidates = [definition('SERIALIZED_INVENTORY', 'BOTH'), moduleByCode]
  })

  it('excludes ORGANIZATION_ONLY from the per-venue module list while preserving scope for eligible modules', async () => {
    mockModuleFindMany.mockImplementation(async ({ where }: any = {}) =>
      moduleCandidates
        .filter(candidate => scopeAllows(where?.scope, candidate.scope))
        .map(candidate => ({ ...candidate, venueModules: [] })),
    )

    const response = await request(server).get(`/modules/venues/${VENUE_ID}`)

    expect(response.status).toBe(200)
    expect(response.body.modules.map((module: any) => module.code)).toEqual(['SERIALIZED_INVENTORY'])
    expect(response.body.modules[0].scope).toBe('BOTH')
  })

  it.each(['', '?grouped=true'])('rejects ORGANIZATION_ONLY from /:code/venues%s', async query => {
    const response = await request(server).get(`/modules/MASTER_CATALOG/venues${query}`)

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/organization/i)
    expect(mockVenueFindMany).not.toHaveBeenCalled()
    expect(mockOrganizationFindMany).not.toHaveBeenCalled()
  })

  it('does not report stale organization inheritance for grouped VENUE_ONLY modules', async () => {
    moduleByCode = definition('SERIALIZED_INVENTORY', 'VENUE_ONLY', { id: MODULE_ID })
    mockOrganizationFindMany.mockImplementation(async ({ select }: any) => {
      const staleRowVisible = scopeAllows(select.organizationModules.where.module?.scope, 'VENUE_ONLY')
      return [
        {
          id: ORGANIZATION_ID,
          name: 'Organization test',
          slug: 'organization-test',
          organizationModules: staleRowVisible
            ? [{ enabled: true, config: { stale: true }, enabledAt: new Date('2026-08-08T00:00:00.000Z') }]
            : [],
          venues: [
            {
              id: VENUE_ID,
              name: 'Venue test',
              slug: 'venue-test',
              venueModules: [],
            },
          ],
        },
      ]
    })

    const response = await request(server).get('/modules/SERIALIZED_INVENTORY/venues?grouped=true')

    expect(response.status).toBe(200)
    expect(response.body.organizations[0].orgModuleEnabled).toBe(false)
    expect(response.body.organizations[0].venues[0]).toMatchObject({ moduleEnabled: false, isInherited: false })
  })

  it('rejects enabling ORGANIZATION_ONLY for a venue', async () => {
    const response = await request(server).post('/modules/enable').send({ venueId: VENUE_ID, moduleCode: 'MASTER_CATALOG' })

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/organization/i)
    expect(mockVenueModuleUpsert).not.toHaveBeenCalled()
  })

  it('keeps DELETE venue-override as an explicit repair path for a stale forbidden row', async () => {
    mockVenueModuleFindFirst.mockResolvedValue({ id: 'venue-module-stale' })

    const response = await request(server).delete('/modules/venue-override').send({ venueId: VENUE_ID, moduleCode: 'MASTER_CATALOG' })

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
  })
})

describe('global delete and organization projections', () => {
  it('rejects module deletion when a disabled VenueModule remains', async () => {
    mockVenueModuleCount.mockResolvedValue(1)

    const response = await request(server).delete(`/modules/${MODULE_ID}`)

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/assignment|asign/i)
    expect(mockModuleDelete).not.toHaveBeenCalled()
  })

  it('rejects module deletion when any disabled venue or organization assignment still exists', async () => {
    moduleById = definition('MASTER_CATALOG', 'ORGANIZATION_ONLY', {
      id: MODULE_ID,
      venueModules: [],
      organizationModules: [{ id: 'organization-module-disabled', enabled: false }],
    })
    mockOrganizationModuleCount.mockResolvedValue(1)

    const response = await request(server).delete(`/modules/${MODULE_ID}`)

    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/assignment|asign/i)
    expect(mockModuleDelete).not.toHaveBeenCalled()
  })

  it('organization module listing excludes VENUE_ONLY and returns scope additively', async () => {
    moduleCandidates = [definition('MASTER_CATALOG', 'ORGANIZATION_ONLY'), definition('VENUE_TOOL', 'VENUE_ONLY')]
    mockModuleFindMany.mockImplementation(async ({ where }: any = {}) =>
      moduleCandidates
        .filter(candidate => scopeAllows(where?.scope, candidate.scope))
        .map(candidate => ({ ...candidate, organizationModules: [] })),
    )

    const response = await callController(getModulesForOrganization, { params: { organizationId: ORGANIZATION_ID } })

    expect(response.statusCode).toBe(200)
    expect(response.body.modules.map((module: any) => module.code)).toEqual(['MASTER_CATALOG'])
    expect(response.body.modules[0].scope).toBe('ORGANIZATION_ONLY')
  })

  it('organization summaries exclude stale VENUE_ONLY assignments and expose eligible scope', async () => {
    const eligible = definition('MASTER_CATALOG', 'ORGANIZATION_ONLY')
    const stale = definition('VENUE_TOOL', 'VENUE_ONLY')
    mockOrganizationFindMany.mockImplementation(async ({ include }: any) => {
      const assignments = [eligible, stale]
        .filter(module => scopeAllows(include.organizationModules.where.module?.scope, module.scope))
        .map(module => ({ module }))
      return [
        {
          id: ORGANIZATION_ID,
          name: 'Organization test',
          slug: 'organization-test',
          email: 'ops@example.test',
          phone: null,
          type: 'RETAIL',
          createdAt: new Date('2026-08-08T00:00:00.000Z'),
          updatedAt: new Date('2026-08-08T00:00:00.000Z'),
          _count: { venues: 1, staffOrganizations: 1 },
          organizationModules: assignments,
        },
      ]
    })

    const response = await callController(getAllOrganizations, {})

    expect(response.body.organizations[0].enabledModules).toEqual([
      { code: 'MASTER_CATALOG', name: 'MASTER_CATALOG', scope: 'ORGANIZATION_ONLY' },
    ])
  })

  it('rejects VENUE_ONLY from organization enablement', async () => {
    moduleByCode = definition('VENUE_TOOL', 'VENUE_ONLY')

    const response = await callController(enableModuleForOrganization, {
      params: { organizationId: ORGANIZATION_ID },
      body: { moduleCode: 'VENUE_TOOL' },
      authContext: { userId: 'superadmin-1' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.body.error).toMatch(/venue/i)
    expect(mockOrganizationModuleUpsert).not.toHaveBeenCalled()
  })
})
