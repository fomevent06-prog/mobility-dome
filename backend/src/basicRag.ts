import { MobilityDataService, RagDocument } from "./data";
import { EyGuideDataService } from "./eyGuideData";
import { LLMProviderConfig, LocalRagEngine, RetrievalSnippet } from "./rag";

export type RagAnswer = {
  answer: string;
  snippets: RetrievalSnippet[];
  country?: string;
  mode: "llm";
  documentsIndexed: number;
};

type EngineState = {
  mode: "llm";
  reason?: string;
};

function toSourceLabel(source: string): string {
  return source || "unknown";
}

function resolveConfigFromEnv(): LLMProviderConfig | null {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const azureApiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openAiEndpoint = process.env.OPENAI_ENDPOINT?.trim() || process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";

  if (azureEndpoint && azureApiKey) {
    return {
      provider: "azure",
      endpoint: azureEndpoint,
      apiKey: azureApiKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-10-21",
      chatDeployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT?.trim() || "gpt-4.1-mini",
      embeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT?.trim() || "text-embedding-3-small",
      chatFallbacks: process.env.AZURE_OPENAI_CHAT_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) || [],
      embeddingFallbacks:
        process.env.AZURE_OPENAI_EMBEDDING_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) || []
    };
  }

  if (openAiApiKey) {
    return {
      provider: "openai",
      endpoint: openAiEndpoint,
      apiKey: openAiApiKey,
      chatDeployment: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-4.1-mini",
      embeddingDeployment: process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
      chatFallbacks: process.env.OPENAI_CHAT_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) || [],
      embeddingFallbacks:
        process.env.OPENAI_EMBEDDING_FALLBACKS?.split(",").map((s) => s.trim()).filter(Boolean) || []
    };
  }

  return null;
}

function dedupeDocs(docs: RagDocument[]): RagDocument[] {
  const seen = new Set<string>();
  const unique: RagDocument[] = [];
  for (const doc of docs) {
    const key = `${doc.source}|${doc.country ?? ""}|${doc.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      id: `${doc.source}-${unique.length}`,
      source: toSourceLabel(doc.source),
      country: doc.country,
      text: doc.text
    });
  }
  return unique;
}

export class BasicRagService {
  private readonly localEngine: LocalRagEngine;
  private readonly state: EngineState = { mode: "llm" };
  private docs: RagDocument[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly surveyService: MobilityDataService,
    private readonly eyService: EyGuideDataService
  ) {
    const config = resolveConfigFromEnv();
    if (!config) {
      throw new Error(
        "LLM configuration missing. Set OPENAI_API_KEY (or AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY)."
      );
    }
    this.localEngine = new LocalRagEngine(this.dataDir, config);
  }

  async load(): Promise<void> {
    this.docs = dedupeDocs([
      ...this.surveyService.ragDocuments(),
      ...this.eyService.ragDocuments()
    ]);

    if (!this.docs.length) {
      throw new Error("No documents available for RAG indexing.");
    }

    await this.localEngine.initialize(this.docs);
    this.state.reason = undefined;
  }

  status(): { mode: "llm"; reason?: string; documentsIndexed: number } {
    return { mode: this.state.mode, reason: this.state.reason, documentsIndexed: this.docs.length };
  }

  async ask(question: string, country?: string): Promise<RagAnswer> {
    const snippets = await this.retrieve(question, country, 8);
    if (!snippets.length) {
      return {
        answer: "I could not find relevant context in the indexed mobility data.",
        snippets: [],
        country,
        mode: this.state.mode,
        documentsIndexed: this.docs.length
      };
    }

    const answer = await this.localEngine.generateFromContext(question, snippets, country);
    return { answer, snippets, country, mode: "llm", documentsIndexed: this.docs.length };
  }

  private async retrieve(question: string, country?: string, limit = 8): Promise<RetrievalSnippet[]> {
    return this.localEngine.retrieve(question, { country, limit });
  }
}
