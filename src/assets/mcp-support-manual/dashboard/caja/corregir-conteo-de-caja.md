---
title: Corregir el conteo de un corte de caja en el panel
description: Corrige el efectivo contado de un turno de caja ya cerrado desde Ventas › Turnos de caja en el panel.
product: dashboard
category: caja
task: corregir-conteo-de-caja
requiredPermissions:
  - shifts:update
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
browserTested: 2026-11-18
keywords:
  - corregir conteo
  - me equivoqué al contar
  - corte de caja
  - arqueo
  - faltante
  - sobrante
---

## Antes de empezar

*Turnos de caja* sale en *Ventas* sólo si el negocio usa turnos. *Corregir conteo* sale si tienes permiso para editar turnos, en un turno cerrado que tiene conteo: si el turno se cerró sin contar, no aparece.

## Pasos

1. En *Ventas* › *Turnos de caja*, abre el turno.
2. En *Arqueo de caja*, toca *Corregir conteo*.
3. En *Monto contado*, escribe lo que de verdad se contó (viene con el monto que tiene ahora). En *Motivo*, explica el error.
4. Revisa la línea «El resultado pasa de … a …» y toca *Guardar corrección*. Si sale «Conteo corregido», ya quedó.

## Problemas frecuentes

- Si *Corregir conteo* sale apagado, lee la razón que sale debajo; por ejemplo, «Este corte no tiene caja ligada (es anterior al 3-sep o no usó caja); pídele la corrección a soporte».
- *Guardar corrección* se prende con un monto distinto al que ya tiene el corte y un motivo de al menos 3 letras. Con el mismo monto sale «Es el mismo monto que ya tiene el corte».
- Si sale «Alguien cambió este conteo mientras lo corregías; recarga la página», no lo vuelvas a corregir: tu corrección pudo quedar en un primer intento, o la cambió otra persona. Pide que lo revise una persona del equipo de Avoqado.
- En *Arqueo de caja* se ven las correcciones: «Corregido por …», con el monto de antes y el motivo.
