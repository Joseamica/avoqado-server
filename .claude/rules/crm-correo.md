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

## 🔴 La liga de baja de «Envíame una prueba» es REAL

`sendTestToSelf` firma `platformUnsubscribeUrl` con el correo de quien prueba. Si lo usa (Rafa, por ejemplo), su correo queda bloqueado y
hoy no hay ruta para revertirlo. Para probar la baja, usa una dirección de `CRM_CORREO_PRUEBAS` que no sea la tuya.

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
quotas and limits»). Todo lo del cupo cuenta ese día; el tope de las campañas (`CRM_CAMPAIGN_DAILY_CAP`) sigue contando el de CDMX.
`instalarMedidorDeCupoResend()` (en `server.ts`, también en `DEMO_MODE`) envuelve el `fetch` global porque el SDK 6.3.0 tira las cabeceras:
lee `x-resend-daily-quota` y `x-resend-monthly-quota` de cada respuesta de `api.resend.com`, y el `name` de un 429 (`daily_quota_exceeded` /
`monthly_quota_exceeded`). Nunca cambia ni frena un correo, y nunca lanza.

- **Aviso** al 80 % del día o del mes, o con un 429 de cupo: `logger.error('[Resend] …')` y un correo a jose@avoqado.io (fuera de
  producción, sólo si está en `CRM_CORREO_PRUEBAS`) con la llave `cupo-resend-<tipo>-<día o mes>`. Se lee la fila `EmailQuotaAlert`
  (`id = 'resend'`) antes y se ANOTA después del log y del correo: si el proceso muere en medio, el siguiente vuelve a avisar y Resend no
  repite el correo por su llave (24 h). Un correo que no salió no se anota.
- **Pausa, sólo de las campañas del CRM**, con 80 en el día o un 429 de cupo (también el del mes: Resend no publica cuándo reinicia el mes,
  así que al día siguiente sale un correo de prueba y, si vuelve el 429, se pausa otra vez): el remitente no reclama, revisa la pausa otra
  vez justo antes de cada envío, y lo reclamado que ya no salió vuelve a la cola **sin gastar un intento**, con `nextAttemptAt` en
  `reinicioDelCupoDiario` (un primer intento vuelve PENDIENTE y suelta su lugar del día; un reintento conserva su `sendAttemptAt`). El
  detalle de la campaña y `crm_campaign_status` lo dicen con `pausadaPorCupo`. El login y los recibos nunca se pausan.
- Sin `x-resend-daily-quota` en una respuesta exitosa, la cuenta ya es de pago: se dice una vez y no hay pausa diaria. Al subir de plan, pon
  `RESEND_MONTHLY_QUOTA` (y `RESEND_DAILY_QUOTA` si aplica), o el aviso del mes saldría al 80 % de 3,000.
- La pausa vive en la memoria del proceso: tras un reinicio se rearma con la primera respuesta de Resend.

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
