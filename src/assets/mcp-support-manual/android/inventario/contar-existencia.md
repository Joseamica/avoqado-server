---
title: Contar la existencia del inventario en el POS Android
description: Haz un conteo completo o de algunos artículos en el POS Android, revisa las diferencias y confírmalo para ajustar el inventario.
product: android
category: inventario
task: contar-existencia
requiredPermissions:
  - inventory:read
  - inventory:create
  - inventory:update
  - inventory:adjust
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - conteo de inventario
  - contar existencia
  - inventario físico
  - conteo cíclico
  - conteo completo
  - ajustar inventario
---

## Antes de empezar

*Inventario* sale para gerente, administrador y dueño. Los conteos dependen del plan: sin él, *Conteos* sale con candado.

## Pasos

1. En *Inventario*, abre *Conteos* y toca *Contar existencia*.
2. En *Tipo de conteo*, elige *Conteo completo* o *Conteo cíclico*; en el cíclico, toca *Agregar artículos* y elige cuáles.
3. Escribe cuánto hay de cada artículo y toca *Siguiente artículo*; en el último, toca *Revisar conteo*.
4. Revisa *Esperado*, *Contado* y *Diferencia*; si quieres, toca *Agregar nota*.
5. Toca *Confirmar* para ajustar el inventario con lo contado.

## Problemas frecuentes

- Si sales a media captura, pregunta «¿Qué hacemos con este conteo?»: *Guardar el avance* lo deja en este aparato y lo sigues después con *Continuar*.
- *Descartar el conteo* borra lo contado en este aparato y no se puede deshacer; si ya contaste algo, pide confirmarlo con *Descartar el conteo*. Si el conteo ya existía en el servidor, también pide cancelarlo allá; sin conexión, ese pedido queda guardado en el aparato.
- Si aparece «Tienes un conteo sin terminar en este aparato…», termina o descarta ese conteo antes de empezar otro.
- Si aparece «Este conteo ya se cerró desde otro aparato…», lo que contaste aquí ya no se aplica: sólo queda para consulta.
- Si aparece que un artículo «no entró al conteo», ese artículo no se ajusta en el inventario.
- Si aparece «No se aplicó» junto a un producto, ese producto no cambió en el inventario: debajo dice si hay que volver a contarlo o si lo resuelve el dueño en el panel.
- Si aparece «No se pudo comprobar si todo se aplicó…», no repitas el conteo: con conexión, abre ese conteo en *Conteos* y revisa si algún producto dice «No se aplicó».

## Sin internet

- Si aparece «Sin conexión: el conteo quedó guardado en este aparato. Confirma cuando vuelva la red.», toca *Confirmar* otra vez cuando vuelva la conexión.
