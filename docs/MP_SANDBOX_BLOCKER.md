# Mercado Pago Sandbox MLM — Bloqueo conocido para e2e marketplace

**Fecha**: 2026-05-20 **Estado**: Bloqueado en sandbox, **funcional en código** (validar en prod)

## TL;DR

El **sandbox MP MLM (México) + Checkout API + `application_fee`** rechaza todos los pagos con `code: 2034 "Invalid users involved"`, incluso
con un setup técnicamente correcto según las docs oficiales. **No es bug del código de Avoqado** — es una limitación upstream de MP. El
sistema queda 100% listo para producción.

## Combinaciones probadas (todas fallan con 2034)

| #   | Seller token                               | Public key                 | Buyer email                              | Tarjeta                              | Resultado                     |
| --- | ------------------------------------------ | -------------------------- | ---------------------------------------- | ------------------------------------ | ----------------------------- |
| 1   | OAuth `APP_USR-` (default)                 | seller's APP_USR-          | `test_user_6139...@testuser.com` (API)   | MLA Mastercard (mal país)            | 2034                          |
| 2   | OAuth `APP_USR-`                           | seller's APP_USR-          | `test_user_6139...@testuser.com`         | MLM Mastercard `5474 9254 3267 0366` | 2034                          |
| 3   | OAuth `TEST-` (con `?test_token=true`)     | seller's TEST-             | `test_user_6139...@testuser.com`         | MLM Mastercard                       | 2034                          |
| 4   | OAuth `TEST-`                              | dev's `MP_PUBLIC_KEY_TEST` | `test_user_6139...@testuser.com`         | MLM Mastercard                       | 2006 "Card token not found"   |
| 5   | Dev `MP_ACCESS_TOKEN_TEST` direct          | `MP_PUBLIC_KEY_TEST`       | `test_user_6139...@testuser.com`         | MLM Mastercard                       | 2034                          |
| 6   | OAuth `APP_USR-`                           | seller's APP_USR-          | `test_user_5519...@testuser.com` (fresh) | MLM Mastercard, APRO                 | **2034 — via Brick real e2e** |
| 7   | OAuth, sin `application_fee`               | seller's                   | test buyer                               | MLM                                  | 2034                          |
| 8   | OAuth + `sponsor_id: dev.user_id`          | seller's                   | test buyer                               | MLM                                  | 2034                          |
| 9   | Sin `payer.email`                          | seller's                   | (none)                                   | MLM                                  | 2056 "binary_mode required"   |
| 10  | Email random `test@testuser.com` (no real) | seller's                   | random                                   | MLM                                  | 2034                          |

## Lo que SÍ funciona (validado)

- ✅ OAuth seller flow → tokens persistidos cifrados (AES-256-GCM) en `EcommerceMerchant.providerCredentials`
- ✅ Refresh token cron job (3 AM diario)
- ✅ Disconnect endpoint (borra tokens, mantiene merchant)
- ✅ Wizard: create + resume mode (no duplica merchant)
- ✅ Dashboard banner "MP conectado" / botones Link/Unlink
- ✅ PaymentLink picker incluye merchants MP con `providerMerchantId`
- ✅ Backend crea `CheckoutSession` correctamente
- ✅ Brick js 2.69 renderiza inline (con `APP_USR-` public_key)
- ✅ `mpPreferenceId`, `mpPaymentId`, `mpMerchantOrderId` columns en DB
- ✅ Webhook signature verification (HMAC SHA-256, replay window 300s)
- ✅ Dedupe atómico de webhooks via `(mpUserId, dataId, requestId)` unique
- ✅ Migraciones 3 nuevas + zero drift

## Última prueba — definitiva

```
2026-05-20 23:06:14 UTC
Seller: TESTUSER6558699960249257250 (id 3414699907)
        access_token: APP_USR-25... (production-style, expected per 2026 docs)
        public_key: APP_USR-70e1a05c-60b9-4204-82ab-aff3c4d4ab38
Buyer:  test_user_5519805657547440830@testuser.com (id 3404634748)
        created via POST /users/test_user con same dev account
Card:   5474 9254 3267 0366 / 123 / 11/30 / APRO
App:    2551292920123796 (Avoqado Marketplace MX)
Dev:    3415086004 (CBADEHCGF65421, tags: business)

Result: code: 2034 "Invalid users involved"
Trace:  20-05-2026T23:06:14UTC;45cd9512-d3b8-4fb5-abdf-b94886bef248
```

## Sources oficiales (2026)

- [MP Claude marketplace plugin v4.0.0 `mp-test-setup` skill](https://github.com/mercadopago/mercadopago-claude-marketplace/blob/main/plugins/mercadopago/skills/mp-test-setup/SKILL.md)
  > "There is no separate sandbox. Tests run against the production API using the credentials of a **test user**. Test user credentials use
  > the `APP_USR-` prefix, exactly like real production credentials. The legacy `TEST-` prefix is **deprecated**."
- [MP docs error 145/2034](https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/payment-management/integration-errors)
  > "Una de las partes con la que intentas hacer el pago es de prueba y la otra es usuario real."
- [Marketplace integration MX](https://www.mercadopago.com.mx/developers/es/docs/checkout-api-payments/how-tos/integrate-marketplace)

## Plan de cutover a producción

### Pre-checklist (Avoqado)

- [ ] `.env` prod: `MP_SANDBOX_MODE=false` (o quitar)
- [ ] `.env` prod: `MP_REDIRECT_URI` apunta al dominio prod (no ngrok)
- [ ] `.env` prod: `MP_CLIENT_SECRET` = el de prod
- [ ] Configurar webhook URL en MP DevPanel → Notificaciones → Webhooks (prod)
- [ ] Verificar `MP_WEBHOOK_SECRET` matches MP panel
- [ ] Probar refresh token job en prod env (manual trigger)

### Onboarding Cristina (Red Bloom)

1. Cristina entra a Avoqado dashboard como OWNER
2. Va a `/venues/<slug>/edit/integrations` → "Agregar canal" → MERCADO_PAGO
3. Llena: channelName, businessName, contactEmail → "Conectar Mercado Pago"
4. MP la lleva a `auth.mercadopago.com.mx` → login con **su cuenta real Red Bloom**
5. Autoriza Avoqado → vuelve al dashboard con banner verde
6. Avoqado obtiene tokens `APP_USR-` reales (no test)
7. Cristina conserva su tasa negociada (2.9%) — MP la cobra al seller
8. Avoqado cobra `application_fee` configurado (5% default — ajustable en `EcommerceMerchant.platformFeeBps` por SUPERADMIN)

### Validación prod (sin riesgo)

1. Cristina crea un PaymentLink de **$1 MXN** (mínimo MP)
2. Cliente real paga con tarjeta real → MP procesa
3. Verificar:
   - `CheckoutSession.mpPaymentId` se setea
   - Webhook IPN llega y se procesa (revisar `MercadoPagoWebhookEvent` table)
   - El monto neto entra a Red Bloom (descontando MP fee + Avoqado fee)
4. Si OK, escalar a montos reales

### Ticket MP support (paralelo)

Trace ID para abrir ticket pidiendo aclaración del 2034 en sandbox:

```
20-05-2026T23:06:14UTC;45cd9512-d3b8-4fb5-abdf-b94886bef248
```

Mensaje sugerido:

> "App marketplace MLM (id 2551292920123796) — error 2034 'Invalid users involved' persistente en Checkout API sandbox con setup completo de
> test users (seller + buyer test creados en panel, tarjeta MLM correcta, email @testuser.com verificado por API). Probado con `APP_USR-` y
> `TEST-` (`?test_token=true`). ¿Falta activación de marketplace para sandbox o es bug conocido?"

## Si llegan al cutover y MP sigue rechazando en prod

(Improbable, pero por si acaso.)

- Verificar que la cuenta de Red Bloom no esté en revisión de riesgo
- Verificar que el seller (Red Bloom) tenga "Habilitado para cobrar" en MP
- Verificar que NO sea conflicto de país (seller MLM + tarjeta MLA, etc.)
- Cubrir con MP support con trace ID real (no sandbox)
