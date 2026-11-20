---
title: Cobrar con el teclado en el POS Windows
description: Teclas del cobro en el POS Windows: F12 cobra, F5 es efectivo, F4 manda a la terminal y Esc regresa.
product: windows
category: cobro
task: cobrar-con-el-teclado
requiredPermissions:
  - payments:create
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - atajos de teclado
  - teclas
  - F12
  - F5
  - F4
  - Esc
  - cobrar con el teclado
---

## Pasos

1. En *Cobrar*, con los productos en la venta, aprieta F12: hace lo mismo que el botón *Cobrar*.
2. Si sale *¿Cómo fue tu experiencia?*, F12 hace lo mismo que *Omitir*. En *Propina* las teclas de atajo no responden: elige con el mouse o con el dedo.
3. En la pantalla del cobro, aprieta F5 para efectivo: se abre *Monto recibido* con el total ya puesto.
4. Si te dieron justo el total, aprieta F5 otra vez. Si no, teclea lo que te dieron con sus centavos (para $200.00, teclea 20000), revisa el monto que sale y aprieta F5: cobra si llega al total.
5. Para mandarlo a la terminal, aprieta F4 en la pantalla del cobro, y en *Seleccionar terminal* aprieta F4 otra vez para la primera de la lista.
6. Al terminar, Esc hace lo mismo que *Venta nueva*. En la pantalla del cobro, Esc hace lo mismo que la X de arriba para cerrarla.

## Problemas frecuentes

- F12 sólo cobra con productos en la venta y sin nada abierto encima (una búsqueda, *¿Algo más?*, un aviso o una ventana).
- En *Monto recibido*, Enter no cobra: aprieta F5 o toca *Confirmar*.
- F4 no hace nada si dice «No hay terminales conectadas».
