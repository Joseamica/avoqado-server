/**
 * El medidor del cupo de Resend (promesa `docs/audit/2026-11-03-cupo-de-resend/promesa.md`). Resend dice en cada respuesta
 * cuántos correos lleva la cuenta en el día y en el mes; aquí se simula ese `fetch` (no sale nada a la red) y se mira cuándo
 * se avisa, cuándo se pausan las campañas y que el medidor nunca le rompa un correo a nadie (login, recibos).
 *
 * Cada `cargar()` es un PROCESO nuevo (el módulo con su memoria vacía, como tras un reinicio); la fila del aviso es una sola
 * para todos, como en Postgres: se lee antes de avisar y se anota DESPUÉS del log y del correo.
 *
 * 🔴 El día es el de Resend, UTC: su cupo diario se reinicia a la medianoche UTC, las 18:00 de Ciudad de México.
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
const mockSendEmail = jest.fn()
jest.mock('@/config/logger', () => ({ __esModule: true, default: mockLogger }))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmail: (...args: unknown[]) => mockSendEmail(...args) },
}))

type Medidor = typeof import('@/services/email/resendQuota')

const RESEND = 'https://api.resend.com/emails'
/** 3-nov-2026, 12:00 en Ciudad de México. */
const HOY = new Date('2026-11-03T18:00:00.000Z')
const MANANA = new Date('2026-11-04T18:00:00.000Z')
const OTRO_MES = new Date('2026-12-01T18:00:00.000Z')

const falsa = jest.fn()
const FETCH_ORIGINAL = globalThis.fetch
const ENV = { ...process.env }

/** La fila `EmailQuotaAlert` compartida por todos los procesos. */
let fila: Record<string, string | null> | null

/** Un proceso nuevo: memoria vacía, con el medidor instalado sobre el `fetch` falso. Devuelve su módulo y su `fetch`. */
function cargar(): Medidor & { fetch: typeof fetch } {
  globalThis.fetch = falsa as unknown as typeof fetch
  let mod!: Medidor
  jest.isolateModules(() => {
    mod = require('@/services/email/resendQuota')
  })
  mod.instalarMedidorDeCupoResend()
  return { ...mod, fetch: globalThis.fetch }
}

const respuesta = (status: number, cabeceras: Record<string, string> = {}, cuerpo: unknown = { id: 're_1' }) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...cabeceras } })
const conCupo = (diario: number | null, mensual: number | null = 10, status = 200) =>
  respuesta(status, {
    ...(diario === null ? {} : { 'x-resend-daily-quota': String(diario) }),
    ...(mensual === null ? {} : { 'x-resend-monthly-quota': String(mensual) }),
  })
const agotado = (name: string) =>
  respuesta(429, { 'x-resend-daily-quota': '100', 'x-resend-monthly-quota': '900' }, { statusCode: 429, name, message: 'quota' })

/** Los avisos salen sin esperar al correo que los disparó: se deja correr la cola. */
const asentar = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}
/** Un correo por el `fetch` dado, con la respuesta dada. */
const mandar = async (f: typeof fetch, r: Response, url = RESEND) => {
  falsa.mockResolvedValueOnce(r)
  const res = await f(url, { method: 'POST' })
  await asentar()
  return res
}
const avisos = () => mockLogger.error.mock.calls.filter(([m]) => String(m).startsWith('[Resend]'))

beforeEach(() => {
  jest.useFakeTimers({ now: HOY, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  falsa.mockReset()
  mockSendEmail.mockReset().mockResolvedValue(true)
  for (const fn of Object.values(mockLogger)) fn.mockReset()
  fila = null
  prismaMock.emailQuotaAlert.findUnique.mockReset().mockImplementation(async () => fila)
  prismaMock.emailQuotaAlert.upsert.mockReset().mockImplementation(async ({ update }: { update: Record<string, string> }) => {
    fila = { dailyAlertDay: null, monthlyAlertMonth: null, exhaustedAlertDay: null, ...fila, ...update }
    return fila
  })
  process.env.CRM_CORREO_PRUEBAS = 'jose@avoqado.io'
  delete process.env.RESEND_DAILY_QUOTA
  delete process.env.RESEND_MONTHLY_QUOTA
})

afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = FETCH_ORIGINAL
  process.env = { ...ENV }
})

describe('el aviso del día', () => {
  it('79 → 80 → 81 en el día da UN aviso (log con los números y un correo a jose@avoqado.io) y pausa desde el 80', async () => {
    const p = cargar()

    await mandar(p.fetch, conCupo(79))
    expect(avisos()).toHaveLength(0)
    expect(p.campanasPausadasPorCupo()).toBe(false)

    await mandar(p.fetch, conCupo(80))
    await mandar(p.fetch, conCupo(81))

    expect(avisos()).toHaveLength(1)
    // El número del momento va en el log; el correo dice el umbral, igual para la misma llave.
    expect(avisos()[0][1]).toMatchObject({ usado: 80, cuota: 100 })
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'jose@avoqado.io', subject: expect.stringContaining('80 de 100') }),
    )
    expect(p.campanasPausadasPorCupo()).toBe(true)
    // El correo lleva una llave por aviso: si sale dos veces (dos procesos, o un reinicio antes de anotarlo), Resend lo manda una.
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cupo-resend-diario-2026-11-03' }))
    // 🔴 Se anota DESPUÉS del log y del correo: si el proceso muere antes de anotarlo, el siguiente lo vuelve a intentar.
    expect(fila?.dailyAlertDay).toBe('2026-11-03')
    const anotado = prismaMock.emailQuotaAlert.upsert.mock.invocationCallOrder[0]
    expect(mockLogger.error.mock.invocationCallOrder[0]).toBeLessThan(anotado)
    expect(mockSendEmail.mock.invocationCallOrder[0]).toBeLessThan(anotado)
  })

  it('la pausa dura hasta las 18:00 de CDMX (medianoche UTC, cuando Resend reinicia el día), no hasta la medianoche de CDMX', async () => {
    // 3-nov a las 19:00 en CDMX: para Resend ya es el 4-nov.
    jest.setSystemTime(new Date('2026-11-04T01:00:00.000Z'))
    const p = cargar()
    await mandar(p.fetch, conCupo(85))

    expect(fila?.dailyAlertDay).toBe('2026-11-04')
    // La medianoche de CDMX no cambia el día de Resend: con el cupo todavía ocupado, las campañas siguen pausadas.
    expect(p.campanasPausadasPorCupo(new Date('2026-11-04T06:00:00.000Z'))).toBe(true)
    expect(p.campanasPausadasPorCupo(new Date('2026-11-04T23:59:59.999Z'))).toBe(true)
    expect(p.campanasPausadasPorCupo(new Date('2026-11-05T00:00:00.000Z'))).toBe(false)
    expect(p.reinicioDelCupoDiario(new Date('2026-11-04T01:00:00.000Z'))).toEqual(new Date('2026-11-05T00:00:00.000Z'))
  })

  it('una respuesta que Resend fechó ayer y llega después de medianoche no pausa el día nuevo (se cuenta en su día)', async () => {
    // 4-nov 00:00:01 UTC en el servidor; Resend la generó a las 23:59:59 del 3-nov, con 80 en ese día.
    jest.setSystemTime(new Date('2026-11-04T00:00:01.000Z'))
    const p = cargar()
    await mandar(p.fetch, respuesta(200, { 'x-resend-daily-quota': '80', date: 'Tue, 03 Nov 2026 23:59:59 GMT' }))
    expect(p.campanasPausadasPorCupo()).toBe(false)
    expect(fila?.dailyAlertDay).toBe('2026-11-03')

    // Ya del día nuevo, con 1: el 80 de ayer no se le suma.
    await mandar(p.fetch, respuesta(200, { 'x-resend-daily-quota': '1', date: 'Wed, 04 Nov 2026 00:00:02 GMT' }))
    expect(p.campanasPausadasPorCupo()).toBe(false)

    // Y una de ayer que llega todavía más tarde no tumba lo que ya se vio hoy.
    await mandar(p.fetch, respuesta(200, { 'x-resend-daily-quota': '99', date: 'Tue, 03 Nov 2026 23:59:58 GMT' }))
    expect(p.campanasPausadasPorCupo()).toBe(false)
  })

  it('con el reloj de aquí atrasado unos segundos, la lectura de Resend del día nuevo SÍ pausa (un solo reloj: el de Resend)', async () => {
    // Aquí son las 23:59:50 del 3-nov; Resend ya va en el 4-nov y dice 80.
    jest.setSystemTime(new Date('2026-11-03T23:59:50.000Z'))
    const p = cargar()
    await mandar(p.fetch, respuesta(200, { 'x-resend-daily-quota': '80', date: 'Wed, 04 Nov 2026 00:00:20 GMT' }))
    expect(p.campanasPausadasPorCupo()).toBe(true)
    expect(p.campanasPausadasPorCupo(new Date('2026-11-04T23:59:59.999Z'))).toBe(true)
    expect(p.campanasPausadasPorCupo(new Date('2026-11-05T00:00:00.000Z'))).toBe(false)
  })

  it('con el reloj de aquí atrasado, un 429 de cupo del día nuevo tampoco intenta el correo del aviso', async () => {
    jest.setSystemTime(new Date('2026-11-03T23:59:50.000Z'))
    const p = cargar()
    await mandar(
      p.fetch,
      respuesta(429, { 'x-resend-daily-quota': '100', date: 'Wed, 04 Nov 2026 00:00:20 GMT' }, { name: 'daily_quota_exceeded' }),
    )
    expect(p.campanasPausadasPorCupo()).toBe(true)
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(fila?.exhaustedAlertDay).toBe('2026-11-04')
  })

  it('finDeLaPausaPorCupo da el instante que vio el medidor (reloj de Resend); sin haber visto nada, la medianoche UTC de aquí', async () => {
    jest.setSystemTime(new Date('2026-11-04T00:00:17.000Z'))
    const p = cargar()
    expect(p.finDeLaPausaPorCupo(new Date())).toEqual(new Date('2026-11-05T00:00:00.000Z'))
    // Para Resend todavía es el 3-nov y el cupo se agotó: su reinicio es el 4-nov 00:00, ya pasado aquí (se prueba en el próximo tic).
    await mandar(
      p.fetch,
      respuesta(429, { 'x-resend-daily-quota': '100', date: 'Tue, 03 Nov 2026 23:59:57 GMT' }, { name: 'daily_quota_exceeded' }),
    )
    expect(p.finDeLaPausaPorCupo(new Date())).toEqual(new Date('2026-11-04T00:00:00.000Z'))
  })

  it('otro día vuelve a avisar; la pausa de ayer no pasa a hoy', async () => {
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    expect(p.campanasPausadasPorCupo()).toBe(true)

    jest.setSystemTime(MANANA)
    expect(p.campanasPausadasPorCupo()).toBe(false)
    await mandar(p.fetch, conCupo(80))

    expect(avisos()).toHaveLength(2)
    expect(fila?.dailyAlertDay).toBe('2026-11-04')
    expect(p.campanasPausadasPorCupo()).toBe(true)
  })

  it('una lectura menor en el mismo día no quita la pausa (ya se vio el 80)', async () => {
    const p = cargar()
    await mandar(p.fetch, conCupo(85))
    await mandar(p.fetch, conCupo(3))
    expect(p.campanasPausadasPorCupo()).toBe(true)
  })

  it('RESEND_DAILY_QUOTA cambia el umbral (1,000 → 800); uno mal escrito vale 100 y no tumba nada', async () => {
    process.env.RESEND_DAILY_QUOTA = '1000'
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    expect(p.campanasPausadasPorCupo()).toBe(false)
    await mandar(p.fetch, conCupo(800))
    expect(p.campanasPausadasPorCupo()).toBe(true)

    process.env.RESEND_DAILY_QUOTA = 'mil'
    const q = cargar()
    await mandar(q.fetch, conCupo(80))
    expect(q.campanasPausadasPorCupo()).toBe(true)
  })
})

describe('el aviso del mes', () => {
  it('2,399 → 2,400 en el mes da UN aviso, y no pausa las campañas (sólo el día las pausa)', async () => {
    const p = cargar()
    await mandar(p.fetch, conCupo(10, 2399))
    expect(avisos()).toHaveLength(0)

    await mandar(p.fetch, conCupo(11, 2400))
    await mandar(p.fetch, conCupo(12, 2401))

    expect(avisos()).toHaveLength(1)
    expect(avisos()[0][0]).toContain('2400 de 3000')
    expect(fila?.monthlyAlertMonth).toBe('2026-11')
    expect(p.campanasPausadasPorCupo()).toBe(false)
  })
})

describe('el 429 de cupo agotado', () => {
  it('daily_quota_exceeded avisa en el acto y pausa; la respuesta llega intacta (el SDK todavía lee su cuerpo)', async () => {
    const p = cargar()
    const res = await mandar(p.fetch, agotado('daily_quota_exceeded'))

    expect(res.status).toBe(429)
    await expect(res.json()).resolves.toMatchObject({ name: 'daily_quota_exceeded' })
    expect(p.campanasPausadasPorCupo()).toBe(true)
    expect(avisos().some(([m]) => String(m).includes('se acabó el cupo del día'))).toBe(true)
    // Con el cupo agotado el correo del aviso no puede salir: queda el log (Better Stack) y se anota sin intentarlo.
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(fila?.exhaustedAlertDay).toBe('2026-11-03')
    expect(fila?.dailyAlertDay).toBe('2026-11-03')
  })

  it('monthly_quota_exceeded pausa hasta que Resend reinicia el día y entonces se vuelve a probar (no publica cuándo reinicia el mes)', async () => {
    const p = cargar()
    await mandar(p.fetch, agotado('monthly_quota_exceeded'))
    expect(p.campanasPausadasPorCupo()).toBe(true)
    expect(p.campanasPausadasPorCupo(new Date('2026-11-03T23:59:59.999Z'))).toBe(true)
    // Al día siguiente sale UN correo de prueba: si Resend vuelve a decir 429, se pausa otra vez.
    expect(p.campanasPausadasPorCupo(MANANA)).toBe(false)
    expect(p.campanasPausadasPorCupo(OTRO_MES)).toBe(false)
  })

  it('el 429 de RITMO (rate_limit_exceeded) no es cupo: ni aviso de agotado ni pausa', async () => {
    const p = cargar()
    await mandar(p.fetch, respuesta(429, { 'x-resend-daily-quota': '10' }, { name: 'rate_limit_exceeded' }))
    expect(avisos()).toHaveLength(0)
    expect(p.campanasPausadasPorCupo()).toBe(false)
  })
})

describe('lo que el medidor no mira', () => {
  it('sin cabecera diaria en una respuesta exitosa: la cuenta es de pago, no pausa, y lo dice UNA vez por proceso', async () => {
    const p = cargar()
    await mandar(p.fetch, conCupo(null, 10))
    await mandar(p.fetch, conCupo(null, 11))

    expect(p.campanasPausadasPorCupo()).toBe(false)
    const dePago = mockLogger.info.mock.calls.filter(([m]) => String(m).includes('de pago'))
    expect(dePago).toHaveLength(1)
  })

  it('un host distinto de api.resend.com no se mira, y la petición pasa tal cual', async () => {
    const p = cargar()
    const init = { method: 'POST', body: 'x' }
    falsa.mockResolvedValueOnce(conCupo(99, 2999))
    await p.fetch('https://api.stripe.com/v1/charges', init)
    await asentar()

    expect(falsa).toHaveBeenCalledWith('https://api.stripe.com/v1/charges', init)
    expect(p.campanasPausadasPorCupo()).toBe(false)
    expect(avisos()).toHaveLength(0)
  })

  it('un medidor que truena no rompe el fetch: la respuesta llega igual', async () => {
    const p = cargar()
    const rota = {
      status: 200,
      ok: true,
      headers: {
        get: () => {
          throw new Error('cabeceras rotas')
        },
      },
    }
    falsa.mockResolvedValueOnce(rota)
    await expect(p.fetch(RESEND, { method: 'POST' })).resolves.toBe(rota)
  })

  it('si la red falla, el error llega tal cual (el medidor no lo cambia)', async () => {
    const p = cargar()
    const caida = new TypeError('fetch failed')
    falsa.mockRejectedValueOnce(caida)
    await expect(p.fetch(RESEND)).rejects.toBe(caida)
  })

  it('instalarlo dos veces no envuelve dos veces', async () => {
    const p = cargar()
    p.instalarMedidorDeCupoResend()
    expect(globalThis.fetch).toBe(p.fetch)
  })
})

describe('una vez por día aunque haya dos procesos o un reinicio (la fila, y la llave del correo)', () => {
  it('dos procesos que cruzan el 80 a la vez mandan el aviso con la MISMA llave: Resend lo manda una vez', async () => {
    const a = cargar()
    const b = cargar()
    falsa.mockResolvedValueOnce(conCupo(80)).mockResolvedValueOnce(conCupo(80))

    await Promise.all([a.fetch(RESEND), b.fetch(RESEND)])
    await asentar()

    const llaves = new Set(mockSendEmail.mock.calls.map(([opciones]) => opciones.idempotencyKey))
    expect(llaves).toEqual(new Set(['cupo-resend-diario-2026-11-03']))
    // Los dos procesos pausan sus campañas: la pausa es de cada uno, el aviso es de la cuenta.
    expect(a.campanasPausadasPorCupo()).toBe(true)
    expect(b.campanasPausadasPorCupo()).toBe(true)
  })

  it('tras reiniciar (memoria vacía) no repite el aviso del día, pero la pausa se rearma con la primera respuesta', async () => {
    const antes = cargar()
    await mandar(antes.fetch, conCupo(80))
    expect(avisos()).toHaveLength(1)

    const despues = cargar()
    expect(despues.campanasPausadasPorCupo()).toBe(false)
    await mandar(despues.fetch, conCupo(85))

    expect(avisos()).toHaveLength(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(despues.campanasPausadasPorCupo()).toBe(true)
  })

  it('el correo del aviso (que también sale por Resend) no dispara otro aviso', async () => {
    const p = cargar()
    mockSendEmail.mockImplementation(async () => {
      falsa.mockResolvedValueOnce(conCupo(81))
      await p.fetch(RESEND, { method: 'POST' })
      return true
    })

    await mandar(p.fetch, conCupo(80))

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(avisos()).toHaveLength(1)
  })

  it('si el correo del aviso falla, el log ya quedó, no se anota (el siguiente proceso lo reintenta) y nada truena', async () => {
    mockSendEmail.mockRejectedValue(new Error('Resend caído'))
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    expect(avisos()).toHaveLength(1)
    expect(fila?.dailyAlertDay ?? null).toBeNull()

    mockSendEmail.mockReset().mockResolvedValue(false)
    const otro = cargar()
    await mandar(otro.fetch, conCupo(81))
    expect(fila?.dailyAlertDay ?? null).toBeNull()
  })

  it('si el proceso muere tras avisar y antes de anotarlo, el siguiente vuelve a avisar con la MISMA llave', async () => {
    prismaMock.emailQuotaAlert.upsert.mockRejectedValueOnce(new Error('el proceso murió'))
    const antes = cargar()
    await mandar(antes.fetch, conCupo(80))
    expect(fila?.dailyAlertDay ?? null).toBeNull()

    const despues = cargar()
    await mandar(despues.fetch, conCupo(82))

    expect(avisos()).toHaveLength(2)
    expect(mockSendEmail.mock.calls.map(([o]) => o.idempotencyKey)).toEqual([
      'cupo-resend-diario-2026-11-03',
      'cupo-resend-diario-2026-11-03',
    ])
    // 🔴 El mismo contenido con la misma llave (80 la primera vez, 82 la segunda): con otro, Resend contesta 409 y nunca se anota.
    const [primero, segundo] = mockSendEmail.mock.calls.map(([o]) => ({ subject: o.subject, html: o.html, text: o.text }))
    expect(segundo).toEqual(primero)
    expect(fila?.dailyAlertDay).toBe('2026-11-03')
  })

  it('si el correo del aviso falla (503, ritmo), se reintenta a los 10 minutos con la siguiente respuesta, sin repetir el log', async () => {
    mockSendEmail.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    await mandar(p.fetch, conCupo(81))
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(fila?.dailyAlertDay ?? null).toBeNull()

    jest.setSystemTime(new Date(HOY.getTime() + 10 * 60_000))
    await mandar(p.fetch, conCupo(82))

    expect(mockSendEmail).toHaveBeenCalledTimes(2)
    expect(avisos()).toHaveLength(1)
    expect(fila?.dailyAlertDay).toBe('2026-11-03')
  })

  it('un aviso de ayer que falla después de cambiar el día no pisa el aviso de hoy (que ya está en vuelo)', async () => {
    let soltarAyer!: (salio: boolean) => void
    mockSendEmail
      .mockImplementationOnce(() => new Promise<boolean>(resolve => (soltarAyer = resolve)))
      .mockImplementationOnce(() => new Promise<boolean>(() => {}))
    const p = cargar()
    await mandar(p.fetch, conCupo(80))

    jest.setSystemTime(MANANA)
    await mandar(p.fetch, conCupo(80))
    expect(mockSendEmail).toHaveBeenCalledTimes(2)

    soltarAyer(false)
    await asentar()
    await mandar(p.fetch, conCupo(81))
    // El de hoy sigue en vuelo: otra respuesta no lo vuelve a disparar.
    expect(mockSendEmail).toHaveBeenCalledTimes(2)
  })

  it('si la base no contesta al leer el aviso, se avisa igual (mejor uno de más que uno perdido)', async () => {
    prismaMock.emailQuotaAlert.findUnique.mockRejectedValue(new Error('se cayó la base'))
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    expect(avisos()).toHaveLength(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('fuera de producción, sin jose@avoqado.io en la lista de prueba, sólo queda el log', async () => {
    process.env.CRM_CORREO_PRUEBAS = 'otra@avoqado.io'
    const p = cargar()
    await mandar(p.fetch, conCupo(80))
    expect(avisos()).toHaveLength(1)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})
