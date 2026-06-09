import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";
import { CountrySummary, InsightPayload, RagDocument } from "./data";

const GUIDE_PAGE_URL =
  "https://www.ey.com/en_gl/technical/tax-guides/worldwide-personal-tax-and-immigration-guide";

type GuideCache = {
  updatedAt: string;
  sourcePdfUrl: string;
  rawText: string;
  countries: string[];
  countrySentiment: Record<string, "positive" | "neutral" | "negative">;
  docs: RagDocument[];
};

function normalizeText(text: string): string {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function resolvePdfUrl(landingHtml: string): string | null {
  const match = landingHtml.match(/href="(\/content\/dam\/[^"]+worldwide[^"]+immigration[^"]+\.pdf)"/i);
  if (!match?.[1]) return null;
  return new URL(match[1], "https://www.ey.com").toString();
}

function chunkText(text: string, source: string, chunkSize = 1800, overlap = 220): RagDocument[] {
  const docs: RagDocument[] = [];
  let i = 0;
  let idx = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + chunkSize);
    const slice = text.slice(i, end).trim();
    if (slice) {
      docs.push({ id: `ey-guide-${idx}`, source, text: slice });
      idx += 1;
    }
    if (end >= text.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return docs;
}

function normalizeCountryName(input: string): string {
  return input
    .replace(/\s*\(other jurisdictions chapter\)\s*/gi, "")
    .replace(/\s*\(European Union Member State\)\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCountryPageStarts(text: string): Array<{ country: string; page: number }> {
  const starts: Array<{ country: string; page: number }> = [];
  const tocStart = text.indexOf("\nContents\n");
  const tocEnd = text.indexOf("\n-- 8 of", tocStart > -1 ? tocStart : 0);
  const toc = tocStart > -1 && tocEnd > tocStart ? text.slice(tocStart, tocEnd) : text.slice(0, 120000);
  const re = /\n([A-Z][A-Za-z .,'’&()/-]{2,80})\s+\.{3,}\s+(\d{2,4})\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toc)) !== null) {
    const country = normalizeCountryName(m[1]);
    const page = Number(m[2]);
    if (!country || Number.isNaN(page)) continue;
    if (/^(About|EY Global Tax contacts|Contacts for other jurisdictions|Currencies|EY Global People|Preface|Contents)/i.test(country)) continue;
    starts.push({ country, page });
  }
  const dedup = new Map<string, number>();
  for (const s of starts) {
    if (!dedup.has(s.country)) dedup.set(s.country, s.page);
  }
  return [...dedup.entries()].map(([country, page]) => ({ country, page })).sort((a, b) => a.page - b.page);
}

function extractSectionByPage(text: string, startPage: number, endPage: number): string {
  const startToken = `-- ${startPage} of `;
  const endToken = `-- ${endPage} of `;
  const startIdx = text.indexOf(startToken);
  if (startIdx < 0) return "";
  const endIdx = endPage > startPage ? text.indexOf(endToken, startIdx + startToken.length) : -1;
  const slice = endIdx > startIdx ? text.slice(startIdx, endIdx) : text.slice(startIdx);
  return slice.trim();
}

function buildDocsFromText(text: string): { docs: RagDocument[]; countries: string[] } {
  const countryPages = extractCountryPageStarts(text);
  const sections = countryPages.map((cp, i) => {
    const next = countryPages[i + 1];
    const endPage = next ? next.page : 9999;
    return { country: cp.country, content: extractSectionByPage(text, cp.page, endPage) };
  });
  if (!sections.length) {
    return { docs: chunkText(text, "ey-worldwide-guide").slice(0, 320), countries: [] };
  }

  const docs: RagDocument[] = [];
  const countries: string[] = [];
  for (const section of sections) {
    if (!section.content || section.content.length < 400) continue;
    countries.push(section.country);
    const chunks = chunkText(section.content, "ey-worldwide-guide", 1500, 180).slice(0, 3);
    for (let i = 0; i < chunks.length; i += 1) {
      docs.push({
        id: `${section.country.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}`,
        source: chunks[i].source,
        country: section.country,
        text: `Country: ${section.country}\n${chunks[i].text}`
      });
    }
  }
  return { docs: docs.slice(0, 320), countries: [...new Set(countries)] };
}

function countrySentimentLabel(text: string): "positive" | "neutral" | "negative" {
  const lower = text.toLowerCase();
  const positiveWords = [
    "exempt",
    "favorable",
    "relief",
    "clear",
    "streamlined",
    "flexible",
    "incentive",
    "support"
  ];
  const negativeWords = [
    "complex",
    "restriction",
    "penalty",
    "risk",
    "burden",
    "strict",
    "taxed",
    "withholding",
    "requirement"
  ];
  const pos = positiveWords.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
  const neg = negativeWords.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
  if (pos - neg >= 2) return "positive";
  if (neg - pos >= 2) return "negative";
  return "neutral";
}

function buildCountrySentimentDocs(
  docs: RagDocument[],
  countries: string[]
): { sentimentMap: Record<string, "positive" | "neutral" | "negative">; sentimentDocs: RagDocument[] } {
  const sentimentMap: Record<string, "positive" | "neutral" | "negative"> = {};
  const sentimentDocs: RagDocument[] = [];
  for (const country of countries) {
    const countryText = docs
      .filter((d) => (d.country ?? "").toLowerCase() === country.toLowerCase())
      .map((d) => d.text)
      .join("\n");
    const label = countrySentimentLabel(countryText);
    sentimentMap[country] = label;
    sentimentDocs.push({
      id: `offline-sentiment-${country.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      source: "offline-sentiment",
      country,
      text: `Country: ${country}\nOffline sentiment classification for mobility experience: ${label}. This label is a heuristic signal from the country text and should be treated as directional only.`
    });
  }
  return { sentimentMap, sentimentDocs };
}

export class EyGuideDataService {
  private docs: RagDocument[] = [];
  private countriesList: string[] = [];
  private countrySentiment: Record<string, "positive" | "neutral" | "negative"> = {};
  private readonly cachePath: string;

  constructor(private readonly dataDir: string) {
    this.cachePath = path.join(this.dataDir, "_ey_worldwide_guide_cache.json");
  }

  async load(): Promise<void> {
    try {
      const landing = await fetch(GUIDE_PAGE_URL);
      if (!landing.ok) throw new Error(`Landing page fetch failed: ${landing.status}`);
      const html = await landing.text();
      const pdfUrl = resolvePdfUrl(html);
      if (!pdfUrl) throw new Error("Could not resolve EY guide PDF URL from landing page.");

      const pdfResponse = await fetch(pdfUrl);
      if (!pdfResponse.ok) throw new Error(`Guide PDF fetch failed: ${pdfResponse.status}`);
      const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
      const parser = new PDFParse({ data: pdfBytes });
      const parsed = await parser.getText();
      await parser.destroy();
      const rawText = normalizeText(parsed.text || "");
      const { docs, countries } = buildDocsFromText(rawText);
      const { sentimentMap, sentimentDocs } = buildCountrySentimentDocs(docs, countries);
      if (!docs.length) throw new Error("No text chunks were extracted from EY guide PDF.");

      this.docs = [...docs, ...sentimentDocs];
      this.countriesList = countries;
      this.countrySentiment = sentimentMap;
      const cache: GuideCache = {
        updatedAt: new Date().toISOString(),
        sourcePdfUrl: pdfUrl,
        rawText,
        countrySentiment: this.countrySentiment,
        docs: this.docs,
        countries: this.countriesList
      };
      fs.writeFileSync(this.cachePath, JSON.stringify(cache));
    } catch (error) {
      if (!fs.existsSync(this.cachePath)) {
        throw error;
      }
      const cached = JSON.parse(fs.readFileSync(this.cachePath, "utf-8")) as GuideCache;
      this.docs = cached.docs ?? [];
      this.countriesList = cached.countries ?? [];
      this.countrySentiment = cached.countrySentiment ?? {};
      if (!this.docs.some((d) => d.source === "offline-sentiment") && this.countriesList.length) {
        const baseDocs = this.docs.filter((d) => d.source !== "offline-sentiment");
        const { sentimentMap, sentimentDocs } = buildCountrySentimentDocs(baseDocs, this.countriesList);
        this.countrySentiment = sentimentMap;
        this.docs = [...baseDocs, ...sentimentDocs];
      }
      if (!this.docs.length) throw error;
    }
  }

  ragDocuments(): RagDocument[] {
    return this.docs;
  }

  detectCountry(text: string): string | undefined {
    const needle = text.toLowerCase();
    const sorted = [...this.countriesList].sort((a, b) => b.length - a.length);
    return sorted.find((c) => needle.includes(c.toLowerCase()));
  }

  countries(): CountrySummary[] {
    return this.countriesList.map((country) => ({ country, assigneeCount: 0 }));
  }

  insights(country?: string): InsightPayload {
    const scoped = this.docs.filter((d) => !country || (d.country ?? "").toLowerCase() === country.toLowerCase());
    const assigneeCount = scoped.length;
    const simple = (word: string) => scoped.filter((d) => d.text.toLowerCase().includes(word)).length;
    const confidence: InsightPayload["confidence"] =
      assigneeCount >= 25 ? "high" : assigneeCount >= 12 ? "medium" : assigneeCount >= 5 ? "low" : "very_low";
    return {
      scope: country ?? "Global",
      assigneeCount,
      confidence,
      topPainPoints: [
        { theme: "Tax complexity", count: simple("tax") },
        { theme: "Immigration compliance", count: simple("immigration") },
        { theme: "Work authorization", count: simple("work authorization") }
      ],
      whatsWorking: [{ theme: "Treaty guidance coverage", count: simple("treaty") }],
      improvementAreas: [{ theme: "Cross-border planning", count: simple("residence") }]
    };
  }
}
