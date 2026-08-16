import { z } from 'zod'

/**
 * Longitud del PIN de personal, en UN solo lugar.
 *
 * 🔴 Estaba copiado en ocho sitios y la unificación a 4-10 se olvidó de uno:
 * `UpdateTeamMemberSchema` seguía en 4-6, así que un superadmin podía poner un
 * PIN largo que la pantalla de Equipo —la que los venues usan de verdad—
 * rechazaba con "PIN must be 4-6 digits". Justo el camino que la recomendación
 * de seguridad pide usar.
 *
 * El rango importa: el PIN se guarda en TEXTO PLANO por decisión explícita del
 * founder, así que su única defensa real es poder ser largo. 10 dígitos son
 * 10 mil millones de combinaciones contra las 10 mil de cuatro.
 */
export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 10

/** `/^\d{4,10}$/` — solo dígitos, sin espacios ni separadores. */
export const PIN_REGEX = new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`)

export const PIN_ERROR_MESSAGE = `El PIN debe tener entre ${PIN_MIN_LENGTH} y ${PIN_MAX_LENGTH} dígitos`

/** PIN obligatorio. */
export const pinSchema = z.string().regex(PIN_REGEX, PIN_ERROR_MESSAGE)

/**
 * PIN opcional que además acepta vaciarlo.
 *
 * Las pantallas de edición mandan `''` o `null` para BORRAR el PIN de alguien;
 * eso no es un PIN inválido, es la ausencia de PIN.
 */
export const optionalClearablePinSchema = z.union([pinSchema, z.literal(''), z.null()]).optional()
