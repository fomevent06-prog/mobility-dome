import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "path";
import { BasicRagService } from "./basicRag";
import { defaultDataDir, MobilityDataService } from "./data";
import { EyGuideDataService } from "./eyGuideData";

const app = express();
app.use(cors());
app.use(express.json());

dotenv.config({ path: path.join(process.cwd(), ".env") });

const dataDir = defaultDataDir();
const surveyService = new MobilityDataService(dataDir);
const eyService = new EyGuideDataService(dataDir);
const ragService = new BasicRagService(dataDir, surveyService, eyService);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/countries", (_req, res) => {
  res.json({ countries: surveyService.countries() });
});

app.get("/api/insights", (req, res) => {
  const country = typeof req.query.country === "string" && req.query.country.trim() ? req.query.country : undefined;
  res.json(surveyService.insights(country));
});

app.get("/api/rag/status", (_req, res) => {
  res.json(ragService.status());
});

app.post("/api/rag/ask", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    res.status(400).json({ error: "Question is required." });
    return;
  }
  const requestedCountry = typeof req.body?.country === "string" ? req.body.country.trim() : undefined;
  const detectedCountry = requestedCountry || surveyService.detectCountry(question) || eyService.detectCountry(question);
  try {
    const result = await ragService.ask(question, detectedCountry);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to answer question.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

async function bootstrap(): Promise<void> {
  await surveyService.load();
  await eyService.load();
  await ragService.load();

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`Mobility demo backend running on http://localhost:${port}`);
  });
}

bootstrap().catch((err) => {
  console.error("Backend failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
