/**
 * 1b S4: las banderas del detalle de la cuenta en el POS (Q16) y la regla de Q102 —el código sólo sale con su renglón
 * `GIFT_CARD_CODE_REVEALED` YA guardado en su transacción, y se descifra después del commit—. Lo demás (reenviar, cambiar el
 * destino, los candados) se prueba contra Postgres en `tests/integration/giftCards/reenviarYRevelar.integration.test.ts`.
 */
jest.mock('@/services/giftCards/giftCardCode', () => {
  const real = jest.requireActual('@/services/giftCards/giftCardCode')
  return { ...real, decryptGiftCardCode: jest.fn(real.decryptGiftCardCode) }
})
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))

import { decryptGiftCardCode, encryptGiftCardCode, generateGiftCardCode } from '@/services/giftCards/giftCardCode'
import { logAction } from '@/services/dashboard/activity-log.service'
import { registrarSalidaDelSecreto } from '@/services/giftCards/giftCardSurface.service'
import {
  accionesSobreLaTarjeta,
  revelarCodigo,
  revelarCodigosDeLaCuenta,
  type QuienPregunta,
} from '@/services/giftCards/giftCardCuenta.service'
import { prismaMock } from '../../../__helpers__/setup'

const ZONA = 'America/Mexico_City'
/** «Otro día» en la zona del negocio: 23:59 del 19 y 00:01 del 20 (UTC−6). */
const AHORA = new Date('2026-10-20T06:01:00Z')
const AYER = new Date('2026-10-20T05:59:00Z')
const HOY = new Date('2026-10-20T06:00:30Z')

const CAJERO: QuienPregunta = { staffId: 's-caja', puedeVender: true, puedeGestionar: false }
const GERENTE: QuienPregunta = { staffId: 's-gerente', puedeVender: true, puedeGestionar: true }
const SOLO_LECTURA: QuienPregunta = { staffId: 's-mira', puedeVender: false, puedeGestionar: false }

const tarjeta = (over: Partial<Parameters<typeof accionesSobreLaTarjeta>[1]> = {}): Parameters<typeof accionesSobreLaTarjeta>[1] => ({
  status: 'ACTIVE',
  expiresAt: null,
  activatedAt: HOY,
  deliveryChannel: 'WHATSAPP',
  usada: false,
  customerId: null,
  ...over,
})

describe('accionesSobreLaTarjeta (Q16)', () => {
  const de = (quien: QuienPregunta, t: ReturnType<typeof tarjeta>) => {
    const a = accionesSobreLaTarjeta(quien, t, AHORA, ZONA)
    return {
      admite: [a.puedeReenviar, a.puedeCambiarDestino, a.puedeRevelar],
      cambiarPideGerente: a.cambiarDestinoPideGerente,
      revelarPideGerente: a.revelarPideGerente,
    }
  }

  it('cajero (sell), WhatsApp, mismo día, sin usar: admite las tres; cambiar pide gerente, revelar no', () => {
    expect(de(CAJERO, tarjeta())).toEqual({ admite: [true, true, true], cambiarPideGerente: true, revelarPideGerente: false })
  })

  it('cajero, otro día: revelar también pide gerente', () => {
    expect(de(CAJERO, tarjeta({ activatedAt: AYER }))).toEqual({
      admite: [true, true, true],
      cambiarPideGerente: true,
      revelarPideGerente: true,
    })
  })

  it('gerente (sell + manage), otro día: no pide gerente para nada', () => {
    expect(de(GERENTE, tarjeta({ activatedAt: AYER }))).toEqual({
      admite: [true, true, true],
      cambiarPideGerente: false,
      revelarPideGerente: false,
    })
  })

  it.each([
    ['usada', { usada: true }],
    ['guardada en la cartera de un cliente', { customerId: 'cliente-1' }],
  ])('%s: se reenvía y se revela, pero el destino no se cambia', (_caso, over) => {
    for (const quien of [CAJERO, GERENTE]) expect(de(quien, tarjeta(over)).admite).toEqual([true, false, true])
  })

  it('PRINTED sin usar: no se reenvía (no hay a dónde), pero el destino sí se cambia y se revela', () => {
    expect(de(CAJERO, tarjeta({ deliveryChannel: 'PRINTED' })).admite).toEqual([false, true, true])
  })

  it.each([
    ['BLOCKED', { status: 'BLOCKED' as const }],
    ['vencida', { expiresAt: new Date('2026-10-19T00:00:00Z') }],
    ['PENDING', { status: 'PENDING' as const, activatedAt: null }],
  ])('%s: nada', (_caso, over) => {
    for (const quien of [CAJERO, GERENTE]) expect(de(quien, tarjeta(over)).admite).toEqual([false, false, false])
  })

  it('sólo read, WhatsApp, mismo día: admite las tres, pero cambiar y revelar piden gerente', () => {
    expect(de(SOLO_LECTURA, tarjeta())).toEqual({ admite: [true, true, true], cambiarPideGerente: true, revelarPideGerente: true })
  })
})

describe('Q102: registrarSalidaDelSecreto', () => {
  beforeEach(() => jest.clearAllMocks())

  it('escribe con createMany tal cual (Staff.id sin normalizar) y la data sin secretos', async () => {
    const db = { activityLog: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    await registrarSalidaDelSecreto(db as any, [
      {
        venueId: 'v1',
        staffId: 'cl9caja0000000000000000000',
        action: 'GIFT_CARD_CODE_REVEALED',
        entity: 'GiftCard',
        entityId: 'g1',
        data: { operationKey: 'revela-0001', motivo: 'REPRINT', ruta: 'r' },
        ipAddress: '10.0.0.1',
      },
    ])
    expect(db.activityLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          venueId: 'v1',
          staffId: 'cl9caja0000000000000000000',
          action: 'GIFT_CARD_CODE_REVEALED',
          entity: 'GiftCard',
          entityId: 'g1',
          data: { operationKey: 'revela-0001', motivo: 'REPRINT', ruta: 'r' },
          ipAddress: '10.0.0.1',
          userAgent: null,
        },
      ],
    })
  })

  it('🔴 si createMany rechaza, lanza EL MISMO error (no lo traga) y nunca cae a logAction', async () => {
    const fallo = new Error('ActivityLog_staffId_fkey')
    const db = { activityLog: { createMany: jest.fn().mockRejectedValue(fallo) } }
    await expect(
      registrarSalidaDelSecreto(db as any, [
        { venueId: 'v1', staffId: 's', action: 'GIFT_CARD_CODE_REVEALED', entity: 'GiftCard', entityId: 'g1', data: {} },
      ]),
    ).rejects.toBe(fallo)
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('Q102: el código sólo sale con su renglón guardado', () => {
  const codigo = generateGiftCardCode()
  const SECRETO = { codeEnc: encryptGiftCardCode(codigo.normalized), pageToken: 'liga-secreta-0123456789abcdef' }
  const AUDITORIA = { staffId: 's-caja', ruta: 'POST /prueba' }
  const bloqueada = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    venueId: 'v1',
    codeHash: 'h',
    pageToken: SECRETO.pageToken,
    recipientPhone: null,
    deliveryChannel: 'PRINTED',
    status: 'ACTIVE',
    balance: 500,
    initialAmount: 500,
    expiresAt: null,
    activatedAt: HOY,
    validityMonths: null,
    customerId: null,
    ...over,
  })
  const fila = {
    id: 'g1',
    ...SECRETO,
    codeLast4: codigo.last4,
    initialAmount: 500,
    balance: 500,
    expiresAt: null,
    termsVersion: '2026-10-14',
    recipientName: 'Ana',
    purchaserName: 'Luis',
    message: null,
  }
  let orden: string[]
  let tx: any

  function armar(createMany: jest.Mock, lock = [bloqueada()]) {
    orden = []
    tx = {
      $queryRaw: jest.fn().mockResolvedValue(lock),
      giftCard: { findUnique: jest.fn().mockResolvedValue(fila), findMany: jest.fn().mockResolvedValue([fila]) },
      order: {
        findFirst: jest.fn().mockResolvedValue({ items: [{ giftCard: { id: 'g1' } }], _count: { items: 0 } }),
      },
      activityLog: { createMany },
    }
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: ZONA })
    prismaMock.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
      const r = await cb(tx)
      orden.push('commit')
      return r
    })
    ;(decryptGiftCardCode as jest.Mock).mockClear()
    ;(decryptGiftCardCode as jest.Mock).mockImplementation((enc: string) => {
      orden.push('descifrar')
      return jest.requireActual('@/services/giftCards/giftCardCode').decryptGiftCardCode(enc)
    })
  }

  const revelar: Record<string, (quien?: QuienPregunta) => Promise<unknown>> = {
    revelarCodigo: (quien = CAJERO) =>
      revelarCodigo('v1', 'g1', quien, { operationKey: 'revela-0001', motivo: 'REPRINT', comoGerente: false, auditoria: AUDITORIA }, AHORA),
    revelarCodigosDeLaCuenta: (quien = CAJERO) =>
      revelarCodigosDeLaCuenta('v1', 'o1', quien, { operationKey: 'imprime-0001', auditoria: AUDITORIA }, AHORA),
  }

  it.each(Object.keys(revelar))('🔴 si la bitácora falla no sale el secreto (%s)', async nombre => {
    armar(jest.fn().mockRejectedValue(new Error('la base no contestó')))
    const error: any = await revelar[nombre]().catch(e => e)
    expect(error.statusCode).toBe(503)
    expect(error.message).toBe('No se pudo mostrar el código. Intenta otra vez.')
    expect(decryptGiftCardCode).not.toHaveBeenCalled()
    const todo = JSON.stringify({ message: error.message, details: error.details })
    expect(todo).not.toContain(codigo.display)
    expect(todo).not.toContain(SECRETO.pageToken)
    expect(todo).not.toContain('/tarjeta/')
  })

  it.each(Object.keys(revelar))('con éxito el renglón va en la transacción y se descifra después (%s)', async nombre => {
    armar(jest.fn().mockImplementation(async () => void orden.push('renglon')))
    const r = JSON.stringify(await revelar[nombre]())
    expect(orden).toEqual(['renglon', 'commit', 'descifrar'])
    expect(r).toContain(codigo.display)
    const [{ data }] = tx.activityLog.createMany.mock.calls[0]
    expect(data).toEqual([
      expect.objectContaining({
        action: 'GIFT_CARD_CODE_REVEALED',
        entityId: 'g1',
        staffId: 's-caja',
        data: expect.objectContaining({ motivo: nombre === 'revelarCodigo' ? 'REPRINT' : 'PRINT', ruta: 'POST /prueba' }),
      }),
    ])
    expect(JSON.stringify(data)).not.toContain(codigo.display)
    expect(JSON.stringify(data)).not.toContain(SECRETO.pageToken)
  })

  it.each(Object.keys(revelar))('un 403 de otro día sigue siendo 403, no 503, y no escribe renglón (%s)', async nombre => {
    armar(jest.fn(), [bloqueada({ activatedAt: AYER })])
    await expect(revelar[nombre]()).rejects.toMatchObject({ statusCode: 403, code: 'GIFT_CARD_REVEAL_NOT_ALLOWED' })
    expect(tx.activityLog.createMany).not.toHaveBeenCalled()
    expect(decryptGiftCardCode).not.toHaveBeenCalled()
  })

  it('revelarCodigo: el gerente de verdad revela otro día por `reveal`; `reveal-manager` (comoGerente) revela a cualquiera', async () => {
    armar(jest.fn().mockResolvedValue({ count: 1 }), [bloqueada({ activatedAt: AYER })])
    await expect(revelar.revelarCodigo(GERENTE)).resolves.toMatchObject({ codigo: codigo.display })
    armar(jest.fn().mockResolvedValue({ count: 1 }), [bloqueada({ activatedAt: AYER })])
    await expect(
      revelarCodigo('v1', 'g1', CAJERO, { operationKey: 'revela-0002', motivo: 'SHOW_QR', comoGerente: true, auditoria: AUDITORIA }, AHORA),
    ).resolves.toMatchObject({ codigo: codigo.display })
  })
})
