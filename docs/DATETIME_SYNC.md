# Sincronización de Fechas y Horas entre Frontend y Backend

## 📊 Arquitectura de Fechas en Avoqado

### **Principio Central: Frontend y Backend SIEMPRE en Sincronía**

```
┌─────────────────┐         ┌──────────────────┐         ┌────────────┐
│   Dashboard     │         │  Avoqado Server  │         │ PostgreSQL │
│   (Frontend)    │         │    (Backend)     │         │  Database  │
├─────────────────┤         ├──────────────────┤         ├────────────┤
│                 │         │                  │         │            │
│ Luxon           │  ISO    │  date-fns-tz     │  UTC    │ TIMESTAMP  │
│ useVenueDateTime│ ─────>  │  datetime.ts     │ ─────>  │ WITH       │
│                 │  8601   │  parseDateRange  │  Date   │ TIME ZONE  │
│                 │         │  getVenueDateRange│         │            │
└─────────────────┘         └──────────────────┘         └────────────┘
```

## 🎯 Problema Resuelto

**ANTES:**

```typescript
// Backend (Chatbot)
"This week" → date_trunc('week', NOW())  // Semana calendario (lunes-domingo)
// Dashboard
"Últimos 7 días" → from: NOW() - 7 days  // Últimos 7 días exactos
❌ Resultados DIFERENTES
```

**DESPUÉS:**

```typescript
// Backend (Chatbot)
"This week" → NOW() - INTERVAL '7 days'  // Últimos 7 días exactos
// Dashboard
"Últimos 7 días" → from: NOW() - 7 days  // Últimos 7 días exactos
✅ Resultados IDÉNTICOS
```

## 📁 Archivos Clave

### Frontend

- **`/src/utils/datetime.ts`** - Funciones de Luxon para convertir UTC → Timezone del venue
- **`/src/services/dashboard.progressive.service.ts`** - Envía `toISOString()` al backend

### Backend

- **`/src/utils/datetime.ts`** - Funciones de date-fns-tz (NUEVO) ⭐
- **`/src/services/dashboard/text-to-sql-assistant.service.ts`** - Chatbot usa ejemplos actualizados

## 🔧 Uso del Nuevo Archivo datetime.ts (Backend)

### 1. Recibir fechas del frontend:

```typescript
// Controller
import { parseDateRange } from '@/utils/datetime'

export async function getDashboardData(req: Request, res: Response) {
  const { fromDate, toDate } = req.query // ISO strings from frontend

  // Parse ISO strings → Date objects
  const { from, to } = parseDateRange(fromDate, toDate)

  // Use in Prisma queries (Prisma converts to UTC automatically)
  const orders = await prisma.order.findMany({
    where: {
      venueId: req.params.venueId,
      createdAt: { gte: from, lte: to },
    },
  })

  res.json({ orders })
}
```

### 2. Interpretar rangos relativos para el chatbot:

```typescript
// Text-to-SQL Service
import { getVenueDateRange, getSqlDateFilter } from '@/utils/datetime'

// User asks: "¿cuánto vendí esta semana?"
const venue = await prisma.venue.findUnique({ where: { id: venueId } })

// Option A: Get Date range for backend queries
const range = getVenueDateRange('thisWeek', venue.timezone)
const sales = await prisma.payment.findMany({
  where: {
    venueId,
    createdAt: { gte: range.from, lte: range.to },
  },
})

// Option B: Generate SQL filter for AI chatbot
const sqlFilter = getSqlDateFilter('thisWeek')
// Returns: '"createdAt" >= NOW() - INTERVAL \'7 days\''
```

### 3. Comparar periodos:

```typescript
import { getVenueDateRange } from '@/utils/datetime'

// Current period
const currentPeriod = getVenueDateRange('last7days', venue.timezone)

// Previous period
const previousPeriod = getVenueDateRange('lastWeek', venue.timezone)

// Calculate percentage change
const currentSales = await getSalesTotal(venueId, currentPeriod)
const previousSales = await getSalesTotal(venueId, previousPeriod)
const percentChange = ((currentSales - previousSales) / previousSales) * 100
```

## 📝 Mapeo de Términos (Frontend ↔ Backend)

| Dashboard Filter  | Usuario Pregunta                | Backend Function                 | SQL Pattern                                  |
| ----------------- | ------------------------------- | -------------------------------- | -------------------------------------------- |
| "Hoy"             | "hoy", "today"                  | `getVenueDateRange('today')`     | `>= CURRENT_DATE AND < CURRENT_DATE + 1 day` |
| "Últimos 7 días"  | "esta semana", "últimos 7 días" | `getVenueDateRange('thisWeek')`  | `>= NOW() - INTERVAL '7 days'`               |
| "Últimos 30 días" | "este mes", "últimos 30 días"   | `getVenueDateRange('thisMonth')` | `>= NOW() - INTERVAL '30 days'`              |

## ⚠️ Reglas Críticas

### ✅ HACER:

1. **SIEMPRE** usar `parseDateRange()` para fechas del frontend
2. **SIEMPRE** usar `getVenueDateRange()` para rangos relativos
3. **SIEMPRE** pasar el timezone del venue
4. **SIEMPRE** devolver ISO 8601 con 'Z' al frontend
5. **SIEMPRE** mantener "esta semana" = "últimos 7 días"

### ❌ NO HACER:

1. ❌ NO usar `date_trunc('week')` para "esta semana" (usa semana calendario)
2. ❌ NO usar `date_trunc('month')` para "este mes" (usa mes calendario)
3. ❌ NO crear Date objects con `new Date()` sin validación
4. ❌ NO asumir que el servidor está en el mismo timezone que el venue
5. ❌ NO mezclar Luxon y date-fns en el mismo proyecto (frontend usa Luxon, backend usa date-fns)

## 🧪 Tests de Sincronización

Para verificar que frontend y backend están sincronizados:

```typescript
// Test en Jest
describe('Date Range Synchronization', () => {
  it('should match dashboard "last 7 days" filter', () => {
    const backendRange = getVenueDateRange('last7days', 'America/Mexico_City')
    const frontendRange = {
      from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      to: new Date(),
    }

    // Ranges should be within 1 second of each other
    expect(Math.abs(backendRange.from.getTime() - frontendRange.from.getTime())).toBeLessThan(1000)
    expect(Math.abs(backendRange.to.getTime() - frontendRange.to.getTime())).toBeLessThan(1000)
  })
})
```

## 🔄 Flujo Completo de Ejemplo

### Escenario: Usuario pregunta "¿cuánto vendí esta semana?"

```typescript
// 1. Frontend (Dashboard) - Usuario filtra "Últimos 7 días"
const selectedRange = {
  from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  to: new Date()
}

// API call:
GET /api/v1/dashboard/venues/:venueId/basic-metrics?
    fromDate=2025-10-22T12:00:00.000Z&
    toDate=2025-10-29T12:00:00.000Z

// 2. Backend (Controller) - Recibe ISO strings
const { fromDate, toDate } = req.query
const { from, to } = parseDateRange(fromDate, toDate)

// 3. Backend (Service) - Query Prisma
const payments = await prisma.payment.findMany({
  where: {
    venueId,
    createdAt: { gte: from, lte: to }
  }
})

// 4. Backend (Chatbot) - Interpreta "esta semana"
const range = getVenueDateRange('thisWeek', venue.timezone)
// Genera SQL: "createdAt" >= NOW() - INTERVAL '7 days'

// 5. Resultado: AMBOS queries retornan los MISMOS datos ✅
```

## 📚 Referencias

- **date-fns docs**: https://date-fns.org/
- **date-fns-tz docs**: https://date-fns.org/docs/Time-Zones
- **Luxon docs**: https://moment.github.io/luxon/
- **Stripe API date handling**: https://stripe.com/docs/api/dates
- **Best practices**: Store UTC, Transmit ISO 8601, Display venue timezone

## 🚀 Deployment Checklist

Antes de hacer deploy:

- [ ] Build exitoso: `npm run build`
- [ ] Tests pasan (si existen)
- [ ] Frontend y backend en sincronía
- [ ] Chatbot actualizado con ejemplos correctos
- [ ] Documentación actualizada
- [ ] Reiniciar servidor backend para cargar nuevo código
