# Socket.IO End-to-End Testing Guide (Manual)

## FASE 1.E - Verificación Completa

> **Purpose**: Verify Socket.IO events are correctly broadcasted from server to Android TPV and Web Dashboard

---

## ✅ Pre-requisites

**Server Running:**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npm run dev
# Server should be running on http://localhost:3000
```

**Test Venue:** `avoqado-full` (ID: `cmhtrvsvk00ad9krx8gb9jgbq`)

---

## 🧪 Test Flow

### Setup: Prepare 3 Terminals

**Terminal 1: Server Logs**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
# Find latest log file
ls -t logs/development*.log | head -1
# Tail the log
tail -f logs/development7.log  # Replace with actual latest number
```

**Terminal 2: Android Logs (if testing Android)**

```bash
# Connect Android device/emulator
adb devices

# Filter for Socket.IO events (look for 🍽️ 💰 📂 emojis)
adb logcat -s Timber | grep -E "🍽️|💰|📂|Socket"
```

**Terminal 3: Web Dashboard (if testing Web)**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard
npm run dev
# Open http://localhost:5173
# Open DevTools → Console
# Login to venue: avoqado-full
```

---

## Test 1: Product Creation (menu_item_created)

### Step 1: Open Dashboard

1. Navigate to: `http://localhost:5173/venues/avoqado-full/menu`
2. Open DevTools → Console
3. Ensure Socket.IO connection is established (look for connection logs)

### Step 2: Create Product via UI

1. Click "Crear Producto"
2. Fill form:
   - Name: `Test Socket ${Date.now()}`
   - Category: `Tacos Mexicanos`
   - Price: `99.99`
   - SKU: `TEST-SOCKET-001`
3. Click "Guardar"

### Expected Results

**✅ Server Logs (Terminal 1):**

```
🔌 Product created broadcasted {
  venueId: 'cmhtrvsvk00ad9krx8gb9jgbq',
  itemId: '...',
  itemName: 'Test Socket ...',
  price: 99.99
}
```

**✅ Android Logs (Terminal 2 - if Android connected):**

```
🍽️ Menu item created: Test Socket ...
🍽️ Menu updated: FULL_REFRESH (reason=ITEM_ADDED)
```

**✅ Web Console (Terminal 3 - if dashboard open):**

```javascript
[Socket.IO] menu_item_created {
  itemId: "...",
  itemName: "Test Socket ...",
  price: 99.99,
  categoryId: "cmhtrvtdx00gk9krxcyo4zpah"
}

[Socket.IO] menu_updated {
  updateType: "FULL_REFRESH",
  reason: "ITEM_ADDED",
  venueId: "cmhtrvsvk00ad9krx8gb9jgbq"
}
```

---

## Test 2: Price Change (product_price_changed)

### Step 1: Edit Product Price

1. Find the product you just created in the menu list
2. Click "Editar"
3. Change price from `99.99` → `149.99`
4. Click "Guardar"

### Expected Results

**✅ Server Logs:**

```
🔌 Product price changed broadcasted {
  productName: 'Test Socket ...',
  oldPrice: 99.99,
  newPrice: 149.99,
  priceChange: 50,
  priceChangePercent: 50.05
}
```

**✅ Android Logs:**

```
💰 Price changed: Test Socket ... 99.99 -> 149.99
🍽️ Menu item updated: Test Socket ...
🍽️ Menu updated: PARTIAL_UPDATE (reason=PRICE_CHANGE)
```

**✅ Web Console:**

```javascript
[Socket.IO] product_price_changed {
  productId: "...",
  productName: "Test Socket ...",
  oldPrice: 99.99,
  newPrice: 149.99,
  priceChange: 50,
  priceChangePercent: 50.05
}

[Socket.IO] menu_updated {
  updateType: "PARTIAL_UPDATE",
  reason: "PRICE_CHANGE"
}
```

---

## Test 3: Availability Change (menu_item_availability_changed)

### Step 1: Toggle Product Availability

1. Find the product in menu list
2. Click the toggle switch to make it unavailable (active: false)

### Expected Results

**✅ Server Logs:**

```
🔌 Menu item availability changed broadcasted {
  itemName: 'Test Socket ...',
  available: false,
  previousAvailability: true,
  reason: 'MANUAL'
}
```

**✅ Android Logs:**

```
🍽️ Item availability changed: Test Socket ... → available=false
🍽️ Menu updated: PARTIAL_UPDATE (reason=AVAILABILITY_CHANGE)
```

**✅ Web Console:**

```javascript
[Socket.IO] menu_item_availability_changed {
  itemId: "...",
  itemName: "Test Socket ...",
  available: false,
  previousAvailability: true,
  reason: "MANUAL"
}
```

---

## Test 4: Product Deletion (menu_item_deleted)

### Step 1: Delete Product

1. Find the product in menu list
2. Click "Eliminar"
3. Confirm deletion

### Expected Results

**✅ Server Logs:**

```
🔌 Menu item deleted broadcasted {
  itemName: 'Test Socket ...',
  itemId: '...'
}
```

**✅ Android Logs:**

```
🍽️ Menu item deleted: Test Socket ...
🍽️ Menu updated: FULL_REFRESH (reason=ITEM_REMOVED)
```

**✅ Web Console:**

```javascript
[Socket.IO] menu_item_deleted {
  itemId: "...",
  itemName: "Test Socket ..."
}

[Socket.IO] menu_updated {
  updateType: "FULL_REFRESH",
  reason: "ITEM_REMOVED"
}
```

---

## Test 5: Category Updates (menu_category_updated)

### Step 1: Create Category

1. Navigate to menu categories section
2. Click "Crear Categoría"
3. Fill:
   - Name: `Test Category Socket`
   - Display Order: `99`
4. Click "Guardar"

### Expected Results

**✅ Server Logs:**

```
🔌 Menu category updated broadcasted {
  categoryName: 'Test Category Socket',
  action: 'CREATED'
}
```

**✅ Android Logs:**

```
📂 Category updated: Test Category Socket (action=CREATED)
```

**✅ Web Console:**

```javascript
[Socket.IO] menu_category_updated {
  categoryId: "...",
  categoryName: "Test Category Socket",
  action: "CREATED",
  displayOrder: 99
}
```

---

## Test 6: Payment Events (payment_completed, payment_processing)

### Prerequisites

- Active order in the system
- TPV terminal connected

### Step 1: Process Payment

1. Select an open order
2. Click "Procesar Pago"
3. Enter amount: `150.00`
4. Select payment method: `CARD`
5. Complete payment

### Expected Results

**✅ Server Logs:**

```
🔌 Payment processing broadcasted {
  paymentId: '...',
  orderId: '...',
  amount: 15000,  // cents
  status: 'processing'
}

🔌 Payment completed broadcasted {
  paymentId: '...',
  orderId: '...',
  amount: 15000,
  status: 'completed',
  metadata: { cardBrand: 'VISA', last4: '4242' }
}
```

**✅ Android Logs:**

```
💳 Payment processing: paymentId=...
💳 Payment completed: paymentId=...
```

**✅ Web Console:**

```javascript
[Socket.IO] payment_processing {
  paymentId: "...",
  orderId: "...",
  amount: 15000,
  method: "CARD",
  status: "processing"
}

[Socket.IO] payment_completed {
  paymentId: "...",
  orderId: "...",
  amount: 15000,
  status: "completed",
  metadata: { cardBrand: "VISA", last4: "4242" }
}
```

---

## ✅ Success Criteria

### All Tests Must Pass:

- [ ] `menu_item_created` event received after product creation
- [ ] `product_price_changed` event received after price update
- [ ] `menu_item_availability_changed` event received after availability toggle
- [ ] `menu_item_deleted` event received after product deletion
- [ ] `menu_category_updated` event received after category creation
- [ ] `menu_updated` general event received for all menu changes
- [ ] `payment_processing` event received during payment
- [ ] `payment_completed` event received after payment success
- [ ] Events received by BOTH Android and Web (if both connected)
- [ ] No JSON parsing errors in Android logs
- [ ] No console errors in Web dashboard
- [ ] Server logs confirm broadcasts sent

---

## ❌ Troubleshooting

### Event Not Received?

**Check 1: Socket.IO Connection**

```javascript
// Web Console
window.socket.connected // Should be true

// Android Logcat
// Look for: ✅ Socket.IO Connected
```

**Check 2: Room Membership**

```javascript
// Web Console - check if joined room
// Look for: "Joined room: venue_cmhtrvsvk00ad9krx8gb9jgbq"

// Android Logcat
// Look for: 🚪 Joined venue room: cmhtrvsvk00ad9krx8gb9jgbq
```

**Check 3: Server Broadcast**

```bash
# Server logs should show:
# 🔌 Product created broadcasted
# If NOT showing → Broadcasting service not initialized
```

### JSON Parsing Errors (Android)

```
❌ Error parsing menu_item_created
```

**Cause**: Mismatch between server payload and Android SocketEvent data class

**Fix**: Compare payload structure:

- Server: `src/communication/sockets/types/index.ts`
- Android: `app/.../SocketEvent.kt`

### Events Delayed/Missing

**Cause**: Network latency or Socket.IO reconnection

**Fix**:

1. Check network connection
2. Verify no firewall blocking WebSocket
3. Check server uptime: `lsof -i :3000`

---

## 📊 Test Results Template

```
## Socket.IO End-to-End Test Results
Date: ___________
Tester: __________

### Environment
- [x] Server running on port 3000
- [x] Android TPV connected (if applicable)
- [x] Web dashboard open (if applicable)

### Test Results

| Test | Server Broadcast | Android Received | Web Received | Status |
|------|-----------------|------------------|--------------|--------|
| Product Created | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Price Changed | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Availability Changed | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Product Deleted | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Category Updated | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Payment Processing | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |
| Payment Completed | ✅/❌ | ✅/❌ | ✅/❌ | PASS/FAIL |

### Overall Result
- Tests Passed: ____ / 7
- Success Rate: ____%
- Production Ready: YES / NO

### Notes
_________________________________________
_________________________________________
```

---

## 🚀 Next Steps After Testing

If all tests pass:

- ✅ FASE 1.E Complete
- ✅ Ready for FASE 2: Bidirectional sync (Android → Server)

If tests fail:

- 🔍 Review server broadcast logs
- 🔍 Check Android/Web event listener registration
- 🔍 Verify payload structure matches across platforms
- 🔍 Consult `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/SOCKET_TESTING_PLAN.md`
