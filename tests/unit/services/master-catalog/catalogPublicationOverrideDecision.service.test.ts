import { createCatalogPublicationOverrideDecisionService } from '@/services/master-catalog/catalogPublicationOverrideDecision.service'

const NOW = new Date('2026-08-09T12:00:00.000Z')
const publisher = { type: 'HUMAN' as const, staffId: 'publisher-1', impersonating: false }

function projection() {
  return {
    fieldMask: ['description', 'name'] as const,
    fields: [
      {
        field: 'description' as const,
        before: 'Descripción local',
        proposed: 'Descripción corporativa',
        changed: true,
        diverged: true,
      },
      {
        field: 'name' as const,
        before: 'Nombre local',
        proposed: 'Nombre corporativo',
        changed: true,
        diverged: true,
      },
    ],
  }
}

function tx() {
  return {
    catalogVenueOverride: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
}

function harness(rows: unknown[] = []) {
  const client = tx()
  client.catalogVenueOverride.findMany.mockResolvedValue(rows)
  return {
    tx: client,
    service: createCatalogPublicationOverrideDecisionService({ now: () => NOW }),
  }
}

describe('catalogPublicationOverrideDecision.service', () => {
  it('requires the exact decision set to equal fieldMask', async () => {
    const h = harness()

    await expect(
      h.service.resolve(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        actor: publisher,
        projection: projection() as never,
        decisions: [{ field: 'name', decision: 'PUBLISH_CORPORATE' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PUBLICATION_DECISIONS_INCOMPLETE' })
  })

  it('publishes corporate fields without an override FK and preserves a matching current APPROVED value', async () => {
    const approved = {
      id: 'override-approved',
      organizationId: 'org-1',
      venueId: 'venue-1',
      bindingId: 'binding-1',
      field: 'name',
      localValue: 'Nombre local',
      status: 'APPROVED',
      requestedById: 'maker-1',
      decidedById: 'checker-old',
    }
    const h = harness([approved])

    const result = await h.service.resolve(h.tx as never, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      bindingId: 'binding-1',
      actor: publisher,
      projection: projection() as never,
      decisions: [
        { field: 'description', decision: 'PUBLISH_CORPORATE' },
        { field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: 'override-approved' },
      ],
    })

    expect(result).toEqual([
      {
        field: 'description',
        decision: 'PUBLISH_CORPORATE',
        before: 'Descripción local',
        proposed: 'Descripción corporativa',
        after: 'Descripción corporativa',
        overrideId: null,
        reason: null,
      },
      {
        field: 'name',
        decision: 'APPROVE_LOCAL_OVERRIDE',
        before: 'Nombre local',
        proposed: 'Nombre corporativo',
        after: 'Nombre local',
        overrideId: 'override-approved',
        reason: null,
      },
    ])
    expect(h.tx.catalogVenueOverride.updateMany).not.toHaveBeenCalled()
  })

  it('approves a matching REQUESTED override by another Staff and supersedes the current APPROVED replacement', async () => {
    const h = harness([
      {
        id: 'override-requested',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre local',
        status: 'REQUESTED',
        requestedById: 'maker-1',
        decidedById: null,
        reason: 'Nombre comercial local',
      },
      {
        id: 'override-old',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre anterior',
        status: 'APPROVED',
        requestedById: 'maker-old',
        decidedById: 'checker-old',
        reason: 'Excepción anterior',
      },
    ])

    const result = await h.service.resolve(h.tx as never, {
      organizationId: 'org-1',
      venueId: 'venue-1',
      bindingId: 'binding-1',
      actor: publisher,
      projection: projection() as never,
      decisions: [
        { field: 'description', decision: 'PUBLISH_CORPORATE' },
        { field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: 'override-requested' },
      ],
    })

    expect(result[1]).toMatchObject({ after: 'Nombre local', overrideId: 'override-requested' })
    expect(h.tx.catalogVenueOverride.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'override-old', organizationId: 'org-1', bindingId: 'binding-1', field: 'name', status: 'APPROVED' },
      data: { status: 'SUPERSEDED', supersededByOverrideId: 'override-requested', supersededAt: NOW },
    })
    expect(h.tx.catalogVenueOverride.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'override-requested',
        organizationId: 'org-1',
        bindingId: 'binding-1',
        field: 'name',
        status: 'REQUESTED',
        requestedById: { not: 'publisher-1' },
      },
      data: { status: 'APPROVED', decidedById: 'publisher-1', decidedAt: NOW },
    })
  })

  it.each([
    ['self approval', { id: 'request-self', field: 'name', localValue: 'Nombre local', status: 'REQUESTED', requestedById: 'publisher-1' }],
    ['stale local value', { id: 'request-stale', field: 'name', localValue: 'Otro nombre', status: 'REQUESTED', requestedById: 'maker-1' }],
  ])('keeps %s as an explicit conflict', async (_label, override) => {
    const h = harness([
      { organizationId: 'org-1', venueId: 'venue-1', bindingId: 'binding-1', decidedById: null, reason: null, ...override },
    ])

    await expect(
      h.service.resolve(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        actor: publisher,
        projection: projection() as never,
        decisions: [
          { field: 'description', decision: 'PUBLISH_CORPORATE' },
          { field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: String(override.id) },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_OVERRIDE_CONFLICT' })
    expect(h.tx.catalogVenueOverride.updateMany).not.toHaveBeenCalled()
  })

  it('denies a requester who tries to reject their own REQUESTED override', async () => {
    const h = harness([
      {
        id: 'request-self',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre local',
        status: 'REQUESTED',
        requestedById: 'publisher-1',
        decidedById: null,
        reason: 'Mi solicitud',
      },
    ])

    await expect(
      h.service.reject(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        overrideId: 'request-self',
        actor: publisher,
        reason: 'No aplica',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CATALOG_OVERRIDE_MAKER_CHECKER_REQUIRED' })
  })

  it('fails the whole decision set when a supersession CAS loses the race', async () => {
    const h = harness([
      {
        id: 'request-new',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Nombre local',
        status: 'REQUESTED',
        requestedById: 'maker-1',
        decidedById: null,
        reason: null,
      },
      {
        id: 'approved-old',
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        field: 'name',
        localValue: 'Anterior',
        status: 'APPROVED',
        requestedById: 'maker-old',
        decidedById: 'checker-old',
        reason: null,
      },
    ])
    h.tx.catalogVenueOverride.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      h.service.resolve(h.tx as never, {
        organizationId: 'org-1',
        venueId: 'venue-1',
        bindingId: 'binding-1',
        actor: publisher,
        projection: projection() as never,
        decisions: [
          { field: 'description', decision: 'PUBLISH_CORPORATE' },
          { field: 'name', decision: 'APPROVE_LOCAL_OVERRIDE', overrideId: 'request-new' },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_OVERRIDE_CONFLICT' })
  })
})
