# TotalPass — contrato técnico para el adaptador ERP (Avoqado)

Leído en vivo el **2026-10-02** de `https://dev.totalpass.com` (ReadMe). Cada página se bajó con su versión en markdown
(`/reference/<slug>.md`), que trae la **definición OpenAPI 3.0.2 completa** embebida. El índice que usa ReadMe para
agentes es `https://dev.totalpass.com/llms.txt`. No hay un `.json` OpenAPI público aparte: el OpenAPI vive dentro de
cada página. No se usó ninguna credencial y no se hizo ninguna llamada a su API (sólo `dig` de los hosts).

Convención: **«NO DOCUMENTADO»** = no aparece en ninguna página de dev.totalpass.com ni en las ayudas leídas.
**«Inferencia»** = deducción mía a partir de ejemplos; no está escrito como regla.

Fechas de actualización de las páginas (frontmatter `updatedAt`): la mayoría 2025-09-08; las de Check-in y
`update-configs` 2026-05-27; la Overview legacy 2026-08-03. Los ejemplos internos datan de 2023-2024 (hay
inconsistencias, señaladas abajo).

---

## 0. Las dos APIs que nos tocan (y las que NO)

| API (sección en dev.totalpass.com) | Para qué | Host prod | Host staging (según OpenAPI) |
|---|---|---|---|
| **Booking - New** | Publicar clases en la app TotalPass, recibir reservas, confirmarlas/negarlas, cupos, mapas de lugares | `https://booking-api.totalpass.com` | `https://booking-api.staging.totalpass.com` |
| **Webhook - Checkin** | Recibir el check-in del usuario y validarlo (abrir torniquete / dar entrada) | `https://gym-service-api.totalpass.com` | `https://gym-service-api.staging.totalpass.com` |
| Validación del check-in (la URL viene en el webhook) | `POST` al link `endpoint` del payload | `https://{admin_server}/api/v1/webhook_confirmations/{TOKEN}` — el OpenAPI sólo da `admin.staging.totalpass.com` como default; **el host de producción NO DOCUMENTADO** (usar siempre la URL literal del payload) | `admin.staging.totalpass.com` |

**NO nos tocan** (otros productos de la misma doc): *Partner App* (`/partner_app/v1/validate`, para apps de
nutrición/bienestar que validan elegibilidad de empleados con `x-api-key`), *Company Eligibles API* y *API Companies*
(para empresas que dan el beneficio), y *LEGACY APIS* (`/v1/track_usages`, `/v1/bookings` con `x-api-key` /
`SINGLE-ACCESS-TOKEN`; reemplazadas por las dos de arriba). Ver §10.

**Versionado:** ambas OpenAPI dicen `"version": "1.0.0"`. Las rutas no llevan versión (`/partner/...`). No hay
política de versionado/deprecación publicada → **NO DOCUMENTADO**.

**Entorno de pruebas — contradicción entre fuentes:**
- El OpenAPI lista hosts `*.staging.totalpass.com` (resuelven en DNS hoy, 2026-10-02).
- Las ayudas oficiales (BR 48941417163931 actualizada 2026-09-30, MX 49665457008411 actualizada 2026-09-30) dicen:
  *«TotalPass no cuenta con un entorno de Sandbox separado; por lo tanto, todo el desarrollo y las pruebas se
  realizan directamente en nuestro entorno de producción»*. Se pide un **usuario de prueba real** (nombre, CURP/RFC sin
  registro previo en TotalPass, correo, dirección a ≤ 200 m del sitio de prueba por la geolocalización del check-in)
  y una `place_api_key` de prueba que da el portal de desarrolladores (`https://developers.totalpass.com/`).
- ⇒ Tratar staging como **no garantizado**; preguntar a TotalPass. El adaptador debe tener el host configurable.
- **Comprobado el 2026-10-03** (POST `/partner/auth` con cuerpo vacío, sin llaves): `booking-api.staging.totalpass.com` responde
  igual que producción (400 de validación) ⇒ la API de reservas de staging está viva; `gym-service-api.staging.totalpass.com`
  responde **502** ⇒ el check-in de staging no está disponible. No se probó si nuestras llaves sirven en staging. El
  adaptador ya es configurable (`TOTALPASS_BOOKING_API_URL`, `TOTALPASS_CHECKIN_API_URL`).

Fuentes: https://dev.totalpass.com/llms.txt · https://dev.totalpass.com/reference/post_partner-auth ·
https://dev.totalpass.com/reference/post_partner-auth-1 ·
https://ayuda.totalpass.com.mx/hc/es-mx/articles/49665457008411 · https://ajuda.totalpass.com.br/hc/pt-br/articles/48941417163931

---

## 1. Autenticación

### 1.1 Cómo se combinan las dos llaves
- **`partner_api_key`** = identifica al **software (Avoqado)**. La genera TotalPass y la entrega tras firmar el
  Acuerdo/Termo de Adhesión (o se ve en el portal de desarrolladores). **Confidencial: nunca se le pide al cliente.**
- **`place_api_key`** = identifica a **cada sucursal** (gimnasio/estudio). La genera **el cliente** en el *Portal de
  Academias y Aliados* (`https://booking.totalpass.com/mx/login`) → pestaña **«Integraciones»** → elige el ERP de la
  lista → «Crear nuevo código». El cliente la pega en nuestro sistema.
- Se mandan **las dos juntas** en un solo `POST /partner/auth`. Resultado: **un JWT por par (partner, place)** — es
  decir, **un token por sucursal**. El JWT de ejemplo decodificado trae `{"partner_api_key","place_api_key","iat","exp"}`.
- 🔴 **Las mismas llaves sirven para Booking y para Check-in, pero cada API tiene SU endpoint de auth** (hosts
  distintos). Un token de Booking no está documentado como válido en Check-in ni viceversa: autenticar en cada host.
- Si el cliente regenera su código («Crear nuevo código»), la llave vieja deja de servir (inferencia: la ayuda dice
  que hay que capturar el nuevo código en el ERP; la configuración de clases/reservas «sigue intacta»).

### 1.2 Endpoint
```
POST https://booking-api.totalpass.com/partner/auth          (Booking)
POST https://gym-service-api.totalpass.com/partner/auth      (Check-in)
Content-Type: application/json
```
Body (ambos idénticos, los dos campos `required`, string):
```json
{
  "place_api_key": "c8f928a1-302c-4776-91d9-84063a38b68b",
  "partner_api_key": "0c31a687-4056-43cc-b91f-2fb8928e7489"
}
```
Respuesta **201 Created** (ejemplo literal de la doc):
```json
{
  "partner": {
    "name": "Kreiger - Trantow",
    "partnerApiKey": "0c31a687-4056-43cc-b91f-2fb8928e7489"
  },
  "place": {
    "name": "Prosacco - Yundt",
    "placeApiKey": "c8f928a1-302c-4776-91d9-84063a38b68b"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXJ0bmVyX2FwaV9rZXkiOiIwYzMxYTY4Ny00MDU2LTQzY2MtYjkxZi0yZmI4OTI4ZTc0ODkiLCJwbGFjZV9hcGlfa2V5IjoiYzhmOTI4YTEtMzAyYy00Nzc2LTkxZDktODQwNjNhMzhiNjhiIiwiaWF0IjoxNjk3NzQyMDg1LCJleHAiOjE2OTc4Mjg0ODV9.OS7bg0EsaTEgUi2KJ43jMwF_vCkirmJAqAGBbAHOTqM"
}
```
- La respuesta también declara el header `Authorization: Bearer <your_token_here>`.
- ⚠️ Las ayudas dicen que la respuesta **«devolverá los planes activos de la sucursal»**, pero el ejemplo (de 2023) **no
  trae** planes. Para obtenerlos de forma fiable usar `GET /partner/plans` (§7.1).

Errores:
```json
// 400 — params vacíos
{ "statusCode": 400, "message": ["partner_api_key should not be empty","partner_api_key must be a string","place_api_key should not be empty","place_api_key must be a string"], "error": "Bad Request" }
// 401 — credenciales inválidas
{ "message": "Invalid credentials" }
```

### 1.3 Uso del token, duración, refresh
- Todas las demás llamadas: header **`Authorization: Bearer <token>`** (el OpenAPI lo declara como parámetro de header
  `required` + `security: bearerAuth`).
- **Duración: 24 h** (la doc: *«This token must be renewed every 24 hours»*; el JWT de ejemplo: `exp − iat = 86400`).
- **No hay endpoint de refresh**: se vuelve a llamar `POST /partner/auth`. (El refresh/logout que aparece en la doc es
  de la *Company Eligibles API*, otro producto.)
- Respuesta a token vencido/ inválido en los demás endpoints: `401 {"statusCode": 401, "message": "Unauthorized"}`.
- Recomendación de implementación (inferencia): cachear por sucursal y renovar al recibir 401 o antes de las 24 h.
  La ayuda de Check-in aclara que el token **sólo** hace falta para administrar webhooks: recibir y validar
  check-ins **no** usa el JWT.

Fuentes: https://dev.totalpass.com/reference/post_partner-auth · https://dev.totalpass.com/reference/post_partner-auth-1 ·
https://dev.totalpass.com/reference/post_partner-auth-3 (copia idéntica) · https://dev.totalpass.com/docs/authenticate ·
https://ayuda.totalpass.com.mx/hc/es-mx/articles/49665969462811 · https://ayuda.totalpass.com.mx/hc/es-mx/articles/49503820692251

---

## 2. Booking — modelo

- **Event** (clase) = plantilla, con `id` numérico. Puede ser **recurrente** (`POST /partner/events`, con
  `frequencyOptions`) o **individual** (`POST /partner/event-occurrence`, sin recurrencia).
- **EventOccurrence** (ocurrencia) = *«la representación de un solo día de la recurrencia»*; se identifica por
  **`occurrenceUuid`** (en algunas respuestas sale como `eventOccurrenceUuid` o `startTimeId` — mismo valor en los
  ejemplos). Cupos, visibilidad, edición y borrado se hacen por ocurrencia.
- **Slot** = una **reserva** de un usuario TotalPass (id tipo Mongo, p. ej. `"657a1c812244207e106c7b2c"`). Ojo: el
  campo `slots` del evento/ocurrencia es el **número de cupos** para usuarios TotalPass; el *slot* del webhook es la
  reserva.
- **Plan** = plan de la sucursal en TotalPass; cada clase va ligada a un `planId` (numérico) y define qué usuarios
  pueden reservarla.
- **SeatMap** = mapa de lugares (bicis, costales…), opcional, por sucursal.
- La ayuda recomienda crear clases con el **endpoint de evento individual** (`/partner/event-occurrence`), y avisa que
  **plan y zona horaria vacíos o incorrectos causan fallas de reserva** al usuario.
- Las clases creadas por API se ven en el Portal de TotalPass pero **sólo deben editarse desde el ERP**; si el
  gimnasio crea clases a mano en el Portal **quedan duplicadas**.

Fuentes: https://dev.totalpass.com/reference/post_partner-events-1 (glosario en `info.description`) ·
https://ayuda.totalpass.com.mx/hc/es-mx/articles/49666312143259 · https://ajuda.totalpass.com.br/hc/pt-br/articles/48561762836763

---

## 3. Booking — endpoints (host `booking-api.totalpass.com`, todos con `Authorization: Bearer`)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/partner/events` | Crear evento **recurrente** |
| GET | `/partner/events` | Listar todos los eventos de la sucursal (con sus `EventOccurrences`) — sin filtros ni paginación documentados |
| PUT | `/partner/events/{eventId}` | Editar evento y **todas** sus ocurrencias |
| DELETE | `/partner/events/{id}` | Borrar evento |
| POST | `/partner/event-occurrence` | Crear clase **individual** (sin recurrencia) |
| GET | `/partner/events/{occurrenceUuid}` | Ver una ocurrencia (⚠️ la ruta es `/partner/events/…`, no `/event-occurrence/…`) |
| PUT | `/partner/event-occurrence/{occurrenceUuid}` | Editar una ocurrencia |
| PUT | `/partner/event-occurrence/{occurrenceUuid}/slot` | Cambiar cupos y/o lugares disponibles de una ocurrencia |
| POST | `/partner/event-occurrence/status` | Visibilidad ACTIVE / HIDDEN / INACTIVE, en lote (≤ 20) |
| DELETE | `/partner/event-occurrence/{occurrenceUuid}` | Borrar una ocurrencia |
| GET | `/partner/slot` | Listar reservas |
| PUT | `/partner/slot/confirmSlot/{slotId}` | Confirmar / negar una reserva |
| DELETE | `/partner/slot/{slotId}` | Cancelar una reserva (desde el ERP) |
| POST/GET/PUT/DELETE | `/partner/seat-maps[/{seatMapId}]` | Mapas de lugares (§8) |
| GET | `/partner/plans` | Planes de la sucursal (§7.1) |
| PUT | `/partner/places/update-configs` | `hasSlotConfirmation` (§7.2) |
| POST | `/partner/webhook/subscribe` · GET/DELETE `/partner/webhook` | Webhook de reservas (§6.1) |

### 3.1 Crear evento recurrente — `POST /partner/events`
*«All fields in the payload are mandatory.»* `required`: `title, responsible, duration, slots, timezone, startDate,
endDate, planId, frequencyOptions`. Opcionales en el schema: `seatMapId` (integer), `status`
(`ACTIVE|INACTIVE|HIDDEN`), `description`.

| Campo | Tipo | Regla |
|---|---|---|
| `title` | string | título de la clase |
| `responsible` | string | nombre del instructor |
| `duration` | integer | minutos |
| `slots` | integer | cupos para usuarios TotalPass |
| `planId` | integer | id numérico del plan de la sucursal |
| `timezone` | string enum | **`"pt-BR"` o `"es-MX"`** (es un código de locale, no un IANA tz) |
| `startDate`, `endDate` | string `YYYY-MM-DD` | rango de la recurrencia |
| `frequencyOptions[]` | `{weekday: 0-6, startTime: string[]}` | `startTime` *«accepts only AM/PM hours format, like 'hh:mm PM'»* |

Request (ejemplo literal):
```json
{
  "title": "Yoga",
  "responsible": "Cisne",
  "duration": 45,
  "slots": 1,
  "planId": 1,
  "seatMapId": null,
  "timezone": "es-MX",
  "startDate": "2023-09-06",
  "endDate": "2023-09-07",
  "description": "A Yoga melhora o funcionamento do coração, ...",
  "frequencyOptions": [
    { "weekday": 4, "startTime": ["15:00"] },
    { "weekday": 3, "startTime": ["15:00"] }
  ]
}
```
⚠️ El propio ejemplo manda `"15:00"` aunque la descripción exige `"hh:mm PM"`; la respuesta lo devuelve como
`"03:00 PM"`. Mandar **`"03:00 PM"`** (lo documentado). Que `weekday 0` = domingo: **NO DOCUMENTADO** (sólo «0 a 6»).

Respuesta **201**:
```json
{
  "id": 4, "title": "Yoga", "responsible": "Cisne", "description": "...", "duration": 45, "slots": 1,
  "frequencyOptions": [ { "weekday": 4, "startTime": ["03:00 PM"] }, { "weekday": 3, "startTime": ["03:00 PM"] } ],
  "placeId": 1, "planId": 1, "seatMapId": null,
  "timezone": "America/Sao Paulo",
  "startDate": "2023-09-06T03:00:00.000Z", "endDate": "2023-09-07T03:00:00.000Z",
  "recurrenceType": "WEEKLY", "status": "ACTIVE",
  "createdAt": "2023-10-19T19:02:02.952Z", "updatedAt": "2023-10-19T19:02:02.952Z", "deletedAt": null,
  "eventColor": "#EBDCFF"
}
```
Errores 400 (ejemplos): `"title should not be empty"`, `"startDate must be a valid ISO 8601 date string"`,
`"frequencyOptions.0.startTime must be an array"`. 401 `{"statusCode":401,"message":"Unauthorized"}`.

### 3.2 Crear clase individual — `POST /partner/event-occurrence` (la recomendada)
*«Except for 'bookingWindow', 'maxTimeToCancel', and 'externalReference', ALL fields in the payload are mandatory.»*
`required` en el schema: `title, responsible, duration, slots, timezone, planId, eventDate, startTime`. También
aceptados: `seatMapId`, `status` (`ACTIVE|INACTIVE|HIDDEN`), `description`, y los opcionales:

| Campo | Formato | Regla |
|---|---|---|
| `eventDate` | `YYYY-MM-DD` | día de la clase |
| `startTime` | `"hh:mm AM/PM"` (string, uno solo) | hora de inicio |
| `bookingWindow.minTimeToBook` | `'YYYY-MM-DD hh:mm AM/PM'` | lo más temprano que se puede reservar; debe ser **antes** de `maxTimeToBook` |
| `bookingWindow.maxTimeToBook` | `'YYYY-MM-DD hh:mm AM/PM'` | cierre de reservas; **≥ 1 min antes** del inicio |
| `maxTimeToCancel` | `'YYYY-MM-DD 00:00 AM/PM'` | después de esto, cancelar = **late cancel** |
| `externalReference` | string no único, default `null` | identificador libre nuestro (p. ej. id de la clase en Avoqado) |

Si se manda `bookingWindow`, **sus dos campos son obligatorios**. Sin `bookingWindow`: default **NO DOCUMENTADO**.
Zona horaria de esas fechas-hora (local vs UTC): **NO DOCUMENTADO** (inferencia: hora local de `timezone`).

Request (ejemplo literal — ⚠️ omite `startTime` aunque es `required`):
```json
{
  "title": "Yoga",
  "responsible": "Cisne",
  "duration": 45,
  "slots": 1,
  "planId": 1,
  "timezone": "es-MX",
  "eventDate": "2023-09-06",
  "description": "A Yoga melhora o funcionamento do coração, ..."
}
```
Respuesta **201** (literal):
```json
{
  "eventId": 1, "title": "Yoga", "description": "...", "eventColor": "#EBDCFF",
  "startTime": "03:00 PM",
  "minTimeToBook": "2023-09-06T03:00:00.000Z", "maxTimeToBook": "2023-09-07T13:00:00.000Z",
  "maxTimeToCancel": "2023-09-07T10:00:00.000Z",
  "endTime": "03:45 PM", "eventDate": "2023-09-06T03:00:00.000Z",
  "responsible": "Cisne", "duration": 45, "status": "ACTIVE", "externalReference": null,
  "slots": 1, "slotsInUse": 0,
  "eventOccurrenceUuid": "8e2205a2-470c-4429-b0f0-37d684c6cb86",
  "availableSeats": [],
  "Event": { "id": 1, "...": "...", "recurrenceType": "DAILY", "Place": { "id": 1, "name": "Batatinha", "identifier": "a9ff272a-...", "placeApiKey": "...", "placeWebhookUrl": null, "partnerId": 1, "isActive": true } }
}
```
Errores 400 extra: `"bookingWindow.minTimeToBook is required when bookingWindow is provided"`,
`"The booking window is invalid. Ensure minTimeToBook is less than maxTimeToBook, and dates are not before today."`

### 3.3 Listar — `GET /partner/events`
Sin parámetros (sólo `Authorization`). Devuelve un **arreglo de eventos**, cada uno con `Places` y
`EventOccurrences[]` (`id, eventId, startTime, occurrenceUuid, endTime, eventDate, responsible, duration, status,
slots, createdAt, updatedAt, deletedAt`). Paginación/filtros por fecha: **NO DOCUMENTADO**.

### 3.4 Ver una ocurrencia — `GET /partner/events/{occurrenceUuid}`
Respuesta 200 con la ocurrencia + `Event`; si hay mapa: `availableSeats` (identifiers), `Event.SeatMaps`,
`openSeats[]`, `bookedSeats[]`, `slotCount`, `eventOccurrenceUuid`. 404 `{"message": "Events not found"}`.

### 3.5 Editar evento recurrente — `PUT /partner/events/{eventId}`
Actualiza el evento **y todas sus ocurrencias**. `required`: `title, responsible, duration, slots`; opcional
`description`. **`slots` sólo puede subir, nunca bajar** (400: `"... The slots cannot be reduced"`). No acepta
fecha, hora, plan, timezone ni frecuencia. Respuesta documentada como `201` con el evento.

### 3.6 Editar ocurrencia — `PUT /partner/event-occurrence/{occurrenceUuid}`
Campos aceptados (ninguno `required` en el schema): `title, responsible, duration, bookingWindow{minTimeToBook,
maxTimeToBook}, description, externalReference`. Request literal:
```json
{ "title": "Yoga", "responsible": "Cisne", "duration": 45, "description": "...", "externalReference": "event-test-123" }
```
Respuesta 200 (literal, recortada): `{ "id": 1, "eventId": 1, "startTime": "03:00 PM", "startTimeId": "8e2205a2-…",
"endTime": "03:45 PM", "eventDate": "…", "minTimeToBook": "…", "maxTimeToBook": "…", "maxTimeToCancel": "…",
"status": "ACTIVE", "slotsInUse": 0, "availableSeats": [], "slots": 1, …, "externalReference": "event-test-123" }`.

🔴 **`isCancelled`:** la ayuda oficial (MX 49666312143259 / BR 48923933171483) dice que, para reprogramar, se cancele
la clase vieja *«vía PUT /partner/event-occurrence/{occurrenceUuid} definiendo `isCancelled: true` (para notificar a los
usuarios)»*. **Ese campo NO aparece en el schema del reference** de ese endpoint. Comportamiento, respuesta y efecto
sobre las reservas de `isCancelled`: **NO DOCUMENTADO en la referencia** — confirmar con TotalPass antes de depender de
él. Alternativa sí documentada: `POST /partner/event-occurrence/status` con `INACTIVE` (§3.8).

### 3.7 Por qué NO se puede cambiar fecha/hora
La ayuda: *«No es posible modificar el horario (`startTime`) o la fecha (`eventDate`) de una clase ya creada.»* Ningún
endpoint de edición acepta esos campos. El **porqué** no se explica (**NO DOCUMENTADO**; inferencia: los usuarios ya
reservaron esa fecha-hora y TotalPass no migra reservas). Flujo oficial de reprogramación:
1. Crear una clase nueva con el horario correcto.
2. Cancelar la vieja (`PUT …/{occurrenceUuid}` con `isCancelled: true`, ver ⚠️ arriba) para notificar a los usuarios.
3. Borrar la vieja con `DELETE`.

### 3.8 Visibilidad / cancelación en lote — `POST /partner/event-occurrence/status`
Hasta **20** ocurrencias por request; default al crear = `ACTIVE`.
- `ACTIVE`: visible y reservable.
- `HIDDEN`: no se muestra, **no** acepta reservas nuevas, **conserva** las existentes.
- `INACTIVE`: no se muestra, no acepta reservas nuevas y **borra las reservas existentes**.
```json
// request
{ "occurrencesToUpdate": [
  { "occurrenceUuid": "8e2205a2-470c-4429-b0f0-37d684c6cb86", "status": "INACTIVE" },
  { "occurrenceUuid": "f3aed860-ac30-445d-9964-bcd9e2cfea0b", "status": "HIDDEN" } ] }
// 201
{ "occurrencesToUpdate": [ ...igual... ], "message": "Count of updated events: 2" }
```
400: `"occurrencesToUpdate must contain no more than 20 elements"`, `"occurrencesToUpdate.1.occurrenceUuid must be a UUID"`.
Si `INACTIVE` notifica al usuario: **NO DOCUMENTADO**.

### 3.9 Cupos de una ocurrencia — `PUT /partner/event-occurrence/{occurrenceUuid}/slot`
Cambia el **límite de cupos** (sube o baja, pero **no por debajo de las reservas activas**) y/o los lugares
disponibles si hay mapa (`availablePositions` = lista de `externalReference` de posiciones).
```json
{ "slots": 4, "availablePositions": ["A1", "A2"] }
```
200: la ocurrencia con `slots`, `slotsInUse`, `availableSeats` (identifiers), `Event` y **`activeSlotsList[]`** (las
reservas activas). 404 `{"message":"Events not found"}`. **422** `{"message":"The number of total slots cannot be
reduced below the number of reserved slots"}`.
La ayuda pide usarlo para **sincronizar cupos compartidos con clientes no-TotalPass**: cada vez que un lugar se ocupa
fuera de TotalPass, avisar para evitar sobrecupo.

### 3.10 Borrar — `DELETE /partner/events/{id}` y `DELETE /partner/event-occurrence/{occurrenceUuid}`
200 `{"message": "Event deleted"}` · 404 `{"message": "Event not found"}`. Según la ayuda: al borrar una clase con
reservas, **TotalPass cancela las reservas automáticamente y manda Push/Correo** a los usuarios.

Fuentes: https://dev.totalpass.com/reference/post_partner-events-1 · …/get_partner-events-1 ·
…/put_partner-events-eventid-1 · …/delete_partner-events-id-1 · …/post_partner-event-occurrence-1 ·
…/get_partner-events-occurrenceuuid-1 · …/put_partner-event-occurrence-occurrenceuuid-1 ·
…/put_partner-event-occurrence-occurrenceuuid-slot-1 · …/post_partner-event-occurrence-status-1 ·
…/delete_partner-event-occurrence-occurrenceuuid-1 · https://ayuda.totalpass.com.mx/hc/es-mx/articles/49666312143259 ·
https://ajuda.totalpass.com.br/hc/pt-br/articles/48923933171483

---

## 4. Cómo llega una RESERVA y cómo se acepta / rechaza

### 4.1 Llega por webhook (POST de TotalPass a nuestra URL de booking)
Registrada con `POST /partner/webhook/subscribe` (§6.1). Payload documentado (literal; el original trae una coma
colgante en `plan_code`):
```json
{
  "event": { "id": "231fd985-d3a3-40b3-99a8-c363fc26aaaa", "title": "Yoga", "plan_code": "XXXXXX" },
  "place": { "place": "ac04cf8a-8643-41d5-a0c9-efee02f9aaaa", "name": "Bio Ritmo Paulista" },
  "user": {
    "name": "Cisne", "email": "cisne@totalpass.com.br", "phone": "xxxxxxxxx",
    "document_number": "12345678900", "document_type": "cpf", "code": "ABCDEF"
  },
  "slot": {
    "id": "64c1ad93a879333d436da6e8",
    "status": "active",
    "date": "2023-07-31T00:00:00.000Z",
    "seat": { "externalReference": "123", "name": "A1", "identifier": "5e701467-4d80-40a4-b78a-00490a6faaaa", "position": "[1,1]" },
    "confirmation_url": "booking-api.totalpass.com/partner/slot/confirmSlot/64c1ad93a879333d436da6e8"
  }
}
```
Segundo ejemplo (en `update-configs`), con `seat: null` y `confirmation_url` con `https://`:
```json
{
  "event": { "id": "40dc2acc-f418-4447-9d78-7b1c76fc8399", "title": "Yoga" },
  "place": { "place": "9c83d967-d783-4e74-9e11-4ebe462ab7d9", "name": "TUDO JEANS" },
  "user": { "name": "Pedro Santos", "email": "pedrosantos@outlook.com", "phone": "(11) 98222-4623",
            "document_number": "23312388894", "document_type": "cpf", "code": "S2MXBABC" },
  "slot": { "id": "677fc3d14bc7797787a4e8c7", "status": "active", "date": "2025-01-10T20:30:00.000Z", "seat": null,
            "confirmation_url": "https://booking-api.totalpass.com/partner/slot/confirmSlot/677fc3d14bc7797787a4e8c7" }
}
```
Notas:
- **No hay campo de tipo de evento** (`type`) en el payload de booking (a diferencia del de check-in). Cómo distinguir
  «reserva nueva» de «cancelación del usuario»: **NO DOCUMENTADO** (inferencia: por `slot.status`).
- `event.id` es un **UUID**, no el `eventId` numérico. Si es el `occurrenceUuid`: **NO DOCUMENTADO** (inferencia
  fuerte: sí). `place.place` = `identifier` de la sucursal (UUID), útil para enrutar con una sola URL para todas.
- `slot.date` en UTC ISO-8601. `user.document_type` en MX: valores posibles **NO DOCUMENTADOS** (ejemplos sólo `cpf`;
  la API legacy acepta `curp`, `rfc`, `email`).
- `confirmation_url` sólo es útil si la sucursal tiene `hasSlotConfirmation = true`.

### 4.2 Aceptar / rechazar — `PUT /partner/slot/confirmSlot/{slotId}`
Sólo para sucursales con **`hasSlotConfirmation: true`** (§7.2). **Plazo: «within 5 minutes of its creation»**.
```
PUT https://booking-api.totalpass.com/partner/slot/confirmSlot/{slotId}
Authorization: Bearer <token de la sucursal>
```
```json
{ "state": "confirmed" }
{ "state": "denied", "reason": "class_overbooked" }
```
- `state` (required): `confirmed` | `denied`. `denied` ⇒ el usuario ve la reserva como **cancelada** en la app.
- `reason` (opcional en el schema, pero **la ayuda lo exige al negar**): `reason_not_provided`, `class_overbooked`,
  `api_error`, `denied_by_gym`, `user_not_elegible` (sic), `monthly_limit_exceeded`, `unavailable_spot`,
  `user_already_in_class`, `canceled_event`. La ayuda pide además que **el motivo del rechazo quede visible para el
  gimnasio en el panel del ERP**.
- 200:
```json
{ "statusCode": 200, "message": { "_id": "60d21b4667d0d8992e610c85", "place": { "id": "1", "name": "Example Place" },
  "status": "confirmed", "state": "confirmed", "createdAt": "2023-10-01T12:00:00Z", "updatedAt": "2023-10-01T12:00:00Z" } }
```
- 400: `"state must be one of the following values: confirmed, denied"`, `"state should not be empty"`, enum de `reason`.
  404: `"Original slot not found with ID: …"`.
- **Qué pasa si no respondemos en 5 min: NO DOCUMENTADO** (¿se confirma sola, se cae, se queda pendiente?). Preguntar.
- Sin confirmación activada (default `false`), la reserva queda firme al crearse (inferencia).

### 4.3 Cancelación, listado y no-show
- **Cancelación por el usuario:** la ayuda MX 49503716199195: *«En caso de que un usuario cancele su reserva desde la
  app, esta información también se enviará automáticamente a tu sistema.»* Payload/campo que lo distingue: **NO
  DOCUMENTADO** (no hay ejemplo de payload de cancelación).
- **Cancelación por el ERP:** `DELETE /partner/slot/{slotId}` → 200 `{"slotId":"657a…","message":"Slot removed
  successfully"}`; 400 `{"title":"already_canceled","message":"Already canceled"}` o
  `{"title":"slot_expired","message":"Slot expired, you cannot cancel this slot"}`; 404 `{"title":"slot_not_found",…}`.
- **Listar reservas:** `GET /partner/slot?id=&userId=&eventOccurrenceUuid=&slotDateFrom=YYYY-MM-DD&slotDateTo=YYYY-MM-DD`.
  Sin parámetros ⇒ reservas de **hoy a +6 días**. `slotDateFrom`/`slotDateTo` van juntos, **máx. 30 días**. Con `id`
  se ignora lo demás. Respuesta: arreglo de `{ _id, userId, status, user{…,code}, eventId, weekday, weekdayName,
  startTimeId, startTime "18:00", endTime, slotDate, timezone "pt-BR", version, event{…, plan_code}, place{id,
  identifier}, createdAt }`. Útil como **reconciliación** si se pierde un webhook. Paginación: **NO DOCUMENTADO**.
- Valores de `slot.status` vistos: `active`, `expired`, `confirmed` (este en `confirmSlot`). Lista completa (¿`canceled`,
  `denied`, `late_canceled`, `no_show`?): **NO DOCUMENTADO**.
- **No-show:** **NO DOCUMENTADO** (no hay endpoint ni estado). Sólo existe el concepto de *late cancel* vía
  `maxTimeToCancel`. Inferencia: TotalPass mide asistencia por el **check-in** del usuario (§5): la ayuda dice que con
  booking el usuario igual tiene que hacer check-in al llegar.

Fuentes: https://dev.totalpass.com/reference/post_partner-webhook-subscribe · …/put_partner-slot-confirmslot-slotid ·
…/put_partner-places-update-configs-1 · …/get_partner-slot · …/delete_partner-slot-slotid ·
https://ayuda.totalpass.com.mx/hc/es-mx/articles/49503716199195 · https://ayuda.totalpass.com.mx/hc/es-mx/articles/20706175861659

---

## 5. Check-in

### 5.1 Flujo
1. Autenticar la sucursal en `gym-service-api` (§1) y registrar la URL con `POST /partner/webhook/create`
   (`webhook_type: "CHECKIN"`) (§6.2).
2. El usuario hace check-in en la app TotalPass (con geolocalización) → TotalPass hace **POST a nuestra URL** con el
   payload de abajo.
3. Para **liberar la entrada** hacemos `POST` a la URL que viene en **`endpoint`**. Sin body, sin `Authorization`
   (el OpenAPI no declara `security` ni `requestBody` para esa llamada; el token va en la ruta).
4. **Plazo: 90 minutos** desde `started_at` (el ejemplo: `started_at 17:54:16` → `expires_at 19:24:16`). Pasado
   eso el check-in expira y el usuario debe hacer uno nuevo.

### 5.2 Payload del webhook (literal)
```json
{
  "type": "CHECK_IN_CREATED",
  "endpoint": "https://admin.staging.totalpass.com/api/v1/webhook_confirmations/TXIefq1R0-w59n6XLaMhR425lS0olXdTSnQ0qJUNZpnF2GGyUWcjrw==",
  "check_in": {
    "started_at": "2024-08-07T17:54:16.271-03:00",
    "plan_code": "59TADO9F",
    "expires_at": "2024-08-07T19:24:16.271-03:00"
  },
  "place": {
    "place": "5e701467-4d80-40a4-b78a-00490a6feb9b",
    "name": "Batatinha",
    "code": "59TADO9F"
  },
  "user": {
    "name": "Cleveland Wolf",
    "email": "tarra.cruickshank@yahoo.com",
    "phone": "6399907-8947",
    "document_number": "66844563680",
    "document_type": "cpf",
    "code": "EQ2B3FBK"
  }
}
```
- `type` = único valor documentado `CHECK_IN_CREATED`. Otros tipos (cancelado/expirado): **NO DOCUMENTADO**.
- `user.code` = código del beneficiario TotalPass (el mismo `code` que trae el webhook de booking ⇒ sirve para ligar
  reserva ↔ check-in, inferencia). `place.place` = UUID de la sucursal.
- Fechas con **offset local** (`-03:00`) en este webhook, a diferencia de booking (UTC `Z`).
- El token del `endpoint` es base64 con `=`: guardar la URL **literal**, no reconstruirla.

### 5.3 Validar — `POST {endpoint}` (= `https://{admin_server}/api/v1/webhook_confirmations/{TOKEN}`)
- **200** `"1"` (string) — check-in validado.
- **404** `{"message": "not found"}`.
- **422** — no se pudo validar:
```json
{ "errors": [ { "status": "422", "title": "Validation Error", "detail": "Unable to validate the webhook confirmation",
  "source": { "message": "Check-in não está disponível.", "label": "check_in_not_available" } } ] }
```
```json
{ "errors": [ { "status": "422", "title": "Validation Error", "detail": "Unable to validate the webhook confirmation",
  "source": { "message": "Tempo de check-in expirado! Um novo check-in precisa ser feito.", "label": "check_in_expired_alert" } } ] }
```
- **422 `check_in_not_available` cuando ya se validó**: la ayuda MX 49666604278555 lo dice explícito — *«En caso de que
  recepción valide el check-in manualmente [en el Portal] antes que tu sistema, tu intento de validación vía API
  devolverá el error 422 - Check-in no disponible (pues ya ha sido validado).»* La integración **no bloquea** la
  validación manual en el Portal. ⇒ Tratar `check_in_not_available` como **«ya validado / no reintentar»**, distinto
  de `check_in_expired_alert`. Que un segundo POST nuestro también dé 422 (idempotencia): inferencia, no escrito.
- Otros códigos (401, 5xx, 429): **NO DOCUMENTADO**.

### 5.4 `POST /partner_app/v1/validate` — NO aplica a nosotros
Es de la *Partner App API* (host `https://api.totalpass.com/`, staging `https://staging.totalpass.com/api/`), con
header `x-api-key`: una **app asociada** (p. ej. nutrición) manda `{"employee_document_number": "…"}` y recibe
`employee_data{name,email,birthday,phone}` + `app_data{meal_plan,appointment}` para decidir si el empleado puede usar
esa app. No interviene en check-in ni en booking de gimnasios. 401 `{"error":"Unauthorized","message":"No valid API key
provided",…}`, 422 `{"errors":["A empresa fornecida não pode acessar o recurso solicitado."]}`.

Fuentes: https://dev.totalpass.com/reference/post_webhook-confirmations-token · …/post_partner-webhook-create ·
…/post_partner-app-v1-validate · https://ayuda.totalpass.com.mx/hc/es-mx/articles/49666604278555 ·
https://ajuda.totalpass.com.br/hc/pt-br/articles/48920022036635

---

## 6. Webhooks — registro, tipos, seguridad

Son **dos sistemas distintos**, en hosts distintos, con APIs distintas:

### 6.1 Booking — `booking-api.totalpass.com`, «subscribe» (una URL por sucursal)
```
POST   /partner/webhook/subscribe   body {"webhook_url": "https://…"}   → 201 {"status":"success","code":200}
GET    /partner/webhook                                                 → 200 {"placeWebhookUrl":"https://…","name":"Batatão Jeans"}
DELETE /partner/webhook                                                 → 200 {"status":"success","code":200}
```
*«Responsible for associating the webhook URL with the logged-in gym's registration … using the session information in
the JWT»* ⇒ la URL queda en la **sucursal** (`Place.placeWebhookUrl`); hay que suscribir **cada** sucursal con su token.
Una sola URL por sucursal (no hay `type`). Update = volver a llamar `subscribe` (inferencia; no hay PUT).

### 6.2 Check-in — `gym-service-api.totalpass.com`, «create» (con tipo)
```
POST   /partner/webhook/create        body {"webhook_url":"https://…","webhook_type":"CHECKIN"}  → 201 {"status":"success","code":201}
PUT    /partner/webhook/update        body {"webhook_url":"https://…","webhook_type":"CHECKIN"}  → 200 {"status":"success","code":200}
DELETE /partner/webhook/delete/{TYPE}                                                          → 200 {"status":"success","code":200}
GET    /partner/webhook/get           → 200 {"webhooks":[{"webhook_url":"https://…","webhook_type":"CHECKIN"}, …]}
```
*«Currently, the only available type is 'CHECKIN'.»* La doc dice «associated with the logged-in partner», pero la
sesión del JWT es partner+place y la ayuda dice «registrar una URL … en esa sucursal» ⇒ se registra por sucursal.
400: `"webhook_url should not be empty"`, `"webhook_type must be a string"`.

**create vs subscribe:** `subscribe` = webhook de **reservas** (API Booking); `create/update/delete/get` = webhook de
**check-in** (API Check-in). No son intercambiables.

**Tipos disponibles:** check-in → sólo `CHECKIN` (payload `type: "CHECK_IN_CREATED"`). Booking → sin tipos; un solo
payload de slot (reserva nueva; la cancelación del usuario también se envía según la ayuda, payload no documentado).

**Misma URL para todas las sucursales:** permitido; la ayuda pide identificar la sucursal en el código. Nada en el
payload identifica al **partner**; la sucursal sí (`place.place` UUID, `place.name`, y en check-in `place.code`).
⇒ Recomendación (inferencia): **URL distinta por sucursal** (p. ej. con un id opaco nuestro en la ruta) para no
depender del payload y poder revocar una sola.

**Autenticidad / firma:** **NO DOCUMENTADO**. Ningún header de firma, HMAC, secreto compartido ni IP de origen.
Mitigación (inferencia): URL con secreto aleatorio por sucursal + HTTPS; para check-in, la acción real (abrir
torniquete) sólo ocurre si nuestro `POST {endpoint}` devuelve 200, y ese endpoint vive en un host de TotalPass ⇒ un
webhook falso no puede validar nada. **Validar que `endpoint` sea `https://*.totalpass.com/...` antes de llamarlo**
(evita SSRF). Para booking, reconciliar contra `GET /partner/slot` antes de confiar.

**Reintentos, timeout, código esperado de nuestra respuesta, orden y duplicados:** **NO DOCUMENTADO**. Diseñar
idempotente por `slot.id` (booking) y por la URL/token de `endpoint` (check-in).

Fuentes: https://dev.totalpass.com/reference/post_partner-webhook-subscribe · …/get_partner-webhook ·
…/delete_partner-webhook · …/post_partner-webhook-create · …/put_partner-webhook-update ·
…/delete_partner-webhook-delete-type · …/get_partner-webhook-get · https://ayuda.totalpass.com.mx/hc/es-mx/articles/49666604278555

---

## 7. Plans y configuración de la sucursal

### 7.1 `GET /partner/plans` (booking-api)
Planes **activos** de la sucursal en TotalPass (alternativa a leerlos del auth). Query opcional `id` = `code` del plan
(el `externalReference` es de uso interno de TotalPass: *«external partners won't have access … shouldn't be openly
used»*).
```json
{
  "name": "Plance Name",
  "identifier": "71b6ab00-3340-42d9-baaf-d84ff94f40ce",
  "placeApiKey": "78347c63-99d4-4d05-9abb-0ac474033df6",
  "Plans": [
    { "id": 305, "name": "Plan Example 1", "code": "B0KR5QWH", "createdAt": "2024-11-01T11:09:11.030Z",
      "updatedAt": "2024-11-01T11:09:11.030Z", "deletedAt": null, "placeId": 12, "externalReference": "2000-0000-0002-0000" }
  ]
}
```
Con `id` ⇒ devuelve un **arreglo** de planes. 400 `{"message":"No plan found with code or externalReference 'TEST1234'"}`.
- **`id` numérico = el `planId` que va en la clase**; **`code`** (8 chars) = el `plan_code` que llega en webhooks. El
  ERP debe guardar ambos y dejar que el gimnasio elija qué plan TotalPass corresponde a cada clase.
- Qué significa cada plan (niveles TP1, TP2…) y si un usuario de plan menor puede reservar una clase de plan mayor:
  **NO DOCUMENTADO** en esta API.

### 7.2 `PUT /partner/places/update-configs` (booking-api)
Único campo: **`hasSlotConfirmation`** (boolean, required). Default **`false`** para todas las sucursales.
`true` ⇒ cada reserva llega con `confirmation_url` y hay que confirmarla/negarla en ≤ 5 min (§4.2).
```json
{ "hasSlotConfirmation": true }            // request
{ "hasSlotConfirmation": true }            // 201
```
400: `"hasSlotConfirmation must be a boolean value"`, `"Body cannot be empty"`.
**La ayuda «recomienda fuertemente» activarla en todas las sucursales autenticadas.** GET para leer el valor actual:
**NO DOCUMENTADO**.

**Lo que el ERP NO puede configurar por API** (NO DOCUMENTADO como endpoint): activar el booking en el perfil del
gimnasio, ventana de reserva por defecto de la sucursal, política de cancelación por defecto, límites mensuales. La
ventana y el límite de cancelación existen **por clase** (`bookingWindow`, `maxTimeToCancel` en §3.2); lo demás se
maneja en el Portal de TotalPass (inferencia).

Fuentes: https://dev.totalpass.com/reference/get_partner-plans · https://dev.totalpass.com/reference/put_partner-places-update-configs-1 ·
https://ayuda.totalpass.com.mx/hc/es-mx/articles/49666312143259

---

## 8. SeatMaps (mapas de lugares)

Opcionales. Cada mapa pertenece a la sucursal cuyo token lo creó. Se crea **antes** de la clase y su `id` va en
`seatMapId`.

Modelo: `name` (req), `thumbnail` (opc), `size: [filas, columnas]` (req, 2 enteros), `categories[]` (req), cada una
`{ name (req), bookable (req bool), icon (opc enum: bike, step, yoga, boxing, treadmill, person, door, ac),
positions[] (req) }`, y cada posición `{ name (req), externalReference (req), position: [x, y] (req, 2 enteros
positivos, dentro de size, únicos), description (opc) }`. TotalPass le asigna a cada posición un `identifier` (UUID).

```
POST   /partner/seat-maps                  → 201 mapa con identifiers
GET    /partner/seat-maps[?id=<int>]       → lista o uno
PUT    /partner/seat-maps/{seatMapId}      → body completo (name, size, categories required) → 201
DELETE /partner/seat-maps/{seatMapId}      → 200 {"message":"Seat Map deleted"} · 404 {"message":"Seat Map not found"}
```
Request de creación (literal):
```json
{
  "name": "Bike Room 1",
  "size": [3, 3],
  "categories": [
    { "name": "bike", "bookable": true, "icon": "bike",
      "positions": [ { "name": "B1", "position": [2, 1], "externalReference": "B1" },
                     { "name": "B2", "position": [2, 2], "externalReference": "B2" } ] },
    { "name": "air conditioning", "bookable": false,
      "positions": [ { "name": "A1", "position": [1, 1], "externalReference": "A1" },
                     { "name": "A3", "position": [1, 3], "externalReference": "A3" } ] }
  ]
}
```
400: `"Each position must be within the bounds of the size array."`, `"All position arrays must be unique."`,
`"categories.0.positions.0.position should be an array of positive numbers"`.

Reglas del PUT (literal de la doc, resumidas):
- **Quitar una posición es irreversible**: las reservas en ese lugar **se cancelan automáticamente**, se pierden los
  vínculos con clases futuras y su `externalReference`.
- Poner una categoría `bookable: false` **cancela las reservas** de todos sus lugares; volver a `true` los reactiva
  sin perder datos.
- Para apagar **un** lugar sin borrarlo (p. ej. bici en mantenimiento): moverlo a una categoría `bookable: false`
  («Temporarily Unavailable Bikes»); también cancela sus reservas.
- No se puede borrar un mapa en uso por una clase futura.
- En la ocurrencia: `availableSeats` (identifiers libres), `openSeats` / `bookedSeats` en el GET, y
  `availablePositions` (externalReferences) para cambiarlos en `…/slot`. La reserva trae `slot.seat`.
- Con mapa, relación entre `slots` y número de lugares bookables: **NO DOCUMENTADO** (el GET trae
  `maxAvailableSeats`).

Fuentes: https://dev.totalpass.com/reference/post_partner-seat-maps-1 · …/get_partner-seat-maps-1 ·
…/put_partner-seat-maps-seatmapid-1 · …/delete_partner-seat-maps-seatmapid-1 · …/get_partner-events-occurrenceuuid-1

---

## 9. Límites, idempotencia, zonas horarias, formatos

| Tema | Lo documentado |
|---|---|
| Rate limits | **NO DOCUMENTADO** (sin 429 ni cabeceras de cuota). Único tope: ≤ 20 ocurrencias en `event-occurrence/status`; rango ≤ 30 días en `GET /partner/slot`. |
| Idempotencia | **NO DOCUMENTADO** (sin `Idempotency-Key`). Crear dos veces la misma clase la duplica (inferencia). Usar `externalReference` (no único) para reconciliar contra `GET /partner/events`. |
| Paginación | **NO DOCUMENTADO** en ningún GET de Booking. |
| Zona horaria | Campo `timezone` con **códigos de locale**: `"pt-BR"` / `"es-MX"`. La respuesta convierte `pt-BR` → `"America/Sao Paulo"`. A qué IANA mapea `es-MX` (México tiene varias zonas: Tijuana, Cancún, Hermosillo…): **NO DOCUMENTADO**. Inferencia: un solo huso «es-MX» ⇒ riesgo real para sucursales fuera de la zona centro; preguntar. |
| Fechas (entrada) | `startDate`/`endDate`/`eventDate`: `YYYY-MM-DD`. Horas: `"hh:mm AM/PM"`. Ventanas: `'YYYY-MM-DD hh:mm AM/PM'`. |
| Fechas (salida) | ISO-8601 UTC (`2023-09-06T03:00:00.000Z` = medianoche local de São Paulo). Horas como `"03:00 PM"`; en slots `"18:00"` (24 h). |
| Webhook check-in | ISO-8601 **con offset local** (`2024-08-07T17:54:16.271-03:00`). |
| Webhook booking | `slot.date` ISO-8601 UTC. |
| Errores | Formato NestJS: `{"statusCode":400,"message":[…],"error":"Bad Request"}`; algunos `{"message":"…"}` o `{"title":"…","message":"…"}`; check-in `{"errors":[{status,title,detail,source{message,label}}]}`. |
| Idioma de mensajes | Mezcla inglés / portugués (labels estables en `source.label` y `title` — usar ésos, no el texto). |

---

## 10. Legacy (sólo referencia — no implementar)

`https://api.totalpass.com/service/v1` (staging `https://staging.totalpass.com/api/v1`), header `x-api-key`:
- `POST /track_usages` (Use Token): valida token diario + check-in y **consume** el uso; *«Only the Token Use endpoint is
  mandatory to release the turnstile»*. Body JSON:API `{"data":{"type":"string","attributes":{"type":"cpf|curp|token|code",
  "identifier":"…","service_provider_code":"59TADO9F","service_provider_plan_code":"V01F5Q15"}}}`; 204 OK; 422 con
  labels `invalid_gym`, `check_in_not_found`, `not_exists`, `check_in_started_on_different_gym`, check-in expirado.
- `POST /track_usages/validate` (sólo valida, no consume), `POST /track_usages/beneficiaries/code`.
- `POST /bookings`, `DELETE /bookings/{id}` con header `SINGLE-ACCESS-TOKEN`.
Ya no es el camino que publica la ayuda 2026 para ERPs (que manda a Booking + Webhook Check-in).

Fuente: https://dev.totalpass.com/reference/overview · …/post_track-usages-1 · …/post_bookings-1

---

## 11. Proceso para salir en vivo (de las ayudas)

1. Registrarse en `https://developers.totalpass.com/` → ver credenciales (`partner_api_key` + `place_api_key` de prueba).
   El acuerdo de adhesión se pide a `tp.integraciones@totalpass.com.mx` (nombre del ERP, RFC, representante legal).
2. Desarrollar.
3. Pedir usuario de prueba real (sin sandbox).
4. Homologación: check-in y reservas reales con la sucursal de prueba.
5. Go-live: el ERP aparece en «Integraciones» del Portal de Partners; cada gimnasio genera su `place_api_key` y la
   captura en el ERP.
Getting Started además pide entregar a TotalPass **logo PNG** y **URL de un instructivo** para los clientes (dónde
capturar la `place_api_key`).

Fuentes: https://dev.totalpass.com/docs/getting-started · https://ayuda.totalpass.com.mx/hc/es-mx/articles/49665457008411

---

## 12. Lista de «NO DOCUMENTADO» (preguntas para TotalPass)

1. ¿Existe de verdad un entorno staging (`*.staging.totalpass.com` en el OpenAPI) o todo es producción (lo que dicen las ayudas)?
2. Host de producción del validador de check-in (`admin_server`); el OpenAPI sólo da `admin.staging.totalpass.com`.
3. Firma/autenticidad de los webhooks (HMAC, secreto, header, IPs de origen).
4. Reintentos de TotalPass si nuestro webhook responde error o no responde; timeout; qué código esperan; orden; duplicados.
5. Payload de la **cancelación de reserva por el usuario** y cómo distinguirlo de una reserva nueva (no hay `type` en booking).
6. Lista completa de `slot.status`.
7. Qué pasa si no confirmamos/negamos una reserva en los 5 minutos con `hasSlotConfirmation: true`.
8. `isCancelled` en `PUT /partner/event-occurrence/{uuid}`: la ayuda lo usa, el schema no lo tiene. Efecto y notificación.
9. ¿`INACTIVE` (status) notifica al usuario igual que borrar?
10. A qué zona IANA mapea `timezone: "es-MX"`; cómo publicar clases de sucursales fuera de la zona centro.
11. Zona horaria de `bookingWindow` / `maxTimeToCancel` (local vs UTC) y su default si no se mandan.
12. `weekday`: ¿0 = domingo?
13. No-show: ¿se reporta, se penaliza, existe estado?
14. Rate limits, idempotencia, paginación de los GET.
15. Si `event.id` del webhook de booking es el `occurrenceUuid`.
16. Si el auth realmente devuelve los planes (el ejemplo no los trae).
17. GET para leer `hasSlotConfirmation`; si existen otras configuraciones de sucursal por API.
18. Relación entre `slots` y lugares cuando hay seat map.
19. Otros tipos de webhook de check-in además de `CHECK_IN_CREATED`; otros códigos de error del validador.
20. Valores de `user.document_type` en México.
21. Política de versionado/deprecación de la API.
