import { BadRequestError, ConflictError } from '@/errors/AppError'
import { IvaTratamiento, TRATAMIENTOS_OFRECIDOS_V1, tratamientoDesdeTupla, tuplaDesdeTratamiento } from './ivaTratamiento'

const MENSAJES = {
  IVA_POR_PRODUCTO_APAGADO:
    'El IVA por producto no está activado para este negocio. Todos los productos se venden con IVA 16 %. Pídele a Avoqado que lo active.',
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
  actual: { ivaTratamiento: IvaTratamiento; taxRate: number } | null,
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

  // Cliente viejo: si la tupla no cambia respecto a la fila, no se toca nada (un EXENTO no se degrada a IVA_0).
  const tasaActual = actual?.taxRate ?? 0.16
  const sinCambio = (!mandaTasa || mismaTasa(entrada.taxRate, tasaActual)) && !mandaObjeto
  if (sinCambio) return {}

  const derivado = tratamientoDesdeTupla(mandaTasa ? Number(entrada.taxRate) : tasaActual, mandaObjeto ? String(entrada.objetoImp) : '02')
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
