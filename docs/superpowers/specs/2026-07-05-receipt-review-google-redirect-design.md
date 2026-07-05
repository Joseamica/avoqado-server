# Reseñas en el recibo digital + redirección a Google (5★) — Diseño

**Fecha:** 2026-07-05
**Estado:** Diseño aprobado (pendiente review del spec por el fundador)
**Repos afectados:** `avoqado-server` (hub, autoritativo), `avoqado-web-dashboard` (widget + config), `Avoqado-HQ` (deck de ventas)
**Tier:** PRO (decisión del fundador)

---

## 1. Problema

El recibo digital público que abre el cliente escaneando el QR que imprime la TPV
(`dashboard.avoqado.io/receipts/public/:accessKey`) **no muestra** ninguna forma de
calificar la experiencia con estrellas.

La causa raíz (investigada esta sesión):

- El backend YA tiene la API completa de reseñas desde el recibo: `POST/GET
  /api/v1/public/receipt/:accessKey/review` + `/review/status`, el modelo Prisma
  `Review`, y el servicio `receiptReview.tpv.service.ts`. Funciona.
- Existe un widget de estrellas **legacy** en HTML server-rendered
  (`avoqado-server/src/utils/receiptTemplate.ts`, `generateReceiptHTML`, ago 2025)
  que sí tiene el formulario — pero está **muerto** para el flujo real: el QR de la
  TPV apunta a la ruta React del dashboard, que pide JSON al backend (`axios.get`
  sin `Accept: text/html`), así que la rama HTML nunca se sirve al cliente.
- El componente React que sí se usa (`ModernReceiptDesign.tsx`) **nunca portó** el
  widget de estrellas.
- La lógica "5★ → Google, menos → interno" **no existe en ningún lado** del código
  (ni en el HTML legacy ni en el backend). Lo único condicional por rating hoy es
  `VenueSettings.badReviewThreshold` (default 3), que dispara una notificación
  **interna** al staff para calificaciones bajas — no hay redirección externa.
- `Venue.googlePlaceId` NO sirve para armar el link de "escribe tu reseña": es el
  resource-name interno de la Google Business Profile API
  (`accounts/.../locations/...`), usado por la feature *separada y ya funcional* que
  importa reseñas de Google hacia Avoqado para que el staff responda
  (`googleBusinessProfile.service.ts`, `GoogleIntegration.tsx`, `src/components/Review/*`).
  No confundir con esta feature.

## 2. Objetivo

Portar el widget de estrellas al recibo React actual y agregar la lógica de
redirección condicional a Google, con un campo de configuración donde el dueño pega
su link de reseñas de Google. Todo gateado a PRO.

## 3. Decisiones tomadas (fundador, esta sesión)

| # | Decisión | Valor |
|---|----------|-------|
| 1 | Umbral de redirección | **Solo 5★** redirige a Google. 1-4★ se guardan solo internamente. |
| 2 | Sub-ratings (food/service/ambience) | **NO** se muestran. Solo `overallRating` + comentario opcional. (ICP actual = retail/servicios, no restaurantes.) |
| 3 | Origen del link de Google | El dueño lo pega manualmente. **Campo inteligente**: acepta URL completa O solo el Place ID; auto-detecta cuál es. |
| 4 | Validación del campo | **Estricta** (ver §6). |
| 5 | Qué es PRO | El **widget completo** (estrellas + captura interna + redirect). Venue FREE no muestra nada en el recibo. |
| 6 | Timing del redirect | Se guarda el review interno **siempre primero** (sin importar rating); el redirect es aditivo. En 5★ se muestra pantalla de éxito con CTA grande a Google (no salto automático `window.location`). |
| 7 | Hogar del campo de config | Sección **Integraciones** del dashboard (`settings/integrations`), dentro del subpage de Google (`GoogleIntegration.tsx`). |
| 8 | Exposición en el MCP | **Solo OWNER** (gate de permiso owner-scoped). |

## 4. Arquitectura (flujo end-to-end)

```
Cliente escanea QR TPV → dashboard.avoqado.io/receipts/public/:accessKey
   → ReceiptViewer.tsx (React) pide GET /public/receipt/:accessKey (JSON)
   → GET /public/receipt/:accessKey/review/status  ← se EXTIENDE aquí
        devuelve: { canSubmit, reason, venue,
                    reviewsEnabled: bool,       ← gate PRO resuelto server-side
                    googleReviewUrl: string|null } ← link ya normalizado a URL final
   → ModernReceiptDesign.tsx renderiza <ReceiptReviewWidget> SOLO si reviewsEnabled
   → Cliente califica 1-5★ (+ comentario/nombre opcionales) → "Enviar"
      → POST /public/receipt/:accessKey/review  (source=AVOQADO, SIEMPRE se guarda)
      → si overallRating === 5 && googleReviewUrl → pantalla éxito con CTA a Google
      → si overallRating < 5 → "¡Gracias!" (backend ya dispara notif. interna si ≤ threshold)
```

## 5. Modelo de datos (avoqado-server)

Nuevo campo en `VenueSettings` (junto a la sección "Reviews" que ya existe):

```prisma
model VenueSettings {
  // ... campos existentes ...
  // Reviews
  autoReplyReviews    Boolean  @default(false)
  notifyBadReviews    Boolean  @default(true)
  badReviewThreshold  Int      @default(3)
  badReviewAlertRoles String[] @default(["OWNER", "ADMIN", "MANAGER"])
  googleReviewLink    String?  // NUEVO — URL completa o Place ID crudo, tal cual lo pega el dueño
}
```

- Se guarda **crudo** (lo que el dueño pegó). La normalización a URL final se hace al
  **leer** (service), no al escribir — así se puede cambiar la lógica de normalización
  sin migrar datos.
- Migración: `npx prisma migrate dev` (NO `db push`). Agregar `VenueSettings` ya está
  en `MODEL_TO_DOMAIN` (modelo existente, no aplica la regla de schema-map para modelos nuevos).
- NO se toca el modelo `Review`. Ya acepta `foodRating/serviceRating/ambienceRating`
  como opcionales; simplemente el widget nuevo no los manda.

## 6. Normalización + validación del link de Google

Lógica compartida (backend autoritativo, frontend espeja para UX inmediata):

**Detección:** si el valor empieza con `http://` o `https://` → es URL; si no → es Place ID.

**Validación al guardar (Zod, mensajes en español):**
- Si es URL: debe parsear como URL válida Y el `host` debe estar en una allowlist de
  dominios de Google: `g.page`, `goo.gl`, `maps.app.goo.gl`, `google.com`,
  `www.google.com`, `search.google.com`, `maps.google.com`. Cualquier otro dominio →
  rechazo ("El link debe ser de Google").
- Si es Place ID: regex `^[A-Za-z0-9_-]{10,256}$` (solo alfanumérico + `-`/`_`, sin
  espacios, `/`, `.`). Esto rechaza pedazos de URL rotos pegados a medias.

**Normalización al leer (service → devuelve `googleReviewUrl`):**
- URL passthrough → se devuelve tal cual.
- Place ID → `https://search.google.com/local/writereview?placeid=<placeId>`.
- `null`/vacío → `googleReviewUrl: null`.

## 7. Gating PRO

- Nuevo `Feature.code = 'GOOGLE_REVIEW_REDIRECT'`.
- Agregar a `PRO.includes` en `avoqado-web-dashboard/src/config/plan-catalog.ts`.
- **NO** entra a `PREMIUM_ONLY_CODES` (`basePlan.service.ts`) → cualquier venue con
  PLAN_PRO o PLAN_PREMIUM activo lo desbloquea automáticamente vía el mecanismo que ya
  existe (mismo patrón que `LOYALTY_PROGRAM`/`RESERVATIONS`). Sin producto Stripe nuevo.
- Registro en `PERMISSION_TO_FEATURE_MAP` si aplica al split de white-label (revisar en plan).
- **Resolución del gate:**
  - En el recibo público (unauthenticated): el endpoint `/review/status` resuelve
    `venueHasFeatureAccess(venueId, 'GOOGLE_REVIEW_REDIRECT')` server-side y devuelve
    `reviewsEnabled`. El frontend solo pinta el widget si es `true`.
  - En el dashboard: el campo de config se envuelve en `<FeatureGate feature="GOOGLE_REVIEW_REDIRECT">`
    (teaser de upsell como CFDI) — el teaser va en el dashboard, **nunca** en el recibo del cliente.

## 8. Frontend — widget del recibo (avoqado-web-dashboard)

Nuevo componente `ReceiptReviewWidget` (nuevo archivo bajo `src/components/receipts/`),
renderizado por `ModernReceiptDesign.tsx` **solo en `variant='full'` (vista pública) y
solo si `reviewsEnabled`**:

- Estrellas 1-5 (interactivas, hover), comentario opcional (`textarea`), nombre opcional.
- Botón "Enviar" → `POST /public/receipt/:accessKey/review` con `{ overallRating,
  comment?, customerName? }`. Usa `axios` directo (endpoint público, `origin:'*'`, sin
  `withCredentials`), igual que `ReceiptViewer.tsx` ya hace para el recibo.
- Al éxito:
  - Si `overallRating === 5 && googleReviewUrl`: pantalla de éxito que **lidera** con
    botón primario grande "Califícanos en Google ⭐" (`window.open(googleReviewUrl,
    '_blank', 'noopener')`).
  - Si `< 5`: "¡Gracias por tu opinión!".
- Estados: ya calificado (`canSubmit=false, reason='Review already submitted'`) →
  deshabilitado con "✅ Ya calificado"; error → toast.
- i18n: `es` + `en` (regla del repo). Sin colores hardcodeados (tokens semánticos).
- El widget legacy en `receiptTemplate.ts` se deja como está (dead code para el flujo
  real; se puede limpiar después, fuera de scope aquí).

## 9. Frontend — config del link (avoqado-web-dashboard, Integraciones)

Dentro de `src/pages/Settings/GoogleIntegration.tsx` (subpage de Integraciones → Google),
agregar una card **"Link de reseñas de Google"** envuelta en `<FeatureGate
feature="GOOGLE_REVIEW_REDIRECT">`:

- Un `<Input>` donde el dueño pega el link completo O solo el Place ID.
- Texto de ayuda: cómo obtener el link ("Obtener más reseñas" en su perfil de Google
  Business, formato `g.page/r/XXXX/review`) o el Place ID.
- Guarda vía el endpoint que ya existe `PUT /api/v1/dashboard/venues/:venueId/settings`
  (permiso `venues:update`, `UpdateVenueSettingsSchema`) — agregar `googleReviewLink` al
  schema Zod. Sin endpoint nuevo, sin permiso nuevo.
- Lee vía `GET /api/v1/dashboard/venues/:venueId/settings` (ya devuelve `VenueSettings`).
- Validación espejo (misma lógica de §6) para feedback inmediato antes de mandar.

## 10. Backend — endpoints (avoqado-server)

1. **Extender** `GET /public/receipt/:accessKey/review/status`
   (`receiptReview.public.controller.ts` → `receiptReview.tpv.service.ts::canSubmitReview`):
   agregar al response `reviewsEnabled: boolean` (gate PRO resuelto) y `googleReviewUrl:
   string | null` (link normalizado). Backward-compatible (campos nuevos, opcionales).
2. **Extender** `UpdateVenueSettingsSchema` + `getVenueSettings`/`updateVenueSettings`
   controllers para incluir `googleReviewLink` con la validación Zod de §6 (español).
3. `POST /public/receipt/:accessKey/review` — **sin cambios** (ya guarda el review; la
   notificación interna de mala review ya está cableada). El redirect es 100% decisión
   del frontend basada en el rating + `googleReviewUrl`.

## 11. MCP (avoqado-server, customer MCP `src/mcp/`)

Regla del workspace: mantener el MCP en sync. El fundador pidió **OWNER-only**.

- Exponer `googleReviewLink` (o `googleReviewUrl` normalizado) en la lectura del venue
  (extender `venues.ts` / `venue_profile`), gateado a un permiso **owner-scoped**
  (reusar `settings:manage` si es OWNER-only, o el gate owner que corresponda — resolver
  en el plan; NO usar un gate ADMIN+).
- Si se agrega un tool de **escritura** para configurar el link: `requirePermission`
  (owner) + `venueFilter` + `auditMcpWrite`. Es de bajo impacto (config, reversible) →
  puede ejecutar directo sin confirm-gate de dos pasos, pero owner-only.
- NO tocar el admin MCP (`scripts/mcp/`).

## 12. Sincronización obligatoria (reglas del workspace)

- **Deck de ventas + one-pager** (`Avoqado-HQ/operations/marketing/platform-presentation/`):
  es capacidad visible al cliente (feature PRO nueva) → actualizar `avoqado-presentacion.html`
  Y `avoqado-one-pager.html` + regenerar ambos PDFs. (Cambio en repo HQ, tarea del plan.)
- **avoqado-ios / avoqado-android:** no aplican tier gating aún (deuda conocida); no
  bloquea esta feature. El widget vive en el recibo web, no en las apps POS.

## 13. Testing

- **Backend (unit):** normalización/validación del link (URL válida de Google, dominio
  no-Google rechazado, Place ID válido, Place ID con basura rechazado, null); `/review/status`
  devuelve `reviewsEnabled` correcto según feature access; `googleReviewUrl` correcto por
  cada forma de input. Regresión: submit de review sigue funcionando; notif. interna intacta.
- **Frontend:** widget solo aparece con `reviewsEnabled`; 5★ muestra CTA de Google, <5★ no;
  review se guarda antes de mostrar CTA; estado "ya calificado".
- `tsc --noEmit` después de tests (jest es transpile-only).

## 14. Fuera de scope (YAGNI)

- Limpiar/eliminar el widget legacy de `receiptTemplate.ts` (dead code, no molesta).
- Sub-ratings por sector-terminology (decidido: no sub-ratings).
- Sacar el Place ID automáticamente vía la Google Business Profile API OAuth (el dueño
  lo pega; no dependemos de que conecte esa integración).
- Redirección automática dura (`window.location`) — se usa botón/CTA.

## 15. Riesgos / notas

- El endpoint `/review/status` es público (unauthenticated). Resolver el feature access
  ahí es correcto: es el gate del **venue**, no scoped a usuario. No expone datos sensibles
  (solo un booleano + una URL pública de reseñas).
- No hay escritura a producción en el desarrollo/testing (regla firme): todo en dev local.
- No commitear hasta que el fundador diga "commitea/push/lanza".
