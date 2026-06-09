"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const data_1 = require("./data");
const eyGuideData_1 = require("./eyGuideData");
const rag_1 = require("./rag");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
dotenv_1.default.config({ path: path_1.default.join(process.cwd(), ".env") });
const dataDir = (0, data_1.defaultDataDir)();
const source = "excel_survey_plus_ey_guide";
const surveyService = new data_1.MobilityDataService(dataDir);
const eyService = new eyGuideData_1.EyGuideDataService(dataDir);
const provider = process.env.OPENAI_API_KEY ? "openai" : "azure";
const rag = new rag_1.LocalRagEngine((0, data_1.defaultDataDir)(), {
    provider,
    endpoint: provider === "openai" ? process.env.OPENAI_BASE_URL ?? "https://api.openai.com" : process.env.AZURE_OPENAI_ENDPOINT ?? "",
    apiKey: provider === "openai" ? process.env.OPENAI_API_KEY ?? "" : process.env.AZURE_OPENAI_API_KEY ?? "",
    apiVersion: process.env.OPENAI_API_VERSION ?? "2024-08-01-preview",
    chatDeployment: process.env.OPENAI_CHAT_MODEL ?? process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "gpt-5.4-mini",
    embeddingDeployment: process.env.OPENAI_EMBEDDING_MODEL ?? process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? "text-embedding-3-small",
    chatFallbacks: [process.env.OPENAI_COMPAT_MODEL ?? "", "gpt-4.1-mini", "gpt-4o-mini"],
    embeddingFallbacks: ["text-embedding-3-large"]
});
function rateAnswer(reply) {
    const text = reply.toLowerCase();
    const positiveWords = ["improve", "strong", "working", "compliant", "clear", "good", "recommended"];
    const negativeWords = ["risk", "not", "issue", "delay", "complex", "penalty", "gap", "uncertain"];
    const positive = positiveWords.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    const negative = negativeWords.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    return positive >= negative ? "positive" : "negative";
}
async function compareReply(countryA, countryB) {
    const queryA = `${countryA} mobility employee experience tax immigration compliance risks`;
    const queryB = `${countryB} mobility employee experience tax immigration compliance risks`;
    const rawA = await rag.retrieve(queryA, { country: countryA, limit: 6 });
    const rawB = await rag.retrieve(queryB, { country: countryB, limit: 6 });
    const prompt = [
        `Compare ${countryA} vs ${countryB} for mobility employee experience.`,
        "Use the extracted raw snippets for each country.",
        "Return nuanced strengths, risks/trade-offs, and a practical recommendation.",
        "Do not use deterministic scoring language."
    ].join(" ");
    const reply = await rag.generateFromContext(prompt, [...rawA, ...rawB]);
    return { reply, rating: rateAnswer(reply) };
}
function mentionedCountries(message) {
    const text = message.toLowerCase();
    const names = [...new Set([...surveyService.countries().map((c) => c.country), ...eyService.countries().map((c) => c.country)])]
        .sort((a, b) => b.length - a.length);
    const found = [];
    for (const name of names) {
        if (text.includes(name.toLowerCase()))
            found.push(name);
        if (found.length >= 2)
            break;
    }
    return found;
}
async function bestVsWorstReply() {
    const prompt = [
        "Which country appears to have the best experience versus worst experience based on the indexed survey and EY guide data?",
        "Give a cautious, qualitative answer with uncertainty, include why, and avoid rigid numeric scoring."
    ].join(" ");
    const reply = await rag.answer(prompt);
    return { reply, rating: rateAnswer(reply) };
}
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", ragReady: rag.isReady() });
});
app.get("/api/countries", (_req, res) => {
    res.json({ countries: surveyService.countries() });
});
app.get("/api/insights", (req, res) => {
    const country = typeof req.query.country === "string" && req.query.country.trim() ? req.query.country : undefined;
    res.json(surveyService.insights(country));
});
app.get("/api/compare", async (req, res) => {
    const countryA = typeof req.query.countryA === "string" ? req.query.countryA.trim() : "";
    const countryB = typeof req.query.countryB === "string" ? req.query.countryB.trim() : "";
    if (!countryA || !countryB) {
        return res.status(400).json({ error: "countryA and countryB are required" });
    }
    try {
        const queryA = `${countryA} mobility employee experience tax immigration compliance risks`;
        const queryB = `${countryB} mobility employee experience tax immigration compliance risks`;
        const rawA = await rag.retrieve(queryA, { country: countryA, limit: 6 });
        const rawB = await rag.retrieve(queryB, { country: countryB, limit: 6 });
        const prompt = [
            `Compare ${countryA} vs ${countryB} for mobility employee experience.`,
            "Use the extracted raw snippets for each country.",
            "Return nuanced strengths, risks/trade-offs, and a practical recommendation.",
            "Do not use deterministic scoring language."
        ].join(" ");
        const reply = await rag.generateFromContext(prompt, [...rawA, ...rawB]);
        const result = { reply, rating: rateAnswer(reply) };
        return res.json({
            countryA: surveyService.insights(countryA),
            countryB: surveyService.insights(countryB),
            rawExtraction: {
                countryA: rawA,
                countryB: rawB
            },
            reply: result.reply,
            rating: result.rating
        });
    }
    catch (error) {
        console.error("Compare failed:", error instanceof Error ? error.message : error);
        return res.status(503).json({
            reply: "Comparison model call failed. Please retry in a moment.",
            rating: "negative"
        });
    }
});
app.post("/api/chat", async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    const messageLower = message.toLowerCase();
    const selectedCountry = String(req.body?.country ?? "").trim();
    const detectedCountry = selectedCountry || surveyService.detectCountry(message) || eyService.detectCountry(message);
    const country = selectedCountry || detectedCountry || undefined;
    if (!message) {
        return res.json({
            reply: "Ask a mobility question and I will answer using the locally indexed EY tax and immigration guide.",
            rating: "positive"
        });
    }
    if ((messageLower.includes("best") && messageLower.includes("worst")) ||
        (messageLower.includes("best experience") && messageLower.includes("experience"))) {
        try {
            const result = await bestVsWorstReply();
            return res.json(result);
        }
        catch (error) {
            console.error("Best-vs-worst failed:", error instanceof Error ? error.message : error);
            return res.json({
                reply: "I could not generate a robust best-vs-worst comparison right now. Please retry.",
                rating: "negative"
            });
        }
    }
    if (messageLower.includes("compare") || messageLower.includes(" vs ")) {
        const countries = mentionedCountries(message);
        if (countries.length >= 2) {
            try {
                const result = await compareReply(countries[0], countries[1]);
                return res.json(result);
            }
            catch (error) {
                console.error("Chat compare failed:", error instanceof Error ? error.message : error);
                return res.json({
                    reply: "I could not run the comparison model call right now. Please retry.",
                    rating: "negative"
                });
            }
        }
        return res.json({
            reply: "Please mention two countries to compare, for example: Compare Germany vs France.",
            rating: "negative"
        });
    }
    try {
        const reply = await rag.answer(message, country);
        return res.json({ reply, rating: rateAnswer(reply) });
    }
    catch (error) {
        console.error("RAG chat failed:", error instanceof Error ? error.message : error);
        if (messageLower.includes("working") || messageLower.includes("pain")) {
            const insights = surveyService.insights(country);
            const reply = `I could not reach the model, so here is deterministic fallback for ${insights.scope}: confidence ${insights.confidence}, assignees ${insights.assigneeCount}.`;
            return res.json({
                reply,
                rating: rateAnswer(reply)
            });
        }
        const reply = "Model/index is unavailable right now. Please check Azure OpenAI credentials and deployment names.";
        return res.json({
            reply,
            rating: rateAnswer(reply)
        });
    }
});
async function bootstrap() {
    await surveyService.load();
    await eyService.load();
    await rag.initialize([...surveyService.ragDocuments(), ...eyService.ragDocuments()]);
    const port = Number(process.env.PORT ?? 4000);
    app.listen(port, () => {
        console.log(`Mobility demo backend running on http://localhost:${port} (source=${source}, provider=${provider})`);
    });
}
bootstrap().catch((err) => {
    console.error("Backend failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
});
