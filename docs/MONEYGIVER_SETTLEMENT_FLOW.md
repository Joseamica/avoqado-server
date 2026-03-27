# Moneygiver Settlement Flow

## Overview

Moneygiver is a payment aggregator under Blumon (processor). The settlement flow has two layers:

```
Cliente paga $X
  → Blumon retiene: comisión (% según tipo tarjeta) + IVA (16% de la comisión)
  → Blumon deposita a Moneygiver: Pago Neto (bruto - comisión - IVA)
    → Moneygiver cobra comisión por venue (% negociado, SIN IVA)
    → Moneygiver dispersa al comercio: Pago Neto - comisión MG
    → Comisión MG se divide: 70% Avoqado / 30% Moneygiver (EXTERNAL)
                              30% Avoqado / 70% Moneygiver (AGGREGATOR)
```

## Layer 1: Blumon → Moneygiver

Blumon cobra comisión + IVA (16%) y deposita el neto a Moneygiver.

### Tasas Blumon (configurable en Aggregator.baseFees):

| Tipo Tarjeta  | Tasa | + IVA 16% |
| ------------- | ---- | --------- |
| Débito        | 2.5% | + 0.4%    |
| Crédito       | 2.5% | + 0.4%    |
| AMEX          | 3.5% | + 0.56%   |
| Internacional | 3.8% | + 0.608%  |

### Cálculo:

```
comisión = monto × tasa
IVA      = comisión × 16%
pago_neto_a_MG = monto - comisión - IVA
```

### Ejemplo ($10, débito):

```
comisión = $10 × 2.5% = $0.25
IVA      = $0.25 × 16% = $0.04
pago_neto = $10 - $0.25 - $0.04 = $9.71
```

## Layer 2: Moneygiver → Comercio

Moneygiver cobra comisión por venue sobre el pago neto recibido de Blumon. **SIN IVA.**

### Tasas por Venue (configurable en VenueCommission.rate):

| Comercio          | Tasa MG     | Referido por |
| ----------------- | ----------- | ------------ |
| Doña Simona       | 4.62%       | TBD          |
| Alberto Dominguez | 7.00%       | TBD          |
| HS Consulting SC  | Por definir | TBD          |

### Cálculo:

```
comisión_MG = pago_neto × tasa_venue
dispersar_a_comercio = pago_neto - comisión_MG
```

### Split de comisión MG:

| Referido por | Avoqado (External) | Moneygiver (Aggregator) |
| ------------ | ------------------ | ----------------------- |
| EXTERNAL     | 70%                | 30%                     |
| AGGREGATOR   | 30%                | 70%                     |

### Ejemplo completo ($10, débito, Alberto 7%, EXTERNAL):

```
1. Blumon cobra:     $0.25 comisión + $0.04 IVA = $0.29
2. Pago neto a MG:   $10 - $0.29 = $9.71
3. MG cobra 7%:      $9.71 × 7% = $0.6797
4. Dispersar:        $9.71 - $0.6797 = $9.0303
5. Split $0.6797:    Avoqado 70% = $0.4758, MG 30% = $0.2039
```

## Reportes Excel

### Proceso de generación del reporte diario:

1. Recibir el Excel de Blumon (reporte de transacciones del día anterior, D+1)
2. Agregar columna "TPV" con el número de serie de terminal (cruzar por número de autorización con nuestra DB)
3. Ocultar columnas no necesarias para MG
4. Agregar resumen por comercio con:
   - Monto bruto
   - Comisión Blumon + IVA (lo que Blumon retiene)
   - Neto a MG (lo que Blumon deposita)
   - % Comisión MG (por venue)
   - Comisión MG (sin IVA)
   - A dispersar al comercio
   - Split: parte Avoqado / parte MG

### Cron jobs (7 AM México):

- **Layer 1**: Reporte de dispersión Blumon → MG (comisiones base + IVA)
- **Layer 2**: Reporte de comisiones MG por venue (sin IVA) + split Avoqado/MG

### Días de liquidación (D+N hábiles):

| Tipo tarjeta | Días hábiles | Ejemplo (viernes) |
|---|---|---|
| Débito/Crédito | D+1 | Viernes → Lunes |
| AMEX/Internacional | D+3 | Viernes → Miércoles |

Días hábiles = Lunes a Viernes (excluye sábados y domingos).

Los cron jobs calculan hacia atrás: "¿qué transacciones se liquidan HOY?"
- Déb/Créd: busca transacciones de D-1 hábil
- AMEX/Intl: busca transacciones de D-3 hábiles

Esto hace que el reporte de la mañana coincida con lo que Blumon reportará ese día.

## Modelos de datos

### Aggregator

- `baseFees`: JSON con tasas por tipo de tarjeta (lo que Blumon cobra)
- `ivaRate`: Decimal (16% = 0.16) — solo aplica a Layer 1

### VenueCommission

- `rate`: Decimal (ej. 0.0462 = 4.62%) — lo que MG cobra al venue
- `referredBy`: "EXTERNAL" o "AGGREGATOR" — determina el split 70/30 o 30/70

### Tablas relacionadas que también guardan tasas:

- `ProviderCostStructure` — costo real de Blumon por merchant account
- `VenuePricingStructure` — lo que se cobra al venue (debe coincidir con baseFees)

## Archivos de código

- Layer 1 cron: `src/jobs/moneygiver-settlement.job.ts`
- Layer 2 cron: `src/jobs/venue-commission-settlement.job.ts`
- Aggregator CRUD: `src/services/superadmin/aggregator.service.ts`
- VenueCommission CRUD: `src/services/superadmin/venueCommission.service.ts`
- Seed script: `scripts/seed-moneygiver-aggregator.ts`
