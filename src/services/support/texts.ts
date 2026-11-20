import { isSupportDataEnabled, isSupportFreeTextEnabled } from '@/config/supportWhatsapp'

export const SUPPORT_CONTACT =
  'Consulta https://avoqado.io/help o escribe a hola@avoqado.io. No se ha abierto un ticket ni enviado un correo.'
export const SUPPORT_NOTICE =
  'Soy el asistente automático de ayuda de Avoqado. Explico guías revisadas; no opero tu negocio ni consulto ventas privadas. Necesitas internet. WhatsApp (Meta) y el proveedor de IA procesan mensajes; Avoqado conserva preguntas y respuestas hasta 30 días. No envíes contraseñas, PIN, tarjetas ni datos sensibles. Las políticas de los proveedores también aplican: https://avoqado.io/privacy\n\nEscribe CONTINUAR para usar el asistente o SALIR para terminar. Puedes consultar https://avoqado.io/help sin vincular una cuenta.'
export const SUPPORT_NOTICE_FREE_TEXT = SUPPORT_NOTICE.replace(
  'Escribe CONTINUAR para usar el asistente o SALIR para terminar.',
  'Responde SÍ para continuar o SALIR para terminar.',
)
/** Aprobada por el founder el 16-nov. Vive en ESTA línea y en ninguna otra. */
export const SUPPORT_NOTICE_DATA_SENTENCE = 'no opero tu negocio; sólo consulto datos de tu sucursal si lo autorizas en el panel'
/** La frase del aviso de la fase 1 que SUPPORT_NOTICE_DATA_SENTENCE reemplaza con la B prendida. */
const SUPPORT_NOTICE_PHASE1_SENTENCE = 'no opero tu negocio ni consulto ventas privadas'
/** El aviso general con la B prendida: la misma frase de hoy cambia por SUPPORT_NOTICE_DATA_SENTENCE. */
export const SUPPORT_NOTICE_DATA = SUPPORT_NOTICE.replace(SUPPORT_NOTICE_PHASE1_SENTENCE, SUPPORT_NOTICE_DATA_SENTENCE)
export const SUPPORT_NOTICE_DATA_FREE_TEXT = SUPPORT_NOTICE_FREE_TEXT.replace(SUPPORT_NOTICE_PHASE1_SENTENCE, SUPPORT_NOTICE_DATA_SENTENCE)
/** Todo aviso general que el router reconoce como mostrado: un «sí» a uno de antes sigue valiendo al prender o apagar la B. */
export const SUPPORT_NOTICE_TEXTS = [SUPPORT_NOTICE, SUPPORT_NOTICE_FREE_TEXT, SUPPORT_NOTICE_DATA, SUPPORT_NOTICE_DATA_FREE_TEXT]
// The B depends on free text (through hybrid), so with it on the notice is always the free-text one.
export const supportNotice = () =>
  isSupportDataEnabled() ? SUPPORT_NOTICE_DATA_FREE_TEXT : isSupportFreeTextEnabled() ? SUPPORT_NOTICE_FREE_TEXT : SUPPORT_NOTICE
export const SUPPORT_ASK_APP =
  '¿Qué app usas? Responde con una opción:\n1. Dashboard web\n2. POS Android\n3. POS Windows\n4. Terminal de cobro PAX/Nexgo'
/** El nombre de cada app como lo lee una persona: el resumen de hoy y el correo del aviso (sin efectos al importarse). */
export const SUPPORT_APP_LABELS: Record<string, string> = {
  dashboard: 'Dashboard web',
  android: 'POS Android',
  windows: 'POS Windows',
  tpv: 'Terminal de cobro',
}
export const SUPPORT_GREETING = '¡Hola! Escribe tu duda con tus palabras, por ejemplo: «¿Cómo cambio de sucursal?».'
/** Un «gracias», «va» u «ok» después de una respuesta: no se vuelve a saludar. El founder puede cambiar la redacción (barra 8). */
export const SUPPORT_THANKS = 'Con gusto. Si tienes otra duda, escríbela con tus palabras.'
export const SUPPORT_NO_COVERAGE = `Todavía no tengo una guía verificada para esa app, versión o pregunta. ${SUPPORT_CONTACT}`
export const SUPPORT_HYBRID_UNKNOWN =
  'No encontré eso en nuestras guías y prefiero no adivinar. Escríbenos a hola@avoqado.io y te ayudamos.'
export const SUPPORT_REPHRASE = 'No te entendí bien. ¿Me lo escribes de otra forma? Por ejemplo: «¿cómo cambio de sucursal?».'
export const SUPPORT_OFF_TOPIC = 'Sólo puedo ayudarte con dudas de uso de Avoqado: el panel, el POS o la terminal. ¿En qué te ayudo?'
/** La aclaración: esta línea, una por opción (`• <título>: <publicUrl>`, nunca su descripción: T-F6c) y el cierre. La escribe el código, nunca la IA. */
export const SUPPORT_CLARIFY = '¿Te refieres a alguna de estas?'
export const SUPPORT_CLARIFY_CLOSE = 'Cuéntame cuál y te explico paso a paso.'
/** El cierre de una aclaración que sale con el modo híbrido apagado: ya no promete explicar. */
export const SUPPORT_CLARIFY_OPEN_GUIDE = 'Abre la guía que corresponda o escríbenos a hola@avoqado.io.'
/** Igual, cuando alguna opción es una página interna del manual: ésa no tiene guía que abrir. */
export const SUPPORT_CLARIFY_CLOSE_MANUAL = 'Escríbenos a hola@avoqado.io y te ayudamos con la que corresponda.'
/** Las preguntas de versión y de terminal, iguales con y sin el modo híbrido; el router guarda la respuesta. */
export const SUPPORT_ASK_VERSION = '¿Qué versión de la app usas? Escríbela como aparece en la app (por ejemplo, 2.10.1).'
export const SUPPORT_ASK_DEVICE = '¿Qué terminal usas?\n1. PAX\n2. Nexgo'
/** La página elegida es de una versión más nueva que la de la persona: va delante de la guía literal. */
export const supportOldVersion = (min: string) => `Esta guía es para la versión ${min} o más nueva; te recomiendo actualizar la app.`
/**
 * T-F6 (Codex H3): una guía que no cabe entera en WhatsApp sale como tarjeta: su título, esto y su enlace. Nunca sus pasos ni su
 * resumen sin el resto de la guía, que es donde viven sus condiciones y advertencias.
 */
export const SUPPORT_GUIDE_TOO_LONG = 'Esta guía es larga para WhatsApp; ábrela para ver los pasos y advertencias.'
/**
 * La misma tarjeta para una página del manual interno, que no tiene enlace que abrir: ofrece pasar con una persona en este mismo
 * chat, con la palabra PERSONA que la fase 1 ya contesta con el traspaso (router.service.ts). T-F6c. El founder puede cambiar la redacción.
 */
export const SUPPORT_GUIDE_TOO_LONG_MANUAL =
  'Esta guía es larga para WhatsApp. Si quieres, te paso con una persona del equipo: escribe PERSONA.'
/**
 * Cuánto puede medir una respuesta REDACTADA (renderSupportAnswer) o cualquier otro texto de soporte que no es la guía literal.
 * T-F13: 1,500 siempre (el 2,000 de T-F8.3 para una respuesta con el bloque «Importante» se fue con el bloque).
 */
export const SUPPORT_DRAFT_CAP = 1500
/**
 * T-F10c («lo seguro debe ser lo completo»): la guía literal (composeVerifiedGuides) va ENTERA y tal cual hasta 3,500, con sus
 * avisos al frente. Medido sin IA con la biblioteca real (138 guías): solas, enteras caben 72 en 1,500, 129 en 2,500, 135 en 3,000,
 * 135 en 3,500 y 136 en 3,900; en 3,500 caben las 135 también con la línea de la sucursal más larga, el aviso de reenvío y el de
 * versión vieja con la oferta. 3,900 sólo agrega una guía sola, y sin esos avisos. WhatsApp acepta 4,096 en `text.body`: quedan 596.
 * Lo que no cabe entero en 3,500 sale como su tarjeta, como antes.
 */
export const SUPPORT_LITERAL_CAP = 3500
/**
 * T-F10c: el tope de un texto de soporte YA ARMADO, leído del texto: el de la redacción (SUPPORT_DRAFT_CAP) mientras cabe en él;
 * más largo sólo puede ser la guía literal, porque la redacción nunca pasa de su tope, así que SUPPORT_LITERAL_CAP. Lo usan la
 * entrega (los avisos al frente y la última guarda), REINTENTAR (con el texto de antes, sin su aviso) y el envío, para que digan lo
 * mismo.
 */
export const supportTextCap = (text: string): number => (text.length > SUPPORT_DRAFT_CAP ? SUPPORT_LITERAL_CAP : SUPPORT_DRAFT_CAP)
/**
 * T-F14 (H-T15-1, la prueba del founder del 18-nov: «¿quién abrió la caja hoy y cómo agrego un producto?» contestó sólo lo de la
 * caja y lo otro se perdió sin aviso): el mensaje traía otra pregunta que la respuesta no contesta. Entender lo marca en su misma
 * salida (`otherQuestion`, sin otra llamada a la IA) y esta línea fija va al final. La escribe el código, nunca la IA, y no trae
 * cifras, enlaces ni correos: puede ir detrás de las cifras selladas de la B. El founder puede cambiar la redacción.
 */
export const SUPPORT_OTHER_QUESTION = 'También preguntaste otra cosa: mándamela en otro mensaje y te contesto.'
/**
 * El texto con SUPPORT_OTHER_QUESTION en su propio párrafo al final, si `also` y si cabe en `cap`: por default, el tope del texto
 * sin ella (supportTextCap); quien arma la guía literal pasa SUPPORT_LITERAL_CAP. Si no cabe, el texto sale entero y sin la línea,
 * nunca recortado. ponytail: a menos de 73 caracteres de su tope (de 1,428 a 1,500, o de 3,428 a 3,500 la guía literal) la línea
 * no cabe y no sale; si pasa seguido, se le reserva su espacio al redactar.
 */
export function withOtherQuestion(text: string, also: boolean, cap = supportTextCap(text)): string {
  if (!also || !text || text.endsWith(SUPPORT_OTHER_QUESTION)) return text
  const joined = `${text}\n\n${SUPPORT_OTHER_QUESTION}`
  return joined.length <= cap ? joined : text
}
/** T-F14: un texto que se rearma desde sus guías (la entrega, REINTENTAR) conserva la línea si el guardado la traía. */
export const keepOtherQuestion = (saved: string | null, rebuilt: string, cap?: number): string =>
  withOtherQuestion(rebuilt, !!saved?.endsWith(SUPPORT_OTHER_QUESTION), cap)
/** La cita de una página interna sin enlace público (R1-08). */
export const supportManualSource = (title: string) => `Fuente: manual de Avoqado · ${title}`
/**
 * T-F10a (Codex P2): junto al título de una guía en el resumen para una persona y en el aviso al equipo, cuando la versión que se
 * mostró ya no es la publicada: el título de hoy no es el de entonces.
 */
export const SUPPORT_GUIDE_CHANGED = '(la guía cambió después)'
/**
 * T-F11: lo que entender y la redacción ven en el historial de una respuesta que no cabe en él (la guía literal entera, de más de
 * 2,000): los títulos de sus guías, nunca su texto. La primera siempre salió entera (dos tarjetas nunca llegan a 2,000); la segunda,
 * entera o como su tarjeta.
 */
export const supportLongAnswerMark = ([first, ...rest]: string[]) =>
  `[Se mandó la guía «${first}» completa${rest.map(t => ` y la guía «${t}»`).join('')}]`
/** Pasar a una persona. Los topes alcanzados dicen `supportHandoffAlready`: el cliente nunca se entera de los topes. */
export const supportHandoffDone = (number: string) =>
  `Listo, ya le avisé al equipo de Avoqado. Una persona te va a escribir por WhatsApp desde el ${number}. Mientras, puedo seguir ayudándote con las guías.`
export const supportHandoffAlready = (number: string) => `Ya le avisé al equipo; te van a escribir desde el ${number}.`
export const SUPPORT_HANDOFF_OFFER = '¿Quieres que te escriba una persona del equipo de Avoqado?'
/** La segunda falla seguida: corta, siempre cabe con la guía más cercana y la oferta (R1-13). */
export const SUPPORT_SECOND_FAILURE = 'No encontré eso en nuestras guías.'
/** El saludo que abre el botón del correo (wa.me). */
export const SUPPORT_HANDOFF_GREETING = 'Hola, te escribo de Avoqado por tu mensaje en el asistente de ayuda.'
export const SUPPORT_LINK =
  'Para adaptar las instrucciones a tus permisos, vincula un WhatsApp personal desde https://dashboard.avoqado.io/support/whatsapp. Si el teléfono es compartido, conserva ayuda pública.'
export const SUPPORT_SENSITIVE =
  'Por privacidad omití tu texto y no lo enviaré al asistente. Para recuperar tu contraseña, abre https://dashboard.avoqado.io/auth/forgot-password. Para dudas sobre el PIN o acceso al negocio, consulta https://avoqado.io/help o escribe a hola@avoqado.io. Si tu duda es de un cobro u otra cosa, escríbela otra vez sin mencionar el NIP, el PIN, la clave ni el código. No compartas contraseñas, PIN, códigos, tarjetas ni secretos.'
export const SUPPORT_SEND_RETRY_NOTICE = 'Este es el único reenvío que pediste. El primer mensaje pudo haber llegado.'
export const SUPPORT_UNREGISTERED =
  'Hola, soy el asistente de ayuda de Avoqado. Por ahora este WhatsApp atiende a equipos de negocios registrados. Guías: https://avoqado.io/help · Soporte: hola@avoqado.io · ¿Te interesa Avoqado? Escríbenos: https://wa.me/525640070001'
