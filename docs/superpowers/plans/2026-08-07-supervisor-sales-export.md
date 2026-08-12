# Supervisor Sales Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mantener el reporte anual completo de PlayTelecom sin que el feed interactivo cargue, ordene y serialice miles de eventos cada 30
segundos.

**Architecture:** El feed interactivo queda acotado y sujeto al alcance del actor. Un servicio nuevo pagina únicamente órdenes con cursor
keyset y selección mínima; el dashboard descarga páginas secuenciales y genera CSV/XLSX en el navegador. Una ruta separada audita el formato
después de la descarga.

**Tech Stack:** TypeScript, Express, Prisma, Jest/Supertest, React, TanStack Query, Vitest, ExcelJS/PapaParse.

**Spec:** `docs/superpowers/specs/2026-08-07-supervisor-sales-export-design.md`

## Global Constraints

- Trabajar en las ramas actuales; no crear worktree ni cambiar de branch.
- Otro LLM edita `avoqado-server`; antes de cada parche comprobar los targets y preservar cambios ajenos.
- No crear commits ni staging sin solicitud explícita.
- TDD estricto: observar rojo antes de modificar producción.
- OWNER/ADMIN/SUPERADMIN conservan alcance organizacional; otros roles sólo `StaffVenue` activos.
- Feed de 100, máximo backend 200; página 500; rango 370 días; máximo 25,000 ventas; nunca truncar.
- Sin migraciones ni dependencias nuevas.

---

### Task 1: Alcance y límite del feed interactivo

**Files:**

- Create: `src/services/organization-dashboard/storesAnalysisScope.service.ts`
- Modify: `src/routes/dashboard/storesAnalysis.routes.ts`
- Modify: `src/services/organization-dashboard/organizationDashboard.service.ts`
- Test: `tests/unit/routes/storesAnalysis.activity-feed.routes.test.ts`

**Interfaces:**

- Produce `resolveStoresAnalysisVenueIds({ organizationId, userId, role, filterVenueId }): Promise<string[] | undefined>`.
- `undefined` significa todos los venues activos para rol privilegiado; `[]`, ningún venue autorizado.

- [ ] **Step 1: Escribir tests rojos**

```ts
it('caps limit=10000 at 200', async () => {
  await request(app).get(`${base}/activity-feed?limit=10000`)
  expect(getActivityFeedSpy).toHaveBeenCalledWith(ORG_ID, 200, undefined, undefined, undefined, undefined)
})

it('passes only a managers active venue ids', async () => {
  prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId: 'v-1' }, { venueId: 'v-2' }] as any)
  await request(app).get(`${base}/activity-feed`)
  expect(getActivityFeedSpy).toHaveBeenCalledWith(ORG_ID, 50, undefined, undefined, undefined, ['v-1', 'v-2'])
})
```

- [ ] **Step 2: Correr y confirmar rojo**

```bash
npx jest --runInBand --runTestsByPath tests/unit/routes/storesAnalysis.activity-feed.routes.test.ts
```

- [ ] **Step 3: Implementar límite y alcance**

```ts
const parsed = Number.parseInt(String(req.query.limit ?? '50'), 10)
const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50
const scopedVenueIds = await resolveStoresAnalysisVenueIds({
  organizationId: orgId,
  userId: req.access!.userId,
  role: req.access!.role,
  filterVenueId,
})
```

Añadir un último parámetro opcional `scopedVenueIds` a `getActivityFeed` y aplicarlo en la consulta de venues; dejar intacto al caller
organizacional.

- [ ] **Step 4: Correr verde y revisar targets**

```bash
npx jest --runInBand --runTestsByPath tests/unit/routes/storesAnalysis.activity-feed.routes.test.ts
git status --short
```

---

### Task 2: Servicio paginado de ventas

**Files:**

- Create: `src/services/organization-dashboard/supervisorSalesExport.service.ts`
- Test: `tests/unit/services/organization-dashboard/supervisorSalesExport.service.test.ts`

**Interfaces:**

- Produce `getSupervisorSalesExportPage(input): Promise<{ rows; nextCursor; total? }>`.
- Exporta helpers de cursor y constantes `500`, `25000`, `370`.

- [ ] **Step 1: Escribir tests rojos de cursor, límites y selección mínima**

```ts
it('returns a stable keyset cursor and no more than 500 rows', async () => {
  prismaMock.order.count.mockResolvedValue(2)
  prismaMock.order.findMany.mockResolvedValue([order1, order2] as any)
  const result = await getSupervisorSalesExportPage(baseInput)
  expect(result.total).toBe(2)
  expect(prismaMock.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 501 }))
})

it('rejects more than 25000 rows before loading orders', async () => {
  prismaMock.order.count.mockResolvedValue(25_001)
  await expect(getSupervisorSalesExportPage(baseInput)).rejects.toThrow('25,000')
  expect(prismaMock.order.findMany).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Correr rojo**

```bash
npx jest --runInBand --runTestsByPath tests/unit/services/organization-dashboard/supervisorSalesExport.service.test.ts
```

- [ ] **Step 3: Implementar keyset `(createdAt,id)` y select mínimo**

```ts
const orders = await prisma.order.findMany({
  where: { status: 'COMPLETED', createdAt: range, ...venueScope, ...cursorWhere },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: pageSize + 1,
  select: {
    id: true,
    createdAt: true,
    total: true,
    venue: { select: { name: true } },
    servedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
    items: { take: 1, select: { serializedItem: { select: { serialNumber: true } } } },
  },
})
```

- [ ] **Step 4: Correr verde**

---

### Task 3: Rutas de páginas y auditoría

**Files:**

- Modify: `src/routes/dashboard/storesAnalysis.routes.ts`
- Test: `tests/unit/routes/storesAnalysis.sales-export.routes.test.ts`

- [ ] **Step 1: Escribir tests rojos para GET envelope, filtros no autorizados y POST audit**
- [ ] **Step 2: Correr rojo**
- [ ] **Step 3: Implementar GET `sales-export-rows` y POST `sales-export-audit`**

```ts
await logAction({
  staffId: req.access!.userId,
  venueId,
  action: 'SALES_REPORT_EXPORTED',
  entity: 'SalesReport',
  data: { format, startDate, endDate, filterVenueId: filterVenueId ?? null, rowCount },
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
})
```

- [ ] **Step 4: Correr verde y confirmar que auditoría inválida no escribe**

---

### Task 4: Cliente paginado y helpers puros

**Files:**

- Modify: `../avoqado-web-dashboard/src/services/storesAnalysis.service.ts`
- Create: `../avoqado-web-dashboard/src/pages/playtelecom/Supervisor/supervisorExport.ts`
- Test: `../avoqado-web-dashboard/src/services/__tests__/storesAnalysis.service.test.ts`
- Test: `../avoqado-web-dashboard/src/pages/playtelecom/Supervisor/supervisorExport.test.ts`

**Interfaces:**

- Produce `getSalesExportRows`, `recordSalesExportAudit`, `fetchAllSupervisorSales`, `buildSupervisorExportData`,
  `shouldPollSupervisorActivity`.

- [ ] **Step 1: Tests rojos del API, cursor loop, progreso y mapeo de columnas**

```ts
const fetchPage = vi
  .fn()
  .mockResolvedValueOnce({ rows: [row1], nextCursor: 'c1', total: 2 })
  .mockResolvedValueOnce({ rows: [row2], nextCursor: null })
const rows = await fetchAllSupervisorSales(baseParams, fetchPage, onProgress)
expect(rows).toEqual([row1, row2])
expect(onProgress).toHaveBeenLastCalledWith({ fetched: 2, total: 2 })
```

- [ ] **Step 2: Correr rojo**

```bash
npm run test:run -- src/services/__tests__/storesAnalysis.service.test.ts src/pages/playtelecom/Supervisor/supervisorExport.test.ts
```

- [ ] **Step 3: Implementar loop secuencial con snapshot inmutable y `limit: 500`; correr verde**

---

### Task 5: Integrar SupervisorDashboard

**Files:**

- Modify: `../avoqado-web-dashboard/src/pages/playtelecom/Supervisor/SupervisorDashboard.tsx`
- Modify: `../avoqado-web-dashboard/src/hooks/useStoresAnalysis.ts`

- [ ] **Step 1: Test rojo: `refetchInterval=false` se conserva y sólo se hace polling de rango actual en tab operativo**
- [ ] **Step 2: Cambiar feed a 100 y quitar su uso como fuente de exportación**
- [ ] **Step 3: Abrir `about:blank` para Sheets antes del primer await; generar archivo; navegar a Sheets; cerrar en error**
- [ ] **Step 4: Deshabilitar botón y mostrar `fetched / total`; auditar best-effort después del archivo**
- [ ] **Step 5: Correr verde y revisar sólo diffs propios**

---

### Task 6: Verificación conjunta

- [ ] Tests focalizados backend/frontend.
- [ ] `npm run typecheck` en server y `npm run build` en dashboard.
- [ ] Lint de archivos tocados y `git diff --check`.
- [ ] Comparar estado final con el inventario inicial; no stagear ni commitear.
