import { handleBlumonTPVWebhook } from '@/controllers/tpv/blumon-webhook.tpv.controller'
import * as svc from '@/services/tpv/blumon-webhook.service'
import logger from '@/config/logger'

jest.mock('@/services/tpv/blumon-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/blumon-webhook.service'),
  processBlumonPaymentWebhook: jest.fn(),
}))

const mockedProcess = svc.processBlumonPaymentWebhook as jest.Mock

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

const validBody = {
  amount: '100.00',
  reference: '260718120000',
  operationNumber: 99000001,
  codeResponse: '00',
  descriptionResponse: 'APROBADA',
  operationType: 'VENTA',
}

const mockReq = (body: unknown = validBody) => ({ body, header: () => undefined, headers: {} }) as any

/**
 * The catch-all used to answer 200 "to prevent Blumon from retrying". But an
 * exception can happen BEFORE the event row is persisted — acknowledging then
 * loses the charge forever, with a receipt. Retries are safe because
 * ProviderEventLog has @@unique([provider, eventId]), so the honest answer is
 * 503 whenever we cannot prove the event was stored.
 */
describe('Task 4 — ACK only after durable persistence', () => {
  beforeEach(() => mockedProcess.mockReset())

  it('503 when the service threw (event may not be persisted)', async () => {
    mockedProcess.mockRejectedValue(new Error('db down'))
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('503 when the result carries no eventLogId (not persisted)', async () => {
    mockedProcess.mockResolvedValue({ success: false, action: 'PENDING', message: 'x' })
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('200 when the event was persisted (eventLogId present)', async () => {
    mockedProcess.mockResolvedValue({
      success: true,
      action: 'MATCHED',
      message: 'ok',
      eventLogId: 'evt_1',
      paymentId: 'pay_1',
    })
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq(), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('an invalid payload still answers 400, not 503', async () => {
    const res = mockRes()

    await handleBlumonTPVWebhook(mockReq({ nonsense: true }), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedProcess).not.toHaveBeenCalled()
  })
})

/**
 * R6 (hallazgo D4): el log y la base no guardan el titular, y el log tampoco el bin ni los últimos 4.
 * La regresión «200 con eventLogId y 503 sin él» son las pruebas de arriba (H1: no se duplican).
 */
describe('R6 — el aviso no deja titular ni tarjeta en el log', () => {
  const conTarjeta = { ...validBody, cardHolder: 'HOMER SIMPSON', bin: '411111', lastFour: '1111' }
  const reqBuffer = (texto: string) => mockReq(Buffer.from(texto, 'utf8'))
  let espias: jest.SpyInstance[]

  /** Todos los argumentos de todas las llamadas a logger.*, serializados. */
  const todoLoLogueado = () => espias.flatMap(s => s.mock.calls).map(args => JSON.stringify(args)).join('\n')

  beforeEach(() => {
    mockedProcess.mockReset()
    // correlationId lleva Date.now(): fijo, para que '1111' no salga por casualidad.
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    espias = (['info', 'warn', 'error', 'debug'] as const).map(nivel =>
      jest.spyOn(logger, nivel).mockImplementation((() => logger) as any),
    )
  })
  afterEach(() => jest.restoreAllMocks())

  it('el log del aviso no lleva titular, bin ni últimos 4', async () => {
    mockedProcess.mockResolvedValue({ success: true, action: 'MATCHED', message: 'ok', eventLogId: 'evt_1' })
    const res = mockRes()

    await handleBlumonTPVWebhook(reqBuffer(JSON.stringify(conTarjeta)), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(200)
    const log = todoLoLogueado()
    expect(log).toContain('"amount":"100.00"') // sí se logueó el aviso…
    expect(log).not.toContain('HOMER') // …pero sin titular
    expect(log).not.toContain('411111')
    expect(log).not.toContain('1111')
  })

  it.each([
    '{"cardHolder":"HOMER', // cadena sin terminar
    '{"cardHolder": HOMER SIMPSON}', // valor sin comillas: el SyntaxError de V8 cita un fragmento del cuerpo
  ])('JSON roto %p: el log sólo lleva nombre del error, tamaño y posición', async cuerpo => {
    const res = mockRes()

    await handleBlumonTPVWebhook(reqBuffer(cuerpo), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(todoLoLogueado()).not.toContain('HOMER')
    const [, campos] = (logger.error as unknown as jest.SpyInstance).mock.calls[0]
    expect(campos).toEqual(expect.objectContaining({ errorName: 'SyntaxError', rawBodyLength: Buffer.byteLength(cuerpo) }))
    if ('jsonErrorPosition' in campos) expect(typeof campos.jsonErrorPosition).toBe('number')
  })

  it('payload inválido: el recorte de 500 caracteres sale de paraElLog', async () => {
    const invalido = { cardHolder: 'HOMER SIMPSON', bin: '411111', lastFour: '1111', relleno: 'x'.repeat(600) } // sin amount
    const res = mockRes()

    await handleBlumonTPVWebhook(reqBuffer(JSON.stringify(invalido)), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    const [, campos] = (logger.warn as unknown as jest.SpyInstance).mock.calls[0]
    expect(campos.body).toBe(JSON.stringify(svc.paraElLog(invalido)).substring(0, 500))
    const log = todoLoLogueado()
    expect(log).not.toContain('HOMER')
    expect(log).not.toContain('411111')
    expect(log).not.toContain('1111')
  })

  it('JSON válido doblemente codificado (raíz cadena con cardHolder, bin y lastFour dentro) ⇒ el log sólo dice rootType string y el tamaño', async () => {
    const cuerpo = JSON.stringify(JSON.stringify(conTarjeta))
    const res = mockRes()

    await handleBlumonTPVWebhook(reqBuffer(cuerpo), res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    const log = todoLoLogueado()
    expect(log).toContain('"rootType":"string"')
    expect(log).toContain(`"rawBodyLength":${Buffer.byteLength(cuerpo)}`)
    expect(log).not.toContain('HOMER')
    expect(log).not.toContain('411111')
    expect(log).not.toContain('1111')
  })
})
