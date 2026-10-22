/**
 * El horario de la TIENDA en el proveedor sigue al de Avoqado, por huella (Tarea 19).
 *
 * 🔴 Lo que no se puede romper: nunca se publica una semana toda cerrada (sin horario, el proveedor puede tomar la tienda como
 * abierta las 24 h), y la huella sólo se guarda cuando el proveedor aceptó TODO: un fallo a medias se reintenta en la siguiente
 * pasada, que vuelve a leer lo que el proveedor de verdad tiene.
 */
jest.mock('@/services/delivery-channels/core/deliveryHours.service', () => ({
  resolveDeliveryHours: jest.fn(),
}))

jest.mock('@/services/delivery-channels/core/adapterRegistry', () => ({
  hasAdapter: jest.fn(() => true),
  adapterFor: jest.fn(),
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'
import { resolveDeliveryHours, type HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import { _olvidarAvisosDeFallas, syncChannelHours } from '@/services/delivery-channels/core/hoursSync.service'

const mockedResolve = resolveDeliveryHours as jest.Mock
const mockedAdapterFor = adapterFor as jest.Mock
const mockedHasAdapter = hasAdapter as jest.Mock
const mockedQueryRaw = (prisma as any).$queryRaw as jest.Mock
const mockedUpdate = (prisma as any).deliveryChannelLink.update as jest.Mock
const mockedError = logger.error as jest.Mock
const mockedWarn = logger.warn as jest.Mock

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const CERRADO = { enabled: false, ranges: [] }

function semana(over: Partial<HorarioSemanal> = {}): HorarioSemanal {
  const base = {} as HorarioSemanal
  for (const d of DIAS) base[d] = d === 'sunday' ? CERRADO : { enabled: true, ranges: [{ open: '09:00', close: '22:00' }] }
  return { ...base, ...over }
}
function todoCerrado(): HorarioSemanal {
  const h = {} as HorarioSemanal
  for (const d of DIAS) h[d] = CERRADO
  return h
}

/** La FILA vigente en la base. `SELECT … FOR UPDATE` devuelve una COPIA, como Prisma. */
let fila: { config: Record<string, any>; lastMenuHash: string | null }
/** La copia del vínculo que trae una pasada del job (leída ANTES de sincronizar). */
const copia = (): any => ({
  id: 'link1',
  venueId: 'venue1',
  provider: 'RAPPI',
  externalLocationId: 'store1',
  status: 'ACTIVE',
  autoSyncMenu: true,
  lastMenuHash: fila.lastMenuHash,
  config: structuredClone(fila.config),
})

function conPublicador(publicar: jest.Mock = jest.fn(async () => ({ ok: true, status: 200, raw: '' }))) {
  mockedAdapterFor.mockReturnValue({ publishStoreHours: publicar })
  return publicar
}

describe('syncChannelHours — el horario de la tienda en el proveedor sigue al de Avoqado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    _olvidarAvisosDeFallas()
    mockedHasAdapter.mockReturnValue(true)
    mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'CANAL' })
    fila = { config: { menuEnRevision: { huella: 'm1', publicadaEn: '2026-10-22T08:00:00.000Z' } }, lastMenuHash: 'menu-viejo' }
    mockedQueryRaw.mockReset().mockImplementation(async () => [structuredClone(fila)])
    mockedUpdate.mockReset().mockImplementation(async ({ data }: any) => {
      if (data.config !== undefined) fila.config = structuredClone(data.config)
      return {}
    })
  })

  it('🔴 publica cuando cambió y guarda horarioPublicado = { huella, en } con la fila BLOQUEADA, sin pisar las llaves del menú', async () => {
    const publicar = conPublicador()
    const antes = Date.now()

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledWith(semana(), 'store1')
    expect(fila.config.horarioPublicado).toEqual({ huella: expect.stringMatching(/^[0-9a-f]{64}$/), en: expect.any(String) })
    expect(Date.parse(fila.config.horarioPublicado.en)).toBeGreaterThanOrEqual(antes)
    expect((mockedQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/)
    // Las llaves del menú siguen ahí: el parche sólo trae `horarioPublicado`.
    expect(fila.config.menuEnRevision).toEqual({ huella: 'm1', publicadaEn: '2026-10-22T08:00:00.000Z' })
  })

  it('🔴 sin cambios ⇒ UNCHANGED: ni red ni escritura', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia())
    mockedQueryRaw.mockClear()
    mockedUpdate.mockClear()

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1) // la primera, no la segunda
    expect(mockedQueryRaw).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('la huella no depende del orden de las franjas ni de lo que guarde un día cerrado (si no, republicaría sin motivo)', async () => {
    const dosTurnos = {
      enabled: true,
      ranges: [
        { open: '13:00', close: '17:00' },
        { open: '19:00', close: '23:00' },
      ],
    }
    mockedResolve.mockResolvedValue({ horario: semana({ monday: dosTurnos }), fuente: 'CANAL' })
    const publicar = conPublicador()
    await syncChannelHours(copia())

    mockedResolve.mockResolvedValue({
      horario: semana({
        monday: { enabled: true, ranges: [...dosTurnos.ranges].reverse() },
        sunday: { enabled: false, ranges: [{ open: '10:00', close: '12:00' }] },
      }),
      fuente: 'CANAL',
    })
    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('UNCHANGED')
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('un horario distinto ⇒ se publica otra vez (la huella cambia)', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia())
    const primera = fila.config.horarioPublicado.huella

    mockedResolve.mockResolvedValue({
      horario: semana({ monday: { enabled: true, ranges: [{ open: '09:00', close: '23:00' }] } }),
      fuente: 'CANAL',
    })
    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledTimes(2)
    expect(fila.config.horarioPublicado.huella).not.toBe(primera)
  })

  it('🔴 semana toda cerrada ⇒ no se publica nada (el proveedor lo tomaría como 24 h): 🚨 UNA vez y se conserva el último', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia())
    const publicado = structuredClone(fila.config.horarioPublicado)
    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    mockedError.mockClear()

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('SKIPPED_EMPTY')
    expect(publicar).toHaveBeenCalledTimes(1) // sólo la publicación de antes
    expect(mockedError).toHaveBeenCalledTimes(1)
    expect(mockedError.mock.calls[0][0]).toMatch(/🚨/)
    // El último publicado se conserva (la huella no se toca): al reabrir, se compara contra él.
    expect(fila.config.horarioPublicado).toMatchObject({ huella: publicado.huella, en: publicado.en })

    // La siguiente pasada, igual de cerrada: no se vuelve a gritar.
    const r2 = await syncChannelHours(copia())
    expect(r2.outcome).toBe('SKIPPED_EMPTY')
    expect(mockedError).toHaveBeenCalledTimes(1)
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('al reabrir tras una semana cerrada, se publica y el aviso se rearma', async () => {
    const publicar = conPublicador()
    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    await syncChannelHours(copia())
    expect(fila.config.horarioPublicado).toEqual({ vacioAvisadoEn: expect.any(String) })

    mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'CANAL' })
    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledTimes(1)
    expect(fila.config.horarioPublicado).toEqual({ huella: expect.any(String), en: expect.any(String) })
  })

  it('🔴 un fallo deja la huella vieja (se reintenta en la siguiente pasada)', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia())
    const vieja = structuredClone(fila.config.horarioPublicado)
    mockedResolve.mockResolvedValue({
      horario: semana({ saturday: { enabled: true, ranges: [{ open: '10:00', close: '23:00' }] } }),
      fuente: 'CANAL',
    })

    publicar.mockResolvedValueOnce({ ok: false, status: 400, raw: 'CREAR sat: overlapping' })
    const r = await syncChannelHours(copia())
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'HTTP 400' })
    expect(fila.config.horarioPublicado).toEqual(vieja)

    publicar.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
    const r2 = await syncChannelHours(copia())
    expect(r2).toMatchObject({ outcome: 'FAILED', error: expect.stringMatching(/timeout/) })
    expect(fila.config.horarioPublicado).toEqual(vieja)

    // La tercera pasada lo vuelve a intentar (no se quedó «publicado» por error) y ahora sí sale.
    const r3 = await syncChannelHours(copia())
    expect(r3.outcome).toBe('PUBLISHED')
    expect(publicar).toHaveBeenCalledTimes(4)
    expect(fila.config.horarioPublicado.huella).not.toBe(vieja.huella)
  })

  it('una escritura que NO salió (el candado) ⇒ FAILED con aviso de «no salió», sin 🚨', async () => {
    conPublicador(jest.fn().mockRejectedValue(new DeliveryWriteNotSentError('STORE_NOT_AUTHORIZED', 'tienda fuera de la lista')))

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('FAILED')
    expect(fila.config.horarioPublicado).toBeUndefined()
    expect(mockedWarn).toHaveBeenCalledWith(expect.stringMatching(/NO salió/), expect.objectContaining({ reason: 'STORE_NOT_AUTHORIZED' }))
    expect(mockedError).not.toHaveBeenCalled()
  })

  it('si resolver el horario truena ⇒ FAILED, no lanza (el job sigue con los demás canales)', async () => {
    conPublicador()
    mockedResolve.mockRejectedValue(new Error('P1001'))

    await expect(syncChannelHours(copia())).resolves.toMatchObject({ outcome: 'FAILED', error: 'P1001' })
  })

  // ── Ronda de arreglo 1 ───────────────────────────────────────────────────────────────────
  it('🔴 resuelve el horario SIN avisar: el 🚨 del estimado ya lo da el menú en la misma pasada (uno solo por pasada)', async () => {
    conPublicador()

    await syncChannelHours(copia())

    expect(mockedResolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'link1' }), { avisar: false })
  })

  it('🔴 sin horario configurado ⇒ SKIPPED_ESTIMATED y ninguna llamada al proveedor (nunca se pisa su portal con una suposición)', async () => {
    const publicar = conPublicador()
    mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'ESTIMADO' })

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('SKIPPED_ESTIMATED')
    expect(publicar).not.toHaveBeenCalled()
    expect(mockedQueryRaw).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(fila.config.horarioPublicado).toBeUndefined()
    expect(mockedError).not.toHaveBeenCalled()
    expect(mockedWarn).not.toHaveBeenCalled()
  })

  it('🔴 tenía un horario publicado y el dueño borró su configuración ⇒ no se toca al proveedor ni la huella', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia())
    const publicado = structuredClone(fila.config.horarioPublicado)
    mockedQueryRaw.mockClear()
    mockedUpdate.mockClear()
    mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'ESTIMADO' })

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('SKIPPED_ESTIMATED')
    expect(publicar).toHaveBeenCalledTimes(1) // sólo la de antes
    expect(fila.config.horarioPublicado).toEqual(publicado)
    expect(mockedQueryRaw).not.toHaveBeenCalled()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it.each([
    [
      'se enciman',
      [
        { open: '09:00', close: '14:00' },
        { open: '13:00', close: '18:00' },
      ],
    ],
    [
      'sólo se tocan',
      [
        { open: '09:00', close: '14:00' },
        { open: '14:00', close: '18:00' },
      ],
    ],
    [
      'una adentro de otra',
      [
        { open: '09:00', close: '18:00' },
        { open: '10:00', close: '12:00' },
      ],
    ],
  ])('🔴 turnos del dueño que %s se FUSIONAN: misma huella que una sola franja 09–18, y se publica ya fusionado', async (_caso, ranges) => {
    const publicar = conPublicador()
    mockedResolve.mockResolvedValue({
      horario: semana({ monday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } }),
      fuente: 'CANAL',
    })
    await syncChannelHours(copia())
    const unaSola = fila.config.horarioPublicado.huella

    // La misma semana capturada con los dos turnos: misma huella ⇒ nada que publicar.
    mockedResolve.mockResolvedValue({ horario: semana({ monday: { enabled: true, ranges } }), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('UNCHANGED')

    // Y si es la primera vez, lo que llega al adaptador ya viene fusionado (nunca un FAILED por turnos encimados).
    fila.config = {}
    const r = await syncChannelHours(copia())
    expect(r.outcome).toBe('PUBLISHED')
    expect(fila.config.horarioPublicado.huella).toBe(unaSola)
    expect(publicar).toHaveBeenLastCalledWith(semana({ monday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } }), 'store1')
  })

  // ── Ronda de arreglo 2 ───────────────────────────────────────────────────────────────────
  const avisosDeSemanaCerrada = () =>
    mockedError.mock.calls.filter(([m]) => /🚨/.test(String(m)) && /TODOS los días cerrados/.test(String(m)))

  it('🔴 cerrar → reabrir IGUAL → cerrar ⇒ 🚨 dos veces (las vacaciones de nuevo no pasan en silencio)', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia()) // publica H1
    const h1 = fila.config.horarioPublicado.huella

    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('SKIPPED_EMPTY')

    // Reabre con el MISMO horario: no hay nada que publicar, pero el aviso se rearma (la fila queda con { huella, en }).
    mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('UNCHANGED')
    expect(fila.config.horarioPublicado).toEqual({ huella: h1, en: expect.any(String) })

    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('SKIPPED_EMPTY')

    expect(avisosDeSemanaCerrada()).toHaveLength(2)
    expect(publicar).toHaveBeenCalledTimes(1)
  })

  it('🔴 cerrar → reabrir con OTRO horario que no se logra publicar → cerrar ⇒ 🚨 dos veces (el aviso se rearma en cuanto algún día abre)', async () => {
    const publicar = conPublicador()
    await syncChannelHours(copia()) // publica H1
    const h1 = structuredClone(fila.config.horarioPublicado)

    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('SKIPPED_EMPTY')
    expect(avisosDeSemanaCerrada()).toHaveLength(1)
    expect(fila.config.horarioPublicado).toEqual({ ...h1, vacioAvisadoEn: expect.any(String) })

    // Reabre con OTRO horario y el proveedor lo rechaza de forma persistente: ni UNCHANGED ni PUBLISHED.
    publicar.mockResolvedValue({ ok: false, status: 400, raw: 'rechazado' })
    mockedResolve.mockResolvedValue({
      horario: semana({ monday: { enabled: true, ranges: [{ open: '10:00', close: '20:00' }] } }),
      fuente: 'CANAL',
    })
    expect((await syncChannelHours(copia())).outcome).toBe('FAILED')
    // El aviso ya se rearmó (sin esperar a publicar), conservando la última huella publicada y las llaves del menú.
    expect(fila.config.horarioPublicado).toEqual(h1)
    expect(fila.config.menuEnRevision).toEqual({ huella: 'm1', publicadaEn: '2026-10-22T08:00:00.000Z' })

    // Vuelve a cerrar todo: la segunda semana cerrada SÍ grita.
    mockedResolve.mockResolvedValue({ horario: todoCerrado(), fuente: 'CANAL' })
    expect((await syncChannelHours(copia())).outcome).toBe('SKIPPED_EMPTY')

    expect(avisosDeSemanaCerrada()).toHaveLength(2)
    expect(fila.config.menuEnRevision).toEqual({ huella: 'm1', publicadaEn: '2026-10-22T08:00:00.000Z' })
  })

  it('UNCHANGED sin aviso pendiente no toca la base (el rearme sólo escribe cuando hay marca)', async () => {
    conPublicador()
    await syncChannelHours(copia())
    mockedQueryRaw.mockClear()

    expect((await syncChannelHours(copia())).outcome).toBe('UNCHANGED')
    expect(mockedQueryRaw).not.toHaveBeenCalled()
  })

  describe('una falla que se repite no grita en cada pasada (🚨 la primera vez por vínculo y horario; 6 h)', () => {
    const gritos = () => mockedError.mock.calls.filter(([m]) => /🚨/.test(String(m)) && /HoursSync/.test(String(m)))
    const repetidos = () => mockedWarn.mock.calls.filter(([m]) => /HoursSync/.test(String(m)) && /ya se avisó/.test(String(m)))

    it.each([
      [
        'el proveedor rechaza el mismo paso',
        () => jest.fn(async () => ({ ok: false, status: 400, raw: 'paso 1 de 1 (CREAR mon) rechazado' })),
      ],
      [
        'el login de Utils no está habilitado (lanza)',
        () => jest.fn().mockRejectedValue(new Error('[Rappi] login de utils respondió 401')),
      ],
    ])('🔴 %s: dos pasadas seguidas con la misma huella ⇒ un 🚨 y un warn', async (_caso, publicador) => {
      conPublicador(publicador())

      expect((await syncChannelHours(copia())).outcome).toBe('FAILED')
      expect((await syncChannelHours(copia())).outcome).toBe('FAILED')

      expect(gritos()).toHaveLength(1)
      expect(repetidos()).toHaveLength(1)
      expect(String(repetidos()[0][0])).not.toMatch(/🚨/)
    })

    it('otra huella (el dueño cambió el horario) sí vuelve a gritar, y pasadas 6 h también', async () => {
      conPublicador(jest.fn(async () => ({ ok: false, status: 400, raw: 'no' })))
      const ahora = Date.now()
      const reloj = jest.spyOn(Date, 'now').mockReturnValue(ahora)
      try {
        await syncChannelHours(copia())
        mockedResolve.mockResolvedValue({
          horario: semana({ monday: { enabled: true, ranges: [{ open: '10:00', close: '20:00' }] } }),
          fuente: 'CANAL',
        })
        await syncChannelHours(copia())
        expect(gritos()).toHaveLength(2)

        await syncChannelHours(copia()) // misma huella, dentro de las 6 h
        expect(gritos()).toHaveLength(2)

        reloj.mockReturnValue(ahora + 6 * 60 * 60 * 1000 + 1)
        await syncChannelHours(copia())
      } finally {
        // En `finally`: una aserción fallida no deja el reloj puesto para las pruebas que siguen.
        reloj.mockRestore()
      }
      expect(gritos()).toHaveLength(3)
    })

    it('al publicar con éxito se olvida: si después vuelve a fallar ese horario, grita de nuevo', async () => {
      const publicar = conPublicador(jest.fn(async () => ({ ok: false, status: 400, raw: 'no' })))
      await syncChannelHours(copia())
      publicar.mockResolvedValueOnce({ ok: true, status: 200, raw: '' })
      expect((await syncChannelHours(copia())).outcome).toBe('PUBLISHED')

      // Otro horario que falla, y luego el mismo de antes otra vez (el dueño lo regresó): grita las dos.
      mockedResolve.mockResolvedValue({ horario: semana({ friday: CERRADO }), fuente: 'CANAL' })
      await syncChannelHours(copia())
      fila.config = {}
      mockedResolve.mockResolvedValue({ horario: semana(), fuente: 'CANAL' })
      await syncChannelHours(copia())

      expect(gritos()).toHaveLength(3)
    })
  })

  it('un proveedor sin `publishStoreHours` ⇒ NO_PUBLISHER, en silencio (ni aviso por pasada)', async () => {
    mockedAdapterFor.mockReturnValue({ publishMenu: jest.fn() })

    const r = await syncChannelHours(copia())

    expect(r.outcome).toBe('NO_PUBLISHER')
    expect(mockedResolve).not.toHaveBeenCalled()
    expect(mockedWarn).not.toHaveBeenCalled()
    expect(mockedError).not.toHaveBeenCalled()
  })

  it('un proveedor sin adaptador ⇒ NO_PUBLISHER, en silencio', async () => {
    mockedHasAdapter.mockReturnValue(false)

    const r = await syncChannelHours({ ...copia(), provider: 'DELIVERECT' })

    expect(r.outcome).toBe('NO_PUBLISHER')
    expect(mockedAdapterFor).not.toHaveBeenCalled()
    expect(mockedWarn).not.toHaveBeenCalled()
  })
})
