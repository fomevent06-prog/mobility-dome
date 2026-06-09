"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalRagEngine = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function normalizeEndpoint(endpoint) {
    return endpoint.replace(/\/+$/, "");
}
function cosineSimilarity(a, b) {
    let dot = 0;
    let aNorm = 0;
    let bNorm = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
        dot += a[i] * b[i];
        aNorm += a[i] * a[i];
        bNorm += b[i] * b[i];
    }
    if (!aNorm || !bNorm)
        return 0;
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
function hashDocuments(docs) {
    const payload = docs.map((d) => ({ id: d.id, text: d.text, source: d.source, country: d.country ?? "" }));
    return crypto_1.default.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
class LocalRagEngine {
    constructor(dataDir, config) {
        this.dataDir = dataDir;
        this.config = config;
        this.docs = [];
        this.vectors = [];
        this.ready = false;
        this.indexPath = path_1.default.join(this.dataDir, "_local_rag_index.json");
    }
    async initialize(docs) {
        if (!this.config.endpoint || !this.config.apiKey) {
            throw new Error("Model credentials are missing. Set OPENAI_API_KEY (or Azure OpenAI credentials).");
        }
        this.docs = docs;
        const contentHash = hashDocuments(docs);
        const cached = this.tryReadIndex();
        if (cached && cached.contentHash === contentHash && cached.embeddingDeployment === this.config.embeddingDeployment) {
            this.vectors = cached.vectors;
            this.ready = true;
            return;
        }
        const vectors = [];
        const batchSize = 16;
        for (let i = 0; i < docs.length; i += batchSize) {
            const batch = docs.slice(i, i + batchSize).map((d) => d.text);
            const embedded = await this.embed(batch);
            vectors.push(...embedded);
        }
        this.vectors = vectors;
        this.ready = true;
        const toWrite = {
            contentHash,
            embeddingDeployment: this.config.embeddingDeployment,
            docs: this.docs,
            vectors: this.vectors
        };
        fs_1.default.writeFileSync(this.indexPath, JSON.stringify(toWrite));
    }
    isReady() {
        return this.ready;
    }
    async answer(question, country) {
        if (!this.ready) {
            throw new Error("RAG index is not initialized.");
        }
        const snippets = await this.retrieve(question, { country, limit: 8 });
        return this.generateFromContext(question, snippets, country);
    }
    async retrieve(question, options) {
        if (!this.ready) {
            throw new Error("RAG index is not initialized.");
        }
        const limit = options?.limit ?? 8;
        const country = options?.country;
        const queryVector = (await this.embed([question]))[0];
        return this.docs
            .map((doc, i) => ({ doc, score: cosineSimilarity(queryVector, this.vectors[i]) }))
            .filter((x) => !country || !x.doc.country || x.doc.country.toLowerCase() === country.toLowerCase())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map((x) => ({
            id: x.doc.id,
            source: x.doc.source,
            country: x.doc.country,
            score: x.score,
            text: x.doc.text.slice(0, 1200)
        }));
    }
    async generateFromContext(question, snippets, country) {
        if (!this.ready) {
            throw new Error("RAG index is not initialized.");
        }
        if (!snippets.length) {
            return "I could not find enough indexed context to answer reliably.";
        }
        const context = snippets
            .map((s, idx) => `[${idx + 1}] source=${s.source}${s.country ? `; country=${s.country}` : ""}; score=${s.score.toFixed(4)}\n${s.text}`)
            .join("\n\n");
        return this.chat(question, context, country);
    }
    tryReadIndex() {
        if (!fs_1.default.existsSync(this.indexPath))
            return null;
        try {
            const raw = fs_1.default.readFileSync(this.indexPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.vectors) || !Array.isArray(parsed.docs))
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    async embed(inputs) {
        const candidates = this.uniqueModels(this.config.embeddingDeployment, this.config.embeddingFallbacks ?? []);
        const openaiModelUrl = this.config.provider === "openai"
            ? `${normalizeEndpoint(this.config.endpoint)}/v1/embeddings`
            : `${normalizeEndpoint(this.config.endpoint)}/openai/v1/embeddings`;
        const failures = [];
        for (const candidate of candidates) {
            if (this.config.provider === "openai") {
                const model = await this.postJson(openaiModelUrl, { model: candidate, input: inputs });
                if (model.ok) {
                    const json = (await model.response.json());
                    return json.data.map((d) => d.embedding);
                }
                failures.push(`${candidate}: model=${model.status} ${model.body}`);
                continue;
            }
            const deploymentUrl = `${normalizeEndpoint(this.config.endpoint)}/openai/deployments/${candidate}/embeddings?api-version=${encodeURIComponent(this.config.apiVersion ?? "")}`;
            const deployment = await this.postJson(deploymentUrl, { input: inputs });
            if (deployment.ok) {
                const json = (await deployment.response.json());
                return json.data.map((d) => d.embedding);
            }
            const model = await this.postJson(openaiModelUrl, { model: candidate, input: inputs });
            if (model.ok) {
                const json = (await model.response.json());
                return json.data.map((d) => d.embedding);
            }
            failures.push(`${candidate}: deployment=${deployment.status} ${deployment.body}; model=${model.status} ${model.body}`);
        }
        throw new Error(`Embedding request failed. ${failures.join(" | ")}`);
    }
    async chat(question, context, country) {
        const candidates = this.uniqueModels(this.config.chatDeployment, this.config.chatFallbacks ?? []);
        const openaiModelUrl = this.config.provider === "openai"
            ? `${normalizeEndpoint(this.config.endpoint)}/v1/chat/completions`
            : `${normalizeEndpoint(this.config.endpoint)}/openai/v1/chat/completions`;
        const system = [
            "You are a mobility workshop assistant.",
            "Answer only using the provided context and state uncertainty if context is weak.",
            "Keep responses concise and practical for non-technical business users.",
            "Include a short compliance note that this is not legal/tax advice.",
            country ? `Prioritize ${country} specific evidence when available.` : "Use global evidence when country is not specified."
        ].join(" ");
        const messages = [
            { role: "system", content: system },
            { role: "user", content: `Question: ${question}\n\nContext:\n${context}` }
        ];
        const failures = [];
        for (const candidate of candidates) {
            if (this.config.provider === "openai") {
                const model = await this.postJson(openaiModelUrl, { model: candidate, messages, temperature: 0.2 });
                if (model.ok) {
                    const json = (await model.response.json());
                    const content = json.choices?.[0]?.message?.content;
                    if (typeof content === "string")
                        return content.trim();
                    if (Array.isArray(content))
                        return content.map((c) => c.text ?? "").join("").trim();
                }
                failures.push(`${candidate}: model=${model.status} ${model.body}`);
                continue;
            }
            const deploymentUrl = `${normalizeEndpoint(this.config.endpoint)}/openai/deployments/${candidate}/chat/completions?api-version=${encodeURIComponent(this.config.apiVersion ?? "")}`;
            const deployment = await this.postJson(deploymentUrl, { messages, temperature: 0.2 });
            if (deployment.ok) {
                const json = (await deployment.response.json());
                return json.choices?.[0]?.message?.content?.trim() || "I could not generate a grounded response from the index.";
            }
            const model = await this.postJson(openaiModelUrl, { model: candidate, messages, temperature: 0.2 });
            if (model.ok) {
                const json = (await model.response.json());
                const content = json.choices?.[0]?.message?.content;
                if (typeof content === "string")
                    return content.trim();
                if (Array.isArray(content))
                    return content.map((c) => c.text ?? "").join("").trim();
            }
            failures.push(`${candidate}: deployment=${deployment.status} ${deployment.body}; model=${model.status} ${model.body}`);
        }
        throw new Error(`Chat request failed. ${failures.join(" | ")}`);
    }
    async postJson(url, payload) {
        const headers = { "Content-Type": "application/json" };
        if (this.config.provider === "openai") {
            headers.Authorization = `Bearer ${this.config.apiKey}`;
        }
        else {
            headers["api-key"] = this.config.apiKey;
            headers.Authorization = `Bearer ${this.config.apiKey}`;
        }
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            return { ok: true, status: response.status, body: "", response };
        }
        return { ok: false, status: response.status, body: await response.text(), response };
    }
    uniqueModels(primary, extras) {
        const all = [primary, ...extras].map((x) => x.trim()).filter(Boolean);
        return [...new Set(all)];
    }
}
exports.LocalRagEngine = LocalRagEngine;
