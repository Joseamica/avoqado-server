import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

const hits: string[] = []
const permissionHits: string[] = []
const handler = (name: string) => (req: Request, res: Response) => {
  hits.push(name)
  res.status(200).json({ success: true, data: { handler: name, ifMatch: req.get('if-match') ?? null } })
}

jest.mock('@/controllers/superadmin/commercial.superadmin.controller', () => ({
  listDrafts: handler('listDrafts'),
  createDraft: handler('createDraft'),
  getDraft: handler('getDraft'),
  replaceDraft: handler('replaceDraft'),
  validateDraft: handler('validateDraft'),
  previewPublication: handler('previewPublication'),
  publishDraft: handler('publishDraft'),
  listPublications: handler('listPublications'),
  getPublication: handler('getPublication'),
  getCurrentActivation: handler('getCurrentActivation'),
  activatePublication: handler('activatePublication'),
  emergencyReactivatePublicationV1: handler('emergencyReactivatePublicationV1'),
  listFailedCommercialOutbox: handler('listFailedCommercialOutbox'),
  getFailedCommercialOutbox: handler('getFailedCommercialOutbox'),
  requeueFailedCommercialOutbox: handler('requeueFailedCommercialOutbox'),
  listCampaignDrafts: handler('listCampaignDrafts'),
  createCampaignDraft: handler('createCampaignDraft'),
  getCampaignDraft: handler('getCampaignDraft'),
  replaceCampaignDraft: handler('replaceCampaignDraft'),
  publishCampaignDraft: handler('publishCampaignDraft'),
  listCampaignVersions: handler('listCampaignVersions'),
  listCampaignActivations: handler('listCampaignActivations'),
  activateCampaignVersion: handler('activateCampaignVersion'),
  issueCampaignAcquisitionClaim: handler('issueCampaignAcquisitionClaim'),
  listManualSpeiCases: handler('listManualSpeiCases'),
  getManualSpeiCase: handler('getManualSpeiCase'),
  getManualSpeiEvidenceAccess: handler('getManualSpeiEvidenceAccess'),
  createManualSpeiCase: handler('createManualSpeiCase'),
  registerManualSpeiEvidence: handler('registerManualSpeiEvidence'),
  reviewManualSpeiEvidence: handler('reviewManualSpeiEvidence'),
  supersedeManualSpeiEvidence: handler('supersedeManualSpeiEvidence'),
  approveManualSpeiCase: handler('approveManualSpeiCase'),
}))

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (_req: Request, _res: Response, next: () => void) => {
    permissionHits.push(permission)
    next()
  },
}))

import commercialRoutes from '@/routes/superadmin/commercial.routes'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/v1/superadmin/commercial', commercialRoutes)
  server.use(
    (error: Error & { statusCode?: number; code?: string; details?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.statusCode ?? 500).json({
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      })
    },
  )
  return server
}

describe('Superadmin commercial route contract', () => {
  beforeEach(() => {
    hits.splice(0)
    permissionHits.splice(0)
  })

  it('rejects a replace without the canonical draft If-Match before reaching the controller', async () => {
    const response = await request(app()).put('/api/v1/superadmin/commercial/drafts/draft_1').send({ draft: {}, reason: 'Editar' })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(hits).toEqual([])
  })

  it('routes validated preview, publish, history and activation commands', async () => {
    await request(app()).post('/api/v1/superadmin/commercial/drafts/draft_1/preview').send({ expectedRevision: 3 }).expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/drafts/draft_1/publish')
      .send({
        expectedRevision: 3,
        previewToken: 'opaque.preview',
        checksum: 'a'.repeat(64),
        reason: 'Publicar catálogo aprobado',
        confirm: true,
      })
      .expect(200)
    await request(app()).get('/api/v1/superadmin/commercial/publications').expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/publications/pub_1/activate')
      .send({ expectedActivationRevision: 0, reason: 'Activar publicación', confirm: true })
      .expect(200)

    expect(hits).toEqual(['previewPublication', 'publishDraft', 'listPublications', 'activatePublication'])
  })

  it('accepts an exact revision ETag for replacement', async () => {
    const draft = {
      name: 'Catálogo',
      products: [],
      pricebooks: [],
      prices: [],
      bundles: [],
      bundleItems: [],
      featureBindings: [],
    }
    const response = await request(app())
      .put('/api/v1/superadmin/commercial/drafts/draft_1')
      .set('If-Match', 'W/"commercial-draft:draft_1:4"')
      .send({ draft, reason: 'Guardar borrador' })
      .expect(200)

    expect(response.body.data.ifMatch).toBe('W/"commercial-draft:draft_1:4"')
    expect(hits).toEqual(['replaceDraft'])
  })

  it('routes normalized campaign drafts, publication and rollback with exact revisions', async () => {
    const campaign = {
      code: 'POS_INTRO_2026',
      name: 'POS introducción',
      startsAt: '2026-08-22T06:00:00.000Z',
      endsAt: '2026-09-22T06:00:00.000Z',
      stackingGroups: [],
      rules: [{ code: 'POS_FIFTY', type: 'FIXED_PRICE', priority: 100, target: { productCodes: ['POS'] }, amount: '50.00', cycles: 3 }],
    }
    await request(app())
      .post('/api/v1/superadmin/commercial/campaigns/drafts')
      .send({ draft: campaign, reason: 'Crear piloto' })
      .expect(200)
    await request(app())
      .put('/api/v1/superadmin/commercial/campaigns/drafts/campaign_1')
      .set('If-Match', 'W/"commercial-campaign:campaign_1:2"')
      .send({ draft: campaign, reason: 'Ajustar piloto' })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/campaigns/drafts/campaign_1/publish')
      .send({ expectedDraftRevision: 3, expectedActivationRevision: null, reason: 'Publicar piloto', confirm: true })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/campaigns/POS_INTRO_2026/versions/version_old/activate')
      .send({ expectedActivationRevision: 2, reason: 'Rollback campaña', confirm: true })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/campaigns/POS_INTRO_2026/versions/version_old/acquisition-claims')
      .send({
        channel: 'PAID_META',
        sourceRef: 'adset-cdmx-restaurants',
        expiresAt: '2026-09-01T06:00:00.000Z',
        reason: 'Crear enlace para Meta',
        confirm: true,
      })
      .expect(200)

    expect(hits).toEqual([
      'createCampaignDraft',
      'replaceCampaignDraft',
      'publishCampaignDraft',
      'activateCampaignVersion',
      'issueCampaignAcquisitionClaim',
    ])
  })

  it.each([
    { amount: '50', issue: 'El monto debe usar formato decimal canónico con dos decimales.' },
    { amount: '10000000000.00', issue: 'El monto excede el máximo unitario permitido.' },
  ])('rejects invalid campaign v2 money at the route before the controller: $amount', async ({ amount, issue }) => {
    const response = await request(app())
      .post('/api/v1/superadmin/commercial/campaigns/drafts')
      .send({
        draft: {
          code: 'POS_INTRO_2026',
          name: 'POS introducción',
          startsAt: '2026-08-22T06:00:00.000Z',
          endsAt: '2026-09-22T06:00:00.000Z',
          stackingGroups: [],
          rules: [
            {
              code: 'POS_FIFTY',
              type: 'FIXED_PRICE',
              priority: 100,
              target: { productCodes: ['POS'] },
              amount,
              cycles: 3,
            },
          ],
        },
        reason: 'Crear piloto',
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ message: `Error de validación: draft.rules.0.amount: ${issue}` })
    expect(hits).toEqual([])
  })

  it('routes emergency v1 reactivation and inspected outbox recovery with exact permissions', async () => {
    await request(app())
      .post('/api/v1/superadmin/commercial/publications/pub_v1/emergency-reactivate-v1')
      .send({ expectedActivationRevision: 4, reason: 'Incidente confirmado por el founder', confirm: true })
      .expect(200)
    await request(app()).get('/api/v1/superadmin/commercial/outbox/failed?cursor=opaque_cursor-1&limit=25').expect(200)
    await request(app()).get('/api/v1/superadmin/commercial/outbox/failed/outbox_1').expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/outbox/failed/outbox_1/requeue')
      .send({
        observedAttempts: 8,
        observedLastErrorCode: 'COMMERCIAL_OUTBOX_AUTHORITY_UNAVAILABLE',
        reason: 'Autoridad restaurada e inspeccionada',
        confirm: true,
      })
      .expect(200)

    expect(hits).toEqual([
      'emergencyReactivatePublicationV1',
      'listFailedCommercialOutbox',
      'getFailedCommercialOutbox',
      'requeueFailedCommercialOutbox',
    ])
    expect(permissionHits).toEqual(['commercial:publish', 'commercial:read', 'commercial:read', 'commercial:publish'])
  })

  it.each([
    {
      method: 'get' as const,
      path: '/api/v1/superadmin/commercial/outbox/failed?eventType=PUBLICATION_CREATED',
      body: undefined,
    },
    {
      method: 'post' as const,
      path: '/api/v1/superadmin/commercial/outbox/failed/outbox_1/requeue',
      body: {
        observedAttempts: 8,
        observedLastErrorCode: 'raw database error',
        reason: 'Intento ciego',
        confirm: true,
      },
    },
    {
      method: 'post' as const,
      path: '/api/v1/superadmin/commercial/publications/pub_v1/emergency-reactivate-v1',
      body: { expectedActivationRevision: 0, reason: 'Revisión inexistente', confirm: true },
    },
  ])('rejects blind or malformed control-plane request: $path', async ({ method, path, body }) => {
    const operation = request(app())[method](path)
    if (body !== undefined) operation.send(body)
    await operation.expect(400)
    expect(hits).toEqual([])
    expect(permissionHits).toEqual([])
  })

  it('routes the manual SPEI review workflow with a distinct reconciliation permission', async () => {
    await request(app()).get('/api/v1/superadmin/commercial/billing/manual-spei/cases?status=AWAITING_APPROVAL&limit=25').expect(200)
    await request(app()).get('/api/v1/superadmin/commercial/billing/manual-spei/cases/spei_case_1').expect(200)
    await request(app())
      .get('/api/v1/superadmin/commercial/billing/manual-spei/evidence/evidence_1/access?organizationId=org_1&venueId=venue_1')
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/billing/manual-spei/cases')
      .send({
        organizationId: 'org_1',
        venueId: 'venue_1',
        receivableId: 'receivable_1',
        paymentAttemptId: 'attempt_1',
        observedAmountMinor: '28884',
        bankReference: 'SPEI-123',
        receivingAccountFingerprint: 'a'.repeat(64),
        observedAt: '2026-09-01T18:00:00.000Z',
        attributedCommercialActorIds: [],
      })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/billing/manual-spei/cases/spei_case_1/evidence')
      .send({
        organizationId: 'org_1',
        venueId: 'venue_1',
        storageObjectKey: 'private/commercial-spei/org_1/spei_case_1/proof.pdf',
        contentSha256: 'b'.repeat(64),
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/billing/manual-spei/evidence/evidence_1/review')
      .send({ organizationId: 'org_1', venueId: 'venue_1', action: 'ACCEPT', reason: null })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/billing/manual-spei/evidence/evidence_1/supersede')
      .send({
        organizationId: 'org_1',
        venueId: 'venue_1',
        reason: 'Se reemplazará con evidencia corregida.',
        confirm: true,
      })
      .expect(200)
    await request(app())
      .post('/api/v1/superadmin/commercial/billing/manual-spei/cases/spei_case_1/approve')
      .send({ organizationId: 'org_1', venueId: 'venue_1', confirm: true })
      .expect(200)

    expect(hits).toEqual([
      'listManualSpeiCases',
      'getManualSpeiCase',
      'getManualSpeiEvidenceAccess',
      'createManualSpeiCase',
      'registerManualSpeiEvidence',
      'reviewManualSpeiEvidence',
      'supersedeManualSpeiEvidence',
      'approveManualSpeiCase',
    ])
    expect(permissionHits).toEqual([
      'commercial:read',
      'commercial:read',
      'commercial:reconcile_payment',
      'commercial:reconcile_payment',
      'commercial:reconcile_payment',
      'commercial:reconcile_payment',
      'commercial:reconcile_payment',
      'commercial:reconcile_payment',
    ])
  })

  it.each([
    {
      path: '/api/v1/superadmin/commercial/billing/manual-spei/cases',
      body: {
        organizationId: 'org_1',
        venueId: 'venue_1',
        receivableId: 'receivable_1',
        paymentAttemptId: 'attempt_1',
        observedAmountMinor: 28884,
        bankReference: null,
        receivingAccountFingerprint: 'a'.repeat(64),
        observedAt: '2026-09-01T18:00:00.000Z',
        attributedCommercialActorIds: [],
      },
    },
    {
      path: '/api/v1/superadmin/commercial/billing/manual-spei/evidence/evidence_1/supersede',
      body: {
        organizationId: 'org_1',
        venueId: 'venue_1',
        reason: 'Reemplazar evidencia',
        confirm: false,
      },
    },
    {
      path: '/api/v1/superadmin/commercial/billing/manual-spei/cases/spei_case_1/approve',
      body: { organizationId: 'org_1', venueId: 'venue_1', confirm: false },
    },
  ])('rejects unsafe manual SPEI money/control input before permission evaluation: $path', async ({ path, body }) => {
    await request(app()).post(path).send(body).expect(400)
    expect(hits).toEqual([])
    expect(permissionHits).toEqual([])
  })

  it('rejects spoofed evidence-viewer identity before permission evaluation', async () => {
    await request(app())
      .get(
        '/api/v1/superadmin/commercial/billing/manual-spei/evidence/evidence_1/access?organizationId=org_1&venueId=venue_1&actorId=spoofed',
      )
      .expect(400)
    expect(hits).toEqual([])
    expect(permissionHits).toEqual([])
  })
})
