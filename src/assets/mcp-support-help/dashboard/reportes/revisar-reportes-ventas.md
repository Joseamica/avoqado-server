---
title: Revisar reportes de ventas
description: Consulta resumen de ventas, ventas por producto y gráficas del inicio.
product: dashboard
category: reportes
featureCode: AVOQADO_REPORTS
dashboardRoutes:
  - reports/sales-summary
  - reports/sales-by-item
  - reports/home-charts
roles:
  - OWNER
  - ADMIN
  - MANAGER
  - VIEWER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
relatedArticles:
  - revisar-reportes-avanzados
  - ver-pagos
  - ver-saldo-disponible
keywords:
  - resumen de ventas
  - ventas por producto
  - ver mis ventas
  - el reporte no coincide con los pagos
  - una métrica sale vacía
  - exportar reporte de ventas
  - el archivo no trae mis filtros
  - la hora del archivo no coincide
  - ventas por artículo
  - dentro de paquete
  - las flautas del paquete no salen como vendidas
  - las piezas de un combo no salen en el reporte
---

## Antes de empezar

Reportes de ventas se usan para analizar resultados, no solo para ver transacciones individuales. Antes de descargar o compartir un reporte, confirma periodo, sucursal, tipo de vista y si necesitas ventas por día, por producto o por método de pago.

Ten presente que los reportes pueden tratar descuentos, propinas, impuestos y comisiones de forma distinta según la métrica seleccionada.

## Pasos

1. Abre **Reportes > Resumen de ventas**.
2. Selecciona el rango de fechas.
3. Elige el tipo de reporte o vista disponible.
4. Revisa métricas como ventas brutas, descuentos, reembolsos, ventas netas, impuestos, propinas y total cobrado.
5. Abre **Reportes > Ventas por artículo** para analizar artículos vendidos.
6. Exporta o comparte datos solo después de confirmar filtros y sucursal. Al tocar **Exportar**, el archivo trae las fechas y los filtros que ves en la pantalla (puedes cambiarlos ahí mismo). Marca al menos una sección: con un filtro de método de pago, el desglose por método y el detalle por tipo de tarjeta no aplican. **Por periodo** trae una fila por periodo del tipo de informe que ves (por día si ves el resumen sin desglose). **Transacciones detalladas** (Premium) trae una fila por cobro o devolución, con la fecha y hora del negocio; los cobros del sistema QR anterior sólo salen en el resumen.

## Problemas frecuentes

Si el reporte no coincide con pagos, revisa filtros, cancelaciones, descuentos y reembolsos. Si ventas por producto no coincide con inventario, valida recetas y movimientos. Si una métrica parece vacía, puede depender de permisos o configuración del local. Para conciliación de depósitos usa también **Saldo disponible**.

Antes de enviar un reporte a dirección o contabilidad, guarda el rango exacto de fechas y filtros usados.

## «Dentro de paquete» y «Total» en Ventas por artículo

Si un extra está ligado a un platillo del menú (por ejemplo, las flautas de papa que se eligen dentro de un paquete), esas unidades no cuentan como venta suelta del platillo: salen aparte en la columna **Dentro de paquete**, y **Total** suma las sueltas más las de paquete. Un platillo que sólo se vendió dentro de paquetes también aparece, con 0 sueltas. Las dos columnas salen sólo cuando en el periodo se vendió algún extra ligado, y también van en el CSV.

No suman dinero: el precio va en el producto principal (el paquete). Las unidades sueltas, las ventas y los totales de siempre no cambian. La columna usa la liga actual del extra: si ligas o desligas un extra hoy, también cambian los días pasados.

## Cómo leer las métricas

No todas las métricas responden la misma pregunta. Ventas brutas ayudan a entender volumen; descuentos y reembolsos explican ajustes; ventas netas se acercan más al resultado comercial; total cobrado ayuda a comparar contra pagos. Para depósitos, usa **Saldo disponible** porque las liquidaciones tienen tiempos y reglas propias.

Cuando compares periodos, usa rangos equivalentes. No compares un día incompleto contra un día cerrado sin anotarlo. Si el local tiene varias sucursales, descarga reportes por sucursal antes de consolidar.

## Cuándo pedir ayuda

Pide soporte si una métrica cambia sin filtros, si un export no coincide con la pantalla o si hay una diferencia que no se explica con cancelaciones, reembolsos o descuentos. Comparte rango, zona horaria, sucursal, filtros y captura de la pantalla.
