import { seedPlayoffs } from "../services/poolLeagueService.js";
import {
  connectMongo,
  disconnectMongo,
  getSeasonLabel,
  resolveSeason,
} from "./poolLeagueAdminUtils.js";

const seasonArg = process.argv.slice(2).join(" ").trim();

const run = async () => {
  await connectMongo();

  try {
    const season = await resolveSeason(seasonArg);
    if (!season) {
      throw new Error("Season not found. Pass season ID, season name, or e.g. 'Spring 2026'.");
    }

    const result = await seedPlayoffs(season._id);
    console.log(`Season: ${getSeasonLabel(season)} (${season._id})`);
    console.log(result.message);
  } finally {
    await disconnectMongo();
  }
};

run().catch((error) => {
  console.error("Force start playoffs failed:", error.message || error);
  process.exit(1);
});