---
title: Ver pagos
description: Consulta pagos, filtros, recibos y detalle de transacciones.
product: dashboard
category: ventas
featureCode: AVOQADO_PAYMENTS
dashboardRoutes:
  - payments
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - CASHIER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - gestionar-cobros-avanzados
  - crear-liga-pago
  - ver-saldo-disponible
---

## Antes de empezar

La vista de pagos sirve para consultar transacciones cobradas, revisar detalles y validar informacion antes de conciliar. Necesitas permiso para leer pagos y, en algunos locales, KYC completo para ver operacion de cobros.

Ten claro que pagos y pedidos no siempre son lo mismo: un pedido puede contener productos, mesa o mesero; un pago es la transaccion de cobro. Para investigar una venta completa, revisa ambos cuando aplique.

## Pasos

1. Abre **Ventas > Transacciones**.
2. Confirma que estas en la sucursal correcta.
3. Ajusta el rango de fechas.
4. Usa busqueda o filtros para encontrar monto, cliente, referencia o metodo de pago.
5. Abre el pago para revisar estado, total, metodo, fecha y detalle disponible.
6. Si necesitas conciliar, compara contra **Reportes > Resumen de ventas** y **Saldo disponible**.

## Problemas frecuentes

Si no aparece un pago, amplia el rango de fechas y revisa si estas filtrando por metodo o estado. Si el pago aparece pero el saldo no, puede estar pendiente de liquidacion. Si no puedes abrir detalles, tu rol puede no tener permiso suficiente. Si el cliente pago por liga, revisa tambien **Ventas > Ligas de Pago**.

## Validacion y conciliacion

Para validar un pago, revisa cuatro datos antes de escalar: fecha de cobro, monto total, metodo de pago y estado. Si el pago viene de terminal, compara tambien la terminal o referencia disponible. Si viene de una liga de pago, confirma que el concepto coincida con la liga compartida.

Cuando el objetivo sea conciliar, no uses una sola pantalla. Empieza en **Ventas > Transacciones**, cruza contra **Reportes > Resumen de ventas** y despues valida **Saldo disponible** para entender si el dinero ya esta liquidado o sigue pendiente.

## Cuando pedir ayuda

Contacta soporte con captura del pago, rango de fechas usado, sucursal activa, monto, hora aproximada y metodo de pago. Si el cliente tiene comprobante, agrega los ultimos cuatro digitos o referencia visible sin compartir datos sensibles completos.
