---
title: Agregar o editar un cliente en el panel
description: Da de alta un cliente con su nombre y su correo o teléfono, o cambia sus datos, desde Clientes en el panel.
product: dashboard
category: clientes
task: agregar-o-editar-cliente
requiredPermissions:
  - customers:read
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - nuevo cliente
  - dar de alta cliente
  - editar cliente
  - cambiar teléfono del cliente
---

## Antes de empezar

Necesitas permiso para ver clientes. Para dar de alta uno necesitas permiso para crear clientes, y para cambiar sus datos, permiso para editarlos. Para elegir su *Grupo de Cliente* también necesitas permiso para ver los grupos; sin él, la lista sólo trae *Sin Grupo*.

## Pasos

1. En *Clientes* › *Todos los Clientes*, toca *Nuevo Cliente*.
2. Escribe el *Nombre*, el *Apellido* y al menos el *Email* o el *Teléfono*. Si quieres, también la *Fecha de nacimiento* y el *Grupo de Cliente*.
3. Toca *Crear Cliente*: sale «Cliente creado exitosamente».
4. Para cambiar uno, en la lista toca ⋯ › *Editar*, o abre el cliente y toca *Editar*. Haz el cambio y toca *Guardar Cambios*.

## Problemas frecuentes

- Debajo del campo sale lo que falta, por ejemplo «Pon al menos un correo o un teléfono para poder contactarlo» o «El teléfono debe tener al menos 10 caracteres».
- Al editar, el correo o el teléfono que el cliente ya tenía no se pueden dejar vacíos: escribe uno nuevo o déjalo como estaba.
- Si sale «El cliente se guardó, pero no se pudo registrar su consentimiento de marketing», el cliente sí quedó guardado; lo que no quedó es su permiso para recibir correos.
- Si sale «Error», el aviso trae la razón; si no la trae, dice «Ocurrió un error. Por favor intenta de nuevo.»
- Si al crear sale «Error», aunque diga que ya existe un cliente con ese correo o teléfono, no lo vuelvas a crear: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
