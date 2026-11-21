/**
 * SDK propio (fase 3, bloque 2a): `inHouseSdkEnabled` es una llave RESERVADA. La verdad es la columna `Terminal.inHouseSdkEnabled`
 * (con su único escritor) y sólo viaja en la raíz de `/config`. En el JSON de ajustes (`Terminal.config.settings`,
 * `Terminal.configOverrides`, los ajustes de la organización) nunca se guarda ni se devuelve: si llega, se quita sin error.
 * Cada escritor de ese JSON pasa por aquí; la guardia `tests/unit/architecture/llaveReservadaEscritores.test.ts` cuenta los sitios.
 */
export const LLAVE_RESERVADA_SDK_PROPIO = 'inHouseSdkEnabled'

/** Una copia de los ajustes sin la llave reservada. */
export function sinLlaveReservada<T extends Record<string, any>>(ajustes: T): Omit<T, typeof LLAVE_RESERVADA_SDK_PROPIO> {
  const { [LLAVE_RESERVADA_SDK_PROPIO]: _reservada, ...resto } = ajustes
  return resto
}

/** Un `Terminal.config` completo (lo que manda el formulario o el alta): quita la llave de su `settings`, si lo trae. */
export function configSinLlaveReservada<T>(config: T): T {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return config
  const { settings } = config as Record<string, any>
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return config
  return { ...config, settings: sinLlaveReservada(settings) }
}
