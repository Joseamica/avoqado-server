/**
 * «Lo que se vio» (C1 y C2): cada edición manda lo que la pantalla enseñaba de cada campo que cambia, y el SERVIDOR lo
 * compara bajo el candado de la fila. Si lo guardado ya es otra cosa, 409 con lo de ahora y nada escrito.
 */
import { ConflictError } from '../../errors/AppError'

/** «Lo que viste» contra lo guardado: sin espacios de más, y '' es lo mismo que null. */
export const mismoTexto = (a?: string | null, b?: string | null): boolean => (a ?? '').trim() === (b ?? '').trim()

/**
 * La copia del editor está vieja: alguien guardó otra cosa mientras estaba abierto (rediseño de C1: decide el SERVIDOR, no
 * el navegador). Con `ahora`, lo guardado de esos campos, para que el editor lo enseñe sin esperar una recarga.
 */
export function cambioAlEditar(ahora?: object): ConflictError {
  return new ConflictError(
    'Cambió mientras lo editabas: revisa y guarda otra vez.',
    'CRM_CAMBIO_AL_EDITAR',
    ahora === undefined ? undefined : { ahora },
  )
}
