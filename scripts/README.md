# Scripts Directory

Collection of utility scripts for Avoqado development and testing.

## PlayTelecom Setup Script

**File:** `setup-playtelecom.js`

Creates a complete PlayTelecom organization with realistic test data for Command Center development and testing.

### Usage

```bash
# From avoqado-server directory
node scripts/setup-playtelecom.js
```

### What it does

1. **Cleans up** - Deletes all existing PlayTelecom data (if any)
2. **Creates organization** - PlayTelecom with proper CUID v1 IDs
3. **Creates venues** - Centro and Sur (both with KYC VERIFIED)
4. **Creates staff**:
   - 1 Manager with OWNER role (organization-level access to both venues)
   - 5 Promoters (3 for Centro, 2 for Sur)
5. **Sets organizational goals**:
   - Weekly: $135,000 / 500 sales
   - Daily: $19,285.71 / 71 sales
6. **Activates modules** (at 3 levels):
   - **Module** table (base modules)
   - **OrganizationModule** (enables for organization)
   - **VenueModule** (enables for each venue with white-label config)
7. **Configures White-Label Dashboard**:
   - Preset: "telecom"
   - Features: Centro de Comando, Inventario Serializado, Auditoría de Promotores, Análisis de Tiendas, Gerentes, Comisiones
   - Navigation: 6 items configured
   - Theme: PlayTelecom branding (orange #FF6B00)
8. **Creates sample TimeEntries** - 3 active check-ins for realistic gauge data
9. **Creates sample sales data** - 15 orders distributed across venues:
   - Centro: 10 orders ($37,120 total) - Top performer
   - Sur: 5 orders ($3,770 total) - Low performer
   - Juan Pérez: 5 sales (top seller in Centro)
   - María González: 5 sales (Centro)
   - Ana Martínez: 5 sales (Sur)
10. **Creates attendance issues** - Realistic data for testing:
    - Carlos López: 2 check-ins this week (3 absences)
    - Luis Hernández: 1 check-in (multiple absences)
11. **Creates critical anomalies**:
    - GPS violation: Check-in 1.2km outside venue geofence
    - Low stock alert: 3 SIMs remaining (critical threshold)

### Test Credentials

All accounts use password: `admin123`

| Email                          | Role    | Venue       | Status                    |
| ------------------------------ | ------- | ----------- | ------------------------- |
| manager@playtelecom.mx         | OWNER   | Centro, Sur | Organization-level access |
| juan.promotor@playtelecom.mx   | CASHIER | Centro      | ✅ Online                 |
| maria.promotor@playtelecom.mx  | CASHIER | Centro      | ✅ Online                 |
| carlos.promotor@playtelecom.mx | CASHIER | Centro      | Offline                   |
| ana.promotor@playtelecom.mx    | CASHIER | Sur         | ✅ Online                 |
| luis.promotor@playtelecom.mx   | CASHIER | Sur         | Offline                   |

### Command Center URLs

- **Via SERIALIZED_INVENTORY module**: `http://localhost:5173/venues/playtelecom-centro/playtelecom`
- **Via WHITE_LABEL_DASHBOARD module**: `http://localhost:5173/venues/playtelecom-centro/command-center`

### Expected Results

After running the script, the Command Center should show:

#### Gauges & Metrics

- **Promotores Online Gauge**: 60% (3/5 promoters online)
  - Centro: 66% (2/3 online)
  - Sur: 50% (1/2 online)

#### Operational Insights (Insights Section)

- **Tienda Líder (Ventas)**: Centro - $37,120 (10 orders)
- **Menor Venta**: Sur - $3,770 (5 orders)
- **Top Promotor**: Juan Pérez - 5 SIMs activadas
- **Peor Asistencia**: Carlos López - 3 faltas esta semana

#### Critical Anomalies

- **GPS Violation**: Check-in detected 1.2km outside venue (Centro)
- **Low Stock Alert**: Only 3 SIMs remaining (critical threshold)

#### Performance by Venue

- **Centro**: $37,120 revenue, 10 orders (top performer)
- **Sur**: $3,770 revenue, 5 orders

### When to Use

- Starting fresh development on PlayTelecom Command Center
- After database reset or migration
- When test data becomes inconsistent
- Before client demo or meeting
- Testing organization-level features

### Notes

- Script is **idempotent** - safe to run multiple times
- Always deletes and recreates from scratch
- Uses Prisma auto-generated CUID v1 IDs
- All emails are pre-verified
- All venues have KYC pre-approved
- TimeEntries are created with realistic clock-in times (2-4 hours ago)
