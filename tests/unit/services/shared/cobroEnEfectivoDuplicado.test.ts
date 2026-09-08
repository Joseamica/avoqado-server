import { Decimal } from '@prisma/client/runtime/library'
import {
  aplicaCandadoDeEfectivo,
  cobroEnEfectivoSobreOrdenSaldada,
  VENTANA_DE_RAFAGA_MS,
  type PagoPrevio,
} from '@/services/shared/cobroEnEfectivoDuplicado'

const ORDEN_CERO = { subtotal: new Decimal(0), discountAmount: null, serviceChargeAmount: null }
const ORDEN_100 = { subtotal: new Decimal(100), discountAmount: null, serviceChargeAmount: null }

/** El instante en que llega el cobro entrante. Fijo: la regla recibe el reloj por parámetro. */
const AHORA = new Date('2026-09-04T00:18:10Z')

function pago(id: string, amount: number, extra: Partial<PagoPrevio> = {}): PagoPrevio {
  return {
    id,
    amount: new Decimal(amount),
    tipAmount: new Decimal(0),
    type: 'REGULAR',
    method: 'CASH',
    terminalId: 'term-A',
    createdAt: new Date('2026-09-04T00:18:08Z'),
    // Por default el cobro previo es de un APK viejo: SIN llave. Es el lado en el que la
    // heurística tiene algo que hacer; los casos con llave la ponen explícita.
    idempotencyKey: null,
    ...extra,
  }
}

/**
 * El cobro entrante de la evidencia: efectivo de $0 sin propina, desde la MISMA PAX y **sin
 * llave de idempotencia** — así llegaban los cinco cobros de SN00396, y es la única forma en
 * la que esta heurística tiene algo que hacer (con llave manda la identidad exacta).
 */
const CANDIDATO_CASH = {
  method: 'CASH',
  status: 'COMPLETED',
  hasAreaTicketLines: false,
  amount: 0,
  tip: 0,
  terminalId: 'term-A',
  idempotencyKey: null,
}

describe('cobroEnEfectivoSobreOrdenSaldada — la regla que separa un toque repetido de un cobro legítimo', () => {
  it('orden de $0 SIN cobros previos: el primer cobro de una línea gratis se registra (null)', () => {
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [], AHORA)).toBeNull()
  })

  it('orden de $0 con UN cobro previo en efectivo: el segundo es el toque repetido → devuelve el previo', () => {
    const previo = pago('pay-prev', 0)
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBe(previo)
  })

  it('orden de $100 ya cubierta con $100 en efectivo: otro efectivo del MISMO monto devuelve el previo', () => {
    const previo = pago('pay-prev', 100)
    expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100 }, ORDEN_100, [previo], AHORA)).toBe(previo)
  })

  it('partes iguales: $50 de $100 pagados, el segundo $50 en efectivo es legítimo (null)', () => {
    expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 50 }, ORDEN_100, [pago('p1', 50)], AHORA)).toBeNull()
  })

  it('TARJETA sobre una orden saldada NUNCA se deduplica: el dinero ya se movió en el banco (null)', () => {
    const candidatoTarjeta = { ...CANDIDATO_CASH, method: 'CREDIT_CARD', amount: 100 }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidatoTarjeta, ORDEN_100, [pago('p1', 100, { method: 'CREDIT_CARD' })], AHORA)).toBeNull()
  })

  it('tras un REEMBOLSO total, volver a cobrar en efectivo es legítimo (null)', () => {
    const cobro = pago('p1', 100)
    const reembolso = pago('r1', -100, { type: 'REFUND' })
    expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100 }, ORDEN_100, [cobro, reembolso], AHORA)).toBeNull()
  })

  it('con vales por área (areaTicketLines) no interviene: ese submódulo tiene su propio candado (null)', () => {
    const candidato = { ...CANDIDATO_CASH, hasAreaTicketLines: true }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidato, ORDEN_CERO, [pago('p1', 0)], AHORA)).toBeNull()
  })

  it('un cobro que no es COMPLETED no se deduplica (null)', () => {
    const candidato = { ...CANDIDATO_CASH, status: 'PENDING' }
    expect(cobroEnEfectivoSobreOrdenSaldada(candidato, ORDEN_CERO, [pago('p1', 0)], AHORA)).toBeNull()
  })

  it('devuelve el cobro en EFECTIVO más reciente, no un cobro con tarjeta de la misma orden', () => {
    const tarjeta = pago('tarjeta', 100, { method: 'CREDIT_CARD', createdAt: new Date('2026-09-04T00:18:10Z') })
    const efectivo = pago('efectivo', 0, { createdAt: new Date('2026-09-04T00:18:08Z') })
    expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_100, [tarjeta, efectivo], AHORA)).toBe(efectivo)
  })

  // ── Regresión propia: un reembolso PARCIAL también reabre la puerta ─────────
  // Mismo razonamiento que el reembolso total. El saldo de ESTA regla es el del
  // diagnóstico —`total − cobrado + reembolsado`—, no el `isFullyPaid` de
  // `computeOrderBalance`, que por decisión del founder NO reabre saldo. Con
  // `isFullyPaid` esta orden se leería como saldada y un cobro real se perdería.
  it('tras un reembolso PARCIAL, cobrar de nuevo en efectivo es legítimo (null)', () => {
    const cobro = pago('p1', 100)
    const reembolso = pago('r1', -40, { type: 'REFUND' })
    expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100 }, ORDEN_100, [cobro, reembolso], AHORA)).toBeNull()
  })

  // ── RONDA 2 — «firma de ráfaga» (auditoría de Codex, P1-1) ────────────────────────
  // «Saldo cubierto» a secas confunde DOS entregas físicas de efectivo distintas: una fila
  // encolada que se reproduce horas después, sobre una orden que OTRA terminal ya cobró,
  // se leería como un toque repetido y esos $100 desaparecerían del turno y del cajón. La
  // regla ahora exige la firma completa de una ráfaga: mismo dinero, misma terminal y
  // dentro de la ventana. Fuera de eso el cobro SE REGISTRA y el sobrepago lo vigila el
  // watchdog — visible y reparable, en vez de invisible.
  describe('firma de ráfaga: mismo dinero, misma terminal, dentro de la ventana', () => {
    it('misma terminal, mismo monto y propina, hace 30 s: es la ráfaga → devuelve el previo', () => {
      const previo = pago('p1', 0, { terminalId: 'term-A', createdAt: new Date('2026-09-04T00:17:40Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBe(previo)
    })

    it('el cobro previo tiene 16 minutos: ya no es un toque repetido, se registra (null)', () => {
      const previo = pago('p1', 0, { terminalId: 'term-A', createdAt: new Date('2026-09-04T00:02:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBeNull()
    })

    it('otra terminal cobró la misma orden: no se deduplica (el sobrepago lo vigila el watchdog) (null)', () => {
      const previo = pago('p1', 0, { terminalId: 'term-B', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBeNull()
    })

    it('si alguno de los dos no trae terminal (APK viejo sin serial), la terminal no descalifica', () => {
      const previo = pago('p1', 0, { terminalId: null, createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBe(previo)
    })

    it('monto distinto al del efectivo previo: no es el mismo toque (null)', () => {
      const previo = pago('p1', 100, { terminalId: 'term-A', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 60 }, ORDEN_100, [previo], AHORA)).toBeNull()
    })

    it('propina sola (amount 0, tip 20) sobre una orden saldada con 100/0: no se deduplica (null)', () => {
      const previo = pago('p1', 100, { terminalId: 'term-A', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 0, tip: 20 }, ORDEN_100, [previo], AHORA)).toBeNull()
    })

    it('la propina también entra en la firma: mismo importe pero propina distinta NO es el mismo toque (null)', () => {
      const previo = pago('p1', 100, { tipAmount: new Decimal(10), createdAt: new Date('2026-09-04T00:18:00Z') })
      // total = 100 de mercancía + 10 de propina cobrada = 110; pagado = 110 ⇒ saldada.
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100, tip: 25 }, ORDEN_100, [previo], AHORA)).toBeNull()
    })

    it('el borde de la ventana (exactamente 15 min) todavía cuenta como ráfaga', () => {
      const previo = pago('p1', 0, { createdAt: new Date(AHORA.getTime() - VENTANA_DE_RAFAGA_MS) })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBe(previo)
    })

    it('un cobro previo SIN fecha no puede demostrar la ventana: no se deduplica (null)', () => {
      const previo = pago('p1', 0, { createdAt: undefined })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBeNull()
    })
  })

  // ── RONDA 3 + 4 — identidad exacta del dinero, ventana sin futuro, y la LLAVE ────────────
  // La ronda 3 apagaba la heurística entera en cuanto el cobro entrante traía `idempotencyKey`.
  // La 3ª auditoría de Codex mostró que ese gate abre una ráfaga MIXTA: una sola entrega de
  // $100 que produce dos peticiones —A sin llave, B con llave— deja DOS cobros, porque B salta
  // la heurística y su llave no existe todavía en la base. La regla de la ronda 4 no mira si el
  // ENTRANTE trae llave, sino si los DOS lados la traen: dos cobros con llave son dos intentos
  // lógicos distintos y nunca se deduplican por heurística (ahí manda `@@unique([venueId,
  // idempotencyKey])`); en cuanto a uno de los dos le falta, la identidad exacta no existe y la
  // firma de la ráfaga vuelve a ser la única defensa.
  describe('la llave: se deduplica sólo si a alguno de los dos lados le falta', () => {
    it('entrante CON llave contra un previo CON llave: son dos intentos lógicos distintos (null)', () => {
      const previo = pago('p1', 0, { idempotencyKey: 'k-previa', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, idempotencyKey: 'k-nueva' }, ORDEN_CERO, [previo], AHORA)).toBeNull()
    })

    it('entrante CON llave contra un previo SIN llave, misma firma a 30 s: es la ráfaga mixta → devuelve el previo', () => {
      const previo = pago('p1', 0, { idempotencyKey: null, createdAt: new Date('2026-09-04T00:17:40Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, idempotencyKey: 'k-nueva' }, ORDEN_CERO, [previo], AHORA)).toBe(previo)
    })

    it('entrante SIN llave contra un previo CON llave, misma firma: también es la ráfaga mixta → devuelve el previo', () => {
      const previo = pago('p1', 0, { idempotencyKey: 'k-previa', createdAt: new Date('2026-09-04T00:17:40Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBe(previo)
    })

    it('entre varios previos elige el que puede deduplicarse: el de la llave queda fuera', () => {
      const conLlave = pago('con-llave', 0, { idempotencyKey: 'k-previa', createdAt: new Date('2026-09-04T00:18:05Z') })
      const sinLlave = pago('sin-llave', 0, { idempotencyKey: null, createdAt: new Date('2026-09-04T00:17:40Z') })
      const entrante = { ...CANDIDATO_CASH, idempotencyKey: 'k-nueva' }
      expect(cobroEnEfectivoSobreOrdenSaldada(entrante, ORDEN_CERO, [conLlave, sinLlave], AHORA)).toBe(sinLlave)
    })

    it('el candado APLICA aunque el cobro traiga llave: el filtro por llave vive en la firma, no aquí', () => {
      // 🔴 El precio de esta decisión, declarado: un cobro en efectivo CON llave paga ahora la
      // consulta de los cobros previos y la relectura de la orden dentro de la transacción. Se
      // acepta porque es sólo efectivo; la TARJETA sigue saliendo antes de tocar la base.
      expect(aplicaCandadoDeEfectivo({ ...CANDIDATO_CASH, idempotencyKey: 'k-nueva' })).toBe(true)
      expect(aplicaCandadoDeEfectivo(CANDIDATO_CASH)).toBe(true)
      expect(aplicaCandadoDeEfectivo({ ...CANDIDATO_CASH, method: 'CREDIT_CARD' })).toBe(false)
    })
  })

  describe('identidad exacta del dinero y ventana sin futuro', () => {
    it('un centavo de diferencia NO es el mismo dinero (null)', () => {
      const previo = pago('p1', 100, { terminalId: 'term-A', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100.01 }, ORDEN_100, [previo], AHORA)).toBeNull()
    })

    it('un centavo de diferencia en la PROPINA tampoco es el mismo dinero (null)', () => {
      const previo = pago('p1', 100, { tipAmount: new Decimal(10), terminalId: 'term-A', createdAt: new Date('2026-09-04T00:18:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada({ ...CANDIDATO_CASH, amount: 100, tip: 10.01 }, ORDEN_100, [previo], AHORA)).toBeNull()
    })

    it('un cobro previo con fecha FUTURA no demuestra la ventana (null)', () => {
      const previo = pago('p1', 0, { terminalId: 'term-A', createdAt: new Date('2026-09-05T00:00:00Z') })
      expect(cobroEnEfectivoSobreOrdenSaldada(CANDIDATO_CASH, ORDEN_CERO, [previo], AHORA)).toBeNull()
    })
  })
})
