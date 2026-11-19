---
title: Registrar un pago manual en el panel
description: Anota en el panel un pago que se cobró fuera de Avoqado, como en otra terminal, por transferencia o en efectivo.
product: dashboard
category: pagos
task: registrar-pago-manual
requiredPermissions:
  - payment:create-manual
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-12
keywords:
  - pago manual
  - registrar pago
  - nuevo pago manual
  - pago de otra terminal
  - anotar un cobro
---

## Antes de empezar

*Nuevo pago manual* sale en *Ventas* › *Transacciones* si tienes permiso para registrar pagos manuales. El pago manual sólo queda anotado: no le cobra nada al cliente.

## Pasos

1. En *Ventas* › *Transacciones*, toca *Nuevo pago manual*.
2. Escribe el *Monto*. Si aplica, llena *Propina (opcional)*, *IVA (opcional)* y *Descuento (opcional)*.
3. Elige el *Método* (viene en *Efectivo*) y el *Origen*. Con *Otro (proveedor externo)*, que viene elegido, toca *Proveedor externo*, escribe quién cobró y toca *Agregar "…"*, o elige uno de *Ya usados en este venue*.
4. Si quieres, elige el *Mesero (opcional)* y escribe la *Razón (opcional)*.
5. Toca *Registrar pago*. Si sale «Pago registrado», ya quedó.

## Problemas frecuentes

- Si debajo de un campo sale un aviso en rojo, corrígelo antes de guardar; por ejemplo, «El monto debe ser un número mayor a 0» o «El proveedor externo es requerido cuando el origen es OTHER».
- Si después de tocar *Registrar pago* sale «Error», debajo dice por qué, pero no lo registres otra vez: el pago pudo quedar en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
