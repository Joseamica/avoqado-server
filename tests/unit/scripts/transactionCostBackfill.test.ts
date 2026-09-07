/**
 * Lógica PURA del backfill de TransactionCost por merchant.
 *
 * Aquí NO vive una sola línea de aritmética de dinero: el cálculo lo hace
 * `recomputeEconomics` (`src/services/superadmin/rateCorrection/rateRecompute.ts`),
 * que ya está probado y ya está atado por su prueba de paridad al camino vivo.
 * Lo que se prueba aquí son las TRES decisiones nuevas del backfill:
 *
 *   1. qué ranura (PRIMARY/SECONDARY/TERTIARY) le toca al pago — espejo exacto
 *      de `createTransactionCost`, porque de ella depende con qué tarifa se le
 *      cobra al negocio;
 *   2. si el pago se puede recalcular HOY o le falta una estructura vigente —
 *      es el candado que impide llamar al servicio 33 veces para cosechar 33
 *      errores, y es lo que hace honesta la simulación;
 *   3. si lo que quedó ESCRITO cuadra con lo que la simulación prometió, a la
 *      precisión de cada columna (Decimal(10,2) en Payment, Decimal(10,4) en
 *      TransactionCost).
 */
import { clasificarPago, cuadraRedondeado, resolverRanura } from '../../../scripts/lib/transactionCostBackfill'

const tarifa = { debitRate: 0.0228, creditRate: 0.0278, amexRate: 0.03, internationalRate: 0.03 }

describe('resolverRanura', () => {
  const config = { primaryAccountId: 'prim', secondaryAccountId: 'seg', tertiaryAccountId: 'ter' }

  it('reconoce la cuenta SECUNDARIA', () => {
    expect(resolverRanura(config, 'seg')).toBe('SECONDARY')
  })

  it('reconoce la cuenta TERCIARIA', () => {
    expect(resolverRanura(config, 'ter')).toBe('TERTIARY')
  })

  it('reconoce la cuenta PRIMARIA', () => {
    expect(resolverRanura(config, 'prim')).toBe('PRIMARY')
  })

  // Espejo del `else` del servicio: una cuenta que no está en la configuración
  // cae a PRIMARY. Cambiarlo a "abortar" divergiría del camino vivo y el
  // backfill escribiría un número distinto del que produce un cobro normal.
  it('cae a PRIMARY cuando la cuenta no está en la configuración del negocio', () => {
    expect(resolverRanura(config, 'ajena')).toBe('PRIMARY')
  })

  it('cae a PRIMARY cuando el pago no registró cuenta', () => {
    expect(resolverRanura(config, null)).toBe('PRIMARY')
  })

  // Una ranura vacía NO puede confundirse con "el pago no traía cuenta":
  // ambos son null/undefined y compararlos a ciegas haría que un pago sin
  // cuenta se resolviera como SECONDARY.
  it('no confunde una ranura vacía con un pago sin cuenta', () => {
    expect(resolverRanura({ primaryAccountId: 'prim', secondaryAccountId: null, tertiaryAccountId: null }, null)).toBe('PRIMARY')
  })
})

describe('clasificarPago', () => {
  it('marca LISTO cuando hay costo y tarifa vigentes y el pago trae dinero', () => {
    expect(clasificarPago({ bruto: 100, hayConfigDePagos: true, costoVigente: tarifa, tarifaVigente: tarifa })).toBe('LISTO')
  })

  // Un negocio sin `VenuePaymentConfig` (ni propia ni de su organización) hace que
  // `createTransactionCost` reviente en su Step 2, antes de mirar estructura alguna.
  // 🔴 Se clasifica y se sigue, NO se aborta la corrida: un merchant puede servir a
  // varios negocios y uno mal configurado no puede dejar sin reparar a los demás.
  it('marca SIN_CONFIG_DE_PAGOS cuando el negocio no tiene configuración de pagos', () => {
    expect(clasificarPago({ bruto: 100, hayConfigDePagos: false, costoVigente: tarifa, tarifaVigente: tarifa })).toBe('SIN_CONFIG_DE_PAGOS')
  })

  // El orden espeja el del servicio: la configuración se resuelve en el Step 2 y las
  // estructuras en el 3 y el 4, así que la falta de configuración se reporta primero.
  it('reporta la falta de configuración antes que la de estructuras', () => {
    expect(clasificarPago({ bruto: 100, hayConfigDePagos: false, costoVigente: null, tarifaVigente: null })).toBe('SIN_CONFIG_DE_PAGOS')
  })

  // Sin estructura de costo vigente a la fecha del pago, `createTransactionCost`
  // lanza BadRequestError. Llamarlo igual sería cosechar errores; la simulación
  // tiene que DECIRLO para que se vea que falta mover `effectiveFrom`.
  it('marca SIN_COSTO_VIGENTE cuando no hay estructura de costo a esa fecha', () => {
    expect(clasificarPago({ bruto: 100, hayConfigDePagos: true, costoVigente: null, tarifaVigente: tarifa })).toBe('SIN_COSTO_VIGENTE')
  })

  it('marca SIN_TARIFA_VIGENTE cuando no hay tarifa del negocio a esa fecha', () => {
    expect(clasificarPago({ bruto: 100, hayConfigDePagos: true, costoVigente: tarifa, tarifaVigente: null })).toBe('SIN_TARIFA_VIGENTE')
  })

  // Un pago de $0 produce un costo de $0: no hay dinero en juego y llenaría el
  // reporte de renglones vacíos. Se omite, pero se REPORTA, nunca en silencio.
  it('marca EN_CERO un pago sin dinero, aunque tenga las dos estructuras', () => {
    expect(clasificarPago({ bruto: 0, hayConfigDePagos: true, costoVigente: tarifa, tarifaVigente: tarifa })).toBe('EN_CERO')
  })

  // El orden importa: un pago de $0 al que además le falta el costo se reporta
  // como EN_CERO, que es la razón por la que no se va a tocar nunca.
  it('reporta EN_CERO antes que cualquier otra carencia', () => {
    expect(clasificarPago({ bruto: 0, hayConfigDePagos: false, costoVigente: null, tarifaVigente: null })).toBe('EN_CERO')
  })

  it('trata un bruto negativo como EN_CERO (no hay nada que cobrar)', () => {
    expect(clasificarPago({ bruto: -5, hayConfigDePagos: true, costoVigente: tarifa, tarifaVigente: tarifa })).toBe('EN_CERO')
  })
})

describe('cuadraRedondeado', () => {
  // Payment.feeAmount es Decimal(10,2): lo escrito es lo previsto redondeado a
  // 2 decimales, así que 174.6220 previsto y 174.62 escrito SÍ cuadran.
  it('acepta la diferencia que introduce redondear a 2 decimales', () => {
    expect(cuadraRedondeado(174.62, 174.622, 2)).toBe(true)
  })

  it('rechaza una diferencia mayor que el redondeo a 2 decimales', () => {
    expect(cuadraRedondeado(174.62, 174.75, 2)).toBe(false)
  })

  // TransactionCost.venueChargeAmount es Decimal(10,4).
  it('acepta la diferencia que introduce redondear a 4 decimales', () => {
    expect(cuadraRedondeado(149.722, 149.72195, 4)).toBe(true)
  })

  it('rechaza a 4 decimales lo que sí pasaría a 2', () => {
    expect(cuadraRedondeado(149.722, 149.7245, 4)).toBe(false)
  })

  // Un centavo justo en la frontera del redondeo no puede reportarse como
  // descuadre: sería un falso positivo en cada corrida.
  it('acepta exactamente medio centavo de diferencia a 2 decimales', () => {
    expect(cuadraRedondeado(10.0, 10.005, 2)).toBe(true)
  })

  it('rechaza más de medio centavo a 2 decimales', () => {
    expect(cuadraRedondeado(10.0, 10.02, 2)).toBe(false)
  })

  // Un NaN es la firma de una lectura fallida (un Decimal ilegible, una columna
  // nula). Tratarlo como "cuadra" haría que el descuadre pasara desapercibido,
  // que es justo lo que esta comprobación existe para evitar.
  it('nunca cuadra si alguno de los dos valores no es un número', () => {
    expect(cuadraRedondeado(NaN, 10, 2)).toBe(false)
    expect(cuadraRedondeado(10, NaN, 2)).toBe(false)
  })
})
