jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    catalogPublicationBatch: { findFirst: jest.fn(), findMany: jest.fn() },
    catalogValidationProfile: { findMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
  },
}))

jest.mock('@/services/master-catalog/catalogImportRead.service', () => ({ listCatalogImportPreviewPage: jest.fn() }))
jest.mock('@/services/master-catalog/catalogOverrideRead.service', () => ({ assertCatalogVenueAccess: jest.fn() }))

import prisma from '@/utils/prismaClient'
import {
  getCatalogImport,
  getCatalogPublication,
  listCatalogPublications,
  listCatalogValidationProfiles,
  getCatalogVenueAccess,
  resolveCatalogVenueContext,
} from '@/services/master-catalog/masterCatalogRead.service'
import { listCatalogImportPreviewPage } from '@/services/master-catalog/catalogImportRead.service'
import { assertCatalogVenueAccess } from '@/services/master-catalog/catalogOverrideRead.service'
import type { CatalogReadContext } from '@/types/master-catalog'

const db = prisma as any
const context: CatalogReadContext = {
  organizationId: 'org-pits',
  actor: { type: 'HUMAN', staffId: 'staff-owner', impersonating: false },
  orgRole: 'OWNER',
}

describe('masterCatalogRead publication tenant boundary', () => {
  beforeEach(() => jest.clearAllMocks())

  it('uses one id+organization predicate and returns a bounded projection', async () => {
    db.catalogPublicationBatch.findFirst.mockResolvedValue({
      id: 'publication-1',
      operation: 'CATALOG_FIELDS_PUBLISH',
      state: 'PREVIEWED',
      previewExpiresAt: new Date('2026-08-09T12:00:00.000Z'),
      appliedAt: null,
      completedAt: null,
      createdAt: new Date('2026-08-09T11:00:00.000Z'),
      updatedAt: new Date('2026-08-09T11:30:00.000Z'),
      failureCode: null,
      failureMessage: null,
      _count: { lines: 2 },
    })

    const result = await getCatalogPublication(context, 'publication-1')

    expect(db.catalogPublicationBatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'publication-1', organizationId: 'org-pits' } }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        publicationBatchId: 'publication-1',
        previewExpiresAt: '2026-08-09T12:00:00.000Z',
        lineCount: 2,
      }),
    )
    expect(result).not.toHaveProperty('previewTokenHash')
    expect(result).not.toHaveProperty('dependencies')
  })

  it('uses createdAt/id keyset pagination within the organization', async () => {
    db.catalogPublicationBatch.findMany.mockResolvedValue([])

    await listCatalogPublications(context, { pageSize: 25 })

    expect(db.catalogPublicationBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-pits' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 26,
      }),
    )
  })
})

describe('masterCatalogRead shared read adapters', () => {
  beforeEach(() => jest.clearAllMocks())

  it('reuses Task 7 durable import reader rather than parsing staged JSON', async () => {
    ;(listCatalogImportPreviewPage as jest.Mock).mockResolvedValue({ batch: { importBatchId: 'import-1' }, items: [] })

    await getCatalogImport(context, 'import-1')

    expect(listCatalogImportPreviewPage).toHaveBeenCalledWith(context, {
      importBatchId: 'import-1',
      section: 'ITEMS',
      pageSize: 1,
    })
  })

  it('lists only bounded profile metadata from the active organization', async () => {
    db.catalogValidationProfile.findMany.mockResolvedValue([])

    await listCatalogValidationProfiles(context)

    expect(db.catalogValidationProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-pits' }, take: 500 }),
    )
  })

  it('derives organization scope from the route venue instead of token or body scope', async () => {
    db.staffVenue.findFirst.mockResolvedValue({ venue: { id: 'venue-pits', organizationId: 'org-pits' } })
    const actor = { type: 'HUMAN' as const, staffId: 'staff-manager', impersonating: false }

    await expect(resolveCatalogVenueContext('venue-pits', actor)).resolves.toEqual({
      venueId: 'venue-pits',
      organizationId: 'org-pits',
      actor,
    })
    expect(db.staffVenue.findFirst).toHaveBeenCalledWith({
      where: { staffId: 'staff-manager', venueId: 'venue-pits', active: true, staff: { active: true } },
      select: { venue: { select: { id: true, organizationId: true } } },
    })
  })

  it('makes missing and foreign venue ids identical when an active organization is supplied', async () => {
    db.venue.findFirst.mockResolvedValue(null)
    const actor = { type: 'HUMAN' as const, staffId: 'staff-manager', impersonating: false }

    await expect(resolveCatalogVenueContext('foreign-venue', actor, 'org-pits')).rejects.toMatchObject({ statusCode: 404 })
    expect(db.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-venue', organizationId: 'org-pits' },
      select: { id: true, organizationId: true },
    })
  })

  it('checks venue access through the shared live custom-permission authority', async () => {
    const venueContext = { ...context, venueId: 'venue-pits' }

    await expect(getCatalogVenueAccess(venueContext)).resolves.toEqual({ allowed: true, venueId: 'venue-pits' })
    expect(assertCatalogVenueAccess).toHaveBeenCalledWith(db, venueContext, 'catalog-venue:read', false)
  })
})
