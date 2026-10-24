/**
 * D1, paso 1 (21-oct-2026): el guardia de avisos de Blumon TPV decide IGUAL que antes (primer eslabón de
 * X-Forwarded-For) y sólo ANOTA la IP que pone Cloudflare y si leerla cambiaría la decisión. El paso 2 —leer la del
 * portero— se hace sólo si los avisos reales muestran que coinciden; si no, se rechazarían avisos buenos de Blumon.
 *
 * Cada petición trae el X-Forwarded-For que el proxy de Render le entrega a la app: lo que mandó quien llama, más el
 * eslabón de Cloudflare y el del borde al final (Cloudflare y Render AGREGAN, no reemplazan).
 */
import express from 'express'
import request from 'supertest'
import logger from '@/config/logger'
import { handleBlumonTPVWebhook } from '@/controllers/tpv/blumon-webhook.tpv.controller'
import { blumonIPWhitelist } from '@/middlewares/blumon-ip-whitelist.middleware'
import * as servicio from '@/services/tpv/blumon-webhook.service'

jest.mock('@/services/tpv/blumon-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/blumon-webhook.service'),
  processBlumonPaymentWebhook: jest.fn(),
}))

const BLUMON = '3.132.184.158'
const BORDE = '172.69.164.176'

function app() {
  const a = express()
  a.set('trust proxy', 1)
  a.post('/webhooks/blumon/tpv', blumonIPWhitelist, (_req, res) => {
    res.sendStatus(200)
  })
  return a
}

const observaciones = (nivel: 'info' | 'warn') =>
  (logger[nivel] as jest.Mock).mock.calls.filter(([mensaje]) => String(mensaje).includes('[Blumon IP]')).map(([, datos]) => datos)

beforeEach(() => jest.clearAllMocks())

describe('guardia de avisos de Blumon TPV — paso 1: observar sin cambiar la decisión', () => {
  it('el aviso real de Blumon pasa como antes y queda anotado que las dos IPs coinciden', async () => {
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', BLUMON)
      .set('X-Forwarded-For', `${BLUMON}, ${BORDE}`)
    expect(res.status).toBe(200)
    expect(observaciones('info')).toEqual([
      { ipQueDiceElVisitante: BLUMON, ipDelPortero: BLUMON, coinciden: true, decision: 'ACEPTA', cambiariaLaDecision: false },
    ])
    expect(observaciones('warn')).toEqual([])
  })

  it('🔴 un X-Forwarded-For inventado SIGUE pasando en el paso 1 (no cambia nada) y queda anotado en warn', async () => {
    const intruso = '189.203.10.55'
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', intruso)
      .set('X-Forwarded-For', `${BLUMON}, ${intruso}, ${BORDE}`)
    expect(res.status).toBe(200)
    expect(observaciones('warn')).toEqual([
      { ipQueDiceElVisitante: BLUMON, ipDelPortero: intruso, coinciden: false, decision: 'ACEPTA', cambiariaLaDecision: true },
    ])
  })

  it('quien no es Blumon se sigue rechazando con 403 y también queda la observación', async () => {
    const ajeno = '189.203.10.55'
    const res = await request(app())
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', ajeno)
      .set('X-Forwarded-For', `${ajeno}, ${BORDE}`)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ success: false, error: 'Forbidden', message: 'IP not authorized' })
    expect(observaciones('info')).toEqual([
      { ipQueDiceElVisitante: ajeno, ipDelPortero: ajeno, coinciden: true, decision: 'RECHAZA', cambiariaLaDecision: false },
    ])
  })

  it('🔴 la línea que dice QUÉ PAGO emparejó el aviso trae la observación: el paso 2 no depende de unir identificadores', async () => {
    // Codex d1-r1: la observación sale con el correlationId de la petición y el resultado con `blumon-wh-<ms>`; sin
    // esto no se puede saber cuál observación fue de un aviso REAL (emparejó un pago) y cuál de alguien que la inventó.
    ;(servicio.processBlumonPaymentWebhook as jest.Mock).mockResolvedValue({
      success: true,
      action: 'MATCHED',
      paymentId: 'pago-1',
      eventLogId: 'evento-1',
    })
    const a = express()
    a.set('trust proxy', 1)
    a.post('/webhooks/blumon/tpv', express.json(), blumonIPWhitelist, handleBlumonTPVWebhook)

    const res = await request(a)
      .post('/webhooks/blumon/tpv')
      .set('CF-Connecting-IP', BLUMON)
      .set('X-Forwarded-For', `${BLUMON}, ${BORDE}`)
      .send({
        amount: '100.00',
        reference: '260718120000',
        operationNumber: 99000001,
        codeResponse: '00',
        descriptionResponse: 'APROBADA',
        operationType: 'VENTA',
      })

    expect(res.status).toBe(200)
    const procesado = (logger.info as jest.Mock).mock.calls.find(([mensaje]) => mensaje === '📤 Blumon webhook processed')
    expect(procesado?.[1]).toEqual(
      expect.objectContaining({
        action: 'MATCHED',
        paymentId: 'pago-1',
        observacionIp: {
          ipQueDiceElVisitante: BLUMON,
          ipDelPortero: BLUMON,
          coinciden: true,
          decision: 'ACEPTA',
          cambiariaLaDecision: false,
        },
      }),
    )
  })

  it('sin la cabecera de Cloudflare, la IP del portero es la que vio el proxy (req.ip), nunca el primer eslabón', async () => {
    const res = await request(app()).post('/webhooks/blumon/tpv').set('X-Forwarded-For', `${BLUMON}, 198.51.100.50`)
    expect(res.status).toBe(200)
    expect(observaciones('warn')).toEqual([
      { ipQueDiceElVisitante: BLUMON, ipDelPortero: '198.51.100.50', coinciden: false, decision: 'ACEPTA', cambiariaLaDecision: true },
    ])
  })
})
