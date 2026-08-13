/**
 * El correo que lleva un documento KYC al buzón de onboarding en cuanto el negocio lo sube.
 *
 * Existe porque el KYC se aprueba a mano antes de que lleguen todos los papeles: sin este
 * aviso, el documento que llegaba después se quedaba en storage y nadie se enteraba — la
 * aprobación ya estaba dada y no había pantalla que alguien estuviera mirando.
 *
 * Va ADJUNTO a propósito: la bandeja debe bastar para actuar, sin abrir el dashboard.
 */

// A test file with no top-level import/export is a SCRIPT, not a module, so its
// top-level `const`s land in the global scope and collide across files — two
// suites both declaring `mockSend` broke the typecheck, not the tests. This
// keeps the file a module even when it needs no imports.
export {}
const mockSend = jest.fn()

jest.mock('resend', () => ({
  __esModule: true,
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}))

describe('sendKycDocumentUploadedNotification', () => {
  const buildData = (overrides: Record<string, unknown> = {}) => ({
    venueName: 'Testarudo Cafe',
    venueId: 'cms1qzg6o02jxi32bkm2ta66g',
    venueSlug: 'testarudo-cafe',
    documentKey: 'comprobanteDomicilioUrl',
    documentLabel: 'Comprobante de Domicilio',
    kycStatus: 'VERIFIED',
    fileName: 'testarudo-cafe-Comprobante_Domicilio.pdf',
    fileBuffer: Buffer.from('%PDF-1.4 documento'),
    mimeType: 'application/pdf',
    downloadUrl: 'https://storage.googleapis.com/doc.pdf',
    ...overrides,
  })

  const loadSut = async () => (await import('@/services/resend.service')).sendKycDocumentUploadedNotification

  beforeEach(() => {
    jest.resetModules()
    mockSend.mockReset()
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null })
    process.env.RESEND_API_KEY = 're_test_key'
    delete process.env.ONBOARDING_NOTIFICATIONS_EMAIL
  })

  it('🔴 va al buzón de onboarding con el documento adjunto', async () => {
    const send = await loadSut()

    await expect(send(buildData() as never)).resolves.toBe(true)

    const payload = mockSend.mock.calls[0][0]
    expect(payload.to).toBe('onboarding@avoqado.io')
    expect(payload.attachments).toEqual([{ filename: 'testarudo-cafe-Comprobante_Domicilio.pdf', content: expect.any(Buffer) }])
  })

  it('respeta el alias configurado por env si el buzón se mueve', async () => {
    process.env.ONBOARDING_NOTIFICATIONS_EMAIL = 'kyc@avoqado.io'
    const send = await loadSut()

    await send(buildData() as never)

    expect(mockSend.mock.calls[0][0].to).toBe('kyc@avoqado.io')
  })

  it('avisa cuando el documento llegó con el negocio YA verificado', async () => {
    const send = await loadSut()

    await send(buildData({ kycStatus: 'VERIFIED' }) as never)

    // Es justo el caso que hay que notar: la aprobación manual corrió antes que los papeles.
    expect(mockSend.mock.calls[0][0].html).toContain('ya estaba')
    expect(mockSend.mock.calls[0][0].text).toContain('VERIFICADO')
  })

  it('no lo menciona cuando el KYC todavía no estaba aprobado', async () => {
    const send = await loadSut()

    await send(buildData({ kycStatus: 'NOT_SUBMITTED' }) as never)

    expect(mockSend.mock.calls[0][0].text).not.toContain('VERIFICADO')
  })

  it('🔴 un archivo demasiado grande viaja como enlace, no rompe el envío', async () => {
    const send = await loadSut()

    await expect(send(buildData({ fileBuffer: Buffer.alloc(6 * 1024 * 1024) }) as never)).resolves.toBe(true)

    const payload = mockSend.mock.calls[0][0]
    expect(payload.attachments).toBeUndefined()
    expect(payload.html).toContain('https://storage.googleapis.com/doc.pdf')
  })

  it('🔴 devuelve false en vez de lanzar cuando Resend falla', async () => {
    // El documento ya está guardado: perder la subida por un fallo de correo sería peor.
    mockSend.mockRejectedValue(new Error('Resend caído'))
    const send = await loadSut()

    await expect(send(buildData() as never)).resolves.toBe(false)
  })

  it('devuelve false, sin lanzar, cuando Resend responde con error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'rate limited' } })
    const send = await loadSut()

    await expect(send(buildData() as never)).resolves.toBe(false)
  })

  it('no intenta enviar si Resend no está configurado', async () => {
    delete process.env.RESEND_API_KEY
    const send = await loadSut()

    await expect(send(buildData() as never)).resolves.toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  describe('documento subido durante el alta (aún no hay venue)', () => {
    it('🔴 no pone CTA de revisión: el venue todavía no existe y el link estaría roto', async () => {
      const send = await loadSut()

      await send(buildData({ origin: 'onboarding', kycStatus: 'ONBOARDING' }) as never)

      const { html, text } = mockSend.mock.calls[0][0]
      expect(html).not.toContain('Revisar el KYC')
      expect(text).not.toContain('Revisar el KYC')
    })

    it('sigue llevando el documento adjunto y su enlace', async () => {
      const send = await loadSut()

      await send(buildData({ origin: 'onboarding' }) as never)

      const payload = mockSend.mock.calls[0][0]
      expect(payload.attachments).toHaveLength(1)
      expect(payload.html).toContain('https://storage.googleapis.com/doc.pdf')
    })
  })

  describe('estándar de diseño de emails de Avoqado', () => {
    it('cumple las no-negociables: sin emoji en el asunto, isotipo 2 veces, CTA negro, cuerpo de texto', async () => {
      const send = await loadSut()
      await send(buildData() as never)
      const { subject, html, text } = mockSend.mock.calls[0][0]

      expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(subject.length).toBeLessThanOrEqual(60)
      expect(html.match(/https:\/\/avoqado\.io\/isotipo\.svg/g)?.length).toBeGreaterThanOrEqual(2)
      expect(html).toContain('background-color: #000000')
      expect(html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
      expect(text.trim().length).toBeGreaterThan(0)
    })

    it('no usa gradientes ni hero de color, que es lo que se está migrando fuera', async () => {
      const send = await loadSut()
      await send(buildData() as never)

      expect(mockSend.mock.calls[0][0].html).not.toContain('gradient')
    })
  })
})
