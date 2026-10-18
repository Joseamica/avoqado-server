import { Router } from 'express'
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
router.get('/:id', async (req, res) => {
  res.json(await service.getAdminRequest(req.params.id))
})
router.post('/:id/revoke', async (req, res) => {
  res.json(await service.revokeRequest(req.params.id, req.authContext?.userId))
})
router.post('/:id/renew', async (req, res) => {
  res.json(await service.renewRequest(req.params.id, req.authContext?.userId))
})
router.get('/:id/documents/:documentId/download', async (req, res) => {
  res.json(await service.getDownloadUrl(req.params.id, req.params.documentId))
})
export default router
