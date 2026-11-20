---
title: Ver pedidos
description: Consulta pedidos, productos, estados y detalle operativo.
product: dashboard
category: ventas
featureCode: AVOQADO_ORDERS
dashboardRoutes:
  - orders
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - CASHIER
  - WAITER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
keywords:
  - pedidos
  - detalle de un pedido
  - buscar un pedido
  - falta un pedido
  - el total no coincide con el pago
  - pedido sin pago
---

## Antes de empezar

Pedidos concentra la operación de órdenes: productos vendidos, estado, total, propina, mesa o datos del servicio cuando existen. Es la mejor sección para entender qué se vendió; Pagos es mejor para entender cómo se cobró.

Antes de revisar pedidos, confirma sucursal y periodo. Si el local usa varias fuentes de venta, como QR, POS o terminales, los pedidos pueden llegar con estados o datos diferentes.

## Pasos

1. Abre **Ventas > Pedidos**.
2. Selecciona el rango de fechas.
3. Filtra por estado, mesa, mesero, cliente o búsqueda cuando aplique.
4. Abre un pedido para revisar productos, modificadores, descuentos, propina y total.
5. Si el pedido tiene pago asociado, compara monto y estado con **Ventas > Transacciones**.
6. Usa el detalle para resolver dudas de operación antes de revisar reportes.

## Problemas frecuentes

Si falta un pedido, revisa el local activo, el rango de fechas y filtros aplicados. Si el total no coincide con pagos, verifica descuentos, propina, impuestos o cancelaciones. Si un pedido aparece sin pago, puede estar pendiente, cancelado o provenir de un flujo que todavía no cerró cobro.

## Cómo interpretar el detalle

En el detalle del pedido revisa primero el estado operativo y después los importes. Los productos explican qué se vendió; los descuentos, propinas e impuestos explican por qué el total puede cambiar; el pago asociado explica si ya hubo cobro. Esta separación ayuda a evitar confundir una venta cerrada con una orden todavía pendiente.

Si investigas un reclamo, anota mesa, mesero, hora, productos y cualquier modificador relevante. Después compara el pedido con **Ventas > Transacciones** para confirmar si el cobro existe y si el monto final coincide.

## Cuándo pedir ayuda

Escala el caso si el pedido existe pero el pago asociado no aparece, si el pedido cambió de estado sin acción clara del equipo o si hay diferencias repetidas en el mismo canal de venta. Incluye sucursal, fecha, hora aproximada, total y estado del pedido.
