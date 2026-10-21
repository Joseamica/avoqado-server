// tests/unit/services/customer-display/customerDisplayMobile.test.ts
import { STORAGE_ORIGINS } from '@/services/customer-display/storageOrigins'
import { prismaMock } from '@tests/__helpers__/setup'
import {
  ACK_CAS_MAX_INTENTOS,
  CLIENT_CLOCK_TOLERANCE_MS,
  acknowledgeCustomerDisplay,
  acotarHoraDelCliente,
  armarAcuse,
} from '@/services/customer-display/customerDisplayMobile.service'
import { customerDisplayAckSchema } from '@/schemas/mobile/customerDisplay.mobile.schema'
import { enLaTablet } from '@/services/customer-display/customerDisplayAckView'

const RECIBIDO = new Date('2026-09-25T18:00:00.000Z')

describe('acotarHoraDelCliente — las horas de la tablet, acotadas contra la del servidor', () => {
  it('una hora razonable se conserva, normalizada', () => {
    expect(acotarHoraDelCliente('2026-09-25T17:59:00-00:00', RECIBIDO)).toEqual({ valor: '2026-09-25T17:59:00.000Z', adelantada: false })
  })
  it(`más de ${CLIENT_CLOCK_TOLERANCE_MS / 60_000} min POR DELANTE: se guarda la del servidor y se marca`, () => {
    expect(acotarHoraDelCliente('2026-09-25T18:05:00.001Z', RECIBIDO)).toEqual({ valor: RECIBIDO.toISOString(), adelantada: true })
  })
  it('exactamente en el límite todavía vale', () => {
    expect(acotarHoraDelCliente('2026-09-25T18:05:00.000Z', RECIBIDO).adelantada).toBe(false)
  })
  it('una hora vieja se conserva (atrasada no es mentira: pudo guardarse sin red)', () => {
    expect(acotarHoraDelCliente('2026-09-20T00:00:00.000Z', RECIBIDO).adelantada).toBe(false)
  })
  it('null sigue siendo null («guardado, aún no mostrado»)', () => {
    expect(acotarHoraDelCliente(null, RECIBIDO)).toEqual({ valor: null, adelantada: false })
  })
  // Defensa en profundidad: `Date.parse(undefined)` es NaN, y sin esta guarda salía la hora del servidor con `adelantada`
  // ⇒ un diseño que NO se mostró quedaba «mostrado».
  it('undefined (un campo omitido que llegara sin normalizar) vale lo mismo que null, no la hora del servidor', () => {
    expect(acotarHoraDelCliente(undefined, RECIBIDO)).toEqual({ valor: null, adelantada: false })
  })
})

describe('armarAcuse', () => {
  it('lleva la hora de llegada del SERVIDOR y marca el reloj adelantado si CUALQUIERA de las dos lo estaba', () => {
    const a = armarAcuse(
      {
        installationId: 'i',
        fingerprint: 'f'.repeat(32),
        seq: 3,
        storedAt: '2026-09-25T17:00:00.000Z',
        shownAt: '2026-09-25T19:00:00.000Z',
        surface: 'presentation',
        imagesReady: 2,
        imagesPending: 1,
        imagesFailed: 0,
        unsupportedSchema: false,
      },
      RECIBIDO,
    )
    expect(a).toMatchObject({
      receivedAt: RECIBIDO.toISOString(),
      storedAt: '2026-09-25T17:00:00.000Z',
      shownAt: RECIBIDO.toISOString(),
      clientClockSkew: true,
      seq: 3,
    })
    expect(a).not.toHaveProperty('installationId') // la instalación vive en su columna, no en el ack
  })
})

describe('customerDisplayAckSchema', () => {
  const valido = {
    installationId: 'f1e2d3c4-0000-4000-8000-000000000001',
    fingerprint: 'a'.repeat(32),
    seq: 1,
    storedAt: '2026-09-25T17:00:00.000Z',
    shownAt: null,
    surface: null,
    imagesReady: 0,
    imagesPending: 0,
    imagesFailed: 0,
    unsupportedSchema: false,
  }
  const parse = (body: unknown) => customerDisplayAckSchema.safeParse({ body, params: { venueId: 'v' } })

  it('el cuerpo completo es válido', () => expect(parse(valido).success).toBe(true))
  it.each([
    [{ fingerprint: 'XYZ' }],
    [{ seq: -1 }],
    [{ seq: 1.5 }],
    [{ storedAt: 'ayer' }],
    [{ surface: 'tele' }],
    [{ imagesReady: 101 }],
    [{ extra: true }],
  ])('rechaza %j', extra => {
    const r = parse({ ...valido, ...extra })
    expect(r.success).toBe(false)
  })

  // F0-B, ronda final (M1): el 400 se le muestra tal cual a quien depura la tablet; nada de «Expected string, received number»
  // ni «Unrecognized key(s)». `.strict()` se queda: una app que sume un campo recibe este 400 hasta que el servidor lo conozca.
  it.each([
    ['un campo con el tipo equivocado', { installationId: 123 }, ['La instalación debe ser texto']],
    ['un cuerpo que no es objeto', null, ['El acuse debe ser un objeto']],
    ['una llave que el servidor no conoce', { extra: true }, ['El acuse trae campos que el servidor no conoce: extra']],
    // El mapa del objeto sólo cubre lo del objeto: el mensaje de cada campo sigue siendo el suyo.
    ['un campo que falta', { installationId: undefined }, ['Falta la instalación']],
  ])('%s: el 400 sale en español', (_caso, cambio, mensajes) => {
    const r = parse(cambio === null ? null : { ...valido, ...cambio })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.errors.map(e => e.message)).toEqual(mensajes)
  })

  it('acepta la ventana de Windows como superficie (R1)', () => {
    expect(parse({ ...valido, surface: 'window', shownAt: '2026-09-25T17:00:00.000Z' }).success).toBe(true)
  })

  // «Vacío» = omitido O null: la app puede serializar con encodeDefaults=false (omite) o true (manda null). Un omitido que
  // diera 400 dejaría el panel en «Sin acuse» para siempre.
  it('shownAt y surface OMITIDOS (encodeDefaults=false): válido, y al servicio le llegan en null, nunca undefined', () => {
    const sinVacios: Record<string, unknown> = { ...valido }
    delete sinVacios.shownAt
    delete sinVacios.surface
    const r = parse(sinVacios)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.body.shownAt).toBeNull()
      expect(r.data.body.surface).toBeNull()
    }
  })

  it('🔴 un shownAt OMITIDO es «guardado, aún no mostrado», no «mostrado» con la hora del servidor', () => {
    const sinShownAt: Record<string, unknown> = { ...valido, surface: 'presentation' }
    delete sinShownAt.shownAt
    const r = parse(sinShownAt)
    expect(r.success).toBe(true)
    if (!r.success) return
    const acuse = armarAcuse(r.data.body, RECIBIDO)
    expect(acuse).toMatchObject({ shownAt: null, clientClockSkew: false, storedAt: '2026-09-25T17:00:00.000Z' })
    expect(enLaTablet(acuse, valido.fingerprint, 1).estado).toBe('GUARDADO')
  })
})

it('los orígenes de imagen que se le dan a la tablet son EXACTAMENTE los dos que reconoce el servidor', () => {
  expect(STORAGE_ORIGINS).toEqual(['https://storage.googleapis.com', 'https://firebasestorage.googleapis.com'])
})

// 🔴 Codex r2 N1, su secuencia: llega seq 100 y, antes de cada una de sus tres escrituras, gana un acuse MÁS VIEJO (1, 2 y 3).
it('🔴 perder los tres CAS NO es STALE_SEQ: 503 reintentable, y el ack más nuevo no se cierra', async () => {
  const guardadoCon = (seq: number) =>
    JSON.stringify(
      armarAcuse(
        {
          installationId: 'i',
          fingerprint: 'a'.repeat(32),
          seq,
          storedAt: '2026-09-25T17:00:00.000Z',
          shownAt: null,
          surface: null,
          imagesReady: 0,
          imagesPending: 0,
          imagesFailed: 0,
          unsupportedSchema: false,
        },
        RECIBIDO,
      ),
    )
  const fila = (ack: string | null) => [{ id: 't1', instalacion: 'i', ack }]
  prismaMock.$queryRaw
    .mockResolvedValueOnce(fila(null) as any) // lee «sin acuse»… y gana el seq 1
    .mockResolvedValueOnce(fila(guardadoCon(1)) as any) // lee el 1… y gana el 2
    .mockResolvedValueOnce(fila(guardadoCon(2)) as any) // lee el 2… y gana el 3
  prismaMock.$executeRaw.mockResolvedValue(0 as any) // los tres CAS pierden
  const cien = {
    installationId: 'i',
    fingerprint: 'b'.repeat(32),
    seq: 100,
    storedAt: '2026-09-25T17:00:00.000Z',
    shownAt: null,
    surface: null,
    imagesReady: 0,
    imagesPending: 0,
    imagesFailed: 0,
    unsupportedSchema: false,
  } as const
  await expect(acknowledgeCustomerDisplay('v', 'd', cien, RECIBIDO)).rejects.toMatchObject({
    statusCode: 503,
    code: 'CUSTOMER_DISPLAY_ACK_BUSY',
  })
  expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(ACK_CAS_MAX_INTENTOS)
})
