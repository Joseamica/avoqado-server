---
title: Gestionar inventario
description: Revisa existencias, movimientos, ingredientes, proveedores y recetas.
product: dashboard
category: inventario
featureCode: AVOQADO_INVENTORY
dashboardRoutes:
  - inventory/stock-overview
  - inventory/history
  - inventory/ingredients
  - inventory/recipes
  - inventory/suppliers
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - gestionar-inventario-avanzado
  - gestionar-productos
  - revisar-reportes-ventas
---

## Antes de empezar

Inventario combina varias piezas: existencias actuales, ingredientes, recetas, proveedores, ordenes de compra, conteos y movimientos. Antes de ajustar stock, identifica si el articulo se controla por cantidad directa o por receta. Cambiar inventario sin revisar el metodo puede producir diferencias en reportes de costo o disponibilidad.

Tambien confirma que estas trabajando en la sucursal correcta. El stock es local: una misma materia prima puede tener existencias diferentes por ubicacion.

## Pasos

1. Abre **Inventario > Resumen de existencias** para revisar el estado general.
2. Usa **Ingredientes** para mantener materias primas, unidades y costos.
3. Usa **Recetas** para relacionar productos de venta con ingredientes.
4. Entra a **Historial** para auditar movimientos recientes.
5. Revisa **Pedidos** y **Proveedores** cuando necesites abastecimiento.
6. Usa **Conteos** y **Transferencias** para seguimiento operativo cuando esten disponibles.

## Problemas frecuentes

Si el stock no coincide, revisa primero el historial de movimientos y ultimo conteo. Si una receta no descuenta inventario, confirma que el producto tenga receta asignada y que sus ingredientes existan. Si no puedes crear movimientos, revisa permisos. Si el inventario no aparece, la funcion puede no estar activa para el local.

## Orden recomendado de revision

Para investigar diferencias, empieza por **Historial** y no por ajustes manuales. Identifica el ultimo conteo, entradas de proveedor, salidas, transferencias y ventas que pudieron descontar stock. Despues revisa ingredientes y recetas para confirmar que cada producto descuente la cantidad correcta.

Si el problema es disponibilidad de venta, revisa si el producto depende de una receta y si todos sus ingredientes tienen existencia suficiente. Si el problema es costo, revisa unidad de compra, unidad de consumo y costo promedio antes de modificar cantidades.

## Cuando pedir ayuda

Escala a soporte cuando el historial muestre movimientos duplicados, cuando una receta descuente cantidades incorrectas despues de revisar unidades o cuando un conteo guardado no se refleje. Incluye producto o ingrediente, sucursal, fecha del conteo y captura del historial.
