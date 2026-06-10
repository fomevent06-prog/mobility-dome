import path from "path";
import XLSX from "xlsx";

type Row = Record<string, string | number | Date>;
export type RagDocument = { id: string; text: string; source: string; country?: string };

export type CountrySummary = {
  country: string;
  assigneeCount: number;
};

export type InsightPayload = {
  scope: string;
  assigneeCount: number;
  confidence: "very_low" | "low" | "medium" | "high";
  topPainPoints: Array<{ theme: string; count: number }>;
  whatsWorking: Array<{ theme: string; count: number }>;
  improvementAreas: Array<{ theme: string; count: number }>;
};

const THEME_RULES: Array<{ theme: string; words: string[] }> = [
  { theme: "Housing", words: ["housing", "accommodation", "rent"] },
  { theme: "Visa and Immigration", words: ["visa", "immigration", "permit"] },
  { theme: "Communication", words: ["communication", "transparency", "updates"] },
  { theme: "Language and Culture", words: ["language", "culture", "cultural"] },
  { theme: "Payroll and Tax", words: ["payroll", "tax", "withholding"] },
  { theme: "Relocation Logistics", words: ["relocation", "logistics", "move", "shipping"] },
  { theme: "Support Quality", words: ["support", "help", "assistance"] }
];

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function inferTheme(answer: string): string {
  const text = answer.toLowerCase();
  for (const rule of THEME_RULES) {
    if (rule.words.some((w) => text.includes(w))) return rule.theme;
  }
  return "Other";
}

function confidenceFromN(n: number): InsightPayload["confidence"] {
  if (n < 3) return "very_low";
  if (n < 5) return "low";
  if (n < 10) return "medium";
  return "high";
}

function topThemes(answers: string[], limit = 5): Array<{ theme: string; count: number }> {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    const theme = inferTheme(answer);
    counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([theme, count]) => ({ theme, count }));
}

export class MobilityDataService {
  private rows: Row[] = [];
  private ragDocs: RagDocument[] = [];

  constructor(private readonly dataDir: string) {}

  load(): void {
    const workbookPath = path.join(this.dataDir, "Mobility_survey_data - Full 100 Assignees.xlsx");

    const workbook = XLSX.readFile(workbookPath);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    this.rows = XLSX.utils.sheet_to_json<Row>(firstSheet, { defval: "" });
    this.ragDocs = this.buildRagDocs();
  }

  countries(): CountrySummary[] {
    const byAssignee = new Map<string, string>();
    for (const row of this.rows) {
      const assignee = normalize(row["Assignee ID"]);
      const country = normalize(row["Country"]);
      if (assignee && country && !byAssignee.has(assignee)) byAssignee.set(assignee, country);
    }
    const counts = new Map<string, number>();
    for (const country of byAssignee.values()) {
      counts.set(country, (counts.get(country) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([country, assigneeCount]) => ({ country, assigneeCount }));
  }

  insights(country?: string): InsightPayload {
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

  detectCountry(text: string): string | undefined {
    const needle = text.toLowerCase();
    const names = this.countries().map((c) => c.country).sort((a, b) => b.length - a.length);
    return names.find((name) => needle.includes(name.toLowerCase()));
  }

  ragDocuments(): RagDocument[] {
    return this.ragDocs;
  }

  private buildRagDocs(): RagDocument[] {
    const docs: RagDocument[] = [];

    for (const row of this.rows) {
      const assignee = normalize(row["Assignee ID"]);
      const country = normalize(row["Country"]);
      const qn = normalize(row["Question #"]);
      const answer = normalize(row["Answer"]);
      if (!assignee || !qn || !answer) continue;
      docs.push({
        id: `survey-${assignee}-${qn}-${docs.length}`,
        source: "survey",
        country: country || undefined,
        text: `Country: ${country || "Unknown"}\nQuestion: ${qn}\nAnswer: ${answer}`
      });
    }

    return docs;
  }
}

export function defaultDataDir(): string {
  return process.env.DATA_DIR ?? path.resolve(process.cwd(), "..", "Mobility");
}
