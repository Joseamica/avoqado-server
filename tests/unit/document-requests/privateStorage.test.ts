import { getStorageBucket } from '@/config/firebase'
import { buildPrivateFilePath, savePrivateFileAtPath, signPrivateAttachmentUrl } from '@/services/privateStorage.service'

jest.mock('@/config/firebase', () => ({ getStorageBucket: jest.fn() }))
jest.mock('@/services/storage.service', () => ({ getStorageEnvPrefix: () => 'dev' }))

describe('Document private storage — new writes and downloads', () => {
  const save = jest.fn().mockResolvedValue(undefined)
  const getSignedUrl = jest.fn().mockResolvedValue(['https://storage.example/signed'])
  const makePublic = jest.fn()
  const file = jest.fn(() => ({ save, getSignedUrl, makePublic }))

  beforeEach(() => {
    jest.clearAllMocks()
    ;(getStorageBucket as jest.Mock).mockReturnValue({ bucket: () => ({ file }) })
  })

  it('records deterministic private paths before uploading bytes', () => {
    expect(buildPrivateFilePath('document-requests/c123', 'c456.pdf')).toBe('private/dev/document-requests/c123/c456.pdf')
  })

  it('writes create-only without public ACLs or Firebase download tokens', async () => {
    await savePrivateFileAtPath('private/dev/document-requests/c123/c456.pdf', Buffer.from('%PDF'), 'application/pdf')
    expect(file).toHaveBeenCalledWith('private/dev/document-requests/c123/c456.pdf')
    expect(save).toHaveBeenCalledWith(
      Buffer.from('%PDF'),
      expect.objectContaining({
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: 'private, no-store', contentDisposition: 'attachment' },
      }),
    )
    expect(makePublic).not.toHaveBeenCalled()
  })

  it('signs short-lived attachment downloads instead of embedding documents', async () => {
    const now = Date.now()
    await expect(signPrivateAttachmentUrl('private/dev/document-requests/c123/c456.pdf')).resolves.toBe('https://storage.example/signed')
    const options = getSignedUrl.mock.calls[0][0]
    expect(options).toMatchObject({ action: 'read', version: 'v4', responseDisposition: 'attachment' })
    expect(options.expires).toBeGreaterThanOrEqual(now + 10 * 60_000)
    expect(options.expires).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  })
})

describe('Document private storage — boundary regression', () => {
  it.each([
    ['document-requests/../another', 'file.pdf'],
    ['document-requests/c123', '../file.pdf'],
    ['document-requests/c123', 'file/secret.pdf'],
  ])('rejects traversal in %s / %s', (scope, name) => {
    expect(() => buildPrivateFilePath(scope, name)).toThrow('Ámbito inválido')
  })

  it('never signs or writes a path outside the private prefix', async () => {
    await expect(signPrivateAttachmentUrl('prod/venues/example/kyc/file.pdf')).rejects.toThrow('almacenamiento privado')
    await expect(savePrivateFileAtPath('public/file.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow('almacenamiento privado')
  })
})
