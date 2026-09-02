import 'dotenv/config'
import prisma from '@/utils/prismaClient'
import { createCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { buildInitialCommercialDraftV1 } from '@/services/commercial/commercialInitialCatalog'

async function main(): Promise<void> {
  const actorStaffId = process.env.COMMERCIAL_SEED_ACTOR_STAFF_ID
  if (!actorStaffId) throw new Error('COMMERCIAL_SEED_ACTOR_STAFF_ID is required; the seed must remain attributable to a human operator')
  const initial = buildInitialCommercialDraftV1()
  const existing = await prisma.commercialDraft.findUnique({ where: { sourceKey: initial.sourceKey } })
  if (existing) {
    process.stdout.write(`${JSON.stringify({ created: false, draftId: existing.id, revision: existing.revision })}\n`)
    return
  }
  const draft = await createCommercialDraft(
    initial.draft,
    { staffId: actorStaffId, reason: 'Crear borrador comercial inicial de México' },
    { sourceKey: initial.sourceKey },
  )
  // Deliberately no preview/publish/activate call here. Those actions require
  // a human confirmation from Superadmin after reviewing the resulting draft.
  process.stdout.write(`${JSON.stringify({ created: true, draftId: draft.id, revision: draft.revision })}\n`)
}

main()
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Commercial seed failed'}\n`)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
