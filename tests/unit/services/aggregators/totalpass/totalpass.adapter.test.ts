import { totalPassAdapter, __resetTotalPassTokens } from '@/services/aggregators/providers/totalpass/totalpass.adapter'

const ctx = { id: 'c1', venueId: 'v1', provider: 'TOTALPASS' as const, externalPlaceId: 'place-1', credential: 'place-key', config: {} }
const json = (status: number, body: unknown) =>
  ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as any
const calls = () => (fetch as jest.Mock).mock.calls
const pub = (startsAt: Date, over: Record<string, unknown> = {}) => ({
  classSessionId: 's1',
  title: 'Reformer',
  coachName: 'Lu',
  durationMin: 50,
  startsAt,
  timezone: 'America/Mexico_City',
  spots: 3,
  externalPlanId: '305',
  bookingClosesAt: new Date(startsAt.getTime() - 60e3),
  cancelUntil: null,
  ...over,
})

// Reloj congelado: las clases de 2030 siempre están en el futuro (sin bomba de tiempo) y la ventana de reserva se
// puede afirmar exacta. fetch está simulado, así que ningún temporizador real hace falta.
const NOW = new Date('2030-03-01T12:00:00Z') // 06:00 AM en CDMX

describe('totalPassAdapter (HTTP)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
    __resetTotalPassTokens()
    global.fetch = jest.fn() as any
  })
  afterEach(() => {
    jest.useRealTimers()
  })
  // nuevo
  it('autentica una vez por conexión y reusa el token', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, {}))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 4)
    const urls = calls().map(c => c[0])
    expect(urls.filter((u: string) => u.endsWith('/partner/auth'))).toHaveLength(1)
    expect(calls()[1][1].headers.Authorization).toBe('Bearer jwt-1')
    expect(JSON.parse(calls()[0][1].body)).toEqual({ place_api_key: 'place-key', partner_api_key: 'partner-test-key' })
    expect(urls[1]).toBe('https://booking-api.totalpass.com/partner/event-occurrence/occ-1/slot')
    expect(JSON.parse(calls()[2][1].body)).toEqual({ slots: 4 })
  })
  // nuevo — el token es por conexión y por host
  it('otra conexión u otro host (check-in) piden su propio token', async () => {
    ;(fetch as jest.Mock).mockResolvedValue(json(201, { token: 'jwt-x', identifier: 'uuid-place' }))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    await totalPassAdapter.updateSpots({ ...ctx, id: 'c2' }, 'occ-1', 3)
    await totalPassAdapter.setup(ctx, { booking: 'https://a/b', checkin: 'https://a/c' }).catch(() => undefined)
    const auths = calls()
      .map(c => c[0])
      .filter((u: string) => u.endsWith('/partner/auth'))
    expect(auths).toEqual([
      'https://booking-api.totalpass.com/partner/auth',
      'https://booking-api.totalpass.com/partner/auth',
      'https://gym-service-api.totalpass.com/partner/auth',
    ])
  })
  // nuevo — R14c: una llave nueva del estudio nunca reusa el JWT de la vieja
  it('si cambia la llave de la sucursal, pide token nuevo con la llave nueva', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-vieja' }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(201, { token: 'jwt-nueva' }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, {}))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    await totalPassAdapter.updateSpots({ ...ctx, credential: 'place-key-2' }, 'occ-1', 3)
    await totalPassAdapter.updateSpots({ ...ctx, credential: 'place-key-2' }, 'occ-1', 3)
    expect(calls().map(c => c[0].endsWith('/partner/auth'))).toEqual([true, false, true, false, false])
    expect(JSON.parse(calls()[2][1].body).place_api_key).toBe('place-key-2')
    expect(calls()[3][1].headers.Authorization).toBe('Bearer jwt-nueva')
    expect(calls()[4][1].headers.Authorization).toBe('Bearer jwt-nueva')
  })
  // nuevo — el token dura 23 h en caché
  it('el token se renueva pasadas 23 h', async () => {
    ;(fetch as jest.Mock).mockResolvedValue(json(201, { token: 'jwt' }))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    jest.setSystemTime(new Date(NOW.getTime() + 22 * 3600e3))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    jest.setSystemTime(new Date(NOW.getTime() + 23 * 3600e3 + 1))
    await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    expect(calls().filter(c => c[0].endsWith('/partner/auth'))).toHaveLength(2)
  })
  // nuevo
  it('401 ⇒ re-autentica una vez; si vuelve 401 ⇒ UNAUTHORIZED no reintentable', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(json(401, { message: 'Invalid credentials' }))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: 'UNAUTHORIZED',
    })
  })
  // nuevo
  it('401 con token vencido ⇒ re-autentica y repite la llamada con el token nuevo', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(401, { message: 'Unauthorized' }))
      .mockResolvedValueOnce(json(201, { token: 'jwt-2' }))
      .mockResolvedValueOnce(json(200, {}))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toEqual({ ok: true })
    expect(calls()[3][1].headers.Authorization).toBe('Bearer jwt-2')
    expect(calls()).toHaveLength(4)
  })
  // nuevo
  it('sin llave de la sucursal ⇒ UNAUTHORIZED sin llamar a TotalPass', async () => {
    await expect(totalPassAdapter.updateSpots({ ...ctx, credential: null }, 'occ-1', 3)).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: 'UNAUTHORIZED',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
  // nuevo
  it('422 al bajar cupo ⇒ no reintentable', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(422, { message: 'cannot be reduced' }))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 0)).resolves.toMatchObject({ ok: false, retryable: false })
  })
  // nuevo
  it('5xx y 429 se reintentan', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(503, 'down'))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({ ok: false, retryable: true, code: 'HTTP_503' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(429, 'slow down'))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({ ok: false, retryable: true, code: 'HTTP_429' })
  })
  // nuevo — la bandeja tiene lease de 2 min: toda llamada lleva timeout
  it('cada llamada lleva un timeout y un timeout ⇒ TIMEOUT reintentable', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockRejectedValueOnce(timeout)
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({ ok: false, retryable: true, code: 'TIMEOUT' })
    for (const [, init] of calls()) expect(init.signal).toBeInstanceOf(AbortSignal)
    ;(fetch as jest.Mock).mockRejectedValueOnce(timeout)
    await expect(
      totalPassAdapter.validateVisit(ctx, 'https://admin.totalpass.com/api/v1/webhook_confirmations/T=='),
    ).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: 'TIMEOUT',
    })
    expect(calls()[2][1].signal).toBeInstanceOf(AbortSignal)
  })
  // nuevo — el auth también lleva timeout
  it('timeout en el auth ⇒ TIMEOUT reintentable; red caída ⇒ NETWORK reintentable', async () => {
    ;(fetch as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({ ok: false, retryable: true, code: 'TIMEOUT' })
    ;(fetch as jest.Mock).mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(totalPassAdapter.updateSpots(ctx, 'occ-1', 3)).resolves.toMatchObject({ ok: false, retryable: true, code: 'NETWORK' })
  })
  // nuevo — llaves y token nunca en el mensaje
  it('los mensajes de error no llevan llaves ni token', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-secreto-1' }))
      .mockResolvedValueOnce(json(400, { echo: 'place-key partner-test-key jwt-secreto-1' }))
    const r: any = await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    expect(r).toMatchObject({ ok: false, retryable: false, code: 'HTTP_400' })
    expect(r.message).not.toMatch(/place-key|partner-test-key|jwt-secreto-1/)
    __resetTotalPassTokens()
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(500, { place_api_key: 'place-key', partner_api_key: 'partner-test-key' }))
    const a: any = await totalPassAdapter.updateSpots(ctx, 'occ-1', 3)
    expect(a).toMatchObject({ ok: false, retryable: true, code: 'HTTP_500' })
    expect(a.message).not.toMatch(/place-key|partner-test-key/)
  })
  // nuevo
  it('publica una ocurrencia nueva con el formato de TotalPass', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(201, { eventOccurrenceUuid: 'occ-9' }))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    const r = await totalPassAdapter.publishSession(ctx, pub(startsAt), { externalOccurrenceId: null, publishedStartsAt: null })
    expect(r).toMatchObject({ ok: true, externalOccurrenceId: 'occ-9' })
    const [url, init] = calls()[1]
    expect(url).toBe('https://booking-api.totalpass.com/partner/event-occurrence')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      title: 'Reformer',
      responsible: 'Lu',
      duration: 50,
      slots: 3,
      planId: 305,
      timezone: 'es-MX',
      eventDate: '2030-03-04',
      startTime: '03:00 PM',
      externalReference: 's1',
    })
    expect(body.bookingWindow.maxTimeToBook).toBe('2030-03-04 02:59 PM')
    expect(body.bookingWindow.minTimeToBook).toBe('2030-03-01 06:00 AM')
    expect(calls()).toHaveLength(2) // sin ocurrencia previa no se da de baja nada
  })
  // nuevo — Review: publishedStartsAt solo no basta para dar de baja
  it('con publishedStartsAt pero sin ocurrencia previa no toca nada viejo', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(201, { eventOccurrenceUuid: 'occ-9' }))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    await totalPassAdapter.publishSession(ctx, pub(startsAt), {
      externalOccurrenceId: null,
      publishedStartsAt: new Date('2030-03-03T21:00:00Z'),
    })
    expect(calls().map(c => c[1].method)).toEqual(['POST', 'POST'])
  })
  // nuevo — reprogramar: baja (INACTIVE + DELETE) y alta
  it('con ocurrencia previa: la desactiva, la borra y crea la nueva', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(201, { message: 'Count of updated events: 1' }))
      .mockResolvedValueOnce(json(200, { message: 'Event deleted' }))
      .mockResolvedValueOnce(json(201, { eventOccurrenceUuid: 'occ-new' }))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    const r = await totalPassAdapter.publishSession(ctx, pub(startsAt), {
      externalOccurrenceId: 'occ-old',
      publishedStartsAt: new Date('2030-03-03T21:00:00Z'),
    })
    expect(r).toMatchObject({ ok: true, externalOccurrenceId: 'occ-new' })
    expect(calls()[1][0]).toBe('https://booking-api.totalpass.com/partner/event-occurrence/status')
    expect(JSON.parse(calls()[1][1].body)).toEqual({ occurrencesToUpdate: [{ occurrenceUuid: 'occ-old', status: 'INACTIVE' }] })
    expect(calls()[2][0]).toBe('https://booking-api.totalpass.com/partner/event-occurrence/occ-old')
    expect(calls()[2][1].method).toBe('DELETE')
    expect(calls()[3][0]).toBe('https://booking-api.totalpass.com/partner/event-occurrence')
  })
  // nuevo — si la baja falla no se crea un duplicado
  it('si la baja de la vieja falla, devuelve ese fallo y no crea la nueva', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(503, 'down'))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    const r = await totalPassAdapter.publishSession(ctx, pub(startsAt), { externalOccurrenceId: 'occ-old', publishedStartsAt: startsAt })
    expect(r).toMatchObject({ ok: false, retryable: true, code: 'HTTP_503' })
    expect(calls()).toHaveLength(2)
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, {})).mockResolvedValueOnce(json(500, 'boom'))
    const r2 = await totalPassAdapter.publishSession(ctx, pub(startsAt), { externalOccurrenceId: 'occ-old', publishedStartsAt: startsAt })
    expect(r2).toMatchObject({ ok: false, retryable: true, code: 'HTTP_500' })
    expect(calls().filter(c => c[0].endsWith('/partner/event-occurrence') && c[1].method === 'POST')).toHaveLength(0)
  })
  // nuevo — la vieja ya no existía
  it('si la vieja ya no existe (404) sigue con el alta', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(json(404, { message: 'Event not found' }))
      .mockResolvedValueOnce(json(201, { eventOccurrenceUuid: 'occ-new' }))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    await expect(
      totalPassAdapter.publishSession(ctx, pub(startsAt), { externalOccurrenceId: 'occ-old', publishedStartsAt: startsAt }),
    ).resolves.toMatchObject({ ok: true, externalOccurrenceId: 'occ-new' })
  })
  // nuevo
  it('plan no numérico ⇒ BAD_PLAN_ID sin llamar; ventana casi cerrada ⇒ sin bookingWindow', async () => {
    const startsAt = new Date('2030-03-04T21:00:00Z')
    await expect(
      totalPassAdapter.publishSession(ctx, pub(startsAt, { externalPlanId: 'abc' }), {
        externalOccurrenceId: null,
        publishedStartsAt: null,
      }),
    ).resolves.toMatchObject({ ok: false, retryable: false, code: 'BAD_PLAN_ID' })
    expect(fetch).not.toHaveBeenCalled()
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(201, { eventOccurrenceUuid: 'occ-9' }))
    await totalPassAdapter.publishSession(ctx, pub(startsAt, { bookingClosesAt: new Date(Date.now() + 10e3), coachName: '  ' }), {
      externalOccurrenceId: null,
      publishedStartsAt: null,
    })
    const body = JSON.parse(calls()[1][1].body)
    expect(body.bookingWindow).toBeUndefined()
    expect(body.responsible).toBe('Por asignar')
  })
  // nuevo — Codex F7: coach, título o duración se editan en la ocurrencia viva (contrato §3.6), sin cancelar reservas
  it('updateSessionDetails: PUT de la ocurrencia con los campos editables del contrato §3.6', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(200, { id: 1 }))
    const startsAt = new Date('2030-03-04T21:00:00Z')
    const r = await totalPassAdapter.updateSessionDetails(ctx, 'occ-9', pub(startsAt, { coachName: 'Ana', durationMin: 45 }))
    expect(r).toEqual({ ok: true })
    const [url, init] = calls()[1]
    expect(url).toBe('https://booking-api.totalpass.com/partner/event-occurrence/occ-9')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({
      title: 'Reformer',
      responsible: 'Ana',
      duration: 45,
      externalReference: 's1',
      bookingWindow: { minTimeToBook: '2030-03-01 06:00 AM', maxTimeToBook: '2030-03-04 02:59 PM' },
    })
    // Sin cupo, plan, fecha ni hora: eso no se edita por aquí.
    expect(Object.keys(JSON.parse(init.body))).not.toEqual(expect.arrayContaining(['slots']))
  })
  // nuevo — Codex F7
  it('updateSessionDetails: un 4xx no se reintenta y un 5xx sí', async () => {
    const startsAt = new Date('2030-03-04T21:00:00Z')
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(400, { message: 'x' }))
    await expect(totalPassAdapter.updateSessionDetails(ctx, 'occ-9', pub(startsAt))).resolves.toMatchObject({ ok: false, retryable: false })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(503, 'down'))
    await expect(totalPassAdapter.updateSessionDetails(ctx, 'occ-9', pub(startsAt))).resolves.toMatchObject({ ok: false, retryable: true })
  })
  // nuevo
  it('respuesta de alta sin uuid ⇒ ok sin externalOccurrenceId (el núcleo lo trata)', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(201, { eventId: 1 }))
    const r = await totalPassAdapter.publishSession(ctx, pub(new Date('2030-03-04T21:00:00Z')), {
      externalOccurrenceId: null,
      publishedStartsAt: null,
    })
    expect(r).toEqual({ ok: true, externalOccurrenceId: undefined })
  })
  // nuevo
  it('baja de la sesión: DELETE; 404 cuenta como hecho', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(200, { message: 'Event deleted' }))
    await expect(totalPassAdapter.unpublishSession(ctx, 'occ-1')).resolves.toEqual({ ok: true })
    expect(calls()[1][1].method).toBe('DELETE')
    expect(calls()[1][0]).toBe('https://booking-api.totalpass.com/partner/event-occurrence/occ-1')
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(404, { message: 'Event not found' }))
    await expect(totalPassAdapter.unpublishSession(ctx, 'occ-1')).resolves.toEqual({ ok: true })
  })
  // nuevo — Review Focus 4
  it('validar check-in: 200 ok; 422 check_in_not_available ⇒ alreadyValidated; 422 expirado ⇒ expired', async () => {
    const url = 'https://admin.totalpass.com/api/v1/webhook_confirmations/T=='
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(200, '1'))
    await expect(totalPassAdapter.validateVisit(ctx, url)).resolves.toMatchObject({ ok: true })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(422, { errors: [{ source: { label: 'check_in_not_available' } }] }))
    await expect(totalPassAdapter.validateVisit(ctx, url)).resolves.toMatchObject({ ok: false, alreadyValidated: true, retryable: false })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(422, { errors: [{ source: { label: 'check_in_expired_alert' } }] }))
    await expect(totalPassAdapter.validateVisit(ctx, url)).resolves.toMatchObject({ ok: false, expired: true, retryable: false })
    const [calledUrl, init] = calls()[0]
    expect(calledUrl).toBe(url)
    expect(init.method).toBe('POST')
    expect(init.headers?.Authorization).toBeUndefined()
    expect(init.body).toBeUndefined()
  })
  // nuevo
  it('validar check-in: 404 no reintentable, 5xx reintentable, y el resultado nunca lleva el token', async () => {
    const token = 'SECRETO-Ab+/=='
    const url = `https://admin.totalpass.com/api/v1/webhook_confirmations/${token}`
    const eco = `token ${token} url ${url} codificado ${encodeURIComponent(token)} ${encodeURIComponent(url)}`
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(404, { message: 'not found', eco }))
    const r: any = await totalPassAdapter.validateVisit(ctx, url)
    expect(r).toEqual({ ok: false, retryable: false, code: 'HTTP_404', message: 'TotalPass respondió HTTP 404 al validar el check-in' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(500, eco))
    const r2: any = await totalPassAdapter.validateVisit(ctx, url)
    expect(r2).toMatchObject({ ok: false, retryable: true, code: 'HTTP_500' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(502, `bad gateway ${eco}`))
    const r3: any = await totalPassAdapter.validateVisit(ctx, url)
    expect(r3).toMatchObject({ ok: false, retryable: true, code: 'HTTP_502' })
    ;(fetch as jest.Mock).mockRejectedValueOnce(new TypeError(`fetch failed ${url}`))
    const r4: any = await totalPassAdapter.validateVisit(ctx, url)
    expect(r4).toMatchObject({ ok: false, retryable: true, code: 'NETWORK' })
    // 422 con etiqueta desconocida que repite el token: sólo pasan etiquetas conocidas
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(422, { errors: [{ source: { label: eco, message: eco } }] }))
    const r5: any = await totalPassAdapter.validateVisit(ctx, url)
    expect(r5).toMatchObject({ ok: false, retryable: false, code: 'HTTP_422', alreadyValidated: false, expired: false })
    for (const x of [r, r2, r3, r4, r5]) expect(JSON.stringify(x)).not.toMatch(/SECRETO/)
  })
  // nuevo — anti-SSRF
  it('no llama a una URL de validación que no sea de TotalPass', async () => {
    await expect(totalPassAdapter.validateVisit(ctx, 'https://evil.io/x')).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: 'BAD_VALIDATION_URL',
    })
    await expect(totalPassAdapter.validateVisit(ctx, 'http://admin.totalpass.com/x')).resolves.toMatchObject({ code: 'BAD_VALIDATION_URL' })
    expect(fetch).not.toHaveBeenCalled()
  })
  // nuevo
  it('rechazo de reserva manda state denied con motivo', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(200, { statusCode: 200 }))
    await totalPassAdapter.respondBooking(ctx, 'slot-1', { accept: false, reason: 'CLASS_FULL' })
    const [url, init] = calls()[1]
    expect(url).toBe('https://booking-api.totalpass.com/partner/slot/confirmSlot/slot-1')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ state: 'denied', reason: 'class_overbooked' })
  })
  // nuevo
  it('aceptar reserva manda state confirmed; 404 no se reintenta', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-1' })).mockResolvedValueOnce(json(200, { statusCode: 200 }))
    await expect(totalPassAdapter.respondBooking(ctx, 'slot-1', { accept: true })).resolves.toEqual({ ok: true })
    expect(JSON.parse(calls()[1][1].body)).toEqual({ state: 'confirmed' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(404, { message: 'Original slot not found' }))
    await expect(totalPassAdapter.respondBooking(ctx, 'slot-2', { accept: true })).resolves.toMatchObject({ ok: false, retryable: false })
  })
  // nuevo — revisión final I3: el estudio cancela la reserva de un socio desde Avoqado
  it('cancelar reserva: DELETE del slot; ya cancelada, vencida o inexistente cuenta como hecho; 5xx se reintenta', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-1' }))
      .mockResolvedValueOnce(json(200, { slotId: 'slot-1', message: 'Slot removed successfully' }))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toEqual({ ok: true })
    expect(calls()[1][0]).toBe('https://booking-api.totalpass.com/partner/slot/slot-1')
    expect(calls()[1][1].method).toBe('DELETE')
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(400, { title: 'already_canceled', message: 'Already canceled' }))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toEqual({ ok: true })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(400, { title: 'slot_expired', message: 'Slot expired, you cannot cancel this slot' }))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toEqual({ ok: true })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(404, { title: 'slot_not_found', message: 'Slot not found' }))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toEqual({ ok: true })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(400, { title: 'otra_cosa', message: 'x' }))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toMatchObject({ ok: false, retryable: false })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(503, {}))
    await expect(totalPassAdapter.cancelBooking(ctx, 'slot-1')).resolves.toMatchObject({ ok: false, retryable: true })
  })
  // nuevo
  it('setup: planes, confirmación, webhook de reservas y de check-in; nunca devuelve la placeApiKey', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-b' }))
      .mockResolvedValueOnce(
        json(200, {
          name: 'Estudio',
          identifier: 'uuid-place',
          placeApiKey: 'place-key',
          Plans: [{ id: 305, name: 'TP1', code: 'B0KR5QWH', externalReference: 'interno' }],
        }),
      )
      .mockResolvedValueOnce(json(201, { hasSlotConfirmation: true }))
      .mockResolvedValueOnce(json(201, { status: 'success' }))
      .mockResolvedValueOnce(json(201, { token: 'jwt-c' }))
      .mockResolvedValueOnce(json(200, { webhooks: [] }))
      .mockResolvedValueOnce(json(201, { status: 'success' }))
    const r = await totalPassAdapter.setup(ctx, { booking: 'https://api.avoqado.io/b', checkin: 'https://api.avoqado.io/c' })
    expect(r).toEqual({
      ok: true,
      externalPlaceId: 'uuid-place',
      externalPlaceName: 'Estudio',
      data: { plans: [{ id: 305, name: 'TP1', code: 'B0KR5QWH' }] },
    })
    expect(JSON.stringify(r)).not.toContain('place-key')
    const seq = calls().map(c => `${c[1].method} ${c[0]}`)
    expect(seq).toEqual([
      'POST https://booking-api.totalpass.com/partner/auth',
      'GET https://booking-api.totalpass.com/partner/plans',
      'PUT https://booking-api.totalpass.com/partner/places/update-configs',
      'POST https://booking-api.totalpass.com/partner/webhook/subscribe',
      'POST https://gym-service-api.totalpass.com/partner/auth',
      'GET https://gym-service-api.totalpass.com/partner/webhook/get',
      'POST https://gym-service-api.totalpass.com/partner/webhook/create',
    ])
    expect(JSON.parse(calls()[2][1].body)).toEqual({ hasSlotConfirmation: true })
    expect(JSON.parse(calls()[3][1].body)).toEqual({ webhook_url: 'https://api.avoqado.io/b' })
    expect(JSON.parse(calls()[6][1].body)).toEqual({ webhook_url: 'https://api.avoqado.io/c', webhook_type: 'CHECKIN' })
    expect(calls()[6][1].headers.Authorization).toBe('Bearer jwt-c')
  })
  // nuevo
  const setupHasta = () =>
    (fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-b' }))
      .mockResolvedValueOnce(json(200, { name: 'Estudio', identifier: 'uuid-place', Plans: [] }))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(json(201, { token: 'jwt-c' }))
  // nuevo — R14d
  it('setup: si el webhook de check-in ya existe (GET), lo actualiza con PUT y no intenta crearlo', async () => {
    setupHasta()
      .mockResolvedValueOnce(json(200, { webhooks: [{ webhook_url: 'https://viejo/c', webhook_type: 'CHECKIN' }] }))
      .mockResolvedValueOnce(json(200, { status: 'success' }))
    await expect(totalPassAdapter.setup(ctx, { booking: 'https://x/b', checkin: 'https://x/c' })).resolves.toMatchObject({
      ok: true,
      externalPlaceId: 'uuid-place',
    })
    const seq = calls().map(c => `${c[1].method} ${c[0]}`)
    expect(seq.slice(5)).toEqual([
      'GET https://gym-service-api.totalpass.com/partner/webhook/get',
      'PUT https://gym-service-api.totalpass.com/partner/webhook/update',
    ])
    expect(JSON.parse(calls()[6][1].body)).toEqual({ webhook_url: 'https://x/c', webhook_type: 'CHECKIN' })
  })
  // nuevo — R14d: el error es el de la llamada elegida, sin probar la otra
  it('setup: si falla el create o el update elegido, devuelve ESE error sin intentar la otra llamada', async () => {
    setupHasta()
      .mockResolvedValueOnce(json(200, { webhooks: [{ webhook_type: 'OTRO' }] }))
      .mockResolvedValueOnce(json(400, { message: ['webhook_url should not be empty'] }))
    await expect(totalPassAdapter.setup(ctx, { booking: 'https://x/b', checkin: 'https://x/c' })).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: 'HTTP_400',
    })
    expect(
      calls()
        .map(c => c[0])
        .filter((u: string) => u.endsWith('/webhook/update')),
    ).toHaveLength(0)

    __resetTotalPassTokens()
    ;(fetch as jest.Mock).mockReset()
    setupHasta()
      .mockResolvedValueOnce(json(200, { webhooks: [{ webhook_type: 'CHECKIN' }] }))
      .mockResolvedValueOnce(json(503, 'down'))
    await expect(totalPassAdapter.setup(ctx, { booking: 'https://x/b', checkin: 'https://x/c' })).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: 'HTTP_503',
    })
    expect(
      calls()
        .map(c => c[0])
        .filter((u: string) => u.endsWith('/webhook/create')),
    ).toHaveLength(0)
  })
  // nuevo — R14d: si no se puede leer el estado, no se adivina
  it('setup: si el GET del webhook de check-in falla, devuelve ese error y no crea ni actualiza', async () => {
    setupHasta().mockResolvedValueOnce(json(500, 'boom'))
    await expect(totalPassAdapter.setup(ctx, { booking: 'https://x/b', checkin: 'https://x/c' })).resolves.toMatchObject({
      ok: false,
      retryable: true,
      code: 'HTTP_500',
    })
    expect(calls()).toHaveLength(6)
  })
  // nuevo — Codex F3: identificar la sucursal de la llave sin tocar sus webhooks
  it('identify: sólo autentica y lee la sucursal; no toca webhooks ni configuración, ni devuelve la placeApiKey', async () => {
    ;(fetch as jest.Mock)
      .mockResolvedValueOnce(json(201, { token: 'jwt-b' }))
      .mockResolvedValueOnce(json(200, { name: 'Estudio', identifier: 'uuid-place', placeApiKey: 'place-key', Plans: [] }))
    const r = await totalPassAdapter.identify(ctx)
    expect(r).toEqual({ ok: true, externalPlaceId: 'uuid-place', externalPlaceName: 'Estudio' })
    expect(JSON.stringify(r)).not.toContain('place-key')
    expect(calls().map(c => `${c[1].method} ${c[0]}`)).toEqual([
      'POST https://booking-api.totalpass.com/partner/auth',
      'GET https://booking-api.totalpass.com/partner/plans',
    ])
  })
  // nuevo — Codex F3
  it('identify: llave rechazada ⇒ UNAUTHORIZED; sin identificador ⇒ NO_PLACE_ID', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(401, { message: 'Invalid credentials' }))
    await expect(totalPassAdapter.identify(ctx)).resolves.toMatchObject({ ok: false, retryable: false, code: 'UNAUTHORIZED' })
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(201, { token: 'jwt-b' })).mockResolvedValueOnce(json(200, { name: 'Sin id' }))
    await expect(totalPassAdapter.identify(ctx)).resolves.toMatchObject({ ok: false, retryable: false, code: 'NO_PLACE_ID' })
  })
  // nuevo
  it('setup con llaves inválidas ⇒ UNAUTHORIZED', async () => {
    ;(fetch as jest.Mock).mockResolvedValueOnce(json(401, { message: 'Invalid credentials' }))
    await expect(totalPassAdapter.setup(ctx, { booking: 'https://x/b', checkin: 'https://x/c' })).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: 'UNAUTHORIZED',
    })
  })
})
