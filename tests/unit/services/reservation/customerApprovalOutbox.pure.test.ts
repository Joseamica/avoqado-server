import {
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptDelayMs,
  resolveDeliveryOutcome,
  recipientsForEvent,
  dedupeKey,
} from '@/services/reservation/customerApprovalOutbox.service'

/**
 * Fase 1 slice 5 — el núcleo PURO del outbox de aprobación.
 *
 * La entrega real (Resend, lease, SKIP LOCKED) necesita base de datos y red; toda la
 * corrección que sí se puede probar sola vive aquí: cuándo se reintenta, cuándo se rinde,
 * y a quién le toca cada correo.
 *
 * Por qué existe este outbox y no un `await sendEmail()` a secas: un evento con TRES
 * destinatarios que entrega a dos y falla en el tercero, al reintentar le vuelve a escribir
 * a los dos primeros. La unidad de entrega es (evento × destinatario × canal), no el evento.
 */
describe('backoff de reintentos', () => {
  it('🔴 crece exponencialmente: el primer reintento es en un minuto', () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000)
    expect(nextAttemptDelayMs(2)).toBe(120_000)
    expect(nextAttemptDelayMs(3)).toBe(240_000)
  })

  it('🔴 tiene techo de una hora: un proveedor caído medio día no empuja el reintento a la semana próxima', () => {
    expect(nextAttemptDelayMs(20)).toBe(3_600_000)
    expect(nextAttemptDelayMs(MAX_DELIVERY_ATTEMPTS)).toBeLessThanOrEqual(3_600_000)
  })

  it('nunca devuelve 0 ni negativo (un reintento inmediato en bucle tumbaría al proveedor)', () => {
    for (let i = 0; i <= 10; i++) expect(nextAttemptDelayMs(i)).toBeGreaterThan(0)
  })
})

describe('resolveDeliveryOutcome — qué hacer tras un fallo', () => {
  it('🔴 con intentos de sobra: FAILED y se reagenda', () => {
    const r = resolveDeliveryOutcome({ attempts: 1, now: new Date('2026-09-01T10:00:00Z'), error: 'timeout' })

    expect(r.status).toBe('FAILED')
    expect(r.nextAttemptAt).toEqual(new Date('2026-09-01T10:01:00Z'))
    expect(r.lastError).toBe('timeout')
  })

  it('🔴 agotados los intentos: DEAD_LETTER y NO se reagenda — reintentar para siempre esconde el problema', () => {
    const r = resolveDeliveryOutcome({ attempts: MAX_DELIVERY_ATTEMPTS, now: new Date('2026-09-01T10:00:00Z'), error: 'bounce' })

    expect(r.status).toBe('DEAD_LETTER')
    expect(r.nextAttemptAt).toBeNull()
    expect(r.lastError).toBe('bounce')
  })

  it('🔴 el error se recorta: un stack de 40 KB en cada fila infla la tabla sin decir nada más', () => {
    const r = resolveDeliveryOutcome({ attempts: 1, now: new Date(), error: 'x'.repeat(5_000) })

    expect(r.lastError!.length).toBeLessThanOrEqual(1_000)
  })
})

describe('recipientsForEvent — a quién le toca cada correo', () => {
  const staff = [
    { id: 's1', email: 'duena@estudio.mx', role: 'OWNER' },
    { id: 's2', email: 'admin@estudio.mx', role: 'ADMIN' },
    { id: 's3', email: 'gerente@estudio.mx', role: 'MANAGER' },
  ]
  const customer = { id: 'c1', email: 'ana@test.com', phone: '+525511110000' }

  it('🔴 REQUESTED_STAFF va al staff con los roles configurados, y a nadie más', () => {
    const r = recipientsForEvent('REQUESTED_STAFF', { staff, customer, notifyRoles: ['OWNER', 'ADMIN'] })

    expect(r.map(x => x.recipient).sort()).toEqual(['admin@estudio.mx', 'duena@estudio.mx'])
    expect(r.every(x => x.channel === 'EMAIL')).toBe(true)
  })

  it('🔴 los tres eventos de cliente van al CLIENTE, nunca al staff', () => {
    for (const event of ['PENDING_CUSTOMER', 'APPROVED_CUSTOMER', 'REJECTED_CUSTOMER'] as const) {
      const r = recipientsForEvent(event, { staff, customer, notifyRoles: ['OWNER'] })
      expect(r).toEqual([{ recipient: 'ana@test.com', channel: 'EMAIL' }])
    }
  })

  it('🔴 sin correo del cliente NO se inventa un destinatario: se devuelve vacío', () => {
    const r = recipientsForEvent('APPROVED_CUSTOMER', { staff, customer: { ...customer, email: null }, notifyRoles: ['OWNER'] })

    expect(r).toEqual([])
  })

  it('🔴 ningún staff con ese rol: vacío, no falla — el negocio se queda sin aviso pero la cuenta ya está registrada', () => {
    const r = recipientsForEvent('REQUESTED_STAFF', { staff, customer, notifyRoles: ['CASHIER'] })

    expect(r).toEqual([])
  })

  it('deduplica: la misma persona con dos roles configurados recibe UN correo', () => {
    const dupes = [
      { id: 's1', email: 'duena@estudio.mx', role: 'OWNER' },
      { id: 's1', email: 'duena@estudio.mx', role: 'ADMIN' },
    ]
    const r = recipientsForEvent('REQUESTED_STAFF', { staff: dupes, customer, notifyRoles: ['OWNER', 'ADMIN'] })

    expect(r).toHaveLength(1)
  })
})

describe('dedupeKey', () => {
  it('🔴 repetir la MISMA decisión no encola de nuevo; una decisión nueva sí (cambia la versión)', () => {
    expect(dedupeKey('APPROVED_CUSTOMER', 'c1', 3)).toBe(dedupeKey('APPROVED_CUSTOMER', 'c1', 3))
    expect(dedupeKey('APPROVED_CUSTOMER', 'c1', 4)).not.toBe(dedupeKey('APPROVED_CUSTOMER', 'c1', 3))
    expect(dedupeKey('REJECTED_CUSTOMER', 'c1', 3)).not.toBe(dedupeKey('APPROVED_CUSTOMER', 'c1', 3))
  })
})
