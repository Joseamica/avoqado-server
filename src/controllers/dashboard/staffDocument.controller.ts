import { NextFunction, Request, Response } from 'express'
import * as staffDocumentService from '../../services/dashboard/staffDocument.service'

export async function listDocuments(req: Request<{ venueId: string; staffId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const docs = await staffDocumentService.listStaffDocuments(req.params.venueId, req.params.staffId)
    res.status(200).json(docs)
  } catch (error) {
    next(error)
  }
}

export async function addDocument(req: Request<{ venueId: string; staffId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const uploadedById = (req as any).authContext?.userId
    if (!uploadedById) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const doc = await staffDocumentService.addStaffDocument(req.params.venueId, req.params.staffId, req.body, uploadedById)
    res.status(201).json(doc)
  } catch (error) {
    next(error)
  }
}

export async function removeDocument(
  req: Request<{ venueId: string; documentId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorId = (req as any).authContext?.userId
    if (!actorId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    await staffDocumentService.removeStaffDocument(req.params.venueId, req.params.documentId, actorId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}
