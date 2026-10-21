# IVA por producto — plan 2: crónica (el contrato de precio de cada venta)

**Plan:** `docs/superpowers/plans/2026-09-25-iva-por-producto-plan-2-contrato-de-precio.md`.
**Spec:** workspace `docs/superpowers/plans/2026-09-24-iva-por-producto.md` (v5 §1, v6, Ronda 6).
**Rama:** `iva-por-producto`, de `6afec7ab` a `fbbe8dcf` (ya trae `develop`). Sin push, sin merge, sin desplegar.

> Esta crónica vive en la rama porque la sesión en segundo plano no puede editar el workspace compartido. Al integrar,
> moverla a `docs/proyectos/iva-por-producto--plan-2-contrato-de-precio.md` del workspace.

## Qué quedó

- **La columna `Order.contratoDePrecio`.**
  - Es un enum con tres valores: `IVA_INCLUIDO`, `IVA_APARTE` y `DESCONOCIDO`.
  - Es NOT NULL con DEFAULT, **sin backfill**: las ventas anteriores quedan `DESCONOCIDO`.
  - La migración `20260926000300` pone `lock_timeout` y no reescribe la tabla.
- **Los 23 escritores de `Order` declaran el contrato.**
  - 15 lo marcan `IVA_INCLUIDO`, incluidas las mesas que nacen vacías.
  - 6 escriben otro valor:
    - cotización y puente de SoftRestaurant → `IVA_APARTE`;
    - cobro manual → según el IVA tecleado;
    - importación de Excel y reembolso suelto → `DESCONOCIDO`;
    - demo → `IVA_APARTE`.
  - Los 2 restantes son las dos separaciones de cuenta (copian el contrato, ver abajo).
  - La prueba `tests/unit/architecture/orderContratoDePrecioWriters.test.ts` falla si un escritor nuevo no lo declara.
  - También falla si un `update` lo reescribe fuera de `mergeOrders` y `confirmarContratoIvaIncluido`.
- **Separar copia el contrato; fusionar lo combina.**
  - Al combinar: iguales ⇒ el mismo; distintos ⇒ `DESCONOCIDO`.
  - La fusión lee las dos cuentas dentro de la transacción, después de bloquearlas.
  - Nunca bloquea la fusión.
- **Confirmación de ventas viejas** (`src/services/fiscal/confirmarContratoDePrecio.service.ts`).
  - Sólo hace `DESCONOCIDO → IVA_INCLUIDO`.
  - Lleva un candado sobre `version` que, al guardar, vuelve a revisar el impuesto, el origen y el estado.
  - Escribe `ActivityLog` en la misma transacción, con una foto de la venta: número, total y pagado.
  - No se pueden confirmar:
    - ventas con impuesto aparte;
    - ventas con IVA negativo del motor de descuentos anterior (con su propio mensaje);
    - ventas canceladas;
    - ventas del puente de SoftRestaurant;
    - ventas que salieron de una cotización.
- **MCP `confirm_order_price_contract`.**
  - Dos pasos.
  - Permiso `cfdi:configure` (dueño y administrador; el gerente no) y candado de plan `CFDI`.
  - La vista previa va en pesos, con la fecha local y con «pagada $X» o «sin cobrar».
  - Deja su propia bitácora, `…_MCP`.

## Decisiones tomadas en la construcción (con lo que cuestan si están mal)

1. **Tareas 1 y 2 en un solo envío.** Eran cimientos pequeños. Si fue un error, se hizo una revisión en vez de dos.
2. **El cobro manual pasa `taxAmount.toFixed(2)`, no el `Decimal`.** Con el `Decimal`, un cobro con IVA aparte saldría «no se sabe». Si fue un error, cuesta una línea.
3. **Son 15 sitios, no 16, y el piso del escáner es 23, no 24.** El plan sumaba mal: contaba un comentario como escritor. Si fue un error, el piso queda corrido por uno.
4. **La fusión toma el contrato de las cuentas ya bloqueadas.** Una lectura previa podría pisar una confirmación simultánea. Si fue un error, una cuenta fusionada conserva un contrato viejo.
5. **La separación lee el contrato fuera de la transacción.** Si alguien confirma justo en ese momento, la cuenta nueva queda «no se sabe», que es la dirección conservadora. Si fue un error, hay que confirmar esa cuenta otra vez.
6. **El demo es `IVA_APARTE`, no `IVA_INCLUIDO`.** Calcula `total = subtotal + 16 %`, así que el plan se equivocaba. Si fue un error, sólo afecta datos de demo.
7. **Se aceptó el arreglo del candado de pos-sync** (`::text` en `lockPosOrderNaturalKey`). Reventaba contra cualquier Postgres real y bloqueaba la prueba. Si fue un error, es una línea más que revisar.
8. **El MCP audita con `ORDER_PRICE_CONTRACT_CONFIRMED_MCP`.** El servicio ya escribe su bitácora dentro de la transacción; es el mismo patrón del conteo de inventario. Si fue un error, cuesta un nombre de acción.
9. **Una venta con IVA negativo (motor de descuentos viejo) no se puede confirmar, pero recibe un mensaje honesto.** Es conservador: no se escribe un dato fiscal sobre una fila ambigua. Si fue un error, esas ventas esperan la decisión del founder.
10. **Se usa el permiso `cfdi:configure` en lugar de `cfdi:issue`.** El spec dice «del dueño o superadmin», y `cfdi:issue` también lo tiene el gerente. Si fue un error, un gerente tiene que pedirle al dueño o al administrador que confirme.
11. **Una venta sin cobrar sí se puede confirmar, y la vista previa lo dice.** Lo que se factura lo decide el plan 3. Si fue un error, una venta sin cobrar lleva un contrato que no usa.
12. **Se trajo `develop` a la rama al final.** Sólo chocó `SCHEMA_MAP`, y se regeneró. Se aplicó la migración nueva de pantalla de cocina y se volvió a verificar todo.

## Verificación

- **Typecheck del CI:** 0 errores en local y en el Alienware, antes y después de traer `develop`.
- **Unitarias, los 4 shards pasan.**
  - Shard 2: una prueba de presupuesto del event loop falló por carga. Su archivo no cambió, y aislada en DUAL pasó.
  - Shards 3 y 4: el Alienware se quedó sin memoria. Se repitieron con 8 GB de heap y coinciden.
- **Integración completa: 158/161.** Los 3 fallos son de entorno, y sus archivos son idénticos a la base:
  - la guarda que detecta el `RENDER_DATABASE_URL` real en el `.env` compartido;
  - el arnés de h1a, que exige correr solo;
  - la prueba de replay, que espera Postgres 14 cuando aquí hay 16.
- **Después de los arreglos:**
  - fiscal: 7 suites / 45 pruebas;
  - `mcp-customer`: 124 suites / 965 pruebas;
  - `audit:permissions` sale en 0;
  - la prueba de arquitectura pasa 4/4 sobre la rama ya mezclada.

## Hallazgos fuera del alcance (para el founder)

- **El puente de SoftRestaurant reventaba en cada evento contra una base real** por el candado sin `::text`. Quedó arreglado en esta rama. No afectó a ningún cliente, porque 0 negocios lo usan desde el 12-ago. Merece su propio registro.
- **El motor de descuentos viejo resta un 16 % estimado de `Order.taxAmount`** aunque la venta no separe impuesto. Deja `taxAmount` negativo y no sube `version`.
- **La cotización convertida guarda el `total` bruto y los renglones netos.** Es un defecto preexistente.
- **Los scripts y seeds fuera de `src/` crean órdenes sin contrato.** Nacen `DESCONOCIDO`, que es lo seguro. Son `scripts/setup-playtelecom*.ts|js`, `scripts/seed-demo-venues.ts`, `scripts/seed-la-ribera-demo.ts` y `prisma/seed.ts`.

## Pendiente

- ⬜ **Decisión del founder:** ¿una venta vieja con el IVA negativo del motor de descuentos anterior se puede confirmar? Hoy no.
- ⬜ **Plan 3:** los emisores de CFDI leen el contrato.
- ⬜ **Integrar al workspace:** actualizar la fila del plan 2 en `.claude/rules/proyectos-por-fases.md` (el texto está listo en la sesión que construyó esto) y mover esta crónica a `docs/proyectos/`.
- Menores diferidos, que no bloquean:
  - una columna del schema sin alinear;
  - un ternario denso;
  - el caso 4 de fusión, que no discrimina por la semilla;
  - el demo sin prueba propia;
  - la vista previa es orientativa: se puede confirmar adivinando la versión, y la elegibilidad se revisa al guardar.
