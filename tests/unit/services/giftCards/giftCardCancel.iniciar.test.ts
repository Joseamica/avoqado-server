/**
 * B2 r1 · la regla única de «Cancelar venta» (`evaluarCancelacionDeVenta`, vista desde `estadoDeCancelacionDeVenta` e
 * `iniciarCancelacionDeVenta`) y el reintento de iniciar, con la base fingida (`prismaMock`). Los candados y la libreta se fingen: aquí
 * se prueba QUÉ decide la regla y en qué orden; la integración (`cancelacion.integration.test.ts`) prueba los candados reales.
 *  - M1: una venta PAGADA con todos sus sobres PENDING de OTRO día no manda al gerente a «sólo el mismo día»: su salida (reembolsar el
 *    cobro, que B1 r2 cierra en $0) no depende del día.
 *  - M2: «reembolsa el cobro, se cancela sola» sólo con TODOS los sobres PENDING (el gancho usa `every`); mezcla ⇒ texto neutro.
 *  - M3: el reintento completo de iniciar con la misma llave ya no responde éxito si esa cancelación se liberó.
 */
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  lockGiftCardsForUpdate: jest.fn().mockResolvedValue([]),
  operarSobreDeGerenteEnTx: jest.fn().mockResolvedValue({ activityIds: ['act-previa'], replay: true }),
  desactivarSobresDeCuentaEnTx: jest.fn().mockResolvedValue(undefined),
  desactivarSobresPendientesDeCuentaEnTx: jest.fn().mockResolvedValue({ desactivados: [] }),
  revertirCanjeEnTx: jest.fn().mockResolvedValue([]),
}))
jest.mock('@/services/giftCards/giftCardMarks', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardMarks'),
  leerSiEsCuentaDeTarjetas: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  lockExistingOrderForPayment: jest.fn().mockResolvedValue(true),
}))

import { claveDeSobre, estadoDeCancelacionDeVenta, iniciarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import { lockGiftCardsForUpdate, operarSobreDeGerenteEnTx } from '@/services/giftCards/giftCardLedger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

type Estado = 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'DEACTIVATED'
const HACE_TRES_DIAS = () => new Date(Date.now() - 72 * 60 * 60 * 1000)
const LLAVE = 'cancelar-venta-0001'

function escenario(e: {
  sobres: Array<{ id: string; status: Estado }>
  cobradoEn?: Date
  canjes?: number
  bloqueos?: Array<{ giftCardId: string; type: 'BLOCK' | 'UNBLOCK'; reason: string }>
  llavesOcupadas?: string[]
}) {
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  prismaMock.orderItem.findMany.mockResolvedValue(e.sobres.map(s => ({ giftCardId: s.id })))
  prismaMock.order.findFirst.mockResolvedValue({ paymentStatus: 'PAID', orderNumber: 'GC-0001' })
  prismaMock.giftCard.findMany.mockResolvedValue(e.sobres)
  prismaMock.$queryRaw.mockResolvedValue((e.bloqueos ?? []).map(b => ({ ...b, note: null, createdAt: new Date() })))
  prismaMock.payment.findFirst.mockResolvedValue({ createdAt: e.cobradoEn ?? new Date() })
  prismaMock.giftCardActivity.count.mockResolvedValue(e.canjes ?? 0)
  prismaMock.giftCardActivity.findMany.mockResolvedValue((e.llavesOcupadas ?? []).map(operationKey => ({ operationKey })))
}

const iniciar = (operationKey = LLAVE) => iniciarCancelacionDeVenta('v1', 'o-gc', { staffId: 's1', operationKey })

describe('M1 · PAGADA con todos sus sobres PENDING: su salida es el reembolso, el día no importa', () => {
  const pendientes = [
    { id: 'cgc1', status: 'PENDING' as const },
    { id: 'cgc2', status: 'PENDING' as const },
  ]

  it('🔴 cobrada hace tres días ⇒ NOT_PAID (no NOT_SAME_DAY) en el detalle del dashboard', async () => {
    escenario({ sobres: pendientes, cobradoEn: HACE_TRES_DIAS() })
    // C4 nota 2: el detalle lleva el MISMO texto que el rechazo de iniciar, así el panel dice la salida (reembolsar el cobro).
    await expect(estadoDeCancelacionDeVenta('v1', 'o-gc', new Date())).resolves.toEqual({
      allowed: false,
      reason: 'NOT_PAID',
      message: expect.stringContaining('reembolsa el cobro'),
    })
  })

  it('🔴 iniciar ⇒ GIFT_CARD_SALE_NOT_PAID con la salida del reembolso (no WINDOW_CLOSED) y nada se bloquea', async () => {
    escenario({ sobres: pendientes, cobradoEn: HACE_TRES_DIAS() })
    const error = await iniciar().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'GIFT_CARD_SALE_NOT_PAID', statusCode: 409 })
    expect((error as Error).message).toMatch(/reembolsa el cobro/)
    expect(operarSobreDeGerenteEnTx).not.toHaveBeenCalled()
  })

  it('la cancelación en curso sigue yendo antes que el día (se libera o se devuelve aunque sea de ayer)', async () => {
    escenario({
      sobres: [{ id: 'cgc1', status: 'BLOCKED' }],
      cobradoEn: HACE_TRES_DIAS(),
      bloqueos: [{ giftCardId: 'cgc1', type: 'BLOCK', reason: 'CANCEL_IN_PROGRESS' }],
    })
    await expect(estadoDeCancelacionDeVenta('v1', 'o-gc', new Date())).resolves.toEqual({
      allowed: false,
      reason: 'IN_PROGRESS',
      message: null,
    })
  })

  it('regresión: una venta con sus sobres ACTIVE de otro día sigue en NOT_SAME_DAY', async () => {
    escenario({ sobres: [{ id: 'cgc1', status: 'ACTIVE' }], cobradoEn: HACE_TRES_DIAS() })
    await expect(estadoDeCancelacionDeVenta('v1', 'o-gc', new Date())).resolves.toEqual({
      allowed: false,
      reason: 'NOT_SAME_DAY',
      message: expect.stringContaining('el mismo día'),
    })
    await expect(iniciar()).rejects.toMatchObject({ code: 'GIFT_CARD_CANCEL_WINDOW_CLOSED' })
  })
})

describe('M2 · el mensaje del reembolso sólo cuando TODOS los sobres están PENDING (el gancho de B1 usa `every`)', () => {
  it('🔴 mezcla PENDING + ACTIVE ⇒ NOT_PAID con un texto neutro que no promete «reembolsa… se cancela sola»', async () => {
    escenario({
      sobres: [
        { id: 'cgc1', status: 'PENDING' },
        { id: 'cgc2', status: 'ACTIVE' },
      ],
    })
    const estado = await estadoDeCancelacionDeVenta('v1', 'o-gc', new Date())
    expect(estado).toEqual({ allowed: false, reason: 'NOT_PAID', message: expect.stringContaining('soporte') })
    expect(estado.message).not.toMatch(/reembolsa|se cancela sola/)
    const error = await iniciar().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'GIFT_CARD_SALE_NOT_PAID', statusCode: 409 })
    expect((error as Error).message).not.toMatch(/reembolsa|se cancela sola/)
    expect(operarSobreDeGerenteEnTx).not.toHaveBeenCalled()
  })
})

describe('M3 · reintento COMPLETO de iniciar con la misma llave: responde según el estado de hoy, no el de entonces', () => {
  const sobres = ['cgc1', 'cgc2']
  const ocupadas = sobres.map(id => claveDeSobre(LLAVE, id))

  it('🔴 la cancelación de esa llave ya se liberó (sobres ACTIVE) ⇒ 409 GIFT_CARD_CANCEL_NOT_STARTED, sin escribir ni registrar', async () => {
    escenario({
      sobres: sobres.map(id => ({ id, status: 'ACTIVE' as const })),
      llavesOcupadas: ocupadas,
      bloqueos: sobres.map(giftCardId => ({ giftCardId, type: 'UNBLOCK' as const, reason: 'CANCEL_IN_PROGRESS' })),
    })
    const error = await iniciar().catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'GIFT_CARD_CANCEL_NOT_STARTED', statusCode: 409 })
    expect((error as Error).message).toMatch(/ya se liberó/)
    expect((error as Error).message).toMatch(/inicia una nueva/)
    // Cada llave ocupada se validó con la libreta (replay), y nada más: ni un BLOCK nuevo ni bitácora.
    expect(operarSobreDeGerenteEnTx).toHaveBeenCalledTimes(2)
    expect((operarSobreDeGerenteEnTx as jest.Mock).mock.calls.every(([, a]) => ocupadas.includes(a.operationKey))).toBe(true)
    expect(logAction).not.toHaveBeenCalled()
    // Bajo el candado de los sobres.
    expect(lockGiftCardsForUpdate).toHaveBeenCalled()
  })

  it('la cancelación sigue en curso ⇒ el reintento devuelve lo mismo, sin escribir ni registrar', async () => {
    escenario({
      sobres: sobres.map(id => ({ id, status: 'BLOCKED' as const })),
      llavesOcupadas: ocupadas,
      bloqueos: sobres.map(giftCardId => ({ giftCardId, type: 'BLOCK' as const, reason: 'CANCEL_IN_PROGRESS' })),
    })
    await expect(iniciar()).resolves.toEqual({ giftCardIds: sobres, bloqueadas: [] })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('la cancelación ya terminó con la devolución (todos DEACTIVATED) ⇒ el reintento devuelve lo mismo', async () => {
    escenario({ sobres: sobres.map(id => ({ id, status: 'DEACTIVATED' as const })), llavesOcupadas: ocupadas })
    await expect(iniciar()).resolves.toEqual({ giftCardIds: sobres, bloqueadas: [] })
    expect(logAction).not.toHaveBeenCalled()
  })
})
