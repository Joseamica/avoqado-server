---
title: Agregar y probar una impresora en el POS Windows
description: Agrega una impresora de tickets o de comandas al POS Windows, elige para qué sirve e imprime una página de prueba.
product: windows
category: impresoras
task: agregar-y-probar-impresora
requiredPermissions: []
versionMin: 2.25.4
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
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

La impresora tiene que estar encendida y en la misma red del local, o conectada a esta computadora: instalada en Windows o en un puerto COM.

## Pasos

1. En *Más*, toca *Ajustes* y luego *Impresoras y cajón*; la app busca impresoras sola.
2. En «Disponibles para agregar», toca *Agregar* junto a tu impresora.
3. Si es de red y no aparece, en «¿No aparece tu impresora?» escribe su *Dirección IP* y toca *Agregar impresora*.
4. En *Configurar impresora*, en *Funciones* deja prendido sólo para qué es: *Recibos* para tickets o *Cocina* para comandas.
5. Si es para comandas, prende también *Imprimir comandas automáticamente*.
6. Toca *Imprimir página de prueba*.

## Problemas frecuentes

- Una impresora conectada a esta computadora sólo sale en «Disponibles para agregar» si Windows la tiene instalada (sale como «… (impresora de Windows)») o si está en un puerto COM (sale como «Puerto …» o «Bluetooth (…)»).
- Junto a cada impresora sale su estado, por ejemplo *Responde*, *No responde* o *Sin comprobar* (todavía no se sabe). Para saber si imprime, ábrela y toca *Imprimir página de prueba*.
- Si aparece «No se pudo conectar con …» al agregarla por IP, revisa que esté encendida, en esta misma red y el puerto (el normal es 9100).
- Si en «Recibos y cajón de esta caja» aparece «No configurada», esta computadora no tiene guardada una impresora de tickets: agrégala en «Disponibles para agregar».
- En «Recibos y cajón de esta caja», *Imprimir prueba* y *Abrir cajón* prueban la impresora de tickets y el cajón.
- Las impresoras de «Comandas del local» vienen del panel web: se cambian ahí, no en el POS.
- Para quitar una impresora, ábrela, toca *Eliminar impresora* y luego *Eliminar*.
