---
title: Registrar una merma en el POS Windows
description: Registra en el POS Windows un producto o insumo que se echó a perder, se cayó o caducó, con su motivo; también sin internet.
product: windows
category: inventario
task: registrar-merma
requiredPermissions:
  - inventory:log-waste
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
keywords:
  - merma
  - registrar merma
  - se echó a perder
  - caducó
  - se cayó
  - desperdicio
  - producto dañado
---

## Antes de empezar

Hace falta el permiso de registrar merma; sin él, *Registrar merma* sale apagada con «Pídele acceso a tu gerente».

## Pasos

1. En *Más*, toca *Registrar merma* (también está en *Inventario*).
2. Busca el artículo en «Busca por nombre o SKU» y tócalo.
3. Escribe la *Cantidad*.
4. Elige el *Motivo*; con *Otro* hay que escribir qué pasó en la nota.
5. Toca *Registrar* y luego *Confirmar*.
6. Si sale «¡Merma registrada!», ya quedó; para el papel, toca *Imprimir comprobante*.

## Problemas frecuentes

- Si aparece «Merma guardada» con «Se está subiendo.», todavía no la confirma el servidor: no la vuelvas a capturar.
- Si aparece «No se pudo registrar…», revísala en *Más* › *Mermas por subir*; la que no sirva, quítala con *Descartar*.
- Lo guardado sube con la sesión de quien lo capturó: si alguien más entra en esta computadora antes, se queda en *Mermas por subir* y sólo puede subir cuando esa persona vuelva a entrar.
- Si aparece «Estos productos no aparecen en la lista de merma:», debajo dice qué hacer con ese producto.
- Si aparece «Incluido en el Plan Premium», lo que registres se guarda en la computadora; no sube mientras el negocio no tenga el plan.

## Sin internet

- Si aparece «Sin conexión: la merma se guarda en este aparato y se sube sola.», regístrala igual: queda guardada en la computadora.
- Si aparece «Sin catálogo guardado. Conéctate a internet para descargarlo.», no hay artículos para buscar hasta que vuelva la conexión.
