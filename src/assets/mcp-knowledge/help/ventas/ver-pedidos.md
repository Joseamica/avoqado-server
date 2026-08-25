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
---

## Antes de empezar

Pedidos concentra la operacion de ordenes: productos vendidos, estado, total, propina, mesa o datos del servicio cuando existen. Es la mejor seccion para entender que se vendio; Pagos es mejor para entender como se cobro.

Antes de revisar pedidos, confirma sucursal y periodo. Si el local usa varias fuentes de venta, como QR, POS o terminales, los pedidos pueden llegar con estados o datos diferentes.

## Pasos

1. Abre **Ventas > Pedidos**.
2. Selecciona el rango de fechas.
3. Filtra por estado, mesa, mesero, cliente o busqueda cuando aplique.
4. Abre un pedido para revisar productos, modificadores, descuentos, propina y total.
5. Si el pedido tiene pago asociado, compara monto y estado con **Ventas > Transacciones**.
6. Usa el detalle para resolver dudas de operacion antes de revisar reportes.

## Problemas frecuentes

Si falta un pedido, revisa el local activo, el rango de fechas y filtros aplicados. Si el total no coincide con pagos, verifica descuentos, propina, impuestos o cancelaciones. Si un pedido aparece sin pago, puede estar pendiente, cancelado o provenir de un flujo que todavia no cerró cobro.

## Como interpretar el detalle

En el detalle del pedido revisa primero el estado operativo y despues los importes. Los productos explican que se vendio; los descuentos, propinas e impuestos explican por que el total puede cambiar; el pago asociado explica si ya hubo cobro. Esta separacion ayuda a evitar confundir una venta cerrada con una orden todavia pendiente.

Si investigas un reclamo, anota mesa, mesero, hora, productos y cualquier modificador relevante. Despues compara el pedido con **Ventas > Transacciones** para confirmar si el cobro existe y si el monto final coincide.

## Cuando pedir ayuda

Escala el caso si el pedido existe pero el pago asociado no aparece, si el pedido cambio de estado sin accion clara del equipo o si hay diferencias repetidas en el mismo canal de venta. Incluye sucursal, fecha, hora aproximada, total y estado del pedido.
