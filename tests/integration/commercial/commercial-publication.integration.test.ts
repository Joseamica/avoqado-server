import { randomUUID } from 'node:crypto'
import prisma from '@/utils/prismaClient'
import { createCommercialDraft, replaceCommercialDraft } from '@/services/commercial/commercialDraft.service'
import {
  createCommercialPublicationService,
  prismaCommercialPublicationDependencies,
} from '@/services/commercial/commercialPublication.service'
import {
  createCommercialActivationService,
  prismaCommercialActivationDependencies,
} from '@/services/commercial/commercialActivation.service'
import { buildValidCommercialDraft } from '../../__helpers__/commercialDraft'

const signingSecret = 'integration-secret-that-is-at-least-32-bytes'

function buildDraftInput() {
  const input = buildValidCommercialDraft()
  return {
    name: input.name,
    description: input.description,
    products: input.products,
    pricebooks: input.pricebooks,
    prices: input.prices,
    bundles: input.bundles,
    bundleItems: input.bundleItems,
    featureBindings: input.featureBindings,
  }
}

const isolatedPublicationDependencies = {
  ...prismaCommercialPublicationDependencies,
  getActivePublication: async () => null,
}

describe('Commercial publication transaction', () => {
  beforeEach(async () => {
    // Activation history is global. Keep each scenario independent inside the
    // shared disposable database without touching immutable publications.
    await prisma.commercialPublicationActivation.deleteMany()
    await prisma.commercialPublicationOutbox.deleteMany({
      where: { eventType: { in: ['PUBLICATION_ACTIVATED', 'PUBLICATION_ROLLED_BACK'] } },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('persists an immutable schema-v2 publication and activates it through verified C3 authority', async () => {
    const suffix = randomUUID()
    const actor = {
      staffId: `staff_${suffix}`,
      reason: 'Prueba de publicación integrada',
      permissions: ['commercial:publish'],
    }
    await prisma.staff.create({
      data: {
        id: actor.staffId,
        email: `commercial-${suffix}@example.test`,
        firstName: 'Commercial',
        lastName: 'Tester',
      },
    })
    const input = buildDraftInput()
    const draft = await createCommercialDraft(
      {
        name: input.name,
        description: input.description,
        products: input.products,
        pricebooks: input.pricebooks,
        prices: input.prices,
        bundles: input.bundles,
        bundleItems: input.bundleItems,
        featureBindings: input.featureBindings,
      },
      { staffId: actor.staffId, reason: actor.reason },
    )
    const publishedAt = new Date('2026-08-21T18:00:00.000Z')
    const publicationId = `pub_${suffix}`
    const publicationService = createCommercialPublicationService({
      ...isolatedPublicationDependencies,
      now: () => publishedAt,
      randomId: () => publicationId,
      signingSecret,
    })

    const preview = await publicationService.previewCommercialPublication(draft.id, draft.revision, actor)
    const publication = await publicationService.publishCommercialDraft(
      {
        draftId: draft.id,
        expectedRevision: draft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )

    const [stored, auditCount, outbox] = await Promise.all([
      prisma.commercialPublication.findUnique({ where: { id: publication.id } }),
      prisma.activityLog.count({ where: { entity: 'CommercialPublication', entityId: publication.id } }),
      prisma.commercialPublicationOutbox.findFirst({
        where: { publicationId: publication.id, eventType: 'PUBLICATION_CREATED' },
      }),
    ])
    expect(stored?.schemaVersion).toBe(2)
    expect(stored?.checksum).toBe(preview.checksum)
    expect(stored?.snapshot).toEqual(preview.snapshot)
    expect(preview.snapshot.products.find(product => product.code === 'POS')?.prices[0]?.amount).toBe('249.00')
    expect(auditCount).toBe(1)
    expect(outbox?.payloadVersion).toBe(1)
    expect(outbox?.payload).toMatchObject({ schemaVersion: 2, checksum: preview.checksum })

    await expect(
      prisma.$executeRaw`UPDATE "CommercialPublication" SET "reason" = 'mutated' WHERE "id" = ${publication.id}`,
    ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })

    const activationService = createCommercialActivationService({
      ...prismaCommercialActivationDependencies,
      now: () => new Date('2026-08-21T18:01:00.000Z'),
    })
    const currentActivation = await prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })
    const expectedActivationRevision = currentActivation?.revision ?? 0
    await expect(
      activationService.activateCommercialPublication(
        {
          publicationId: publication.id,
          expectedActivationRevision,
          reason: 'Activar catálogo integrado',
          confirm: true,
        },
        actor,
      ),
    ).resolves.toMatchObject({
      publicationId: publication.id,
      previousPublicationId: currentActivation?.publicationId ?? null,
      revision: expectedActivationRevision + 1,
    })
    await expect(prisma.commercialPublicationActivation.findUnique({ where: { environment: 'PRODUCTION' } })).resolves.toMatchObject({
      publicationId: publication.id,
      revision: expectedActivationRevision + 1,
    })
  })

  it('rolls the entire publish transaction back if the human actor does not exist', async () => {
    const suffix = randomUUID()
    const realStaff = await prisma.staff.create({
      data: {
        id: `staff_real_${suffix}`,
        email: `commercial-real-${suffix}@example.test`,
        firstName: 'Real',
        lastName: 'Tester',
      },
    })
    const input = buildValidCommercialDraft()
    const draft = await createCommercialDraft(
      {
        name: input.name,
        description: input.description,
        products: input.products,
        pricebooks: input.pricebooks,
        prices: input.prices,
        bundles: input.bundles,
        bundleItems: input.bundleItems,
        featureBindings: input.featureBindings,
      },
      { staffId: realStaff.id, reason: 'Preparar rollback integrado' },
    )
    const actor = {
      staffId: `missing_${suffix}`,
      reason: 'Este actor no existe',
      permissions: ['commercial:publish'],
    }
    const publicationId = `pub_missing_${suffix}`
    const service = createCommercialPublicationService({
      ...isolatedPublicationDependencies,
      now: () => new Date('2026-08-21T19:00:00.000Z'),
      randomId: () => publicationId,
      signingSecret,
    })
    const preview = await service.previewCommercialPublication(draft.id, draft.revision, actor)

    await expect(
      service.publishCommercialDraft(
        {
          draftId: draft.id,
          expectedRevision: draft.revision,
          previewToken: preview.previewToken,
          checksum: preview.checksum,
          reason: actor.reason,
          confirm: true,
        },
        actor,
      ),
    ).rejects.toBeDefined()

    await expect(prisma.commercialPublication.findUnique({ where: { id: publicationId } })).resolves.toBeNull()
    await expect(prisma.commercialPublicationOutbox.count({ where: { publicationId } })).resolves.toBe(0)
    await expect(prisma.activityLog.count({ where: { entityId: publicationId } })).resolves.toBe(0)
  })

  it('rechecks and locks the draft inside the publish transaction when an edit wins the race', async () => {
    const suffix = randomUUID()
    const staff = await prisma.staff.create({
      data: {
        id: `staff_race_${suffix}`,
        email: `commercial-race-${suffix}@example.test`,
        firstName: 'Race',
        lastName: 'Tester',
      },
    })
    const actor = { staffId: staff.id, reason: 'Ensayar carrera de publicación', permissions: ['commercial:publish'] }
    const input = buildDraftInput()
    const draftActor = { staffId: actor.staffId, reason: actor.reason }
    const draft = await createCommercialDraft(input, draftActor)
    const publicationId = `pub_race_${suffix}`
    let releasePublish!: () => void
    let publishReachedTransaction!: () => void
    const publishCanContinue = new Promise<void>(resolve => (releasePublish = resolve))
    const transactionReached = new Promise<void>(resolve => (publishReachedTransaction = resolve))
    const service = createCommercialPublicationService({
      ...isolatedPublicationDependencies,
      signingSecret,
      randomId: () => publicationId,
      // Publication now enters the serialized writer through the eligible-offer
      // snapshot runner. Pause at that boundary so the edit commits first, then
      // verify that the transaction re-reads the draft instead of trusting preview.
      runWithEligibleOffers: async (now, operation) => {
        publishReachedTransaction()
        await publishCanContinue
        return isolatedPublicationDependencies.runWithEligibleOffers(now, operation)
      },
    })
    const preview = await service.previewCommercialPublication(draft.id, draft.revision, actor)
    const publishing = service.publishCommercialDraft(
      {
        draftId: draft.id,
        expectedRevision: draft.revision,
        previewToken: preview.previewToken,
        checksum: preview.checksum,
        reason: actor.reason,
        confirm: true,
      },
      actor,
    )

    await transactionReached
    await replaceCommercialDraft(draft.id, { ...input, name: 'Catálogo editado durante publicación' }, draft.revision, draftActor)
    releasePublish()

    await expect(publishing).rejects.toMatchObject({ code: 'COMMERCIAL_DRAFT_CONFLICT' })
    await expect(prisma.commercialPublication.findUnique({ where: { id: publicationId } })).resolves.toBeNull()
  })

  it('confirms the same preview concurrently without aborting the losing transaction', async () => {
    const suffix = randomUUID()
    const staff = await prisma.staff.create({
      data: {
        id: `staff_idempotent_${suffix}`,
        email: `commercial-idempotent-${suffix}@example.test`,
        firstName: 'Idempotent',
        lastName: 'Tester',
      },
    })
    const actor = { staffId: staff.id, reason: 'Confirmación concurrente', permissions: ['commercial:publish'] }
    const draft = await createCommercialDraft(buildDraftInput(), { staffId: actor.staffId, reason: actor.reason })
    const publicationId = `pub_idempotent_${suffix}`
    const service = createCommercialPublicationService({
      ...isolatedPublicationDependencies,
      signingSecret,
      randomId: () => publicationId,
    })
    const preview = await service.previewCommercialPublication(draft.id, draft.revision, actor)
    const command = {
      draftId: draft.id,
      expectedRevision: draft.revision,
      previewToken: preview.previewToken,
      checksum: preview.checksum,
      reason: actor.reason,
      confirm: true as const,
    }

    const [first, second] = await Promise.all([
      service.publishCommercialDraft(command, actor),
      service.publishCommercialDraft(command, actor),
    ])

    expect(second.id).toBe(first.id)
    await expect(prisma.activityLog.count({ where: { entity: 'CommercialPublication', entityId: publicationId } })).resolves.toBe(1)
    await expect(prisma.commercialPublicationOutbox.count({ where: { publicationId } })).resolves.toBe(1)
  })
})
