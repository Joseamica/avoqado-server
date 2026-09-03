import { InternalServerError } from '../../errors/AppError'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * ¿CUÁNTO SE HA DEVUELTO YA DE ESTE COBRO?  ·  DEFINICIÓN ÚNICA
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 `Payment.processorData.refundedAmount` (pesos) y su gemelo `refundedAmountCents`
 * significan **TODO el dinero que salió por ese cobro: VENTA + PROPINA**, en positivo.
 *
 * Los reembolsos se guardan como un `Payment` aparte con `type = 'REFUND'` y las DOS columnas
 * en negativo (`amount` = la venta devuelta, `tipAmount` = la propina devuelta). Lo devuelto
 * de un cobro es, por tanto, `Σ (|amount| + |tipAmount|)` de sus reembolsos.
 *
 * ── POR QUÉ INCLUYE LA PROPINA, y qué se rompe si alguien lo invierte ─────────────────────
 *
 * 1. **Es la definición que la plataforma ya usa** una capa más arriba, para la misma
 *    pregunta: `summarizeRefunds` en `shared/orderBalance.ts` acumula exactamente
 *    `amount.abs().plus(tip.abs())`, y ése es el `refundedAmount` que sale en TODA respuesta
 *    de API (dashboard, apps, MCP). Dos definiciones del mismo nombre en el mismo backend es
 *    justo lo que produjo este defecto.
 *
 * 2. **Es lo que asumen sus lectores.** El remanente se calcula SIEMPRE contra
 *    `amount + tipAmount`: `tpv/terminalRefundTarget.ts:74` («La propina es parte de lo que
 *    el cliente pagó»), `tpv/payment.tpv.service.ts:1439` (`isFullyRefunded` del historial),
 *    y las dos validaciones de `tpv/refund.tpv.service.ts`. Medir el acumulado sobre una base
 *    y el remanente sobre otra ES el defecto, no un detalle de estilo.
 *
 * 3. **Es la única que hace imposible el «$130 sobre $120».** Con la definición contraria
 *    —sólo la venta— cada peso de propina ya devuelto vuelve a quedar disponible: un cobro de
 *    $100 + $20 admite dos reembolsos de $60 (=$120 entregados) y todavía declara $10
 *    reembolsables. Invertir esta regla resucita exactamente esa fuga.
 *
 * ── DE DÓNDE SE LEE ──────────────────────────────────────────────────────────────────────
 *
 * Hay DOS evidencias del mismo hecho y ninguna es infalible:
 *
 *   · **las FILAS** de reembolso ligadas al cobro (`processorData.originalPaymentId`) — es el
 *     dinero, pero un reembolso antiguo sin esa llave no aparece;
 *   · **el ACUMULADO** persistido en el cobro — es una caché de lo anterior, y las filas
 *     escritas antes de este archivo pueden venir cortas por la propina.
 *
 * 🔑 Las dos pueden PERDERSE un reembolso; ninguna puede INVENTARSE uno. Por eso
 * `centavosYaDevueltos` toma **la mayor**: en un carril de dinero el error caro es el que
 * deja salir de más, y quedarse con el número más alto sólo puede rechazar de más — un
 * rechazo se nota en minutos, un peso de más no se nota nunca.
 *
 * 🔴 Y por eso **LOS DOS RIELES QUE AUTORIZAN DINERO PASAN LAS FILAS**, no sólo el del
 * dashboard. Es una consulta más dentro de una transacción que ya está abierta, y sin ella la
 * promesa de arriba sería falsa justo donde termina la fuga: un cobro de $100 + $20 con el
 * acumulado corto en 110 (dos reembolsos viejos del dashboard que suman 120) haría que la
 * TERMINAL creyera que quedan $10 y sacara $130 sobre $120. «Se autocorrige al leerlo» ahí
 * se cumpliría **pagando la diferencia**. Quien lo llame SIN `filas` sólo puede ser una
 * lectura informativa, nunca una que autorice una salida de dinero.
 *
 * Consecuencia práctica, y por eso NO hace falta migrar ninguna fila: un acumulado corto
 * escrito con la regla vieja se corrige solo la próxima vez que alguien lea este cobro con
 * sus filas a la mano, y se reescribe correcto en el siguiente reembolso.
 *
 * ── QUIÉN LO USA ─────────────────────────────────────────────────────────────────────────
 *
 * `dashboard/refund.dashboard.service.ts` (que es también el que atiende a las apps:
 * `POST /mobile/venues/:venueId/payments/:paymentId/refund`) y `tpv/refund.tpv.service.ts`.
 * `mobile/refund.mobile.service.ts` NO entra: crea reembolsos NO asociados, sin cobro
 * original, así que no hay acumulado que llevar.
 *
 * Todo se hace en CENTAVOS enteros. Sumar pesos con `+` deriva; los centavos comparan exacto
 * y es la convención de la casa para el carril de reembolso (`orderBalance.ts:refundedCents`).
 */

/** Lo único que hace falta de una fila de reembolso para medir lo devuelto. */
export interface FilaDeReembolso {
  /** Venta devuelta, en PESOS y en negativo. */
  amount: unknown
  /** Propina devuelta, en PESOS y en negativo. Nulable: `null` es una fila normal. */
  tipAmount: unknown
  /**
   * `TransactionStatus` como cadena. **Sólo los `COMPLETED` movieron dinero**, y son los
   * únicos que cuentan — misma restricción que el precedente que cita la cabecera
   * (`orderBalance.ts:summarizeRefunds`, que sus llamadores alimentan sólo con completados).
   * Contar una fila que no completó inflaría el piso y rechazaría reembolsos legítimos.
   */
  status: unknown
}

/** El único estado en el que un `Payment` movió dinero de verdad. */
const COMPLETADO = 'COMPLETED'

/** Pesos → centavos enteros, redondeando ANTES de sumar. */
function aCentavos(pesos: unknown): number {
  const n = Number(pesos ?? 0)
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN
}

/**
 * Lo devuelto según las FILAS de reembolso: `Σ (|amount| + |tipAmount|)`, en centavos.
 *
 * 🔴 Exige que cada fila TRAIGA las dos llaves, y revienta si falta alguna. No es paranoia:
 * estas filas suelen llegar de un `$queryRaw` cuyo tipo se declara a mano, así que TypeScript
 * no comprueba que el SQL pida de verdad las columnas. Recortar `"tipAmount"` del `SELECT`
 * haría que `Number(undefined)` valga 0 y devolvería el acumulado a la semántica vieja **en
 * silencio y para siempre**. Se mira la LLAVE y no el valor porque `tipAmount` es nulable:
 * `null` es una fila legítima; una columna que no se pidió simplemente no aparece.
 * Es la misma guarda que ya protege el candado de `refund.tpv.service.ts` (commit 4a52652b).
 */
export function centavosDevueltosDeFilas(filas: readonly FilaDeReembolso[]): number {
  let centavos = 0
  for (const fila of filas) {
    for (const columna of ['amount', 'tipAmount', 'status'] as const) {
      if (!fila || typeof fila !== 'object' || !(columna in fila)) {
        throw new InternalServerError(
          `Una fila de reembolso llegó sin la columna "${columna}": no se puede medir cuánto se ha devuelto de este cobro. ` +
            'No se registró ningún reembolso.',
        )
      }
    }
    // Sólo el dinero que de verdad salió. `status` se exige como llave (y no se tolera su
    // ausencia) por lo mismo que las otras dos: una columna que el `SELECT` deje de pedir no
    // puede cambiar en silencio lo que esta función cuenta.
    if (fila.status !== COMPLETADO) continue

    const venta = aCentavos(fila.amount)
    const propina = aCentavos(fila.tipAmount)
    if (!Number.isFinite(venta) || !Number.isFinite(propina)) {
      throw new InternalServerError(
        'El importe de un reembolso previo no es un número: no se puede medir cuánto se ha devuelto de este cobro. ' +
          'No se registró ningún reembolso.',
      )
    }
    centavos += Math.abs(venta) + Math.abs(propina)
  }
  return centavos
}

/**
 * Lo devuelto según el ACUMULADO persistido en el `processorData` del cobro, en centavos.
 *
 * Prefiere `refundedAmountCents` —entero, exacto— y cae a `refundedAmount` en pesos para las
 * filas escritas antes de que ese campo existiera. Tolera el número guardado como cadena
 * porque hay filas así en la calle (`payment.tpv.service.ts:1431` ya lo hace).
 *
 * 🔴 Un valor PRESENTE pero ilegible revienta en vez de valer 0. Hoy `Number('vaya')` es
 * `NaN`, y comparar contra `NaN` da `false`: un acumulado corrupto dejaba pasar TODOS los
 * reembolsos. Y uno negativo se trata como 0, porque restarlo AGRANDARÍA el remanente.
 */
export function centavosDevueltosDeclarados(processorData: unknown): number {
  if (!processorData || typeof processorData !== 'object' || Array.isArray(processorData)) return 0
  const pd = processorData as Record<string, unknown>

  const crudoCentavos = pd.refundedAmountCents
  if (crudoCentavos !== undefined && crudoCentavos !== null) {
    const n = Number(crudoCentavos)
    if (!Number.isFinite(n)) {
      throw new InternalServerError(
        'El acumulado de reembolsos del cobro (`refundedAmountCents`) no es un número: no se puede validar cuánto queda por devolver. ' +
          'No se registró ningún reembolso.',
      )
    }
    return Math.max(0, Math.round(n))
  }

  const crudoPesos = pd.refundedAmount
  if (crudoPesos === undefined || crudoPesos === null) return 0
  const n = Number(crudoPesos)
  if (!Number.isFinite(n)) {
    throw new InternalServerError(
      'El acumulado de reembolsos del cobro (`refundedAmount`) no es un número: no se puede validar cuánto queda por devolver. ' +
        'No se registró ningún reembolso.',
    )
  }
  return Math.max(0, Math.round(n * 100))
}

/**
 * Lo YA devuelto de un cobro, en centavos: **la mayor** de las dos evidencias disponibles.
 *
 * 🔴 `filas` se omite (o va en `null`) SÓLO en lecturas informativas. Los dos rieles que
 * autorizan una salida de dinero las pasan siempre: sin ellas, el piso es el acumulado
 * persistido, que puede venir corto por la regla vieja. El razonamiento completo —y el
 * escenario del «$130 sobre $120» que esto cierra— está en la cabecera del archivo.
 */
export function centavosYaDevueltos(args: { processorData: unknown; filas?: readonly FilaDeReembolso[] | null }): number {
  const declarado = centavosDevueltosDeclarados(args.processorData)
  if (!args.filas) return declarado
  return Math.max(declarado, centavosDevueltosDeFilas(args.filas))
}

/**
 * Los dos campos que los rieles persisten tras registrar un reembolso, derivados del MISMO
 * entero de centavos para que no puedan divergir entre sí.
 *
 * 🔴 Contrato ADITIVO: `refundedAmount` sigue saliendo en PESOS, que es lo que leen las apps
 * instaladas y `terminalRefundTarget`. Lo único que cambia es CÓMO se calcula.
 */
export function acumuladoPersistido(centavos: number): { refundedAmount: number; refundedAmountCents: number } {
  const enteros = Math.max(0, Math.round(centavos))
  return { refundedAmount: enteros / 100, refundedAmountCents: enteros }
}
