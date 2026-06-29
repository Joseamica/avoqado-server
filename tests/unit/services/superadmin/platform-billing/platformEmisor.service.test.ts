import { prismaMock } from '@tests/__helpers__/setup'
import { uploadPlatformEmisorCsd, provisionPlatformEmisor } from '@/services/superadmin/platform-billing/platformEmisor.service'

describe('platformEmisor.service — provider error surfacing (NEW)', () => {
  it('maps a Facturapi CSD error to VALIDATION (422) keeping its Spanish message', async () => {
    prismaMock.platformEmisor.findUnique.mockResolvedValue({ id: 'em1', providerOrgId: 'org1' })
    const provider = {
      uploadCsd: jest.fn().mockRejectedValue(new Error('El certificado no es un CSD. Asegúrate de no estar enviando una FIEL.')),
    } as any

    await expect(uploadPlatformEmisorCsd('em1', { cerBase64: 'x', keyBase64: 'y', csdPassword: 'z' }, provider)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('no es un CSD'),
    })
  })

  it('maps a Facturapi provisioning error to PROVIDER (502) with its message', async () => {
    prismaMock.platformEmisor.findUnique.mockResolvedValue({ id: 'em1', legalName: 'AVO', regimenFiscal: '601', lugarExpedicion: '05500' })
    const provider = {
      createOrganization: jest.fn().mockRejectedValue(new Error('llave de cuenta inválida')),
      updateOrgLegal: jest.fn(),
    } as any

    await expect(provisionPlatformEmisor('em1', provider)).rejects.toMatchObject({
      code: 'PROVIDER',
      message: expect.stringContaining('llave de cuenta inválida'),
    })
  })

  it('still rejects with NO_EMISOR when the emisor row is missing', async () => {
    prismaMock.platformEmisor.findUnique.mockResolvedValue(null)
    await expect(
      uploadPlatformEmisorCsd('nope', { cerBase64: 'x', keyBase64: 'y', csdPassword: 'z' }, { uploadCsd: jest.fn() } as any),
    ).rejects.toMatchObject({ code: 'NO_EMISOR' })
  })
})
