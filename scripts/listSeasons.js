import mongoose from "mongoose";
import PoolLeagueSeason from "../models/poolLeagueSeason.js";
import PoolLeagueTeam from "../models/poolLeagueTeam.js";
import PoolLeagueMatch from "../models/poolLeagueMatch.js";
import dotenv from "dotenv";
dotenv.config();

const { MONGO_HOSTNAME, MONGO_INITDB_ROOT_USERNAME, MONGO_INITDB_ROOT_PASSWORD, MONGO_INITDB_DATABASE } = process.env;

const url = new URL(`mongodb://${MONGO_HOSTNAME}:27017/${MONGO_INITDB_DATABASE}`);
url.username = MONGO_INITDB_ROOT_USERNAME;
url.password = MONGO_INITDB_ROOT_PASSWORD;
url.search = new URLSearchParams({ retryWrites: "true", w: "majority", authSource: "admin" }).toString();

mongoose.connect(url.toString(), { useNewUrlParser: true, useUnifiedTopology: true });

const run = async () => {
  const seasons = await PoolLeagueSeason.find({}).sort({ createdAt: 1 });
  console.log(`\nFound ${seasons.length} season(s):\n`);

  for (const season of seasons) {
    const teamCount = await PoolLeagueTeam.countDocuments({ seasonId: season._id });
    const matchCount = await PoolLeagueMatch.countDocuments({ seasonId: season._id });
    const completedCount = await PoolLeagueMatch.countDocuments({ seasonId: season._id, status: "COMPLETE" });

    console.log(`  ID:       ${season._id}`);
    console.log(`  Label:    ${season.seasonName || `${season.semester} ${season.year}`}`);
    console.log(`  Semester: ${season.semester} | Year: ${season.year}`);
    console.log(`  Status:   ${season.status}`);
    console.log(`  Teams:    ${teamCount}`);
    console.log(`  Matches:  ${matchCount} total, ${completedCount} completed`);
    console.log(`  Created:  ${season.createdAt}`);
    console.log();
  }

  mongoose.disconnect();
};

run().catch(err => { console.error(err); mongoose.disconnect(); });
