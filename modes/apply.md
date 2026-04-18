## Files to Load

- `config/profile.yml` — candidate identity and targets (core sections)
- `config/profile-apply.yml` — work authorization, demographics, common answers (form-filling data)
- `cv.md` — required for generating form answers
- `modes/_profile.md` — archetypes and framing

# Modo: apply — Auto-Aplicación con Playwright

Modo **totalmente automatizado** para llenar + subir PDF + (opcional) enviar aplicaciones vía Playwright. Bypasea las restricciones de Chrome/Simplify usando CDP directamente.

**Stack:** `apply-form.mjs` (Playwright) + config JSON generado por este modo.

---

## Invocación

| Argumento | Comportamiento |
|-----------|---------------|
| `/career-ops apply {URL}` | Navegar a esa URL |
| `/career-ops apply {NUM}` | Buscar URL en `reports/{NUM}-*.md` → navegar |
| `/career-ops apply {company}` | Buscar report por nombre → navegar |
| `/career-ops apply` | Pedir URL al usuario |

**Resolución de URL desde número de reporte:**
1. Glob `reports/{NUM}-*.md`
2. Extraer `**URL:**` del header
3. Usar esa URL

---

## Workflow

```
1. RESOLVER URL         → según argumento
2. LEER REPORT          → cargar scores, proof points, Section E/F/G si existe
3. DETECTAR PDF         → buscar output/cv-{candidate}-{company}-*.pdf
                          Si no existe → ejecutar /career-ops pdf {NUM} primero
4. GENERAR RESPUESTAS   → para cada pregunta custom del JD, generar respuesta
                          personalizada basada en el report + cv.md
5. ESCRIBIR CONFIG      → /tmp/apply-config-{company}.json
6. LANZAR PLAYWRIGHT    → node apply-form.mjs /tmp/apply-config-{company}.json
7. MOSTRAR STATUS       → informar qué se llenó, qué quedó pendiente
8. POST-APPLY           → si user confirma envío, actualizar tracker
```

---

## Paso 1 — Resolver URL y cargar report

Leer el report correspondiente. Extraer:
- URL
- Company, Role
- Score, Archetype
- Section E (personalización) y F (STAR stories) — se usan para generar respuestas custom
- Keywords extraídas

---

## Paso 2 — Verificar/generar PDF tailored

Buscar `output/cv-{candidate}-{company-slug}-*.pdf`.

- **Si existe**: usar la más reciente.
- **Si no existe**: avisar al user y ofrecer generar con `/career-ops pdf {NUM}` antes de continuar.

---

## Paso 3 — Inspeccionar el formulario

Antes de escribir el config, inspeccionar el formulario para identificar campos custom (question IDs, dropdowns específicos del role).

**Opción A — Pre-scan con WebFetch/Playwright MCP:**
Navegar brevemente a la URL, extraer IDs visibles de campos custom (`question_XXXXXXX`), detectar dropdowns vs text areas.

**Opción B — Assumir estándar Greenhouse:**
Usar los campos base conocidos (`first_name`, `last_name`, `email`, `phone`) y dejar `custom_answers`/`dropdowns` vacíos. El script `apply-form.mjs` llenará lo que puede y dejará el resto al user.

Para Greenhouse (la gran mayoría), los IDs estándar son:
- `first_name`, `last_name`, `email`, `phone`
- `candidate-location` (location autocomplete)
- Custom: `question_{digits}` — requiere inspección

---

## Paso 4 — Generar respuestas para preguntas custom

Para cada pregunta custom que identificamos en el formulario:

1. **Si la pregunta ya está en Section G del report** → usar esa respuesta, refinar si cambió el rol.
2. **Si es nueva** → generar desde:
   - Proof points (Block B del report)
   - Historias STAR+R (Block F)
   - `cv.md` + `profile.yml`
3. **Reglas de tono:**
   - "I'm choosing you" framing — específico al rol y empresa
   - Referenciar algo concreto del JD
   - Incluir un proof point con métrica si hay campo "Additional info"
   - Sin corporate speak (ver `_shared.md`)
4. **Respuestas comunes** (work auth, salary, location) → usar `profile-apply.yml` + `profile.yml`

---

## Paso 5 — Escribir config JSON

Escribir `/tmp/apply-config-{company-slug}.json`:

```json
{
  "url": "https://job-boards.greenhouse.io/...",
  "pdf_path": "/abs/path/to/cv.pdf",
  "cover_letter_pdf": null,
  "fields": {
    "first_name": "Xingyu",
    "last_name": "Chen",
    "email": "cxy1368@gmail.com",
    "phone": "+1-217-721-2866"
  },
  "custom_answers": {
    "question_11592189007": "Yes, I am willing to relocate..."
  },
  "dropdowns": {
    "question_11592190007": "Yes, I am currently legally authorized",
    "question_11592191007": "No, I do not and will not require sponsorship"
  },
  "auto_submit": false,
  "keep_open_seconds": 600
}
```

**⚠️ auto_submit:**
- Por defecto `false` — el user revisa y hace click en Submit manualmente
- `true` solo si el user dio instrucción explícita en el mismo mensaje ("envíalo automáticamente", "auto submit")
- **Regla ética (CLAUDE.md):** nunca enviar sin permiso explícito para este mensaje específico

---

## Paso 6 — Lanzar Playwright

```bash
cd /Users/xingyuchen/.../career-ops
node apply-form.mjs /tmp/apply-config-{company-slug}.json
```

El script:
1. Abre Chromium visible
2. Navega a la URL
3. Si está en la JD → click Apply
4. Llena campos por ID o label
5. Sube PDF via `setInputFiles()` (bypass Chrome security)
6. Resuelve dropdowns react-select por text match
7. Mantiene el navegador abierto para revisión (o envía si `auto_submit: true`)

---

## Paso 7 — Mostrar resultado

```
## Auto-Apply: [Empresa] — [Rol]

✅ Llenado:
  - Fields: first_name, last_name, email, phone
  - Custom: [lista]
  - Resume: cv-xingyu-chen-togetherai-2026-04-16.pdf
  - Dropdowns: work auth, sponsorship

⚠️ Pendiente revisión manual:
  - [cualquier campo que falló]

El navegador queda abierto 10 min. Revisa y haz click en Submit cuando estés listo.
```

---

## Paso 8 — Post-apply (si user confirma envío)

1. Actualizar `applications.md`: "Evaluated" → "Applied"
2. Actualizar Section G del report con las respuestas finales
3. Sugerir `/career-ops contacto {NUM}` para LinkedIn outreach

---

## Fallback sin argumento / sin Playwright

Si el user pega screenshot o texto del formulario:
1. Extraer preguntas manualmente
2. Generar respuestas (mismo proceso Paso 4)
3. Presentar en formato copy-paste

---

## Flag `auto_submit: true` — Totalmente automático

Cuando el user haya dicho explícitamente "auto submit" o configurado `apply.auto_submit: true` en `profile.yml`:

1. El script espera 3s después de llenar todo
2. Click en Submit
3. Espera confirmation
4. Cierra navegador
5. Actualiza tracker automáticamente

**Requisitos para activar auto_submit:**
- Score del report ≥ 4.0
- Todos los campos required se llenaron OK
- No hay "Additional info" que requiera intervención humana
- Legitimacy = High Confidence

Si alguno falla → desactivar auto_submit y dejar navegador abierto.
