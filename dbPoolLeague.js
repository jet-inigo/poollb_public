import fs from "fs";
import path from "path";
import Player from "./models/players.js";
import PoolLeagueSeason from "./models/poolLeagueSeason.js";
import PoolLeagueTeam from "./models/poolLeagueTeam.js";

async function readTeamsFromFile() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(import.meta.dirname, "teams.csv");

    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }

    fs.readFile(filePath, "utf8", (error, data) => {
      if (error) {
        console.error("Error reading teams CSV file:", error);
        reject(error);
        return;
      }

      const rows = data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("Format:"));

      const parsed = rows
        .map((row) => row.split(",").map((value) => value.trim()))
        .filter((parts) => parts.length === 2)
        .map((parts) => {
          const [playerAName, playerBName] = parts;
          return {
            teamName: `${playerAName} | ${playerBName}`,
            playerAName,
            playerBName,
          };
        });

      resolve(parsed);
    });
  });
}

async function readSeasonsFromFile() {
  return new Promise((resolve, reject) => {
    const filePath = path.join(import.meta.dirname, "seasons.csv");

    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }

    fs.readFile(filePath, "utf8", (error, data) => {
      if (error) {
        console.error("Error reading seasons CSV file:", error);
        reject(error);
        return;
      }

      const rows = data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("year,"));

      const parsed = rows
        .map((row) => row.split(",").map((value) => value.trim()))
        .filter((parts) => parts.length >= 6)
        .map((parts) => {
          const [year, semester, startDate, regularWeeks, daysBetweenWeeks, seasonName, breakAfterWeek, breakWeeks] = parts;
          return {
            year: parseInt(year, 10),
            semester,
            startDate: new Date(startDate),
            regularWeeks: parseInt(regularWeeks, 10),
            daysBetweenWeeks: parseInt(daysBetweenWeeks, 10),
            seasonName,
            breakAfterWeek: breakAfterWeek ? parseInt(breakAfterWeek, 10) : null,
            breakWeeks: breakWeeks ? parseInt(breakWeeks, 10) : 1,
          };
        });

      resolve(parsed);
    });
  });
}

const seedSeasons = async () => {
  const rawSeasons = await readSeasonsFromFile();

  if (rawSeasons.length === 0) {
    console.log("No seasons.csv entries found; skipped season seeding.");
    return;
  }

  for (const seasonData of rawSeasons) {
    const existing = await PoolLeagueSeason.findOne({
      year: seasonData.year,
      semester: seasonData.semester,
    });

    if (!existing) {
      await PoolLeagueSeason.create({
        year: seasonData.year,
        semester: seasonData.semester,
        startDate: seasonData.startDate,
        regularWeeks: seasonData.regularWeeks,
        daysBetweenWeeks: seasonData.daysBetweenWeeks,
        seasonName: seasonData.seasonName,
        breakAfterWeek: seasonData.breakAfterWeek,
        breakWeeks: seasonData.breakWeeks,
        regularRounds: seasonData.regularWeeks * 2,
        status: "SIGNUP",
      });
      console.log(`Season '${seasonData.seasonName}' created`);
    } else {
      // Update break fields on existing seasons so CSV changes take effect on restart
      await PoolLeagueSeason.findByIdAndUpdate(existing._id, {
        breakAfterWeek: seasonData.breakAfterWeek,
        breakWeeks: seasonData.breakWeeks,
      });
    }
  }
};

const seedPoolLeagueTeams = async () => {
  const rawTeams = await readTeamsFromFile();

  if (rawTeams.length === 0) {
    console.log("No teams.csv entries found; skipped Pool League team seeding.");
    return;
  }

  const season = await PoolLeagueSeason.findOne({ status: "SIGNUP" }).sort({ createdAt: -1 });

  if (!season) {
    console.log("No signup season found; skipped Pool League team seeding.");
    return;
  }

  if (season.status !== "SIGNUP") {
    console.log("Pool League season is not in signup state; skipped team seeding.");
    return;
  }

  const existingTeamsCount = await PoolLeagueTeam.countDocuments({ seasonId: season._id });
  if (existingTeamsCount > 0) {
    console.log("Pool League teams already exist for current season; skipped team seeding.");
    return;
  }

  const players = await Player.find();
  const playerIdByName = new Map(players.map((player) => [player.name, player._id]));
  const usedPlayers = new Set();
  const teamDocs = [];

  for (const team of rawTeams) {
    // Auto-create players from teams.csv if they don't exist in the DB
    if (!playerIdByName.has(team.playerAName)) {
      const created = await Player.create({ name: team.playerAName, rating: 1000 });
      playerIdByName.set(team.playerAName, created._id);
      console.log(`Auto-created player '${team.playerAName}' from teams.csv`);
    }
    if (!playerIdByName.has(team.playerBName)) {
      const created = await Player.create({ name: team.playerBName, rating: 1000 });
      playerIdByName.set(team.playerBName, created._id);
      console.log(`Auto-created player '${team.playerBName}' from teams.csv`);
    }

    const playerAId = playerIdByName.get(team.playerAName);
    const playerBId = playerIdByName.get(team.playerBName);
    const playerAKey = String(playerAId);
    const playerBKey = String(playerBId);

    if (playerAKey === playerBKey) {
      console.log(`Skipping team '${team.teamName}' due to duplicate player.`);
      continue;
    }

    if (usedPlayers.has(playerAKey) || usedPlayers.has(playerBKey)) {
      console.log(`Skipping team '${team.teamName}' because a player is already assigned.`);
      continue;
    }

    usedPlayers.add(playerAKey);
    usedPlayers.add(playerBKey);

    teamDocs.push({
      seasonId: season._id,
      name: team.teamName,
      playerIds: [playerAId, playerBId],
      playerNames: [team.playerAName, team.playerBName],
    });
  }

  if (teamDocs.length === 0) {
    console.log("No valid teams found in teams.csv; skipped team insertion.");
    return;
  }

  await PoolLeagueTeam.insertMany(teamDocs, { ordered: false });
  console.log(`Pool League teams added from teams.csv: ${teamDocs.length}`);
};

const seedPoolLeagueData = async () => {
  await seedSeasons();
  await seedPoolLeagueTeams();
};

export default seedPoolLeagueData;
