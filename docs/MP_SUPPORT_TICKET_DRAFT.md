# Draft — Ticket MP Support (actualizado 2026-05-21)

**Asunto sugerido**:
`Marketplace MLM Checkout API — error 2034/2198 persistente con cuenta dev verificada + test users del panel + emails confirmados`

---

## Mensaje

Hola equipo Mercado Pago,

Marketplace MLM integration con OAuth + `application_fee` (Split Payments 1:1). Cuenta developer **ya verificada** (2026-05-21). Test users
del panel **ya con `confirmed_email: true`**. Aún así, **todos los pagos sandbox devuelven error**:

- `payer.email = test_user_<X>@testuser.com` → **2034 "Invalid users involved"**
- `payer.email = email_real_del_buyer_perfil` (cambiado) → **2198 "Invalid test user email"**

Estamos atascados en un círculo:

- El email `@testuser.com` original NO se puede validar (no recibe correos)
- El email nuevo (ej. `avoqado@test.com`) sí se puede validar pero MP lo rechaza con 2198

### Datos de la integración

- **Application ID**: `2551292920123796` (Avoqado Marketplace MX)
- **Country / Site**: MLM
- **Developer account**: `3415086004` (cuenta verificada)

### Trace IDs

```
21-05-2026T20:45:50UTC;85967709-3958-4340-b58e-7bcd3e83c7fe  ⭐ buyer FRESH del panel, SIN application_fee → 2034
21-05-2026T20:45:25UTC;31f50db5-75e5-4374-a513-753e4664527a  ⭐ buyer FRESH del panel, CON application_fee → 2034
21-05-2026T20:27:02UTC;354eb165-14c7-4905-b6f1-b3af93aa582f  (con email nuevo del buyer → 2198)
21-05-2026T20:24:50UTC;041d9d8e-f954-43e4-ae9b-0654b881042a  (con ?test_token=true)
21-05-2026T20:24:49UTC;89609312-c9f0-4d09-a5d7-882fd77c5c48  (payer info completa)
21-05-2026T20:18:03UTC;86f310f2-a3a1-43aa-8293-000e189c1d8d  (con application_fee)
21-05-2026T20:12:28UTC;17001a57-4aa6-4f9c-8644-d909392d25de  (vía Brick frontend)
```

### ⭐ EVIDENCIA DEFINITIVA (2026-05-21 20:45 UTC)

Creé un test buyer 100% nuevo y fresco directamente desde el panel MP (no via API, mismo dev account, app correcta). El buyer NO se ha
tocado: no se cambió el email, no se validó, está exactamente como MP lo entregó.

- **Buyer fresh**: `3417475741` / `TESTUSER6448646864699319800`
- **Email entregado por MP**: `test_user_6448646864699319800@testuser.com`
- **Resultado con `application_fee: 5`**: 2034
- **Resultado SIN `application_fee` (pago directo, no marketplace)**: 2034

⚠️ **Esto confirma que el problema NO es del flow marketplace** — es algo más fundamental. MP rechaza la combinación de:

- Seller test (`3414699907`, panel, `confirmed_email: true`)
- Buyer test FRESH (`3417475741`, panel, sin tocar)
- Card token con seller's `APP_USR-` public_key
- Tarjeta MLM Visa `4075 5957 1648 3764` titular APRO
- `payer.email = test_user_6448646864699319800@testuser.com`

Ambos test users:

- Mismo dev account (`3415086004`)
- Misma app (`2551292920123796`)
- Mismo país (MLM)
- Ambos `site_status: active`
- IDs distintos (no self-purchase)

### Setup técnico (todo verificado consistent)

**Test seller (panel, app 2551292920123796):**

- user_id: `3414699907`
- nickname: `TESTUSER6558699960249257250`
- tags: `["test_user", "normal"]`
- `confirmed_email: true` ✓
- email: `test_user_6558699960249257250@testuser.com`
- `status.sell.allow: true`
- `status.billing.allow: true`

**Test buyer (panel, app 2551292920123796, mismo dev):**

- user_id: `3414699903`
- nickname: `TESTUSER6115718530863174786`
- email original: `test_user_6115718530863174786@testuser.com`
- email cambiado (para validar): `avoqado@test.com` ahora confirmado ✓

**OAuth tokens consistentes (vía `/users/me`):**

- access_token ID suffix: `3414699907` ✓
- public_key: `APP_USR-70e1a05c-60b9-4204-82ab-aff3c4d4ab38`
- card_token live_mode: `true` (consistent con APP_USR-)

**Card** (oficial MLM): `5474 9254 3267 0366` / `123` / `11/30` / Titular `APRO`

### Combinaciones probadas exhaustivamente

1. ✗ Body completo (con `application_fee`, `external_reference`, `payer` completo)
2. ✗ Body mínimo (`transaction_amount`, `token`, `installments`, `payment_method_id`, `payer.email`)
3. ✗ Sin `application_fee`
4. ✗ Con `sponsor_id: 3415086004`
5. ✗ Con `?test_token=true` en `/v1/payments`
6. ✗ Email original buyer (`test_user_..._@testuser.com`) → 2034
7. ✗ Email nuevo buyer (`avoqado@test.com` post-validation) → 2198
8. ✗ Email seller (`test_user_..._@testuser.com`) → 2034
9. ✗ Tarjetas MLM Mastercard, Visa, Amex, débito
10. ✗ Buyer test creado via panel Y via API → ambos 2034

### Pregunta concreta

¿Cómo se procesa un pago Checkout API marketplace MLM sandbox?

Específicamente:

1. ¿Qué `payer.email` espera MP cuando el buyer test cambió su email del `@testuser.com` automático a uno ficticio para validación?
2. ¿Existe algún flag adicional para sandbox marketplace MLM que no esté documentado?
3. ¿Es bug conocido de MLM marketplace sandbox + Checkout API?

Adjunto los trace IDs — pueden ver el request exacto en sus logs.

Gracias.

---

## Resumen ejecutivo (para Avoqado interno)

**Bloqueo confirmado**: Sandbox MP MLM marketplace + Checkout API no procesa pagos en ninguna combinación probada (10+ scenarios). Todas las
hipótesis del otro LLM/docs/foros probadas y descartadas.

**El código backend está correcto** según docs oficiales MP 2026.

**Camino real para validar e2e**: Producción real con cuenta MP de Cristina (Red Bloom). Monto $1 MXN para mitigar riesgo.
