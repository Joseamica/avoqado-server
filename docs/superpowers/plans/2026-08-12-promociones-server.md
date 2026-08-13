# Promociones en el POS — Plan de implementación (1 de 3: server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el server sepa resolver una promoción a líneas de venta con precios netos exactos al centavo, aplicarla y retirarla de una
orden de forma transaccional, y exponerla al POS y al MCP.

**Architecture:** El corazón es una **decisión pura** (`resolvePromotionLines`) que convierte "esta promoción con estas opciones" en líneas
con su bruto, su descuento y su neto — sin Prisma, sin red, probable sola. Todo lo demás es plomería alrededor: un modelo que guarda la
definición, un servicio transaccional que escribe la instancia vendida, y rutas que la exponen. El POS nunca manda precios; manda **qué
promoción y qué eligió la persona**, y el server hace la aritmética.

**Tech Stack:** TypeScript · Express · Prisma/PostgreSQL · Jest (unit, con el mock global de `prisma`)

## Global Constraints

- **Alcance de este plan: SOLO avoqado-server.** El dashboard (plan 2) y Android+iOS (plan 3) van después, sobre el contrato que este plan
  crea.
- **Rama: `develop`.** El merge a `main` lo hace el founder.
- **Ruta de dinero y de stock: TDD obligatorio.** No negociable.
- **Aditivo:** ninguna respuesta de API cambia de forma; ningún campo se renombra ni se quita. `promotionRef` en `ADD_ITEMS` es OPCIONAL —
  un cliente que no lo mande se comporta EXACTAMENTE igual que hoy.
- **Tier:** código `PROMOTIONS`, PRO. Nombre EXACTO, espejado después en dashboard, Android e iOS.
- **Los 14 tipos de `SyncIntentType` NO cambian.** No se agrega ninguno.
- **Vigencia:** se usa `isWithinVenueSchedule` de `src/utils/datetime.ts`. **No se escribe otro evaluador de horarios.**
- **Prorrata:** se usa `allocateByWeights` de `src/services/fiscal/ivaMath.ts`. **No se escribe otro repartidor de centavos.**
- **Las promociones NUNCA tocan `Order.taxAmount`.**
- Spec de referencia: `docs/superpowers/specs/2026-08-12-promociones-en-el-pos-design.md`

---

## File Structure

| Archivo                                                           | Responsabilidad                                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/promotions/resolvePromotionLines.ts` _(nuevo)_      | **Decisión pura**: promoción + opciones → líneas con bruto, descuento y neto. Sin Prisma. Aquí vive toda la corrección del dinero. |
| `src/services/promotions/validatePromotion.ts` _(nuevo)_          | **Decisión pura**: ¿esta promoción se puede publicar? Consistencia tipo/estructura, rangos, tenant.                                |
| `src/services/promotions/promotion.service.ts` _(nuevo)_          | Aplicar y retirar una promoción de una orden, en transacción. Usa las dos puras.                                                   |
| `src/services/promotions/promotionCatalog.service.ts` _(nuevo)_   | Qué promociones están vigentes (y cuáles vienen) para un venue, usando `isWithinVenueSchedule`.                                    |
| `prisma/schema.prisma` _(modificar)_                              | Modelos `Promotion`, `PromotionGroup`, `PromotionOption`, `OrderPromotion`; `orderPromotionId` en `OrderItem`.                     |
| `src/services/mobile/sync.mobile.service.ts` _(modificar)_        | `promotionRef` opcional en `ADD_ITEMS` + ventana acotada offline.                                                                  |
| `src/services/dashboard/discountEngine.service.ts` _(modificar)_  | La base de los descuentos automáticos excluye líneas con `orderPromotionId`.                                                       |
| `src/controllers/mobile/promotion.mobile.controller.ts` _(nuevo)_ | `GET /mobile/venues/:venueId/promotions`.                                                                                          |
| `src/mcp/tools/promotions.ts` _(nuevo)_                           | `list_promotions`, `create_promotion`, `promotion_status`.                                                                         |

---

## Task 1: La decisión pura — de promoción a líneas con centavos exactos

**Files:**

- Create: `src/services/promotions/resolvePromotionLines.ts`
- Test: `tests/unit/services/promotions/resolvePromotionLines.test.ts`

**Interfaces:**

- Consumes: `allocateByWeights` de `@/services/fiscal/ivaMath`
- Produces: `resolvePromotionLines(input: PromotionPricingInput): ResolvedPromotion` — usada por Task 4 y Task 10. Tipos exactos abajo.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/resolvePromotionLines.test.ts
import { resolvePromotionLines } from '@/services/promotions/resolvePromotionLines'

const opcion = (over: Partial<Parameters<typeof resolvePromotionLines>[0]['selections'][0]> = {}) => ({
  productId: 'p1',
  quantity: 1,
  chargedQuantity: 1,
  priceDeltaCents: 0,
  listPriceCents: 10000,
  ...over,
})

describe('resolvePromotionLines — el dinero de una promoción, al centavo', () => {
  describe('FIXED_TOTAL: el combo cuesta lo que dice', () => {
    it('las líneas suman EXACTAMENTE el precio de la promoción', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [
          opcion({ productId: 'hamburguesa', listPriceCents: 8000 }),
          opcion({ productId: 'papas', listPriceCents: 4000 }),
          opcion({ productId: 'refresco', listPriceCents: 2000 }),
        ],
      })

      expect(r.netCents).toBe(9900)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(9900)
    })

    it('🔴 $100 entre 3 productos no pierde ni inventa un centavo', () => {
      // El reparto ingenuo da 33.33+33.33+33.33 = 99.99. Falta un centavo.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [
          opcion({ productId: 'a', listPriceCents: 5000 }),
          opcion({ productId: 'b', listPriceCents: 5000 }),
          opcion({ productId: 'c', listPriceCents: 5000 }),
        ],
      })

      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
      expect(r.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(r.discountCents)
    })

    it('el descuento se reparte PROPORCIONAL al bruto, no en partes iguales', () => {
      // 🔴 Partes iguales le movería la base gravable a un producto 0% frente
      // a uno 16%. Bruto 140 → neto 100 → descuento 40, o sea 28.57% de cada uno.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [
          opcion({ productId: 'a', listPriceCents: 8000 }),
          opcion({ productId: 'b', listPriceCents: 4000 }),
          opcion({ productId: 'c', listPriceCents: 2000 }),
        ],
      })

      expect(r.lines.map(l => l.totalCents)).toEqual([5714, 2857, 1429])
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
    })

    it('el priceDelta de la opción elegida sube el precio de la promoción', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [
          opcion({ productId: 'pollo', listPriceCents: 9000, priceDeltaCents: 1500 }),
          opcion({ productId: 'papas', listPriceCents: 4000 }),
        ],
      })

      expect(r.netCents).toBe(11400)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(11400)
    })

    it('cada línea conserva su precio BRUTO de catálogo', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 9900,
        selections: [opcion({ productId: 'a', listPriceCents: 8000 }), opcion({ productId: 'b', listPriceCents: 4000 })],
      })

      expect(r.lines.map(l => l.unitPriceCents)).toEqual([8000, 4000])
      expect(r.grossCents).toBe(12000)
    })
  })

  describe('PER_UNIT: el 2x1', () => {
    it('entran 2 unidades y se cobra 1', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 2, chargedQuantity: 1, listPriceCents: 5000 })],
      })

      expect(r.lines).toHaveLength(1)
      expect(r.lines[0].quantity).toBe(2) // 🔴 el inventario descuenta por aquí
      expect(r.lines[0].unitPriceCents).toBe(5000)
      expect(r.lines[0].discountCents).toBe(5000)
      expect(r.lines[0].totalCents).toBe(5000)
      expect(r.netCents).toBe(5000)
    })

    it('un 3x2 cobra dos de tres', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 3, chargedQuantity: 2, listPriceCents: 5000 })],
      })

      expect(r.lines[0].quantity).toBe(3)
      expect(r.netCents).toBe(10000)
    })

    it('en PER_UNIT el priceDelta se ignora — el precio ya sale del producto', () => {
      const r = resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: [opcion({ productId: 'cerveza', quantity: 2, chargedQuantity: 1, listPriceCents: 5000, priceDeltaCents: 3000 })],
      })

      expect(r.netCents).toBe(5000)
    })
  })

  describe('bordes que protegen al local', () => {
    it('una promoción más cara que el catálogo no genera descuento negativo', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 15000,
        selections: [opcion({ productId: 'a', listPriceCents: 10000 })],
      })

      expect(r.discountCents).toBe(0)
      expect(r.netCents).toBe(10000) // nunca se cobra MÁS que el catálogo
    })

    it('sin opciones no hay promoción que resolver', () => {
      const r = resolvePromotionLines({ pricingMode: 'FIXED_TOTAL', priceCents: 9900, selections: [] })

      expect(r.lines).toEqual([])
      expect(r.netCents).toBe(0)
      expect(r.discountCents).toBe(0)
    })

    it('una promoción gratis deja todas las líneas en cero', () => {
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 0,
        selections: [opcion({ productId: 'a', listPriceCents: 8000 }), opcion({ productId: 'b', listPriceCents: 4000 })],
      })

      expect(r.netCents).toBe(0)
      expect(r.lines.every(l => l.totalCents === 0)).toBe(true)
    })

    it('dos opciones del MISMO producto se mantienen como líneas separadas', () => {
      // No se fusionan: cada opción es un renglón de la promoción y su
      // prorrata se calcula por separado.
      const r = resolvePromotionLines({
        pricingMode: 'FIXED_TOTAL',
        priceCents: 10000,
        selections: [opcion({ productId: 'a', listPriceCents: 6000 }), opcion({ productId: 'a', listPriceCents: 6000 })],
      })

      expect(r.lines).toHaveLength(2)
      expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(10000)
    })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/resolvePromotionLines.test.ts` Expected: FAIL —
`Cannot find module '@/services/promotions/resolvePromotionLines'`

- [ ] **Step 3: Escribir la implementación**

```typescript
// src/services/promotions/resolvePromotionLines.ts
import { allocateByWeights } from '@/services/fiscal/ivaMath'

/** Una opción ya elegida, con el precio de catálogo del producto congelado. */
export interface PromotionOptionSnapshot {
  productId: string
  /** Unidades que ENTRAN al carrito. El inventario descuenta por aquí. */
  quantity: number
  /** Unidades que se COBRAN. En un 2x1: quantity 2, chargedQuantity 1. */
  chargedQuantity: number
  /** Sobreprecio de esta opción, en centavos. Sólo se usa en FIXED_TOTAL. */
  priceDeltaCents: number
  /** Precio de lista del producto, en centavos. */
  listPriceCents: number
}

export interface PromotionPricingInput {
  pricingMode: 'FIXED_TOTAL' | 'PER_UNIT'
  /** Precio base de la promoción, en centavos. Sólo se usa en FIXED_TOTAL. */
  priceCents: number
  selections: PromotionOptionSnapshot[]
}

export interface ResolvedPromotionLine {
  productId: string
  quantity: number
  /** Precio de lista unitario. La línea SIEMPRE conserva su bruto de catálogo. */
  unitPriceCents: number
  /** Lo que se le descuenta a esta línea. */
  discountCents: number
  /** unitPriceCents × quantity − discountCents */
  totalCents: number
}

export interface ResolvedPromotion {
  lines: ResolvedPromotionLine[]
  grossCents: number
  discountCents: number
  netCents: number
}

/**
 * Convierte una promoción y lo que la persona eligió en líneas de venta.
 *
 * 🔑 Cada línea conserva su precio BRUTO de catálogo y carga su parte del
 * descuento. Nunca se inventa un "precio promocional" por unidad: si se
 * hiciera, el regalo dejaría de ser visible como regalo (nadie podría reportar
 * cuánto se regaló en promociones) y el precio de venta del producto quedaría
 * sucio en los reportes.
 *
 * 🔴 El descuento se reparte PROPORCIONAL al bruto, no en partes iguales.
 * Partes iguales le movería la base gravable a un producto 0% frente a uno
 * 16%. `allocateByWeights` garantiza que las partes sumen el total EXACTO.
 */
export function resolvePromotionLines(input: PromotionPricingInput): ResolvedPromotion {
  const { pricingMode, priceCents, selections } = input

  if (selections.length === 0) {
    return { lines: [], grossCents: 0, discountCents: 0, netCents: 0 }
  }

  const grossPerLine = selections.map(s => s.listPriceCents * s.quantity)
  const grossCents = grossPerLine.reduce((a, b) => a + b, 0)

  // Cuánto DEBE cobrar la promoción.
  const targetNet =
    pricingMode === 'FIXED_TOTAL'
      ? priceCents + selections.reduce((sum, s) => sum + s.priceDeltaCents, 0)
      : selections.reduce((sum, s) => sum + s.listPriceCents * s.chargedQuantity, 0)

  // Una promoción no puede cobrar MÁS que el catálogo: si alguien la configura
  // por encima, se cobra el catálogo y no se genera un descuento negativo.
  const discountCents = Math.max(0, grossCents - targetNet)
  const shares = allocateByWeights(discountCents, grossPerLine)

  const lines: ResolvedPromotionLine[] = selections.map((s, i) => ({
    productId: s.productId,
    quantity: s.quantity,
    unitPriceCents: s.listPriceCents,
    discountCents: shares[i],
    totalCents: grossPerLine[i] - shares[i],
  }))

  return {
    lines,
    grossCents,
    discountCents,
    netCents: grossCents - discountCents,
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/resolvePromotionLines.test.ts` Expected: PASS — 12 tests

- [ ] **Step 5: Verificar por mutación que los tests atrapan**

Cambiar `allocateByWeights(discountCents, grossPerLine)` por `grossPerLine.map(() => Math.round(discountCents / grossPerLine.length))`
(reparto en partes iguales) y correr. Expected: mueren "no pierde ni inventa un centavo" y "proporcional al bruto". **Revertir.**

- [ ] **Step 6: Commit**

```bash
git add src/services/promotions/resolvePromotionLines.ts tests/unit/services/promotions/resolvePromotionLines.test.ts
git commit -m "feat(promociones): decision pura de a que precio entra cada linea de una promocion"
```

---

## Task 2: El modelo

**Files:**

- Modify: `prisma/schema.prisma`
- Modify: `scripts/generate-schema-map.ts` (dar de alta los modelos en `MODEL_TO_DOMAIN`)
- Create: migración de Prisma

**Interfaces:**

- Consumes: nada
- Produces: los modelos `Promotion`, `PromotionGroup`, `PromotionOption`, `OrderPromotion` y el campo `OrderItem.orderPromotionId`, usados
  por Tasks 4, 5, 6, 8 y 10.

- [ ] **Step 1: Agregar los enums y modelos a `schema.prisma`**

```prisma
enum PromotionType {
  BUNDLE // grupo fijo: todos los grupos tienen 1 opción
  COMBO // el cliente elige
  DISCOUNT // sin grupos; apunta a un Discount existente
}

enum PromotionPricingMode {
  FIXED_TOTAL // cuesta `priceCents` (+ los priceDelta elegidos)
  PER_UNIT // 2x1: el precio sale del producto elegido
}

enum PromotionStatus {
  DRAFT
  PUBLISHED
  ARCHIVED
}

model Promotion {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  name        String
  description String? @db.Text
  imageUrl    String?

  type        PromotionType
  pricingMode PromotionPricingMode
  /** Precio base en CENTAVOS. Sólo se usa en FIXED_TOTAL. */
  priceCents  Int                  @default(0)

  /** Sólo para type = DISCOUNT: el descuento que aplica al carrito. */
  discountId String?
  discount   Discount? @relation(fields: [discountId], references: [id], onDelete: SetNull)

  // Vigencia — MISMA forma que Discount, para poder evaluarla con el MISMO
  // predicado (`isWithinVenueSchedule`). No inventar otro esquema de horarios.
  validFrom  DateTime?
  validUntil DateTime?
  daysOfWeek Int[]
  timeFrom   String?
  timeUntil  String?

  status       PromotionStatus @default(DRAFT)
  displayOrder Int             @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  groups          PromotionGroup[]
  orderPromotions OrderPromotion[]

  @@index([venueId, status])
  @@index([venueId, displayOrder])
}

model PromotionGroup {
  id          String    @id @default(cuid())
  promotionId String
  promotion   Promotion @relation(fields: [promotionId], references: [id], onDelete: Cascade)

  name         String // "Elige tu plato"
  displayOrder Int    @default(0)
  /** v1: siempre 1 y 1. Los campos existen para no migrar después. */
  minSelect    Int    @default(1)
  maxSelect    Int    @default(1)

  options PromotionOption[]

  @@index([promotionId])
}

model PromotionOption {
  id      String         @id @default(cuid())
  groupId String
  group   PromotionGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)

  productId String
  product   Product @relation(fields: [productId], references: [id], onDelete: Restrict)

  /** Unidades que ENTRAN al carrito. El inventario descuenta por aquí. */
  quantity        Int @default(1)
  /** Unidades que se COBRAN. 2x1 = quantity 2, chargedQuantity 1. */
  chargedQuantity Int @default(1)
  /** Sobreprecio en CENTAVOS. Sólo se usa en FIXED_TOTAL. */
  priceDeltaCents Int @default(0)

  displayOrder Int @default(0)

  @@index([groupId])
  @@index([productId])
}

/// La INSTANCIA vendida. Guarda el snapshot de lo que se cobró para que editar
/// o archivar la promoción NUNCA cambie un reporte histórico.
model OrderPromotion {
  id      String @id @default(cuid())
  orderId String
  order   Order  @relation(fields: [orderId], references: [id], onDelete: Cascade)

  promotionId String
  promotion   Promotion @relation(fields: [promotionId], references: [id], onDelete: Restrict)

  /// UUID generado por el POS. Es lo que hace idempotente el replay offline.
  instanceId String

  /// Snapshot: nombre, modo, precio y opciones elegidas, tal como se cobraron.
  snapshotJson Json

  grossCents   Int
  discountCents Int
  netCents     Int

  /// El desenlace no pudo validarse al sincronizar (promo archivada, reloj
  /// movido). La venta entró igual; esto la marca para revisión.
  needsReview   Boolean @default(false)
  reviewReason  String?

  createdAt DateTime @default(now())

  items OrderItem[]

  @@unique([orderId, instanceId])
  @@index([promotionId])
}
```

Y los dos ajustes de panel, que el dashboard escribe (plan 2) y los clientes leen (plan 3). Van en `VenueSettings` porque son preferencia
del local, no capacidad vendible:

```prisma
enum PromotionPanelMode {
  HIDDEN
  TAB
  SIDE_PANEL
}
```

En `model VenueSettings`:

```prisma
  /// Dónde salen las promociones en la pantalla del cajero y en la del cliente.
  /// El local de autoservicio quiere el panel (las promos SON el menú); el
  /// mostrador con fila quiere el ancho para la cuadrícula. Los clientes caen
  /// solos a TAB por debajo de ~960dp: ahí SIDE_PANEL no cabe.
  promotionsPanelCashier  PromotionPanelMode @default(TAB)
  promotionsPanelCustomer PromotionPanelMode @default(SIDE_PANEL)
```

Y en `model OrderItem`, agregar:

```prisma
  /// La promoción de la que nació esta línea. Las líneas de promoción quedan
  /// FUERA de los descuentos automáticos y se retiran juntas.
  orderPromotionId String?
  orderPromotion   OrderPromotion? @relation(fields: [orderPromotionId], references: [id], onDelete: Cascade)
```

Y en `model Order`, agregar `promotions OrderPromotion[]`. En `model Venue`, agregar `promotions Promotion[]`. En `model Discount`, agregar
`promotions Promotion[]`. En `model Product`, agregar `promotionOptions PromotionOption[]`.

- [ ] **Step 2: Dar de alta los modelos en el mapa de esquema**

En `scripts/generate-schema-map.ts`, agregar a `MODEL_TO_DOMAIN`:

```typescript
  Promotion: 'catalog',
  PromotionGroup: 'catalog',
  PromotionOption: 'catalog',
  OrderPromotion: 'orders',
```

- [ ] **Step 3: Generar migración y mapa**

```bash
npx prisma migrate dev --name promotions
npm run schema:map
```

- [ ] **Step 4: Verificar que compila**

Run: `npm run build` Expected: sin errores TS.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations scripts/generate-schema-map.ts docs/SCHEMA_MAP.md
git commit -m "feat(promociones): modelo de promociones e instancia vendida"
```

---

## Task 3: Qué se puede publicar

**Files:**

- Create: `src/services/promotions/validatePromotion.ts`
- Test: `tests/unit/services/promotions/validatePromotion.test.ts`

**Interfaces:**

- Consumes: nada (función pura)
- Produces: `validatePromotionForPublish(input: PromotionDraft): ValidationResult` — usada por Task 10 y por el dashboard (plan 2).

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/validatePromotion.test.ts
import { validatePromotionForPublish } from '@/services/promotions/validatePromotion'

const base = () => ({
  venueId: 'venue-1',
  type: 'BUNDLE' as const,
  pricingMode: 'FIXED_TOTAL' as const,
  priceCents: 9900,
  groups: [
    {
      name: 'Plato',
      minSelect: 1,
      maxSelect: 1,
      options: [{ productId: 'p1', productVenueId: 'venue-1', productActive: true, quantity: 1, chargedQuantity: 1, priceDeltaCents: 0 }],
    },
  ],
})

describe('validatePromotionForPublish — qué NO se publica', () => {
  it('un bundle bien armado se publica', () => {
    expect(validatePromotionForPublish(base())).toEqual({ ok: true })
  })

  it('🔴 un producto de OTRO venue nunca se publica', () => {
    const draft = base()
    draft.groups[0].options[0].productVenueId = 'venue-ajeno'

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['El producto p1 no pertenece a este establecimiento.'],
    })
  })

  it('un producto inactivo no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].productActive = false

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El producto p1 está desactivado.'] })
  })

  it('un grupo sin opciones no se publica', () => {
    const draft = base()
    draft.groups[0].options = []

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El grupo "Plato" no tiene opciones.'] })
  })

  it('🔴 chargedQuantity mayor que quantity regalaría al revés', () => {
    const draft = base()
    draft.groups[0].options[0].chargedQuantity = 2

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['El producto p1 cobra más unidades de las que entrega.'],
    })
  })

  it('quantity cero no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].quantity = 0

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El producto p1 debe entregar al menos una unidad.'] })
  })

  it('un precio negativo no se publica', () => {
    expect(validatePromotionForPublish({ ...base(), priceCents: -100 })).toEqual({
      ok: false,
      errors: ['El precio de la promoción no puede ser negativo.'],
    })
  })

  it('un priceDelta negativo no se publica', () => {
    const draft = base()
    draft.groups[0].options[0].priceDeltaCents = -500

    expect(validatePromotionForPublish(draft)).toEqual({ ok: false, errors: ['El sobreprecio del producto p1 no puede ser negativo.'] })
  })

  it('🔴 un BUNDLE con un grupo de varias opciones es en realidad un COMBO', () => {
    const draft = base()
    draft.groups[0].options.push({
      productId: 'p2',
      productVenueId: 'venue-1',
      productActive: true,
      quantity: 1,
      chargedQuantity: 1,
      priceDeltaCents: 0,
    })

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['Un bundle no puede tener grupos con varias opciones. Márcala como combo.'],
    })
  })

  it('un COMBO necesita al menos un grupo con varias opciones', () => {
    expect(validatePromotionForPublish({ ...base(), type: 'COMBO' })).toEqual({
      ok: false,
      errors: ['Un combo necesita al menos un grupo con más de una opción. Márcala como bundle.'],
    })
  })

  it('v1: elegir más de una opción por grupo no se publica', () => {
    const draft = base()
    draft.groups[0].maxSelect = 2

    expect(validatePromotionForPublish(draft)).toEqual({
      ok: false,
      errors: ['Por ahora cada grupo permite elegir exactamente una opción.'],
    })
  })

  it('un DISCOUNT no lleva grupos', () => {
    expect(validatePromotionForPublish({ ...base(), type: 'DISCOUNT' })).toEqual({
      ok: false,
      errors: ['Una promoción de descuento no lleva grupos de productos.'],
    })
  })

  it('se reportan TODOS los errores juntos, no el primero', () => {
    const draft = base()
    draft.groups[0].options[0].quantity = 0
    draft.priceCents = -1

    const result = validatePromotionForPublish(draft)
    expect(result.ok).toBe(false)
    expect((result as { errors: string[] }).errors).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/validatePromotion.test.ts` Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Escribir la implementación**

```typescript
// src/services/promotions/validatePromotion.ts

export interface PromotionDraftOption {
  productId: string
  /** venueId del producto — se compara contra el de la promoción. */
  productVenueId: string
  productActive: boolean
  quantity: number
  chargedQuantity: number
  priceDeltaCents: number
}

export interface PromotionDraftGroup {
  name: string
  minSelect: number
  maxSelect: number
  options: PromotionDraftOption[]
}

export interface PromotionDraft {
  venueId: string
  type: 'BUNDLE' | 'COMBO' | 'DISCOUNT'
  pricingMode: 'FIXED_TOTAL' | 'PER_UNIT'
  priceCents: number
  groups: PromotionDraftGroup[]
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

/**
 * ¿Esta promoción se puede publicar?
 *
 * Se reportan TODOS los errores juntos: quien la está armando en el dashboard
 * merece verlos de una vez, no uno por intento.
 *
 * 🔴 El check de tenant no es cosmético: una opción con el producto de otro
 * negocio cobraría mercancía ajena, y ni el dueño ni el otro local se
 * enterarían.
 */
export function validatePromotionForPublish(draft: PromotionDraft): ValidationResult {
  const errors: string[] = []

  if (draft.priceCents < 0) {
    errors.push('El precio de la promoción no puede ser negativo.')
  }

  if (draft.type === 'DISCOUNT') {
    if (draft.groups.length > 0) errors.push('Una promoción de descuento no lleva grupos de productos.')
    return errors.length > 0 ? { ok: false, errors } : { ok: true }
  }

  const gruposConVarias = draft.groups.filter(g => g.options.length > 1).length
  if (draft.type === 'BUNDLE' && gruposConVarias > 0) {
    errors.push('Un bundle no puede tener grupos con varias opciones. Márcala como combo.')
  }
  if (draft.type === 'COMBO' && gruposConVarias === 0) {
    errors.push('Un combo necesita al menos un grupo con más de una opción. Márcala como bundle.')
  }

  for (const group of draft.groups) {
    if (group.options.length === 0) {
      errors.push(`El grupo "${group.name}" no tiene opciones.`)
    }
    // v1: exactamente una opción por grupo. Los campos existen para no migrar
    // después, pero el POS no ofrece multi-selección y la prorrata de "elige 2
    // de estas 5" es otro problema.
    if (group.minSelect !== 1 || group.maxSelect !== 1) {
      errors.push('Por ahora cada grupo permite elegir exactamente una opción.')
    }

    for (const option of group.options) {
      if (option.productVenueId !== draft.venueId) {
        errors.push(`El producto ${option.productId} no pertenece a este establecimiento.`)
      }
      if (!option.productActive) {
        errors.push(`El producto ${option.productId} está desactivado.`)
      }
      if (option.quantity < 1) {
        errors.push(`El producto ${option.productId} debe entregar al menos una unidad.`)
      }
      if (option.chargedQuantity > option.quantity) {
        errors.push(`El producto ${option.productId} cobra más unidades de las que entrega.`)
      }
      if (option.priceDeltaCents < 0) {
        errors.push(`El sobreprecio del producto ${option.productId} no puede ser negativo.`)
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/validatePromotion.test.ts` Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/promotions/validatePromotion.ts tests/unit/services/promotions/validatePromotion.test.ts
git commit -m "feat(promociones): validacion de publicacion con check de tenant"
```

---

## Task 4: Aplicar una promoción a una orden, en una sola transacción

**Files:**

- Create: `src/services/promotions/promotion.service.ts`
- Test: `tests/unit/services/promotions/applyPromotion.test.ts`

**Interfaces:**

- Consumes: `resolvePromotionLines` (Task 1), los modelos (Task 2)
- Produces:
  `applyPromotionToOrder(params: { venueId, orderId, promotionId, instanceId, selections: Array<{ groupId, optionId }>, soldAt: Date }): Promise<{ orderPromotionId: string; netCents: number }>`
  — usada por Task 7.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/applyPromotion.test.ts
import prisma from '@/utils/prismaClient'
import { applyPromotionToOrder } from '@/services/promotions/promotion.service'

const prismaMock = prisma as any

const promocionEnBase = () => ({
  id: 'promo-1',
  venueId: 'venue-1',
  name: 'Combo del día',
  type: 'BUNDLE',
  pricingMode: 'FIXED_TOTAL',
  priceCents: 9900,
  status: 'PUBLISHED',
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [
    {
      id: 'g1',
      name: 'Plato',
      options: [{ id: 'o1', productId: 'hamburguesa', quantity: 1, chargedQuantity: 1, priceDeltaCents: 0, product: { price: 80 } }],
    },
    {
      id: 'g2',
      name: 'Bebida',
      options: [{ id: 'o2', productId: 'refresco', quantity: 1, chargedQuantity: 1, priceDeltaCents: 0, product: { price: 40 } }],
    },
  ],
})

const params = (over: Record<string, unknown> = {}) => ({
  venueId: 'venue-1',
  orderId: 'order-1',
  promotionId: 'promo-1',
  instanceId: 'inst-abc',
  selections: [
    { groupId: 'g1', optionId: 'o1' },
    { groupId: 'g2', optionId: 'o2' },
  ],
  soldAt: new Date('2026-08-12T18:00:00Z'),
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  prismaMock.promotion.findFirst.mockResolvedValue(promocionEnBase())
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  prismaMock.orderPromotion.findUnique.mockResolvedValue(null)
  prismaMock.orderPromotion.create.mockResolvedValue({ id: 'op-1' })
  prismaMock.orderItem.createMany.mockResolvedValue({ count: 2 })
})

describe('applyPromotionToOrder', () => {
  it('crea la instancia y sus líneas con los netos exactos', async () => {
    const result = await applyPromotionToOrder(params())

    expect(result).toMatchObject({ orderPromotionId: 'op-1', netCents: 9900 })
    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lineas).toHaveLength(2)
    expect(lineas.reduce((s: number, l: any) => s + Math.round(Number(l.total) * 100), 0)).toBe(9900)
    expect(lineas.every((l: any) => l.orderPromotionId === 'op-1')).toBe(true)
  })

  it('🔴 todo va dentro de UNA transacción — no puede quedar media promoción', async () => {
    await applyPromotionToOrder(params())

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('un replay del mismo instanceId no duplica: devuelve el existente', async () => {
    prismaMock.orderPromotion.findUnique.mockResolvedValue({ id: 'op-previo', netCents: 9900 })

    const result = await applyPromotionToOrder(params())

    expect(result).toMatchObject({ orderPromotionId: 'op-previo' })
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
  })

  it('🔴 una promoción de OTRO venue no se aplica', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue(null)

    await expect(applyPromotionToOrder(params({ venueId: 'venue-ajeno' }))).rejects.toThrow(/no encontr/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('una promoción en DRAFT no se aplica', async () => {
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), status: 'DRAFT' })

    await expect(applyPromotionToOrder(params())).rejects.toThrow(/no está publicada/i)
  })

  it('una opción que no pertenece al grupo se rechaza', async () => {
    await expect(applyPromotionToOrder(params({ selections: [{ groupId: 'g1', optionId: 'o2' }] }))).rejects.toThrow(/opción/i)
    expect(prismaMock.orderPromotion.create).not.toHaveBeenCalled()
  })

  it('faltar un grupo por elegir se rechaza — no se arma media promoción', async () => {
    await expect(applyPromotionToOrder(params({ selections: [{ groupId: 'g1', optionId: 'o1' }] }))).rejects.toThrow(/elegir/i)
  })

  it('🔴 fuera de horario, la venta ENTRA pero a precio de lista y marcada', async () => {
    // Un 2x1 de 18:00 a 20:00, vendido offline a las 22:00 y sincronizado ahora.
    prismaMock.promotion.findFirst.mockResolvedValue({ ...promocionEnBase(), timeFrom: '18:00', timeUntil: '20:00' })

    const result = await applyPromotionToOrder(params({ soldAt: new Date('2026-08-13T04:00:00Z') }))

    expect(result.netCents).toBe(12000) // bruto: 80 + 40
    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada).toMatchObject({ needsReview: true })
    expect(creada.reviewReason).toMatch(/vigencia/i)
  })

  it('el snapshot guarda lo que se cobró, para que editar la promo no cambie el histórico', async () => {
    await applyPromotionToOrder(params())

    const creada = prismaMock.orderPromotion.create.mock.calls[0][0].data
    expect(creada.snapshotJson).toMatchObject({ name: 'Combo del día', pricingMode: 'FIXED_TOTAL', priceCents: 9900 })
  })

  it('🔴 las líneas de promoción NUNCA traen impuesto propio', async () => {
    // El motor de descuentos estima 16% fijo y lo resta de Order.taxAmount, que
    // en POS suele ser 0 porque el IVA va incluido — eso deja el impuesto en
    // negativo. Las promociones no juegan ese juego: el CFDI deriva el IVA del
    // neto por línea.
    await applyPromotionToOrder(params())

    const lineas = prismaMock.orderItem.createMany.mock.calls[0][0].data
    expect(lineas.every((l: any) => Number(l.taxAmount) === 0)).toBe(true)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/applyPromotion.test.ts` Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Escribir la implementación**

```typescript
// src/services/promotions/promotion.service.ts
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'
import { resolvePromotionLines, type PromotionOptionSnapshot } from './resolvePromotionLines'

export interface ApplyPromotionParams {
  venueId: string
  orderId: string
  promotionId: string
  /** UUID del POS. Ancla la idempotencia del replay offline. */
  instanceId: string
  selections: Array<{ groupId: string; optionId: string }>
  /** Cuándo se vendió de verdad (ya acotado por el llamador). */
  soldAt: Date
}

/**
 * Aplica una promoción a una orden.
 *
 * 🔴 TODO ocurre en UNA transacción. Antes las líneas se creaban con
 * `Promise.all` y el CAS de totales venía después: si el tercer componente
 * fallaba, quedaba MEDIA promoción en la cuenta.
 *
 * 🔴 La venta nunca se rechaza por vigencia. Si la promoción no estaba viva en
 * `soldAt` —típico de una venta offline que sincroniza tarde—, las líneas
 * entran a precio de lista y la instancia queda marcada para revisión.
 * Rechazar mercancía ya entregada es peor que revisar un ticket.
 */
export async function applyPromotionToOrder(params: ApplyPromotionParams): Promise<{ orderPromotionId: string; netCents: number }> {
  const { venueId, orderId, promotionId, instanceId, selections, soldAt } = params

  const existing = await prisma.orderPromotion.findUnique({
    where: { orderId_instanceId: { orderId, instanceId } },
    select: { id: true, netCents: true },
  })
  if (existing) {
    return { orderPromotionId: existing.id, netCents: existing.netCents }
  }

  const promotion = await prisma.promotion.findFirst({
    where: { id: promotionId, venueId },
    include: { groups: { include: { options: { include: { product: { select: { price: true } } } } } } },
  })
  if (!promotion) {
    throw new NotFoundError('No se encontró esa promoción en este establecimiento.')
  }
  if (promotion.status !== 'PUBLISHED') {
    throw new BadRequestError('Esa promoción no está publicada.')
  }

  // Resolver lo elegido contra la definición: una opción tiene que pertenecer
  // a su grupo, y no puede faltar ningún grupo por elegir.
  const chosen: PromotionOptionSnapshot[] = []
  for (const group of promotion.groups) {
    const selection = selections.find(s => s.groupId === group.id)
    if (!selection) {
      throw new BadRequestError(`Falta elegir una opción de "${group.name}".`)
    }
    const option = group.options.find(o => o.id === selection.optionId)
    if (!option) {
      throw new BadRequestError(`Esa opción no pertenece al grupo "${group.name}".`)
    }
    chosen.push({
      productId: option.productId,
      quantity: option.quantity,
      chargedQuantity: option.chargedQuantity,
      priceDeltaCents: option.priceDeltaCents,
      listPriceCents: Math.round(Number(option.product.price) * 100),
    })
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const vigente = isWithinVenueSchedule(promotion, soldAt, venue?.timezone || DEFAULT_TIMEZONE)

  // Fuera de vigencia: los productos entran igual, a precio de lista.
  const resolved = vigente
    ? resolvePromotionLines({ pricingMode: promotion.pricingMode, priceCents: promotion.priceCents, selections: chosen })
    : resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: chosen.map(c => ({ ...c, chargedQuantity: c.quantity })),
      })

  return prisma.$transaction(async tx => {
    const created = await tx.orderPromotion.create({
      data: {
        orderId,
        promotionId,
        instanceId,
        snapshotJson: {
          name: promotion.name,
          type: promotion.type,
          pricingMode: promotion.pricingMode,
          priceCents: promotion.priceCents,
          selections: chosen,
        },
        grossCents: resolved.grossCents,
        discountCents: resolved.discountCents,
        netCents: resolved.netCents,
        needsReview: !vigente,
        reviewReason: vigente ? null : 'La promoción no estaba en vigencia al momento de la venta.',
      },
    })

    await tx.orderItem.createMany({
      data: resolved.lines.map(line => ({
        orderId,
        orderPromotionId: created.id,
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: line.unitPriceCents / 100,
        discountAmount: line.discountCents / 100,
        taxAmount: 0, // Las promociones NUNCA tocan el impuesto: el CFDI lo deriva del neto.
        total: line.totalCents / 100,
      })),
    })

    return { orderPromotionId: created.id, netCents: resolved.netCents }
  })
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/applyPromotion.test.ts` Expected: PASS — 9 tests

- [ ] **Step 5: Verificar por mutación**

Cambiar `needsReview: !vigente` por `needsReview: false` y correr. Expected: muere "fuera de horario, la venta ENTRA pero a precio de lista
y marcada". **Revertir.**

- [ ] **Step 6: Commit**

```bash
git add src/services/promotions/promotion.service.ts tests/unit/services/promotions/applyPromotion.test.ts
git commit -m "feat(promociones): aplicar una promocion a una orden en una sola transaccion"
```

---

## Task 5: Retirar una promoción completa

**Files:**

- Modify: `src/services/promotions/promotion.service.ts`
- Test: `tests/unit/services/promotions/removePromotion.test.ts`

**Interfaces:**

- Consumes: los modelos (Task 2)
- Produces: `removePromotionFromOrder(params: { venueId: string; orderId: string; orderPromotionId: string }): Promise<void>`

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/removePromotion.test.ts
import prisma from '@/utils/prismaClient'
import { removePromotionFromOrder } from '@/services/promotions/promotion.service'

const prismaMock = prisma as any

const params = () => ({ venueId: 'venue-1', orderId: 'order-1', orderPromotionId: 'op-1' })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  prismaMock.orderPromotion.findFirst.mockResolvedValue({ id: 'op-1', orderId: 'order-1', order: { venueId: 'venue-1' } })
  prismaMock.orderItem.deleteMany.mockResolvedValue({ count: 3 })
  prismaMock.orderPromotion.delete.mockResolvedValue({})
})

describe('removePromotionFromOrder', () => {
  it('🔴 borra TODAS las líneas de la promoción, no una', async () => {
    await removePromotionFromOrder(params())

    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderPromotionId: 'op-1' } })
    expect(prismaMock.orderPromotion.delete).toHaveBeenCalledWith({ where: { id: 'op-1' } })
  })

  it('todo va dentro de UNA transacción', async () => {
    await removePromotionFromOrder(params())

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('🔴 la promoción de otro venue no se puede retirar', async () => {
    prismaMock.orderPromotion.findFirst.mockResolvedValue(null)

    await expect(removePromotionFromOrder({ ...params(), venueId: 'venue-ajeno' })).rejects.toThrow(/no encontr/i)
    expect(prismaMock.orderItem.deleteMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/removePromotion.test.ts` Expected: FAIL — `removePromotionFromOrder is not a function`

- [ ] **Step 3: Agregar la implementación a `promotion.service.ts`**

```typescript
/**
 * Retira una promoción COMPLETA de una orden.
 *
 * 🔴 Nunca línea por línea. Quitar sólo el refresco de un combo de $99 dejaría
 * hamburguesa + papas cobradas a $99. Y antes, borrar una línea dejaba VIVO el
 * descuento que la mencionaba, que luego se volvía a sumar sobre las otras.
 */
export async function removePromotionFromOrder(params: { venueId: string; orderId: string; orderPromotionId: string }): Promise<void> {
  const { venueId, orderId, orderPromotionId } = params

  const found = await prisma.orderPromotion.findFirst({
    where: { id: orderPromotionId, orderId, order: { venueId } },
    select: { id: true },
  })
  if (!found) {
    throw new NotFoundError('No se encontró esa promoción en la cuenta.')
  }

  await prisma.$transaction(async tx => {
    await tx.orderItem.deleteMany({ where: { orderPromotionId } })
    await tx.orderPromotion.delete({ where: { id: orderPromotionId } })
  })
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/removePromotion.test.ts` Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/promotions/promotion.service.ts tests/unit/services/promotions/removePromotion.test.ts
git commit -m "feat(promociones): retirar una promocion completa, nunca linea por linea"
```

---

## Task 6: Los descuentos automáticos no alcanzan las líneas de promoción

**Files:**

- Modify: `src/services/dashboard/discountEngine.service.ts`
- Test: `tests/unit/services/dashboard/discountEnginePromotions.test.ts`

**Interfaces:**

- Consumes: `OrderItem.orderPromotionId` (Task 2)
- Produces: `OrderItemContext` gana el campo `orderPromotionId?: string | null`; `calculateDiscountAmount` lo respeta.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/dashboard/discountEnginePromotions.test.ts
import { calculateDiscountAmount } from '@/services/dashboard/discountEngine.service'

const descuento = (over: Record<string, any> = {}) =>
  ({
    id: 'd1',
    name: '20% automático',
    type: 'PERCENTAGE',
    value: 20,
    scope: 'ORDER',
    targetItemIds: [],
    targetCategoryIds: [],
    targetModifierIds: [],
    targetModifierGroupIds: [],
    customerGroupId: null,
    isAutomatic: true,
    priority: 0,
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    minQuantity: null,
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyItemIds: [],
    getItemIds: [],
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    timeFrom: null,
    timeUntil: null,
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    currentUses: 0,
    isStackable: false,
    stackPriority: 0,
    requiresApproval: false,
    applyBeforeTax: true,
    ...over,
  }) as any

const contexto = (items: any[]) => ({
  orderId: 'order-1',
  venueId: 'venue-1',
  subtotal: items.reduce((s, i) => s + i.total, 0),
  items,
  appliedDiscounts: [],
})

describe('los descuentos automáticos no alcanzan las líneas de promoción', () => {
  it('🔴 un 20% de orden se calcula SOLO sobre lo que no es promoción', () => {
    // El bug que evita: artículo normal $100 + combo $99 → el 20% subía de $20
    // a $39.80 y alcanzaba la promoción por la puerta de atrás.
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 100, total: 100, modifiers: [], orderPromotionId: null },
        { id: 'i2', productId: 'p2', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(20)
  })

  it('sin líneas de promoción el cálculo no cambia', () => {
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 100, total: 100, modifiers: [], orderPromotionId: null },
      ]),
    )

    expect(result.amount).toBe(20)
  })

  it('una cuenta que es SÓLO promoción no recibe descuento automático', () => {
    const result = calculateDiscountAmount(
      descuento(),
      contexto([
        { id: 'i1', productId: 'p1', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(0)
  })

  it('un descuento por ARTÍCULO tampoco toca una línea de promoción', () => {
    const result = calculateDiscountAmount(
      descuento({ scope: 'ITEM', targetItemIds: ['p2'] }),
      contexto([
        { id: 'i2', productId: 'p2', categoryId: 'c1', quantity: 1, unitPrice: 99, total: 99, modifiers: [], orderPromotionId: 'op-1' },
      ]),
    )

    expect(result.amount).toBe(0)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/discountEnginePromotions.test.ts` Expected: FAIL — el primero da 39.8 en vez de 20.

- [ ] **Step 3: Implementar**

En `discountEngine.service.ts`, agregar el campo a `OrderItemContext`:

```typescript
interface OrderItemContext {
  id: string
  productId: string
  categoryId: string
  quantity: number
  unitPrice: number
  total: number
  /** Si viene de una promoción, ningún descuento automático la toca. */
  orderPromotionId?: string | null
  modifiers: Array<{
    id: string
    modifierGroupId: string
    price: number
  }>
}
```

Y al principio de `calculateDiscountAmount`, antes de cualquier cuenta, reducir el contexto a las líneas elegibles:

```typescript
export function calculateDiscountAmount(discount: DiscountCandidate['discount'], context: OrderContext): DiscountCalculationResult {
  // 🔴 Las líneas nacidas de una promoción quedan FUERA de todo descuento
  // automático: la promo ya trae su precio negociado y nada se le encima solo.
  //
  // No basta con filtrar `items`: el subtotal es la base de los porcentajes de
  // orden, y al agregar artículos se recalcula sobre el subtotal NUEVO — así
  // que un 20% subía de $20 a $39.80 al meter un combo de $99.
  const elegibles = context.items.filter(i => !i.orderPromotionId)
  const eligibleContext: OrderContext = {
    ...context,
    items: elegibles,
    subtotal: elegibles.reduce((sum, i) => sum + i.total, 0),
  }
  context = eligibleContext

  // …resto del cuerpo actual, sin cambios…
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx jest tests/unit/services/dashboard/discountEnginePromotions.test.ts tests/unit/services/dashboard/discountEngine.service.test.ts`
Expected: PASS — los 4 nuevos y los 62 que ya estaban.

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/discountEngine.service.ts tests/unit/services/dashboard/discountEnginePromotions.test.ts
git commit -m "fix(descuentos): un automatico ya no alcanza las lineas de una promocion"
```

---

## Task 7: `promotionRef` en `ADD_ITEMS` y la ventana acotada offline

**Files:**

- Modify: `src/services/mobile/sync.mobile.service.ts`
- Test: `tests/unit/services/syncPromotionRef.test.ts`

**Interfaces:**

- Consumes: `applyPromotionToOrder` (Task 4)
- Produces: `ADD_ITEMS` acepta `items[].promotionRef = { promotionId, promotionInstanceId, selections }`. **Opcional**: sin él, el
  comportamiento es idéntico al de hoy.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/syncPromotionRef.test.ts
import { clampSoldAt } from '@/services/mobile/sync.mobile.service'

describe('clampSoldAt — el reloj del cliente no manda solo', () => {
  const sync = new Date('2026-08-12T20:00:00Z')

  it('una venta de hace 40 minutos se honra tal cual', () => {
    expect(clampSoldAt('2026-08-12T19:20:00Z', sync).toISOString()).toBe('2026-08-12T19:20:00.000Z')
  })

  it('🔴 un reloj movido 3 días atrás se acota a 24 horas', () => {
    expect(clampSoldAt('2026-08-09T19:20:00Z', sync).toISOString()).toBe('2026-08-11T20:00:00.000Z')
  })

  it('un reloj adelantado se acota al momento de sincronizar', () => {
    expect(clampSoldAt('2026-08-15T10:00:00Z', sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })

  it('sin fecha del cliente se usa el momento de sincronizar', () => {
    expect(clampSoldAt(undefined, sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })

  it('una fecha basura no truena: se usa el momento de sincronizar', () => {
    expect(clampSoldAt('ayer por la tarde', sync).toISOString()).toBe('2026-08-12T20:00:00.000Z')
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/syncPromotionRef.test.ts` Expected: FAIL — `clampSoldAt is not a function`

- [ ] **Step 3: Implementar `clampSoldAt` en `sync.mobile.service.ts`**

```typescript
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Cuándo se vendió de verdad, sin dejar que el reloj del cliente mande solo.
 *
 * 🔴 Si el POS vende a las 19:59 sin red y sincroniza a las 20:30, evaluar la
 * vigencia contra "ahora" tumbaría el precio de una venta ya entregada. Pero
 * confiar ciegamente en `createdAtLocal` deja mover el reloj para revivir una
 * promoción vencida. Se acota a `[sync − 24h, sync]`: una venta legítima de
 * más temprano el mismo día se honra, y un reloj movido más no compra nada.
 */
export function clampSoldAt(createdAtLocal: string | undefined, syncAt: Date): Date {
  const parsed = createdAtLocal ? new Date(createdAtLocal) : null
  if (!parsed || Number.isNaN(parsed.getTime())) return syncAt

  const floor = syncAt.getTime() - OFFLINE_GRACE_MS
  return new Date(Math.min(Math.max(parsed.getTime(), floor), syncAt.getTime()))
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/syncPromotionRef.test.ts` Expected: PASS — 5 tests

- [ ] **Step 5: Enganchar `promotionRef` en `applyAddItems`**

En `applyAddItems`, después de la validación de `invalidAddItemsReason` y antes de `addItemsToOrder`, separar los items con promoción:

```typescript
// Los items con `promotionRef` NO pasan por el alta normal: su precio lo
// resuelve el server desde la definición de la promoción. Los demás siguen
// exactamente el camino de hoy.
const conPromocion = items.filter(it => it.promotionRef)
const normales = items.filter(it => !it.promotionRef)

const soldAt = clampSoldAt(intent.payload.createdAtLocal as string | undefined, new Date())
for (const item of conPromocion) {
  await applyPromotionToOrder({
    venueId,
    orderId,
    promotionId: item.promotionRef.promotionId,
    instanceId: item.promotionRef.promotionInstanceId,
    selections: item.promotionRef.selections,
    soldAt,
  })
}
```

y usar `normales` donde hoy se usa `items` para construir `itemsWithKey`. Si `normales` queda vacío y hubo promociones, no llamar a
`addItemsToOrder`.

- [ ] **Step 6: Correr la suite de sync completa**

Run: `npx jest tests/unit/services/sync.mobile.service.test.ts` Expected: PASS — los 58 que ya estaban siguen verdes (nada cambia sin
`promotionRef`).

- [ ] **Step 7: Commit**

```bash
git add src/services/mobile/sync.mobile.service.ts tests/unit/services/syncPromotionRef.test.ts
git commit -m "feat(promociones): ADD_ITEMS acepta promotionRef y acota el reloj del cliente"
```

---

## Task 8: El catálogo de promociones para el POS

**Files:**

- Create: `src/services/promotions/promotionCatalog.service.ts`
- Create: `src/controllers/mobile/promotion.mobile.controller.ts`
- Modify: `src/routes/mobile.routes.ts`
- Test: `tests/unit/services/promotions/promotionCatalog.test.ts`

**Interfaces:**

- Consumes: `isWithinVenueSchedule` de `@/utils/datetime`, los modelos (Task 2)
- Produces: `GET /api/v1/mobile/venues/:venueId/promotions` → `{ active: PromotionCard[]; upcoming: PromotionCard[] }`

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/promotionCatalog.test.ts
import prisma from '@/utils/prismaClient'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'

const prismaMock = prisma as any

const promo = (over: Record<string, unknown> = {}) => ({
  id: 'promo-1',
  name: 'Martes de cerveza',
  description: null,
  imageUrl: null,
  type: 'BUNDLE',
  pricingMode: 'PER_UNIT',
  priceCents: 0,
  status: 'PUBLISHED',
  displayOrder: 0,
  validFrom: null,
  validUntil: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  groups: [],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('listPromotionsForPos', () => {
  it('una promoción vigente ahora sale en activas', async () => {
    // 2026-08-12 19:00 CST = 2026-08-13 01:00 UTC.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '18:00', timeUntil: '20:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-13T01:00:00Z'))

    expect(result.active.map(p => p.id)).toEqual(['promo-1'])
    expect(result.upcoming).toEqual([])
  })

  it('una que empieza en 2 horas sale en próximas', async () => {
    // 15:00 CST; la promo abre a las 18:00.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '17:00', timeUntil: '20:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T21:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming.map(p => p.id)).toEqual(['promo-1'])
    expect(result.upcoming[0].startsAt).toBe('17:00')
  })

  it('🔴 una que empieza en 6 horas NO se muestra — el horizonte son 4', async () => {
    // 12:00 CST; abre a las 22:00.
    prismaMock.promotion.findMany.mockResolvedValue([promo({ timeFrom: '22:00', timeUntil: '23:00' })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T18:00:00Z'))

    expect(result.active).toEqual([])
    expect(result.upcoming).toEqual([])
  })

  it('las activas van ordenadas por displayOrder', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([promo({ id: 'b', displayOrder: 2 }), promo({ id: 'a', displayOrder: 1 })])

    const result = await listPromotionsForPos('venue-1', new Date('2026-08-12T18:00:00Z'))

    expect(result.active.map(p => p.id)).toEqual(['a', 'b'])
  })

  it('sólo se consultan las PUBLISHED', async () => {
    prismaMock.promotion.findMany.mockResolvedValue([])

    await listPromotionsForPos('venue-1', new Date())

    expect(prismaMock.promotion.findMany.mock.calls[0][0].where).toMatchObject({ venueId: 'venue-1', status: 'PUBLISHED' })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/promotionCatalog.test.ts` Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Escribir la implementación**

```typescript
// src/services/promotions/promotionCatalog.service.ts
import prisma from '@/utils/prismaClient'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'

/** Cuánto se adelanta el panel mostrando lo que viene. Más allá, no se muestra. */
const UPCOMING_HORIZON_MS = 4 * 60 * 60 * 1000

export interface PromotionCard {
  id: string
  name: string
  description: string | null
  imageUrl: string | null
  type: string
  pricingMode: string
  priceCents: number
  /** Sólo en las próximas: a qué hora abre, para poder decirlo en la tarjeta. */
  startsAt?: string
  groups: Array<{ id: string; name: string; options: Array<{ id: string; productId: string; priceDeltaCents: number }> }>
}

/**
 * Qué promociones ve el POS: las vigentes ahora y las que abren pronto.
 *
 * Las próximas se muestran apagadas en vez de colapsar el panel. Colapsar
 * recuperaría el 25% de la pantalla pero movería el layout dos veces al día,
 * encogiendo la cuadrícula que el cajero ya tiene memorizada — y decir "a las
 * 6 son 2x1" es una herramienta de venta.
 */
export async function listPromotionsForPos(
  venueId: string,
  now: Date = new Date(),
): Promise<{ active: PromotionCard[]; upcoming: PromotionCard[] }> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone || DEFAULT_TIMEZONE

  const promotions = await prisma.promotion.findMany({
    where: {
      venueId,
      status: 'PUBLISHED',
      AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: now } }] }, { OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  })

  const active: PromotionCard[] = []
  const upcoming: PromotionCard[] = []

  for (const promotion of promotions) {
    const card = toCard(promotion)
    if (isWithinVenueSchedule(promotion, now, timezone)) {
      active.push(card)
      continue
    }
    // ¿Abre dentro del horizonte? Se prueba el propio predicado adelantando el
    // reloj, para no reimplementar la aritmética de horarios.
    const horizonte = new Date(now.getTime() + UPCOMING_HORIZON_MS)
    if (promotion.timeFrom && isWithinVenueSchedule(promotion, horizonte, timezone)) {
      upcoming.push({ ...card, startsAt: promotion.timeFrom })
    }
  }

  return { active, upcoming }
}

function toCard(promotion: any): PromotionCard {
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    imageUrl: promotion.imageUrl,
    type: promotion.type,
    pricingMode: promotion.pricingMode,
    priceCents: promotion.priceCents,
    groups: (promotion.groups ?? []).map((g: any) => ({
      id: g.id,
      name: g.name,
      options: (g.options ?? []).map((o: any) => ({ id: o.id, productId: o.productId, priceDeltaCents: o.priceDeltaCents })),
    })),
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/promotionCatalog.test.ts` Expected: PASS — 5 tests

- [ ] **Step 5: Agregar controller y ruta**

```typescript
// src/controllers/mobile/promotion.mobile.controller.ts
import { Request, Response } from 'express'
import { listPromotionsForPos } from '../../services/promotions/promotionCatalog.service'
import logger from '../../config/logger'

/** GET /api/v1/mobile/venues/:venueId/promotions */
export async function getPromotions(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const data = await listPromotionsForPos(venueId)
    return res.status(200).json({ success: true, data })
  } catch (error) {
    logger.error('Error in getPromotions', { error: error instanceof Error ? error.message : 'desconocido', venueId: req.params.venueId })
    return res.status(500).json({ success: false, message: 'Error interno del servidor' })
  }
}
```

En `src/routes/mobile.routes.ts`, junto a las demás rutas de venue:

```typescript
/**
 * GET /api/v1/mobile/venues/:venueId/promotions
 * Promociones vigentes y las que abren en las próximas 4 horas.
 */
router.get(
  '/venues/:venueId/promotions',
  authenticateTokenMiddleware,
  checkFeatureAccess('PROMOTIONS'),
  promotionMobileController.getPromotions,
)
```

con `import * as promotionMobileController from '../controllers/mobile/promotion.mobile.controller'` arriba.

- [ ] **Step 6: Verificar que compila**

Run: `npm run build` Expected: sin errores TS.

- [ ] **Step 7: Commit**

```bash
git add src/services/promotions/promotionCatalog.service.ts src/controllers/mobile/promotion.mobile.controller.ts src/routes/mobile.routes.ts tests/unit/services/promotions/promotionCatalog.test.ts
git commit -m "feat(promociones): endpoint movil con vigentes y proximas"
```

---

## Task 9: El gate PRO (ancla, no cableado)

**Files:**

- Test: `tests/unit/services/access/promotionsFeature.test.ts`
- Modify: `src/services/access/basePlan.service.ts` — **sólo un comentario**, ver Step 3.

**Interfaces:**

- Consumes: `venueHasFeatureAccess` de `@/services/access/basePlan.service`
- Produces: la garantía, con test, de que `PROMOTIONS` es PRO. El cableado real es el `checkFeatureAccess('PROMOTIONS')` de la Task 8.

🔑 **El gating aquí es allow-by-default, y por eso esta task casi no toca código.** `PREMIUM_ONLY_CODES` lista lo que PRO **NO** tiene;
`FREE_TIER_CODES` lo que tiene todo el mundo. Un código que no está en ninguna de las dos **ya es PRO y PREMIUM**
(`basePlan.service.ts:229-232`). `PROMOTIONS` no va en ninguna lista. Lo que sí hace falta es **anclar esa decisión con un test**, porque
hoy nada impide que alguien meta `PROMOTIONS` en `PREMIUM_ONLY_CODES` sin darse cuenta de que deja fuera a los PRO — que son justo los que
pelean por ticket promedio.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/access/promotionsFeature.test.ts
import { FREE_TIER_CODES, PREMIUM_ONLY_CODES } from '@/services/access/basePlan.service'

describe('PROMOTIONS es una feature PRO', () => {
  // El gating es allow-by-default: lo que no está en ninguna lista es PRO+.
  it('🔴 no está en PREMIUM_ONLY_CODES — dejaría fuera a los PRO', () => {
    expect(PREMIUM_ONLY_CODES as readonly string[]).not.toContain('PROMOTIONS')
  })

  it('🔴 no está en FREE_TIER_CODES — regalaría una capacidad que se cobra', () => {
    expect(FREE_TIER_CODES as readonly string[]).not.toContain('PROMOTIONS')
  })
})
```

- [ ] **Step 2: Correr el test**

Run: `npx jest tests/unit/services/access/promotionsFeature.test.ts` Expected: PASS de entrada — es un test de anclaje, no de cambio. Si
FALLA, alguien ya metió el código en una lista y hay que sacarlo.

- [ ] **Step 3: Dejar el rastro en el código**

Sobre `PREMIUM_ONLY_CODES` en `basePlan.service.ts`, agregar:

```typescript
// PROMOTIONS (combos, bundles, 2x1) es PRO a propósito y por eso NO aparece
// aquí: el gating es allow-by-default. Ver promotionsFeature.test.ts, que ancla
// la decisión — meterlo en esta lista dejaría fuera a los PRO, que son los que
// más pelean por ticket promedio.
```

- [ ] **Step 4: Commit**

```bash
git add src/services/access/basePlan.service.ts tests/unit/services/access/promotionsFeature.test.ts
git commit -m "test(promociones): anclar que PROMOTIONS es PRO, no PREMIUM"
```

---

## Task 10: La base de la propina

**Files:**

- Create: `src/services/promotions/tipBase.ts`
- Test: `tests/unit/services/promotions/tipBase.test.ts`

**Interfaces:**

- Consumes: nada (función pura)
- Produces: `netSubtotalForTipCents(items: TipBaseLine[]): number` — la base canónica. La consume el plan 3 (clientes) a través de la
  respuesta de la orden; ningún cliente la calcula por su cuenta.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/promotions/tipBase.test.ts
import { netSubtotalForTipCents } from '@/services/promotions/tipBase'

describe('netSubtotalForTipCents — sobre qué se calcula la propina', () => {
  it('🔴 la base es el NETO, no el bruto de catálogo', () => {
    // Un combo de $99 cuyo catálogo suma $200 daría "15%" de $30 en un cliente
    // y de $14.85 en otro. La base canónica es una sola.
    expect(
      netSubtotalForTipCents([
        { grossCents: 8000, discountCents: 2286 },
        { grossCents: 4000, discountCents: 1143 },
        { grossCents: 2000, discountCents: 571 },
      ]),
    ).toBe(10000)
  })

  it('sin descuentos el neto es el bruto', () => {
    expect(netSubtotalForTipCents([{ grossCents: 15000, discountCents: 0 }])).toBe(15000)
  })

  it('una cuenta vacía da cero, no NaN', () => {
    expect(netSubtotalForTipCents([])).toBe(0)
  })

  it('una línea de cortesía no aporta base', () => {
    expect(netSubtotalForTipCents([{ grossCents: 5000, discountCents: 5000 }])).toBe(0)
  })

  it('un descuento mayor que el bruto no genera base negativa', () => {
    // Defensa contra dato sucio: la propina nunca se calcula sobre un negativo.
    expect(netSubtotalForTipCents([{ grossCents: 5000, discountCents: 9000 }])).toBe(0)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/promotions/tipBase.test.ts` Expected: FAIL — módulo no encontrado.

- [ ] **Step 3: Escribir la implementación**

```typescript
// src/services/promotions/tipBase.ts

export interface TipBaseLine {
  grossCents: number
  discountCents: number
}

/**
 * La base canónica de la propina: **el subtotal NETO, después de promociones y
 * descuentos, antes de propina.**
 *
 * 🔴 Sin una base única, un combo de $99 cuyo catálogo suma $200 produce "15%"
 * de $14.85 en un cliente y de $30 en otro — y el mesero cobra distinto según
 * con qué aparato lo atendieron. El server la calcula y los clientes la
 * muestran; ninguno la deriva por su cuenta.
 */
export function netSubtotalForTipCents(items: TipBaseLine[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.grossCents - item.discountCents), 0)
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/promotions/tipBase.test.ts` Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/promotions/tipBase.ts tests/unit/services/promotions/tipBase.test.ts
git commit -m "feat(promociones): base canonica de la propina sobre el subtotal neto"
```

---

## Task 11: El reembolso de una promoción es completo o no es

**Files:**

- Modify: `src/services/dashboard/refund.dashboard.service.ts`
- Test: `tests/unit/services/dashboard/refundPromotion.test.ts`

**Interfaces:**

- Consumes: `OrderItem.orderPromotionId` (Task 2)
- Produces: el guard que impide reembolsar una línea suelta de una promoción.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/dashboard/refundPromotion.test.ts
import { assertRefundableLines } from '@/services/dashboard/refund.dashboard.service'

describe('assertRefundableLines — una promoción no se reembolsa a pedazos', () => {
  const combo = [
    { id: 'i1', orderPromotionId: 'op-1', total: 57.14 },
    { id: 'i2', orderPromotionId: 'op-1', total: 28.57 },
    { id: 'i3', orderPromotionId: 'op-1', total: 14.29 },
  ]

  it('reembolsar el combo COMPLETO se permite', () => {
    expect(() => assertRefundableLines(combo, ['i1', 'i2', 'i3'])).not.toThrow()
  })

  it('🔴 reembolsar UN componente se rechaza', () => {
    // Devolver sólo el refresco dejaría hamburguesa + papas cobradas a precio
    // de combo, y no hay regla escrita de cómo se reprecia el resto.
    expect(() => assertRefundableLines(combo, ['i3'])).toThrow(/completa/i)
  })

  it('reembolsar dos de tres también se rechaza', () => {
    expect(() => assertRefundableLines(combo, ['i1', 'i2'])).toThrow(/completa/i)
  })

  it('las líneas normales se reembolsan sueltas como siempre', () => {
    const normales = [
      { id: 'n1', orderPromotionId: null, total: 100 },
      { id: 'n2', orderPromotionId: null, total: 50 },
    ]
    expect(() => assertRefundableLines(normales, ['n1'])).not.toThrow()
  })

  it('mezclar una línea normal con un combo completo se permite', () => {
    const mixto = [...combo, { id: 'n1', orderPromotionId: null, total: 100 }]
    expect(() => assertRefundableLines(mixto, ['i1', 'i2', 'i3', 'n1'])).not.toThrow()
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/refundPromotion.test.ts` Expected: FAIL — `assertRefundableLines is not a function`

- [ ] **Step 3: Escribir la implementación en `refund.dashboard.service.ts`**

```typescript
export interface RefundableLine {
  id: string
  orderPromotionId: string | null
  total: number | { toString(): string }
}

/**
 * Una promoción se reembolsa COMPLETA o no se reembolsa.
 *
 * 🔴 Devolver un componente suelto dejaría el resto cobrado a precio de
 * promoción —hamburguesa + papas por $99— y no hay regla escrita de cómo se
 * reprecia lo que queda. Peor: el reembolso por artículo usa `OrderItem.total`
 * y no sabría si la unidad devuelta era la pagada o la regalada de un 2x1.
 */
export function assertRefundableLines(lines: RefundableLine[], selectedIds: string[]): void {
  const selected = new Set(selectedIds)
  const porPromocion = new Map<string, RefundableLine[]>()

  for (const line of lines) {
    if (!line.orderPromotionId) continue
    const grupo = porPromocion.get(line.orderPromotionId) ?? []
    grupo.push(line)
    porPromocion.set(line.orderPromotionId, grupo)
  }

  for (const [, grupo] of porPromocion) {
    const elegidas = grupo.filter(l => selected.has(l.id)).length
    if (elegidas > 0 && elegidas < grupo.length) {
      throw new BadRequestError('Una promoción se reembolsa completa. Selecciona todos sus artículos o ninguno.')
    }
  }
}
```

(`BadRequestError` ya está importado en ese archivo; si no, agregar `import { BadRequestError } from '@/errors/AppError'`.)

- [ ] **Step 4: Llamarlo desde el reembolso por artículo**

En la función de reembolso por artículos de `refund.dashboard.service.ts`, después de cargar las líneas de la orden y antes de calcular
montos, llamar `assertRefundableLines(orderItems, requestedItemIds)`.

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx jest tests/unit/services/dashboard/refundPromotion.test.ts tests/unit/services/dashboard/refund*.test.ts` Expected: PASS — los 5
nuevos y los que ya estaban.

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/refund.dashboard.service.ts tests/unit/services/dashboard/refundPromotion.test.ts
git commit -m "feat(promociones): una promocion se reembolsa completa o no se reembolsa"
```

---

## Task 12: Las herramientas del MCP

**Files:**

- Create: `src/mcp/tools/promotions.ts`
- Modify: el registro de tools del MCP (donde se llaman los `register*Tools`)

**Interfaces:**

- Consumes: `validatePromotionForPublish` (Task 3), `listPromotionsForPos` (Task 8)
- Produces: `list_promotions`, `promotion_status`, `create_promotion`

- [ ] **Step 1: Escribir el archivo de tools**

```typescript
// src/mcp/tools/promotions.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'
import { validatePromotionForPublish } from '@/services/promotions/validatePromotion'

export function registerPromotionTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_promotions',
    'Lista las promociones de un venue (combos, bundles y 2x1) con su estado: DRAFT, PUBLISHED o ARCHIVED. Úsala para ver qué tiene armado el local y qué le falta publicar. Los precios vienen en pesos.',
    {
      venueId: z.string().describe('Venue (debe estar en tu alcance)'),
      status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional().describe('Filtrar por estado; omite para todas'),
    },
    async ({ venueId, status }) => {
      const where = guard.venueFilter(venueId)
      const rows = await prisma.promotion.findMany({
        where: { ...where, ...(status ? { status } : {}) },
        include: { groups: { include: { options: true } } },
        orderBy: [{ status: 'asc' }, { displayOrder: 'asc' }],
        take: 100,
      })
      return text({
        count: rows.length,
        promotions: rows.map(p => ({
          id: p.id,
          name: p.name,
          type: p.type,
          pricingMode: p.pricingMode,
          price: p.priceCents / 100,
          status: p.status,
          schedule: { daysOfWeek: p.daysOfWeek, from: p.timeFrom, until: p.timeUntil },
          groups: p.groups.map(g => ({ name: g.name, options: g.options.length })),
        })),
      })
    },
  )

  server.tool(
    'promotion_status',
    'Dice qué promociones están VIGENTES ahora mismo en un venue y cuáles abren en las próximas 4 horas, evaluado en la hora del negocio (no la del servidor). Úsala para contestar "¿qué promo tengo corriendo?" sin adivinar con el reloj.',
    { venueId: z.string().describe('Venue (debe estar en tu alcance)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      const { active, upcoming } = await listPromotionsForPos(venueId)
      return text({
        activeNow: active.map(p => ({ id: p.id, name: p.name, price: p.priceCents / 100 })),
        startingSoon: upcoming.map(p => ({ id: p.id, name: p.name, startsAt: p.startsAt })),
      })
    },
  )

  server.tool(
    'create_promotion',
    'Crea una promoción en DRAFT (combo, bundle o 2x1). Se crea SIEMPRE apagada: publicarla es un paso aparte y deliberado, porque una promo mal armada cobra de menos en cada venta. Por DEFAULT sólo valida y muestra qué quedaría; llama otra vez con confirm:true para crearla. Requiere discounts:create.',
    {
      venueId: z.string().describe('Venue dueño de la promoción (debe estar en tu alcance)'),
      name: z.string().min(1).describe('Nombre visible, ej. "Combo del día"'),
      type: z.enum(['BUNDLE', 'COMBO']).describe('BUNDLE = grupo fijo; COMBO = el cliente elige'),
      pricingMode: z.enum(['FIXED_TOTAL', 'PER_UNIT']).describe('FIXED_TOTAL = cuesta un precio fijo; PER_UNIT = 2x1'),
      price: z.number().min(0).describe('Precio de la promoción en PESOS. 0 en PER_UNIT.'),
      groups: z
        .array(
          z.object({
            name: z.string().min(1),
            options: z.array(
              z.object({
                productId: z.string(),
                quantity: z.number().int().min(1).describe('Unidades que ENTRAN al carrito. 2 en un 2x1.'),
                chargedQuantity: z.number().int().min(0).describe('Unidades que se COBRAN. 1 en un 2x1.'),
                priceDelta: z.number().min(0).default(0).describe('Sobreprecio en pesos (sólo FIXED_TOTAL)'),
              }),
            ),
          }),
        )
        .describe('Grupos de elección. Un bundle lleva un grupo por componente, cada uno con UNA opción.'),
      confirm: z.boolean().optional().describe('Debe ser true para crearla; sin esto sólo obtienes la validación'),
    },
    async ({ venueId, name, type, pricingMode, price, groups, confirm }) => {
      const base = guard.venueFilter(venueId)
      guard.requirePermission('discounts:create', venueId)

      const productIds = groups.flatMap(g => g.options.map(o => o.productId))
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, ...base },
        select: { id: true, venueId: true, active: true, name: true },
      })

      const draft = {
        venueId,
        type,
        pricingMode,
        priceCents: Math.round(price * 100),
        groups: groups.map(g => ({
          name: g.name,
          minSelect: 1,
          maxSelect: 1,
          options: g.options.map(o => {
            const product = products.find(p => p.id === o.productId)
            return {
              productId: o.productId,
              productVenueId: product?.venueId ?? 'desconocido',
              productActive: product?.active ?? false,
              quantity: o.quantity,
              chargedQuantity: o.chargedQuantity,
              priceDeltaCents: Math.round(o.priceDelta * 100),
            }
          }),
        })),
      }

      const validation = validatePromotionForPublish(draft)
      if (!validation.ok) {
        return text({ ok: false, errors: validation.errors, message: 'Así no se puede publicar. Corrige y vuelve a intentar.' })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { name, type, pricingMode, price, groups: groups.length },
          message: `Esto creará la promoción "${name}" en DRAFT (apagada). Vuelve a llamar con confirm:true para crearla.`,
        })
      }

      const created = await prisma.promotion.create({
        data: {
          venueId,
          name,
          type,
          pricingMode,
          priceCents: draft.priceCents,
          status: 'DRAFT',
          groups: {
            create: groups.map((g, gi) => ({
              name: g.name,
              displayOrder: gi,
              options: {
                create: g.options.map((o, oi) => ({
                  productId: o.productId,
                  quantity: o.quantity,
                  chargedQuantity: o.chargedQuantity,
                  priceDeltaCents: Math.round(o.priceDelta * 100),
                  displayOrder: oi,
                })),
              },
            })),
          },
        },
      })

      return text({
        ok: true,
        promotionId: created.id,
        message: `Creada "${name}" en DRAFT. Todavía NO la ve nadie en el POS: hay que publicarla desde el dashboard.`,
      })
    },
  )
}
```

- [ ] **Step 2: Registrar las tools**

En el archivo donde se llaman los demás `register*Tools`, agregar `registerPromotionTools(server, scope)` siguiendo el patrón existente.

- [ ] **Step 3: Verificar que compila**

Run: `npm run build` Expected: sin errores TS.

- [ ] **Step 4: Correr la suite completa**

Run: `npx jest --selectProjects unit` Expected: todo verde.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/promotions.ts src/mcp/
git commit -m "feat(promociones): herramientas de MCP para listar, ver vigencia y crear"
```

---

## Qué sigue

Con este plan terminado, el server sabe todo lo que necesita y el contrato existe. Los otros dos planes se escriben sobre él:

- **Plan 2 — dashboard:** sección Promociones (crear, editar, publicar, archivar, foto, grupos y opciones, vigencia) y los dos ajustes de
  panel.
- **Plan 3 — Android + iOS:** el panel (lateral/pestaña/oculto con caída automática bajo ~960dp), la hoja de combo, los estados de "no
  aplica" y la lectura de tier. Van en el MISMO trabajo por la regla de paridad.

Y las dos obligaciones del workspace, al cerrar los tres: la presentación de ventas (deck + one-pagers + **regenerar los tres PDFs**) y el
mapa de esquema, que este plan ya cubre en la Task 2.
