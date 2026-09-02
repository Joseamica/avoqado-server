import type { NextFunction, Request, Response } from 'express'
import type { CommercialManualSpeiCaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getRealUserId } from '@/security'
import { createCommercialDraft, getCommercialDraft, replaceCommercialDraft } from '@/services/commercial/commercialDraft.service'
import { validateCommercialDraft } from '@/services/commercial/commercialValidation.service'
import { previewCommercialPublication, publishCommercialDraft } from '@/services/commercial/commercialPublication.service'
import {
  activateCommercialPublication,
  emergencyReactivateCommercialPublicationV1,
} from '@/services/commercial/commercialActivation.service'
import { NotFoundError } from '@/errors/AppError'
import type { CommercialDraftActor, CommercialPublisherActor } from '@/types/commercial'
import { formatCommercialDraftEtag, parseCommercialDraftEtag } from '@/services/commercial/commercialDraftEtag'
import { commercialCampaignDraftService } from '@/services/commercial/commercialCampaignDraft.service'
import { commercialCampaignPublicationService } from '@/services/commercial/commercialCampaignPublication.service'
import { commercialCampaignClaimService } from '@/services/commercial/commercialCampaignClaim.service'
import { commercialOutboxRecoveryService } from '@/services/commercial/commercialOutboxRecovery.service'
import {
  approveCommercialManualSpeiCase,
  createCommercialManualSpeiCase,
  registerCommercialManualSpeiEvidence,
  reviewCommercialManualSpeiEvidence,
  supersedeCommercialManualSpeiEvidence,
} from '@/services/commercial/billing/manualSpei.service'
import {
  getCommercialManualSpeiCase as readCommercialManualSpeiCase,
  getCommercialManualSpeiEvidenceAccess as readCommercialManualSpeiEvidenceAccess,
  listCommercialManualSpeiCases as readCommercialManualSpeiCases,
} from '@/services/commercial/billing/manualSpeiRead.service'

function humanActor(req: Request, reason: string): CommercialDraftActor {
  if (!req.authContext) throw new NotFoundError('Sesión de operador no encontrada.')
  return {
    staffId: getRealUserId(req.authContext),
    reason,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }
}

function publisher(req: Request, reason: string): CommercialPublisherActor {
  return { ...humanActor(req, reason), permissions: ['commercial:publish'] }
}

function ifMatchRevision(req: Request): number {
  return parseCommercialDraftEtag(req.get('if-match')!, req.params.id)
}

function campaignEtag(id: string, revision: number): string {
  return `W/"commercial-campaign:${id}:${revision}"`
}

function campaignIfMatchRevision(req: Request): number {
  const match = /^W\/"commercial-campaign:([^":]+):([1-9]\d*)"$/.exec(req.get('if-match') ?? '')
  if (!match || match[1] !== req.params.id) throw new NotFoundError('If-Match de campaña no corresponde al borrador.')
  return Number(match[2])
}

export async function listDrafts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.commercialDraft.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, sourceKey: true, name: true, description: true, status: true, revision: true, createdAt: true, updatedAt: true },
    })
    res.status(200).json({ success: true, data: rows })
  } catch (error) {
    next(error)
  }
}

export async function createDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await createCommercialDraft(req.body.draft, humanActor(req, req.body.reason))
    res.setHeader('ETag', formatCommercialDraftEtag(row.id, row.revision))
    res.status(201).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function getDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await getCommercialDraft(req.params.id)
    if (!row) throw new NotFoundError('Borrador comercial no encontrado.')
    res.setHeader('ETag', formatCommercialDraftEtag(row.id, row.revision))
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function replaceDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await replaceCommercialDraft(req.params.id, req.body.draft, ifMatchRevision(req), humanActor(req, req.body.reason))
    res.setHeader('ETag', formatCommercialDraftEtag(row.id, row.revision))
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function validateDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ success: true, data: await validateCommercialDraft(req.params.id) })
  } catch (error) {
    next(error)
  }
}

export async function previewPublication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await previewCommercialPublication(req.params.id, req.body.expectedRevision, publisher(req, 'Generar preview comercial'))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function publishDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await publishCommercialDraft({ draftId: req.params.id, ...req.body }, publisher(req, req.body.reason))
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function listPublications(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.commercialPublication.findMany({
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        sourceDraftId: true,
        sourceRevision: true,
        schemaVersion: true,
        checksum: true,
        reason: true,
        publishedById: true,
        publishedAt: true,
      },
    })
    res.status(200).json({ success: true, data: rows })
  } catch (error) {
    next(error)
  }
}

export async function getPublication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await prisma.commercialPublication.findUnique({ where: { id: req.params.id } })
    if (!row) throw new NotFoundError('Publicación comercial no encontrada.')
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function getCurrentActivation(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await prisma.commercialPublicationActivation.findUnique({
      where: { environment: 'PRODUCTION' },
      include: { publication: true },
    })
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function activatePublication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await activateCommercialPublication({ publicationId: req.params.id, ...req.body }, publisher(req, req.body.reason))
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function emergencyReactivatePublicationV1(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await emergencyReactivateCommercialPublicationV1(
      { publicationId: req.params.id, ...req.body },
      publisher(req, req.body.reason),
    )
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function listFailedCommercialOutbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialOutboxRecoveryService.listFailed({
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit as unknown as number | undefined,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function getFailedCommercialOutbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialOutboxRecoveryService.getFailed(req.params.id)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function requeueFailedCommercialOutbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialOutboxRecoveryService.requeueFailed(req.params.id, req.body, publisher(req, req.body.reason))
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function listCampaignDrafts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.commercialCampaignDraft.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        status: true,
        revision: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    res.status(200).json({ success: true, data: rows })
  } catch (error) {
    next(error)
  }
}

export async function createCampaignDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await commercialCampaignDraftService.createDraft(req.body.draft, humanActor(req, req.body.reason))
    res.setHeader('ETag', campaignEtag(row.id, row.revision))
    res.status(201).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function getCampaignDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await commercialCampaignDraftService.getDraft(req.params.id)
    if (!row) throw new NotFoundError('Borrador de campaña no encontrado.')
    res.setHeader('ETag', campaignEtag(row.id, row.revision))
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function replaceCampaignDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await commercialCampaignDraftService.replaceDraft(
      req.params.id,
      req.body.draft,
      campaignIfMatchRevision(req),
      humanActor(req, req.body.reason),
    )
    res.setHeader('ETag', campaignEtag(row.id, row.revision))
    res.status(200).json({ success: true, data: row })
  } catch (error) {
    next(error)
  }
}

export async function publishCampaignDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialCampaignPublicationService.publishAndActivate(
      { draftId: req.params.id, ...req.body },
      publisher(req, req.body.reason),
    )
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function listCampaignVersions(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.commercialCampaignVersion.findMany({
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        campaignCode: true,
        sourceDraftId: true,
        sourceRevision: true,
        schemaVersion: true,
        checksum: true,
        reason: true,
        publishedById: true,
        publishedAt: true,
      },
    })
    res.status(200).json({ success: true, data: rows })
  } catch (error) {
    next(error)
  }
}

export async function listCampaignActivations(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.commercialCampaignActivation.findMany({
      where: { environment: 'PRODUCTION' },
      orderBy: { campaignCode: 'asc' },
      include: { campaignVersion: true },
    })
    res.status(200).json({ success: true, data: rows })
  } catch (error) {
    next(error)
  }
}

export async function activateCampaignVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialCampaignPublicationService.activateVersion(
      {
        campaignCode: req.params.campaignCode,
        campaignVersionId: req.params.versionId,
        expectedActivationRevision: req.body.expectedActivationRevision,
        reason: req.body.reason,
        confirm: req.body.confirm,
      },
      publisher(req, req.body.reason),
    )
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function issueCampaignAcquisitionClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await commercialCampaignClaimService.issue(
      {
        campaignCode: req.params.campaignCode,
        campaignVersionId: req.params.versionId,
        channel: req.body.channel,
        sourceRef: req.body.sourceRef,
        expiresAt: req.body.expiresAt,
        confirm: req.body.confirm,
      },
      publisher(req, req.body.reason),
      new Date(),
    )
    res.setHeader('Cache-Control', 'no-store')
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store')
}

export async function listManualSpeiCases(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await readCommercialManualSpeiCases({
      organizationId: req.query.organizationId as string | undefined,
      venueId: req.query.venueId as string | undefined,
      status: req.query.status as CommercialManualSpeiCaseStatus | undefined,
      cursor: req.query.cursor as string | undefined,
      limit: req.query.limit as unknown as number | undefined,
    })
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function getManualSpeiCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await readCommercialManualSpeiCase(req.params.caseId)
    if (!data) throw new NotFoundError('Caso de conciliación SPEI no encontrado.')
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function getManualSpeiEvidenceAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Abrir evidencia SPEI').staffId
    const data = await readCommercialManualSpeiEvidenceAccess({
      evidenceId: req.params.evidenceId,
      organizationId: req.query.organizationId as string,
      venueId: req.query.venueId as string,
      actorId,
    })
    if (!data) throw new NotFoundError('Evidencia de conciliación SPEI no encontrada.')
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function createManualSpeiCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Crear caso de conciliación SPEI').staffId
    const data = await createCommercialManualSpeiCase({ ...req.body, createdById: actorId })
    noStore(res)
    res.status(data.decision === 'CREATED' ? 201 : 200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function supersedeManualSpeiEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Reemplazar evidencia SPEI rechazada').staffId
    const data = await supersedeCommercialManualSpeiEvidence({
      evidenceId: req.params.evidenceId,
      organizationId: req.body.organizationId,
      venueId: req.body.venueId,
      actorId,
      reason: req.body.reason,
    })
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function registerManualSpeiEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Registrar evidencia SPEI').staffId
    const data = await registerCommercialManualSpeiEvidence({
      ...req.body,
      caseId: req.params.caseId,
      uploadedById: actorId,
    })
    noStore(res)
    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function reviewManualSpeiEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Revisar evidencia SPEI').staffId
    const data = await reviewCommercialManualSpeiEvidence({
      ...req.body,
      evidenceId: req.params.evidenceId,
      actorId,
    })
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function approveManualSpeiCase(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = humanActor(req, 'Aprobar conciliación SPEI').staffId
    const data = await approveCommercialManualSpeiCase({
      caseId: req.params.caseId,
      organizationId: req.body.organizationId,
      venueId: req.body.venueId,
      actorId,
      now: new Date(),
    })
    noStore(res)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
