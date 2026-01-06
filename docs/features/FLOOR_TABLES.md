# Floor Plans & Table Management

## Overview

The Floor Plans system provides visual layout management for venue tables and decorative elements. Tables can be positioned on a canvas, assigned to areas, and track real-time order status. The system supports drag-and-drop positioning, shape customization, and real-time status updates via Socket.IO.

## Business Context

**Key Use Cases:**
- Visual restaurant floor plan design
- Real-time table availability at a glance
- Table assignment for new orders
- Area-based organization (Terraza, Interior, Bar, VIP)
- Capacity management for reservations

**Industry Standards:**
- Toast: "Table Layout" with drag-and-drop
- Square: "Floor Plan" visual editor
- Clover: "Tables & Sections" management

## Database Models

### Area

Areas group tables and floor elements for organization (e.g., "Terraza", "Interior"):

```prisma
model Area {
  id      String @id @default(cuid())
  venueId String

  name        String
  description String?

  tables        Table[]         // Tables in this area
  floorElements FloorElement[]  // Decorative elements

  @@unique([venueId, name])
}
```

### Table

```prisma
model Table {
  id      String @id @default(cuid())
  venueId String

  number   String      // Display number (e.g., "1", "A1", "VIP-1")
  capacity Int         // Seating capacity
  qrCode   String @unique  // For QR ordering
  areaId   String?     // Optional area grouping
  active   Boolean @default(true)

  // Floor plan positioning (normalized 0-1 coordinates)
  positionX Float?
  positionY Float?
  shape     TableShape @default(SQUARE)
  rotation  Int @default(0)  // 0, 90, 180, 270 degrees

  // Real-time status
  status TableStatus @default(AVAILABLE)

  // Current order link (1-to-1 for occupied tables)
  currentOrderId String? @unique
  currentOrder   Order?  @relation("TableCurrentOrder")

  // Order history
  orders Order[] @relation("TableOrderHistory")
}
```

### TableShape Enum

```prisma
enum TableShape {
  SQUARE     // 2-4 person square table
  ROUND      // Round table
  RECTANGLE  // Long table (6+ people)
}
```

### TableStatus Enum

```prisma
enum TableStatus {
  AVAILABLE  // Free, can be assigned
  OCCUPIED   // Has active order
  RESERVED   // Reserved for future
  CLEANING   // Being cleaned/prepared
}
```

### FloorElement

Decorative/structural elements on the floor plan:

```prisma
model FloorElement {
  id      String @id @default(cuid())
  venueId String
  areaId  String?

  type FloorElementType

  // GLOBAL coordinates (0.0 - 1.0, relative to entire venue)
  positionX Float
  positionY Float

  // For rectangular elements (BAR_COUNTER, SERVICE_AREA)
  width    Float?  // 0.0 - 1.0
  height   Float?  // 0.0 - 1.0
  rotation Int @default(0)

  // For WALL (line from start to end)
  endX Float?
  endY Float?

  // Metadata
  label  String?  // "Cocina", "Baño", "Entrada"
  color  String?  // Hex color (e.g., "#424242")
  active Boolean @default(true)
}
```

### FloorElementType Enum

```prisma
enum FloorElementType {
  WALL          // Decorative/dividing wall
  BAR_COUNTER   // Bar counter
  SERVICE_AREA  // Kitchen, bathroom, storage
  LABEL         // Decorative text (e.g., "Terraza", "VIP")
  DOOR          // Door/entrance
}
```

## Architecture

### Coordinate System

All positions use **normalized coordinates (0.0 - 1.0)** relative to the venue canvas:

```
(0,0) ─────────────────────────── (1,0)
  │                                 │
  │         Canvas Area             │
  │                                 │
  │    Table at (0.3, 0.4)          │
  │         ┌───┐                   │
  │         │ 1 │                   │
  │         └───┘                   │
  │                                 │
(0,1) ─────────────────────────── (1,1)
```

**Why normalized coordinates?**
- Canvas can be any size on different screens
- Positions scale automatically with canvas resize
- Consistent across TPV, dashboard, and mobile

### Table State Machine

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Table Status Flow                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────┐                                                      │
│  │ AVAILABLE │ ◀──────────────────────────────────────┐             │
│  └───────────┘                                        │             │
│        │                                              │             │
│        │ assignTable()                    clearTable()│             │
│        ▼                                   (after payment)          │
│  ┌───────────┐                                        │             │
│  │ OCCUPIED  │ ───────────────────────────────────────┘             │
│  └───────────┘                                                      │
│        │                                                            │
│        │ (optional: mark for cleaning)                              │
│        ▼                                                            │
│  ┌───────────┐                                                      │
│  │ CLEANING  │ ─────────► AVAILABLE                                 │
│  └───────────┘                                                      │
│                                                                      │
│  ┌───────────┐                                                      │
│  │ RESERVED  │  (Future: reservation system)                        │
│  └───────────┘                                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Service Layer

### Table Service

**File:** `src/services/tpv/table.tpv.service.ts`

```typescript
// Get all tables with current status and orders
export async function getTablesWithStatus(venueId: string): Promise<TableStatusResponse[]>

// Assign table to start new order (or return existing)
export async function assignTable(
  venueId: string,
  tableId: string,
  staffId: string,
  covers: number
): Promise<{ order: Order; isNewOrder: boolean }>

// Clear table after payment
export async function clearTable(venueId: string, tableId: string): Promise<void>

// CRUD operations
export async function createTable(venueId: string, data: CreateTableData): Promise<TableStatusResponse>
export async function updateTable(venueId: string, tableId: string, data: UpdateTableData): Promise<TableStatusResponse>
export async function updateTablePosition(venueId: string, tableId: string, x: number, y: number): Promise<...>
export async function deleteTable(venueId: string, tableId: string): Promise<void>
```

### Floor Element Service

**File:** `src/services/tpv/floor-element.tpv.service.ts`

```typescript
// Get decorative elements for floor plan
export async function getFloorElements(venueId: string): Promise<FloorElementResponse[]>

// CRUD operations
export async function createFloorElement(venueId: string, data: CreateFloorElementData): Promise<FloorElementResponse>
export async function updateFloorElement(venueId: string, elementId: string, data: UpdateFloorElementData): Promise<...>
export async function deleteFloorElement(venueId: string, elementId: string): Promise<void>
```

## Real-Time Updates

### Socket.IO Events

Table status changes broadcast via Socket.IO for real-time floor plan updates:

```typescript
// Event: TABLE_STATUS_CHANGE
socketManager.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
  tableId: "table_123",
  tableNumber: "5",
  status: "OCCUPIED",
  orderId: "order_456",
  orderNumber: "ORD-1704567890123",
  covers: 4,
  waiter: {
    id: "staff_789",
    name: "Juan García"
  }
})
```

**When events fire:**
- `assignTable()` → AVAILABLE → OCCUPIED
- `clearTable()` → OCCUPIED → AVAILABLE

## API Endpoints

### Tables

```
GET    /api/v1/tpv/venues/:venueId/tables
POST   /api/v1/tpv/venues/:venueId/tables
GET    /api/v1/tpv/venues/:venueId/tables/:tableId
PATCH  /api/v1/tpv/venues/:venueId/tables/:tableId
DELETE /api/v1/tpv/venues/:venueId/tables/:tableId
PATCH  /api/v1/tpv/venues/:venueId/tables/:tableId/position
POST   /api/v1/tpv/venues/:venueId/tables/:tableId/assign
POST   /api/v1/tpv/venues/:venueId/tables/:tableId/clear
```

### Floor Elements

```
GET    /api/v1/tpv/venues/:venueId/floor-elements
POST   /api/v1/tpv/venues/:venueId/floor-elements
PATCH  /api/v1/tpv/venues/:venueId/floor-elements/:elementId
DELETE /api/v1/tpv/venues/:venueId/floor-elements/:elementId
```

### Areas

```
GET    /api/v1/dashboard/venues/:venueId/areas
POST   /api/v1/dashboard/venues/:venueId/areas
PATCH  /api/v1/dashboard/venues/:venueId/areas/:areaId
DELETE /api/v1/dashboard/venues/:venueId/areas/:areaId
```

## Request/Response Examples

### Get Tables with Status

```json
// GET /api/v1/tpv/venues/:venueId/tables

[
  {
    "id": "table_abc",
    "number": "1",
    "capacity": 4,
    "positionX": 0.2,
    "positionY": 0.3,
    "shape": "SQUARE",
    "rotation": 0,
    "status": "OCCUPIED",
    "areaId": "area_xyz",
    "areaName": "Terraza",
    "currentOrder": {
      "id": "order_123",
      "orderNumber": "ORD-1704567890123",
      "covers": 3,
      "total": 450.00,
      "itemCount": 5,
      "items": [
        {
          "id": "item_1",
          "productName": "Tacos de Asada",
          "quantity": 2,
          "unitPrice": 85.00,
          "total": 170.00
        }
      ],
      "waiter": {
        "id": "staff_789",
        "name": "María López"
      },
      "createdAt": "2025-01-06T14:30:00Z"
    }
  },
  {
    "id": "table_def",
    "number": "2",
    "capacity": 2,
    "positionX": 0.5,
    "positionY": 0.3,
    "shape": "ROUND",
    "rotation": 0,
    "status": "AVAILABLE",
    "areaId": "area_xyz",
    "areaName": "Terraza",
    "currentOrder": null
  }
]
```

### Assign Table

```json
// POST /api/v1/tpv/venues/:venueId/tables/:tableId/assign
{
  "staffId": "staff_123",
  "covers": 4
}

// Response
{
  "order": {
    "id": "order_new",
    "orderNumber": "ORD-1704567890500",
    "covers": 4,
    "status": "PENDING",
    "paymentStatus": "PENDING"
  },
  "isNewOrder": true
}
```

### Create Floor Element

```json
// POST /api/v1/tpv/venues/:venueId/floor-elements
{
  "type": "WALL",
  "positionX": 0.1,
  "positionY": 0.2,
  "endX": 0.1,
  "endY": 0.8,
  "color": "#424242",
  "label": "Pared Norte"
}

// Response
{
  "id": "elem_abc",
  "type": "WALL",
  "positionX": 0.1,
  "positionY": 0.2,
  "endX": 0.1,
  "endY": 0.8,
  "width": null,
  "height": null,
  "rotation": 0,
  "label": "Pared Norte",
  "color": "#424242",
  "areaId": null,
  "active": true
}
```

## Validation Rules

### Table Validation

| Field | Rule |
|-------|------|
| `number` | Must be unique within venue |
| `capacity` | Must be ≥ 1 |
| `positionX/Y` | Must be 0.0 - 1.0 |
| `shape` | Must be SQUARE, ROUND, or RECTANGLE |
| `areaId` | Must exist in venue if provided |

### Floor Element Validation

| Element Type | Required Fields |
|--------------|-----------------|
| `WALL` | positionX, positionY, endX, endY |
| `BAR_COUNTER` | positionX, positionY, width, height |
| `SERVICE_AREA` | positionX, positionY, width, height |
| `LABEL` | positionX, positionY |
| `DOOR` | positionX, positionY |

## Error Handling

| Error | Cause | HTTP Status |
|-------|-------|-------------|
| `Table number X already exists` | Duplicate table number | 400 |
| `Table not found in venue` | Invalid tableId | 404 |
| `Cannot clear table with unpaid order` | Attempting to clear occupied table | 400 |
| `Cannot delete table with active order` | Table has open order | 400 |
| `Invalid coordinates` | Position outside 0-1 range | 400 |
| `WALL elements require endX and endY` | Missing wall endpoints | 400 |

## Testing Scenarios

### Manual Testing

1. **Create floor layout:**
   - Create tables at different positions
   - Add walls, bar counter, labels
   - Verify visual representation

2. **Table workflow:**
   - Assign table → Creates order, status = OCCUPIED
   - Add items to order
   - Complete payment
   - Clear table → status = AVAILABLE

3. **Real-time updates:**
   - Open floor plan on two devices
   - Assign table on device A
   - Verify status updates on device B

### Database Verification

```sql
-- Check tables with orders
SELECT
  t.number,
  t.status,
  t."positionX",
  t."positionY",
  a.name as area_name,
  o."orderNumber",
  o.total
FROM "Table" t
LEFT JOIN "Area" a ON t."areaId" = a.id
LEFT JOIN "Order" o ON t."currentOrderId" = o.id
WHERE t."venueId" = 'your-venue-id'
ORDER BY t.number;

-- Check floor elements
SELECT
  fe.type,
  fe.label,
  fe."positionX",
  fe."positionY",
  fe.width,
  fe.height,
  a.name as area_name
FROM "FloorElement" fe
LEFT JOIN "Area" a ON fe."areaId" = a.id
WHERE fe."venueId" = 'your-venue-id'
  AND fe.active = true;
```

## Related Files

**Backend:**
- `prisma/schema.prisma` - Table, FloorElement, Area models
- `src/services/tpv/table.tpv.service.ts` - Table operations
- `src/services/tpv/floor-element.tpv.service.ts` - Floor element operations
- `src/controllers/tpv/table.tpv.controller.ts` - API handlers
- `src/routes/tpv.routes.ts` - Route definitions

**TPV Android:**
- Floor plan canvas component
- Table drag-and-drop positioning
- Real-time status visualization

**Dashboard:**
- Floor plan editor page
- Area management
- Table CRUD interface

## Future Enhancements

1. **Reservation system:** Reserve tables for future times
2. **Table merging:** Combine tables for large parties
3. **Heatmap analytics:** Visualize table popularity/revenue
4. **Auto-assignment:** Suggest optimal table based on party size
5. **QR code generation:** Print table QR codes for ordering
6. **3D floor plan:** Isometric or 3D view of venue
7. **Multiple floors:** Support multi-level venues
