/**
 * Planes editables: los requisitos de código para prender el interruptor `PLANES_EDITABLES`.
 *
 * 🔴 `SERVIDOR_LISTO_PARA_PLANES_EDITABLES` se queda en `false`: B5 la pone en `true` cuando la LANDING ya lee la oferta en
 * producción (§4.8). Para probar con Stripe de pruebas, la Mac cambia en su copia local (nunca en un commit) este valor.
 */
export const SERVIDOR_LISTO_PARA_PLANES_EDITABLES = false

/**
 * El cupón `INTRO_PRO_3M` queda fuera de toda compra con una versión del editor (≥ 2): B2 §12.2 lo excluye en
 * `planActivation.service.ts` y ninguna pantalla del alta lo ofrece. Borrar su código es limpieza aparte (founder, 27-nov).
 * Lo prueba `planActivation.service.test.ts` («guarda del supuesto del cupón»).
 */
export const cuponDeIntroduccionExcluidoConVersion = (): true => true
