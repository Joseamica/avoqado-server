import { z } from 'zod'

import { CASH_MACHINE_REF, DESENLACES_DE_LA_MAQUINA } from '../../services/cashMachine/ventaDeLaMaquina'

/**
 * Máquina de efectivo (fase 1a, R4-1): la forma de lo que sube la PC. Sólo la forma: si los importes son POSIBLES lo decide el
 * servicio (`validarCierre`), que guarda lo imposible como incidencia (422) en vez de perderlo en un 400.
 *
 * 🔴 H3/H4 (Codex servidor r5): «primero la evidencia» empieza AQUÍ. Lo que sube la PC (cierre o duda) sólo exige el sobre mínimo: el
 * folio, que lo FÍSICO sean números legibles (el adeudo; en un cierre también lo que entró, el cambio y el desenlace como texto) y el
 * emparejamiento (la credencial va en el encabezado). Fracciones de centavo, la hora «conocida» sin fecha, el reparto venta/propina, el
 * turno, el modo de cancelación y el carrito los lee el servicio DESPUÉS de guardar la evidencia y el carrito congelado: lo que falla es
 * incidencia (o una duda abierta), nunca un 400 que no guardó nada.
 */
const venueId = z
  .string({ required_error: 'El negocio es requerido', invalid_type_error: 'El negocio debe ser un texto' })
  .cuid('El identificador del negocio no es válido')

const referenceCC = z
  .string({ required_error: 'El folio de la máquina es requerido', invalid_type_error: 'El folio de la máquina debe ser un texto' })
  .regex(CASH_MACHINE_REF, 'El folio de la máquina debe ser AQ seguido de 12 letras mayúsculas o números')

const centavos = (campo: string) =>
  z
    .number({ required_error: `${campo} es requerido`, invalid_type_error: `${campo} debe ser un número de centavos` })
    .finite(`${campo} debe ser un número de centavos`)

const cierre = z.object({
  // Lo físico, legible: los importes como números (enteros, positivos y posibles lo decide el servicio). r6 #8: el desenlace se acepta
  // TAL CUAL (cualquier texto, de cualquier largo, o nada): si no es PAGADO, CANCELADO o GUARDADO, el servicio lo guarda como IMPOSIBLE
  // (422 con incidencia y el dinero), nunca un 400 sin rastro.
  outcome: z.unknown().optional(),
  dueCents: centavos('El adeudo'),
  creditCents: centavos('Lo que entró'),
  changeDispensedCents: centavos('El cambio entregado'),
  // H3/H4: lo administrativo lo lee el servicio (`leerCierreDeLaPc`): lo que no sirve cuenta como desconocido, nunca un 400.
  saleCents: z.unknown().optional(),
  tipCents: z.unknown().optional(),
  occurredAt: z.unknown().optional(),
  occurredAtKnown: z.unknown().optional(),
  saleShiftId: z.unknown().optional(),
  cancelMode: z.unknown().optional(),
})

export const registrarVentaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z.object({
    referenceCC,
    cierre,
    // Rediseño r3 (D1): el carrito tal cual (el JSON de `POST /orders`). Ausente o ilegible NO es 400: el comprobante se guarda primero y,
    // si el carrito no se puede leer, el dinero queda sin venta (202) para el gerente.
    pedido: z.unknown().optional(),
  }),
})

export const consultarVentaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
})

/** R4-3: la IP de la QuickPay en la red del negocio (su WebSocket es `ws://<ip>:8080/`). El aparato sale del encabezado, nunca de aquí. */
export const emparejarAparatoSchema = z.object({
  params: z.object({ venueId }),
  body: z.object({
    machineIp: z
      .string({ required_error: 'La IP de la máquina es requerida', invalid_type_error: 'La IP de la máquina debe ser texto' })
      .trim()
      .ip({ version: 'v4', message: 'La IP de la máquina debe ser una IPv4, por ejemplo 192.168.1.50' }),
  }),
})

export const desemparejarAparatoSchema = z.object({
  params: z.object({ venueId }),
})

/** R4-2: el MISMO cuerpo que `POST /orders` de una venta de mostrador; lo valida `leerVentaDeMostrador`. */
export const cotizarParaLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z.record(z.unknown(), { invalid_type_error: 'El carrito debe ser un objeto' }),
})

/** Centavos enteros ≥ 0 (lo que teclea el gerente; si son POSIBLES lo decide `validarCierre`). */
const centavosEnteros = (campo: string) =>
  z
    .number({ required_error: `${campo} es requerido`, invalid_type_error: `${campo} debe ser un número de centavos` })
    .int(`${campo} debe ser un número entero de centavos`)
    .min(0, `${campo} no puede ser negativo`)

/**
 * R4-4, R5#6: la duda que sube la PC (no sabe cómo terminó la operación). Importes en centavos, como la venta. H3/H4: sólo el adeudo
 * (lo físico) como número legible; el reparto, la hora de inicio, lo que vio la PC (se corta a 16 KB), el turno y lo que vio entrar
 * (`creditCents`, H1, opcional) los lee el servicio DESPUÉS de guardar la duda.
 */
export const subirDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  body: z.object({
    referenceCC,
    dueCents: centavos('El adeudo'),
    saleCents: z.unknown().optional(),
    tipCents: z.unknown().optional(),
    // El MISMO carrito que la venta. r6-2: uno ilegible no es 400; la duda se guarda y nunca se vuelve desenlace por eso.
    pedido: z.unknown().optional(),
    startedAt: z.unknown().optional(),
    lastSeen: z.unknown().optional(),
    creditCents: z.unknown().optional(),
    saleShiftId: z.unknown().optional(),
  }),
})

export const consultarDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
})

export const listarDudasDeLaMaquinaSchema = z.object({
  params: z.object({ venueId }),
  query: z.object({
    status: z
      .enum(['ABIERTO', 'RESUELTO'], { errorMap: () => ({ message: 'El estado de la duda debe ser ABIERTO o RESUELTO' }) })
      .optional(),
    kind: z
      .enum(['ESPERANDO', 'IMPOSIBLE', 'CONFLICTO', 'NO_SE_PUDO_REGISTRAR', 'TRAS_REVOCAR', 'POR_TERMINAR'], {
        errorMap: () => ({
          message: 'El tipo debe ser ESPERANDO, IMPOSIBLE, CONFLICTO, NO_SE_PUDO_REGISTRAR, TRAS_REVOCAR o POR_TERMINAR',
        }),
      })
      .optional(),
    folio: z.string({ invalid_type_error: 'El folio debe ser texto' }).max(32, 'El folio admite hasta 32 caracteres').optional(),
    cursor: z.string({ invalid_type_error: 'El cursor no es válido' }).max(200, 'El cursor no es válido').optional(),
    // Un límite hostil no se rechaza: el servicio lo recorta a 100.
    limit: z.coerce
      .number({ invalid_type_error: 'El límite debe ser un número' })
      .int('El límite debe ser un número entero')
      .positive('El límite debe ser mayor que cero')
      .optional(),
  }),
})

/**
 * R4-4, R5#5, R5#8: lo que el gerente lee en la máquina. Quién resuelve sale de la sesión, nunca de aquí. H5: un folio «pendiente de
 * terminar» (su desenlace ya está guardado) se termina SÓLO con `version`; una duda sin desenlace exige desenlace, importes y lo que vio
 * (400 `CASH_MACHINE_DOUBT_RESOLUTION_INCOMPLETE` si falta).
 */
export const resolverDudaDeLaMaquinaSchema = z.object({
  params: z.object({ venueId, referenceCC }),
  body: z.object({
    outcome: z
      .enum(DESENLACES_DE_LA_MAQUINA, {
        errorMap: () => ({ message: 'El desenlace de la máquina debe ser PAGADO, CANCELADO o GUARDADO' }),
      })
      .optional(),
    creditCents: centavosEnteros('Lo que entró').optional(),
    changeDispensedCents: centavosEnteros('El cambio entregado').optional(),
    occurredAt: z
      .string({ invalid_type_error: 'La hora del comprobante debe ser texto' })
      .datetime({ offset: true, message: 'La hora del comprobante debe ser una fecha ISO' })
      .nullable()
      .optional(),
    evidence: z
      .string({ required_error: 'Escribe lo que viste en la máquina', invalid_type_error: 'Lo que viste en la máquina debe ser texto' })
      .trim()
      .min(1, 'Escribe lo que viste en la máquina')
      .max(500, 'Lo que viste en la máquina admite hasta 500 caracteres')
      .optional(),
    // Codex r2 #10: con CANCELADO o GUARDADO, lo que el gerente VIO hacer a la máquina con los billetes: '1' los devolvió, '2' los
    // guardó. Si cuadra con el desenlace lo decide el servicio, con el MISMO validador que el cierre de la PC (sin él, 422).
    cancelMode: z
      .enum(['1', '2'], { errorMap: () => ({ message: "El modo de cancelación debe ser '1' (devolvió) o '2' (guardó)" }) })
      .nullable()
      .optional(),
    // r6-4: la versión de la evidencia que vio el gerente (la de la lista); si llegó otra, 409 y no se escribe nada.
    version: z
      .number({ required_error: 'Falta la versión del cobro en duda que viste', invalid_type_error: 'La versión debe ser un número' })
      .int('La versión debe ser un número entero')
      .positive('La versión debe ser mayor que cero'),
  }),
})

/** Codex r1 #7: el gerente da por revisada una incidencia que no es duda. Quién la revisa sale de la sesión. */
export const revisarIncidenciaDeLaMaquinaSchema = z.object({
  params: z.object({
    venueId,
    incidentId: z.string({ required_error: 'La incidencia es requerida' }).cuid('El identificador de la incidencia no es válido'),
  }),
  body: z.object({
    note: z
      .string({ required_error: 'Escribe qué revisaste', invalid_type_error: 'La nota debe ser texto' })
      .trim()
      .min(1, 'Escribe qué revisaste')
      .max(500, 'La nota admite hasta 500 caracteres'),
    // Codex r2 #8: la versión de la evidencia que el gerente vio en la lista; si llegó otra, 409 y no se da por revisada.
    version: z
      .number({ required_error: 'Falta la versión de la incidencia que revisaste', invalid_type_error: 'La versión debe ser un número' })
      .int('La versión debe ser un número entero')
      .positive('La versión debe ser mayor que cero'),
  }),
})

/** R3#8, Codex r1 #13: el turno vivo del negocio para la PC de la máquina. */
export const turnoDelNegocioSchema = z.object({
  params: z.object({ venueId }),
})
