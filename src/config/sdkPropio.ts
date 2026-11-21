/** El freno general del SDK propio: prendido sólo con BLUMON_SDK_PROPIO_ENABLED exactamente 'true'; se lee en cada llamada. */
export function sdkPropioEncendido(): boolean {
  return process.env.BLUMON_SDK_PROPIO_ENABLED === 'true'
}
