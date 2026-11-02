# Pay Later Order Classification - Technical Documentation

**Created**: 2025-12-22 **Feature**: Pay Later (Pagar Después) **Status**: Production Ready

---

## 🎯 Overview

Este documento explica **cómo se clasifican las órdenes pay-later** y por qué **NO interfiere con otras funcionalidades** del sistema.

---

## 📊 Clasificación de Órdenes

### Regla de Clasificación Pay-Later

Una orden es **pay-later** si cumple **TODAS** estas condiciones:

```typescript
// Condición 1: Payment Status debe ser PENDING o PARTIAL
order.paymentStatus === 'PENDING' || order.paymentStatus === 'PARTIAL'

// AND

// Condición 2: Debe tener al menos 1 customer vinculado
order.orderCustomers.length > 0

// AND

// Condición 3: Debe tener saldo pendiente
order.remainingBalance > 0

// AND (desde el 26-oct-2026, «como Toast»)

// Condición 4: NO se creó para cobrarse en el momento
order.payLater !== false   // true = el cajero eligió «Pagar después»; null = cuenta vieja o camino que no lo declara
```

> 🔴 **Actualización 26-oct-2026 (founder: «como Toast»).** Sólo es deuda del cliente lo que el cajero mandó a «Pagar
> después». El POS de ANDROID/iOS manda `paymentMethod` al crear la cuenta: `PAY_LATER` → `Order.payLater = true`; otro
> método (un cobro con tarjeta que luego falla) → `false`, y esa cuenta ya no sale en «Cuentas por cobrar», en el saldo del
> cliente ni en su «Liquidar todo». Sin método (apps viejas, TPV) → `null` y sigue la regla de las condiciones 1-3. Juntar
> cuentas conserva el fiado; dividirlas lo hereda. Regla en código: `src/services/shared/porCobrar.ts`.

### Diagrama de Clasificación

```
┌─────────────────────────────────────────────────────────┐
│                    TODAS LAS ÓRDENES                     │
└───────────────────┬─────────────────────────────────────┘
                    │
        ┌───────────┴──────────┐
        │                      │
   ┌────▼─────┐         ┌──────▼──────┐
   │  PAID /  │         │  PENDING /  │
   │ REFUNDED │         │  PARTIAL    │
   └──────────┘         └──────┬──────┘
                               │
                   ┌───────────┴────────────┐
                   │                        │
            ┌──────▼────────┐        ┌──────▼──────────┐
            │ NO Customer   │        │  HAS Customer   │
            │ (Regular)     │        │  (Pay-Later)    │
            └───────────────┘        └─────────────────┘
```

---

## 🔍 Ejemplos de Clasificación

### ✅ Pay-Later Orders (Se clasifican como pay-later)

#### Ejemplo 1: DINE_IN Pay-Later

```json
{
  "id": "order-1",
  "orderNumber": "ORD-001",
  "paymentStatus": "PENDING",
  "remainingBalance": 100.0,
  "orderCustomers": [{ "customerId": "cust-1", "customer": { "firstName": "Juan" } }],
  "orderType": "DINE_IN"
}
```

**Resultado**: ✅ **Pay-Later** (PENDING + tiene customer)

---

#### Ejemplo 2: TAKEOUT Pay-Later (Partial Payment)

```json
{
  "id": "order-2",
  "orderNumber": "ORD-002",
  "paymentStatus": "PARTIAL",
  "total": 200.0,
  "paidAmount": 50.0,
  "remainingBalance": 150.0,
  "orderCustomers": [{ "customerId": "cust-2" }],
  "orderType": "TAKEOUT"
}
```

**Resultado**: ✅ **Pay-Later** (PARTIAL + tiene customer + saldo pendiente)

---

### ❌ Regular Orders (NO son pay-later)

#### Ejemplo 3: Regular DINE_IN (Sin customer)

```json
{
  "id": "order-3",
  "orderNumber": "ORD-003",
  "paymentStatus": "PENDING",
  "remainingBalance": 100.0,
  "orderCustomers": [], // ← NO customer
  "orderType": "DINE_IN"
}
```

**Resultado**: ❌ **Regular** (PENDING pero SIN customer)

---

#### Ejemplo 4: Regular TAKEOUT (Sin customer)

```json
{
  "id": "order-4",
  "orderNumber": "ORD-004",
  "paymentStatus": "PENDING",
  "remainingBalance": 50.0,
  "orderCustomers": [], // ← NO customer
  "orderType": "TAKEOUT"
}
```

**Resultado**: ❌ **Regular** (Típico TAKEOUT para pagar al recoger)

---

#### Ejemplo 5: Orden Pagada (Tiene customer pero PAID)

```json
{
  "id": "order-5",
  "orderNumber": "ORD-005",
  "paymentStatus": "PAID",
  "remainingBalance": 0.0,
  "orderCustomers": [{ "customerId": "cust-1" }]
}
```

**Resultado**: ❌ **NO Pay-Later** (Tiene customer pero ya está PAID)

---

## 🛡️ ¿Por Qué NO Interfiere con Otras Funciones?

### 1️⃣ **Backward Compatibility Total**

El sistema usa **filtros opcionales** que NO cambian el comportamiento default:

```typescript
// ANTES (sigue funcionando igual)
getOrders(venueId)
// → Retorna PENDING/PARTIAL SIN customer (regular orders)

// NUEVO (opt-in)
getOrders(venueId, { onlyPayLater: true })
// → Retorna PENDING/PARTIAL CON customer (pay-later orders)

getOrders(venueId, { includePayLater: true })
// → Retorna TODOS (regular + pay-later)
```

**Resultado**: ✅ Código existente **no se rompe**, funciona igual que antes.

---

### 2️⃣ **Separación Explícita por Customer Linkage**

La clave está en `OrderCustomer` (junction table):

| Escenario                      | Payment Status | OrderCustomer              | Clasificación |
| ------------------------------ | -------------- | -------------------------- | ------------- |
| Mesa 5, sin cliente registrado | PENDING        | `[]` (vacío)               | **Regular**   |
| Mesa 5, cliente "Juan"         | PENDING        | `[{customerId: "cust-1"}]` | **Pay-Later** |
| Takeout sin cliente            | PENDING        | `[]` (vacío)               | **Regular**   |
| Takeout cliente "María"        | PENDING        | `[{customerId: "cust-2"}]` | **Pay-Later** |

**Resultado**: ✅ Mismo `paymentStatus`, pero **diferente contexto de negocio**.

---

### 3️⃣ **Filtros en Queries, No en Estado**

El filtro se aplica en **Prisma WHERE clause**, no modificando el estado de la orden:

```typescript
// FILTRO DEFAULT: Excluye pay-later
prisma.order.findMany({
  where: {
    venueId,
    paymentStatus: { in: ['PENDING', 'PARTIAL'] },
    orderCustomers: { none: {} }, // ← Filtro: NO customer
  },
})

// FILTRO PAY-LATER: Solo pay-later
prisma.order.findMany({
  where: {
    venueId,
    paymentStatus: { in: ['PENDING', 'PARTIAL'] },
    orderCustomers: { some: {} }, // ← Filtro: HAS customer
  },
})
```

**Resultado**: ✅ La orden **NO cambia**, solo cambia qué órdenes se retornan.

---

### 4️⃣ **No Hay Nuevos Estados de Payment**

**NO creamos** un nuevo `PaymentStatus`:

- ❌ NO: `PaymentStatus.PAY_LATER`
- ✅ SÍ: Sigue siendo `PaymentStatus.PENDING` o `PARTIAL`

**Ventaja**:

- Todo el código existente que valida `paymentStatus === 'PENDING'` sigue funcionando
- No hay migraciones de base de datos
- No hay cambios en lógica de transición de estados

---

### 5️⃣ **Propiedad Calculada, No Persistida**

En el TPV Android, `isPayLater` es una **propiedad calculada**:

```kotlin
data class Order(...) {
    val isPayLater: Boolean
        get() = orderCustomers.isNotEmpty() &&
                paymentStatus in listOf(PaymentStatus.PENDING, PaymentStatus.PARTIAL)
}
```

**NO se guarda** en la base de datos como campo separado.

**Ventaja**:

- No hay riesgo de desincronización
- Siempre refleja el estado actual
- No afecta queries existentes

---

## 🔄 Flujos de Negocio

### Flujo 1: Crear Order Regular (DINE_IN)

```
1. Mesero crea orden en Mesa 5
2. Agrega items (Pizza $100)
3. Envía a cocina
4. Cliente termina de comer
5. Procesa pago → paymentStatus = PAID

Estado: PENDING → PAID
Customer: NUNCA vinculado
Clasificación: Siempre REGULAR
```

---

### Flujo 2: Crear Order Pay-Later

```
1. Mesero crea orden en Mesa 7
2. Agrega items (Hamburguesa $80)
3. Click "Pagar Después"
4. Selecciona customer "Juan Pérez"
5. OrderCustomer creado → order linked to customer

Estado: PENDING
Customer: Juan Pérez
Clasificación: PAY-LATER
```

---

### Flujo 3: Pagar Order Pay-Later (Completo)

```
1. Juan regresa días después
2. Mesero busca orden en filtro "Pendientes de Pago"
3. Procesa pago completo
4. paymentStatus → PAID
5. remainingBalance → 0

Estado: PAID
Customer: Sigue vinculado (histórico)
Clasificación: YA NO PAY-LATER (está PAID)
```

---

### Flujo 4: Pagar Order Pay-Later (Parcial)

```
1. Juan paga $30 de $80
2. paidAmount = 30
3. remainingBalance = 50
4. paymentStatus = PARTIAL

Estado: PARTIAL
Customer: Juan Pérez
Clasificación: SIGUE SIENDO PAY-LATER
```

---

## 🎛️ Impacto en Funciones Existentes

### ✅ TPV: Order List Screen

**Antes**:

```kotlin
// Mostraba TODAS las órdenes PENDING/PARTIAL
getOrders() → [Order1(PENDING), Order2(PENDING)]
```

**Después**:

```kotlin
// Por default: Solo regular (backward compatible)
getOrders() → [Order1(PENDING, no customer)]

// Nuevo filtro: Solo pay-later
getOrders(onlyPayLater: true) → [Order2(PENDING, with customer)]
```

**Impacto**: ✅ **Ninguno** si no usas el filtro nuevo.

---

### ✅ Dashboard: Orders API

**Antes**:

```typescript
// GET /api/v1/dashboard/venues/:venueId/orders
// Retornaba todas las órdenes PENDING/PARTIAL
```

**Después**:

```typescript
// Mismo endpoint, mismo comportamiento
// Backend decide si incluir/excluir pay-later
// Frontend usa filtro local para toggle
```

**Impacto**: ✅ **Ninguno** en la API existente.

---

### ✅ Reports & Analytics

**Antes**:

```sql
SELECT COUNT(*) FROM orders WHERE paymentStatus = 'PENDING'
```

**Después**:

```sql
-- Regular orders (sin customer)
SELECT COUNT(*) FROM orders
WHERE paymentStatus = 'PENDING'
AND id NOT IN (SELECT orderId FROM order_customers)

-- Pay-later orders (con customer)
SELECT COUNT(*) FROM orders
WHERE paymentStatus = 'PENDING'
AND id IN (SELECT orderId FROM order_customers)
```

**Impacto**: ✅ **Mejora** la visibilidad, no rompe reportes existentes.

---

## 🚨 Edge Cases Manejados

### Edge Case 1: Orden con Customer, luego se PAGA

```
Orden: PENDING + Customer → Pay-Later ✅
Pago: PAID + Customer (histórico) → NO Pay-Later ❌
```

**Solución**: El filtro verifica `paymentStatus` primero.

---

### Edge Case 2: Orden PARTIAL sin Customer

```
Orden: PARTIAL + NO Customer → Regular ❌
```

**Razón**: PARTIAL sin customer = pago parcial regular (no pay-later).

---

### Edge Case 3: Orden con Multiple Customers

```
Orden: PENDING + 2 Customers → Pay-Later ✅
```

**Solución**: `orderCustomers.some({})` matchea si hay al menos 1.

---

### Edge Case 4: Remover Customer de Orden Pay-Later

```
Antes: PENDING + Customer → Pay-Later ✅
Después: PENDING + NO Customer → Regular ❌
```

**Solución**: La clasificación se recalcula automáticamente (propiedad calculada).

---

## 📝 Summary

### ¿Cómo se clasifica una orden como Pay-Later?

```
PENDING/PARTIAL + Customer + remainingBalance > 0 = Pay-Later
```

### ¿Interfiere con otras funciones?

**NO**, porque:

1. ✅ Usa filtros opcionales (opt-in)
2. ✅ No crea nuevos estados de payment
3. ✅ Backward compatible al 100%
4. ✅ Propiedad calculada, no persistida
5. ✅ Separación clara por customer linkage

### ¿Qué pasa con código existente?

```typescript
// Este código sigue funcionando EXACTAMENTE igual
const orders = await getOrders(venueId)
// → Retorna órdenes PENDING/PARTIAL sin customer (regular)
```

---

**Conclusión**: La clasificación pay-later es **transparente** para el resto del sistema. Solo afecta cuando **explícitamente** usas los
nuevos filtros.

---

---

## 🖥️ Client-Side Implementation (Android TPV)

### Critical Bug Fix (2025-12-22)

**Issue**: PAY_LATER filter showed empty even with 3 pay-later orders in database.

**Root Cause**: `orderCustomers` field NOT mapped in Android DTO

- ❌ `OrderDto` (TableDto.kt) missing `orderCustomers` field
- ❌ Gson silently dropped the field during JSON parsing
- ❌ `order.isPayLater` always returned `false` (orderCustomers was empty)

**Solution**:

```kotlin
// TableDto.kt - Added field
@SerializedName("orderCustomers") val orderCustomers: List<OrderCustomerDto>? = null

// OrderMappers.kt - Added mapping
orderCustomers = orderCustomers?.map { it.toOrderCustomer() } ?: emptyList()
```

**Impact**: ✅ PAY_LATER filter now works correctly, shows all pay-later orders.

---

### UI Enhancement: Dual Banner System

**Feature**: Differentiated banners for UNPAID_TAKEOUT vs PAY_LATER orders

| Banner             | Color                      | Icon          | Label                       | Priority |
| ------------------ | -------------------------- | ------------- | --------------------------- | -------- |
| **UNPAID_TAKEOUT** | 🔴 Red (errorContainer)    | Warning       | "Órdenes rápidas sin pagar" | High     |
| **PAY_LATER**      | 🔵 Blue (primaryContainer) | AccountCircle | "Cuentas por cobrar"        | Medium   |

**Visual Hierarchy**:

```
┌─────────────────────────────────────────────────┐
│ 🔴 Hay 2 órdenes rápidas sin pagar             │  ← Red (urgent)
├─────────────────────────────────────────────────┤
│ 🔵 Hay 3 cuentas por cobrar                    │  ← Blue (tracking)
├─────────────────────────────────────────────────┤
│  Nueva Orden (Quick Order / Table Service)     │
└─────────────────────────────────────────────────┘
```

**Implementation**:

- Component: `PayLaterBanner.kt`
- ViewModel: `OrderingWelcomeViewModel.kt` (payLaterCount state)
- Navigation: Taps navigate to OrderListScreen with PAY_LATER filter

**Full docs**: See `avoqado-tpv/docs/PAY_LATER_IMPLEMENTATION.md`

---

**Author**: Claude Code (Sonnet 4.5) **Last Updated**: 2025-12-22 **Version**: 1.1 (Added client implementation notes) **Status**: ✅
Production Ready
