import { MENSAJE_DESCUENTO_DE_VENTA_DE_VALES, rechazarSiQuitaUnDescuentoDeVale } from '@/services/shared/cuentaConVales'

/**
 * Tarjeta na24531d (v4, 18-nov; familia «quitar la fila»: Codex r1 #1-#2, r2 #1, r3 #1-#2): toda fila que nace al cobrar vales V7
 * lleva la marca `deValeV7` en su reparto y NO se quita desde la caja (TPV) ni desde el POS, sin importar su `discountId` (una cortesía
 * del catálogo que el dueño borró queda sin liga) ni qué renglones queden en la cuenta (quitar el renglón de vale no la libera). Una
 * fila sin la marca se quita como siempre: la cortesía que la caja da después, un descuento de cuenta, un canje.
 */
const espejo = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-1': 1000 } }
const marcada = { ...espejo, deValeV7: true }
const deCuenta = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-1': 1000 } }

describe('rechazarSiQuitaUnDescuentoDeVale (marca deValeV7)', () => {
  it('🔴 una fila del cobro de vales (marcada) ⇒ 400 AREA_TICKET_DISCOUNT_FROZEN', () => {
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: marcada })).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'AREA_TICKET_DISCOUNT_FROZEN', message: MENSAJE_DESCUENTO_DE_VENTA_DE_VALES }),
    )
  })

  it('🔴 Codex r3 #1: la cortesía del CATÁLOGO que el dueño borró (COMP sin liga) sigue sin quitarse si nació en el cobro de vales', () => {
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: marcada, isComp: true, type: 'COMP', discountId: null } as any)).toThrow(
      expect.objectContaining({ code: 'AREA_TICKET_DISCOUNT_FROZEN' }),
    )
  })

  it('🔴 Codex r3 #2: no depende de los renglones que queden (no consulta la cuenta): el espejo del suelto sigue sin quitarse', () => {
    // Sin transacción: si el candado preguntara por renglones de vale, esta llamada no tendría a quién.
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: { ...marcada, renglones: { 'oi-suelto': 500 } } })).toThrow(
      expect.objectContaining({ code: 'AREA_TICKET_DISCOUNT_FROZEN' }),
    )
  })

  it('🔴 D14 (Codex r2 #3 y #4): el aviso da la salida que de verdad existe, también para las apps viejas que enseñan «Quitar»', () => {
    // Volver a leer el MISMO vale copia otra vez su descuento (areaTicketV7 ~1675): «ármala sin ese descuento» no lo corrige.
    expect(MENSAJE_DESCUENTO_DE_VENTA_DE_VALES).not.toMatch(/vuelve a armarla sin ese descuento/)
    // Cancelar el cobro de vales sólo se puede SIN pagos (cancelAreaTicketCheckout → CHECKOUT_HAS_PAYMENT); con pagos, reembolso.
    expect(MENSAJE_DESCUENTO_DE_VENTA_DE_VALES).toMatch(/sin pagos/i)
    expect(MENSAJE_DESCUENTO_DE_VENTA_DE_VALES).toMatch(/reembolso/i)
    // El error que viene impreso en el vale se corrige con otro vale del área.
    expect(MENSAJE_DESCUENTO_DE_VENTA_DE_VALES).toMatch(/vale nuevo|otro vale/i)
  })

  it('regresión: la cortesía que la caja da después en una venta de vales (espejo SIN marca) se quita como siempre', () => {
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: espejo, isComp: true, type: 'COMP', discountId: null } as any)).not.toThrow()
  })

  it('regresión: un espejo de Mostrador o del vale viejo, un descuento de CUENTA o una fila sin reparto se quitan como siempre', () => {
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: espejo })).not.toThrow()
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: deCuenta })).not.toThrow()
    expect(() => rechazarSiQuitaUnDescuentoDeVale({ reparto: null })).not.toThrow()
  })
})
