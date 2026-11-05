---
paths:
  - 'src/services/crm/email/**/*.ts'
  - 'src/jobs/crm-*.ts'
  - 'src/mcp/tools/crm.ts'
  - 'src/controllers/webhooks/resend.webhook.controller.ts'
  - 'src/controllers/crm/crmEmail.controller.ts'
  - 'src/routes/crm.routes.ts'
---

# CRM propio · correo (fase 2: plantillas, campañas masivas y Gmail del vendedor)

Las campañas masivas salen por Resend desde `novedades.avoqado.io`; el uno a uno, del Gmail del vendedor. Todo el código vive en
`src/services/crm/email/`. Las dos 🔴 que protegen a cualquiera (fuera de producción, y la liga de baja de la prueba) también están en el
`CLAUDE.md`.

## 🔴 Fuera de producción no sale correo a nadie real

Si `NODE_ENV !== 'production'`, sólo se manda a las direcciones de `CRM_CORREO_PRUEBAS` (separadas por comas, en minúsculas; vacía = no sale
nada). Las demás quedan `OMITIDO` con «fuera de la lista de prueba», y en el Gmail la API responde 422. Es **una** función,
`puedeMandarFueraDeProduccion` (`testAllowlist.ts`), y también la usan los avisos del CRM (`digest.service.ts`), los dos correos del
formulario de la landing y el marketing viejo del superadmin (`marketing.superadmin.service.ts`, que además respeta `isBlocked`). `av-db-25`
trae correos de gente real.

## «Eliminar» (D7) y las campañas

`deleteAccount` deja `OMITIDO` «persona eliminada» lo que esperaba en la cola para esa cuenta o sus correos, y borra su `CrmEmailConsent`
aunque cuelgue de otra cuenta o de ninguna. El remitente vuelve a mirar al borde: cuenta que ya no existe, o correo en la lápida desde un
minuto antes de encolar (`correoEliminadoDesde`, `erase.service.ts`). El marketing viejo del superadmin hace la misma pregunta desde que
empezó su campaña. El historial (`CrmEmailMessage`, deliveries) es de D1.

## 🔴 La vista previa se ata a la versión que se ve (`huella`, H3 del 4-nov)

La vista de una campaña trae `huella` (contenido + público; campo nuevo y opcional). La pantalla la manda en `POST /campaigns/:id/preview`
(`{ huella }`): si la campaña ya cambió, 409 `CRM_CAMPANA_CAMBIO` y no se firma token. Sin `huella` (pantalla vieja), igual que antes. Así
quien sólo tiene `mandar` nunca confirma una versión que otra persona cambió mientras la veía. La respuesta de la vista previa también trae
la `huella` que contó y firmó, y la pantalla sólo deja mandar si es la que enseña (una reversa a un SERVIDOR viejo no la manda: «Mandar» se
cierra y sale en gris). No quites ese campo.

## Llaves del CRM (plan 2026-11-04, L4–L9): cada ruta pide la suya

| Llave                                                       | Abre                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crm:plantillas`                                            | crear, editar, archivar y desarchivar plantillas, y su correo de prueba                                                                                                                                                                                          |
| `crm:contactar` · `crm:plantillas` · `crm:preparar`         | leer plantillas (también `crm_list_email_templates`); `/templates/preview` además con `crm:ver-campanas`                                                                                                                                                         |
| `crm:plantillas` · `crm:preparar`                           | subir una imagen                                                                                                                                                                                                                                                 |
| `crm:ver-campanas` (la traen también `preparar` y `mandar`) | lista, detalle y conteo de campañas (también `crm_campaign_status`)                                                                                                                                                                                              |
| `crm:ver-campanas`                                          | `GET /campaigns/:id/recipients` «Ver quiénes» (sólo en BORRADOR, 409 si no): una consulta SQL por página, `LIMIT` ≤ 100 impuesto en el servidor, cursor opaco, **sin total** (la pantalla usa el «Le llega a N»); las bajas se quitan en SQL con `sqlBloqueado`. |
| `crm:preparar`                                              | crear y editar una campaña, y su prueba                                                                                                                                                                                                                          |
| `crm:preparar` | `GET /campaign-people?q=` «Agregar»: busca sólo entre personas **visibles** del CRM (nunca cuenta archivada, cliente oculto ni equipo, ni sus datos), frase completa sin acentos (como «Ver quiénes»), 20 filas fijas + `hayMas`; dice `aceptoCorreos`, `bloqueado` y `agregable` (la misma regla `sqlCorreoAgregable` del PATCH y de la resolución) |
| `crm:plantillas` · `crm:preparar`                           | `GET /test-recipients`: a quién mandar la prueba (sólo nombres, nunca correos)                                                                                                                                                                                   |
| `crm:mandar`                                                | mandar y cancelar                                                                                                                                                                                                                                                |
| `crm:equipo`                                                | `/team` (listar, agregar, cambiar, quitar); reasignar y `/team/options` también con «Editar: todos»; los «sin dueño» del resumen diario                                                                                                                          |
| `crm:configurar`                                            | etapas y motivos (leerlos también con `crm:ver`), ocultar clientes y ver los ocultos y el KYC, importar de HubSpot, la puerta de «Eliminar» (que sigue siendo sólo del superadmin real)                                                                          |
| `crm:bajas`                                                 | `POST /opt-outs`, sola                                                                                                                                                                                                                                           |
| `crm:cerrar` (sólo con «Editar», en su alcance)             | ganar, perder, y mover un GANADO o PERDIDO a una etapa abierta. «Regresar al embudo» sólo desarchiva: pide «Editar», como archivar                                                                                                                               |

🔴 `crm:campanas` y `crm:admin` (y `access.campanas`/`access.admin`) son sólo el espejo para la pantalla vieja: ninguna ruta, servicio ni
herramienta del MCP decide con ellos (lo vigilan `tests/unit/architecture/crmEspejoDeLlaves.test.ts` en servicios, controladores, rutas y
MCP, y `tests/unit/routes/crm.team.routes.test.ts` en las rutas). 🔴 El disparador de `PlatformAccess` (L11) apaga las 8 finas en todo
`UPDATE` que no suba `llavesVersion`: código nuevo que escribe esa fila y debe conservarlas suma `llavesVersion: { increment: 1 }`;
cualquier otra escritura las apaga.

🔴 **`conjuntoHash` y `CRM_CAMPANA_PUBLICO_CAMBIO`:** el token de la vista previa firma también `conjuntoHash` (sha256 de los correos
resueltos, después de bajas, en el orden del recorrido: correo `COLLATE "C"`). Al encolar se recalcula en la misma pasada que crea las
deliveries; si cambiaron las PERSONAS (aunque el total sea igual) es 409 `CRM_CAMPANA_PUBLICO_CAMBIO` («El público cambió: revisa otra
vez»), y si sólo creció sigue siendo `CRM_CAMPANA_PUBLICO_CRECIO`. Un token firmado antes del despliegue (sin `conjuntoHash`) se valida como
siempre.

## 🔴 La liga de baja de «Envíame una prueba» es REAL

`sendTestToSelf` firma `platformUnsubscribeUrl` con el correo de quien prueba. Si lo usa (Rafa, por ejemplo), su correo queda bloqueado y
hoy no hay ruta para revertirlo. Para probar la baja, usa una dirección de `CRM_CORREO_PRUEBAS` que no sea la tuya. La prueba puede ir a
otra persona del equipo (`destinoStaffId`, validado en el servidor contra `miembrosConCorreo`; sin él, a quien la pide): la liga de baja se
firma con el correo del DESTINO.

## Interruptor y jobs (`src/jobs/jobSchedules.ts`)

- `MARKETING_KILL_SWITCH=true` también detiene las campañas del CRM (el remitente ni reclama).
- `crmCampaignSender`: `'17 * * * * *'`, cada minuto; vacía la cola de las campañas con el tope diario.
- `crmGmailReplies`: `'42 */5 * * * *'`, cada 5 minutos; reconcilia los envíos inciertos del Gmail y lee las respuestas.

## Variables (`src/config/env.ts`)

| Variable                                                                     | Default                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| `CRM_CAMPAIGN_FROM`                                                          | `Avoqado <novedades@novedades.avoqado.io>`    |
| `CRM_CAMPAIGN_REPLY_TO`                                                      | `hola@avoqado.io`                             |
| `CRM_CAMPAIGN_DAILY_CAP` (primeros intentos por día de CDMX; se sube a mano) | `50` (era 300; el cupo de Resend, 3-nov)      |
| `RESEND_DAILY_QUOTA`, `RESEND_MONTHLY_QUOTA` (cupo de la cuenta de Resend)   | `100` y `3000` (plan gratis); ver abajo       |
| `CRM_CORREO_PRUEBAS`                                                         | vacío                                         |
| `CRM_GMAIL_CLIENT_ID`, `CRM_GMAIL_CLIENT_SECRET`, `CRM_GMAIL_REDIRECT_URI`   | sin default                                   |
| `CRM_GMAIL_TOKEN_KEY` (64 caracteres hex = 32 bytes; `openssl rand -hex 32`) | sin default; llave propia de esta integración |

`.env.example` pendiente de agregar este bloque:

```bash
# CRM propio · correo (fase 2)
CRM_CAMPAIGN_FROM="Avoqado <novedades@novedades.avoqado.io>"
CRM_CAMPAIGN_REPLY_TO=hola@avoqado.io
# Primeros intentos por día (hora de CDMX): calentamiento del subdominio; se sube a mano
CRM_CAMPAIGN_DAILY_CAP=50
# El cupo de la cuenta de Resend, sólo si cambia el plan (gratis: 100 al día y 3,000 al mes)
RESEND_DAILY_QUOTA=
RESEND_MONTHLY_QUOTA=
# Fuera de producción sólo sale correo a estas direcciones (comas, minúsculas). Vacío = no sale nada
CRM_CORREO_PRUEBAS=
# Gmail del vendedor (app OAuth de Google «External», sin verificar). Sin estas cuatro «Mi Gmail» dice «Falta configurar la app de Google»
CRM_GMAIL_CLIENT_ID=
CRM_GMAIL_CLIENT_SECRET=
CRM_GMAIL_REDIRECT_URI=
# 64 caracteres hex (32 bytes), llave propia de esta integración: openssl rand -hex 32
CRM_GMAIL_TOKEN_KEY=
```

## 🔴 El cupo de Resend (`src/services/email/resendQuota.ts`, 3-nov)

Seguimos en el plan gratis: 100 correos al día y 3,000 al mes para TODO el servidor (login, recibos, avisos y campañas; cuentan también los
recibidos). 🔴 El día de Resend es UTC: su cupo diario se reinicia a la medianoche UTC, **las 18:00 de CDMX** (su documentación, «account
quotas and limits»). Todo lo del cupo cuenta ese día, leído con la hora de Resend (su cabecera `Date`); la pausa se guarda como un instante
(la medianoche UTC siguiente), así un reloj de aquí desfasado no la salta. El tope de las campañas (`CRM_CAMPAIGN_DAILY_CAP`) sigue contando
el de CDMX. `instalarMedidorDeCupoResend()` (en `server.ts`, también en `DEMO_MODE`) envuelve el `fetch` global porque el SDK 6.3.0 tira las
cabeceras: lee `x-resend-daily-quota` y `x-resend-monthly-quota` de cada respuesta de `api.resend.com`, y el `name` de un 429
(`daily_quota_exceeded` / `monthly_quota_exceeded`). Nunca cambia ni frena un correo, y nunca lanza.

- **Aviso** al 80 % del día o del mes, o con un 429 de cupo: `logger.error('[Resend] …')` (una vez por clave en el proceso) y un correo a
  jose@avoqado.io (fuera de producción, sólo si está en `CRM_CORREO_PRUEBAS`) con la llave `cupo-resend-<tipo>-<día o mes>`. 🔴 Asunto y
  cuerpo llevan el umbral, nunca el número del momento: la misma llave con otro contenido da 409 en Resend. Se lee la fila `EmailQuotaAlert`
  (`id = 'resend'`) antes y se ANOTA después del log y del correo: si el proceso muere en medio, el siguiente vuelve a avisar y Resend no
  repite el correo (24 h). Un correo que no salió se reintenta con la siguiente respuesta pasados 10 min. Con el cupo agotado no se intenta
  el correo (no puede salir): queda el log y se anota.
- **Pausa, sólo de las campañas del CRM**, con 80 en el día o un 429 de cupo (también el del mes: Resend no publica cuándo reinicia el mes,
  así que al día siguiente sale un correo de prueba y, si vuelve el 429, se pausa otra vez): el remitente no reclama, vuelve a preguntar
  justo antes de Resend (`antesDeMandar` de `sendEmailWithResult`, sin `await` en medio), y lo reclamado que ya no salió vuelve a la cola
  **sin gastar un intento**, con `nextAttemptAt` en `finDeLaPausaPorCupo` (el instante que vio el medidor, con el reloj de Resend) (un
  primer intento vuelve PENDIENTE y suelta su lugar del día; un reintento conserva su `sendAttemptAt`). El detalle de la campaña y
  `crm_campaign_status` lo dicen con `pausadaPorCupo`. El login y los recibos nunca se pausan.
- Sin `x-resend-daily-quota` en una respuesta exitosa, la cuenta ya es de pago: se dice una vez y no hay pausa diaria. Al subir de plan, pon
  `RESEND_MONTHLY_QUOTA` (y `RESEND_DAILY_QUOTA` si aplica), o el aviso del mes saldría al 80 % de 3,000.
- La pausa vive en la memoria del proceso: tras un reinicio se rearma con la primera respuesta de Resend.

## El permiso de correo (`consent.service.ts`)

Una fila de `CrmEmailConsent` por correo (único). Tres entradas: la **landing** (casilla del formulario), el **alta a mano** (casilla
«Aceptó recibir correos») y la **importación de HubSpot** (casilla «Las personas de estos archivos aceptaron…», campo multipart
`aceptaronCorreos`, no parámetro de URL: un SERVIDOR viejo rechaza el campo con 422 en vez de importar sin el permiso). Las dos del equipo
pasan por `escribirConsentimientoDelEquipoTx`: `skipDuplicates`, así que **nunca pisa** un permiso que ya había (ni su autor); **se salta**
(sin contar ni lanzar) el correo eliminado del CRM (D7), como la landing; sólo cuenta lo que escribió. La importación sólo lo escribe para
lo que CREA y sólo con correos bien formados; su respuesta trae `conPermiso`. Sin casilla la persona entra al CRM y no a campañas.

## Gmail del vendedor

- **«Configurado»** sólo si están presentes y bien formadas las cuatro `CRM_GMAIL_*` **y** `OAUTH_STATE_SECRET` (la llave, 64 hex; la URI,
  http/https; `leerConfig` en `gmailOAuth.service.ts`). Una mal escrita no tumba la API: «Mi Gmail» dice «Falta configurar la app de
  Google».
- La app de Google es «External» y **sin verificar**: tope de **100 cuentas distintas en toda su vida** (`TOPE_CUENTAS_GMAIL`; se cuentan en
  `CrmGmailAccountSeen`).

## Orden del webhook de Resend (`resend.webhook.controller.ts`)

1. **Reputación**: un rebote `Permanent` o una queja suprimen la dirección en `EmailSuppression` antes de todo (`recordSuppression`).
2. **Tarjetas de regalo**: un correo de tarjeta que rebotó, se suprimió o falló queda «No se entregó». No corta: después sigue igual.
3. **Marketing de superadmin** (`marketingService.handleResendWebhook`).
4. **Campañas de un negocio a sus clientes** (`procesarAvisoDeResend`).
5. **Campañas del CRM** (`procesarAvisoCrm`): **no** vuelve a suprimir; sólo marca la delivery `FALLIDO` (rebote duro, `email.failed` y
   `email.suppressed`, con su motivo: no llegó) o `ENVIADO` con su motivo (queja: sí llegó) y, en una queja, anota la baja de Avoqado
   (`CrmEmailOptOut`).

Los carriles 3 → 4 → 5 son una cascada: cada uno corre sólo si el anterior contestó «no es mío», por eso el del CRM va al final y sólo ve lo
que los otros dos no reclamaron. Si el carril 3 truena con un aviso que cambia un estado en algún carril (rebote, queja, `email.failed`,
`email.suppressed`, apertura, clic: `AVISOS_QUE_CAMBIAN_UN_ESTADO`), la respuesta es 500 para que Resend reintente; los demás siguen en 200.
`isBlocked` (`optOut.service.ts`) une `CrmEmailOptOut` y `EmailSuppression` y se revisa justo antes de cada envío.

## Los avisos internos (`digest.service.ts`) no son marketing

«Nuevo prospecto», «Volvió un prospecto» y el resumen diario van al equipo de ventas de Avoqado. Los frena un rebote duro o una queja
(`bloqueoPorReputacion` mira SÓLO `EmailSuppression`: una queja registra supresión y baja, y `isBlocked` contestaría `BAJA`), **no** la baja
de marketing. Si la consulta falla, no salen y se reintentan (el aviso dice `false`; la fila del resumen queda `FALLO` con intentos por
gastar).

## MCP (`src/mcp/tools/crm.ts`)

`crm_list_email_templates` y `crm_campaign_status`: de **lectura**, sólo SUPERADMIN, sólo en `/mcp` (nunca en el catálogo certificado).
Mandar una campaña o un correo por MCP no existe a propósito: es masivo y no se deshace. En `crm_campaign_status`, `desconocidos` quiere
decir «no sabemos si salieron»: Resend lo aceptó y no se guardó el resultado, pasaron más de 23 h desde el primer intento, se agotaron los
seis intentos (Ruling 11: la fila no guarda si alguno llegó a Resend), Resend rechazó un **reintento** (el intento anterior pudo salir)
**o** Resend ya tenía la llave con otro contenido. Nunca se lee como entregado; `FALLIDO` sólo cuando se sabe que no salió: un rechazo en el
primer intento. En «Envíame una prueba», un 5xx de Resend (`application_error`, `internal_server_error`, `service_unavailable`) o la llave
en conflicto también es «no sabemos si salió».
