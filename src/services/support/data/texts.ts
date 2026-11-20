import crypto from 'crypto'
import { deepFreeze } from '@/utils/deepFreeze'

/**
 * Todos los textos de la B (datos de la cuenta, sólo lectura). Los de una capacidad (`label`, `object`, `aiHint`) viven en su archivo y
 * el catálogo los congela al registrarla. Sin efectos al importarse.
 * T-B44: lo que aquí es un objeto o un arreglo nace congelado (deepFreeze, una vez al cargar): `as const` sólo lo cuida el compilador,
 * y un `Object.assign` en ejecución lo cambiaba. Los demás son textos (no se pueden cambiar) y funciones que sólo leen estas constantes.
 */

/** El aviso de la B, aprobado por el founder (16-nov). La persona lo acepta en el panel; su huella cambia sola con el texto. */
export const SUPPORT_DATA_NOTICE: { readonly es: string; readonly en: string } = deepFreeze({
  es: 'Para mostrarte datos de tu negocio por WhatsApp necesito tu permiso. Sólo leo; no cambio nada. Te muestro lo mismo que tu puesto ve en el panel, de la sucursal que estés viendo. Las cifras las escribe Avoqado: la IA sólo lee tu pregunta para saber qué dato quieres, y nunca ve las cifras. Para consultar cualquier dato tienes que tocar «Consultar datos por WhatsApp hoy» aquí, en el panel, cada día; por WhatsApp nunca te voy a pedir un código ni una contraseña. Guardo las respuestas con datos, cifradas, hasta 30 días, y un registro sin cifras de qué consultaste 90 días.',
  en: "To show you your business data on WhatsApp I need your permission. I only read; I don't change anything. I show you what your role already sees in the dashboard, for the venue you are viewing. Avoqado writes the figures: the AI only reads your question to know which data you want, and never sees the figures. To check any data you have to tap “Check data on WhatsApp today” here, in the dashboard, each day; on WhatsApp I will never ask you for a code or a password. I keep answers with data, encrypted, for up to 30 days, and a record without figures of what you checked for 90 days.",
})
/** sha256 hex del aviso en ese idioma. */
export const supportDataNoticeHash = (language: 'es' | 'en'): string =>
  crypto.createHash('sha256').update(SUPPORT_DATA_NOTICE[language]).digest('hex')
/** Las huellas vigentes: una aceptación vale con cualquiera de las dos. */
export const supportDataNoticeHashes = (): string[] => [supportDataNoticeHash('es'), supportDataNoticeHash('en')]

export const SUPPORT_DATA_OMITTED = '[dato omitido]'
export const SUPPORT_DATA_OFF = 'Todavía no consulto datos de tu negocio por aquí. Puedo ayudarte con las guías.'
export const SUPPORT_DATA_LINK_FIRST =
  'Para consultar datos de tu negocio, vincula tu WhatsApp personal en https://dashboard.avoqado.io/support/whatsapp.'
export const SUPPORT_DATA_SUPERADMIN = 'Con una cuenta de superadmin no consulto datos de negocios por WhatsApp. Usa el panel.'
export const SUPPORT_DATA_NEEDS_UNLOCK =
  'Para consultar datos de tu negocio, abre el panel › Soporte por WhatsApp › Consultar datos por WhatsApp hoy: https://dashboard.avoqado.io/support/whatsapp'
const OUT_OF_CATALOG = 'Todavía no consulto ese dato por WhatsApp.'
/** labels en el orden del catálogo: «a, b, c y d». */
export const supportDataOutOfCatalog = (labels: string[]) =>
  `${OUT_OF_CATALOG} Por aquí puedo darte: ${labels.slice(0, -1).join(', ')}${labels.length > 1 ? ' y ' : ''}${labels[labels.length - 1] ?? ''}.`
/**
 * T-B43: una negativa de la B es un texto FIJO, nunca un dato: ninguna lleva texto de la base ni del alcance (ni la sucursal, ni la
 * persona, ni la organización). Sólo dos llevan texto del catálogo, literal en el archivo de su capacidad: la lista de lo que sí
 * puede (sus `label`) y la de sin permiso (su `object`). Una negativa se guarda como ayuda (HELP), sin cifrar, y llega tal cual al
 * historial del modelo: por eso nunca lleva un dato.
 */
export const supportDataNoPermission = (object: string) =>
  `Con tus permisos en esta sucursal no puedo mostrarte ${object}. Pídeselo a quien administra tu negocio.`
export const SUPPORT_DATA_OTHER_VENUE = 'Sólo veo la sucursal que tienes elegida. Para otra sucursal, escribe SUCURSAL.'
const paramInvalid = (what: 'el monto' | 'el día') => `No te entendí ${what}. Escríbelo así: «¿entró un cobro de $850 hoy a las 14:30?».`
/**
 * Las negativas que elige una capacidad, por su llave (`DataRefusalKey`): lo que devuelve `notOffered`, el `{ ok: false }` de
 * `params`, la de `DataReadRefusal` y la de su candado de plan. Una capacidad que necesita otra agrega aquí su llave y su texto fijo;
 * la guardia (`supportDataCapabilitiesNoDb.test.ts`) sólo deja escribir en la capacidad una llave literal de este conjunto.
 */
export const SUPPORT_DATA_REFUSALS = deepFreeze({
  /** La genérica: también la que sale si llega una llave que no es de aquí (supportDataRefusal). */
  NOT_AVAILABLE: 'Ese dato no está disponible por WhatsApp en esta sucursal. Lo encuentras en el panel.',
  PARAM_AMOUNT: paramInvalid('el monto'),
  PARAM_DAY: paramInvalid('el día'),
  /** T-B48: un monto chico sin «$» junto a una hora se niega aquí; el «$» es la salida, así que se dice. Mismos dígitos que las otras dos. */
  PARAM_TIME: 'No te entendí la hora. Escribe el monto con $ y la hora así: «¿entró un cobro de $850 hoy a las 14:30?».',
  /** El candado de plan de «reservaciones de hoy» (C4), el de la pantalla de Reservaciones. */
  PLAN_RESERVATIONS: 'Reservaciones es parte del plan Pro.',
  /** «Ventas de hoy» (C1) no se ofrece en la sucursal que suma cobros del puente de QR anterior (su `notOffered`). */
  SALES_LEGACY_QR:
    'Las ventas de esta sucursal todavía incluyen cobros del sistema anterior, y por aquí no puedo darte el total completo. Velo en Reportes › Resumen de ventas.',
  /** «Ventas de hoy» (C1) sólo contesta hoy (su `params`). */
  SALES_TODAY_ONLY: 'Por aquí sólo veo las ventas de hoy; las demás están en Reportes › Resumen de ventas.',
  /** «Reservaciones de hoy» (C4) sólo contesta hoy (su `params`). */
  RESERVATIONS_TODAY_ONLY: 'Por aquí sólo veo las reservaciones de hoy; las demás están en el panel.',
  /** El candado de plan de «lo que cae en el banco esta semana» (C6), el de Saldo Disponible. */
  PLAN_DEPOSITS: 'Saldo Disponible es parte del plan Pro.',
  /** «Lo que cae en el banco esta semana» (C6) no se ofrece sin la verificación aprobada del negocio (su `notOffered`). */
  DEPOSITS_NEEDS_KYC: 'Saldo Disponible se abre cuando tu negocio tiene aprobada su verificación.',
  /** «Lo que cae en el banco esta semana» (C6) sólo contesta la semana en curso (su `params`). */
  DEPOSITS_THIS_WEEK_ONLY: 'Por aquí sólo veo lo que cae esta semana; las demás están en Reportes › Saldo Disponible.',
  /** «Lo que cae en el banco esta semana» (C6) cuando no puede sumar la semana con exactitud (su `DataReadRefusal`). */
  DEPOSITS_OVER_CAP: 'Esta semana no puedo calcularlo por aquí con exactitud. Velo en Reportes › Saldo Disponible.',
  /** El candado de plan de «si la venta de ese cobro tiene factura» (C7), el de las ventas con su factura en el panel. */
  PLAN_INVOICES: 'Facturación es parte del plan Premium.',
  /** «Quién abrió o cerró la caja» (C8) sólo contesta hoy y ayer (su `params`). */
  CASH_DRAWER_TODAY_OR_YESTERDAY: 'Por aquí sólo veo la caja de hoy y de ayer; lo demás está en Turnos de caja.',
} as const)
export type DataRefusalKey = keyof typeof SUPPORT_DATA_REFUSALS
/** El texto de una llave. Lo que no es una llave del conjunto (un `as`, un `any`) da la genérica, nunca el valor recibido. */
export const supportDataRefusal = (key: unknown): string =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(SUPPORT_DATA_REFUSALS, key)
    ? SUPPORT_DATA_REFUSALS[key as DataRefusalKey]
    : SUPPORT_DATA_REFUSALS.NOT_AVAILABLE
export const SUPPORT_DATA_QUERY_FAILED = 'No pude leer ese dato ahorita. Inténtalo en unos minutos.'
export const SUPPORT_DATA_CHECK_FAILED = 'No pude confirmar la cifra, así que no te la doy.'
export const SUPPORT_DATA_DAILY_CAP = 'Llegaste al límite de consultas de datos de hoy. Lo demás está en el panel.'
export const SUPPORT_DATA_STALE = 'Ese dato ya cambió; vuelve a preguntar.'
export const SUPPORT_DATA_RETRY = 'Para datos al momento, vuelve a preguntar.'
/** Las negativas de la B que no llevan capacidad (apagada, sin vínculo, superadmin, fuera del catálogo): así empiezan. */
const REFUSALS_WITHOUT_CAPABILITY = deepFreeze([SUPPORT_DATA_OFF, SUPPORT_DATA_LINK_FIRST, SUPPORT_DATA_SUPERADMIN, OUT_OF_CATALOG])
/**
 * true si un texto guardado es una de esas negativas: sola, con la oferta de una persona detrás o con el aviso de un reenvío
 * delante (cada una es un párrafo propio). Las demás negativas de la B se reconocen por su `dataCapability`.
 */
export const isSupportDataRefusalWithoutCapability = (answer: string | null): boolean =>
  !!answer && answer.split('\n\n').some(part => REFUSALS_WITHOUT_CAPABILITY.some(lead => part.startsWith(lead)))
/**
 * Lo que ve la IA en el historial en lugar de una respuesta con datos: el `label` congelado del catálogo (dataLabel). Si la
 * capacidad ya no está (null), la marca sin etiqueta: nunca la llave guardada en la base (T-B44).
 */
export const supportDataHistoryMark = (label: string | null) =>
  label ? `[respuesta con datos de ${label}; no se muestran al asistente]` : '[respuesta con datos; no se muestran al asistente]'
