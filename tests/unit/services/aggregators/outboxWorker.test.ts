import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { claimPassOutbox, publicationHash, runPassOutboxRow } from '@/services/aggregators/core/outbox.service'
import * as registry from '@/services/aggregators/core/adapterRegistry'
import * as sync from '@/services/aggregators/core/sessionSync.service'
import * as ingestion from '@/services/aggregators/core/bookingIngestion.service'
import * as basePlan from '@/services/access/basePlan.service'
import { fakeAdapter } from './fakeAdapter'
import { encryptCredential } from '@/services/aggregators/core/credentials'

const NOW = new Date('2030-01-01T12:00:00Z')
const CREDENTIAL = 'place-key-SECRET-xyz'
const conn = {
  id: 'c1',
  venueId: 'v1',
  provider: 'TOTALPASS',
  externalPlaceId: 'place-1',
  credentialCiphertext: encryptCredential(CREDENTIAL),
  config: {},
  status: 'ACTIVE',
}
const row = (op: string, extra = {}) => ({
  id: 'o1',
  operation: op,
  attempts: 0,
  status: 'IN_PROGRESS',
  claimToken: 'tk',
  connection: conn,
  venueId: 'v1',
  connectionId: 'c1',
  classSessionId: null,
  aggregatorBookingId: null,
  aggregatorVisitId: null,
  ...extra,
})
const lastFinish = () => prismaMock.aggregatorOutbox.updateMany.mock.calls.at(-1)[0]

describe('runPassOutboxRow', () => {
  // Por default el negocio tiene el plan de pases (la pausa suave se prueba aparte, al final).
  beforeEach(() => jest.spyOn(basePlan, 'venueHasFeatureAccess').mockResolvedValue(true))
  // nuevo
  it('VALIDATE_VISIT ok ⇒ visita CONFIRMED y fila DONE', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      reservationId: 'r1',
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.validateVisit).toHaveBeenCalledWith(expect.objectContaining({ credential: CREDENTIAL }), 'https://admin.totalpass.com/x')
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'vis1', status: 'PENDING' },
      data: { status: 'CONFIRMED', confirmedBy: 'AUTO' },
    })
    expect(lastFinish()).toMatchObject({ where: { id: 'o1', claimToken: 'tk' }, data: { status: 'DONE' } })
  })
  // nuevo — Review Focus 4
  it('VALIDATE_VISIT ya validada en el portal ⇒ ALREADY_CONFIRMED, sin reintento', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        validateVisit: jest
          .fn()
          .mockResolvedValue({ ok: false, retryable: false, code: 'ALREADY', message: 'check_in_not_available', alreadyValidated: true }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data.status).toBe('ALREADY_CONFIRMED')
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo
  it('VALIDATE_VISIT vencida ⇒ visita EXPIRED, no se llama al proveedor', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'x',
      deadlineAt: new Date(NOW.getTime() - 1),
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.validateVisit).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data.status).toBe('EXPIRED')
  })
  // nuevo
  it('error reintentable ⇒ FAILED con backoff de 30 s', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ respondBooking: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }) }),
      )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'ACCEPTED',
      denyReason: null,
      createdAt: NOW,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    const last = lastFinish().data
    expect(last).toMatchObject({ status: 'FAILED', attempts: 1, lastError: expect.stringContaining('caído') })
    expect(last.scheduledAt.toISOString()).toBe('2030-01-01T12:00:30.000Z')
  })
  // nuevo
  it('SYNC_SESSION publica la primera vez y guarda la ocurrencia', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: NOW } as any, spots: 3, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(null)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession).toHaveBeenCalled()
    expect(prismaMock.aggregatorSessionLink.upsert.mock.calls[0][0].create).toMatchObject({
      classSessionId: 's1',
      externalOccurrenceId: 'occ-1',
      publishedSpots: 3,
      publishedHash: publicationHash({ classSessionId: 's1', startsAt: NOW } as any),
    })
  })
  // nuevo
  it('SYNC_SESSION de una clase cancelada ⇒ la da de baja', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: null, spots: 0, providerActive: 0, reason: 'CANCELLED' })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({ id: 'l1', externalOccurrenceId: 'occ-1', live: true } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.unpublishSession).toHaveBeenCalledWith(expect.anything(), 'occ-1')
    expect(prismaMock.aggregatorSessionLink.update.mock.calls[0][0].data).toMatchObject({ live: false })
  })

  // ── Reglas del controlador (rulings) ──

  // nuevo
  it('conexión no ACTIVE ⇒ SKIPPED sin llamar al proveedor', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(
      row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1', connection: { ...conn, status: 'PAUSED' } }) as any,
    )
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.validateVisit).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.findUnique).not.toHaveBeenCalled()
    expect(lastFinish().data).toMatchObject({ status: 'SKIPPED', claimToken: null, leaseUntil: null })
  })
  // nuevo
  it('la fila ya no es nuestra (otro lease) ⇒ no hace nada', async () => {
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(null)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorOutbox.updateMany).not.toHaveBeenCalled()
  })
  // nuevo
  it('VALIDATE_VISIT de una visita que ya no está PENDING ⇒ SKIPPED', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'CONFIRMED',
      validationRef: 'x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.validateVisit).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.updateMany).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('SKIPPED')
  })
  // nuevo
  it('VALIDATE_VISIT en modo ON_VENUE_CHECKIN ⇒ confirmedBy VENUE', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(fakeAdapter())
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'ON_VENUE_CHECKIN' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'CONFIRMED',
      confirmedBy: 'VENUE',
      confirmedAt: NOW,
    })
  })
  // ronda 1 — H1: en una conexión AUTO, lo que confirmó una persona desde el dashboard se queda como VENUE
  it('VALIDATE_VISIT en modo AUTO de una visita que confirmó el estudio ⇒ conserva confirmedBy VENUE', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(fakeAdapter())
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      confirmedBy: 'VENUE',
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CONFIRMED', confirmedBy: 'VENUE' })
  })
  // ronda 1 — H1: sin confirmación humana, la validación automática sigue siendo AUTO
  it('VALIDATE_VISIT en modo AUTO sin confirmación humana (confirmedBy null) ⇒ AUTO', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(fakeAdapter())
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      confirmedBy: null,
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CONFIRMED', confirmedBy: 'AUTO' })
  })
  // nuevo
  it('VALIDATE_VISIT que el proveedor da por vencida ⇒ EXPIRED y DONE', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: false, code: 'EXPIRED', message: 'expiró', expired: true }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'EXPIRED',
      confirmedAt: null,
      confirmedBy: null,
    })
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo
  it('VALIDATE_VISIT con error reintentable deja la visita PENDING y la fila FAILED', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_502', message: 'x' }) }),
      )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1', attempts: 2 }) as any)
    const deadlineAt = new Date(NOW.getTime() + 90 * 60e3)
    prismaMock.aggregatorVisit.findUnique
      .mockResolvedValueOnce({
        id: 'vis1',
        status: 'PENDING',
        validationRef: 'https://admin.totalpass.com/x',
        deadlineAt,
        connection: { confirmMode: 'AUTO' },
      } as any)
      .mockResolvedValueOnce({ deadlineAt } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    // La visita sigue PENDING: sólo se le anota el motivo (P2-15), nunca un cambio de estado.
    for (const [arg] of prismaMock.aggregatorVisit.updateMany.mock.calls) expect(arg.data).not.toHaveProperty('status')
    const last = lastFinish().data
    expect(last).toMatchObject({ status: 'FAILED', attempts: 3 })
    expect(last.scheduledAt.toISOString()).toBe('2030-01-01T12:10:00.000Z')
  })
  // nuevo — P2-15: la pantalla lee la visita, no la bandeja
  it('VALIDATE_VISIT que falla con reintento deja el motivo en la visita', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'TotalPass HTTP 503' }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    const deadlineAt = new Date(NOW.getTime() + 60 * 60e3)
    prismaMock.aggregatorVisit.findUnique
      .mockResolvedValueOnce({
        id: 'vis1',
        status: 'PENDING',
        validationRef: 'https://admin.totalpass.com/x',
        deadlineAt,
        reservationId: 'r1',
        connection: { confirmMode: 'AUTO' },
      } as any)
      .mockResolvedValueOnce({ deadlineAt } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls.at(-1)[0]).toEqual({
      where: { id: 'vis1', status: 'PENDING' },
      data: { lastError: 'Reintentando con el proveedor: HTTP_503: TotalPass HTTP 503' },
    })
    expect(lastFinish().data.status).toBe('FAILED')
  })
  // R2b-39 (Issue 6) — una falla de red se le dice al estudio en palabras normales (sin «NETWORK … (TypeError)»); la fila
  // de la bandeja conserva el motivo técnico
  describe('VALIDATE_VISIT que falla por red', () => {
    const failVisit = (code: string, message: string, attempts = 0) => {
      jest
        .spyOn(registry, 'adapterFor')
        .mockReturnValue(fakeAdapter({ validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: true, code, message }) }))
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1', attempts }) as any)
      const deadlineAt = new Date(NOW.getTime() + 60 * 60e3)
      prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
        id: 'vis1',
        status: 'PENDING',
        validationRef: 'https://admin.totalpass.com/x',
        deadlineAt,
        reservationId: null,
        connection: { confirmMode: 'AUTO' },
      } as any)
      // El plazo sólo se relee para programar el siguiente intento (no en el último).
      if (attempts < 5) prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({ deadlineAt } as any)
    }
    const visitNote = () => prismaMock.aggregatorVisit.updateMany.mock.calls.at(-1)[0].data.lastError
    it.each([
      ['NETWORK', 'error de red con TotalPass (TypeError)'],
      ['TIMEOUT', 'TotalPass no respondió en 20 s'],
    ])('%s con reintento ⇒ «No pudimos comunicarnos con TotalPass; lo reintentamos.»', async (code, message) => {
      failVisit(code, message)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(visitNote()).toBe('No pudimos comunicarnos con TotalPass; lo reintentamos.')
      expect(lastFinish().data).toMatchObject({ status: 'FAILED', lastError: `${code}: ${message}` })
    })
    it('NETWORK en el último intento ⇒ ya no promete reintento', async () => {
      failVisit('NETWORK', 'error de red con TotalPass (TypeError)', 5)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(visitNote()).toBe('No pudimos comunicarnos con TotalPass.')
      expect(lastFinish().data.status).toBe('DEAD_LETTER')
    })
  })
  // nuevo — P2-15
  it('VALIDATE_VISIT que falla sin reintento deja «No se pudo confirmar…» en la visita (sin URLs)', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        validateVisit: jest
          .fn()
          .mockResolvedValue({ ok: false, retryable: false, code: 'HTTP_400', message: 'x en https://admin.totalpass.com/checkin/tok-9' }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/checkin/tok-9',
      deadlineAt: new Date(NOW.getTime() + 60 * 60e3),
      reservationId: 'r1',
      connection: { confirmMode: 'AUTO' },
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    const note = prismaMock.aggregatorVisit.updateMany.mock.calls.at(-1)[0]
    expect(note.where).toEqual({ id: 'vis1', status: 'PENDING' })
    expect(note.data.lastError).toMatch(/^No se pudo confirmar con el proveedor: HTTP_400: /)
    expect(note.data.lastError).not.toContain('tok-9')
    expect(lastFinish().data.status).toBe('DEAD_LETTER')
  })
  // nuevo — anotar el motivo es accesorio: si falla, la fila igual se cierra (no se queda IN_PROGRESS hasta el lease)
  it('si anotar el motivo en la visita falla, la fila igual queda FAILED', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }) }),
      )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60 * 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    prismaMock.aggregatorVisit.updateMany.mockRejectedValueOnce(new Error('base caída'))
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.updateMany).toHaveBeenCalledTimes(1)
    expect(lastFinish().data).toMatchObject({ status: 'FAILED', attempts: 1 })
  })
  // nuevo — Codex F2: con 503 seguidos la vuelta tras el 5º fallo caía a las ~7 h y la visita vence a los 90 min
  it('VALIDATE_VISIT: los reintentos nunca duermen más allá del plazo de la visita', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ validateVisit: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }) }),
      )
    const deadlineAt = new Date(NOW.getTime() + 90 * 60e3)
    const visit = {
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt,
      connection: { confirmMode: 'AUTO' },
    }
    // La visita completa (o sólo su plazo) en cada lectura, sin depender de cuántas lecturas haga el worker.
    prismaMock.aggregatorVisit.findUnique.mockImplementation(async () => visit)
    const fail = async (attempts: number, at: Date) => {
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1', attempts }) as any)
      await runPassOutboxRow('o1', 'tk', at)
      return lastFinish().data
    }
    try {
      // 5 fallos seguidos, cada intento a la hora que dejó el anterior: todos los siguientes quedan antes del plazo.
      let at = NOW
      for (let attempts = 0; attempts < 5; attempts++) {
        const last = await fail(attempts, at)
        expect(last.status).toBe('FAILED')
        expect(last.scheduledAt.getTime()).toBeLessThanOrEqual(deadlineAt.getTime() - 60e3)
        at = last.scheduledAt
      }
      expect(at.toISOString()).toBe('2030-01-01T13:29:00.000Z') // un minuto antes de vencer, no a las 19:12
      // Piso: a 45 s del plazo se reintenta en 30 s (no «ya», que repetiría el golpe al proveedor).
      const late = await fail(1, new Date(deadlineAt.getTime() - 45e3))
      expect(late.scheduledAt.toISOString()).toBe('2030-01-01T13:29:45.000Z')
    } finally {
      prismaMock.aggregatorVisit.findUnique.mockReset()
    }
  })
  // nuevo
  it('sexto intento fallido ⇒ DEAD_LETTER', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ respondBooking: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }) }),
      )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1', attempts: 5 }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'ACCEPTED',
      denyReason: null,
      createdAt: NOW,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(lastFinish().data).toMatchObject({ status: 'DEAD_LETTER', attempts: 6 })
  })
  // nuevo
  it('error no reintentable ⇒ DEAD_LETTER al primer intento', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(
        fakeAdapter({ updateSpots: jest.fn().mockResolvedValue({ ok: false, retryable: false, code: 'HTTP_422', message: 'no' }) }),
      )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: NOW } as any, spots: 5, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
      id: 'l1',
      externalOccurrenceId: 'occ-1',
      live: true,
      publishedStartsAt: NOW,
      publishedSpots: 2,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(lastFinish().data).toMatchObject({ status: 'DEAD_LETTER', attempts: 1 })
  })
  // R69 / Codex authz P1-4 — una llamada salió con la llave vieja; mientras tanto el refresco guardó la nueva. Su 401 tardío
  // no apaga la conexión: la fila se reintenta (ya con la llave nueva).
  it('401 de una llave que ya se reemplazó ⇒ la conexión sigue ACTIVE y la fila queda para reintentar', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        respondBooking: jest
          .fn()
          .mockResolvedValue({ ok: false, retryable: false, code: 'UNAUTHORIZED', message: 'TotalPass rechazó las llaves (401)' }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'eb1',
      decision: 'ACCEPTED',
      createdAt: NOW,
    } as any)
    prismaMock.aggregatorConnection.updateMany.mockResolvedValueOnce({ count: 0 }) // la credencial ya no es la de la llamada
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(lastFinish().data).toMatchObject({ status: 'FAILED', attempts: 1, scheduledAt: NOW })
    expect(lastFinish().data.lastError).toMatch(/^UNAUTHORIZED: /)
    expect((logger.error as jest.Mock).mock.calls.map(c => String(c[0])).join('\n')).not.toMatch(/REVOKED/)
  })
  // nuevo
  it('401 ⇒ conexión REVOKED (sólo si seguía ACTIVE) y la fila SKIPPED; sin la URL de validación en errores ni logs', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(
      fakeAdapter({
        validateVisit: jest.fn().mockResolvedValue({
          ok: false,
          retryable: false,
          code: 'UNAUTHORIZED',
          message: 'llaves rechazadas en https://admin.totalpass.com/checkin/secret-token-123',
        }),
      }),
    )
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/checkin/secret-token-123',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    prismaMock.aggregatorConnection.updateMany.mockResolvedValueOnce({ count: 1 })
    await runPassOutboxRow('o1', 'tk', NOW)
    const revoke = prismaMock.aggregatorConnection.updateMany.mock.calls[0][0]
    // R69: sólo si la credencial sigue siendo la que se usó en esta llamada
    expect(revoke).toMatchObject({
      where: { id: 'c1', status: 'ACTIVE', credentialCiphertext: conn.credentialCiphertext },
      data: { status: 'REVOKED' },
    })
    expect(revoke.data.lastError).not.toContain('secret-token-123')
    expect(lastFinish().data).toMatchObject({ status: 'SKIPPED' })
    expect(lastFinish().data.lastError).not.toContain('secret-token-123')
    const logged = JSON.stringify([...(logger.error as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls])
    expect(logged).not.toContain('secret-token-123')
    expect(logged).not.toContain(CREDENTIAL)
  })
  // nuevo
  it('una excepción del adaptador cuenta como error reintentable', async () => {
    jest
      .spyOn(registry, 'adapterFor')
      .mockReturnValue(fakeAdapter({ respondBooking: jest.fn().mockRejectedValue(new Error('socket hang up')) }))
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'ACCEPTED',
      denyReason: null,
      createdAt: NOW,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(lastFinish().data).toMatchObject({ status: 'FAILED', attempts: 1, lastError: expect.stringContaining('socket hang up') })
  })
  // nuevo
  it('RESPOND_BOOKING rechazada manda el motivo; fuera de los 5 min se manda igual con aviso', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'DENIED',
      denyReason: 'CLASS_FULL',
      createdAt: new Date(NOW.getTime() - 6 * 60e3),
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.respondBooking).toHaveBeenCalledWith(expect.anything(), 'slot-1', { accept: false, reason: 'CLASS_FULL' })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fuera de los 5 min'))
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo
  it('RESPOND_BOOKING con un motivo desconocido lo manda como OTHER', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'DENIED',
      denyReason: 'LO_QUE_SEA',
      createdAt: NOW,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.respondBooking).toHaveBeenCalledWith(expect.anything(), 'slot-1', { accept: false, reason: 'OTHER' })
  })
  // nuevo
  it('RESPOND_BOOKING de una reserva que el socio ya canceló ⇒ SKIPPED sin llamar', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('RESPOND_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({
      id: 'b1',
      externalBookingId: 'slot-1',
      decision: 'CANCELLED',
      denyReason: null,
      createdAt: NOW,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.respondBooking).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('SKIPPED')
  })
  // nuevo — revisión final I3: el estudio canceló la reserva de un socio desde Avoqado
  it('CANCEL_BOOKING de una reserva cancelada por el estudio ⇒ da de baja el slot en el proveedor y queda DONE', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('CANCEL_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ id: 'b1', externalBookingId: 'slot-1', decision: 'CANCELLED' } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.cancelBooking).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'slot-1')
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo
  it('CANCEL_BOOKING de una reserva que no está cancelada ⇒ SKIPPED sin llamar', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('CANCEL_BOOKING', { aggregatorBookingId: 'b1' }) as any)
    prismaMock.aggregatorBooking.findUnique.mockResolvedValueOnce({ id: 'b1', externalBookingId: 'slot-1', decision: 'ACCEPTED' } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.cancelBooking).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('SKIPPED')
  })
  // nuevo
  it('SYNC_SESSION de una clase PASADA no toca la ocurrencia viva', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: null, spots: 0, providerActive: 0, reason: 'PAST' })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({ id: 'l1', externalOccurrenceId: 'occ-1', live: true } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.unpublishSession).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorSessionLink.update).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('SKIPPED')
  })
  // nuevo
  it('SYNC_SESSION de una sesión que ya no existe y sin ocurrencia viva ⇒ SKIPPED', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 'gone' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: null, spots: 0, providerActive: 0, reason: 'CANCELLED' })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(null)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.unpublishSession).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('SKIPPED')
  })
  // nuevo
  it('SYNC_SESSION con otro cupo ⇒ actualiza sólo los lugares', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    const pub = { classSessionId: 's1', startsAt: NOW } as any
    jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: pub, spots: 4, providerActive: 1 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
      id: 'l1',
      externalOccurrenceId: 'occ-1',
      live: true,
      publishedStartsAt: NOW,
      publishedSpots: 2,
      publishedHash: publicationHash(pub),
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession).not.toHaveBeenCalled()
    expect(a.updateSessionDetails).not.toHaveBeenCalled()
    expect(a.updateSpots).toHaveBeenCalledWith(expect.anything(), 'occ-1', 4)
    expect(prismaMock.aggregatorSessionLink.update.mock.calls[0][0].data).toMatchObject({ publishedSpots: 4 })
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo
  it('SYNC_SESSION ya al día ⇒ DONE sin llamar al proveedor', async () => {
    const a = fakeAdapter()
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    const pub = { classSessionId: 's1', startsAt: NOW } as any
    jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: pub, spots: 2, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
      id: 'l1',
      externalOccurrenceId: 'occ-1',
      live: true,
      publishedStartsAt: NOW,
      publishedSpots: 2,
      publishedHash: publicationHash(pub),
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession).not.toHaveBeenCalled()
    expect(a.updateSpots).not.toHaveBeenCalled()
    expect(a.updateSessionDetails).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('DONE')
  })
  // nuevo — Codex F7: misma hora y mismo cupo, pero otro coach/título/duración ⇒ se edita la ocurrencia viva
  describe('cambió coach, título o duración (misma hora)', () => {
    const before = { classSessionId: 's1', startsAt: NOW, title: 'Yoga', coachName: 'Lu', durationMin: 60, bookingClosesAt: null }
    const after = { ...before, coachName: 'Ana', durationMin: 45 }
    const arrange = (adapter = fakeAdapter()) => {
      jest.spyOn(registry, 'adapterFor').mockReturnValue(adapter)
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
      jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: after as any, spots: 2, providerActive: 0 })
      prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
        id: 'l1',
        externalOccurrenceId: 'occ-1',
        live: true,
        publishedStartsAt: NOW,
        publishedSpots: 2,
        publishedHash: publicationHash(before as any),
      } as any)
      return adapter
    }
    it('huella distinta ⇒ actualiza los detalles en el proveedor y guarda la huella nueva', async () => {
      const a = arrange()
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.publishSession).not.toHaveBeenCalled()
      expect(a.updateSessionDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'occ-1', after)
      expect(prismaMock.aggregatorSessionLink.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'l1' },
        data: { publishedHash: publicationHash(after as any) },
      })
      expect(lastFinish().data.status).toBe('DONE')
    })
    it('si el proveedor falla, no se guarda la huella y la fila se reintenta', async () => {
      arrange(
        fakeAdapter({
          updateSessionDetails: jest.fn().mockResolvedValue({ ok: false, retryable: true, code: 'HTTP_503', message: 'caído' }),
        }),
      )
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(prismaMock.aggregatorSessionLink.update).not.toHaveBeenCalled()
      expect(lastFinish().data.status).toBe('FAILED')
    })
    it('la huella no cambia con la hora en que se calcula, sí con coach/título/duración/cierre de reservas', () => {
      expect(publicationHash(before as any)).toBe(publicationHash({ ...before, spots: 9 } as any))
      expect(publicationHash(before as any)).not.toBe(publicationHash(after as any))
      expect(publicationHash(before as any)).not.toBe(publicationHash({ ...before, title: 'Pilates' } as any))
      expect(publicationHash(before as any)).not.toBe(publicationHash({ ...before, bookingClosesAt: NOW } as any))
    })
  })
  // nuevo
  it('SYNC_SESSION de una clase que cambió de hora ⇒ publica con la ocurrencia anterior', async () => {
    const a = fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: 'occ-2' }) })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    const old = new Date(NOW.getTime() + 2 * 3600e3)
    const moved = new Date(NOW.getTime() + 3 * 3600e3)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: moved } as any, spots: 2, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
      id: 'l1',
      externalOccurrenceId: 'occ-1',
      live: true,
      publishedStartsAt: old,
      publishedSpots: 2,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      externalOccurrenceId: 'occ-1',
      publishedStartsAt: old,
    })
    expect(prismaMock.aggregatorSessionLink.upsert.mock.calls[0][0].update).toMatchObject({
      externalOccurrenceId: 'occ-2',
      publishedStartsAt: moved,
    })
  })
  // nuevo — decisión del founder (3-oct, opción A)
  describe('reemplazo de la ocurrencia (el proveedor no deja mover la clase)', () => {
    const old = new Date(NOW.getTime() + 2 * 3600e3)
    const moved = new Date(NOW.getTime() + 3 * 3600e3)
    const liveLink = { id: 'l1', externalOccurrenceId: 'occ-1', live: true, publishedStartsAt: old, publishedSpots: 2 }
    const arrange = (newOcc: string, link: unknown = liveLink) => {
      const a = fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: newOcc }) })
      jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
      jest
        .spyOn(sync, 'buildSessionPublication')
        .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: moved } as any, spots: 2, providerActive: 1 })
      prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(link as any)
      return a
    }
    afterEach(() => jest.restoreAllMocks())

    it('la ocurrencia viva se reemplazó por otra ⇒ se cancelan aquí las reservas de sus socios', async () => {
      const spy = jest.spyOn(ingestion, 'cancelPassBookingsOfReplacedOccurrence').mockResolvedValue(1)
      const a = arrange('occ-2')
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(spy).toHaveBeenCalledWith({ id: 'c1', venueId: 'v1', provider: 'TOTALPASS' }, 's1', expect.any(Date), NOW)
      // El corte se toma ANTES de llamar al proveedor: las reservas de la ocurrencia nueva no se tocan.
      const replacedAt = spy.mock.calls[0][2] as Date
      expect(replacedAt.getTime()).toBeLessThanOrEqual(Date.now())
      expect(spy.mock.invocationCallOrder[0]).toBeGreaterThan((a.publishSession as jest.Mock).mock.invocationCallOrder[0])
      expect(lastFinish().data.status).toBe('DONE')
    })

    it('primera publicación (sin ocurrencia anterior) ⇒ no cancela nada', async () => {
      const spy = jest.spyOn(ingestion, 'cancelPassBookingsOfReplacedOccurrence').mockResolvedValue(0)
      arrange('occ-2', null)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(spy).not.toHaveBeenCalled()
    })

    it('el proveedor movió la misma ocurrencia (como Wellhub) ⇒ los socios siguen en la clase', async () => {
      const spy = jest.spyOn(ingestion, 'cancelPassBookingsOfReplacedOccurrence').mockResolvedValue(0)
      arrange('occ-1')
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(spy).not.toHaveBeenCalled()
    })

    it('si cancelar aquí falla, la fila queda para una persona (reintentar publicaría otra ocurrencia)', async () => {
      jest.spyOn(ingestion, 'cancelPassBookingsOfReplacedOccurrence').mockRejectedValue(new Error('db caída'))
      arrange('occ-2')
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(lastFinish().data).toMatchObject({ status: 'DEAD_LETTER' })
      expect(lastFinish().data.lastError).toMatch(/REPLACED_BOOKINGS_NOT_CANCELLED/)
    })
  })
  // nuevo
  it('publicar sin que el proveedor devuelva la ocurrencia ⇒ DEAD_LETTER (no se publica dos veces)', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true }) }))
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: NOW } as any, spots: 2, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(null)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorSessionLink.upsert).not.toHaveBeenCalled()
    expect(lastFinish().data.status).toBe('DEAD_LETTER')
  })

  // nuevo — Codex F5: la coalescencia sólo mira PENDING/FAILED, así que el horizonte creaba otra fila y, sin vínculo,
  // publicaba otra vez la clase que TotalPass ya tenía (la primera quedaba huérfana).
  describe('una publicación anterior quedó sin vincular (DEAD_LETTER)', () => {
    const arrange = (dead: unknown, link: unknown = null) => {
      const a = fakeAdapter()
      jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
      prismaMock.aggregatorOutbox.findFirst
        .mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1', coalesceKey: 'SYNC_SESSION:c1:s1' }) as any)
        .mockResolvedValueOnce(dead as any)
      jest
        .spyOn(sync, 'buildSessionPublication')
        .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: NOW } as any, spots: 2, providerActive: 0 })
      prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(link as any)
      return a
    }
    it.each([
      'LINK_SAVE_FAILED: publicada como ocurrencia occ-77 pero no se pudo guardar el vínculo: connection reset',
      'NO_OCCURRENCE_ID: el proveedor publicó sin devolver la ocurrencia',
    ])('«%s» ⇒ SKIPPED en revisión manual, sin publicar otra', async lastError => {
      const a = arrange({ id: 'o0', lastError })
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(prismaMock.aggregatorOutbox.findFirst.mock.calls[1][0].where).toEqual({
        coalesceKey: 'SYNC_SESSION:c1:s1',
        status: 'DEAD_LETTER',
        OR: [{ lastError: { startsWith: 'LINK_SAVE_FAILED' } }, { lastError: { startsWith: 'NO_OCCURRENCE_ID' } }],
      })
      expect(a.publishSession).not.toHaveBeenCalled()
      const last = lastFinish().data
      expect(last.status).toBe('SKIPPED')
      expect(last.lastError).toContain('revisión manual')
      expect(last.lastError).toContain(lastError.split(':')[0])
    })
    // regresión — sin esa fila muerta se publica como siempre
    it('sin fila muerta de la clase ⇒ publica', async () => {
      const a = arrange(null)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.publishSession).toHaveBeenCalledTimes(1)
      expect(lastFinish().data.status).toBe('DONE')
    })
  })
  // fix 1/5 — R12
  it('VALIDATE_VISIT que el estudio resolvió entre la lectura y la escritura ⇒ no se pisa, fila DONE', async () => {
    jest.spyOn(registry, 'adapterFor').mockReturnValue(fakeAdapter())
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('VALIDATE_VISIT', { aggregatorVisitId: 'vis1' }) as any)
    prismaMock.aggregatorVisit.findUnique.mockResolvedValueOnce({
      id: 'vis1',
      status: 'PENDING',
      validationRef: 'https://admin.totalpass.com/x',
      deadlineAt: new Date(NOW.getTime() + 60e3),
      connection: { confirmMode: 'AUTO' },
    } as any)
    prismaMock.aggregatorVisit.updateMany.mockResolvedValueOnce({ count: 0 })
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(prismaMock.aggregatorVisit.update).not.toHaveBeenCalled()
    expect(prismaMock.aggregatorVisit.updateMany.mock.calls[0][0].where).toEqual({ id: 'vis1', status: 'PENDING' })
    expect(lastFinish().data.status).toBe('DONE')
  })
  // fix 1/5 — R12
  it('publicada pero sin poder guardar el vínculo ⇒ DEAD_LETTER con el id de la ocurrencia (no se publica otra)', async () => {
    const a = fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: 'occ-77' }) })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: NOW } as any, spots: 2, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(null)
    prismaMock.aggregatorSessionLink.upsert.mockRejectedValueOnce(new Error('connection reset'))
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession).toHaveBeenCalledTimes(1)
    const last = lastFinish().data
    expect(last.status).toBe('DEAD_LETTER')
    expect(last.lastError).toContain('occ-77')
    expect(last.lastError).not.toContain(CREDENTIAL)
  })
  // fix 1/5
  it.each(['CANCELLED', 'NOT_LINKED'] as const)(
    'SYNC_SESSION %s con la ocurrencia publicada ya en el pasado ⇒ no se da de baja',
    async reason => {
      const a = fakeAdapter()
      jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
      jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: null, spots: 0, providerActive: 0, reason })
      prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
        id: 'l1',
        externalOccurrenceId: 'occ-1',
        live: true,
        publishedStartsAt: new Date(NOW.getTime() - 60e3),
      } as any)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.unpublishSession).not.toHaveBeenCalled()
      expect(lastFinish().data.status).toBe('SKIPPED')
    },
  )
  // fix 1/5
  it('SYNC_SESSION movida desde una hora que ya pasó ⇒ publica nueva sin entregar la ocurrencia pasada', async () => {
    const a = fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: 'occ-2' }) })
    jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
    const future = new Date(NOW.getTime() + 24 * 3600e3)
    prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
    jest
      .spyOn(sync, 'buildSessionPublication')
      .mockResolvedValueOnce({ publication: { classSessionId: 's1', startsAt: future } as any, spots: 2, providerActive: 0 })
    prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce({
      id: 'l1',
      externalOccurrenceId: 'occ-1',
      live: true,
      publishedStartsAt: new Date(NOW.getTime() - 3600e3),
      publishedSpots: 2,
    } as any)
    await runPassOutboxRow('o1', 'tk', NOW)
    expect(a.publishSession.mock.calls[0][2]).toMatchObject({ externalOccurrenceId: null })
  })

  // nuevo — pausa suave (decisión del founder, 3-oct): sin el plan no se publican clases nuevas, pero lo ya publicado
  // se sigue atendiendo (cupo, detalles, baja y reemplazo por cambio de hora) para que nadie se quede plantado.
  describe('pausa suave: el negocio perdió el plan de pases', () => {
    const PAUSED = 'el plan del negocio ya no incluye pases: no se publican clases nuevas'
    const old = new Date(NOW.getTime() + 2 * 3600e3)
    const moved = new Date(NOW.getTime() + 3 * 3600e3)
    const arrange = (link: unknown, publication: unknown = { classSessionId: 's1', startsAt: old }, hasPlan = false) => {
      const a = fakeAdapter({ publishSession: jest.fn().mockResolvedValue({ ok: true, externalOccurrenceId: 'occ-2' }) })
      jest.spyOn(registry, 'adapterFor').mockReturnValue(a)
      const access = jest.spyOn(basePlan, 'venueHasFeatureAccess').mockResolvedValue(hasPlan)
      prismaMock.aggregatorOutbox.findFirst.mockResolvedValueOnce(row('SYNC_SESSION', { classSessionId: 's1' }) as any)
      jest.spyOn(sync, 'buildSessionPublication').mockResolvedValueOnce({ publication: publication as any, spots: 2, providerActive: 0 })
      prismaMock.aggregatorSessionLink.findUnique.mockResolvedValueOnce(link as any)
      return { a, access }
    }
    afterEach(() => jest.restoreAllMocks())

    it.each([
      ['nunca publicada', null],
      ['dada de baja antes', { id: 'l1', externalOccurrenceId: 'occ-1', live: false, publishedStartsAt: old, publishedSpots: 2 }],
      [
        'su ocurrencia viva ya pasó',
        { id: 'l1', externalOccurrenceId: 'occ-1', live: true, publishedStartsAt: new Date(NOW.getTime() - 3600e3) },
      ],
    ])('clase sin ocurrencia viva a futuro (%s) ⇒ SKIPPED sin llamar al proveedor', async (_caso, link) => {
      const { a, access } = arrange(link)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(access).toHaveBeenCalledWith('v1', 'AGGREGATOR_PASSES')
      expect(a.publishSession).not.toHaveBeenCalled()
      expect(prismaMock.aggregatorSessionLink.upsert).not.toHaveBeenCalled()
      expect(lastFinish().data).toMatchObject({ status: 'SKIPPED', lastError: PAUSED })
    })

    it('con el plan ⇒ publica como siempre', async () => {
      const { a, access } = arrange(null, undefined, true)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(access).toHaveBeenCalledWith('v1', 'AGGREGATOR_PASSES')
      expect(a.publishSession).toHaveBeenCalled()
      expect(lastFinish().data.status).toBe('DONE')
    })

    it('ocurrencia viva: el cupo se sigue actualizando', async () => {
      const { a } = arrange({ id: 'l1', externalOccurrenceId: 'occ-1', live: true, publishedStartsAt: old, publishedSpots: 5 })
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.updateSpots).toHaveBeenCalledWith(expect.anything(), 'occ-1', 2)
      expect(a.publishSession).not.toHaveBeenCalled()
      expect(lastFinish().data.status).toBe('DONE')
    })

    it('ocurrencia viva de una clase cancelada: se sigue dando de baja', async () => {
      const { a } = arrange({ id: 'l1', externalOccurrenceId: 'occ-1', live: true, publishedStartsAt: old }, null)
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.unpublishSession).toHaveBeenCalledWith(expect.anything(), 'occ-1')
      expect(lastFinish().data.status).toBe('DONE')
    })

    it('ocurrencia viva que cambió de hora: el reemplazo sigue como hoy y no truena', async () => {
      const cancel = jest.spyOn(ingestion, 'cancelPassBookingsOfReplacedOccurrence').mockResolvedValue(1)
      const { a } = arrange(
        { id: 'l1', externalOccurrenceId: 'occ-1', live: true, publishedStartsAt: old, publishedSpots: 2 },
        { classSessionId: 's1', startsAt: moved },
      )
      await runPassOutboxRow('o1', 'tk', NOW)
      expect(a.publishSession.mock.calls[0][2]).toEqual({ externalOccurrenceId: 'occ-1', publishedStartsAt: old })
      expect(cancel).toHaveBeenCalledWith({ id: 'c1', venueId: 'v1', provider: 'TOTALPASS' }, 's1', expect.any(Date), NOW)
      expect(lastFinish().data.status).toBe('DONE')
    })
  })
})

describe('claimPassOutbox', () => {
  // nuevo
  it('reclama con FOR UPDATE SKIP LOCKED y devuelve sólo lo que quedó en curso con su token', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { id: 'o1', claimToken: 'tok', status: 'IN_PROGRESS' },
      { id: 'o2', claimToken: null, status: 'DEAD_LETTER' },
    ])
    const r = await claimPassOutbox(10, NOW)
    expect(r).toEqual([{ id: 'o1', claimToken: 'tok' }])
    const sql = prismaMock.$queryRaw.mock.calls[0][0]
    const text = (sql as string[]).join('?')
    expect(text).toContain('FOR UPDATE SKIP LOCKED')
    expect(text).toContain('"leaseUntil" <')
    // El tope del lote se acota (nunca más de 50).
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1)
    expect(values).toContain(10)
  })
  // nuevo
  it('acota el lote a 50', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    await claimPassOutbox(5000, NOW)
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1)
    expect(values).toContain(50)
    expect(values).not.toContain(5000)
  })
})
