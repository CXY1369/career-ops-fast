# Modo: pipeline — Inbox de URLs (Second Brain)

Procesa URLs de ofertas acumuladas en `data/pipeline.md`. El usuario agrega URLs cuando quiera y luego ejecuta `/career-ops pipeline` para procesarlas todas.

---

## Pre-procesamiento

```bash
node cv-sync-check.mjs
```
Si hay desincronización, avisar al usuario antes de continuar.

---

## Workflow

### Paso 1 — Leer URLs pendientes

Leer `data/pipeline.md` → extraer todos los items `- [ ]` de `## Pending`.

Pre-asignar números de reporte: listar `reports/`, extraer número más alto + 1, asignar secuencialmente a cada URL en orden de aparición.

---

### Paso 2 — Pre-triage (instant blockers, <5 seg/URL)

Para cada URL, hacer WebFetch rápido. Revisar **solo** los siguientes blockers antes de cualquier evaluación completa:

| Blocker | Condición | Acción |
|---------|-----------|--------|
| Comp ceiling | Salario máximo listado en JD < $100K | SKIP |
| YoE hard requirement | JD requiere 5+ años experience (industry, no research) | SKIP |
| Security clearance | JD requiere TS/SCI/Secret/clearance | SKIP |
| Required license | JD requiere RN, MD, CPA, JD, PE u otro título profesional | SKIP |

**Si SKIP:** escribir reporte de 1 párrafo en `reports/{num}-{slug}-{date}.md`, status=`SKIP` en TSV, marcar `- [!]` en pipeline.md. No ejecutar evaluación completa.

**Si ningún blocker:** continuar al Paso 3.

---

### Paso 3 — Grouping por arquetipo

Si `pipeline.md` tiene secciones (`### Category`), agrupar URLs por sección. Esto permite cargar **solo la sección CV relevante** en cada agente en lugar del CV completo.

**Tabla de secciones CV por arquetipo:**

| Sección en pipeline.md | Extracto de cv.md a incluir | Omitir |
|------------------------|----------------------------|----|
| AI/ML Engineer | CHACAM (1 bullet), MedLogic AI, Sign Language Generator, DistilBERT NER, PSYONIC, Skills (AI/ML + frameworks) | scRNA-seq detail, bio-heavy bullets |
| Data Scientist | CHACAM (stats angle, 1 bullet), Biogen (brief), Spark Streaming, Multi-Agent Trading, Skills (Python/SQL/stats/sklearn) | Full bio context, ligand-receptor details |
| Computational Biology / Bioinformatics | Education, CHACAM (full), Biogen (full), Publications, Skills (bio + ML) | Chase Offer Adder, SQL projects, OS simulator |
| Quant | PhD math context (1 sentence), Multi-Agent Trading System (full), Skills (Python/R/Matlab/C++) | Bio projects, scRNA-seq, MedLogic AI |
| (sin sección / default) | cv.md completo | — |

**Regla de agrupación:** lanzar 1 agente por sección (máximo 4 en paralelo). Si una sección tiene >3 URLs, dividir en sub-grupos de 2-3.

---

### Paso 4 — Lanzar agentes en paralelo

Para cada grupo lanzar un agente con `run_in_background=true` y `model="sonnet"`.

**Contenido del prompt del agente:**
1. El extracto de cv.md para el arquetipo (NO el cv.md completo)
2. Profile core: solo `candidate`, `compensation`, `work_preference` de profile.yml
3. Las URLs del grupo con sus report numbers pre-asignados
4. Las instrucciones de evaluación compacta (ver Paso 4a)

#### Paso 4a — Evaluación compacta por URL (dentro del agente)

Para cada URL, ejecutar **solo estos bloques**:

| Bloque | ¿Ejecutar? | Notas |
|--------|-----------|-------|
| A — Resumen del Rol | ✅ siempre | |
| B — Match con CV | ✅ siempre | Solo con la sección CV del grupo |
| C — Nivel y Estrategia | ✅ siempre | |
| **Scoring Gate → asignar Tier** | ✅ siempre | Determina qué sigue |
| D — Comp y Demanda | ✅ Tier 1 y 2 | Skip si Tier 3. Para empresas conocidas (HRT, Figma, Five Rings, FAANG, etc.) usar benchmark interno — NO hacer WebSearch |
| **E — Plan de Personalización** | ❌ NUNCA | Se genera bajo demanda con `/career-ops pdf` |
| **F — Plan de Entrevistas** | ❌ NUNCA | Se genera bajo demanda con `/career-ops interview-prep` |
| G — Posting Legitimacy | ✅ Tier 1 y 2 | Skip si Tier 3. Para empresas con 1000+ empleados o cotizadas en bolsa: "Established employer — skip layoff search" |
| Keywords | ✅ solo Tier 1 | Para ATS optimization en futuros PDFs |

**Nota de comp para empresas conocidas (NO hacer WebSearch):**
Usar conocimiento de entrenamiento directamente para: Stripe, Google, Meta, Amazon, Microsoft, Apple, Netflix, Uber, Airbnb, Figma, HRT, Citadel, Two Sigma, Five Rings, Jump Trading, DE Shaw, y cualquier empresa cotizada con >1000 empleados. Citar como "industry-known benchmark."

**Resultado por Tier:**
- **Tier 1 (≥4.2):** Reporte completo A + B + C + D + G + Keywords. Header: `**PDF:** Pending — generate with /career-ops pdf {num}`. Nota en TSV: "Tier 1: [key reason]. Generate tailored PDF."
- **Tier 2 (3.0–4.1):** Reporte A + B + C + D + G. Indicar master CV: `output/master-cv-{archetype}.pdf`. Nota en TSV: "Tier 2: [key reason]. Use master-cv-{archetype}.pdf."
- **Tier 3 (<3.0):** Reporte de 1 párrafo. Status = `SKIP`. Nota en TSV: "Tier 3: [blocker]. SKIP."

---

### Paso 5 — Contrato de salida del agente (CRÍTICO)

**Los agentes NO usan Write ni Bash. Solo devuelven texto estructurado.**

El orchestrador (sesión principal) escribe todos los archivos. Formato de retorno por URL evaluada:

```
=== REPORT_{NUM} ===
# Evaluation: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**Archetype:** {detected}
**Score:** {X.X/5}
**URL:** {url}
**Legitimacy:** {tier}
**PDF:** {note}

[bloques A B C D G según aplique]
=== TSV_{NUM} ===
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t❌\t[{num}](reports/{filename}.md)\t{one-line note}
=== END_{NUM} ===
```

Si el agente maneja 2 URLs, devuelve dos bloques `REPORT/TSV/END` consecutivos.

---

### Paso 6 — Orchestrador escribe archivos

Al completar todos los agentes, el **orchestrador (sesión principal)**:

1. Parsear cada bloque `=== REPORT_{NUM} ===` → Write a `reports/{num}-{slug}-{date}.md`
2. Parsear cada bloque `=== TSV_{NUM} ===` → Write a `batch/tracker-additions/{num}-{slug}.tsv`
3. Ejecutar `node merge-tracker.mjs` **una sola vez** al final
4. Actualizar `data/pipeline.md`: mover items de `## Pending` a `## Processed`

---

### Paso 7 — Resumen final

Mostrar tabla:

```
| # | Empresa | Rol | Score | Tier | PDF | Acción recomendada |
```

---

## Formato de pipeline.md

```markdown
## Pending

### AI/ML Engineer
- [ ] https://... | Company | Role

### Data Scientist
- [ ] https://... | Company | Role

## Processed
- [x] #008 | https://... | Company | Role | 4.3/5 | PDF ❌
- [!] #009 | https://... | Company | Role — SKIP (comp $80K < $100K floor)
```

---

## Casos especiales en JD detection

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con SPAs.
2. **WebFetch (fallback):** Para páginas estáticas.
3. **WebSearch (último recurso):** `"{company} {role} job description 2026"`

- **LinkedIn:** Puede requerir login → marcar `[!]` y pedir al usuario que pegue el texto
- **PDF:** URL apunta a PDF → leer con Read tool
- **`local:` prefix:** `local:jds/role.md` → leer `jds/role.md`
