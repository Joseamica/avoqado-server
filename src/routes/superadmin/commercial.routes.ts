import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as controller from '@/controllers/superadmin/commercial.superadmin.controller'
import {
  commercialActivateRequestSchema,
  commercialCreateDraftRequestSchema,
  commercialEmergencyReactivateV1RequestSchema,
  commercialIdRequestSchema,
  commercialOutboxFailedIdRequestSchema,
  commercialOutboxFailedListRequestSchema,
  commercialOutboxRequeueRequestSchema,
  commercialPreviewRequestSchema,
  commercialPublishRequestSchema,
  commercialReplaceDraftRequestSchema,
  commercialManualSpeiApproveCaseRequestSchema,
  commercialManualSpeiCaseRequestSchema,
  commercialManualSpeiCreateCaseRequestSchema,
  commercialManualSpeiEvidenceAccessRequestSchema,
  commercialManualSpeiListRequestSchema,
  commercialManualSpeiRegisterEvidenceRequestSchema,
  commercialManualSpeiReviewEvidenceRequestSchema,
  commercialManualSpeiSupersedeEvidenceRequestSchema,
} from '@/schemas/commercial.schema'
import {
  commercialCampaignActivateRequestSchema,
  commercialCampaignCreateDraftRequestSchema,
  commercialCampaignIdRequestSchema,
  commercialCampaignClaimRequestSchema,
  commercialCampaignPublishRequestSchema,
  commercialCampaignReplaceDraftRequestSchema,
} from '@/schemas/commercialQuote.schema'

const router = Router()

router.get('/drafts', checkPermission('commercial:read'), controller.listDrafts)
router.post('/drafts', validateRequest(commercialCreateDraftRequestSchema), checkPermission('commercial:edit'), controller.createDraft)
router.get('/drafts/:id', validateRequest(commercialIdRequestSchema), checkPermission('commercial:read'), controller.getDraft)
router.put('/drafts/:id', validateRequest(commercialReplaceDraftRequestSchema), checkPermission('commercial:edit'), controller.replaceDraft)
router.post(
  '/drafts/:id/validate',
  validateRequest(commercialIdRequestSchema),
  checkPermission('commercial:read'),
  controller.validateDraft,
)

router.get('/campaigns/drafts', checkPermission('commercial:read'), controller.listCampaignDrafts)
router.post(
  '/campaigns/drafts',
  validateRequest(commercialCampaignCreateDraftRequestSchema),
  checkPermission('commercial:edit'),
  controller.createCampaignDraft,
)
router.get(
  '/campaigns/drafts/:id',
  validateRequest(commercialCampaignIdRequestSchema),
  checkPermission('commercial:read'),
  controller.getCampaignDraft,
)
router.put(
  '/campaigns/drafts/:id',
  validateRequest(commercialCampaignReplaceDraftRequestSchema),
  checkPermission('commercial:edit'),
  controller.replaceCampaignDraft,
)
router.post(
  '/campaigns/drafts/:id/publish',
  validateRequest(commercialCampaignPublishRequestSchema),
  checkPermission('commercial:publish'),
  controller.publishCampaignDraft,
)
router.get('/campaigns/versions', checkPermission('commercial:read'), controller.listCampaignVersions)
router.get('/campaigns/activations', checkPermission('commercial:read'), controller.listCampaignActivations)
router.post(
  '/campaigns/:campaignCode/versions/:versionId/activate',
  validateRequest(commercialCampaignActivateRequestSchema),
  checkPermission('commercial:publish'),
  controller.activateCampaignVersion,
)
router.post(
  '/campaigns/:campaignCode/versions/:versionId/acquisition-claims',
  validateRequest(commercialCampaignClaimRequestSchema),
  checkPermission('commercial:publish'),
  controller.issueCampaignAcquisitionClaim,
)
router.post(
  '/drafts/:id/preview',
  validateRequest(commercialPreviewRequestSchema),
  checkPermission('commercial:publish'),
  controller.previewPublication,
)
router.post(
  '/drafts/:id/publish',
  validateRequest(commercialPublishRequestSchema),
  checkPermission('commercial:publish'),
  controller.publishDraft,
)
router.get('/publications', checkPermission('commercial:read'), controller.listPublications)
router.get('/publications/current', checkPermission('commercial:read'), controller.getCurrentActivation)
router.get('/publications/:id', validateRequest(commercialIdRequestSchema), checkPermission('commercial:read'), controller.getPublication)
router.post(
  '/publications/:id/activate',
  validateRequest(commercialActivateRequestSchema),
  checkPermission('commercial:publish'),
  controller.activatePublication,
)
router.post(
  '/publications/:id/emergency-reactivate-v1',
  validateRequest(commercialEmergencyReactivateV1RequestSchema),
  checkPermission('commercial:publish'),
  controller.emergencyReactivatePublicationV1,
)
router.get(
  '/outbox/failed',
  validateRequest(commercialOutboxFailedListRequestSchema),
  checkPermission('commercial:read'),
  controller.listFailedCommercialOutbox,
)
router.get(
  '/outbox/failed/:id',
  validateRequest(commercialOutboxFailedIdRequestSchema),
  checkPermission('commercial:read'),
  controller.getFailedCommercialOutbox,
)
router.post(
  '/outbox/failed/:id/requeue',
  validateRequest(commercialOutboxRequeueRequestSchema),
  checkPermission('commercial:publish'),
  controller.requeueFailedCommercialOutbox,
)

router.get(
  '/billing/manual-spei/cases',
  validateRequest(commercialManualSpeiListRequestSchema),
  checkPermission('commercial:read'),
  controller.listManualSpeiCases,
)
router.get(
  '/billing/manual-spei/cases/:caseId',
  validateRequest(commercialManualSpeiCaseRequestSchema),
  checkPermission('commercial:read'),
  controller.getManualSpeiCase,
)
router.get(
  '/billing/manual-spei/evidence/:evidenceId/access',
  validateRequest(commercialManualSpeiEvidenceAccessRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.getManualSpeiEvidenceAccess,
)
router.post(
  '/billing/manual-spei/cases',
  validateRequest(commercialManualSpeiCreateCaseRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.createManualSpeiCase,
)
router.post(
  '/billing/manual-spei/cases/:caseId/evidence',
  validateRequest(commercialManualSpeiRegisterEvidenceRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.registerManualSpeiEvidence,
)
router.post(
  '/billing/manual-spei/evidence/:evidenceId/review',
  validateRequest(commercialManualSpeiReviewEvidenceRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.reviewManualSpeiEvidence,
)
router.post(
  '/billing/manual-spei/evidence/:evidenceId/supersede',
  validateRequest(commercialManualSpeiSupersedeEvidenceRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.supersedeManualSpeiEvidence,
)
router.post(
  '/billing/manual-spei/cases/:caseId/approve',
  validateRequest(commercialManualSpeiApproveCaseRequestSchema),
  checkPermission('commercial:reconcile_payment'),
  controller.approveManualSpeiCase,
)

export default router
