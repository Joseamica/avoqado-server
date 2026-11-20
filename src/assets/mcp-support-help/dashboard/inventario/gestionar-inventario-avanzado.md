---
title: Gestionar inventario avanzado
description: Revisa órdenes de compra, conteos, transferencias, reabastecimientos y rentabilidad.
product: dashboard
category: inventario
featureCode: AVOQADO_INVENTORY
dashboardRoutes:
  - inventory/purchase-orders
  - inventory/stock-counts
  - inventory/transfers
  - inventory/restocks
  - inventory/profitability
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - gestionar-inventario
  - revisar-reportes-ventas
keywords:
  - órdenes de compra
  - conteo de inventario
  - transferencias
  - rentabilidad
  - la orden de compra no sube el stock
  - el conteo no coincide
---

## Antes de empezar

Inventario avanzado sirve para pasar de revisar existencias a controlar abastecimiento, auditoría y rentabilidad. Antes de crear o revisar movimientos, confirma que ingredientes, unidades, proveedores y recetas estén bien configurados. Si esos datos base están mal, las órdenes de compra, conteos y rentabilidad también saldrán mal.

Ten en cuenta que algunas pantallas son operativas y otras son de auditoría. Conteos y transferencias pueden existir para revisar eventos ya creados por el equipo, mientras que órdenes de compra y rentabilidad requieren decisiones administrativas.

## Pasos

1. Abre **Inventario > Órdenes de compra** para revisar pedidos a proveedores.
2. Verifica proveedor, ingredientes, cantidades, costo, estado y fecha esperada.
3. Usa **Conteos de inventario** para auditar recuentos físicos y diferencias.
4. Revisa **Transferencias** cuando existan movimientos entre ubicaciones o áreas.
5. Consulta **Reabastecimientos pendientes** para identificar necesidades cuando la pantalla esté disponible.
6. Entra a **Rentabilidad** para comparar precio, costo, margen y productos que necesitan revisión.
7. Antes de ajustar stock o precios, guarda evidencia del dato que explica el cambio.

## Problemas frecuentes

Si una orden de compra no actualiza stock, revisa si fue recibida o sigue pendiente. Si un conteo no coincide, revisa fecha, usuario y movimientos posteriores. Si una transferencia no aparece, confirma sucursal y rango de fechas. Si rentabilidad muestra margen bajo, valida receta, costo de ingrediente y precio de venta antes de cambiar el producto.

## Cómo investigar diferencias

Empieza por historial y conteos antes de modificar cantidades. Después revisa órdenes recibidas, transferencias y recetas que descuentan ingredientes. Para rentabilidad, valida unidad de compra contra unidad de consumo; muchas diferencias nacen de gramos, piezas, litros o porciones mal convertidas.

Si un producto es rentable en papel pero no en operación, revisa modificadores, mermas, descuentos y promociones. La rentabilidad del menú depende tanto de costos como de cómo se vende el producto.

## Cuándo pedir ayuda

Escala a soporte si una orden recibida no mueve inventario, si un conteo guardado desaparece, si una transferencia muestra cantidades incorrectas o si rentabilidad calcula costos que no coinciden con recetas revisadas. Incluye ingrediente, producto, fecha, sucursal y captura del historial.
