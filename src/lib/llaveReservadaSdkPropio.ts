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

/** Sólo un objeto JSON común (`{…}`): ni `null`, ni un arreglo, ni `Prisma.JsonNull` (que es una instancia de clase). */
const esObjetoPlano = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))

/** Un `Terminal.config` completo (lo que manda el formulario o el alta): quita la llave de la RAÍZ y de su `settings`. Lo que no
 *  es un objeto JSON común regresa tal cual. */
export function configSinLlaveReservada<T>(config: T): T {
  if (!esObjetoPlano(config)) return config
  const raiz: Record<string, any> = sinLlaveReservada(config)
  return (esObjetoPlano(raiz.settings) ? { ...raiz, settings: sinLlaveReservada(raiz.settings) } : raiz) as T
}
