import crypto from 'crypto'

import type { Request, Response } from 'express'

import { handleAngelPayWebhook, angelpayWebhookHealthCheck } from '@/controllers/tpv/angelpay-webhook.tpv.controller'
import * as service from '@/services/tpv/angelpay-webhook.service'
import * as avisos from '@/services/tpv/avisosNoGuardados'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the real AngelPay HMAC-SHA256 hex signature.
 * key = full secret string with "whsec_" prefix as raw UTF-8
 * body = raw JSON string bytes
 */
function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    merchantAccount: {
      findFirst: jest.fn(),
    },
  },
}))

import prisma from '@/utils/prismaClient'
const mockedMerchantAccountFindFirst = prisma.merchantAccount.findFirst as jest.Mock

const mockedProcess = service.processAngelPayWebhook as jest.Mock

// ── Request / Response builders ───────────────────────────────────────────────

/**
 * Build a minimal Express-like Request.
 * body should be a Buffer (the raw bytes that were signed).
 */
function mkReq(opts: { bodyBuf?: Buffer; headers?: Record<string, string>; params?: Record<string, string> }): Request {
  return {
    body: opts.bodyBuf ?? Buffer.from('{}'),
    params: opts.params ?? {},
    header(name: string) {
      return opts.headers?.[name.toLowerCase()]
    },
  } as unknown as Request
}

function mkRes(): Response & { __status?: number; __body?: unknown } {
  const res: any = {}
  res.status = (n: number) => {
    res.__status = n
    return res
  }
  res.json = (b: unknown) => {
    res.__body = b
    return res
  }
  return res
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'whsec_x'

const merchantRow = {
  id: 'ma_1',
  externalMerchantId: '351',
  angelpayWebhookSecret: TEST_SECRET,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleAngelPayWebhook', () => {
  beforeEach(() => {
    mockedProcess.mockReset()
    mockedMerchantAccountFindFirst.mockReset()
  })

  it('returns 404 when merchantAccountId is unknown', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(null)
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'unknown' } }), res, jest.fn())
    expect(res.__status).toBe(404)
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 503 when merchant has no angelpayWebhookSecret', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ ...merchantRow, angelpayWebhookSecret: null })
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'ma_1' } }), res, jest.fn())
    expect(res.__status).toBe(503)
  })

  it('returns 401 when x-webhook-signature header is missing', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    // No x-webhook-signature or x-webhook-event-id
    await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: 'ma_1' }, headers: {} }), res, jest.fn())
    expect(res.__status).toBe(401)
    expect((res.__body as any).error).toBe('missing signature headers')
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 401 when signature is invalid (wrong HMAC)', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    const res = mkRes()
    const bodyStr = JSON.stringify({ event_type: 'send_transaction', payload: { amount: '100' } })
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        bodyBuf: Buffer.from(bodyStr),
        headers: {
          'x-webhook-event-id': 'evt_bad',
          'x-webhook-signature': 'deadbeef00000000000000000000000000000000000000000000000000000000',
        },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(401)
    expect((res.__body as any).error).toBe('invalid signature')
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 200 + action body on valid signature and successful processing', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })

    const bodyStr = JSON.stringify({
      event_type: 'send_transaction',
      payload: { amount: '10000', integratorReference: 'ref-x', status: 'approved' },
    })
    const sig = sign(TEST_SECRET, bodyStr)

    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        params: { merchantAccountId: 'ma_1' },
        bodyBuf: Buffer.from(bodyStr),
        headers: {
          'x-webhook-event-id': 'evt_1',
          'x-webhook-timestamp': '2026-05-29T00:53:14.104341+00:00',
          'x-webhook-signature': sig,
        },
      }),
      res,
      jest.fn(),
    )

    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
    expect(mockedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt_1',
        merchantAccount: expect.objectContaining({ id: 'ma_1', externalMerchantId: '351' }),
      }),
    )
  })

  /**
   * 🔴 Codex pasada final (P1-2): el servicio LANZA sólo si el aviso no quedó guardado (lo posterior al ingreso durable lo
   * recupera el worker y contesta 200). Un 200 aquí le decía a AngelPay «recibido» por una aprobación que no existe en
   * ningún lado: sin evento, sin worker que la recupere, y con el silencio de ese intento luciendo como «no se cobró».
   */
  describe('final P1-2 · el aviso firmado que NO se pudo guardar', () => {
    const enviar = async (payload: Record<string, unknown>) => {
      const bodyStr = JSON.stringify({ event_type: 'send_transaction', payload })
      const res = mkRes()
      await handleAngelPayWebhook(
        mkReq({
          params: { merchantAccountId: 'ma_1' },
          bodyBuf: Buffer.from(bodyStr),
          headers: { 'x-webhook-event-id': 'evt_perdido', 'x-webhook-signature': sign(TEST_SECRET, bodyStr) },
        }),
        res,
        jest.fn(),
      )
      return res
    }
    afterEach(() => avisos._olvidarTodoParaPruebas())

    it('🔴 contesta 503 (que AngelPay reintente), no 200', async () => {
      mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
      mockedProcess.mockRejectedValue(new Error('la base se cayó al insertar el evento'))
      const res = await enviar({ amount: '10000', integratorReference: ' ref-perdida ', status: 'approved' })
      expect(res.__status).toBe(503)
    })

    it('🔴 una APROBACIÓN que no se guardó es dinero conocido de SU intento, y el canal de ese comercio deja de estar comprobado', async () => {
      mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
      mockedProcess.mockRejectedValue(new Error('la base se cayó al insertar el evento'))
      await enviar({ amount: '10000', integratorReference: ' ref-perdida ', status: 'approved' })
      expect(avisos.hayDineroNoGuardado('ref-perdida')).toBe(true) // la llave canónica: recortada
      expect(avisos.hayDineroNoGuardado('otro-intento')).toBe(false)
      expect(avisos.canalDelComercioFalloHacePoco('ma_1')).toBe(true)
      expect(avisos.canalDelComercioFalloHacePoco('otro-comercio')).toBe(false)
    })

    it('un estado que no es un rechazo acreditado (sin status) también es posible dinero', async () => {
      mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
      mockedProcess.mockRejectedValue(new Error('caída'))
      await enviar({ amount: '10000', integratorReference: 'ref-sin-status' })
      expect(avisos.hayDineroNoGuardado('ref-sin-status')).toBe(true)
    })

    it('un RECHAZO que no se guardó no es dinero (pero el canal sí falló)', async () => {
      mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
      mockedProcess.mockRejectedValue(new Error('caída'))
      await enviar({ amount: '10000', integratorReference: 'ref-rechazada', status: 'declined' })
      expect(avisos.hayDineroNoGuardado('ref-rechazada')).toBe(false)
      expect(avisos.canalDelComercioFalloHacePoco('ma_1')).toBe(true)
    })

    it('🔴 si la base falla ya al buscar el comercio: 503 y SÓLO la marca del canal — un cuerpo sin firma verificada nunca crea un veto', async () => {
      mockedMerchantAccountFindFirst.mockRejectedValue(new Error('la base está caída'))
      const res = await enviar({ amount: '10000', integratorReference: 'ref-sin-firma', status: 'approved' })
      expect(res.__status).toBe(503)
      expect(mockedProcess).not.toHaveBeenCalled()
      expect(avisos.hayDineroNoGuardado('ref-sin-firma')).toBe(false)
      expect(avisos.canalDelComercioFalloHacePoco('ma_1')).toBe(true)
    })

    it('🔴 un id que no puede existir (con byte nulo la búsqueda revienta en Postgres, medido) ⇒ 404 sin tocar la base ni marcar nada', async () => {
      mockedMerchantAccountFindFirst.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'))
      for (const basura of ['abc\u0000def', 'x'.repeat(65), 'ma 1', '../ma_1']) {
        const res = mkRes()
        await handleAngelPayWebhook(mkReq({ params: { merchantAccountId: basura } }), res, jest.fn())
        expect(res.__status).toBe(404)
        expect(avisos.canalDelComercioFalloHacePoco(basura)).toBe(false)
      }
      expect(mockedMerchantAccountFindFirst).not.toHaveBeenCalled()
    })

    /**
     * 🔴 El reingreso propio: si AngelPay no reintentara el 503, la marca de dinero dejaría la terminal apartada sin salida (la
     * terminal guarda durable el «hay evidencia» y nadie registraría ese cobro). El servidor vuelve a procesar la MISMA entrada.
     */
    describe('reingreso propio', () => {
      beforeEach(() => jest.useFakeTimers())
      afterEach(() => {
        avisos._olvidarTodoParaPruebas()
        jest.useRealTimers()
      })

      it('🔴 el aviso firmado que no se guardó se REINGRESA solo cuando la base vuelve — no depende de que AngelPay reintente', async () => {
        mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
        mockedProcess
          .mockRejectedValueOnce(new Error('la base se cayó'))
          .mockRejectedValueOnce(new Error('sigue caída'))
          .mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_guardado' })
        const res = await enviar({ amount: '10000', integratorReference: 'ref-reingreso', status: 'approved' })
        expect(res.__status).toBe(503)
        expect(mockedProcess).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(2)
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[1])
        expect(mockedProcess).toHaveBeenCalledTimes(3)
        await jest.advanceTimersByTimeAsync(10 * 60_000)
        expect(mockedProcess).toHaveBeenCalledTimes(3) // guardado: ya no se intenta
        expect(mockedProcess.mock.calls[2][0]).toMatchObject({ eventId: 'evt_perdido', merchantAccount: { id: 'ma_1' } })
      })

      it('🔴 si la base falla AL BUSCAR el comercio también se reingresa — y la firma se verifica al reintentar', async () => {
        mockedMerchantAccountFindFirst.mockRejectedValueOnce(new Error('la base está caída')).mockResolvedValue(merchantRow)
        mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_guardado' })
        const res = await enviar({ amount: '10000', integratorReference: 'ref-busqueda', status: 'approved' })
        expect(res.__status).toBe(503)
        expect(mockedProcess).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(1)
        expect(mockedProcess.mock.calls[0][0]).toMatchObject({
          eventId: 'evt_perdido',
          payload: { payload: { integratorReference: 'ref-busqueda' } },
        })
      })

      it('🔴 final-2 · mil avisos basura durante la caída NO expulsan el reingreso del aviso auténtico', async () => {
        // Codex: auténtico con ingreso fallido + 1 000 cuerpos con firma falsa mientras la búsqueda falla ⇒ el auténtico se
        // abandonaba, su veto quedaba vivo y la terminal retenida sin recuperación aunque la base ya había vuelto.
        let busquedas = 0
        mockedMerchantAccountFindFirst.mockImplementation(async () => {
          busquedas++
          if (busquedas >= 2 && busquedas <= avisos.TOPE_DE_REINGRESOS_SIN_VERIFICAR + 6) throw new Error('la base está caída')
          return merchantRow
        })
        mockedProcess.mockRejectedValueOnce(new Error('el ingreso falló')).mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt' })
        expect((await enviar({ amount: '10000', integratorReference: 'ref-autentica', status: 'approved' })).__status).toBe(503)
        for (let i = 0; i < avisos.TOPE_DE_REINGRESOS_SIN_VERIFICAR + 5; i++) {
          const cuerpo = JSON.stringify({ event_type: 'send_transaction', payload: { integratorReference: `basura-${i}` } })
          await handleAngelPayWebhook(
            mkReq({
              params: { merchantAccountId: 'ma_1' },
              bodyBuf: Buffer.from(cuerpo),
              headers: { 'x-webhook-event-id': `evt_basura_${i}`, 'x-webhook-signature': 'ff'.repeat(32) },
            }),
            mkRes(),
            jest.fn(),
          )
        }
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(2)
        expect(mockedProcess.mock.calls[1][0]).toMatchObject({ payload: { payload: { integratorReference: 'ref-autentica' } } })
      })

      it('🔴 final-3 · un falso con la MISMA clave, encolado primero, no se lleva el reingreso del auténtico', async () => {
        // Codex final-3: firma falsa con la búsqueda caída (sin verificar) y DESPUÉS el auténtico con la misma clave
        // comercio/eventId, que verifica y falla al guardarse ⇒ cero avisos guardados y el veto de A vivo.
        let busquedas = 0
        mockedMerchantAccountFindFirst.mockImplementation(async () => {
          busquedas++
          if (busquedas === 1) throw new Error('la base está caída')
          return merchantRow
        })
        mockedProcess.mockRejectedValueOnce(new Error('el ingreso falló')).mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt' })
        const falso = JSON.stringify({ event_type: 'send_transaction', payload: { integratorReference: 'ref-falsa' } })
        await handleAngelPayWebhook(
          mkReq({
            params: { merchantAccountId: 'ma_1' },
            bodyBuf: Buffer.from(falso),
            headers: { 'x-webhook-event-id': 'evt_perdido', 'x-webhook-signature': 'ff'.repeat(32) },
          }),
          mkRes(),
          jest.fn(),
        )
        expect((await enviar({ amount: '10000', integratorReference: 'ref-autentica', status: 'approved' })).__status).toBe(503)
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(2)
        expect(mockedProcess.mock.calls[1][0]).toMatchObject({ payload: { payload: { integratorReference: 'ref-autentica' } } })
      })

      it('🔴 final-4 · el falso y el auténtico con la MISMA clave llegan los DOS con la búsqueda caída: ninguno le quita el lugar al otro', async () => {
        // Sin la base no se puede verificar a ninguno de los dos. Con la clave comercio/eventId el primero que llegaba (el falso)
        // se quedaba el lugar y el auténtico se descartaba; al volver la base el falso daba 401 y no quedaba nada que reingresar.
        let busquedas = 0
        mockedMerchantAccountFindFirst.mockImplementation(async () => {
          busquedas++
          if (busquedas <= 2) throw new Error('la base está caída')
          return merchantRow
        })
        mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt' })
        const falso = JSON.stringify({ event_type: 'send_transaction', payload: { integratorReference: 'ref-falsa' } })
        await handleAngelPayWebhook(
          mkReq({
            params: { merchantAccountId: 'ma_1' },
            bodyBuf: Buffer.from(falso),
            headers: { 'x-webhook-event-id': 'evt_perdido', 'x-webhook-signature': 'ff'.repeat(32) },
          }),
          mkRes(),
          jest.fn(),
        )
        expect((await enviar({ amount: '10000', integratorReference: 'ref-autentica', status: 'approved' })).__status).toBe(503)
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(1)
        expect(mockedProcess.mock.calls[0][0]).toMatchObject({ payload: { payload: { integratorReference: 'ref-autentica' } } })
      })

      it('el mismo aviso fallando dos veces (AngelPay también reintentó) deja UN solo reingreso', async () => {
        mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
        mockedProcess
          .mockRejectedValueOnce(new Error('caída'))
          .mockRejectedValueOnce(new Error('caída'))
          .mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_guardado' })
        await enviar({ amount: '10000', integratorReference: 'ref-doble', status: 'approved' })
        await enviar({ amount: '10000', integratorReference: 'ref-doble', status: 'approved' })
        await jest.advanceTimersByTimeAsync(avisos.ESPERAS_DE_REINGRESO_MS[0])
        expect(mockedProcess).toHaveBeenCalledTimes(3)
      })

      it('un cuerpo más grande de lo que AngelPay manda no se guarda en memoria para reingresar', async () => {
        mockedMerchantAccountFindFirst.mockRejectedValueOnce(new Error('la base está caída')).mockResolvedValue(merchantRow)
        const res = await enviar({
          amount: '10000',
          integratorReference: 'ref-gigante',
          relleno: 'x'.repeat(avisos.TOPE_DE_CUERPO_PARA_REINGRESO),
        })
        expect(res.__status).toBe(503)
        await jest.advanceTimersByTimeAsync(10 * 60_000)
        expect(mockedMerchantAccountFindFirst).toHaveBeenCalledTimes(1)
      })
    })

    it('control · con el aviso guardado (el servicio contesta), 200 y ninguna marca', async () => {
      mockedMerchantAccountFindFirst.mockResolvedValue(merchantRow)
      mockedProcess.mockResolvedValue({ action: 'ERROR', errorReason: 'PROCESSING_ERROR', eventLogId: 'evt_guardado' })
      const res = await enviar({ amount: '10000', integratorReference: 'ref-guardada', status: 'approved' })
      expect(res.__status).toBe(200)
      expect(avisos.hayDineroNoGuardado('ref-guardada')).toBe(false)
      expect(avisos.canalDelComercioFalloHacePoco('ma_1')).toBe(false)
    })
  })
})

describe('angelpayWebhookHealthCheck', () => {
  it('returns 200 with success + timestamp', () => {
    const res = mkRes()
    angelpayWebhookHealthCheck({} as Request, res)
    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ success: true })
    expect((res.__body as any).timestamp).toBeDefined()
  })
})
