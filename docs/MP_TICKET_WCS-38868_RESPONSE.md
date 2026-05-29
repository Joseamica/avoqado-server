# Respuesta a MP Support — Ticket WCS-38868

**Copia el contenido entre `---` para pegarlo en tu respuesta a MP.**

---

¡Gracias por la respuesta! Adjunto los datos solicitados.

## 1. Body y response completos del último intento fallido

**Endpoint**: `POST https://api.mercadopago.com/v1/payments`

**Headers** (Authorization redacted):

```
Authorization: Bearer APP_USR-2551292920123796-052013-****
Content-Type: application/json
X-Idempotency-Key: WCS38868-1779397040940
```

**Body enviado**:

```json
{
  "token": "34a17a57a4f4ab1b0354de45fcb65af3",
  "payment_method_id": "visa",
  "installments": 1,
  "transaction_amount": 100,
  "application_fee": 5,
  "external_reference": "avoqado-ticket-WCS-38868",
  "description": "Avoqado marketplace test for MP ticket WCS-38868",
  "payer": {
    "email": "test_user_6448646864699319800@testuser.com"
  },
  "binary_mode": false
}
```

**Response recibido**:

```json
HTTP/1.1 400
{
  "message": "Invalid users involved",
  "error": "bad_request",
  "status": 400,
  "cause": [
    {
      "code": 2034,
      "description": "Invalid users involved",
      "data": "21-05-2026T20:57:21UTC;153d8799-72e5-4cd4-98b9-98151e54e7eb"
    }
  ]
}
```

## 2. Valor exacto enviado en `payer.email`

```
test_user_6448646864699319800@testuser.com
```

## 3. Confirmación de los users involucrados

### Comprador (`payer`)

- **User ID**: `3417475741`
- **Nickname**: `TESTUSER6448646864699319800`
- **Origen**: Cuenta de prueba creada en el panel de Developers (sección "Cuentas de prueba" de la app `2551292920123796`)
- **Country**: MX (site_id MLM)
- **Status**: site_status=`active`
- **Email asignado por MP al crear**: `test_user_6448646864699319800@testuser.com` (mismo que mando en `payer.email` — no se modificó tras
  la creación)

Detalles vía `GET /users/3417475741`:

```json
{
  "id": 3417475741,
  "nickname": "TESTUSER6448646864699319800",
  "country_id": "MX",
  "site_id": "MLM",
  "user_type": "normal",
  "status": { "site_status": "active" }
}
```

### Vendedor (`collector` vía OAuth)

- **User ID**: `3414699907`
- **Nickname**: `TESTUSER6558699960249257250`
- **Origen**: Cuenta de prueba creada en el panel de Developers (sección "Cuentas de prueba" de la app `2551292920123796`, profile=Vendedor)
- **Country**: MX (site_id MLM, **mismo que el comprador**)
- **tags**: `["test_user", "normal"]`
- **confirmed_email**: `true`
- **status.sell.allow**: `true`
- **status.billing.allow**: `true`

Detalles vía `GET /users/me` con el OAuth access_token:

```json
{
  "id": 3414699907,
  "nickname": "TESTUSER6558699960249257250",
  "email": "test_user_6558699960249257250@testuser.com",
  "tags": ["test_user", "normal"],
  "site_id": "MLM",
  "status": {
    "billing": { "allow": true, "codes": [] },
    "buy": { "allow": true, "codes": [], "immediate_payment": { "reasons": [], "required": false } },
    "sell": { "allow": true, "codes": [], "immediate_payment": { "reasons": [], "required": false } },
    "list": { "allow": true, "codes": [], "immediate_payment": { "reasons": [], "required": false } },
    "confirmed_email": true,
    "site_status": "active",
    "mercadopago_account_type": "personal",
    "mercadopago_tc_accepted": true,
    "required_action": ""
  }
}
```

### Application context

- **Application ID**: `2551292920123796` (Avoqado Marketplace MX)
- **Developer (owner)**: `3415086004`
- **OAuth access_token sufijo**: `...e51ee080-3415086004` (confirma que el token pertenece al developer de la app `2551292920123796`,
  vinculado al seller test `3414699907` via OAuth `authorization_code` flow)
- **Card token public_key**: `APP_USR-70e1a05c-60b9-4204-82ab-aff3c4d4ab38` (la `public_key` del vendedor entregada en la response del
  refresh OAuth)

## 4. Verificaciones adicionales que confirmamos de nuestro lado

✅ Comprador y vendedor son **ambos test users del panel** de la misma app (`2551292920123796`) ✅ Ambos son **del mismo país** (MX / MLM)
✅ El `payer.email` corresponde **exactamente** al email entregado por MP al crear el test user — no es email real ni email seguro ✅ El
`access_token` y la `public_key` corresponden a la **misma aplicación** (`2551292920123796`) ✅ La cuenta developer (`3415086004`) está
**verificada** (confirmamos el 2026-05-21) ✅ Probamos también **sin `application_fee`** (pago directo, no marketplace) → sigue devolviendo
`2034` ✅ Probamos también con `?test_token=true` en `/v1/payments` y en `/oauth/token` → mismo resultado

## 5. Pregunta

Con todos estos checks satisfactorios, ¿pueden revisar el log interno del trace
`21-05-2026T20:57:21UTC;153d8799-72e5-4cd4-98b9-98151e54e7eb` y decirnos qué validación específica está fallando? Necesitamos completar la
validación e2e antes de migrar a producción con sellers reales.

Gracias.

---

## Notas internas (NO incluir en el ticket)

- Si MP responde "el OAuth necesita algo en el panel", aplicar y reportar
- Si MP confirma bug irresoluble en sandbox, ir directo a producción
- Cristina/Red Bloom puede autorizar con cuenta real y validar en prod ($1 MXN)
