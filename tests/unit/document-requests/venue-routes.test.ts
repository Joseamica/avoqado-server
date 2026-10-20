import 'express-async-errors'
import express from 'express'
import request from 'supertest'
import cuid from 'cuid'
import { StaffRole } from '@prisma/client'
import { authorizeRole } from '../../../src/middlewares/authorizeRole.middleware'
import { rolVigente } from '../../../src/services/access/rolVigente'
jest.mock('../../../src/services/access/rolVigente', () => ({ rolVigente: jest.fn() }))
jest.mock('../../../src/services/document-requests/venueLinks.service', () => ({
  listVenueOptions: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  listRequestVenueLinks: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  listVenueDocumentRequests: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
  getVenueDocumentRequest: jest.fn().mockResolvedValue({ link: {}, request: {}, documents: [] }),
  getVenueDocumentDownload: jest.fn().mockResolvedValue({ url: 'signed' }),
  getVenueDocumentPreview: jest.fn().mockResolvedValue({ url: 'signed', mimeType: 'application/pdf', fileName: 'Documento.pdf' }),
  linkRequestToVenue: jest.fn().mockResolvedValue({ link: { id: 'linked' }, created: true }),
}))
jest.mock('../../../src/services/document-requests/documentRequests.service', () => ({
  getAdminRequest: jest.fn().mockResolvedValue({ request: {} }),
  getPreviewUrl: jest.fn().mockResolvedValue({ url: 'signed', mimeType: 'image/png', fileName: 'Foto.png' }),
}))
import router from '../../../src/routes/superadmin/documentRequests.routes'
import * as links from '../../../src/services/document-requests/venueLinks.service'
import * as requests from '../../../src/services/document-requests/documentRequests.service'
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.authContext = { userId: cuid(), role: StaffRole.SUPERADMIN } as any
  next()
})
app.use('/docs', authorizeRole([StaffRole.SUPERADMIN]), router)
app.use((e: any, _req: any, res: any, _next: any) => res.status(e.statusCode || 500).json({ message: e.message }))
const venueId = cuid(),
  requestId = cuid(),
  linkId = cuid(),
  documentId = cuid()
const routes = [
  `/${requestId}/documents/${documentId}/preview`,
  `/venues/${venueId}/links/${linkId}/documents/${documentId}/preview`,
  `/venue-options`,
  `/${requestId}/venue-links`,
  `/venues/${venueId}`,
  `/venues/${venueId}/links/${linkId}`,
  `/venues/${venueId}/links/${linkId}/documents/${documentId}/download`,
]
beforeEach(() => {
  jest.clearAllMocks()
  ;(rolVigente as jest.Mock).mockResolvedValue(StaffRole.SUPERADMIN)
})
test.each(routes)('registers exact route %s before dynamic request detail', async path => {
  expect((await request(app).get('/docs' + path)).status).toBe(200)
})
test('venue-options dispatches picker, not request detail', async () => {
  await request(app).get('/docs/venue-options?page=2')
  expect(links.listVenueOptions).toHaveBeenCalledWith({ page: '2' })
})
test('post passes actor and explicit confirmation', async () => {
  const body = { venueId, submissionVersion: 1, confirmed: true }
  const response = await request(app).post(`/docs/${requestId}/venue-links`).send(body)
  expect(response.status).toBe(201)
  expect(links.linkRequestToVenue).toHaveBeenCalledWith(requestId, body, expect.any(String))
})
test.each([StaffRole.OWNER, StaffRole.ADMIN, StaffRole.CASHIER])(
  'rejects all new reads and write for %s even when token says superadmin',
  async role => {
    ;(rolVigente as jest.Mock).mockResolvedValue(role)
    for (const path of routes) expect((await request(app).get('/docs' + path)).status).toBe(403)
    expect(
      (await request(app).post(`/docs/${requestId}/venue-links`).send({ venueId, submissionVersion: 1, confirmed: true })).status,
    ).toBe(403)
    expect(requests.getPreviewUrl).not.toHaveBeenCalled()
    expect(links.getVenueDocumentPreview).not.toHaveBeenCalled()
    expect(links.listVenueOptions).not.toHaveBeenCalled()
    expect(links.linkRequestToVenue).not.toHaveBeenCalled()
  },
)

test('preview routes preserve exact scope, response and no-store headers', async () => {
  const current = await request(app).get(`/docs/${requestId}/documents/${documentId}/preview`)
  expect(current.status).toBe(200)
  expect(current.body).toEqual({ url: 'signed', mimeType: 'image/png', fileName: 'Foto.png' })
  expect(current.headers['cache-control']).toBe('no-store')
  expect(requests.getPreviewUrl).toHaveBeenCalledWith(requestId, documentId)
  const historical = await request(app).get(`/docs/venues/${venueId}/links/${linkId}/documents/${documentId}/preview`)
  expect(historical.status).toBe(200)
  expect(historical.body).toEqual({ url: 'signed', mimeType: 'application/pdf', fileName: 'Documento.pdf' })
  expect(historical.headers['cache-control']).toBe('no-store')
  expect(links.getVenueDocumentPreview).toHaveBeenCalledWith(venueId, linkId, documentId)
})
