---
title: Agregar o quitar a alguien de la lista de espera en el panel
description: Anota en la lista de espera de Reservaciones a quien no alcanzó lugar, o quítalo cuando ya no espera, desde el panel.
product: dashboard
category: reservaciones
task: agregar-a-lista-de-espera
requiredPermissions:
  - reservations:read
featureCode: RESERVATIONS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - lista de espera
  - esperando lugar
  - anotar en espera
  - quitar de la lista de espera
---

## Antes de empezar

Reservaciones es para los negocios que tienen incluida esa función. Para agregar a alguien necesitas permiso para crear reservaciones; para quitarlo, permiso para cancelarlas.

## Pasos

1. En *Reservaciones* › *Lista de espera*, toca *Agregar a Lista*.
2. Escribe el *Nombre* y la *Hora deseada*. Si quieres, llena *Teléfono*, *Personas* y *Notas*.
3. Toca *Agregar a Lista*: sale «Agregado a la lista de espera».
4. Para quitar a alguien, toca la X de su renglón y luego *Remover*: sale «Removido de la lista de espera».

## Problemas frecuentes

- Si debajo de *Nombre* o de *Hora deseada* sale «Required», llena ese campo. Ese aviso sale antes de mandar el registro.
- «La lista de espera no esta habilitada» quiere decir que la lista está apagada: se prende con *Habilitar lista de espera*, en *Reservaciones* › *Ajustes* › *General*, y eso lo hace un administrador o el dueño.
- «La lista de espera esta llena» quiere decir que hay tantos registros esperando como el *Tamaño máximo* de *Reservaciones* › *Ajustes* › *General*; cada registro cuenta uno, sin importar cuántas *Personas* lleve.
- Si después de tocar *Agregar a Lista* sale cualquier error, incluidos los dos de arriba, no lo agregues otra vez: pudo quedar anotado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
- La X sale en los renglones que siguen *Esperando* o *Notificado*.
