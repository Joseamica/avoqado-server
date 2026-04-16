/**
 * Canonical error-code registry for the SIM custody chain.
 *
 * Single source of truth consumed by:
 *   - Backend controllers/services (attaches `message` to results[] using request locale)
 *   - Dashboard and TPV i18n (mirrored string tables regenerated from this registry)
 *
 * A code appears EVERY time the same semantic failure occurs. Keep this list
 * lean — new codes only when they represent a distinct actionable state.
 *
 * See plan §1.3 (bulk response contract) and §2.0.3 (i18n canonical).
 */

export type SimCustodyErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_ASSIGNED'
  | 'NOT_IN_YOUR_CUSTODY'
  | 'HAS_DOWNSTREAM_CUSTODY'
  | 'VERSION_CONFLICT'
  | 'ALREADY_ACCEPTED'
  | 'ALREADY_REJECTED'
  | 'SIM_SOLD'
  | 'SIM_NOT_ACCEPTED'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_MISMATCH'
  | 'INVALID_STATE'
  | 'REASON_REQUIRED'
  | 'TENANT_MISMATCH'
  | 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY'

export interface SimCustodyErrorEntry {
  /** Canonical code used across backend/dashboard/TPV. */
  code: SimCustodyErrorCode
  /** Default HTTP status when raised at the request level (bulk rows are always in 200 summary). */
  httpStatus: number
  /** Localized messages. Additional locales added later. */
  messages: {
    es: string
    en: string
  }
}

export const SIM_CUSTODY_ERROR_CODES: Record<SimCustodyErrorCode, SimCustodyErrorEntry> = {
  NOT_FOUND: {
    code: 'NOT_FOUND',
    httpStatus: 404,
    messages: {
      es: 'ICCID no existe en el sistema. Regístralo desde "Cargar Items" antes de asignarlo.',
      en: 'ICCID not found. Register it via "Upload Items" before assigning.',
    },
  },
  ALREADY_ASSIGNED: {
    code: 'ALREADY_ASSIGNED',
    httpStatus: 409,
    messages: {
      es: 'Este SIM ya está asignado a otro Supervisor.',
      en: 'This SIM is already assigned to another Supervisor.',
    },
  },
  NOT_IN_YOUR_CUSTODY: {
    code: 'NOT_IN_YOUR_CUSTODY',
    httpStatus: 403,
    messages: {
      es: 'No puedes operar sobre un SIM que no está en tu custodia.',
      en: 'You cannot operate on a SIM that is not in your custody.',
    },
  },
  HAS_DOWNSTREAM_CUSTODY: {
    code: 'HAS_DOWNSTREAM_CUSTODY',
    httpStatus: 409,
    messages: {
      es: 'El Supervisor aún tiene este SIM asignado a un Promotor. Recolecta primero del Promotor.',
      en: 'The Supervisor still has this SIM assigned to a Promoter. Collect from the Promoter first.',
    },
  },
  VERSION_CONFLICT: {
    code: 'VERSION_CONFLICT',
    httpStatus: 409,
    messages: {
      es: 'El SIM cambió de estado mientras se procesaba. Refresca e intenta nuevamente.',
      en: 'The SIM state changed during processing. Refresh and try again.',
    },
  },
  ALREADY_ACCEPTED: {
    code: 'ALREADY_ACCEPTED',
    httpStatus: 409,
    messages: {
      es: 'Este SIM ya fue aceptado.',
      en: 'This SIM was already accepted.',
    },
  },
  ALREADY_REJECTED: {
    code: 'ALREADY_REJECTED',
    httpStatus: 409,
    messages: {
      es: 'Este SIM ya fue rechazado.',
      en: 'This SIM was already rejected.',
    },
  },
  SIM_SOLD: {
    code: 'SIM_SOLD',
    httpStatus: 409,
    messages: {
      es: 'Este SIM ya fue vendido y no puede modificarse.',
      en: 'This SIM has already been sold and cannot be modified.',
    },
  },
  SIM_NOT_ACCEPTED: {
    code: 'SIM_NOT_ACCEPTED',
    httpStatus: 400,
    messages: {
      es: 'Debes aceptar la recepción del SIM en "Mis SIMs" antes de venderlo.',
      en: 'You must accept reception of this SIM in "My SIMs" before selling it.',
    },
  },
  CATEGORY_NOT_FOUND: {
    code: 'CATEGORY_NOT_FOUND',
    httpStatus: 404,
    messages: {
      es: 'La categoría indicada no existe en esta organización.',
      en: 'The provided category does not exist in this organization.',
    },
  },
  CATEGORY_MISMATCH: {
    code: 'CATEGORY_MISMATCH',
    httpStatus: 409,
    messages: {
      es: 'La categoría enviada no coincide con la del SIM. Si necesitas reclasificarlo, edítalo desde Cargas primero.',
      en: "Submitted category does not match the SIM's current category. Reclassify it from the Uploads view first.",
    },
  },
  INVALID_STATE: {
    code: 'INVALID_STATE',
    httpStatus: 409,
    messages: {
      es: 'El SIM no está en un estado válido para esta acción.',
      en: 'The SIM is not in a valid state for this action.',
    },
  },
  REASON_REQUIRED: {
    code: 'REASON_REQUIRED',
    httpStatus: 400,
    messages: {
      es: 'Debes elegir un motivo para recolectar el SIM.',
      en: 'A reason is required to collect this SIM.',
    },
  },
  TENANT_MISMATCH: {
    code: 'TENANT_MISMATCH',
    httpStatus: 403,
    messages: {
      es: 'No tienes acceso a esta organización.',
      en: 'You do not have access to this organization.',
    },
  },
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY: {
    code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
    httpStatus: 409,
    messages: {
      es: 'La llave de idempotencia se usó previamente con un cuerpo diferente.',
      en: 'Idempotency key was previously used with a different request body.',
    },
  },
}

export type SimCustodyLocale = 'es' | 'en'

/**
 * Formats a canonical error for a bulk `results[]` row.
 * Used by custody service + controllers when returning partial-success responses.
 */
export function formatSimCustodyError(
  code: SimCustodyErrorCode,
  opts: { locale?: SimCustodyLocale; detail?: string } = {},
): { code: SimCustodyErrorCode; message: string } {
  const entry = SIM_CUSTODY_ERROR_CODES[code]
  const base = entry.messages[opts.locale ?? 'es']
  return {
    code,
    message: opts.detail ? `${base} ${opts.detail}` : base,
  }
}

/**
 * Raised by the service layer. Controllers translate to the HTTP envelope.
 */
export class SimCustodyError extends Error {
  readonly code: SimCustodyErrorCode
  readonly httpStatus: number
  readonly detail?: string

  constructor(code: SimCustodyErrorCode, detail?: string) {
    const entry = SIM_CUSTODY_ERROR_CODES[code]
    super(entry.messages.es + (detail ? ` ${detail}` : ''))
    this.name = 'SimCustodyError'
    this.code = code
    this.httpStatus = entry.httpStatus
    this.detail = detail
  }
}
