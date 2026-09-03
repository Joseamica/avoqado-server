/**
 * Task 5r — la definición ÚNICA de «cuánto se ha devuelto ya de este cobro».
 *
 * El defecto que la obliga a existir: los dos rieles que escriben
 * `Payment.processorData.refundedAmount` lo medían sobre bases DISTINTAS.
 *
 *   · `refund.tpv.service` acumulaba el TOTAL devuelto (venta + propina);
 *   · `refund.dashboard.service` sumaba sólo `Math.abs(amount)` de los reembolsos previos
 *     —o sea SIN la propina ya devuelta— y comparaba ese número contra `amount + tipAmount`.
 *
 * Cobro de $100 + $20 de propina = $120. Dos reembolsos de $60 por el dashboard: el segundo
 * sólo «ve» los $50 de venta del primero, pasa, y persiste $110 cuando ya salieron $120. Un
 * tercer reembolso POR LA TERMINAL lee esos 110, cree que quedan 10, y saca $130 sobre $120.
 *
 * Estas pruebas fijan la regla y sus dos guardas. Si alguien invierte la definición
 * («refundedAmount es sólo la venta»), la primera de este archivo falla.
 */
import {
  acumuladoPersistido,
  centavosDevueltosDeFilas,
  centavosDevueltosDeclarados,
  centavosYaDevueltos,
} from '@/services/shared/devueltoDeUnCobro'

/** Un reembolso se guarda NEGATIVO en las dos columnas. */
const reembolso = (venta: number, propina: number) => ({ amount: venta, tipAmount: propina })

describe('Task 5r — devueltoDeUnCobro: la propina devuelta CUENTA como devuelta', () => {
  describe('centavosDevueltosDeFilas', () => {
    it('🔴 suma venta + propina de cada reembolso, en valor absoluto', () => {
      // Dos reembolsos de $60 sobre un cobro de $100 + $20: $120 devueltos, no $100.
      // Con la regla vieja (sólo `amount`) esto daba 10000 y dejaba $20 «disponibles»
      // que ya se le habían entregado al cliente.
      expect(centavosDevueltosDeFilas([reembolso(-50, -10), reembolso(-50, -10)])).toBe(12000)
    })

    it('sin reembolsos es 0', () => {
      expect(centavosDevueltosDeFilas([])).toBe(0)
    })

    it('una propina nula es una fila normal: cuenta como 0, no revienta', () => {
      expect(centavosDevueltosDeFilas([{ amount: -50, tipAmount: null }])).toBe(5000)
    })

    it('redondea CADA monto antes de sumar: no arrastra el error de punto flotante', () => {
      // 0.1 + 0.2 en pesos daría 30.000000000000004 centavos.
      expect(centavosDevueltosDeFilas([reembolso(-0.1, -0.2)])).toBe(30)
    })

    it('🔴 una fila SIN la llave `tipAmount` revienta en vez de contarla como 0', () => {
      // Es el defecto original vestido de descuido: recortar la columna del `SELECT`
      // devuelve el acumulado a la semántica vieja EN SILENCIO. Mismo criterio que la
      // guarda de columnas del candado de `refund.tpv.service.ts` (commit 4a52652b):
      // se mira la LLAVE, no el valor, porque `null` es una fila legítima.
      expect(() => centavosDevueltosDeFilas([{ amount: -50 } as never])).toThrow(/tipAmount/)
    })

    it('🔴 una fila SIN la llave `amount` revienta', () => {
      expect(() => centavosDevueltosDeFilas([{ tipAmount: 0 } as never])).toThrow(/amount/)
    })
  })

  describe('centavosDevueltosDeclarados', () => {
    it('prefiere los CENTAVOS enteros cuando están', () => {
      expect(centavosDevueltosDeclarados({ refundedAmount: 119.99999, refundedAmountCents: 12000 })).toBe(12000)
    })

    it('cae a los pesos cuando no hay centavos (filas escritas antes de que existiera el campo)', () => {
      expect(centavosDevueltosDeclarados({ refundedAmount: 120 })).toBe(12000)
    })

    it('acepta el número guardado como cadena: hay filas así en la calle', () => {
      expect(centavosDevueltosDeclarados({ refundedAmount: '60.50' })).toBe(6050)
    })

    it('un cobro sin reembolsos —llave ausente o nula— es 0', () => {
      expect(centavosDevueltosDeclarados({})).toBe(0)
      expect(centavosDevueltosDeclarados({ refundedAmount: null })).toBe(0)
      expect(centavosDevueltosDeclarados(null)).toBe(0)
    })

    it('🔴 un acumulado presente pero ILEGIBLE revienta, no vale 0', () => {
      // Hoy `Number('vaya')` es NaN y `refundAmountInPesos > NaN` es **false**: un acumulado
      // corrupto dejaba pasar TODOS los reembolsos. Reventar es el lado seguro — un rechazo
      // sistemático se nota en minutos; devolver de más no se nota nunca.
      expect(() => centavosDevueltosDeclarados({ refundedAmount: 'vaya' })).toThrow()
      expect(() => centavosDevueltosDeclarados({ refundedAmountCents: Number.NaN })).toThrow()
    })

    it('un acumulado negativo se trata como 0: nunca puede AGRANDAR lo que queda por devolver', () => {
      expect(centavosDevueltosDeclarados({ refundedAmountCents: -500 })).toBe(0)
    })
  })

  describe('centavosYaDevueltos — el conciliador de las dos evidencias', () => {
    it('🔴 gana la MAYOR: cada fuente puede no ver un reembolso, ninguna puede inventarlo', () => {
      // El acumulado se quedó corto (semántica vieja) y las filas dicen la verdad.
      expect(
        centavosYaDevueltos({ processorData: { refundedAmountCents: 11000 }, filas: [reembolso(-50, -10), reembolso(-50, -10)] }),
      ).toBe(12000)
      // Y al revés: un reembolso viejo sin `originalPaymentId` no aparece entre las filas,
      // pero sí quedó en el acumulado. Recalcular a ciegas desde las filas lo perdería y
      // volvería a ofrecer ese dinero.
      expect(centavosYaDevueltos({ processorData: { refundedAmountCents: 12000 }, filas: [] })).toBe(12000)
    })

    it('sin filas a la mano (el riel de la terminal) usa el acumulado', () => {
      expect(centavosYaDevueltos({ processorData: { refundedAmountCents: 6000 } })).toBe(6000)
      expect(centavosYaDevueltos({ processorData: { refundedAmountCents: 6000 }, filas: null })).toBe(6000)
    })
  })

  describe('acumuladoPersistido', () => {
    it('los dos campos salen del MISMO entero: no pueden divergir', () => {
      expect(acumuladoPersistido(12000)).toEqual({ refundedAmount: 120, refundedAmountCents: 12000 })
    })

    it('un acumulado con centavos impares no arrastra flotantes', () => {
      expect(acumuladoPersistido(6050)).toEqual({ refundedAmount: 60.5, refundedAmountCents: 6050 })
    })
  })
})
