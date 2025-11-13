# Socket.IO End-to-End Testing Plan

## FASE 1.E - Verificación de Eventos en Tiempo Real

### Objetivo

Verificar que los eventos de Socket.IO se transmitan correctamente desde el servidor hacia Android TPV y Web Dashboard cuando ocurren
cambios en productos, categorías y pagos.

---

## 1. EVENTOS DE MENÚ

### Test 1.1: Crear Producto (MENU_ITEM_CREATED)

**Endpoint:** `POST /api/dashboard/venues/:venueId/products`

**Payload de prueba:**

```json
{
  "name": "Test Product Socket",
  "description": "Testing Socket.IO events",
  "price": 99.99,
  "sku": "TEST-SOCKET-001",
  "categoryId": "<existing-category-id>",
  "active": true
}
```

**Eventos esperados:**

- ✅ `menu_item_created` → Android TPV
- ✅ `menu_item_created` → Web Dashboard
- ✅ `menu_updated` (FULL_REFRESH) → Ambos

**Verificación:**

- [ ] Android: Timber log `🍽️ Menu item created: Test Product Socket`
- [ ] Web: Console log del hook `useMenuSocketEvents`
- [ ] Server: Winston log `Product created broadcasted`

---

### Test 1.2: Actualizar Precio (PRODUCT_PRICE_CHANGED)

**Endpoint:** `PATCH /api/dashboard/venues/:venueId/products/:productId`

**Payload de prueba:**

```json
{
  "price": 149.99
}
```

**Eventos esperados:**

- ✅ `product_price_changed` → Android TPV
- ✅ `product_price_changed` → Web Dashboard
- ✅ `menu_item_updated` → Ambos
- ✅ `menu_updated` (PARTIAL_UPDATE, reason: PRICE_CHANGE) → Ambos

**Verificación:**

- [ ] Android: Timber log `💰 Price changed: Test Product Socket 99.99 -> 149.99`
- [ ] Web: Console log con `priceChange: 50.00, priceChangePercent: 50.05`
- [ ] Server: Winston log `Product price changed broadcasted`

---

### Test 1.3: Cambiar Disponibilidad (MENU_ITEM_AVAILABILITY_CHANGED)

**Endpoint:** `PATCH /api/dashboard/venues/:venueId/products/:productId`

**Payload de prueba:**

```json
{
  "active": false
}
```

**Eventos esperados:**

- ✅ `menu_item_availability_changed` → Android TPV
- ✅ `menu_item_availability_changed` → Web Dashboard
- ✅ `menu_item_updated` → Ambos
- ✅ `menu_updated` (PARTIAL_UPDATE, reason: AVAILABILITY_CHANGE) → Ambos

**Verificación:**

- [ ] Android: Timber log `🍽️ Item availability changed: Test Product Socket → available=false`
- [ ] Web: Console log con `available: false, previousAvailability: true`
- [ ] Server: Winston log `Menu item availability changed broadcasted`

---

### Test 1.4: Eliminar Producto (MENU_ITEM_DELETED)

**Endpoint:** `DELETE /api/dashboard/venues/:venueId/products/:productId`

**Eventos esperados:**

- ✅ `menu_item_deleted` → Android TPV
- ✅ `menu_item_deleted` → Web Dashboard
- ✅ `menu_updated` (FULL_REFRESH, reason: ITEM_REMOVED) → Ambos

**Verificación:**

- [ ] Android: Timber log `🍽️ Menu item deleted: Test Product Socket`
- [ ] Web: Console log del evento de eliminación
- [ ] Server: Winston log `Menu item deleted broadcasted`

---

### Test 1.5: Crear Categoría (MENU_CATEGORY_UPDATED)

**Endpoint:** `POST /api/dashboard/venues/:venueId/menu-categories`

**Payload de prueba:**

```json
{
  "name": "Test Category Socket",
  "description": "Testing category events",
  "active": true,
  "displayOrder": 99
}
```

**Eventos esperados:**

- ✅ `menu_category_updated` (action: CREATED) → Android TPV
- ✅ `menu_category_updated` (action: CREATED) → Web Dashboard
- ✅ `menu_updated` (FULL_REFRESH, reason: CATEGORY_UPDATED) → Ambos

**Verificación:**

- [ ] Android: Timber log `📂 Category updated: Test Category Socket (action=CREATED)`
- [ ] Web: Console log con `action: 'CREATED'`
- [ ] Server: Winston log `Menu category updated broadcasted`

---

### Test 1.6: Eliminar Categoría (MENU_CATEGORY_DELETED)

**Endpoint:** `DELETE /api/dashboard/venues/:venueId/menu-categories/:categoryId`

**Eventos esperados:**

- ✅ `menu_category_deleted` → Android TPV
- ✅ `menu_category_deleted` → Web Dashboard
- ✅ `menu_updated` (FULL_REFRESH, reason: CATEGORY_UPDATED) → Ambos

**Verificación:**

- [ ] Android: Timber log `📂 Category deleted: Test Category Socket`
- [ ] Web: Console log del evento de eliminación
- [ ] Server: Winston log `Menu category deleted broadcasted`

---

## 2. EVENTOS DE PAGO

### Test 2.1: Pago Exitoso (PAYMENT_COMPLETED)

**Endpoint:** `POST /api/tpv/orders/:orderId/payments`

**Payload de prueba:**

```json
{
  "amount": 150.0,
  "tipAmount": 15.0,
  "method": "CARD",
  "status": "COMPLETED",
  "cardBrand": "VISA",
  "last4": "4242"
}
```

**Eventos esperados:**

- ✅ `payment_completed` → Android TPV
- ✅ `payment_completed` → Web Dashboard

**Verificación:**

- [ ] Android: Timber log `💳 Payment completed: paymentId`
- [ ] Web: Console log con `status: 'completed', metadata: { cardBrand: 'VISA', last4: '4242' }`
- [ ] Server: Winston log del broadcast

---

### Test 2.2: Pago Procesando (PAYMENT_PROCESSING)

**Endpoint:** `POST /api/tpv/orders/:orderId/payments`

**Payload de prueba:**

```json
{
  "amount": 200.0,
  "method": "CARD",
  "status": "PROCESSING",
  "cardBrand": "MASTERCARD",
  "last4": "5555"
}
```

**Eventos esperados:**

- ✅ `payment_processing` → Android TPV
- ✅ `payment_processing` → Web Dashboard

**Verificación:**

- [ ] Android: Timber log `💳 Payment processing: paymentId`
- [ ] Web: Console log con `status: 'processing'`
- [ ] Server: Winston log del broadcast

---

### Test 2.3: Pago Fallido (PAYMENT_FAILED)

**Endpoint:** `POST /api/tpv/orders/:orderId/payments`

**Payload de prueba:**

```json
{
  "amount": 100.0,
  "method": "CARD",
  "status": "FAILED",
  "cardBrand": "AMEX",
  "last4": "3782"
}
```

**Eventos esperados:**

- ✅ `payment_failed` → Android TPV
- ✅ `payment_failed` → Web Dashboard

**Verificación:**

- [ ] Android: Timber log `💳 Payment failed: paymentId`
- [ ] Web: Console log con `status: 'failed', errorMessage: 'Payment failed during processing'`
- [ ] Server: Winston log del broadcast

---

## 3. CONFIGURACIÓN DE PRUEBAS

### Servidor

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npm run dev
```

### Android TPV

1. Iniciar app en dispositivo/emulador
2. Autenticarse con credenciales válidas
3. Verificar conexión Socket.IO establecida
4. Monitorear logs: `adb logcat -s Timber`

### Web Dashboard

1. Abrir en navegador: `http://localhost:5173`
2. Autenticarse con mismas credenciales
3. Abrir DevTools → Console
4. Verificar logs de Socket.IO

---

## 4. HERRAMIENTAS DE TESTING

### Opción 1: Postman / Insomnia

- Importar requests para cada endpoint
- Configurar variables de entorno (venueId, productId, etc.)

### Opción 2: cURL

```bash
# Crear producto
curl -X POST http://localhost:4000/api/dashboard/venues/<venueId>/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Test Product Socket","price":99.99,"sku":"TEST-001","categoryId":"<catId>","active":true}'

# Actualizar precio
curl -X PATCH http://localhost:4000/api/dashboard/venues/<venueId>/products/<productId> \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"price":149.99}'
```

### Opción 3: Desde Web Dashboard

- Usar la UI del dashboard para crear/actualizar/eliminar productos
- Verificar que Android TPV recibe los eventos

---

## 5. CRITERIOS DE ÉXITO

### ✅ Tests Pasados

- [ ] Todos los eventos de menú se reciben correctamente en Android
- [ ] Todos los eventos de menú se reciben correctamente en Web
- [ ] Todos los eventos de pago se reciben correctamente en Android
- [ ] Todos los eventos de pago se reciben correctamente en Web
- [ ] Logs del servidor confirman broadcasts exitosos
- [ ] Payloads JSON coinciden con interfaces TypeScript/Kotlin
- [ ] No hay errores de parsing en Android/Web
- [ ] Room management funciona (eventos solo llegan al venue correcto)

### ❌ Tests Fallidos

Si algún test falla, verificar:

1. Conexión Socket.IO establecida (`socket.connected === true`)
2. Autenticación correcta (`auth_success` recibido)
3. Venue room joined (`room_joined` recibido)
4. Formato de payload en servidor coincide con cliente
5. Event listeners registrados correctamente
6. No hay errores de TypeScript/Kotlin compilation

---

## 6. PRÓXIMOS PASOS

Después de completar FASE 1.E:

- **FASE 2.A:** Implementar sincronización bidireccional (Android → Server)
- **FASE 2.B:** Agregar persistencia offline con sincronización automática
- **FASE 2.C:** Implementar conflict resolution para ediciones concurrentes
- **FASE 3:** Monitoreo y analytics de eventos Socket.IO en producción
