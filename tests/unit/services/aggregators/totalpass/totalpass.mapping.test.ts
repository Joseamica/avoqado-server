import {
  toTotalPassTime,
  toTotalPassDate,
  toTotalPassDateTime,
  mapDenyReason,
  isTotalPassValidationUrl,
} from '@/services/aggregators/providers/totalpass/totalpass.mapping'
import { totalPassAdapter } from '@/services/aggregators/providers/totalpass/totalpass.adapter'
import { BOOKING_ACTIVE, CHECKIN_CREATED } from './fixtures'

const tz = 'America/Mexico_City'
// 2030-03-04 15:00 en CDMX = 21:00Z (CDMX sin horario de verano desde 2022)
const d = new Date('2030-03-04T21:00:00Z')

describe('mapeo TotalPass', () => {
  // nuevo
  it('hora y fecha locales en el formato que exige TotalPass', () => {
    expect(toTotalPassTime(d, tz)).toBe('03:00 PM')
    expect(toTotalPassDate(d, tz)).toBe('2030-03-04')
    expect(toTotalPassDateTime(new Date('2030-03-04T14:59:00Z'), tz)).toBe('2030-03-04 08:59 AM')
  })
  // nuevo — medianoche y fecha local distinta de la UTC
  it('medianoche sale 12:00 AM y la fecha es la local, no la UTC', () => {
    // 2030-03-05 05:30Z = 2030-03-04 23:30 en CDMX
    expect(toTotalPassDateTime(new Date('2030-03-05T05:30:00Z'), tz)).toBe('2030-03-04 11:30 PM')
    expect(toTotalPassDateTime(new Date('2030-03-05T06:00:00Z'), tz)).toBe('2030-03-05 12:00 AM')
    // Otra zona del venue: Tijuana (UTC-8 en marzo antes del cambio de horario)
    expect(toTotalPassTime(new Date('2030-03-04T21:00:00Z'), 'America/Tijuana')).toBe('01:00 PM')
  })
  // nuevo
  it('motivos de rechazo al enum de TotalPass', () => {
    expect(mapDenyReason('CLASS_FULL')).toBe('class_overbooked')
    expect(mapDenyReason('CLASS_CANCELLED')).toBe('canceled_event')
    expect(mapDenyReason('NOT_ELIGIBLE')).toBe('user_not_elegible')
    expect(mapDenyReason('ALREADY_IN_CLASS')).toBe('user_already_in_class')
    expect(mapDenyReason('OTHER')).toBe('denied_by_gym')
  })
  // nuevo — anti-SSRF
  it('sólo valida contra https://*.totalpass.com', () => {
    expect(isTotalPassValidationUrl('https://admin.totalpass.com/api/v1/webhook_confirmations/T==')).toBe(true)
    expect(isTotalPassValidationUrl('https://totalpass.com/x')).toBe(true)
    expect(isTotalPassValidationUrl('http://admin.totalpass.com/x')).toBe(false)
    expect(isTotalPassValidationUrl('https://totalpass.com.evil.io/x')).toBe(false)
    expect(isTotalPassValidationUrl('https://eviltotalpass.com/x')).toBe(false)
    expect(isTotalPassValidationUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isTotalPassValidationUrl('no es url')).toBe(false)
  })
  // nuevo
  it('webhook de booking activo ⇒ BOOKING_REQUESTED con el código del socio', () => {
    expect(totalPassAdapter.parseWebhook('BOOKING', BOOKING_ACTIVE)).toMatchObject({
      kind: 'BOOKING_REQUESTED',
      externalBookingId: '677fc3d14bc7797787a4e8c7',
      externalOccurrenceId: '40dc2acc-f418-4447-9d78-7b1c76fc8399',
      externalUserId: 'S2MXBABC',
      placeId: '9c83d967-d783-4e74-9e11-4ebe462ab7d9',
    })
  })
  // nuevo
  it('booking: plan, lugar y datos del socio', () => {
    const conLugar = {
      ...BOOKING_ACTIVE,
      event: { ...BOOKING_ACTIVE.event, plan_code: 'B0KR5QWH' },
      slot: { ...BOOKING_ACTIVE.slot, seat: { externalReference: 'A1', name: 'A1' } },
    }
    expect(totalPassAdapter.parseWebhook('BOOKING', conLugar)).toMatchObject({
      externalPlanCode: 'B0KR5QWH',
      seatRef: 'A1',
      user: { name: 'Pedro Santos', email: 'pedrosantos@outlook.com', phone: '(11) 98222-4623' },
    })
    expect(totalPassAdapter.parseWebhook('BOOKING', BOOKING_ACTIVE)).toMatchObject({ externalPlanCode: null, seatRef: null })
  })
  // nuevo — Review Focus 5
  it('estado desconocido ⇒ IGNORED; estado con cancel ⇒ BOOKING_CANCELLED', () => {
    const raro = { ...BOOKING_ACTIVE, slot: { ...BOOKING_ACTIVE.slot, status: 'expired' } }
    expect(totalPassAdapter.parseWebhook('BOOKING', raro)).toEqual({ kind: 'IGNORED', reason: 'slot.status=expired' })
    const tarde = { ...BOOKING_ACTIVE, slot: { ...BOOKING_ACTIVE.slot, status: 'late_canceled' } }
    expect(totalPassAdapter.parseWebhook('BOOKING', tarde)).toMatchObject({ kind: 'BOOKING_CANCELLED', late: true })
    const aTiempo = { ...BOOKING_ACTIVE, slot: { ...BOOKING_ACTIVE.slot, status: 'canceled' } }
    expect(totalPassAdapter.parseWebhook('BOOKING', aTiempo)).toEqual({
      kind: 'BOOKING_CANCELLED',
      externalBookingId: '677fc3d14bc7797787a4e8c7',
      late: false,
      placeId: '9c83d967-d783-4e74-9e11-4ebe462ab7d9',
    })
  })
  // nuevo — cuerpos mal formados no truenan
  it('booking mal formado ⇒ IGNORED, nunca excepción', () => {
    for (const body of [null, 'texto', [], {}, { slot: {} }, { slot: { status: 'active' } }]) {
      expect(totalPassAdapter.parseWebhook('BOOKING', body)).toMatchObject({ kind: 'IGNORED' })
    }
    const sinEvento = { ...BOOKING_ACTIVE, event: {} }
    expect(totalPassAdapter.parseWebhook('BOOKING', sinEvento)).toEqual({ kind: 'IGNORED', reason: 'falta event.id' })
    const sinCodigo = { ...BOOKING_ACTIVE, user: { name: 'X' } }
    expect(totalPassAdapter.parseWebhook('BOOKING', sinCodigo)).toEqual({ kind: 'IGNORED', reason: 'falta user.code' })
  })
  // nuevo
  it('check-in ⇒ CHECKIN_CREATED con plazo de expires_at y dedupe por el endpoint', () => {
    const ev: any = totalPassAdapter.parseWebhook('CHECKIN', CHECKIN_CREATED)
    expect(ev).toMatchObject({ kind: 'CHECKIN_CREATED', externalUserId: 'EQ2B3FBK', validationRef: CHECKIN_CREATED.endpoint })
    expect(ev.deadlineAt.toISOString()).toBe(new Date('2024-08-07T19:24:16.271-03:00').toISOString())
    expect(totalPassAdapter.dedupKey('CHECKIN', CHECKIN_CREATED)).toBe(totalPassAdapter.dedupKey('CHECKIN', CHECKIN_CREATED))
    expect(totalPassAdapter.dedupKey('CHECKIN', CHECKIN_CREATED)).toMatch(/^TOTALPASS:CHECKIN:[0-9a-f]{64}$/)
    expect(ev.externalCheckinId).toBe(totalPassAdapter.dedupKey('CHECKIN', CHECKIN_CREATED).split(':')[2])
  })
  // nuevo
  it('check-in sin expires_at ⇒ plazo de 90 min desde started_at', () => {
    const sinPlazo = { ...CHECKIN_CREATED, check_in: { started_at: '2024-08-07T17:54:16.271-03:00' } }
    const ev: any = totalPassAdapter.parseWebhook('CHECKIN', sinPlazo)
    expect(ev.startedAt.toISOString()).toBe('2024-08-07T20:54:16.271Z')
    expect(ev.deadlineAt.toISOString()).toBe('2024-08-07T22:24:16.271Z')
  })
  // nuevo — anti-SSRF y cuerpos mal formados
  it('check-in con endpoint ajeno, fecha inválida o campos faltantes ⇒ IGNORED', () => {
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, endpoint: 'https://evil.io/x' })).toMatchObject({
      kind: 'IGNORED',
    })
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, type: 'CHECK_IN_CANCELLED' })).toEqual({
      kind: 'IGNORED',
      reason: 'type=CHECK_IN_CANCELLED',
    })
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, check_in: { started_at: 'ayer' } })).toMatchObject({
      kind: 'IGNORED',
    })
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, check_in: undefined })).toMatchObject({ kind: 'IGNORED' })
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, user: {} })).toMatchObject({ kind: 'IGNORED' })
    expect(totalPassAdapter.parseWebhook('CHECKIN', { ...CHECKIN_CREATED, endpoint: undefined })).toMatchObject({ kind: 'IGNORED' })
    for (const body of [null, 42, [], {}]) expect(totalPassAdapter.parseWebhook('CHECKIN', body)).toMatchObject({ kind: 'IGNORED' })
  })
  // nuevo
  it('dedupKey de booking por slot y estado; nunca truena y no colapsa cuerpos distintos', () => {
    expect(totalPassAdapter.dedupKey('BOOKING', BOOKING_ACTIVE)).toBe('TOTALPASS:BOOKING:677fc3d14bc7797787a4e8c7:active')
    const cancelado = { ...BOOKING_ACTIVE, slot: { ...BOOKING_ACTIVE.slot, status: 'canceled' } }
    expect(totalPassAdapter.dedupKey('BOOKING', cancelado)).toBe('TOTALPASS:BOOKING:677fc3d14bc7797787a4e8c7:canceled')
    for (const kind of ['BOOKING', 'CHECKIN'] as const) {
      for (const body of [null, undefined, 'x', [], {}]) expect(() => totalPassAdapter.dedupKey(kind, body)).not.toThrow()
      expect(totalPassAdapter.dedupKey(kind, { a: 1 })).not.toBe(totalPassAdapter.dedupKey(kind, { a: 2 }))
      expect(totalPassAdapter.dedupKey(kind, { a: 1 })).toMatch(new RegExp(`^TOTALPASS:${kind}:[0-9a-f]{64}$`))
    }
  })
})
