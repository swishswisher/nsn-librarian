import { publishScanDerivedKnowledge } from "../../../src/lib/bridge/scan-publication";
import { generateScanRecommendationBatch } from "../../../src/lib/bridge/scan-recommendation-batch";
import { getPrismaClient } from "../../../src/lib/db/prisma";

async function main() {
  delete process.env.OPENAI_API_KEY;
  const [sessionId, mode] = process.argv.slice(2);
  if (mode === "batch") await generateScanRecommendationBatch(sessionId);
  else await publishScanDerivedKnowledge(sessionId);
  await getPrismaClient().$disconnect();
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
