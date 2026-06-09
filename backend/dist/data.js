"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MobilityDataService = void 0;
exports.defaultDataDir = defaultDataDir;
const path_1 = __importDefault(require("path"));
const xlsx_1 = __importDefault(require("xlsx"));
const THEME_RULES = [
    { theme: "Housing", words: ["housing", "accommodation", "rent"] },
    { theme: "Visa and Immigration", words: ["visa", "immigration", "permit"] },
    { theme: "Communication", words: ["communication", "transparency", "updates"] },
    { theme: "Language and Culture", words: ["language", "culture", "cultural"] },
    { theme: "Payroll and Tax", words: ["payroll", "tax", "withholding"] },
    { theme: "Relocation Logistics", words: ["relocation", "logistics", "move", "shipping"] },
    { theme: "Support Quality", words: ["support", "help", "assistance"] }
];
function normalize(value) {
    return String(value ?? "").trim();
}
function inferTheme(answer) {
    const text = answer.toLowerCase();
    for (const rule of THEME_RULES) {
        if (rule.words.some((w) => text.includes(w)))
            return rule.theme;
    }
    return "Other";
}
function confidenceFromN(n) {
    if (n < 3)
        return "very_low";
    if (n < 5)
        return "low";
    if (n < 10)
        return "medium";
    return "high";
}
function topThemes(answers, limit = 5) {
    const counts = new Map();
    for (const answer of answers) {
        const theme = inferTheme(answer);
        counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([theme, count]) => ({ theme, count }));
}
function countrySentimentLabel(text) {
    const lower = text.toLowerCase();
    const positiveWords = ["support", "good", "clear", "helpful", "efficient", "smooth", "positive"];
    const negativeWords = ["delay", "complex", "issue", "difficult", "stress", "negative", "frustrating"];
    const pos = positiveWords.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    const neg = negativeWords.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    if (pos - neg >= 2)
        return "positive";
    if (neg - pos >= 2)
        return "negative";
    return "neutral";
}
class MobilityDataService {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.rows = [];
        this.ragDocs = [];
    }
    load() {
        const workbookPath = path_1.default.join(this.dataDir, "Mobility_survey_data - Full 100 Assignees.xlsx");
        const workbook = xlsx_1.default.readFile(workbookPath);
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        this.rows = xlsx_1.default.utils.sheet_to_json(firstSheet, { defval: "" });
        this.ragDocs = this.buildRagDocs();
    }
    countries() {
        const byAssignee = new Map();
        for (const row of this.rows) {
            const assignee = normalize(row["Assignee ID"]);
            const country = normalize(row["Country"]);
            if (assignee && country && !byAssignee.has(assignee))
                byAssignee.set(assignee, country);
        }
        const counts = new Map();
        for (const country of byAssignee.values()) {
            counts.set(country, (counts.get(country) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([country, assigneeCount]) => ({ country, assigneeCount }));
    }
    insights(country) {
        const scopedRows = country
            ? this.rows.filter((r) => normalize(r["Country"]).toLowerCase() === country.toLowerCase())
            : this.rows;
        const assignees = new Set(scopedRows.map((r) => normalize(r["Assignee ID"])).filter(Boolean));
        const painAnswers = scopedRows
            .filter((r) => normalize(r["Question #"]) === "2")
            .map((r) => normalize(r["Answer"]));
        const improveAnswers = scopedRows
            .filter((r) => normalize(r["Question #"]) === "4")
            .map((r) => normalize(r["Answer"]));
        const positiveAnswers = scopedRows
            .filter((r) => ["1", "3", "5"].includes(normalize(r["Question #"])))
            .map((r) => normalize(r["Answer"]));
        return {
            scope: country ?? "Global",
            assigneeCount: assignees.size,
            confidence: confidenceFromN(assignees.size),
            topPainPoints: topThemes(painAnswers),
            whatsWorking: topThemes(positiveAnswers),
            improvementAreas: topThemes(improveAnswers)
        };
    }
    detectCountry(text) {
        const needle = text.toLowerCase();
        const names = this.countries().map((c) => c.country).sort((a, b) => b.length - a.length);
        return names.find((name) => needle.includes(name.toLowerCase()));
    }
    ragDocuments() {
        return this.ragDocs;
    }
    buildRagDocs() {
        const docs = [];
        for (const row of this.rows) {
            const assignee = normalize(row["Assignee ID"]);
            const country = normalize(row["Country"]);
            const qn = normalize(row["Question #"]);
            const answer = normalize(row["Answer"]);
            if (!assignee || !qn || !answer)
                continue;
            docs.push({
                id: `survey-${assignee}-${qn}-${docs.length}`,
                source: "survey",
                country: country || undefined,
                text: `Country: ${country || "Unknown"}\nQuestion: ${qn}\nAnswer: ${answer}`
            });
        }
        for (const country of this.countries().map((c) => c.country)) {
            const countryText = docs
                .filter((d) => (d.country ?? "").toLowerCase() === country.toLowerCase())
                .map((d) => d.text)
                .join("\n");
            const label = countrySentimentLabel(countryText);
            docs.push({
                id: `offline-sentiment-${country.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
                source: "offline-sentiment",
                country,
                text: `Country: ${country}\nOffline sentiment classification for mobility experience: ${label}. This is derived from survey responses only.`
            });
        }
        return docs;
    }
}
exports.MobilityDataService = MobilityDataService;
function defaultDataDir() {
    return process.env.DATA_DIR ?? path_1.default.resolve(process.cwd(), "..", "Mobility");
}
