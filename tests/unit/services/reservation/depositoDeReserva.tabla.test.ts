/**
 * D681 · la tabla de transiciones del depósito de una reserva (`decidirTransicion`, pura). Cada fila es una regla que pidió el
 * founder o una ronda de Codex; si alguien la cambia, cambia a propósito.
 */
import { decidirTransicion, vencimientoDeLigaNueva } from '@/services/reservation/depositoDeReserva'

const AHORA = new Date('2026-11-22T21:00:00.000Z')
const enMin = (m: number) => new Date(AHORA.getTime() + m * 60_000)
const estado = (o: Partial<Parameters<typeof decidirTransicion>[0]> = {}) => ({
  status: 'PENDING' as const,
  depositStatus: 'PENDING' as const,
  checkoutSessionId: 'cs_1',
  depositExpiresAt: enMin(20),
  ...o,
})
const pagado = { tipo: 'PAGADO' as const, paymentIntentId: 'pi_1', eventoId: 'evt_1' }

describe('PAGADO', () => {
  it('desde PENDING confirma la reserva y marca pagado', () => {
    const d = decidirTransicion(estado(), pagado, AHORA)
    expect(d).toMatchObject({ tipo: 'APLICAR', data: { status: 'CONFIRMED', depositStatus: 'PAID', depositProcessorRef: 'pi_1' } })
  })
  it.each(['CHECKED_IN', 'COMPLETED', 'CONFIRMED', 'NO_SHOW'] as const)(
    'desde %s sólo marca pagado (r2 #2: no regresa a quien llegó)',
    status => {
      const d = decidirTransicion(estado({ status }), pagado, AHORA)
      expect(d.tipo).toBe('APLICAR')
      expect((d as any).data.status).toBeUndefined()
      expect((d as any).data.depositStatus).toBe('PAID')
    },
  )
  it('desde CANCELLED es anomalía (nunca revive)', () => {
    expect(decidirTransicion(estado({ status: 'CANCELLED' }), pagado, AHORA)).toEqual({ tipo: 'RECHAZO', motivo: 'CANCELADA' })
  })
  it('con el depósito vencido es anomalía', () => {
    expect(decidirTransicion(estado({ status: 'CANCELLED', depositStatus: 'EXPIRED' }), pagado, AHORA).tipo).toBe('RECHAZO')
  })
  it('ya pagado: no cambia nada (aviso repetido)', () => {
    expect(decidirTransicion(estado({ status: 'CONFIRMED', depositStatus: 'PAID' }), pagado, AHORA)).toEqual({ tipo: 'IGUAL' })
  })
})

describe('VENCIDO', () => {
  const vencido = { tipo: 'VENCIDO' as const, sesionId: 'cs_1', motivo: 'x' }
  it('sólo desde PENDING sin pagar cancela y vence', () => {
    expect(decidirTransicion(estado(), vencido, AHORA)).toMatchObject({
      tipo: 'APLICAR',
      data: { status: 'CANCELLED', depositStatus: 'EXPIRED' },
    })
  })
  it.each(['CONFIRMED', 'CHECKED_IN', 'CANCELLED'] as const)('desde %s sólo cierra el depósito', status => {
    expect(decidirTransicion(estado({ status }), vencido, AHORA)).toEqual({ tipo: 'APLICAR', data: { depositStatus: 'EXPIRED' } })
  })
  it('una liga que ya no es la de la reserva no la toca', () => {
    expect(decidirTransicion(estado({ checkoutSessionId: 'cs_2' }), vencido, AHORA)).toEqual({ tipo: 'IGUAL' })
  })
  it('ya pagada: no la toca', () => {
    expect(decidirTransicion(estado({ depositStatus: 'PAID', status: 'CONFIRMED' }), vencido, AHORA)).toEqual({ tipo: 'IGUAL' })
  })
})

describe('LIGA_CREADA', () => {
  const liga = (venceEn = enMin(20)) => ({ tipo: 'LIGA_CREADA' as const, sesionId: 'cs_nueva', venceEn, merchantId: 'm1' })
  it('primera liga de un apartado', () => {
    expect(decidirTransicion(estado({ checkoutSessionId: null }), liga(), AHORA).tipo).toBe('APLICAR')
  })
  it('nunca dos ligas abiertas para el mismo depósito', () => {
    expect(decidirTransicion(estado(), liga(), AHORA)).toEqual({ tipo: 'RECHAZO', motivo: 'LIGA_ABIERTA' })
  })
  it('r2 #4: nunca alarga el apartado más allá de su vencimiento original', () => {
    expect(decidirTransicion(estado({ checkoutSessionId: null }), liga(enMin(50)), AHORA)).toEqual({
      tipo: 'RECHAZO',
      motivo: 'APARTADO_VENCIDO',
    })
    expect(decidirTransicion(estado({ checkoutSessionId: null, depositExpiresAt: enMin(-1) }), liga(enMin(30)), AHORA)).toEqual({
      tipo: 'RECHAZO',
      motivo: 'APARTADO_VENCIDO',
    })
  })
  it('r2 #5: el depósito null de «pagar al llegar» es una entrada válida (reserva confirmada)', () => {
    const d = decidirTransicion(
      estado({ status: 'CONFIRMED', depositStatus: null, checkoutSessionId: null, depositExpiresAt: null }),
      liga(enMin(31)),
      AHORA,
    )
    expect(d).toMatchObject({ tipo: 'APLICAR', data: { depositStatus: 'PENDING', checkoutSessionId: 'cs_nueva' } })
  })
  it('cancelada o pagada no acepta liga', () => {
    expect(decidirTransicion(estado({ status: 'CANCELLED' }), liga(), AHORA)).toEqual({ tipo: 'RECHAZO', motivo: 'CANCELADA' })
    expect(decidirTransicion(estado({ status: 'CONFIRMED', depositStatus: 'PAID' }), liga(), AHORA)).toEqual({
      tipo: 'RECHAZO',
      motivo: 'PAGADA',
    })
  })
})

describe('CANCELADA (en la transacción de cancelar)', () => {
  it('cierra el depósito sin pagar de la liga que ya se cerró en Stripe', () => {
    expect(decidirTransicion(estado({ status: 'CANCELLED' }), { tipo: 'CANCELADA', sesionCerrada: 'cs_1' }, AHORA)).toEqual({
      tipo: 'APLICAR',
      data: { depositStatus: 'EXPIRED' },
    })
  })
  it('si apareció otra liga mientras tanto, no', () => {
    expect(
      decidirTransicion(estado({ status: 'CANCELLED', checkoutSessionId: 'cs_2' }), { tipo: 'CANCELADA', sesionCerrada: 'cs_1' }, AHORA),
    ).toEqual({
      tipo: 'RECHAZO',
      motivo: 'LIGA_ABIERTA',
    })
  })
})

describe('RETENIDO · DEVUELTO · RESTAURADO', () => {
  it('retener exige el estado que lo justifica', () => {
    const pagada = estado({ status: 'NO_SHOW', depositStatus: 'PAID' })
    expect(decidirTransicion(pagada, { tipo: 'RETENIDO', por: 'NO_SHOW' }, AHORA).tipo).toBe('APLICAR')
    expect(decidirTransicion(pagada, { tipo: 'RETENIDO', por: 'CANCELLED' }, AHORA).tipo).toBe('RECHAZO')
  })
  it('devolver sólo un depósito pagado', () => {
    expect(
      decidirTransicion(estado({ status: 'CANCELLED', depositStatus: 'PAID' }), { tipo: 'DEVUELTO', devueltoEn: AHORA }, AHORA),
    ).toMatchObject({
      tipo: 'APLICAR',
      data: { depositStatus: 'REFUNDED' },
    })
  })
  it('«Sí llegó» devuelve el retenido a pagado', () => {
    expect(decidirTransicion(estado({ status: 'CHECKED_IN', depositStatus: 'FORFEITED' }), { tipo: 'RESTAURADO' }, AHORA)).toEqual({
      tipo: 'APLICAR',
      data: { depositStatus: 'PAID' },
    })
  })
})

describe('vencimientoDeLigaNueva', () => {
  it('un apartado conserva su vencimiento original', () => {
    expect(vencimientoDeLigaNueva({ status: 'PENDING', depositExpiresAt: enMin(120) }, AHORA)).toEqual(enMin(120))
  })
  it('si vence antes de lo que Stripe deja abrir una liga, no hay liga', () => {
    expect(vencimientoDeLigaNueva({ status: 'PENDING', depositExpiresAt: enMin(10) }, AHORA)).toBeNull()
  })
  it('una reserva confirmada («paga al llegar») abre una liga normal', () => {
    expect(vencimientoDeLigaNueva({ status: 'CONFIRMED', depositExpiresAt: null }, AHORA)!.getTime()).toBeGreaterThan(enMin(30).getTime())
  })
})
