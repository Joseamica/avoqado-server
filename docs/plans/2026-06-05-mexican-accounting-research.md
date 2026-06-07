# Investigación verificada: Contabilidad mexicana para el módulo de Avoqado

Generado por /deep-research (gstack) — 2026-06-05 Verificación adversaria: 138 claims extraídos → 25 verificados → **22 confirmados (3-0
unánimes), 3 eliminados** · 29 fuentes (6 angles) Anclado a: Anexo 24 RMF 2026 (DOF 13-ene-2026) + XSD v1.3 descargados en vivo jun-2026
Compañero de: `2026-06-05-accounting-module-design.md`

> Qué hace ÚNICA a la contabilidad mexicana vs US GAAP/IFRS, y qué obliga eso en el diseño del módulo.

## Los 4 mecanismos legales que no existen igual en otros países

### 1. Contabilidad electrónica del SAT (Anexo 24) — capa de normalización gubernamental

Obligación bajo **Art. 28 fr. IV CFF** + RMF 2.8.1.5/2.8.1.6/2.8.1.8. Tres entregables:

- **Catálogo de cuentas** (XML v1.3) — campos: `Versión, RFC, Mes, Año, CodAgrup, NumCta, Descripción, SubCtaDe, Nivel, Naturaleza`. Solo se
  exige hasta 2 niveles.
- **Balanza de comprobación** (XML v1.3) — **MENSUAL**. Header: `RFC, Mes (01-13, 13=cierre anual), Año, TipoEnvio (N|C), FechaModBal`. Por
  cuenta: **`NumCta, SaldoIni, Debe, Haber, SaldoFin`** (5 campos). Ojo: el código agrupador NO va en la balanza, solo en el catálogo.
- **Pólizas** (XML v1.3) — **SOLO a solicitud** (Acto de Fiscalización, Compulsa, Devolución, Compensación). NO mensual.
- → El envío mensual es **catálogo + balanza**. Pólizas se generan en auditoría/devolución.

**Código agrupador del SAT** (`CodAgrup`, requerido): cada cuenta mapea a un código estandarizado del SAT por naturaleza (101 Caja, 102
Bancos, 118 IVA acreditable, 118.01 IVA acreditable pagado, 208 IVA trasladado…). **Esto no existe en GAAP/IFRS** — es lo más sorprendente
para quien viene de contabilidad gringa/europea.

XSD vigente: **solo v1.3** en 2026 (v1.1 ya rechazada por el Buzón). El estándar XML no cambia desde 2017; solo ajustes cosméticos
2024→2026.

### 2. El CFDI (XML timbrado) ES el respaldo legal de cada ingreso y gasto

- Cada **póliza debe ligar el UUID del CFDI** (nodo `CompNal`, atributo `UUID_CFDI` de 36 chars requerido) + RFC del tercero + monto total
  con IVA.
- En **pagos en parcialidades/diferidos (PPD)**, el **REP (Recibo Electrónico de Pago / complemento de pago)** es **requisito** para
  acreditar IVA y deducir el gasto — el XML del pago, no solo la factura.
- → La factura y la contabilidad están atadas legalmente. En otros países la factura es secundaria; en México es el documento fiscal
  primario. **Avoqado nace con ventaja: ya genera/recibe esos XML.**

### 3. IVA en FLUJO DE EFECTIVO (base cash), no devengado

- El IVA se causa **cuando se cobra/paga efectivamente** (Arts. 11, 17 y **1o-B** LIVA), NO al facturar ni al devengar. "Efectivamente
  cobradas" = se reciben en efectivo/bienes/servicios (incluso anticipos) o se extingue la obligación.
- → Difiere del IVA por devengado de la UE. **El módulo debe reconocer IVA en eventos de cobro/pago reales, no en la emisión del CFDI.**
  Requiere cuentas puente: _IVA trasladado cobrado_ vs _no cobrado_, _IVA acreditable pagado_ vs _pendiente_.

### 4. Regímenes simplificados RELEVADOS del envío

- **RESICO PF/PM, Arrendamiento, Servicios Profesionales, RIF** están **relevados del ENVÍO** de contabilidad electrónica si registran en
  **"Mis cuentas"**. **RESICO PF también exento de DIOT** (RMF 3.13.16).
- La exención es del **envío mensual del XML**, NO de llevar/conservar registros (deben producirse si el SAT ejerce facultades o hay
  devolución/compensación).
- → **El #4 (envío de contabilidad electrónica) sirve a MENOS venues de los que parece.** Confirma el wedge-first: solo los de régimen
  general (PM 601, mayores) necesitan el envío XML.

## Otras obligaciones confirmadas

- **DIOT** (Art. 32 fr. VIII LIVA): mensual, día 17 del mes siguiente (RMF 2026 lo extiende administrativamente al último día del mes).
  Reporta IVA de operaciones **con proveedores, desglosado por tasa**. → el módulo necesita detalle de IVA por proveedor y por tasa.

## Implicaciones de diseño (qué necesita el módulo para cumplir)

| Requisito legal          | Qué exige en el modelo/reporte                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Código agrupador         | Campo `satGroupingCode` por cuenta (ya en el plan) ✓                                                        |
| Catálogo XML             | Generador con `Versión, RFC, Mes, Año, CodAgrup, NumCta, Desc, SubCtaDe, Nivel, Naturaleza`                 |
| Balanza XML mensual      | Por periodo: `SaldoIni, Debe, Haber, SaldoFin` por cuenta + header `RFC/Mes(01-13)/Año/TipoEnvio`           |
| Pólizas XML (on-demand)  | Generador a solicitud; **no** mensual → menor prioridad                                                     |
| CFDI como respaldo       | `JournalEntry` lleva `uuidCfdi (36) + rfcTercero + montoTotalConIva` para el nodo CompNal                   |
| IVA en flujo de efectivo | Postear IVA en evento de **cobro/pago**, no en emisión. Cuentas puente cobrado/no-cobrado, pagado/pendiente |
| DIOT                     | `Expense`: RFC proveedor + IVA por tasa (16 / 8 frontera / 0 / exento) + tipo operación                     |
| REP (PPD)                | Rastrear complemento de pago del lado de gastos para deducibilidad                                          |
| Régimen                  | Flag de régimen en el emisor que **active/desactive** la obligación de envío                                |

## NO cubierto por esta investigación (sin claims sobrevivientes — investigar aparte antes de diseñar)

- **ISR**: pagos provisionales, coeficiente de utilidad (PM 601), declaración anual, tasas/límites RESICO PF 2026.
- **Nómina**: estructura del CFDI de nómina, retención ISR por tablas, cuotas IMSS/INFONAVIT, subsidio al empleo 2026.
- **NIF vs IFRS/US GAAP**: NIF B-10 (reexpresión por inflación), PTU, qué difiere material para PyMEs.
- **Detalle IVA→contabilidad**: modelar cuentas puente (códigos 118/208) para reflejar causación por flujo en la balanza.

## Claims ELIMINADOS por verificación adversaria (NO asumir como ciertos)

- ❌ "El REP debe emitirse a más tardar el día 10 del mes siguiente, ligado al IVA" — eliminado (no asumir un plazo específico sin
  verificar).
- ❌ "TODAS las personas morales y PF con actividad/arrendamiento deben enviar contabilidad electrónica" — eliminado (hay excepciones:
  RESICO, Mis cuentas).

## Notas de vigencia

- La RMF se reemite cada año; verificar versión vigente antes de implementar (el XML v1.3 no cambia desde 2017).
- Renumeración de reglas RMF 2026 (1.4 fr.XXIV, 2.8.1.6/7/10) difiere de la legacy (2.8.1.5/6/8) — verificar numeración para referencias
  normativas.

## Fuentes primarias (SAT / DOF / leyes)

- Anexo 24 RMF 2026 (DOF 13-ene-2026):
  https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo_24_RMF2026-13012026.pdf
- XSD Balanza 1.3: http://omawww.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd
- XSD Catálogo 1.3: http://omawww.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd
- Doc técnico Contabilidad Electrónica: https://www.gob.mx/cms/uploads/attachment/file/154200/Doc_tecnico_Cont_Electronica.pdf
- Contabilidad electrónica (SAT): https://www.gob.mx/sat/acciones-y-programas/contabilidad-electronica-173700
- LIVA (Arts. 1o-B, 11, 17, 32): https://www.diputados.gob.mx/LeyesBiblio/pdf/LIVA.pdf
- REP preguntas frecuentes (SAT): http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/PregFrec_RP.pdf

(29 fuentes totales; 7 primarias. Lista completa en el resultado del workflow.)
