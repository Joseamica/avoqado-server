/**
 * El POS de Windows dice cómo dibuja su computadora (hz:a5fa2439:D1): una cabecera opcional en el sondeo de cada
 * 15–20 s. Es un dato de vista: el parser nunca lanza, y guardarlo nunca hace esperar ni falla al sondeo.
 * La sentencia condicionada (lo guardado nunca retrocede) se prueba contra la base en
 * tests/integration/devices/deviceDiagnostics.integration.test.ts.
 */
import { Prisma } from '@prisma/client'
import type { Request } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import {
  esEsperaDeLaBase,
  parseDeviceDiagnostics,
  parseStoredDeviceDiagnostics,
  readDeviceDiagnostics,
  reportarDiagnosticoTrasElSondeo,
} from '@/services/mobile/deviceDiagnostics'

const EJEMPLO =
  'v=1;proc=3fa9c1d2;rev=2;api=SOFTWARE_FAST;paint=712;light=1;perf=LIGHT;set=FAST;forced=1;fail=0;hand=0;' +
  'cpu=Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz;cores=4;ram=7.9;screen=1920x1080'

const COMPLETO = {
  proc: '3fa9c1d2',
  rev: 2,
  api: 'SOFTWARE_FAST',
  paintMs: 712,
  performance: 'LIGHT',
  drawingMode: 'FAST',
  forced: true,
  failed: false,
  manual: false,
  light: true,
  cpu: 'Intel(R) Core(TM) i5-3470 CPU @ 3.20GHz',
  cores: 4,
  ramGb: 7.9,
  screen: '1920x1080',
}

const MINIMO = 'v=1;proc=3fa9c1d2;rev=2;api=OPENGL;paint=40;perf=FLUID;set=AUTO'
const sin = (clave: string) =>
  EJEMPLO.split(';')
    .filter(par => !par.startsWith(`${clave}=`))
    .join(';')
const con = (clave: string, valor: string) =>
  EJEMPLO.split(';')
    .map(par => (par.startsWith(`${clave}=`) ? `${clave}=${valor}` : par))
    .join(';')

describe('parseDeviceDiagnostics (la cabecera)', () => {
  it('la cabecera de ejemplo da el objeto completo', () => {
    expect(parseDeviceDiagnostics(EJEMPLO)).toEqual(COMPLETO)
  })

  it.each([
    ['undefined', undefined],
    ['un número', 42],
    ['vacía', ''],
    ['otra versión', EJEMPLO.replace('v=1', 'v=2')],
    ['basura', 'basura'],
    ['sin paint', sin('paint')],
    ['sin set', sin('set')],
    ['sin proc', sin('proc')],
    ['rev=0', con('rev', '0')],
    ['rev=abc', con('rev', 'abc')],
    ['api=METAL', con('api', 'METAL')],
    ['perf=LIGHT con paint=-5', con('paint', '-5')],
    ['proc=XYZ', con('proc', 'XYZ')],
    ['un obligatorio repetido', `${EJEMPLO};rev=3`],
    ['v repetida', `${EJEMPLO};v=1`],
  ])('%s ⇒ undefined', (_caso, raw) => {
    expect(parseDeviceDiagnostics(raw)).toBeUndefined()
  })

  it('más de 512 caracteres crudos ⇒ undefined, aunque empiece con pares válidos (no se recorta)', () => {
    const largo = `${MINIMO};x=${'a'.repeat(512)}`.slice(0, 513)
    expect(largo).toHaveLength(513)
    expect(parseDeviceDiagnostics(largo)).toBeUndefined()
    expect(parseDeviceDiagnostics(largo.slice(0, 512))).toBeDefined()
  })

  it('un opcional inválido se descarta solo: cores=abc se acepta sin cores', () => {
    const d = parseDeviceDiagnostics(con('cores', 'abc'))
    expect(d).toBeDefined()
    expect(d).not.toHaveProperty('cores')
    expect(d).toMatchObject({ proc: '3fa9c1d2', ramGb: 7.9 })
  })

  it.each([
    ['cpu de 81', 'cpu', 'x'.repeat(81)],
    ['cores=0', 'cores', '0'],
    ['cores=513', 'cores', '513'],
    ['ram=4097', 'ram', '4097'],
    ['screen=1920', 'screen', '1920'],
    ['light=2', 'light', '2'],
  ])('%s se descarta sin tumbar el reporte', (_caso, clave, valor) => {
    const campo = { cpu: 'cpu', cores: 'cores', ram: 'ramGb', screen: 'screen', light: 'light' }[clave]!
    const d = parseDeviceDiagnostics(con(clave, valor))
    expect(d).toBeDefined()
    expect(d).not.toHaveProperty(campo)
  })

  it('un opcional repetido se descarta solo', () => {
    const d = parseDeviceDiagnostics(`${EJEMPLO};cores=8`)
    expect(d).toBeDefined()
    expect(d).not.toHaveProperty('cores')
  })

  it('sin forced/fail/hand ⇒ los tres false; light queda sin definir; las claves desconocidas se ignoran', () => {
    expect(parseDeviceDiagnostics(`${MINIMO};desconocida=1;otra`)).toEqual({
      proc: '3fa9c1d2',
      rev: 2,
      api: 'OPENGL',
      paintMs: 40,
      performance: 'FLUID',
      drawingMode: 'AUTO',
      forced: false,
      failed: false,
      manual: false,
    })
  })

  it('el valor se parte en el PRIMER «=»', () => {
    expect(parseDeviceDiagnostics(`${MINIMO};cpu=a=b`)).toMatchObject({ cpu: 'a=b' })
  })

  it('nunca lanza', () => {
    for (const raw of [null, {}, [], Symbol('x'), 'ñ§;;;', ';;;', '=', 'v=1;=;==;proc', '__proto__=1;v=1']) {
      expect(() => parseDeviceDiagnostics(raw)).not.toThrow()
    }
  })
})

describe('parseStoredDeviceDiagnostics (lo guardado en la columna)', () => {
  const guardado = { ...COMPLETO, receivedAt: '2026-11-25T18:00:00.000Z', prevProc: 'aaaaaaaa' }

  it('lo guardado vuelve campo por campo, sin la marca interna prevProc', () => {
    expect(parseStoredDeviceDiagnostics(guardado)).toEqual({ ...COMPLETO, receivedAt: guardado.receivedAt })
  })

  it.each([
    ['null', null],
    ['basura', 'basura'],
    ['un arreglo', [guardado]],
    ['rev de texto', { ...guardado, rev: 'x' }],
    ['sin receivedAt', { ...guardado, receivedAt: undefined }],
    ['receivedAt inválido', { ...guardado, receivedAt: 'ayer' }],
    ['api desconocida', { ...guardado, api: 'METAL' }],
  ])('%s ⇒ undefined', (_caso, raw) => {
    expect(parseStoredDeviceDiagnostics(raw)).toBeUndefined()
  })

  it('un opcional raro se descarta solo', () => {
    const d = parseStoredDeviceDiagnostics({ ...guardado, cores: 'cuatro', screen: 7 })
    expect(d).toBeDefined()
    expect(d).not.toHaveProperty('cores')
    expect(d).not.toHaveProperty('screen')
  })
})

function reqCon(valores: string[] | undefined, authContext: Record<string, unknown> = { userId: 's1', venueId: 'v1' }): Request {
  return { headersDistinct: valores ? { 'x-device-diagnostics': valores } : {}, authContext } as unknown as Request
}

describe('readDeviceDiagnostics (una sola ocurrencia)', () => {
  it('una ocurrencia válida ⇒ el reporte', () => {
    expect(readDeviceDiagnostics(reqCon([EJEMPLO]))).toEqual(COMPLETO)
  })

  it.each([
    ['sin cabecera', undefined],
    ['dos veces', [EJEMPLO, EJEMPLO]],
  ])('%s ⇒ undefined', (_caso, valores) => {
    expect(readDeviceDiagnostics(reqCon(valores))).toBeUndefined()
  })

  it('una petición sin headersDistinct ⇒ undefined, sin lanzar', () => {
    expect(readDeviceDiagnostics({} as Request)).toBeUndefined()
  })
})

describe('reportarDiagnosticoTrasElSondeo', () => {
  const TERMINAL = 'cterminal0000000000000001'
  const NOW = new Date('2026-11-25T18:00:00.000Z')
  type Pendiente = { promesa: Promise<unknown>; soltar: (v?: unknown) => void; fallar: (e: unknown) => void }
  const pendiente = (): Pendiente => {
    let soltar!: (v?: unknown) => void
    let fallar!: (e: unknown) => void
    const promesa = new Promise((ok, mal) => {
      soltar = ok
      fallar = mal
    })
    return { promesa, soltar, fallar }
  }
  const vaciar = () => new Promise(r => setImmediate(r))

  beforeEach(() => {
    jest.clearAllMocks()
    // La forma en lote: Prisma recibe las dos sentencias juntas y devuelve sus resultados en orden.
    prismaMock.$transaction.mockImplementation((ops: any) => Promise.all(ops))
    prismaMock.$executeRaw.mockResolvedValue(1)
  })

  it('con reporte válido guarda en una transacción corta: SET LOCAL lock_timeout y UNA sentencia sobre esa ficha', async () => {
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), TERMINAL, NOW)
    await vaciar()

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // En lote (un arreglo), no interactiva: la conexión no se queda apartada entre turnos de JS.
    const [lote] = prismaMock.$transaction.mock.calls[0] as unknown as [unknown[]]
    expect(Array.isArray(lote)).toBe(true)
    expect(lote).toHaveLength(2)
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2)
    const [primera] = prismaMock.$executeRaw.mock.calls[0]
    expect((primera as TemplateStringsArray).join('?')).toContain("SET LOCAL lock_timeout = '2s'")
    const [sentencia] = prismaMock.$executeRaw.mock.calls[1] as [{ sql: string; values: unknown[] }]
    expect(sentencia.sql).toMatch(/^\s*UPDATE "Terminal"/)
    expect(sentencia.sql).toContain(`t.type = 'POS_ANDROID'`)
    expect(sentencia.sql).not.toMatch(/lastHeartbeat/)
    expect(sentencia.values).toContain(TERMINAL)
    expect(sentencia.values).toContain(JSON.stringify({ ...COMPLETO, receivedAt: NOW.toISOString() }))
    expect(prismaMock.terminal.update).not.toHaveBeenCalled()
    expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
  })

  it('con un guardado que tarda 5 s regresa de inmediato y no lanza', async () => {
    jest.useFakeTimers()
    try {
      prismaMock.$transaction.mockImplementationOnce(() => new Promise(r => setTimeout(() => r([0, 1]), 5_000)))
      reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), TERMINAL, NOW)
      // Ya regresó y la escritura de 5 s sigue pendiente: nadie la esperó.
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(1)
      jest.advanceTimersByTime(5_000)
    } finally {
      jest.useRealTimers()
    }
    await vaciar()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // Cada prueba que hace fallar el guardado usa su propio aparato: la memoria de avisos es del módulo, y así ningún orden de las
  // pruebas puede callar un aviso que otra espera.
  it('con un guardado que rechaza no lanza ni deja una promesa sin atender: sólo avisa en el log', async () => {
    const pc = 'cterminal0000000000000011'
    prismaMock.$transaction.mockRejectedValueOnce(new Error('se cayó la base'))
    expect(() => reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), pc, NOW)).not.toThrow()
    await vaciar()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dibujo'), expect.objectContaining({ terminalId: pc }))
  })

  it.each([
    ['impersonación', { userId: 's1', venueId: 'v1', isImpersonating: true, impersonation: { mode: 'user' } }],
    ['impersonación sin su ficha', { userId: 's1', venueId: 'v1', isImpersonating: true }],
  ])('una sesión de %s (sólo lectura) no guarda', async (_caso, ctx) => {
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO], ctx), TERMINAL, NOW)
    await vaciar()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it.each([
    ['sin cabecera', undefined],
    ['con la cabecera dos veces', [EJEMPLO, EJEMPLO]],
    ['con un reporte inválido', ['ñ§;;;']],
  ])('%s no guarda', async (_caso, valores) => {
    reportarDiagnosticoTrasElSondeo(reqCon(valores), TERMINAL, NOW)
    await vaciar()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('a lo más un guardado en curso por aparato: tres sondeos más no lanzan otro; al terminar, el siguiente sí guarda', async () => {
    const primero = pendiente()
    prismaMock.$transaction.mockImplementationOnce(() => primero.promesa)

    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), TERMINAL, NOW)
    for (let i = 0; i < 3; i++) reportarDiagnosticoTrasElSondeo(reqCon([con('rev', String(3 + i))]), TERMINAL, NOW)
    await vaciar()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)

    // Otro aparato no espera al primero.
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), 'cterminal0000000000000002', NOW)
    await vaciar()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)

    primero.soltar([0, 1])
    await vaciar()
    reportarDiagnosticoTrasElSondeo(reqCon([con('rev', '9')]), TERMINAL, NOW)
    await vaciar()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
  })

  it('el cupo también se libera cuando el guardado rechaza', async () => {
    const pc = 'cterminal0000000000000012'
    const primero = pendiente()
    prismaMock.$transaction.mockImplementationOnce(() => primero.promesa)
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), pc, NOW)
    primero.fallar(new Error('se cayó la base'))
    await vaciar()
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), pc, NOW)
    await vaciar()
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('nunca lanza, aunque la petición venga rota', () => {
    expect(() => reportarDiagnosticoTrasElSondeo(null as unknown as Request, TERMINAL, NOW)).not.toThrow()
    const rara = {
      get headersDistinct() {
        throw new Error('getter roto')
      },
    } as unknown as Request
    expect(() => reportarDiagnosticoTrasElSondeo(rara, TERMINAL, NOW)).not.toThrow()
  })

  // Cada PC sondea cada 15–20 s: un aviso por sondeo fallido llenaría el log. Ids propios en cada prueba: la memoria de avisos es
  // del módulo.
  const errorDePrisma = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('falló', { code, clientVersion: 'prueba', ...(meta ? { meta } : {}) })
  const a = (minutos: number) => new Date(NOW.getTime() + minutos * 60_000)

  it.each([
    ['la fila tomada (55P03)', 'cterminal0000000000000101', errorDePrisma('P2010', { code: '55P03' })],
    ['la transacción que no arrancó a tiempo (P2028)', 'cterminal0000000000000102', errorDePrisma('P2028')],
    ['el pool sin conexiones libres (P2024)', 'cterminal0000000000000103', errorDePrisma('P2024')],
  ])('%s es una espera normal de la base: va a debug, nunca a warn', async (_caso, terminal, error) => {
    expect(esEsperaDeLaBase(error)).toBe(true)
    prismaMock.$transaction.mockRejectedValueOnce(error)
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), terminal, NOW)
    await vaciar()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('dibujo'), expect.objectContaining({ terminalId: terminal }))
  })

  it('cualquier otro error avisa a lo más una vez cada 10 min por aparato; un guardado bueno reinicia la cuenta', async () => {
    const pc = 'cterminal0000000000000201'
    const otra = 'cterminal0000000000000202'
    const falla = (terminal: string, minuto: number) => {
      prismaMock.$transaction.mockRejectedValueOnce(errorDePrisma('P2010', { code: '57P01' }))
      reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), terminal, a(minuto))
    }

    falla(pc, 0)
    await vaciar()
    falla(pc, 9)
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(1)

    falla(otra, 9) // otro aparato tiene su propia cuenta
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(2)

    falla(pc, 10)
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(3)

    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), pc, a(11)) // guarda bien
    await vaciar()
    falla(pc, 12)
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(4)
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('la memoria de avisos nunca pasa de 1 000 aparatos: si se fuera a pasar, se vacía', async () => {
    const id = (i: number) => `ctope${String(i).padStart(20, '0')}`
    prismaMock.$transaction.mockRejectedValue(new Error('se cayó la base'))
    for (let i = 0; i < 1_000; i++) reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), id(i), NOW)
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(1_000)

    // El aparato 1 000 ya no cabe: la memoria se vacía antes de anotarlo…
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), id(1_000), NOW)
    await vaciar()
    // …así que el 0 vuelve a avisar aunque no hayan pasado sus 10 min.
    reportarDiagnosticoTrasElSondeo(reqCon([EJEMPLO]), id(0), NOW)
    await vaciar()
    expect(logger.warn).toHaveBeenCalledTimes(1_002)
  })
})
