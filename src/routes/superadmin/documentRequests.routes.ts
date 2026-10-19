import { Router } from 'express'
import * as links from '../../services/document-requests/venueLinks.service'
import * as service from '../../services/document-requests/documentRequests.service'

// Parent router authenticates session and enforces SUPERADMIN before these routes.
const router = Router()
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
router.get('/', async (req, res) => {
  res.json(await service.listRequests(req.query))
})
router.post('/', async (req, res) => {
  res.status(201).json(await service.createRequest(req.body, req.authContext?.userId))
})
router.get('/venue-options', async (req, res) => {
  res.json(await links.listVenueOptions(req.query))
})
router.get('/venues/:venueId', async (req, res) => {
  res.json(await links.listVenueDocumentRequests(req.params.venueId, req.query))
})
router.get('/venues/:venueId/links/:linkId', async (req, res) => {
  res.json(await links.getVenueDocumentRequest(req.params.venueId, req.params.linkId))
})
router.get('/venues/:venueId/links/:linkId/documents/:documentId/preview', async (req, res) => {
  res.json(await links.getVenueDocumentPreview(req.params.venueId, req.params.linkId, req.params.documentId))
})
router.get('/venues/:venueId/links/:linkId/documents/:documentId/download', async (req, res) => {
  res.json(await links.getVenueDocumentDownload(req.params.venueId, req.params.linkId, req.params.documentId))
})
router.get('/:id/venue-links', async (req, res) => {
  res.json(await links.listRequestVenueLinks(req.params.id, req.query))
})
router.post('/:id/venue-links', async (req, res) => {
  const result = await links.linkRequestToVenue(req.params.id, req.body, req.authContext!.userId)
  res.status(result.created ? 201 : 200).json(result)
})
router.get('/:id', async (req, res) => {
  res.json(await service.getAdminRequest(req.params.id))
})
router.post('/:id/revoke', async (req, res) => {
  res.json(await service.revokeRequest(req.params.id, req.authContext?.userId))
})
router.post('/:id/renew', async (req, res) => {
  res.json(await service.renewRequest(req.params.id, req.authContext?.userId))
})
router.get('/:id/documents/:documentId/preview', async (req, res) => {
  res.json(await service.getPreviewUrl(req.params.id, req.params.documentId))
})
router.get('/:id/documents/:documentId/download', async (req, res) => {
  res.json(await service.getDownloadUrl(req.params.id, req.params.documentId))
})
export default router
