# Arquitectura multi-proveedor de delivery — núcleo único + adaptadores

**Fecha:** 2026-08-20 · **Estado:** diseño aprobado por el founder, pendiente de plan de implementación

## 1. Qué decide este documento

Cómo integrar **Uber Eats, Rappi y DiDi Food de forma directa** (y Deliverect como
alternativa) sin duplicar la lógica de negocio una vez por proveedor, y sin llenar el
núcleo de condicionales `if (provider === X)`.

La decisión: **un núcleo que hace el trabajo una sola vez, y un adaptador delgado por
proveedor que solo traduce.** Los datos viven en tablas compartidas; lo que se separa es
el código que traduce, no el esquema.

## 2. Estado medido (2026-08-20, no supuesto)

| | archivos | líneas |
|---|---|---|
| `core/` (compartido) | 9 | 1 220 |
| `providers/deliverect/` | 4 | 423 |
| `providers/uber-eats/` | 9 | 930 |

**Uber pesa el doble que Deliverect** porque se le hizo camino propio en vez de usar el
núcleo. En particular, `uber.orderIngestion.service.ts` (220 líneas) duplica a
`core/deliveryOrderIngestion.service.ts` (326).

**No hay condicionales por proveedor todavía.** `grep` de `provider ===` / `=== 'UBER_EATS'`
en `src/`: cero ocurrencias en delivery (las 9 que aparecen están en
`consumer/auth.consumer.service.ts`, sin relación). El problema es duplicación, no espagueti
— se llega a tiempo.

**Por qué se duplicó:** el núcleo arrastra defectos de dinero conocidos y Deliverect quedó
congelado encima de ellos. Ver §6.

## 3. Decisiones del founder (2026-08-20)

1. **Tier: PREMIUM** para delivery directo.
2. **Nadie usa Deliverect en producción hoy** — el núcleo se puede arreglar sin romper clientes.
3. **Deliverect se mantiene como segunda opción**, migrado al mismo contrato, sin prisa. La
   prioridad es la integración directa. Razón de peso encontrada al investigar: DiDi Food se
   integra mayoritariamente vía intermediarios, así que si no aprueba la directa, Deliverect
   es el plan B **para DiDi específicamente**.
4. **Una sola tabla, no una por proveedor.** Motivo: los reportes. Con tablas separadas,
   "ventas de delivery de hoy" son tres consultas y una suma a mano, y cada reporte nuevo se
   escribe tres veces.

## 4. Qué es realmente distinto entre proveedores

Investigado en vivo el 2026-08-20 (no de memoria):

| Eje | Uber Eats | Rappi | DiDi Food |
|---|---|---|---|
| Auth | OAuth `client_credentials` | OAuth `client_credentials` | plataforma abierta ⚠️ |
| Dominio | global (`test-api` / `api`) | **uno por país** | ⚠️ sin verificar |
| Cómo llega el pedido | webhook con **puntero** + `GET` | webhook **y** sondeo | webhook ⚠️ |
| Onboarding | aprobación + verificación conjunta | aprobación comercial | mayormente vía intermediario |

⚠️ **Lo de DiDi NO está verificado de primera mano.** Su documentación pública es escasa y
la mayoría de los POS llegan a DiDi por intermediarios. Antes de escribir su adaptador hay
que obtener acceso a `developer.didi-food.com` y confirmar estas cuatro filas. **El diseño
NO depende de que la tabla de DiDi sea exacta** — el contrato de §5.1 absorbe las cuatro
variantes conocidas (con/sin puntero, con/sin sondeo, dominio fijo o por país) — pero el
plan de DiDi sí, y por eso es un trabajo aparte (§8, paso 8).

Fuentes: [Uber order integration](https://developer.uber.com/docs/eats/guides/order-integration) ·
[Rappi dev portal](https://dev-portal.rappi.com/es/api-reference/orders/) ·
[DiDi Food open platform](https://developer.didi-food.com/es-MX/home)

**Todo lo demás es idéntico** y no depende de quién mandó el pedido: guardar sin duplicar,
resolver el venue, crear `Order` + líneas + `Payment`, inventario, impresión, reportes y
reconciliación.

## 5. La arquitectura

### 5.1 El contrato del adaptador

Un adaptador implementa seis capacidades. Las tres primeras son obligatorias; las otras
son opcionales y el núcleo consulta su presencia, sin preguntarle a nadie quién es:

```typescript
interface DeliveryProviderAdapter {
  readonly provider: DeliveryProvider

  /** ¿El mensaje es auténtico? Cada proveedor firma distinto. */
  verifyWebhook(raw: Buffer, headers: Headers, secrets: string[]): WebhookVerdict

  /** ¿De qué tienda y qué pedido es? Cada uno lo pone en otro campo. */
  extractIdentity(payload: unknown): EventIdentity

  /** Traduce el pedido crudo al contrato interno. Aquí vive TODA la diferencia real. */
  normalizeOrder(raw: unknown, link: DeliveryChannelLink): NormalizedDeliveryOrder

  /** Trae el pedido completo. Opcional: solo si el webhook manda un puntero (Uber). */
  fetchOrder?(orderId: string, ctx: ProviderContext): Promise<RawOrder>

  /** Acciones hacia el proveedor. Opcionales por capacidad. */
  acceptOrder?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  denyOrder?(orderId: string, reason: DenyReason, ctx: ProviderContext): Promise<ActionResult>
  markReady?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  publishMenu?(menu: MenuSnapshot, ctx: ProviderContext): Promise<ActionResult>
  setStoreStatus?(status: StoreStatus, ctx: ProviderContext): Promise<ActionResult>
}
```

**Regla dura del contrato:** si `normalizeOrder` no puede separar el dinero con certeza,
**rechaza** (evento visible + 4xx) en vez de estimar. Nunca inventa un cobro.

### 5.2 El contrato de datos

`NormalizedDeliveryOrder` — lo que los cuatro adaptadores producen y lo único que el
núcleo entiende. Se generaliza a partir de `NormalizedUberOrder` (`uber.types.ts`), que ya
tiene la forma correcta: líneas, modificadores y el **reparto explícito** de quién cobró qué.

Invariantes, verificadas antes de tocar la base:

- Todo el dinero como **string decimal** o `Prisma.Decimal`, nunca `number`.
- `subtotal + comisiones = cobradoExternamente + porCobrarEnEfectivo`, al centavo.
- `propina = propinaExterna + propinaEnEfectivo`.
- Ningún monto negativo. Una sola moneda por pedido.

### 5.3 El núcleo

Hace esto **una sola vez**, para los cuatro:

1. `receiveWebhook(provider, raw, headers)` — verifica firma vía adaptador, persiste,
   deduplica, resuelve el venue. Responde rápido (contrato persist-first).
2. `processEvent(eventId)` — trae el pedido si el adaptador lo requiere, normaliza, ingiere.
3. `ingestOrder(normalized, link)` — `Order` + líneas + modificadores + `Payment` en UNA
   transacción; posting de inventario fuera de ella (patrón del repo).
4. `dispatchAction(orderId, action)` — outbox → adaptador, con reintento y lease.
5. Reconciliación de eventos atorados, **enrutada por `event.provider`**.

### 5.4 Dónde muere el `if (provider === X)`

En un único registro:

```typescript
const ADAPTERS: Record<DeliveryProvider, DeliveryProviderAdapter> = { ... }
export function adapterFor(p: DeliveryProvider): DeliveryProviderAdapter
```

El núcleo pide el adaptador y trabaja contra el contrato. **Un `if` por proveedor fuera de
este registro es un bug de diseño**, y hay un test que recorre `src/services/delivery-channels/core/`
y falla si aparece uno — mismo patrón que el guardrail de `multipartContext.test.ts`.

## 6. Los defectos del núcleo que hay que arreglar

Son la razón real de que Uber tenga camino propio. Al unificar **hay que arreglarlos**, y
como tocan dinero van con **test primero**, sin excepción.

**Propina contada dos veces** — `core/deliveryOrderIngestion.service.ts:220-221`:

```typescript
amount:    new Prisma.Decimal(normalized.total),      // el total YA incluye la propina
tipAmount: new Prisma.Decimal(normalized.tipAmount),  // y la propina otra vez, aparte
```

`Payment.amount` debe ser **la venta sin propina**; `Payment.tipAmount` la propina. Es lo que
`ingestUberOrder` ya hace bien y lo que el núcleo debe adoptar. Emparenta con la deuda ya
registrada en memoria (`order-total-propina-semantica-doble`, ~8 sitios que suman mezclado).

Al migrar, cada defecto se documenta con `archivo:línea`, su test rojo y su fix — no se
"aprovecha para limpiar" nada que no esté en esta lista.

## 7. Cómo se prueba

Un **mismo juego de pruebas de contrato** que se corre contra los cuatro adaptadores:

| Caso | Qué prueba |
|---|---|
| Pedido normal | la traducción básica |
| Con modificadores | que la línea sume bien con sus extras |
| Cancelado tras aceptar | que no se cobre ni imprima algo cancelado |
| Mismo pedido dos veces | idempotencia: no duplica venta ni cobro |
| Dinero que no cuadra | que **rechace** en vez de estimar |
| Producto que no resuelve | que la línea entre marcada, sin perderse |

Si Rappi pasa las mismas pruebas que Uber, está bien integrado. **Eso es lo que convierte
"agregar un proveedor" en ~1 semana en vez de ~3.**

Además: integración contra PostgreSQL real para la ingesta (patrón vigente), y la
serialización pedido-nuevo vs cancelación con **dos conexiones reales**, no mocks.

## 8. Orden de trabajo

1. Generalizar `NormalizedDeliveryOrder` + definir el contrato del adaptador.
2. **Arreglar el núcleo** (test primero — es dinero).
3. Mover Uber al núcleo; borrar `uber.orderIngestion.service.ts`.
4. Registro de adaptadores + el test que prohíbe los `if` por proveedor.
5. Suite de contrato compartida, corriendo contra Uber.
6. **Gating PREMIUM + MCP** (§8.1 y §8.2) — parte de ESTE trabajo, no un "después".
7. Deliverect al mismo contrato (sin prisa; nadie lo usa).
8. Rappi y DiDi entran ya sobre terreno firme.

Los pasos 1-6 son este trabajo. El 7 y el 8 son trabajos aparte, cada uno con su plan.

### 8.1 Gating — no es opcional ni posterior

Delivery directo es **PREMIUM** (decisión del founder, §3.1). Se compone con **AND**, según
`.claude/rules/feature-gating.md`:

- **Tier** — el `Feature` correspondiente, resuelto con `venueHasFeatureAccess` (NO con el
  resolver de módulos: cruzarlos falla en silencio porque casi todo prod está grandfathered).
- **Ajuste del venue** — el switch canónico vive en `avoqado-web-dashboard`, escribiendo el
  registro del server. Nunca sólo en la base de datos.
- **Permiso** — reusar `delivery-channels:*`, que ya existe.

Un 4xx debe decir **qué falta y cómo activarlo**; un 403 pelón obliga a cada cliente a
inventarse el texto. Y apagado se VE: punto de entrada visible con su estado, nunca
desaparecer en silencio.

### 8.2 MCP — en el mismo cambio

Regla dura del repo: una capacidad que no es alcanzable por el **customer MCP** (`src/mcp/`)
está incompleta. `delivery_channels` ya existe; al terminar esto debe reflejar los
proveedores directos y su estado de conexión. Cualquier tool nueva honra los invariantes de
`critical-warnings.md`: pesos 1:1, fechas venue-local, y confirm-gate en escrituras de
alto impacto.

## 9. Qué NO se hace (YAGNI)

- **No** se separan tablas por proveedor (§3.4).
- **No** se construye una capa de plugins cargables en runtime: cuatro adaptadores en el
  mismo repo, importados estáticamente. Un registro de plugins sin un quinto proveedor real
  es complejidad sin cliente.
- **No** se generaliza el sondeo (Rappi) hasta tener Rappi enfrente. El contrato deja el
  hueco (`fetchOrder` opcional); la implementación espera.
- **No** se toca el resto de la deuda de `Order.total` fuera de delivery. Está registrada
  aparte y merece su propio trabajo.

## 10. Riesgos

| Riesgo | Mitigación |
|---|---|
| El paso 3 es cirugía sobre código que ayer se verificó funcionando | Los 7 tests de integración de `ingestUberOrder` son la red: deben seguir en verde tras migrar al núcleo |
| Arreglar la propina cambia montos ya persistidos | Nadie usa Deliverect en prod (§3.2) y Uber aún no tiene pedidos reales: la ventana para hacerlo sin migración de datos es AHORA |
| DiDi puede no aprobar la integración directa | Deliverect queda como plan B para DiDi (§3.3) |
| Rappi tiene dominio por país | El contexto del adaptador lleva el país; el núcleo nunca arma URLs |
