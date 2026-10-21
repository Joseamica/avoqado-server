import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { getStorageBucket } from '@/config/firebase'
import * as storage from '@/services/privateStorage.service'
import * as requests from '@/services/document-requests/documentRequests.service'
import * as links from '@/services/document-requests/venueLinks.service'

jest.mock('@/config/env', () => ({ FRONTEND_URL: 'http://localhost:5173' }))
jest.mock('@/config/firebase', () => ({ getStorageBucket: jest.fn() }))
jest.mock('@/services/storage.service', () => ({ getStorageEnvPrefix: () => 'dev' }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { documentRequestFile: { findFirst: jest.fn() }, documentRequestVenueLink: { findFirst: jest.fn() } },
}))

const requestId = cuid(),
  documentId = cuid(),
  venueId = cuid(),
  linkId = cuid(),
  organizationId = cuid()
const signed = jest.fn().mockResolvedValue(['https://storage.example/temporary'])
const bucketFile = jest.fn(() => ({ getSignedUrl: signed }))
let document: any, link: any
beforeEach(() => {
  jest.clearAllMocks()
  ;(getStorageBucket as jest.Mock).mockReturnValue({ bucket: () => ({ file: bucketFile }) })
  document = {
    id: documentId,
    requestId,
    status: 'READY',
    storagePath: 'private/dev/document.pdf',
    mimeType: 'application/pdf',
    fileName: 'Documento.pdf',
  }
  link = {
    id: linkId,
    venueId,
    requestId,
    organizationId,
    venue: { organizationId },
    request: { organizationId },
    submission: { requestId, files: [{ document }] },
  }
  ;(prisma.documentRequestFile.findFirst as jest.Mock).mockImplementation(({ where }) =>
    where.id === document.id && where.requestId === document.requestId && where.status === document.status ? document : null,
  )
  ;(prisma.documentRequestVenueLink.findFirst as jest.Mock).mockImplementation(({ where, include }) =>
    where.id === link.id && where.venueId === link.venueId
      ? {
          ...link,
          submission: {
            ...link.submission,
            files: link.submission.files.filter((f: any) => f.document.id === include.submission.include.files.where.documentId),
          },
        }
      : null,
  )
})

describe('private document preview', () => {
  test.each(['application/pdf', 'image/jpeg', 'image/png'])('signs %s inline with exact MIME and ten-minute V4 read', async mimeType => {
    const now = Date.now()
    await expect(storage.signPrivatePreviewUrl(document.storagePath, mimeType)).resolves.toBe('https://storage.example/temporary')
    expect(bucketFile).toHaveBeenCalledWith(document.storagePath)
    const options = signed.mock.calls[0][0]
    expect(options).toMatchObject({ action: 'read', version: 'v4', responseDisposition: 'inline', responseType: mimeType })
    expect(options.expires).toBeGreaterThanOrEqual(now + 600000)
    expect(options.expires).toBeLessThanOrEqual(Date.now() + 600000)
  })
  test.each(['text/html', 'image/svg+xml', 'application/pdf; charset=utf-8', 'IMAGE/PNG', ''])(
    'rejects untrusted MIME %s before storage access',
    async mimeType => {
      await expect(storage.signPrivatePreviewUrl(document.storagePath, mimeType)).rejects.toMatchObject({ statusCode: 400 })
      expect(bucketFile).not.toHaveBeenCalled()
    },
  )
  test.each(['public/file.pdf', 'private/../file.pdf'])('rejects non-private/traversal path %s', async path => {
    await expect(storage.signPrivatePreviewUrl(path, 'application/pdf')).rejects.toMatchObject({ statusCode: 400 })
    expect(bucketFile).not.toHaveBeenCalled()
  })
  test('request preview returns only URL and display metadata, download stays attachment', async () => {
    await expect(requests.getPreviewUrl(requestId, documentId)).resolves.toEqual({
      url: 'https://storage.example/temporary',
      mimeType: 'application/pdf',
      fileName: 'Documento.pdf',
    })
    await requests.getDownloadUrl(requestId, documentId)
    expect(signed.mock.calls.map(([options]) => options.responseDisposition)).toEqual(['inline', 'attachment'])
  })
  test.each(['ARCHIVED', 'PENDING', 'DELETING', 'DELETED'])('request excludes %s document without signing', async status => {
    document.status = status
    await expect(requests.getPreviewUrl(requestId, documentId)).rejects.toMatchObject({ statusCode: 404 })
    expect(signed).not.toHaveBeenCalled()
  })
  test.each(['request', 'document'])('request rejects a different %s without signing', async changed => {
    await expect(
      requests.getPreviewUrl(changed === 'request' ? cuid() : requestId, changed === 'document' ? cuid() : documentId),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(signed).not.toHaveBeenCalled()
  })
  test.each(['READY', 'ARCHIVED'])('linked snapshot can preview %s without exposing the path', async status => {
    document.status = status
    await expect(links.getVenueDocumentPreview(venueId, linkId, documentId)).resolves.toEqual({
      url: 'https://storage.example/temporary',
      mimeType: 'application/pdf',
      fileName: 'Documento.pdf',
    })
  })
  test.each(['venue', 'link', 'document', 'organization', 'requestOrganization', 'request', 'submission', 'state'])(
    'linked preview refuses mismatched %s before signing',
    async changed => {
      if (changed === 'organization') link.venue.organizationId = cuid()
      if (changed === 'requestOrganization') link.request.organizationId = cuid()
      if (changed === 'request') document.requestId = cuid()
      if (changed === 'submission') link.submission.requestId = cuid()
      if (changed === 'state') document.status = 'DELETING'
      await expect(
        links.getVenueDocumentPreview(
          changed === 'venue' ? cuid() : venueId,
          changed === 'link' ? cuid() : linkId,
          changed === 'document' ? cuid() : documentId,
        ),
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(signed).not.toHaveBeenCalled()
    },
  )
  test('unsupported stored MIME is refused by both services', async () => {
    document.mimeType = 'text/html'
    await expect(requests.getPreviewUrl(requestId, documentId)).rejects.toMatchObject({ statusCode: 400 })
    await expect(links.getVenueDocumentPreview(venueId, linkId, documentId)).rejects.toMatchObject({ statusCode: 400 })
    expect(signed).not.toHaveBeenCalled()
  })
})
