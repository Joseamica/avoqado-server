// tests/unit/services/marketing/campaignSender.service.test.ts
/**
 * 🔴 Es la tarea más delicada del carril: decide, correo por correo, si sale o no. La mitad
 * de estas pruebas fija la FORMA de las llamadas (el `where` del CAS, lo que se le manda a
 * `sendEmailWithResult`), no sólo el resultado que decide el mock — porque un `where` que
 * pierde el CAS o un `catch` que reintenta un correo ya aceptado por Resend son exactamente
 * los defectos que un mock complaciente no cazaría si sólo se comparara el resultado final.
 */
import { enviarDelivery } from '@/services/marketing/campaignSender.service'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { isSuppressed } from '@/services/marketing/emailSuppression.service'
import { devolverCuota } from '@/services/marketing/emailQuota.service'
import { signCustomerUnsubscribeToken } from '@/utils/customerActionToken'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customerCampaignDelivery: { findUnique: jest.fn(), updateMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmailWithResult: jest.fn() },
}))

jest.mock('@/services/marketing/emailSuppression.service', () => {
  const actual = jest.requireActual('@/services/marketing/emailSuppression.service')
  return { ...actual, isSuppressed: jest.fn() }
})

jest.mock('@/services/marketing/emailQuota.service', () => {
  // `periodoDeEnvio` se usa REAL — es la única forma de que la prueba de R2 (el período
  // que se le devuelve a la cuota) sea una prueba de verdad y no un mock aprobándose a sí
  // mismo. Sólo `devolverCuota` se mockea, para no tener que armar un tx real de Postgres.
  const actual = jest.requireActual('@/services/marketing/emailQuota.service')
  return { ...actual, devolverCuota: jest.fn() }
})

jest.mock('@/utils/customerActionToken', () => ({
  signCustomerUnsubscribeToken: jest.fn(() => 'TOKEN123'),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/config/env', () => ({
  env: { BASE_URL: undefined, MARKETING_FROM_EMAIL: 'promos@promos.avoqado.io' },
}))

const findUniqueMock = (prisma as any).customerCampaignDelivery.findUnique as jest.Mock
const updateManyMock = (prisma as any).customerCampaignDelivery.updateMany as jest.Mock
const venueFindUniqueMock = (prisma as any).venue.findUnique as jest.Mock
const transactionMock = (prisma as any).$transaction as jest.Mock
const sendEmailWithResultMock = (emailService as any).sendEmailWithResult as jest.Mock
const isSuppressedMock = isSuppressed as jest.Mock
const devolverCuotaMock = devolverCuota as jest.Mock
const signTokenMock = signCustomerUnsubscribeToken as jest.Mock

const AHORA = new Date('2026-09-01T12:00:00.000Z') // mediodía UTC = ya es septiembre en México
const VENUE = { id: 'venue-1', name: 'Testarudo Café', email: 'hola@testarudo.mx', phone: null, timezone: 'America/Mexico_City' }

function baseDelivery(overrides: Record<string, any> = {}) {
  return {
    id: 'dlv-1',
    campaignId: 'camp-1',
    automationId: null,
    customerId: 'cust-1',
    venueId: 'venue-1',
    dedupeKey: 'camp-1:cust-1',
    status: 'SENDING',
    sendAttemptAt: AHORA,
    attempts: 1,
    nextAttemptAt: null,
    leaseUntil: new Date(AHORA.getTime() + 5 * 60_000),
    resendId: null,
    openedAt: null,
    clickedAt: null,
    lastError: null,
    createdAt: AHORA,
    updatedAt: AHORA,
    campaign: {
      id: 'camp-1',
      venueId: 'venue-1',
      status: 'ENQUEUED',
      subject: 'Promo de septiembre',
      htmlBody: '<p>PROMO</p>',
      textBody: 'PROMO',
      sendNoLaterThan: null as Date | null,
      scheduledFor: null as Date | null,
    },
    customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: true, active: true },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  transactionMock.mockImplementation(async (cb: any) => cb(prisma))
  venueFindUniqueMock.mockResolvedValue(VENUE)
  updateManyMock.mockResolvedValue({ count: 1 })
  isSuppressedMock.mockResolvedValue(false)
  devolverCuotaMock.mockResolvedValue(undefined)
  signTokenMock.mockReturnValue('TOKEN123')
})

describe('enviarDelivery — relectura al borde y el lease', () => {
  it('la delivery no existe ⇒ UNKNOWN, no se toca nada', async () => {
    findUniqueMock.mockResolvedValue(null)

    const resultado = await enviarDelivery('missing', { ahora: AHORA })

    expect(resultado).toBe('UNKNOWN')
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('🔴 status ya no es SENDING (otro worker la reclamó) ⇒ SKIPPED sin tocar la fila', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ status: 'PENDING' }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('🔴 leaseUntil ya venció ⇒ SKIPPED sin tocar la fila', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ leaseUntil: new Date(AHORA.getTime() - 1) }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it('🔴 leaseUntil es nulo ⇒ SKIPPED sin tocar la fila', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ leaseUntil: null }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})

describe('R1 — los cinco motivos de SKIP, evaluados al borde', () => {
  it('R6a — a) consentimiento revocado ⇒ SKIPPED, sendEmailWithResult NUNCA se llama', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({ customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: false, active: true } }),
    )

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED' }) }))
    // sendAttemptAt YA estaba fijado (lo puso el reclamo del scheduler) ⇒ NO se devuelve cuota.
    expect(devolverCuotaMock).not.toHaveBeenCalled()
  })

  it('a) cliente inactivo ⇒ SKIPPED', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({ customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: true, active: false } }),
    )

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('guarda técnica adicional: sin correo registrado ⇒ SKIPPED (no es una de las 5 letras, pero es obligatoria)', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ customer: { id: 'cust-1', email: null, marketingConsent: true, active: true } }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('b) el correo está en la lista de supresión global ⇒ SKIPPED', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    isSuppressedMock.mockResolvedValue(true)

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(isSuppressedMock).toHaveBeenCalledWith('ana@ejemplo.mx')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it.each(['CANCELLED', 'BLOCKED', 'EXPIRED'])('c) la campaña está %s ⇒ SKIPPED', async status => {
    findUniqueMock.mockResolvedValue(baseDelivery({ campaign: { ...baseDelivery().campaign, status } }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('d) venció sendNoLaterThan ⇒ SKIPPED, una promo tardía hace daño', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({ campaign: { ...baseDelivery().campaign, sendNoLaterThan: new Date('2026-08-31T00:00:00.000Z') } }),
    )

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('d) sin sendNoLaterThan, cae a scheduledFor + 24h, y ya venció ⇒ SKIPPED', async () => {
    // scheduledFor hace 25h — el tope implícito (scheduledFor+24h) ya pasó.
    const scheduledFor = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000)
    findUniqueMock.mockResolvedValue(baseDelivery({ campaign: { ...baseDelivery().campaign, scheduledFor } }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
  })

  it('d) dentro de scheduledFor + 24h todavía ⇒ NO se salta por vencimiento', async () => {
    const scheduledFor = new Date(AHORA.getTime() - 23 * 60 * 60 * 1000)
    findUniqueMock.mockResolvedValue(baseDelivery({ campaign: { ...baseDelivery().campaign, scheduledFor } }))
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SENT')
  })

  it('e) el venue no existe ⇒ SKIPPED', async () => {
    venueFindUniqueMock.mockResolvedValue(null)
    findUniqueMock.mockResolvedValue(baseDelivery())

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })

  it('e) el venue no tiene nombre ⇒ SKIPPED (LFPC: sin identificar al responsable no se manda)', async () => {
    venueFindUniqueMock.mockResolvedValue({ ...VENUE, name: '   ' })
    findUniqueMock.mockResolvedValue(baseDelivery())

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
  })

  it('e) el venue no tiene NINGÚN dato de contacto (ni email ni teléfono) ⇒ SKIPPED', async () => {
    venueFindUniqueMock.mockResolvedValue({ ...VENUE, email: null, phone: null })
    findUniqueMock.mockResolvedValue(baseDelivery())

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
  })

  it('e) con SÓLO teléfono (sin correo) el venue SÍ se identifica ⇒ no se salta por (e)', async () => {
    venueFindUniqueMock.mockResolvedValue({ ...VENUE, email: null, phone: '5555555555' })
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SENT')
  })

  it('campaignId nulo (automatización, Fase 2, aún no soportada) ⇒ SKIPPED', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ campaignId: null, automationId: 'auto-1', campaign: null }))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(sendEmailWithResultMock).not.toHaveBeenCalled()
  })
})

describe('R2 — devolución de cuota: SÓLO si sendAttemptAt era null', () => {
  it('sendAttemptAt YA estaba fijado (camino normal, vía el reclamo del scheduler) ⇒ NO se devuelve cuota', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({
        sendAttemptAt: AHORA,
        customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: false, active: true },
      }),
    )

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    expect(devolverCuotaMock).not.toHaveBeenCalled()
  })

  it('🔴 sendAttemptAt NUNCA se fijó (nunca pasó por el reclamo del scheduler) ⇒ SÍ se devuelve la cuota, con el período correcto', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({
        sendAttemptAt: null,
        customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: false, active: true },
      }),
    )

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SKIPPED')
    // createdAt = AHORA (mediodía UTC del 1-sep) = madrugada del 1-sep en México ⇒ '2026-09'.
    expect(devolverCuotaMock).toHaveBeenCalledWith(prisma, { venueId: 'venue-1', period: '2026-09', cantidad: 1 })
  })

  it('CAS perdido justo al escribir SKIPPED ⇒ UNKNOWN, el resultado se descarta (no se inventa un SKIPPED)', async () => {
    findUniqueMock.mockResolvedValue(
      baseDelivery({ customer: { id: 'cust-1', email: 'ana@ejemplo.mx', marketingConsent: false, active: true } }),
    )
    updateManyMock.mockResolvedValueOnce({ count: 0 })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('UNKNOWN')
  })
})

describe('R3 — el envío de verdad: remitente, pie, cabeceras y tags', () => {
  it('sendEmailWithResult recibe from/idempotencyKey/tags/headers con la FORMA correcta', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(signTokenMock).toHaveBeenCalledWith({ customerId: 'cust-1', venueId: 'venue-1' })
    expect(sendEmailWithResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ana@ejemplo.mx',
        subject: 'Promo de septiembre',
        from: expect.stringContaining('promos@promos.avoqado.io'),
        idempotencyKey: 'dlv-1',
        tags: [{ name: 'deliveryId', value: 'dlv-1' }],
        headers: expect.objectContaining({
          'List-Unsubscribe': expect.stringContaining('TOKEN123'),
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }),
      }),
    )
  })

  it('el pie se AÑADE al html/text de la campaña con nombre, contacto y liga de baja — nunca sanitiza el cuerpo', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    await enviarDelivery('dlv-1', { ahora: AHORA })

    const [{ html, text }] = sendEmailWithResultMock.mock.calls[0]
    expect(html).toContain('<p>PROMO</p>') // cuerpo original de la campaña, intacto
    expect(html).toContain('Testarudo Café')
    expect(html).toContain('hola@testarudo.mx')
    expect(html).toContain('TOKEN123')
    expect(text).toContain('PROMO')
    expect(text).toContain('Testarudo Café')
    expect(text).toContain('TOKEN123')
  })

  it('BASE_URL vacío (dev local) cae a la URL de producción — la liga de baja nunca queda rota', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    await enviarDelivery('dlv-1', { ahora: AHORA })

    const [{ headers }] = sendEmailWithResultMock.mock.calls[0]
    expect(headers['List-Unsubscribe']).toContain('https://api.avoqado.io/api/v1/public/customers/unsubscribe?token=TOKEN123')
  })
})

describe('R4 — desenlaces del envío', () => {
  it('ok:true ⇒ SENT, guarda resendId', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_abc', transient: false })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SENT')
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', resendId: 're_abc' }) }),
    )
  })

  it('R6c — TODA escritura de resultado lleva el CAS exacto: where = {id, attempts, leaseUntil}, nunca sólo {id}', async () => {
    const delivery = baseDelivery()
    findUniqueMock.mockResolvedValue(delivery)
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_abc', transient: false })

    await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: delivery.id, attempts: delivery.attempts, leaseUntil: delivery.leaseUntil },
      }),
    )
  })

  it('ok:false transient:true, attempts=1 (primer intento) ⇒ RETRYING con backoff de 1 minuto', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ attempts: 1 }))
    sendEmailWithResultMock.mockResolvedValue({ ok: false, transient: true, errorCode: 'EMAIL_SERVICE_UNAVAILABLE' })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('RETRYING')
    const data = updateManyMock.mock.calls[0][0].data
    expect(data.status).toBe('RETRYING')
    expect(data.nextAttemptAt.getTime()).toBe(AHORA.getTime() + 60_000)
  })

  it('attempts=5 ⇒ backoff de 6 horas (el ÚLTIMO que de verdad se usa antes del corte a DEAD)', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ attempts: 5 }))
    sendEmailWithResultMock.mockResolvedValue({ ok: false, transient: true })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('RETRYING')
    const data = updateManyMock.mock.calls[0][0].data
    expect(data.nextAttemptAt.getTime()).toBe(AHORA.getTime() + 6 * 60 * 60_000)
  })

  it('🔴 attempts=6 ⇒ DEAD directo, se agotaron los intentos (el backoff de 24h NUNCA se consulta)', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery({ attempts: 6 }))
    sendEmailWithResultMock.mockResolvedValue({ ok: false, transient: true, errorCode: 'ETIMEDOUT' })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('DEAD')
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DEAD' }) }))
  })

  it('ok:false transient:false ⇒ DEAD directo (destinatario inválido o 4xx de validación)', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: false, transient: false, errorCode: 'UNDELIVERABLE_RECIPIENT' })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('DEAD')
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DEAD', lastError: expect.stringContaining('UNDELIVERABLE_RECIPIENT') }),
      }),
    )
  })

  it('R6b — el correo YA salió (hay resendId) pero la persistencia de SENT REVIENTA ⇒ UNKNOWN, JAMÁS RETRYING', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_9', transient: false })
    updateManyMock.mockRejectedValueOnce(new Error('conexión a Postgres perdida'))

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('UNKNOWN')
  })

  it('el correo YA salió pero el CAS de SENT no aplicó (otro worker tomó la fila) ⇒ UNKNOWN, se descarta', async () => {
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_9', transient: false })
    updateManyMock.mockResolvedValueOnce({ count: 0 })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('UNKNOWN')
  })
})

describe('R5 — nada de ActivityLog por correo enviado', () => {
  it('un envío exitoso no escribe en la bitácora (no hay logAction en este archivo)', async () => {
    // No hay import de `logAction` en campaignSender.service.ts — si alguien lo agregara,
    // este archivo tendría que mockearlo o el test tronaría al importar el módulo real.
    // Esta prueba documenta la regla; la garantía real es la ausencia del import (ver el
    // reporte de la task).
    findUniqueMock.mockResolvedValue(baseDelivery())
    sendEmailWithResultMock.mockResolvedValue({ ok: true, resendId: 're_1', transient: false })

    const resultado = await enviarDelivery('dlv-1', { ahora: AHORA })

    expect(resultado).toBe('SENT')
  })
})
