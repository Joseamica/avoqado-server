/**
 * HubSpot Forms API client — un solo uso hoy: copiar al CRM el lead que la
 * landing ya capturó (POST /api/v1/public/contact). La fuente de la verdad
 * sigue siendo la cuenta que se crea en Avoqado; HubSpot es el espejo
 * comercial donde ventas le da seguimiento.
 *
 * 🔑 Por qué la FORMS API y NO la API de contactos (decisión, no preferencia):
 * la API de contactos NO acepta el `hutk` — la cookie que HubSpot le pone al
 * visitante — y HubSpot marca como `Offline Sources` todo contacto creado por
 * ahí. Es exactamente por eso que los 198 contactos que había en el portal el
 * 2026-08-25 tenían `hs_analytics_source: OFFLINE`: eran una importación a
 * mano, sin sesión detrás. Con la Forms API + `hutk` el contacto conserva la
 * campaña, el anuncio y las páginas que vio antes de llenar el formulario, que
 * es la única razón de negocio para tenerlo en el CRM.
 * Doc: https://developers.hubspot.com/docs/api-reference/legacy/marketing/forms/v3-legacy
 *
 * Endpoint público a propósito: `/submissions/v3/integration/submit` NO pide
 * token (el `/secure/submit` sí, sólo para subir el rate limit). Así esta
 * integración no mete ningún secreto nuevo al server — el portalId y el
 * formGuid son identificadores públicos, viajan en cualquier formulario
 * embebido de HubSpot. Rate limit del endpoint público: 50 req / 10 s, tres
 * órdenes de magnitud arriba de nuestro volumen de leads.
 *
 * 🔴 Este cliente NUNCA lanza hacia arriba: un CRM caído no puede costar un
 * lead. Devuelve `false` y loguea. El caller ignora el resultado salvo para
 * el log.
 */
import axios from 'axios'
import logger from '../../config/logger'

const SUBMIT_URL = 'https://api.hsforms.com/submissions/v3/integration/submit'

/**
 * Identificadores del formulario espejo en HubSpot. Públicos, no son secretos.
 * Se leen POR LLAMADA y no al cargar el módulo: así el orden de los imports
 * nunca decide si la integración quedó prendida.
 */
function portalId(): string {
  return process.env.HUBSPOT_PORTAL_ID || ''
}
function formGuid(): string {
  return process.env.HUBSPOT_FORM_GUID || ''
}

/** Apagado mientras no estén las dos variables. Sin ellas no hay a dónde mandar. */
export function isHubspotEnabled(): boolean {
  return Boolean(portalId() && formGuid())
}

export interface HubspotLead {
  email: string
  firstName: string
  lastName: string
  phone: string
  companyName: string
  /** Cookie `hubspotutk` del visitante. Sin ella el lead entra como "Offline". */
  hutk?: string
  pageUri?: string
  pageName?: string
  // Calificación del paso 2 del formulario. Opcional a propósito: ese paso se
  // puede omitir y el lead sigue valiendo. Cada uno tiene su propiedad
  // personalizada en HubSpot, todas de texto libre — ver la nota de abajo.
  businessType?: string
  branches?: string
  revenue?: string
  modules?: string
}

/**
 * Copia un lead al CRM. Devuelve `true` sólo si HubSpot confirmó el alta.
 *
 * 🔴 La Forms API rechaza el envío COMPLETO con `FIELD_NOT_IN_FORM_DEFINITION`
 * si llega UN campo que no está en la definición del formulario. Mandar de más
 * aquí no degrada el lead: lo pierde entero. Por eso los nombres de abajo son
 * literales verificados contra el portal, no inventados, y por eso los campos
 * vacíos se filtran antes de salir.
 *
 * Las cuatro propiedades de calificación son de TEXTO LIBRE a propósito, no
 * desplegables: un desplegable obliga a que el valor coincida exacto con su
 * lista, y el día que alguien agregue un giro nuevo en la landing, HubSpot
 * rechazaría ese lead completo. Se segmenta igual con filtros "contiene".
 */
export async function sendLeadToHubspot(lead: HubspotLead): Promise<boolean> {
  if (!isHubspotEnabled()) return false

  const fields = [
    { name: 'email', value: lead.email },
    { name: 'firstname', value: lead.firstName },
    { name: 'lastname', value: lead.lastName },
    { name: 'phone', value: lead.phone },
    { name: 'company', value: lead.companyName },
    // Nombres internos verificados en el portal 51907484 (2026-08-25).
    { name: 'giro_del_negocio', value: lead.businessType },
    { name: 'sucursales', value: lead.branches },
    { name: 'ventas_al_mes', value: lead.revenue },
    { name: 'modulos_de_interes', value: lead.modules },
  ].filter(f => typeof f.value === 'string' && f.value.trim() !== '') as { name: string; value: string }[]

  // `context` es lo que convierte un renglón en un lead con historia. Se omite
  // cada campo vacío: HubSpot rechaza un `hutk` presente pero inválido.
  const context: Record<string, string> = {}
  if (lead.hutk) context.hutk = lead.hutk
  if (lead.pageUri) context.pageUri = lead.pageUri
  if (lead.pageName) context.pageName = lead.pageName

  try {
    await axios.post(
      `${SUBMIT_URL}/${portalId()}/${formGuid()}`,
      { fields, ...(Object.keys(context).length > 0 ? { context } : {}) },
      { timeout: 8_000, headers: { 'Content-Type': 'application/json' } },
    )
    logger.info('[HUBSPOT] Lead copiado al CRM', {
      email: lead.email,
      // Sirve para responder "¿por qué este lead salió sin campaña?" sin
      // guardar el token del visitante en el log.
      conAtribucion: Boolean(lead.hutk),
    })
    return true
  } catch (err) {
    const e = err as any
    logger.error('[HUBSPOT] No se pudo copiar el lead al CRM (el lead NO se pierde)', {
      email: lead.email,
      status: e?.response?.status,
      body: e?.response?.data,
    })
    return false
  }
}
