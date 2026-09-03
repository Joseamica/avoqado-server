/**
 * Carril de envío de campañas — Fase 1A, tarea 2.
 *
 * Dos piezas nuevas, probadas en el mismo archivo porque comparten el mismo mock de Resend:
 *
 * 1. `buildMarketingFrom` (marketingSender.ts) — construye el remitente del subdominio de
 *    marketing (@promos.), separado a propósito de OTP/recibos para acotar el radio de daño
 *    de un venue abusivo. El SERVICIO arma el remitente, nunca el llamador (spec ronda 2,
 *    hallazgo 11) — de ahí las pruebas de saneado contra inyección de cabeceras.
 * 2. `emailService.sendEmailWithResult` (email.service.ts) — hermano de `sendEmail` (el
 *    booleano, ~40 llamadores, INTACTO) que devuelve `{ ok, resendId, errorCode, transient }`
 *    porque el carril de campañas necesita el `resendId` para conciliar webhooks y distinguir
 *    un fallo reintentable de uno terminal.
 */

// El servicio de correo captura `RESEND_API_KEY` al importarse, así que se define antes del require.
process.env.RESEND_API_KEY = 'test-key'

const sendMock = jest.fn()

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}))

import { buildMarketingFrom } from '@/services/marketing/marketingSender'
import emailService from '@/services/email.service'

describe('buildMarketingFrom', () => {
  it('usa la dirección del subdominio de marketing, no la transaccional', () => {
    expect(buildMarketingFrom('Café Testarudo')).toMatch(/@promos\./)
  })

  it('🔴 sanea salto de línea y retorno de carro (inyección de cabeceras)', () => {
    const from = buildMarketingFrom('Malo\r\nBcc: victima@ejemplo.mx')
    expect(from).not.toMatch(/[\r\n]/)
    expect(from).not.toMatch(/Bcc:/i)
  })

  it('escapa las comillas del nombre en vez de romper el formato', () => {
    expect(buildMarketingFrom('El "Mejor" Café')).not.toContain('"El "Mejor"')
  })

  it('un nombre vacío cae a un display name genérico, nunca a comillas vacías', () => {
    expect(buildMarketingFrom('   ')).toMatch(/^"[^"]+" </)
  })
})

describe('emailService.sendEmailWithResult', () => {
  beforeEach(() => sendMock.mockClear())

  const payload = { to: 'onboarding@avoqado.io', subject: 'Promo de temporada', html: '<p>hola</p>' }

  it('ok:true con el resendId cuando Resend acepta el envío', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 'resend-abc123' }, error: null })

    const result = await emailService.sendEmailWithResult(payload)

    expect(result).toEqual({ ok: true, resendId: 'resend-abc123', transient: false })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('transient:true cuando Resend responde 429 (límite de tasa)', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' },
    })

    const result = await emailService.sendEmailWithResult(payload)

    expect(result.ok).toBe(false)
    expect(result.transient).toBe(true)
    expect(result.errorCode).toBe('rate_limit_exceeded')
  })

  it('transient:true cuando Resend responde 408 (timeout)', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 408, name: 'timeout', message: 'Request timed out' },
    })

    const result = await emailService.sendEmailWithResult(payload)

    expect(result.transient).toBe(true)
  })

  it('transient:true cuando Resend responde 5xx (error del proveedor)', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 500, name: 'internal_server_error', message: 'boom' },
    })

    const result = await emailService.sendEmailWithResult(payload)

    expect(result.ok).toBe(false)
    expect(result.transient).toBe(true)
    expect(result.errorCode).toBe('internal_server_error')
  })

  it('transient:false en un 4xx de validación (no reintentable)', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, name: 'validation_error', message: 'invalid payload' },
    })

    const result = await emailService.sendEmailWithResult(payload)

    expect(result.ok).toBe(false)
    expect(result.transient).toBe(false)
    expect(result.errorCode).toBe('validation_error')
  })

  it('transient:true cuando no hubo respuesta HTTP (excepción de red)', async () => {
    sendMock.mockRejectedValueOnce(new Error('network down'))

    const result = await emailService.sendEmailWithResult(payload)

    expect(result.ok).toBe(false)
    expect(result.transient).toBe(true)
  })

  // 🔴 Fix round 1 — el revisor marcó esto [Important]: el motor de campañas reintenta de
  // forma DURABLE en Postgres con backoff de hasta 24h y sobrevive a un redeploy. Si falta
  // RESEND_API_KEY (secreto rotado, .env incompleto) y alguien lo corrige dos minutos después,
  // con transient:false la tarea 7 ya habría mandado esas entregas a DEAD para siempre. Este
  // test PIN la clasificación para que un refactor futuro no la voltee sin que nada falle.
  it('🔴 transient:true cuando el servicio no está disponible (config, no destinatario) — reintentable', async () => {
    await jest.isolateModulesAsync(async () => {
      const previousKey = process.env.RESEND_API_KEY
      delete process.env.RESEND_API_KEY

      try {
        const freshModule = await import('@/services/email.service')
        const freshEmailService = freshModule.default

        const result = await freshEmailService.sendEmailWithResult(payload)

        expect(result).toEqual({ ok: false, transient: true, errorCode: 'EMAIL_SERVICE_UNAVAILABLE' })
      } finally {
        process.env.RESEND_API_KEY = previousKey
      }
    })
  })

  // Ruling de interfaz — `from`/`tags` son exclusivos de `sendEmailWithResult`: T7 los usa para
  // mandar por `buildMarketingFrom` y para correlacionar el `deliveryId` con los webhooks de
  // Resend. Ambos se pasan al payload SÓLO si vienen.
  it('manda con el `from` y los `tags` dados, cuando vienen', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 'resend-con-tags' }, error: null })

    await emailService.sendEmailWithResult({
      ...payload,
      from: '"Café Testarudo via Avoqado" <promos@promos.avoqado.io>',
      tags: [{ name: 'deliveryId', value: 'delivery-123' }],
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    const sentPayload = sendMock.mock.calls[0][0]
    expect(sentPayload.from).toBe('"Café Testarudo via Avoqado" <promos@promos.avoqado.io>')
    expect(sentPayload.tags).toEqual([{ name: 'deliveryId', value: 'delivery-123' }])
  })

  it('regresión: sin `from`/`tags`, manda con el FROM transaccional y sin tags', async () => {
    sendMock.mockResolvedValueOnce({ data: { id: 'resend-sin-tags' }, error: null })

    await emailService.sendEmailWithResult(payload)

    expect(sendMock).toHaveBeenCalledTimes(1)
    const sentPayload = sendMock.mock.calls[0][0]
    expect(sentPayload.from).toBe('Avoqado <noreply@avoqado.io>')
    expect(sentPayload.tags).toBeUndefined()
  })
})
