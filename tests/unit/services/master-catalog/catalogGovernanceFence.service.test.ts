import { acquireCatalogGovernanceVenueFence } from '@/services/master-catalog/catalogGovernanceFence.service'

describe('catalogGovernanceFence.service', () => {
  it('locks the exact Venue row and returns the server chronology fields', async () => {
    const enforcedAt = new Date('2026-08-09T12:00:00.000Z')
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'venue-1', organizationId: 'org-1', catalogGovernanceEnforcedAt: enforcedAt }]),
    }

    await expect(acquireCatalogGovernanceVenueFence(tx as never, { venueId: 'venue-1', organizationId: 'org-1' })).resolves.toEqual({
      id: 'venue-1',
      organizationId: 'org-1',
      catalogGovernanceEnforcedAt: enforcedAt,
    })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing', [], 'org-1'],
    ['foreign', [{ id: 'venue-1', organizationId: 'org-other', catalogGovernanceEnforcedAt: null }], 'org-1'],
  ])('returns the same tenant-safe 404 for a %s Venue', async (_label, rows, organizationId) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows) }

    await expect(acquireCatalogGovernanceVenueFence(tx as never, { venueId: 'venue-1', organizationId })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Sucursal no encontrada',
    })
  })
})
