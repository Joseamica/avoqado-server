/**
 * Subir un documento KYC: quién puede, cuándo, y a quién se le avisa.
 *
 * El bug que originó estos tests (visto en prod el 2026-08-12, dos intentos
 * fallidos seguidos): el founder aprueba el KYC a mano — el venue queda VERIFIED —
 * y a partir de ahí el negocio **ya no puede subir sus documentos nunca**. El
 * guard solo permitía NOT_SUBMITTED y REJECTED, así que la aprobación manual
 * cerraba la puerta por la que todavía faltaba entrar.
 *
 * Subir un documento NO cambia el estado del KYC (eso lo hace "enviar a
 * revisión"), así que permitirlo no pisa una aprobación manual: la conserva.
 */

jest.mock('@/services/storage.service', () => ({
  uploadFileToStorage: jest.fn().mockResolvedValue('https://storage.test/doc.pdf'),
  buildStoragePath: jest.fn((path: string) => `dev/${path}`),
}))
jest.mock('@/services/superadmin/kycReview.service', () => ({
  notifySuperadminsNewKycSubmission: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))
jest.mock('@/services/resend.service', () => ({
  sendKycDocumentUploadedNotification: jest.fn().mockResolvedValue(true),
}))

import { uploadSingleKycDocument } from '@/services/dashboard/venueKyc.service'
import { sendKycDocumentUploadedNotification } from '@/services/resend.service'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as unknown as {
  venue: { findUnique: jest.Mock; update: jest.Mock }
}
const notifyMock = sendKycDocumentUploadedNotification as jest.Mock

const file = { buffer: Buffer.from('%PDF-1.4 documento'), originalname: 'comprobante.pdf', mimetype: 'application/pdf' }

const givenVenue = (overrides: Record<string, unknown> = {}) => {
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Testarudo Cafe',
    slug: 'testarudo-cafe',
    kycStatus: 'VERIFIED',
    kycRejectedDocuments: [],
    staff: [{ staffId: 'user-1', role: 'OWNER' }],
    ...overrides,
  })
  prismaMock.venue.update.mockResolvedValue({ id: 'venue-1', name: 'Testarudo Cafe' })
}

const upload = () => uploadSingleKycDocument('venue-1', 'user-1', 'comprobanteDomicilioUrl', file)

beforeEach(() => {
  jest.clearAllMocks()
  notifyMock.mockResolvedValue(true)
})

describe('🔴 subir documentos KYC tras una aprobación manual', () => {
  it('un venue VERIFIED SÍ puede subir sus documentos', async () => {
    givenVenue({ kycStatus: 'VERIFIED' })

    await expect(upload()).resolves.toMatchObject({ documentKey: 'comprobanteDomicilioUrl' })
  })

  it.each(['NOT_SUBMITTED', 'PENDING_REVIEW', 'IN_REVIEW', 'VERIFIED'])('permite subir con estado %s', async kycStatus => {
    givenVenue({ kycStatus })

    await expect(upload()).resolves.toBeDefined()
  })

  it('subir NO cambia el estado del KYC — no pisa la aprobación manual', async () => {
    givenVenue({ kycStatus: 'VERIFIED' })

    await upload()

    const updateArgs = prismaMock.venue.update.mock.calls[0][0]
    expect(updateArgs.data).not.toHaveProperty('kycStatus')
  })

  it('🔴 en REJECTED sigue sin poder tocar un documento YA aprobado', async () => {
    // Esta restricción no se relaja: en un rechazo solo se corrige lo rechazado.
    givenVenue({ kycStatus: 'REJECTED', kycRejectedDocuments: ['ineUrl'] })

    await expect(upload()).rejects.toThrow(/Cannot modify approved document/)
  })
})

describe('🔴 aviso a onboarding@avoqado.io', () => {
  it('manda el documento con el archivo adjunto', async () => {
    givenVenue()

    await upload()

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueName: 'Testarudo Cafe',
        venueId: 'venue-1',
        documentKey: 'comprobanteDomicilioUrl',
        kycStatus: 'VERIFIED',
        fileBuffer: file.buffer,
        mimeType: 'application/pdf',
        downloadUrl: 'https://storage.test/doc.pdf',
      }),
    )
  })

  it('🔴 si el correo falla, la subida NO falla — el documento ya está guardado', async () => {
    givenVenue()
    notifyMock.mockRejectedValue(new Error('Resend caído'))

    await expect(upload()).resolves.toBeDefined()
  })

  it('avisa DESPUÉS de guardar, nunca antes', async () => {
    givenVenue()

    await upload()

    expect(prismaMock.venue.update).toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalled()
    expect(prismaMock.venue.update.mock.invocationCallOrder[0]).toBeLessThan(notifyMock.mock.invocationCallOrder[0])
  })
})
