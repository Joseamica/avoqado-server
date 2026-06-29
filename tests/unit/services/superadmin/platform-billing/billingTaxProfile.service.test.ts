import { prismaMock } from '@tests/__helpers__/setup'

// Mock Firebase storage so the test never touches a real bucket.
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: (p: string) => `dev/${p}`,
  uploadFileToStorage: jest.fn(),
  deleteFileFromStorage: jest.fn(),
}))
import { uploadFileToStorage, deleteFileFromStorage } from '@/services/storage.service'
import { uploadConstancia } from '@/services/superadmin/platform-billing/billingTaxProfile.service'

const mockUpload = uploadFileToStorage as jest.Mock
const mockDelete = deleteFileFromStorage as jest.Mock

describe('billingTaxProfile.service — uploadConstancia (NEW)', () => {
  it('uploads the file to Firebase under the profile path and stores the URL', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: null, venueId: null })
    mockUpload.mockResolvedValue('https://storage.googleapis.com/bucket/dev/platform-billing/tax-profiles/p1/constancia.pdf')
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ id: 'p1', ...args.data }))

    const res = await uploadConstancia('p1', Buffer.from('%PDF-1.4 test').toString('base64'), 'application/pdf')

    expect(mockUpload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringContaining('platform-billing/tax-profiles/p1/constancia.pdf'),
      'application/pdf',
    )
    expect(res.constanciaUrl).toContain('constancia.pdf')
  })

  it('best-effort deletes the prior constancia before replacing it', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: 'https://old/constancia.pdf', venueId: null })
    mockUpload.mockResolvedValue('https://new/constancia.pdf')
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ id: 'p1', ...args.data }))

    await uploadConstancia('p1', Buffer.from('x').toString('base64'), 'application/pdf')

    expect(mockDelete).toHaveBeenCalledWith('https://old/constancia.pdf')
  })

  it('rejects when the profile is not found', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(null)
    await expect(uploadConstancia('nope', 'eA==', 'application/pdf')).rejects.toMatchObject({ code: 'NO_PROFILE' })
  })

  it('rejects an empty file', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: null })
    await expect(uploadConstancia('p1', '', 'application/pdf')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
