/**
 * Plantilla del aviso de privacidad del NEGOCIO — Fase 1C, Task 8.
 *
 * Para qué existe: hoy CERO negocios tienen un aviso de privacidad escrito, y sin uno
 * `consent.service.ts` — correctamente — rechaza registrar cualquier consentimiento. Este
 * texto es lo que `getCurrentPrivacyNotice` usa para PRECARGAR el editor del dashboard,
 * para que el dueño sólo tenga que revisar sus datos y publicar, en vez de enfrentarse a
 * una hoja en blanco.
 *
 * 🔴 El texto sale LITERAL de
 * `docs/campanas/2026-09-02-plantilla-aviso-privacidad-negocio.md`, ya revisado contra la
 * LFPDPPP VIGENTE (reforma publicada en el DOF el 20-mar-2025, la que ELIMINÓ al INAI y
 * trasladó la autoridad a la Secretaría Anticorrupción y Buen Gobierno). No se parafrasea
 * ni se resume — cambiar el texto legal sin pasar por ese documento fuente sería reintroducir
 * el mismo error que esta plantilla existe para no repetir.
 *
 * 🔴 Es SÓLO un borrador de precarga: `getCurrentPrivacyNotice` la marca `esPlantilla: true`,
 * y `writeConsent` (consent.service.ts) NUNCA pasa por aquí — tiene su propia consulta a
 * `PrivacyNoticeVersion` y sigue rechazando el consentimiento de un venue sin una versión
 * REAL guardada. La plantilla no cuenta como aviso publicado.
 */

const TEXTO_BASE = `### Aviso de Privacidad

**{{nombreDelNegocio}}**, con domicilio en {{domicilioDelNegocio}}, es responsable del tratamiento
de sus datos personales conforme a la Ley Federal de Protección de Datos Personales en Posesión de
los Particulares.

**Qué datos tratamos.** Su nombre, correo electrónico y, si usted los proporciona, su teléfono y su
fecha de cumpleaños, junto con el historial de sus compras en nuestro negocio. No tratamos datos
personales sensibles.

**Para qué los usamos.**

*Finalidades necesarias* (imprescindibles para atenderle): registrar su compra, emitir su
comprobante o factura, dar seguimiento a garantías o aclaraciones, y contactarle por cuestiones
relacionadas con un pedido o servicio.

*Finalidades adicionales* (opcionales — **usted decide**, y no condicionan que le atendamos):
enviarle promociones, novedades y felicitaciones de cumpleaños por correo electrónico.

**Su consentimiento para lo opcional.** Sólo le enviaremos comunicaciones promocionales si usted lo
acepta expresamente. Puede **retirar ese consentimiento en cualquier momento**, con un solo clic en
el enlace «Dejar de recibir estos correos» que aparece al final de cada mensaje, o escribiéndonos a
{{contactoDelNegocio}}. Dejaremos de enviarle promociones sin que ello afecte el servicio que le
damos.

**Quién nos ayuda a tratarlos.** Utilizamos la plataforma **Avoqado** (Servicios Tecnológicos Avo
S.A. de C.V.) como **encargado**: trata sus datos únicamente por nuestra cuenta y siguiendo nuestras
instrucciones, sin usarlos para fines propios. Para la entrega de los correos, Avoqado se apoya en
el proveedor **Resend**, cuyos servidores se ubican en Estados Unidos. No vendemos, ni compartimos
con terceros para fines propios de éstos, ni cruzamos su información con la de otros negocios.

**Sus derechos ARCO.** Usted puede solicitar el **acceso** a sus datos, su **rectificación** cuando
sean inexactos, su **cancelación** cuando considere que no se requieren, y **oponerse** a un uso
específico. Para ejercerlos, escríbanos a {{contactoDelNegocio}} indicando su nombre, el derecho que
desea ejercer y un medio para responderle. Le contestaremos en un plazo máximo de 20 días hábiles.

**Cuánto los conservamos.** Los datos de su compra se conservan mientras exista una obligación
fiscal o legal de hacerlo. La información sobre el envío de promociones se conserva **24 meses**.
Si usted pide dejar de recibir correos, **conservamos ese registro de forma indefinida**,
precisamente para asegurarnos de no volver a escribirle.

**Cambios a este aviso.** Cualquier modificación se publicará en este mismo medio y, cuando el
cambio afecte las finalidades opcionales, se lo haremos saber antes de seguir enviándole
comunicaciones.

**Autoridad.** Si considera que su derecho a la protección de datos personales fue vulnerado, puede
acudir a la **Secretaría Anticorrupción y Buen Gobierno** (gob.mx/buengobierno), autoridad en la
materia desde la entrada en vigor de la nueva Ley Federal de Protección de Datos Personales en
Posesión de los Particulares, publicada el 20 de marzo de 2025.

*Última actualización: {{fechaDePublicacion}}.*`

/** `es-MX`, zona del negocio no aplica aquí — es sólo la fecha de precarga, no un dato guardado. */
function formatearFecha(fecha: Date): string {
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' }).format(fecha)
}

/**
 * Sustituye los `{{marcadores}}` del texto base por los datos del venue. `domicilio` es
 * opcional (no todo venue lo tiene capturado) — sin él se deja un placeholder explícito en
 * vez de un hueco en blanco, para que la precarga NUNCA deje un `{{marcador}}` sin resolver
 * ni una oración rota ("con domicilio en , es responsable...").
 */
export function plantillaDeAviso(p: { nombreDelNegocio: string; domicilio?: string; contacto: string; fecha: Date }): string {
  const nombre = p.nombreDelNegocio.trim() || '(nombre del negocio pendiente)'
  const domicilio = p.domicilio?.trim() || '(domicilio pendiente de captura)'
  const contacto = p.contacto.trim() || '(dato de contacto pendiente)'
  const fecha = formatearFecha(p.fecha)

  return TEXTO_BASE.split('{{nombreDelNegocio}}')
    .join(nombre)
    .split('{{domicilioDelNegocio}}')
    .join(domicilio)
    .split('{{contactoDelNegocio}}')
    .join(contacto)
    .split('{{fechaDePublicacion}}')
    .join(fecha)
}
