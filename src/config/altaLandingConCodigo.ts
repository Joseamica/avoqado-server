/**
 * Interruptor del alta desde la landing CON CÓDIGO de 6 dígitos (`ALTA_LANDING_CON_CODIGO=true`).
 *
 * Se lee en CADA llamada, no al importar: prenderlo o apagarlo no pide reiniciar nada y las
 * pruebas lo cambian sobre la marcha. Apagado, el alta es exactamente la de siempre.
 *
 * Vive en un módulo mínimo (sin Prisma ni correo) para que `middlewares/limitesDeCodigo` lo pueda
 * leer sin arrastrar todo `signup.service`; éste lo vuelve a exportar con el mismo nombre.
 */
export function altaLandingConCodigo(): boolean {
  return process.env.ALTA_LANDING_CON_CODIGO === 'true'
}
