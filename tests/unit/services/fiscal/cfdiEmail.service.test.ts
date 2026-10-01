/**
 * 🔴 Auditoría 2026-09-30 (H24): la pantalla prometía «Le enviaremos la factura a este correo» y nadie la enviaba. El correo sólo
 * viajaba como dato del receptor a Facturapi, que no envía solo. `sendInvoiceByEmail` ya existía y sólo lo usaba la
 * facturación de plataforma.
 */
const mockSend = jest.fn()
const mockResolveProvider = jest.fn(() => ({ sendInvoiceByEmail: mockSend }))
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: (...a: unknown[]) => mockResolveProvider(...(a as [])),
}))
const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...a) }))

import { prismaMock } from '@tests/__helpers__/setup'
import { correoCapturado, sendCfdiByEmail, sendNewCfdiByEmail } from '@/services/fiscal/cfdiEmail.service'
import { BadRequestError, NotFoundError, ProviderUnavailableError } from '@/errors/AppError'

const conCorreo = (email: unknown) => ({ version: 1, params: { receptor: { rfc: 'MTE123456AB1', email } } })
const STAMPED = {
  id: 'c1',
  status: 'STAMPED',
  facturapiId: 'fa_1',
  serie: 'A',
  folio: '36',
  uuid: 'UUID-1',
  entrada: conCorreo('capturado@cliente.mx'),
  fiscalEmisor: { provider: 'FACTURAPI', providerKeyEnc: 'enc' },
}
const BASE = { cfdiId: 'c1', venueId: 'v1', sandbox: true, staffId: 's1' }

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.cfdi.findFirst.mockReset().mockResolvedValue(STAMPED as any)
  mockSend.mockReset().mockResolvedValue(undefined)
})

describe('correoCapturado', () => {
  it('lee el correo que el receptor dio al facturar, sin espacios', () => {
    expect(correoCapturado(conCorreo('  a@b.mx '))).toBe('a@b.mx')
  })

  it.each([[null], [{}], [conCorreo('')], [conCorreo('   ')], [conCorreo(42)]])('sin correo utilizable (%j) ⇒ undefined', entrada => {
    expect(correoCapturado(entrada)).toBeUndefined()
  })
})

describe('sendCfdiByEmail (reenvío desde el dashboard o el MCP)', () => {
  it('con otro correo, lo manda a ése y deja CFDI_EMAIL_SENT', async () => {
    const result = await sendCfdiByEmail({ ...BASE, origin: 'REENVIO', email: 'otro@cliente.mx' })

    expect(prismaMock.cfdi.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', venueId: 'v1' } }))
    expect(mockSend).toHaveBeenCalledWith('fa_1', 'otro@cliente.mx')
    expect(result).toEqual({ folio: 'A-36', destination: 'otro@cliente.mx' })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_EMAIL_SENT',
        entity: 'Cfdi',
        entityId: 'c1',
        venueId: 'v1',
        staffId: 's1',
        data: expect.objectContaining({ folio: 'A-36', destination: 'otro@cliente.mx', origin: 'REENVIO' }),
      }),
    )
  })

  it('sin otro correo, lo manda al que el receptor dio al facturar', async () => {
    const result = await sendCfdiByEmail({ ...BASE, origin: 'REENVIO' })

    expect(mockSend).toHaveBeenCalledWith('fa_1', 'capturado@cliente.mx')
    expect(result.destination).toBe('capturado@cliente.mx')
  })

  it('factura vieja sin correo capturado: el proveedor usa el del cliente registrado', async () => {
    prismaMock.cfdi.findFirst.mockResolvedValue({ ...STAMPED, entrada: null } as any)

    const result = await sendCfdiByEmail({ ...BASE, origin: 'REENVIO' })

    expect(mockSend).toHaveBeenCalledWith('fa_1', undefined)
    expect(result.destination).toBeNull()
  })

  it('🔴 una factura de otra sucursal: 404 y no se envía', async () => {
    prismaMock.cfdi.findFirst.mockResolvedValue(null)

    await expect(sendCfdiByEmail({ ...BASE, origin: 'REENVIO' })).rejects.toBeInstanceOf(NotFoundError)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it.each([
    ['cancelada', { status: 'CANCELLED' }],
    ['sin timbre en el proveedor', { facturapiId: null }],
  ])('🔴 una factura %s: 400 y no se envía', async (_label, over) => {
    prismaMock.cfdi.findFirst.mockResolvedValue({ ...STAMPED, ...over } as any)

    await expect(sendCfdiByEmail({ ...BASE, origin: 'REENVIO' })).rejects.toBeInstanceOf(BadRequestError)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('si Facturapi falla: CFDI_EMAIL_FAILED con el motivo y 502', async () => {
    mockSend.mockRejectedValue(new Error('El correo no es válido'))

    await expect(sendCfdiByEmail({ ...BASE, origin: 'REENVIO' })).rejects.toBeInstanceOf(ProviderUnavailableError)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CFDI_EMAIL_FAILED', data: expect.objectContaining({ error: 'El correo no es válido' }) }),
    )
    expect(mockLogAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_EMAIL_SENT' }))
  })
})

describe('sendNewCfdiByEmail (una vez, justo al timbrar)', () => {
  const provider = { sendInvoiceByEmail: jest.fn() }
  beforeEach(() => provider.sendInvoiceByEmail.mockReset().mockResolvedValue(undefined))

  it('manda al correo capturado con el proveedor que timbró, como EMISION y sin autor', async () => {
    await sendNewCfdiByEmail({ cfdiId: 'c1', venueId: 'v1', provider })

    expect(provider.sendInvoiceByEmail).toHaveBeenCalledWith('fa_1', 'capturado@cliente.mx')
    expect(mockResolveProvider).not.toHaveBeenCalled()
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CFDI_EMAIL_SENT', staffId: null, data: expect.objectContaining({ origin: 'EMISION' }) }),
    )
  })

  it('sin correo capturado (p. ej. la factura global) no hace nada', async () => {
    prismaMock.cfdi.findFirst.mockResolvedValue({ ...STAMPED, entrada: conCorreo(undefined) } as any)

    await sendNewCfdiByEmail({ cfdiId: 'c1', venueId: 'v1', provider })

    expect(provider.sendInvoiceByEmail).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('🔴 si el envío truena, NO lanza (la factura ya está timbrada) y queda CFDI_EMAIL_FAILED', async () => {
    provider.sendInvoiceByEmail.mockRejectedValue(new Error('timeout'))

    await expect(sendNewCfdiByEmail({ cfdiId: 'c1', venueId: 'v1', provider })).resolves.toBeUndefined()
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_EMAIL_FAILED' }))
  })

  it('si la base falla, tampoco lanza', async () => {
    prismaMock.cfdi.findFirst.mockRejectedValue(new Error('conexión perdida'))

    await expect(sendNewCfdiByEmail({ cfdiId: 'c1', venueId: 'v1', provider })).resolves.toBeUndefined()
    expect(provider.sendInvoiceByEmail).not.toHaveBeenCalled()
  })
})

// 🔴 Codex (ronda 3 del correo): una nota de crédito capturada ANTES del 30-sep trae el correo de un perfil por RFC (quizá de otra
// persona). Una nota va siempre al correo de la factura ORIGINAL que acredita, del mismo negocio.
describe('nota de crédito (egreso): va al correo de la factura original', () => {
  const provider = { sendInvoiceByEmail: jest.fn() }
  const NOTA = {
    ...STAMPED,
    id: 'nota-1',
    entrada: { version: 1, tipo: 'EGRESO', originalCfdiId: 'orig-1', params: { receptor: { email: 'perfil.ajeno@cliente.mx' } } },
  }
  const ORIGINAL = { entrada: conCorreo('original@cliente.mx') }

  beforeEach(() => {
    provider.sendInvoiceByEmail.mockReset().mockResolvedValue(undefined)
    prismaMock.cfdi.findFirst
      .mockReset()
      .mockResolvedValueOnce(NOTA as any)
      .mockResolvedValueOnce(ORIGINAL as any)
  })

  it('al timbrar, la manda al correo de la original (nunca al que traía la nota)', async () => {
    await sendNewCfdiByEmail({ cfdiId: 'nota-1', venueId: 'v1', provider })

    expect(prismaMock.cfdi.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'orig-1', venueId: 'v1' } }))
    expect(provider.sendInvoiceByEmail).toHaveBeenCalledWith('fa_1', 'original@cliente.mx')
  })

  it('al reenviar sin otro correo, también va al de la original', async () => {
    const result = await sendCfdiByEmail({ ...BASE, cfdiId: 'nota-1', origin: 'REENVIO' })

    expect(mockSend).toHaveBeenCalledWith('fa_1', 'original@cliente.mx')
    expect(result.destination).toBe('original@cliente.mx')
  })

  it('sin factura original ligada, no se adivina: no hay envío automático', async () => {
    prismaMock.cfdi.findFirst.mockReset().mockResolvedValue({ ...NOTA, entrada: { ...NOTA.entrada, originalCfdiId: undefined } } as any)

    await sendNewCfdiByEmail({ cfdiId: 'nota-1', venueId: 'v1', provider })

    expect(provider.sendInvoiceByEmail).not.toHaveBeenCalled()
  })
})
