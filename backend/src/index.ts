import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "path";
import { defaultDataDir, MobilityDataService } from "./data";
import { EyGuideDataService } from "./eyGuideData";

const app = express();
app.use(cors());
app.use(express.json());

dotenv.config({ path: path.join(process.cwd(), ".env") });

const dataDir = defaultDataDir();
const surveyService = new MobilityDataService(dataDir);
const eyService = new EyGuideDataService(dataDir);

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

async function bootstrap(): Promise<void> {
  await surveyService.load();
  await eyService.load();

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`Mobility demo backend running on http://localhost:${port}`);
  });
}

bootstrap().catch((err) => {
  console.error("Backend failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
