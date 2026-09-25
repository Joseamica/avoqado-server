import { BadRequestError, ConflictError } from '@/errors/AppError'
import { IvaTratamiento, TRATAMIENTOS_OFRECIDOS_V1, tratamientoDesdeTupla, tuplaDesdeTratamiento } from './ivaTratamiento'

const MENSAJES = {
  IVA_POR_PRODUCTO_APAGADO:
    'El IVA por producto no está activado para este negocio. Todos los productos se venden con IVA 16 %. Pídele a Avoqado que lo active.',
  // La pantalla «Productos → IVA» llega en el plan 6; mientras la bandera esté apagada este mensaje es inalcanzable.
  IVA_REQUIERE_APP_NUEVA: 'Para cambiar el IVA de un producto actualiza la app o hazlo desde el dashboard (Productos → IVA).',
  IVA_TRATAMIENTO_CONTRADICTORIO: 'El IVA elegido no es válido. Usa 16 %, tasa 0 % o exento.',
} as const

const esOfrecido = (v: unknown): v is IvaTratamiento =>
  typeof v === 'string' && (TRATAMIENTOS_OFRECIDOS_V1 as readonly string[]).includes(v)
const mismaTasa = (a: unknown, b: number) => Math.round(Number(a) * 10000) === Math.round(b * 10000)

/**
 * Traduce lo que manda un cliente (app nueva: `ivaTratamiento`; app vieja: sólo `taxRate`) al único valor que se
 * escribe. La tupla la deriva el trigger de Product; el llamador NO debe escribir `taxRate`/`objetoImp` por su cuenta.
 */
export function normalizarIvaDeProducto(
  entrada: { ivaTratamiento?: unknown; taxRate?: unknown; objetoImp?: unknown },
  actual: { ivaTratamiento: IvaTratamiento; taxRate: number; objetoImp: string } | null,
  encendido: boolean,
): { ivaTratamiento?: IvaTratamiento } {
  const pideTratamiento = entrada.ivaTratamiento !== undefined && entrada.ivaTratamiento !== null
  const mandaTasa = entrada.taxRate !== undefined && entrada.taxRate !== null
  const mandaObjeto = entrada.objetoImp !== undefined && entrada.objetoImp !== null

  if (pideTratamiento) {
    if (!esOfrecido(entrada.ivaTratamiento)) {
      throw new BadRequestError(MENSAJES.IVA_TRATAMIENTO_CONTRADICTORIO, 'IVA_TRATAMIENTO_CONTRADICTORIO')
    }
    const pedido = entrada.ivaTratamiento
    if (mandaTasa || mandaObjeto) {
      const esperada = tuplaDesdeTratamiento(pedido, actual?.taxRate ?? 0.16)
      if ((mandaTasa && !mismaTasa(entrada.taxRate, esperada.taxRate)) || (mandaObjeto && entrada.objetoImp !== esperada.objetoImp)) {
        throw new BadRequestError(MENSAJES.IVA_TRATAMIENTO_CONTRADICTORIO, 'IVA_TRATAMIENTO_CONTRADICTORIO')
      }
    }
    if (pedido !== 'IVA_16' && pedido !== actual?.ivaTratamiento && !encendido) {
      throw new ConflictError(MENSAJES.IVA_POR_PRODUCTO_APAGADO, 'IVA_POR_PRODUCTO_APAGADO')
    }
    return { ivaTratamiento: pedido }
  }

  if (!mandaTasa && !mandaObjeto) return {}

  // Cliente viejo: si la tupla ENTERA (tasa Y objetoImp) no cambia respecto a la fila, no se toca
  // nada. Ruling R9: reenviar el `objetoImp` ACTUAL de la fila (lo que hace el dashboard de hoy en
  // CADA guardado, prefiltrado del propio renglón) no es un cambio — ni para un EXENTO (no se
  // degrada a IVA_0) ni para un heredado BLOQUEADO_04 (el trigger ya lo permite: migración
  // `iva_tratamiento_columnas`). Comparar sólo la tasa dejaba pasar un objetoImp distinto sin
  // vetarlo, y comparar "manda objetoImp ⇒ siempre cambio" disparaba un 409 en cada edición normal.
  const tasaActual = actual?.taxRate ?? 0.16
  const objetoActual = actual?.objetoImp ?? '02'
  const sinCambio = (!mandaTasa || mismaTasa(entrada.taxRate, tasaActual)) && (!mandaObjeto || entrada.objetoImp === objetoActual)
  if (sinCambio) return {}

  // Deriva con la parte que SÍ cambió y el valor de la FILA para la que no se mandó — nunca '02' a
  // ciegas: un producto heredado BLOQUEADO_03/04 que sólo cambia la tasa no debe brincar a otro objeto.
  const derivado = tratamientoDesdeTupla(
    mandaTasa ? Number(entrada.taxRate) : tasaActual,
    mandaObjeto ? String(entrada.objetoImp) : objetoActual,
  )
  if (derivado === 'IVA_16') return { ivaTratamiento: 'IVA_16' }
  if (!encendido) throw new ConflictError(MENSAJES.IVA_POR_PRODUCTO_APAGADO, 'IVA_POR_PRODUCTO_APAGADO')
  // Encendido: una tupla vieja no distingue tasa 0 de exento ⇒ no se adivina.
  throw new ConflictError(MENSAJES.IVA_REQUIERE_APP_NUEVA, 'IVA_REQUIERE_APP_NUEVA')
}

/** El trigger lanza P0001 con el código en el mensaje; aquí se vuelve el mismo error HTTP. Otros errores pasan. */
export function traducirErrorDeIva(error: unknown): void {
  const texto = `${(error as any)?.meta?.message ?? ''} ${(error as any)?.message ?? ''}`
  for (const code of Object.keys(MENSAJES) as (keyof typeof MENSAJES)[]) {
    if (texto.includes(code)) {
      if (code === 'IVA_TRATAMIENTO_CONTRADICTORIO') throw new BadRequestError(MENSAJES[code], code)
      throw new ConflictError(MENSAJES[code], code)
    }
  }
}
