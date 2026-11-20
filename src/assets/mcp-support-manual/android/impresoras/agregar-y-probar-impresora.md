---
title: Agregar y probar una impresora en el POS Android
description: Agrega una impresora de tickets o de comandas al POS Android, elige para qué sirve e imprime una página de prueba.
product: android
category: impresoras
task: agregar-y-probar-impresora
requiredPermissions: []
versionMin: 2.24.0
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - agregar impresora
  - conectar impresora
  - impresora de cocina
  - impresora de tickets
  - página de prueba
  - impresora no responde
  - cajón de dinero
---

## Antes de empezar

La impresora tiene que estar encendida y en la misma red del local, o conectada por USB o Bluetooth.

## Pasos

1. En *Más*, toca *Ajustes* y luego *Impresoras y cajón*; la app busca impresoras sola.
2. En «Disponibles para agregar», toca *Agregar* junto a tu impresora.
3. Si no aparece, en «¿No aparece tu impresora?» escribe su *Dirección IP* y toca *Agregar impresora*.
4. En *Configurar impresora*, en *Funciones* deja prendido sólo para qué es: *Recibos* para tickets o *Cocina* para comandas.
5. Si es para comandas, prende también *Imprimir comandas automáticamente*.
6. Toca *Imprimir página de prueba*.

## Problemas frecuentes

- Junto a cada impresora sale su estado, por ejemplo *Responde*, *No responde* o *Sin comprobar* (nadie la ha probado todavía). Para saber si imprime, ábrela y toca *Imprimir página de prueba*.
- Si aparece «No se pudo conectar con …» al agregarla por IP, revisa que esté encendida, en esta misma red y el puerto (el normal es 9100).
- Si en «Recibos y cajón de esta caja» aparece «No configurada», esta caja no tiene guardada una impresora de tickets: agrégala en «Disponibles para agregar».
- En «Recibos y cajón de esta caja», *Imprimir prueba* y *Abrir cajón* prueban la impresora de tickets y el cajón.
- Las impresoras de «Comandas del local» vienen del panel web: se cambian ahí, no en el POS.
- Para quitar una impresora, ábrela, toca *Eliminar impresora* y luego *Eliminar*.
