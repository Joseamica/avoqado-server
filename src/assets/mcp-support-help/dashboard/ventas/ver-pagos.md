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
keywords:
  - transacciones
  - buscar un pago por monto
  - recibo de un pago
  - no aparece un pago
  - el pago aparece pero el saldo no
  - el cliente pagó por liga
---

## Antes de empezar

La vista de pagos sirve para consultar transacciones cobradas, revisar detalles y validar información antes de conciliar. Necesitas permiso para leer pagos y, en algunos locales, KYC completo para ver operación de cobros.

Ten claro que pagos y pedidos no siempre son lo mismo: un pedido puede contener productos, mesa o mesero; un pago es la transacción de cobro. Para investigar una venta completa, revisa ambos cuando aplique.

## Pasos

1. Abre **Ventas > Transacciones**.
2. Confirma que estás en la sucursal correcta.
3. Ajusta el rango de fechas.
4. Usa búsqueda o filtros para encontrar monto, cliente, referencia o método de pago.
5. Abre el pago para revisar estado, total, método, fecha y detalle disponible.
6. Si necesitas conciliar, compara contra **Reportes > Resumen de ventas** y **Saldo disponible**.

## Problemas frecuentes

Si no aparece un pago, amplía el rango de fechas y revisa si estás filtrando por método o estado. Si el pago aparece pero el saldo no, puede estar pendiente de liquidación. Si no puedes abrir detalles, tu rol puede no tener permiso suficiente. Si el cliente pagó por liga, revisa también **Ventas > Ligas de Pago**.

## Validación y conciliación

Para validar un pago, revisa cuatro datos antes de escalar: fecha de cobro, monto total, método de pago y estado. Si el pago viene de terminal, compara también la terminal o referencia disponible. Si viene de una liga de pago, confirma que el concepto coincida con la liga compartida.

Cuando el objetivo sea conciliar, no uses una sola pantalla. Empieza en **Ventas > Transacciones**, cruza contra **Reportes > Resumen de ventas** y después valida **Saldo disponible** para entender si el dinero ya está liquidado o sigue pendiente.

## Cuándo pedir ayuda

Contacta soporte con captura del pago, rango de fechas usado, sucursal activa, monto, hora aproximada y método de pago. Si el cliente tiene comprobante, agrega los últimos cuatro dígitos o referencia visible sin compartir datos sensibles completos.
