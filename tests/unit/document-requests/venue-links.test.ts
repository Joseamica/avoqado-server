import cuid from 'cuid'
jest.mock('../../../src/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    venue: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    documentRequest: { findUnique: jest.fn() },
    documentRequestVenueLink: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  },
}))
jest.mock('../../../src/services/privateStorage.service', () => ({ signPrivateAttachmentUrl: jest.fn().mockResolvedValue('signed') }))
import prisma from '../../../src/utils/prismaClient'
import { signPrivateAttachmentUrl } from '../../../src/services/privateStorage.service'
import * as service from '../../../src/services/document-requests/venueLinks.service'
const requestId = cuid(),
  venueId = cuid(),
  organizationId = cuid(),
  actorId = cuid(),
  submissionId = cuid(),
  documentId = cuid()
let tx: any, r: any, v: any, submission: any, links: any[]
beforeEach(() => {
  jest.clearAllMocks()
  r = {
    id: requestId,
    status: 'SUBMITTED',
    submissionVersion: 1,
    submittedAt: new Date(),
    businessName: 'Estudio',
    provider: 'BLUMON',
    entityType: 'PERSONA_FISICA',
    organizationId: null,
    contactName: 'Ana',
    email: 'ana@example.org',
    phone: '5512345678',
  }
  v = {
    id: venueId,
    organizationId,
    name: 'Estudio Centro',
    slug: 'estudio-centro',
    entityType: 'PERSONA_FISICA',
    organization: { name: 'Grupo' },
  }
  submission = { id: submissionId, requestId, submissionVersion: 1, snapshot: { ...r } }
  links = []
  tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ id: venueId, organizationId }]),
    documentRequest: { findUnique: jest.fn(() => r), update: jest.fn(({ data }) => Object.assign(r, data)) },
    venue: { findUnique: jest.fn(() => v) },
    documentRequestFile: { findMany: jest.fn().mockResolvedValue([{ id: documentId, requestId, status: 'READY' }]) },
    documentRequestSubmission: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) => ({ ...data, id: submissionId })),
    },
    documentRequestVenueLink: {
      findUnique: jest.fn(() => links[0] || null),
      create: jest.fn(({ data }) => {
        const link = { ...data, id: cuid(), linkedAt: new Date(), submission, venue: v }
        links.push(link)
        return link
      }),
    },
    activityLog: { create: jest.fn() },
  }
  ;(prisma.$transaction as jest.Mock).mockImplementation(fn => (typeof fn === 'function' ? fn(tx) : Promise.all(fn)))
  ;(prisma.venue.findUnique as jest.Mock).mockImplementation(() => v)
})
describe('explicit venue links', () => {
  test('creates snapshot and pins organization exactly once; same link replay is idempotent', async () => {
    const input = { venueId, submissionVersion: 1, confirmed: true as const }
    const first = await service.linkRequestToVenue(requestId, input, actorId)
    expect(first.created).toBe(true)
    expect(r.organizationId).toBe(organizationId)
    expect(tx.documentRequestSubmission.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ files: { create: [{ documentId }] } }) }),
    )
    const second = await service.linkRequestToVenue(requestId, input, actorId)
    expect(second.created).toBe(false)
    expect(second.link.id).toBe(first.link.id)
    expect(tx.documentRequestVenueLink.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })
  test.each(['draft', 'version', 'organization', 'entity', 'confirmation'])('rejects %s without writing a link', async scenario => {
    const input = { venueId, submissionVersion: 1, confirmed: true }
    if (scenario === 'draft') r.status = 'OPEN'
    if (scenario === 'version') input.submissionVersion = 2
    if (scenario === 'organization') r.organizationId = cuid()
    if (scenario === 'entity') v.entityType = 'PERSONA_MORAL'
    if (scenario === 'confirmation') input.confirmed = false
    await expect(service.linkRequestToVenue(requestId, input, actorId)).rejects.toThrow()
    expect(tx.documentRequestVenueLink.create).not.toHaveBeenCalled()
  })
  test('refuses venue moved between initial lookup and row lock', async () => {
    tx.venue.findUnique.mockResolvedValue({ ...v, organizationId: cuid() })
    await expect(service.linkRequestToVenue(requestId, { venueId, submissionVersion: 1, confirmed: true }, actorId)).rejects.toThrow()
    expect(tx.documentRequestVenueLink.create).not.toHaveBeenCalled()
  })
  test('venue picker enforces clamp, stable second page and total independent of page rows', async () => {
    ;(prisma.venue.findMany as jest.Mock).mockResolvedValue([v])
    ;(prisma.venue.count as jest.Mock).mockResolvedValue(201)
    const result = await service.listVenueOptions({ page: 2, pageSize: 10000, search: 'Centro' })
    expect(result).toMatchObject({ total: 201, page: 2, pageSize: 100 })
    expect(prisma.venue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        skip: 100,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        where: expect.objectContaining({ OR: expect.any(Array) }),
      }),
    )
    expect(JSON.stringify(result)).not.toMatch(/tokenHash|storagePath|credentials/)
  })
  test('download only signs file belonging to matching venue, link and organization', async () => {
    const link = {
      id: cuid(),
      requestId,
      organizationId,
      venueId,
      submissionId,
      linkedAt: new Date(),
      submission,
      venue: v,
      request: { organizationId },
    }
    ;(prisma.documentRequestVenueLink.findFirst as jest.Mock).mockResolvedValue({
      ...link,
      submission: {
        ...submission,
        files: [{ document: { id: documentId, requestId, status: 'ARCHIVED', storagePath: 'private/immutable.pdf' } }],
      },
    })
    await expect(service.getVenueDocumentDownload(venueId, link.id, documentId)).resolves.toEqual({ url: 'signed' })
    expect(signPrivateAttachmentUrl).toHaveBeenCalledWith('private/immutable.pdf')
    ;(prisma.documentRequestVenueLink.findFirst as jest.Mock).mockResolvedValue({ ...link, organizationId: cuid() })
    await expect(service.getVenueDocumentDownload(venueId, link.id, documentId)).rejects.toThrow()
    expect(signPrivateAttachmentUrl).toHaveBeenCalledTimes(1)
  })
})

test.each([
  { submissionVersion: 1, confirmed: true },
  { venueId, submissionVersion: 'incorrecta', confirmed: true },
])('missing or malformed selection fields produce Spanish validation errors', async input => {
  await expect(service.linkRequestToVenue(requestId, input, actorId)).rejects.toThrow(/Revisa el campo/)
})
