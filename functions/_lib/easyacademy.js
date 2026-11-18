// Client for the public UNIMORE timetable portal (EasyAcademy by EasyStaff).
// Shared by the Pages Function (/ics) and the catalog build script.

export const PORTAL_URL = "https://www.aule.unimore.it/PortaleStudentiUnimore";
export const TIME_ZONE = "Europe/Rome";

const ACADEMIC_YEAR_START_MONTH = 8; // September (0-based)

// The portal exposes only department codes (facolta_code): readable names.
export const DEPARTMENT_NAMES = {
    ingegneria: "Ingegneria \"Enzo Ferrari\"",
    economia: "Economia \"Marco Biagi\"",
    sce: "Comunicazione ed Economia",
    lettere: "Studi Linguistici e Culturali",
    "DSLC - Lettorati": "Studi Linguistici e Culturali - Lettorati",
    medicina: "Area Medica (Medicina e Chirurgia)",
    scienze_vita: "Scienze della Vita",
    agr: "Scienze della Vita - Agraria e Alimenti",
    dscg: "Scienze Chimiche e Geologiche",
    ingre: "Scienze e Metodi dell'Ingegneria",
    educazione: "Educazione e Scienze Umane",
    smfn: "Scienze Fisiche, Informatiche e Matematiche",
    giurisprudenza: "Giurisprudenza",
};

export function departmentName(code) {
    return DEPARTMENT_NAMES[code] || String(code);
}

/** Academic year that is running on `now` (e.g. Nov 2026 -> 2026, meaning 2026/2027). */
export function currentAcademicYear(now = new Date()) {
    const year = now.getUTCFullYear();
    return now.getUTCMonth() >= ACADEMIC_YEAR_START_MONTH ? year : year - 1;
}

/** Extracts `var <name> = [...];` from the JavaScript served by combo.php. */
export function extractComboVar(source, name) {
    const match = source.match(new RegExp(`var ${name} = (.*?);\\s*(?:var |$)`, "s"));
    if (!match) {
        throw new Error(`combo.php: variabile ${name} non trovata`);
    }
    return JSON.parse(match[1]);
}

/** "PDS0-2026|1" -> 1 */
export function yearFromCurriculumValue(value) {
    const year = Number.parseInt(String(value).split("|")[1], 10);
    return Number.isInteger(year) ? year : null;
}

/** "1 - Percorso standard" -> "Percorso standard" */
export function curriculumLabel(label) {
    const parts = String(label).split(" - ");
    return parts.length > 1 ? parts.slice(1).join(" - ").trim() : String(label).trim();
}

/** Turns the raw combo.php payload into the compact catalog served as static JSON. */
export function buildCatalog(comboSource, academicYear) {
    const corsi = extractComboVar(comboSource, "elenco_corsi");
    const depCodes = [...new Set(corsi.map((c) => c.facolta_code).filter(Boolean))];
    return {
        aa: academicYear,
        dipartimenti: depCodes
            .map((code) => ({ id: code, label: departmentName(code) }))
            .sort((a, b) => a.label.localeCompare(b.label, "it")),
        corsi: corsi
            .map((c) => ({
                code: c.valore,
                label: c.label.trim(),
                tipo: (c.tipo || "").trim(),
                dip: c.facolta_code,
                anni: (c.elenco_anni || [])
                    .map((a) => ({
                        value: a.valore,
                        year: yearFromCurriculumValue(a.valore),
                        label: curriculumLabel(a.label),
                        lezioni: (a.elenco_insegnamenti || []).map((i) => ({
                            code: i.valore,
                            label: i.label.trim(),
                            docente: (i.docente || "").trim(),
                        })),
                    }))
                    .filter((a) => a.year !== null),
            }))
            .filter((c) => c.anni.length > 0),
    };
}

/** Form body for grid_call.php; `all_events=1` returns the whole academic year. */
export function gridCallBody({ aa, course, curriculum, date }) {
    const body = new URLSearchParams({
        view: "easycourse",
        "form-type": "corso",
        include: "corso",
        anno: String(aa),
        corso: course,
        date,
        _lang: "it",
        list: "",
        week_grid_type: "-1",
        col_cells: "0",
        empty_box: "0",
        only_grid: "0",
        highlighted_date: "0",
        all_events: "1",
        faculty_group: "0",
    });
    body.append("anno2[]", curriculum);
    return body;
}

function ddmmyyyy(date) {
    const d = String(date.getUTCDate()).padStart(2, "0");
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${d}-${m}-${date.getUTCFullYear()}`;
}

/** Downloads every lesson cell of one course/year/curriculum for the academic year. */
export async function fetchCells({ aa, course, curriculum, fetchImpl = fetch }) {
    const date = ddmmyyyy(new Date(Date.UTC(Number(aa), 9, 15))); // any date inside the year
    const response = await fetchImpl(`${PORTAL_URL}/grid_call.php`, {
        method: "POST",
        body: gridCallBody({ aa, course, curriculum, date }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) {
        throw new Error(`grid_call.php ha risposto ${response.status}`);
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.celle)) {
        throw new Error("grid_call.php: risposta senza elenco lezioni");
    }
    return data.celle;
}

function minutesOf(hhmm) {
    const [h, m] = String(hhmm).split(":").map((x) => Number.parseInt(x, 10));
    return h * 60 + m;
}

function stripTags(text) {
    return String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Converts portal cells into calendar events, keeping only the chosen teachings.
 * `lectureCodes` empty/undefined means "all teachings".
 */
export function cellsToEvents(cells, lectureCodes) {
    const wanted = lectureCodes && lectureCodes.length > 0 ? new Set(lectureCodes) : null;
    const events = [];
    for (const cell of cells) {
        const code = cell.codice_insegnamento;
        if (!code || !Number.isFinite(cell.timestamp)) {
            continue; // closures, holidays and other non-lesson cells
        }
        if (wanted && !wanted.has(code)) {
            continue;
        }
        const start = new Date(cell.timestamp * 1000);
        const durationMin = minutesOf(cell.ora_fine) - minutesOf(cell.ora_inizio);
        const end = new Date(start.getTime() + Math.max(durationMin, 0) * 60000);
        const cancelled = String(cell.Annullato) === "1";
        const title = stripTags(cell.titolo_lezione || cell.nome_insegnamento);
        const details = [
            cell.tipo && `Tipo: ${stripTags(cell.tipo)}`,
            cell.docente && `Docente: ${stripTags(cell.docente)}`,
            cell.notes && stripTags(cell.notes),
        ].filter(Boolean);
        const onlineLink = Array.isArray(cell.link_aula) ? cell.link_aula.find((l) => l) : null;
        events.push({
            uid: `${cell.id || `${code}-${cell.timestamp}`}@unimorecalendar`,
            title: cancelled ? `[ANNULLATA] ${title}` : title,
            start,
            end,
            location: stripTags(cell.aula) || null,
            description: details.join("\n") || null,
            url: onlineLink && /^https?:\/\//.test(onlineLink) ? onlineLink : null,
            cancelled,
        });
    }
    return events.sort((a, b) => a.start - b.start);
}
