# Promociones en el POS — Plan 3A (server: los 3 huecos de frontera)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los tres huecos del server que hoy impiden que Android e iOS puedan pintar y aplicar promociones — sin tocar el motor de
promociones, que ya está construido y probado.

**Architecture:** Todo es **aditivo**. Se agregan campos opcionales a dos respuestas que el POS ya consume
(`GET /mobile/venues/:venueId/settings` y `GET /mobile/venues/:venueId/promotions`) y se enseña al camino de venta rápida
(`createOrderWithItems`) a aceptar `promotionRef` delegando en `applyPromotionToOrder`, exactamente como ya lo hace el reducer de
`ADD_ITEMS`. Ningún campo existente se renombra ni se quita: versiones viejas de las apps siguen funcionando igual.

**Tech Stack:** Express + TypeScript · Prisma/PostgreSQL · Jest (`tests/unit`, prismaMock en `tests/__helpers__/setup.ts`).

**Spec:** `avoqado-android/docs/superpowers/specs/2026-08-15-promociones-pos-cliente-design.md` (§1.1, §1.2, §1.3, §2.6). El diseño de
producto del que hereda es `avoqado-server/docs/superpowers/specs/2026-08-12-promociones-en-el-pos-design.md`.

## Global Constraints

- **Nunca quitar ni renombrar un campo de una respuesta de API.** Las apps viejas dependen de ellos. Todo lo nuevo es opcional y con
  default. (regla cross-repo del workspace)
- **Dinero en PESOS, 1:1, salvo los campos que ya son `…Cents`.** `Promotion.priceCents`, `PromotionOption.priceDeltaCents` y el
  `productPriceCents` que se agrega aquí son centavos **internos** del contrato POS y se mantienen así por consistencia con lo ya publicado;
  `Product.price` es `Decimal` en pesos y se convierte con `Math.round(Number(price) * 100)`.
- **El cliente NUNCA manda precios de promoción.** `promotionRef` lleva qué promoción y qué eligió la persona; la aritmética la hace el
  server.
- **Permiso decidido por el founder (2026-08-15): `discounts:apply`.** No se crea `promotions:apply`.
- **Mensajes de error de Zod y de negocio en ESPAÑOL** (regla del repo: se muestran tal cual al usuario).
- **TDD obligatorio**: esto toca dinero y permisos. Test que falla primero, siempre.
- **Correr los tests así:** `npx jest <ruta-del-archivo> --runInBand`. La suite completa del repo es `npm run test:unit` (pesada; sólo al
  final).
- 🔴 **NO commitear hasta que el founder lo autorice explícitamente.** Los pasos de commit están escritos, pero se ejecutan sólo cuando él
  diga "commitea". Cuando se autoricen: `git add <rutas explícitas>`, nunca `git add -A` (árbol compartido con otras sesiones).
- **Sin migraciones de Prisma en este plan** → no aplica `npm run schema:map`.

---

## File Structure

| Archivo                                                            | Responsabilidad                                                 | Acción                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `src/controllers/mobile/tpvSettings.mobile.controller.ts`          | Sirve settings al POS; se le agrega el bloque `promotions`      | Modificar                                                  |
| `src/services/promotions/promotionCatalog.service.ts`              | Catálogo POS; se enriquecen las opciones                        | Modificar                                                  |
| `src/services/mobile/sync.mobile.service.ts`                       | Reducer offline; se le agrega el permiso condicional            | Modificar (`requiredPermissionsForIntent`)                 |
| `src/services/mobile/order.mobile.service.ts`                      | Venta rápida online; aprende `promotionRef`                     | Modificar (`CreateOrderItemInput`, `createOrderWithItems`) |
| `src/controllers/mobile/order.mobile.controller.ts`                | Valida el body de createOrder; debe dejar pasar líneas de promo | Modificar                                                  |
| `src/routes/mobile.routes.ts`                                      | Ruta de createOrder; permiso                                    | Modificar (1 línea)                                        |
| `tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts` | Task 1                                                          | Crear                                                      |
| `tests/unit/services/promotions/promotionCatalogCard.test.ts`      | Task 2                                                          | Crear                                                      |
| `tests/unit/services/syncPromotionPermission.test.ts`              | Task 3                                                          | Crear                                                      |
| `tests/unit/services/mobile/createOrderPromotion.test.ts`          | Task 4                                                          | Crear                                                      |

---

### Task 1: El POS recibe dónde va el panel

Hoy `GET /api/v1/mobile/venues/:venueId/settings` devuelve `{ terminals, settings, activeTerminalId, deviceTerminal, plan? }`.
`VenueSettings.promotionsPanelCashier` / `promotionsPanelCustomer` existen y el dashboard ya los escribe, pero nunca llegan al POS.

**Files:**

- Modify: `src/controllers/mobile/tpvSettings.mobile.controller.ts` (el `Promise.all` de arriba y el `res.json` final)
- Test: `tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts` (nuevo; patrón:
  `tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts`)

**Interfaces:**

- Consumes: nada de tasks previas.
- Produces: el bloque `promotions: { panelCashier: 'HIDDEN'|'TAB'|'SIDE_PANEL'; panelCustomer: 'HIDDEN'|'TAB'|'SIDE_PANEL' }` en la
  respuesta de settings. Los clientes (plan 3B) lo consumen.

- [ ] **Step 1: Leer el test existente para copiar su forma de montar el controller**

Abre `tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts` y fíjate cómo mockea `prisma` y cómo invoca el handler (req/res
falsos). El test nuevo usa **el mismo** andamiaje; no inventes otro.

- [ ] **Step 2: Escribir el test que falla**

Crea `tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts` con tres casos: valores del venue, defaults cuando no hay fila, y
resiliencia si la lectura truena.

```typescript
// El bloque `promotions` es lo que le dice al POS dónde pintar el panel.
// Sin él, el POS no puede honrar lo que el dueño configuró en el dashboard.
describe('GET /mobile/venues/:venueId/settings — bloque promotions', () => {
  it('devuelve los modos de panel configurados en el venue', async () => {
    // prismaMock: venueSettings.findUnique -> { promotionsPanelCashier: 'SIDE_PANEL', promotionsPanelCustomer: 'HIDDEN' }
    const body = await callGetVenueTpvSettings({ venueId: 'venue-1' })
    expect(body.data.promotions).toEqual({ panelCashier: 'SIDE_PANEL', panelCustomer: 'HIDDEN' })
  })

  it('cae a los defaults del diseño cuando el venue no tiene fila de settings', async () => {
    // prismaMock: venueSettings.findUnique -> null
    const body = await callGetVenueTpvSettings({ venueId: 'venue-sin-settings' })
    expect(body.data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
  })

  it('NO rompe el endpoint si la lectura de settings falla', async () => {
    // prismaMock: venueSettings.findUnique -> rejects(new Error('db caída'))
    const body = await callGetVenueTpvSettings({ venueId: 'venue-1' })
    // Mismo criterio que `plan`: el POS falla abierto, jamás se queda sin poder vender.
    expect(body.data.promotions).toEqual({ panelCashier: 'TAB', panelCustomer: 'SIDE_PANEL' })
    expect(body.data.terminals).toBeDefined()
  })
})
```

- [ ] **Step 3: Correr el test y verificar que FALLA**

Run: `npx jest tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts --runInBand` Expected: FAIL — `body.data.promotions` es
`undefined`.

- [ ] **Step 4: Implementar**

En `getVenueTpvSettings`, agrega la lectura al `Promise.all` existente (junto a `terminals` y `plan`), con el MISMO patrón resiliente que
`plan`:

```typescript
const [terminals, plan, venueSettings] = await Promise.all([
  prisma.terminal.findMany({
    /* ...igual que hoy, no tocar... */
  }),
  getVenuePlanInfo(venueId).catch((error): VenuePlanInfo | undefined => {
    logger.error('Failed to resolve plan info for mobile venue settings — returning settings without plan', { venueId, error })
    return undefined
  }),
  // Dónde pinta el POS el panel de promociones. Es preferencia de LAYOUT del
  // venue (VenueSettings), no configuración de terminal — por eso va en su
  // propio bloque y no dentro de `settings`, que es TpvSettings por terminal.
  prisma.venueSettings
    .findUnique({ where: { venueId }, select: { promotionsPanelCashier: true, promotionsPanelCustomer: true } })
    .catch(error => {
      logger.error('Failed to resolve promotions panel settings — returning defaults', { venueId, error })
      return null
    }),
])
```

Y en el `res.json({ success: true, data: { ... } })` final, agrega el bloque **sin tocar los campos existentes**:

```typescript
        // Aditivo y opcional (mismo contrato que `plan`): un POS viejo lo
        // ignora, uno nuevo sin este campo cae a estos mismos defaults.
        promotions: {
          panelCashier: venueSettings?.promotionsPanelCashier ?? 'TAB',
          panelCustomer: venueSettings?.promotionsPanelCustomer ?? 'SIDE_PANEL',
        },
```

- [ ] **Step 5: Correr el test y verificar que PASA**

Run: `npx jest tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts --runInBand` Expected: PASS (3/3).

- [ ] **Step 6: No romper lo que ya existía**

Run: `npx jest tests/unit/controllers/mobile/tpvSettings.mobile.controller.test.ts --runInBand` Expected: PASS. Si algo falla aquí, rompiste
un campo que las apps ya consumen — arréglalo antes de seguir.

- [ ] **Step 7: Commit** (sólo si el founder ya autorizó commits)

```bash
git add src/controllers/mobile/tpvSettings.mobile.controller.ts tests/unit/controllers/mobile/tpvSettingsPromotionsPanel.test.ts
git commit -m "feat(mobile): servir los modos del panel de promociones al POS"
```

---

### Task 2: La tarjeta del panel puede pintarse sin adivinar

Hoy cada opción del catálogo llega como `{ id, productId, priceDeltaCents }`. Con eso el POS **no** puede escribir "entran 2, pagas 1" ni
mostrar qué caerá al carrito.

**Files:**

- Modify: `src/services/promotions/promotionCatalog.service.ts` (interface `PromotionCard`, el `include` de la query, y `toCard`)
- Test: `tests/unit/services/promotions/promotionCatalogCard.test.ts` (nuevo; patrón:
  `tests/unit/services/promotions/promotionCatalog.test.ts`)

**Interfaces:**

- Consumes: nada de tasks previas.
- Produces: `PromotionCard['groups'][number]['options'][number]` pasa a ser
  `{ id: string; productId: string; priceDeltaCents: number; quantity: number; chargedQuantity: number; productName: string; productPriceCents: number }`.
  El plan 3B (POS) lee `quantity`/`chargedQuantity` para el gancho "2x1" y `productName`/`productPriceCents` para la tarjeta y el estimado
  local.

- [ ] **Step 1: Escribir el test que falla**

Crea `tests/unit/services/promotions/promotionCatalogCard.test.ts`:

```typescript
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'

// El POS pinta la tarjeta con ESTO. Sin quantity/chargedQuantity no hay forma
// de escribir "2x1"; sin nombre/precio la tarjeta sale vacía cuando el producto
// no está en la página del catálogo que el POS tiene cacheada.
describe('listPromotionsForPos — la tarjeta trae lo necesario para pintarse', () => {
  it('incluye cantidades y datos del producto en cada opción', async () => {
    // prismaMock: venue.findUnique -> { timezone: 'America/Mexico_City' }
    // prismaMock: promotion.findMany -> [{
    //   id: 'promo-1', name: '2x1 Cerveza', description: null, imageUrl: null,
    //   type: 'BUNDLE', pricingMode: 'PER_UNIT', priceCents: 0, displayOrder: 0,
    //   validFrom: null, validUntil: null, daysOfWeek: [], timeFrom: null, timeUntil: null,
    //   groups: [{ id: 'g1', name: 'Bebida', displayOrder: 0, options: [{
    //     id: 'o1', productId: 'p1', priceDeltaCents: 0, quantity: 2, chargedQuantity: 1,
    //     product: { name: 'Cerveza Corona', price: new Prisma.Decimal('65.00') },
    //   }] }],
    // }]
    const { active } = await listPromotionsForPos('venue-1')

    expect(active[0].groups[0].options[0]).toEqual({
      id: 'o1',
      productId: 'p1',
      priceDeltaCents: 0,
      quantity: 2,
      chargedQuantity: 1,
      productName: 'Cerveza Corona',
      productPriceCents: 6500, // Decimal de PESOS -> centavos, al centavo
    })
  })

  it('no se cae si la opción viene sin producto cargado', async () => {
    // prismaMock igual pero con `product: null` en la opción.
    // Un producto borrado no puede dejar al cajero sin panel: la tarjeta se
    // pinta con lo que hay.
    const { active } = await listPromotionsForPos('venue-1')
    expect(active[0].groups[0].options[0].productName).toBe('')
    expect(active[0].groups[0].options[0].productPriceCents).toBe(0)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que FALLA**

Run: `npx jest tests/unit/services/promotions/promotionCatalogCard.test.ts --runInBand` Expected: FAIL — las opciones no traen `quantity` ni
`productName`.

- [ ] **Step 3: Ampliar la interface**

En `promotionCatalog.service.ts`, reemplaza la línea de `groups` en `PromotionCard`:

```typescript
groups: Array<{
  id: string
  name: string
  options: Array<{
    id: string
    productId: string
    priceDeltaCents: number
    /** Unidades que ENTRAN al carrito (2 en un 2x1). El POS las necesita para el gancho y el preview. */
    quantity: number
    /** Unidades que se COBRAN (1 en un 2x1). */
    chargedQuantity: number
    /** Denormalizados para que la tarjeta se pinte sin cruzar el catálogo local. */
    productName: string
    /** Precio de lista en CENTAVOS. Sólo para el estimado que se muestra; el precio real lo calcula el server al aplicar. */
    productPriceCents: number
  }>
}>
```

- [ ] **Step 4: Traer el producto en la query**

En `listPromotionsForPos`, cambia el `include` de la query (única línea que se toca):

```typescript
    include: {
      groups: {
        include: { options: { include: { product: { select: { name: true, price: true } } } } },
        orderBy: { displayOrder: 'asc' },
      },
    },
```

- [ ] **Step 5: Mapear en `toCard`**

Reemplaza el `.map` de opciones dentro de `toCard`:

```typescript
      options: (g.options ?? []).map((o: any) => ({
        id: o.id,
        productId: o.productId,
        priceDeltaCents: o.priceDeltaCents,
        quantity: o.quantity,
        chargedQuantity: o.chargedQuantity,
        // Un producto borrado NO puede dejar al cajero sin panel.
        productName: o.product?.name ?? '',
        // Product.price es Decimal en PESOS -> centavos del contrato POS.
        productPriceCents: o.product?.price != null ? Math.round(Number(o.product.price) * 100) : 0,
      })),
```

- [ ] **Step 6: Correr el test y verificar que PASA**

Run: `npx jest tests/unit/services/promotions/promotionCatalogCard.test.ts --runInBand` Expected: PASS (2/2).

- [ ] **Step 7: No romper el catálogo existente**

Run: `npx jest tests/unit/services/promotions/promotionCatalog.test.ts --runInBand` Expected: PASS. Ese test cubre la ventana de "próximas 4
horas" y el orden — nada de eso cambió.

- [ ] **Step 8: Commit** (sólo con autorización)

```bash
git add src/services/promotions/promotionCatalog.service.ts tests/unit/services/promotions/promotionCatalogCard.test.ts
git commit -m "feat(promotions): el catálogo del POS trae cantidades y datos del producto"
```

---

### Task 3: Aplicar una promoción exige permiso (camino offline)

**Este es el hallazgo P1 de la auditoría.** Aplicar una promoción regala mercancía; hoy el reducer sólo exige `orders:create` para
`ADD_ITEMS`, que tiene cualquier mesero. Es exactamente el agujero que ya mordió con `isCortesia` evadiendo `orders:comp` (arreglado en
`0778d35d`) — y la solución vive en el mismo lugar y con el mismo patrón.

**Files:**

- Modify: `src/services/mobile/sync.mobile.service.ts` (`requiredPermissionsForIntent`, ~línea 180)
- Test: `tests/unit/services/syncPromotionPermission.test.ts` (nuevo; patrón: `tests/unit/services/syncPromotionRef.test.ts`)

**Interfaces:**

- Consumes: nada.
- Produces: `requiredPermissionsForIntent(intent)` devuelve `['orders:create', 'discounts:apply']` cuando el `ADD_ITEMS` trae al menos un
  item con `promotionRef`.

- [ ] **Step 1: Escribir el test que falla**

Crea `tests/unit/services/syncPromotionPermission.test.ts`:

```typescript
import { requiredPermissionsForIntent } from '@/services/mobile/sync.mobile.service'

// Aplicar una promoción REGALA mercancía: mismo riesgo que aplicar un descuento
// (`discounts:apply`) o una cortesía (`orders:comp`). Sin esto, un ADD_ITEMS
// con promotionRef pasa con `orders:create`, que tiene cualquier mesero — la
// puerta cerrada y la ventana abierta, otra vez.
describe('requiredPermissionsForIntent — promociones dentro de ADD_ITEMS', () => {
  const intent = (items: any[]) => ({ id: 'i1', type: 'ADD_ITEMS', payload: { orderId: 'o1', items } }) as any

  it('exige discounts:apply cuando un item trae promotionRef', () => {
    const permisos = requiredPermissionsForIntent(
      intent([{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }]),
    )
    expect(permisos).toContain('orders:create')
    expect(permisos).toContain('discounts:apply')
  })

  it('NO lo exige en una ronda normal', () => {
    const permisos = requiredPermissionsForIntent(intent([{ productId: 'p1', quantity: 1 }]))
    expect(permisos).toEqual(['orders:create'])
  })

  it('lo exige una sola vez aunque la ronda traiga varias promociones', () => {
    const permisos = requiredPermissionsForIntent(
      intent([
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
        { promotionRef: { promotionId: 'promo-2', promotionInstanceId: 'uuid-2', selections: [] } },
      ]),
    )
    expect(permisos.filter(p => p === 'discounts:apply')).toHaveLength(1)
  })

  it('acumula con la cortesía cuando la ronda trae las dos cosas', () => {
    const permisos = requiredPermissionsForIntent(
      intent([
        { productId: 'p1', quantity: 1, isCortesia: true },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
      ]),
    )
    expect(permisos).toEqual(expect.arrayContaining(['orders:create', 'orders:comp', 'discounts:apply']))
  })
})
```

- [ ] **Step 2: Correr el test y verificar que FALLA**

Run: `npx jest tests/unit/services/syncPromotionPermission.test.ts --runInBand` Expected: FAIL — el primer caso devuelve sólo
`['orders:create']`.

- [ ] **Step 3: Implementar**

En `requiredPermissionsForIntent`, dentro del `if (intent.type === 'ADD_ITEMS')` que ya existe, agrega debajo del bloque de `isCortesia`:

```typescript
// Aplicar una promoción regala mercancía: mismo permiso que aplicar un
// descuento online (decisión del founder 2026-08-15 — se reusa
// `discounts:apply`, no se crea uno nuevo). Sin esto, el ADD_ITEMS con
// promotionRef pasaría con `orders:create`, que tiene cualquier mesero:
// el mismo hueco que la cortesía de arriba.
if (items.some(item => item?.promotionRef)) {
  permissions.push('discounts:apply')
}
```

- [ ] **Step 4: Correr el test y verificar que PASA**

Run: `npx jest tests/unit/services/syncPromotionPermission.test.ts --runInBand` Expected: PASS (4/4).

- [ ] **Step 5: No romper el reducer**

Run: `npx jest tests/unit/services/syncPromotionRef.test.ts tests/unit/services/sync.mobile.service.test.ts --runInBand` Expected: PASS. ⚠️
Si algún test existente montaba un `ADD_ITEMS` con `promotionRef` usando un staff **sin** `discounts:apply`, ahora será rechazado — y eso es
el comportamiento correcto: actualiza el test para darle el permiso al staff de prueba, no quites el guard.

- [ ] **Step 6: Commit** (sólo con autorización)

```bash
git add src/services/mobile/sync.mobile.service.ts tests/unit/services/syncPromotionPermission.test.ts
git commit -m "fix(sync): aplicar una promoción exige discounts:apply, como la cortesía exige orders:comp"
```

---

### Task 4: La venta rápida puede aplicar promociones (camino online)

Es el hueco que define este plan: el cliente que pidió la feature hace autoservicio, o sea venta rápida. `createOrderWithItems` **ya
recalcula el subtotal desde el catálogo e ignora los totales que manda el cliente**, así que el server ya es la autoridad del precio aquí —
sólo falta que sepa de promociones.

**Files:**

- Modify: `src/services/mobile/order.mobile.service.ts` (`CreateOrderItemInput`, `buildOrderItemsData`, `createOrderWithItems`)
- Modify: `src/controllers/mobile/order.mobile.controller.ts` (la validación de items, ~línea 82)
- Modify: `src/routes/mobile.routes.ts:582` (permiso de la ruta)
- Test: `tests/unit/services/mobile/createOrderPromotion.test.ts` (nuevo; patrón: `tests/unit/services/mobile/order.mobile.service.test.ts`)

**Interfaces:**

- Consumes: `applyPromotionToOrder({ venueId, orderId, promotionId, instanceId, selections, soldAt })` de
  `@/services/promotions/promotion.service` (ya existe, devuelve `{ orderPromotionId, netCents, created }`), y `clampSoldAt` de
  `@/services/mobile/sync.mobile.service`.
- Produces: `CreateOrderItemInput` acepta
  `promotionRef?: { promotionId: string; promotionInstanceId: string; selections: Array<{ groupId: string; optionId: string }> }`. El plan
  3B (POS) manda eso al cobrar en venta rápida.

- [ ] **Step 1: Escribir el test que falla**

Crea `tests/unit/services/mobile/createOrderPromotion.test.ts`:

```typescript
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'

// La venta rápida es el caso del cliente de autoservicio. Sin esto, tocar una
// promoción en el carrito y cobrar la cobraría a precio de lista.
describe('createOrderWithItems — líneas de promoción', () => {
  it('delega la promoción en applyPromotionToOrder y NO la da de alta como línea normal', async () => {
    const apply = jest.spyOn(promotionService, 'applyPromotionToOrder').mockResolvedValue({
      orderPromotionId: 'op-1',
      netCents: 6500,
      created: true,
    })

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 1 },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [{ groupId: 'g1', optionId: 'o1' }] } },
      ],
    } as any)

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        promotionId: 'promo-1',
        instanceId: 'uuid-1',
        selections: [{ groupId: 'g1', optionId: 'o1' }],
      }),
    )
    // La línea de promo NO pasa por el alta normal: su precio lo pone el motor.
    // Se verifica sobre lo que se mandó a crear: una sola línea, la del producto
    // suelto. (prismaMock intercepta order.create — mismo andamiaje que
    // order.mobile.service.test.ts.)
    const createArgs = (prismaMock.order.create as jest.Mock).mock.calls[0][0]
    expect(createArgs.data.items.create).toHaveLength(1)
    expect(createArgs.data.items.create[0]).toEqual(expect.objectContaining({ productId: 'p1' }))
  })

  it('una orden de PURAS promociones se crea igual (sin items normales)', async () => {
    // buildOrderItemsData exige al menos un item; una venta que es sólo un combo
    // es legítima y no puede tronar con "At least one item is required".
    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }],
    } as any)
    expect(result.id).toBeDefined()
  })

  it('es idempotente: el mismo promotionInstanceId no cobra el combo dos veces', async () => {
    // applyPromotionToOrder ya deduplica por (orderId, instanceId) devolviendo
    // created:false. Aquí se verifica que createOrderWithItems no lo llame dos
    // veces por el mismo instanceId dentro de la misma orden.
    const apply = jest.spyOn(promotionService, 'applyPromotionToOrder').mockResolvedValue({
      orderPromotionId: 'op-1',
      netCents: 6500,
      created: false,
    })
    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
      ],
    } as any)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que FALLA**

Run: `npx jest tests/unit/services/mobile/createOrderPromotion.test.ts --runInBand` Expected: FAIL — hoy `promotionRef` se ignora y el item
se trata como línea normal (o truena la validación).

- [ ] **Step 3: Ampliar el tipo de entrada**

En `src/services/mobile/order.mobile.service.ts`, en `CreateOrderItemInput`, agrega:

```typescript
  /**
   * Promoción tocada en el POS. OPCIONAL y sin precios: lleva QUÉ promoción y
   * QUÉ eligió la persona; la aritmética la hace el server (mismo contrato que
   * `items[].promotionRef` del reducer de ADD_ITEMS — deben permanecer iguales).
   */
  promotionRef?: {
    promotionId: string
    promotionInstanceId: string
    selections: Array<{ groupId: string; optionId: string }>
  }
```

- [ ] **Step 4: Separar las líneas de promoción del alta normal**

En `createOrderWithItems`, ANTES de la llamada a `buildOrderItemsData`, parte los items y deduplica por instancia:

```typescript
// Los items con `promotionRef` NO pasan por el alta normal: su precio lo
// resuelve el motor de promociones (espejo exacto de applyAddItems en
// sync.mobile.service.ts). Un item sin promotionRef se comporta igual que hoy.
const itemsConPromocion = input.items.filter(it => it.promotionRef)
const itemsNormales = input.items.filter(it => !it.promotionRef)

// Dedupe defensivo por instancia: dos líneas con el mismo instanceId son la
// MISMA promoción (un doble tap del cajero), no dos combos.
const promocionesUnicas = [...new Map(itemsConPromocion.map(it => [it.promotionRef!.promotionInstanceId, it.promotionRef!])).values()]
```

Cambia la llamada existente para que use `itemsNormales`:

```typescript
const { itemsData, subtotal, itemDiscountTotal, discounts } = await buildOrderItemsData(venueId, itemsNormales)
```

🔴 **`buildOrderItemsData` lanza `BadRequestError('At least one item is required')` con lista vacía.** Una venta de puras promociones es
legítima, así que sáltala cuando no haya líneas normales:

```typescript
const { itemsData, subtotal, itemDiscountTotal, discounts } =
  itemsNormales.length > 0
    ? await buildOrderItemsData(venueId, itemsNormales)
    : { itemsData: [] as any[], subtotal: 0, itemDiscountTotal: 0, discounts: [] as Array<{ id: string; [key: string]: any }> }
```

Y valida arriba de todo que la orden traiga ALGO:

```typescript
if (input.items.length === 0) {
  throw new BadRequestError('Se requiere al menos un artículo o una promoción')
}
```

- [ ] **Step 5: Aplicar las promociones después de crear la orden**

Justo DESPUÉS del `prisma.$transaction` que crea la orden y sus líneas (donde ya tienes `order` con id), y ANTES del `return`:

```typescript
// Las promociones se aplican sobre la orden ya creada, con el MISMO servicio
// transaccional que usa el reducer offline: crea sus líneas, reparte el
// descuento al centavo y RECALCULA los totales de la orden.
if (promocionesUnicas.length > 0) {
  for (const ref of promocionesUnicas) {
    await applyPromotionToOrder({
      venueId,
      orderId: order.id,
      promotionId: ref.promotionId,
      instanceId: ref.promotionInstanceId,
      selections: ref.selections,
      // Venta EN LÍNEA: el instante es ahora. El acotado de reloj
      // (clampSoldAt) es del camino offline, donde el cliente propone la hora.
      soldAt: new Date(),
    })
  }
  // Los totales cambiaron dentro de applyPromotionToOrder — se relee la orden
  // para no devolverle al POS un total viejo (el POS lo muestra al cobrar).
  order = (await prisma.order.findUnique({ where: { id: order.id }, include: createdOrderInclude }))!
}
```

Agrega el import arriba del archivo:

```typescript
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'
```

⚠️ Si `order` está declarada con `const`, cámbiala a `let` para poder reasignarla tras la relectura.

- [ ] **Step 6: Correr el test y verificar que PASA**

Run: `npx jest tests/unit/services/mobile/createOrderPromotion.test.ts --runInBand` Expected: PASS (3/3).

- [ ] **Step 7: Dejar pasar las líneas de promoción por la validación del controller**

En `src/controllers/mobile/order.mobile.controller.ts`, la validación de items exige `productId` o línea custom. Una línea de promoción no
trae ninguno de los dos y hoy sería rechazada con 400. Agrega la excepción **antes** de esa validación:

```typescript
// Una línea de promoción no trae productId ni precio: trae qué promoción
// tocó el cajero. El server resuelve sus líneas.
const esLineaDePromocion = (item: any) => !!item?.promotionRef?.promotionId && !!item?.promotionRef?.promotionInstanceId
```

y en el loop de validación, salta el item cuando `esLineaDePromocion(item)` sea true.

- [ ] **Step 8: Exigir el permiso en la ruta online**

En `src/routes/mobile.routes.ts:582`, la ruta de crear orden pide `checkPermission('orders:create')`. El permiso de promoción depende del
**body**, así que va con el mismo patrón condicional que el reducer — un middleware chico justo antes del controller:

```typescript
// Aplicar una promoción regala mercancía: exige `discounts:apply`, igual que el
// reducer offline (sync.mobile.service.ts requiredPermissionsForIntent). Sin
// esto, el camino ONLINE sería la puerta de atrás del guard de la Task 3.
const checkPromotionPermissionIfPresent = (req: Request, res: Response, next: NextFunction) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (items.some((item: any) => item?.promotionRef)) {
    return checkPermission('discounts:apply')(req, res, next)
  }
  return next()
}

router.post(
  '/venues/:venueId/orders',
  authenticateTokenMiddleware,
  checkPermission('orders:create'),
  checkPromotionPermissionIfPresent,
  orderMobileController.createOrder,
)
```

- [ ] **Step 9: Verificar que no rompiste la venta rápida de siempre**

Run: `npx jest tests/unit/services/mobile/order.mobile.service.test.ts tests/unit/controllers/mobile --runInBand` Expected: PASS. Una orden
sin `promotionRef` debe comportarse EXACTAMENTE igual que antes.

- [ ] **Step 10: Typecheck del repo**

Run: `npm run build` Expected: sin errores. (jest es transpile-only y no atrapa errores de tipo — regla del repo: `tsc` después de los
tests. Si `npx tsc --noEmit` revienta por memoria, `npm run build` es el camino.)

- [ ] **Step 11: Commit** (sólo con autorización)

```bash
git add src/services/mobile/order.mobile.service.ts src/controllers/mobile/order.mobile.controller.ts src/routes/mobile.routes.ts tests/unit/services/mobile/createOrderPromotion.test.ts
git commit -m "feat(mobile): la venta rápida puede aplicar promociones (mismo motor que el reducer)"
```

---

## Cierre del plan

- [ ] **Suite completa del repo**

Run: `npm run test:unit` Expected: verde. Es pesada (~minutos) — la máquina está compartida con otras sesiones, así que puede tardar; **no
la canceles**, súbele el timeout. Si aparecen fallas en archivos que este plan no tocó, verifica con `git diff <archivo>` si el cambio es
tuyo: si no lo es, es WIP de otra sesión — anótalo en el reporte y sigue.

- [ ] **Reportar al founder:** qué quedó, qué tests corrieron, y que el plan 3B (Android + iOS) es lo que sigue.

## Lo que este plan NO hace

- No toca el motor de promociones (`applyPromotionToOrder`, `resolvePromotionLines`, prorrata, retiro por instancia): ya está construido y
  probado.
- No toca el MCP: el ciclo de vida y la edición están excluidos a propósito (documentado en `src/mcp/tools/promotions.ts`).
- No toca la presentación de ventas: se actualiza al cerrar el plan 3B, cuando la capacidad ya es visible para el cliente.
- No incluye Android ni iOS — eso es el plan 3B, que depende de las Tasks 1, 2 y 4 de aquí.
