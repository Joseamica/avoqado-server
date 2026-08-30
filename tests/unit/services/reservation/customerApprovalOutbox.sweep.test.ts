import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendCustomerApprovalEmail: jest.fn(async () => true) },
}))

import emailService from '@/services/email.service'
import { expandPendingEvents, deliverClaimed, MAX_DELIVERY_ATTEMPTS } from '@/services/reservation/customerApprovalOutbox.service'

const SEND = (emailService as any).sendCustomerApprovalEmail as jest.Mock

/**
 * Fase 1 slice 5 — el worker del outbox: abanico de destinatarios y entrega.
 *
 * Lo que se prueba aquí es lo que rompe en producción y no en el núcleo puro: que un evento
 * se abra en una fila por destinatario (y no vuelva a abrirse), que no se entregue un aviso
 * viejo después de uno nuevo, y que el fallo del proveedor NO se confunda con éxito — porque
 * `sendEmail` devuelve `false` en vez de lanzar, que es la trampa de esta API.
 */
const NOW = new Date('2026-09-01T10:00:00.000Z')

function outboxRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ob-1',
    venueId: 'venue-1',
    customerId: 'cust-1',
    event: 'REQUESTED_STAFF',
    approvalVersion: 0,
    createdAt: NOW,
    venue: { id: 'venue-1', name: 'Mindform', slug: 'mindform' },
    customer: { id: 'cust-1', email: 'ana@test.com', phone: null, firstName: 'Ana', lastName: 'López' },
    ...over,
  }
}

describe('expandPendingEvents — de un evento a una fila por destinatario', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.customerApprovalOutbox.findMany.mockResolvedValue([outboxRow()] as any)
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ customerApprovalNotificationRoles: ['OWNER', 'ADMIN'] } as any)
    prismaMock.staffVenue.findMany.mockResolvedValue([
      { role: 'OWNER', staff: { id: 's1', email: 'duena@estudio.mx' } },
      { role: 'ADMIN', staff: { id: 's2', email: 'admin@estudio.mx' } },
    ] as any)
    prismaMock.customerApprovalDelivery.createMany.mockResolvedValue({ count: 2 } as any)
  })

  it('🔴 el staff se filtra por vínculo activo Y cuenta activa: un empleado dado de baja no recibe avisos del negocio', async () => {
    await expandPendingEvents({ limit: 10, now: NOW })

    const where = prismaMock.staffVenue.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ venueId: 'venue-1', active: true, staff: { active: true } })
  })

  it('🔴 crea una fila por destinatario con skipDuplicates: reexpandir el mismo evento no duplica correos', async () => {
    const r = await expandPendingEvents({ limit: 10, now: NOW })

    const call = prismaMock.customerApprovalDelivery.createMany.mock.calls[0][0]
    expect(call.skipDuplicates).toBe(true)
    expect(call.data).toHaveLength(2)
    expect(call.data.map((d: any) => d.recipient).sort()).toEqual(['admin@estudio.mx', 'duena@estudio.mx'])
    // providerKey único por (evento, canal, destinatario) — es la idempotencia del proveedor.
    expect(new Set(call.data.map((d: any) => d.providerKey)).size).toBe(2)
    expect(r.expanded).toBe(2)
  })

  it('🔴 un evento SIN destinatarios no deja el evento colgado reintentándose para siempre', async () => {
    prismaMock.staffVenue.findMany.mockResolvedValue([] as any)

    const r = await expandPendingEvents({ limit: 10, now: NOW })

    expect(prismaMock.customerApprovalDelivery.createMany).not.toHaveBeenCalled()
    // Se marca como expandido-sin-destinatarios para no volver a mirarlo en cada tick.
    expect(prismaMock.customerApprovalDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUPERSEDED', recipient: '' }) }),
    )
    expect(r.expanded).toBe(0)
  })
})

describe('deliverClaimed — entrega, supresión y fallo', () => {
  function claimed(over: Record<string, unknown> = {}) {
    return {
      id: 'dl-1',
      outboxId: 'ob-1',
      recipient: 'ana@test.com',
      channel: 'EMAIL',
      providerKey: 'ob-1:EMAIL:ana@test.com',
      attempts: 1,
      leaseUntil: new Date(NOW.getTime() + 30_000),
      status: 'PENDING',
      outbox: outboxRow({ event: 'PENDING_CUSTOMER' }),
      ...over,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    SEND.mockResolvedValue(true)
    prismaMock.customerApprovalDelivery.count.mockResolvedValue(0 as any)
    prismaMock.customerApprovalDelivery.updateMany.mockResolvedValue({ count: 1 } as any)
  })

  it('🔴 entrega feliz: manda el correo con la clave de idempotencia y marca SENT con sentAt', async () => {
    const r = await deliverClaimed([claimed()] as any, { now: NOW })

    expect(SEND).toHaveBeenCalledWith(
      'PENDING_CUSTOMER',
      'ana@test.com',
      expect.objectContaining({ venueName: 'Mindform', idempotencyKey: 'ob-1:EMAIL:ana@test.com' }),
    )
    const data = prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'SENT', sentAt: NOW })
    expect(r.sent).toBe(1)
  })

  it('entrega al cliente la razón persistida en el payload del rechazo', async () => {
    await deliverClaimed([claimed({ outbox: outboxRow({ event: 'REJECTED_CUSTOMER', payload: { reason: 'No es socia' } }) })] as any, {
      now: NOW,
    })

    expect(SEND).toHaveBeenCalledWith('REJECTED_CUSTOMER', 'ana@test.com', expect.objectContaining({ reason: 'No es socia' }))
  })

  it('🔴 el ack es un CAS sobre el lease: si otro worker se quedó la fila, no se pisa su resultado', async () => {
    await deliverClaimed([claimed()] as any, { now: NOW })

    const where = prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].where
    expect(where).toMatchObject({ id: 'dl-1', attempts: 1, leaseUntil: expect.any(Date) })
  })

  it('🔴 versión más nueva YA enviada → NO se manda: nunca llega "en revisión" después de "aprobado"', async () => {
    prismaMock.customerApprovalDelivery.count.mockResolvedValue(1 as any)

    const r = await deliverClaimed([claimed()] as any, { now: NOW })

    expect(SEND).not.toHaveBeenCalled()
    expect(prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SUPERSEDED' })
    expect(r.superseded).toBe(1)
  })

  it('🔴 `sendEmail` devuelve FALSE en vez de lanzar: eso es un fallo, no un éxito', async () => {
    SEND.mockResolvedValue(false)

    const r = await deliverClaimed([claimed()] as any, { now: NOW })

    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)
    expect(prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'FAILED' })
  })

  it('🔴 el proveedor lanza: se reagenda con backoff, no se pierde', async () => {
    SEND.mockRejectedValue(new Error('resend down'))

    const r = await deliverClaimed([claimed()] as any, { now: NOW })

    const data = prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data
    expect(data.status).toBe('FAILED')
    expect(data.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000))
    expect(data.lastError).toContain('resend down')
    expect(r.failed).toBe(1)
  })

  it('🔴 correo PERMANENTEMENTE inentregable → terminal al PRIMER intento, sin reintentos', async () => {
    // Lo cazó /full-testing leyendo el log del backend: `sendEmail` ya sabe distinguir un
    // destinatario imposible (dominio de ejemplo, cuenta semilla, correo mal formado) y lo
    // SALTA. Mi worker lo trataba como "el proveedor rechazó" y lo reintentaba 6 veces con
    // backoff: trabajo inútil, y el DEAD_LETTER se llenaba de ruido que tapa las fallas reales.
    const r = await deliverClaimed([claimed({ recipient: 'nadie@example.com' })] as any, { now: NOW })

    expect(SEND).not.toHaveBeenCalled() // ni se intenta: se sabe de antemano
    const data = prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data
    expect(data.status).toBe('DEAD_LETTER')
    expect(data.nextAttemptAt).toBeUndefined() // no se reagenda
    expect(data.lastError).toContain('UNDELIVERABLE')
    expect(r.failed).toBe(1)
  })

  it('🔴 agotados los intentos → DEAD_LETTER visible, no un reintento eterno', async () => {
    SEND.mockResolvedValue(false)

    await deliverClaimed([claimed({ attempts: MAX_DELIVERY_ATTEMPTS })] as any, { now: NOW })

    expect(prismaMock.customerApprovalDelivery.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'DEAD_LETTER' })
  })

  it('🔴 una entrega que truena NO detiene a las demás del mismo lote', async () => {
    SEND.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true)

    const r = await deliverClaimed([claimed(), claimed({ id: 'dl-2', providerKey: 'ob-1:EMAIL:otra@test.com' })] as any, { now: NOW })

    expect(r.failed).toBe(1)
    expect(r.sent).toBe(1)
  })
})
