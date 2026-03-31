import fs from "fs";
import path from "path";
import PoolLeagueMatch from "../models/poolLeagueMatch.js";
import PoolLeagueSeason from "../models/poolLeagueSeason.js";
import PoolLeagueTeam from "../models/poolLeagueTeam.js";
import { generateRegularSchedule } from "../services/poolLeagueService.js";
import {
  connectMongo,
  disconnectMongo,
  getSeasonLabel,
  resolveSeason,
} from "./poolLeagueAdminUtils.js";

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    season: "",
    csv: "",
    fillRemainingRandom: false,
    replaceExisting: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--season") {
      options.season = args[i + 1] || "";
      i += 1;
    } else if (arg === "--csv") {
      options.csv = args[i + 1] || "";
      i += 1;
    } else if (arg === "--fill-remaining-random") {
      options.fillRemainingRandom = true;
    } else if (arg === "--replace-existing") {
      options.replaceExisting = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const printUsage = () => {
  console.log("Usage:");
  console.log("  node scripts/manageSeasonSchedule.js [--season \"Spring 2026\"|<seasonId>|<seasonName>] [--replace-existing]");
  console.log("  node scripts/manageSeasonSchedule.js --csv ./path/to/schedule.csv [--season ...] [--replace-existing]");
  console.log("  node scripts/manageSeasonSchedule.js --csv ./path/to/schedule.csv --fill-remaining-random [--season ...] [--replace-existing]");
  console.log("");
  console.log("CSV columns (header required): week,teamA,teamB,status,winner,completedAt");
  console.log("- status: TBD | COMPLETE");
  console.log("- week is required for every row.");
  console.log("- If a row is COMPLETE and completedAt is blank, completedAt is set to end of that week.");
};

const parseCsvLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const parseCsvFile = (filePath) => {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const header = parseCsvLine(lines[0]).map((column) => column.toLowerCase());
  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const row = {};

    header.forEach((column, columnIndex) => {
      row[column] = (values[columnIndex] || "").trim();
    });

    row.__line = index + 2;
    return row;
  });

  return rows;
};

const normalizeStatus = (statusValue) => {
  const status = (statusValue || "").trim().toUpperCase();
  if (!status) return "TBD";
  if (["TBD", "COMPLETE"].includes(status)) return status;
  throw new Error(`Invalid status '${statusValue}'. Use TBD or COMPLETE.`);
};

const parseDate = (value, label) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
};

const getWeekEndDate = (season, week) => {
  if (!season.startDate) {
    const fallback = new Date();
    fallback.setHours(23, 59, 59, 999);
    return fallback;
  }

  const startDate = new Date(season.startDate);
  const daysBetweenWeeks = Math.max(1, season.daysBetweenWeeks || 7);
  const breakAfterWeek = season.breakAfterWeek || null;
  const breakWeeks = season.breakWeeks || 1;

  let offsetDays = (Math.max(week, 1) - 1) * daysBetweenWeeks;
  if (breakAfterWeek && week > breakAfterWeek) {
    offsetDays += breakWeeks * daysBetweenWeeks;
  }

  const weekStart = new Date(startDate);
  weekStart.setDate(weekStart.getDate() + offsetDays);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + daysBetweenWeeks - 1);
  weekEnd.setHours(23, 59, 59, 999);

  return weekEnd;
};

const getPairKey = (teamAId, teamBId) => {
  const ids = [String(teamAId), String(teamBId)].sort();
  return `${ids[0]}|${ids[1]}`;
};

const shuffle = (array) => {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const buildCsvMatches = ({ rows, season, teamsByName, usedPairings }) => {
  const docs = [];
  const maxRegularWeeks = season.regularWeeks || 4;

  for (const row of rows) {
    const weekRaw = (row.week || row.weeknumber || "").trim();
    if (!weekRaw) {
      throw new Error(`CSV line ${row.__line}: week is required.`);
    }

    const week = parseInt(weekRaw, 10);
    if (!Number.isInteger(week) || week < 1) {
      throw new Error(`CSV line ${row.__line}: invalid week '${weekRaw}'.`);
    }

    if (week > maxRegularWeeks) {
      throw new Error(`CSV line ${row.__line}: week ${week} is greater than season regularWeeks (${maxRegularWeeks}).`);
    }

    const teamANameRaw = row.teama || row.teamaname || row.team_a;
    const teamBNameRaw = row.teamb || row.teambname || row.team_b;
    if (!teamANameRaw || !teamBNameRaw) {
      throw new Error(`CSV line ${row.__line}: teamA and teamB are required.`);
    }

    const teamA = teamsByName.get(teamANameRaw.trim().toLowerCase());
    const teamB = teamsByName.get(teamBNameRaw.trim().toLowerCase());

    if (!teamA || !teamB) {
      throw new Error(`CSV line ${row.__line}: one or both teams were not found in this season.`);
    }

    if (String(teamA._id) === String(teamB._id)) {
      throw new Error(`CSV line ${row.__line}: teamA and teamB cannot be the same team.`);
    }

    const pairKey = getPairKey(teamA._id, teamB._id);
    if (usedPairings.has(pairKey)) {
      throw new Error(`CSV line ${row.__line}: duplicate matchup '${teamA.name} vs ${teamB.name}' detected.`);
    }
    usedPairings.add(pairKey);

    const status = normalizeStatus(row.status);
    const winnerRaw = (row.winner || row.winnerteam || "").trim();
    const hasWinner = winnerRaw.length > 0;

    let finalStatus = status;
    if (hasWinner) {
      finalStatus = "COMPLETE";
    }

    let completedAt = parseDate(row.completedat || row.completed_at, `completedAt on line ${row.__line}`);

    const doc = {
      seasonId: season._id,
      phase: "REGULAR",
      week,
      teamAId: teamA._id,
      teamBId: teamB._id,
      teamAName: teamA.name,
      teamBName: teamB.name,
      status: finalStatus,
    };

    if (finalStatus === "COMPLETE") {
      const normalizedWinner = winnerRaw.toLowerCase();
      let winnerTeamId = null;
      let loserTeamId = null;
      let teamAScore = 0;
      let teamBScore = 0;

      if (normalizedWinner === teamA.name.toLowerCase()) {
        winnerTeamId = teamA._id;
        loserTeamId = teamB._id;
        teamAScore = 1;
      } else if (normalizedWinner === teamB.name.toLowerCase()) {
        winnerTeamId = teamB._id;
        loserTeamId = teamA._id;
        teamBScore = 1;
      } else {
        throw new Error(`CSV line ${row.__line}: winner must match teamA or teamB exactly.`);
      }

      if (!completedAt) {
        completedAt = getWeekEndDate(season, week);
      }

      doc.winnerTeamId = winnerTeamId;
      doc.loserTeamId = loserTeamId;
      doc.teamAScore = teamAScore;
      doc.teamBScore = teamBScore;
      doc.completedAt = completedAt;
    } else {
      if (completedAt) {
        throw new Error(`CSV line ${row.__line}: only COMPLETE matches can include completedAt.`);
      }
      if (winnerRaw) {
        throw new Error(`CSV line ${row.__line}: winner can only be set when status is COMPLETE.`);
      }
    }

    docs.push(doc);
  }

  return docs;
};

const buildRemainingRandomMatches = ({
  season,
  teams,
  usedPairings,
  existingDocs,
}) => {
  const weeks = season.regularWeeks || 4;
  const matchesPerTeamPerWeek = 2;
  const maxAttemptsPerWeek = 600;
  const teamIds = teams.map((team) => String(team._id));
  const teamById = new Map(teams.map((team) => [String(team._id), team]));
  const weekTeamCounts = new Map();

  const getWeekCount = (week, teamId) => {
    if (!weekTeamCounts.has(week)) return 0;
    return weekTeamCounts.get(week).get(teamId) || 0;
  };

  const incrementWeekCount = (week, teamId) => {
    if (!weekTeamCounts.has(week)) {
      weekTeamCounts.set(week, new Map());
    }
    const weekMap = weekTeamCounts.get(week);
    weekMap.set(teamId, (weekMap.get(teamId) || 0) + 1);
  };

  existingDocs.forEach((match) => {
    const week = match.week || 1;
    incrementWeekCount(week, String(match.teamAId));
    incrementWeekCount(week, String(match.teamBId));
  });

  for (let week = 1; week <= weeks; week += 1) {
    for (const teamId of teamIds) {
      const count = getWeekCount(week, teamId);
      if (count > matchesPerTeamPerWeek) {
        const team = teamById.get(teamId);
        throw new Error(
          `Cannot auto-fill: ${team?.name || teamId} already has ${count} matches in week ${week}. ` +
          `Maximum allowed is ${matchesPerTeamPerWeek}.`,
        );
      }
    }
  }

  const expectedTotalMatches = (teams.length * weeks * matchesPerTeamPerWeek) / 2;
  if (existingDocs.length > expectedTotalMatches) {
    throw new Error(
      `Cannot auto-fill: existing CSV already has ${existingDocs.length} matches, ` +
      `which exceeds expected total ${expectedTotalMatches} for ${matchesPerTeamPerWeek} matches/team/week.`,
    );
  }

  const pickRandom = (array) => array[Math.floor(Math.random() * array.length)];

  const tryBuildWeekPairs = (week, remainingByTeam, allowRepeats) => {
    for (let attempt = 0; attempt < maxAttemptsPerWeek; attempt += 1) {
      const remaining = new Map(remainingByTeam);
      const pairs = [];
      const weekPairKeys = new Set();

      while (true) {
        const active = teamIds.filter((teamId) => (remaining.get(teamId) || 0) > 0);
        if (active.length === 0) {
          return { pairs, usedRepeat: allowRepeats };
        }

        active.sort((teamA, teamB) => (remaining.get(teamB) || 0) - (remaining.get(teamA) || 0));
        const topNeed = remaining.get(active[0]) || 0;
        const topTeams = active.filter((teamId) => (remaining.get(teamId) || 0) === topNeed);
        const teamAId = pickRandom(topTeams);

        const allCandidates = active.filter((teamId) => teamId !== teamAId);
        const noRepeatCandidates = allCandidates.filter((teamBId) => {
          const pairKey = getPairKey(teamAId, teamBId);
          return !usedPairings.has(pairKey) && !weekPairKeys.has(pairKey);
        });

        let candidatePool = noRepeatCandidates;
        if (allowRepeats && candidatePool.length === 0) {
          candidatePool = allCandidates.filter((teamBId) => {
            const pairKey = getPairKey(teamAId, teamBId);
            return !weekPairKeys.has(pairKey);
          });
        }

        if (candidatePool.length === 0) {
          break;
        }

        const maxCandidateNeed = Math.max(
          ...candidatePool.map((teamId) => remaining.get(teamId) || 0),
        );
        const strongestCandidates = candidatePool.filter(
          (teamId) => (remaining.get(teamId) || 0) === maxCandidateNeed,
        );
        const teamBId = pickRandom(strongestCandidates);

        const pairKey = getPairKey(teamAId, teamBId);
        weekPairKeys.add(pairKey);
        pairs.push({
          week,
          teamA: teamById.get(teamAId),
          teamB: teamById.get(teamBId),
          pairKey,
        });

        remaining.set(teamAId, (remaining.get(teamAId) || 0) - 1);
        remaining.set(teamBId, (remaining.get(teamBId) || 0) - 1);
      }
    }

    return null;
  };

  const docs = [];
  let repeatedPairsUsed = 0;

  for (let week = 1; week <= weeks; week += 1) {
    const remainingByTeam = new Map();
    let slotsNeeded = 0;

    for (const teamId of teamIds) {
      const remaining = matchesPerTeamPerWeek - getWeekCount(week, teamId);
      remainingByTeam.set(teamId, remaining);
      slotsNeeded += remaining;
    }

    if (slotsNeeded === 0) {
      continue;
    }

    if (slotsNeeded % 2 !== 0) {
      throw new Error(`Cannot auto-fill week ${week}: odd number of remaining team slots (${slotsNeeded}).`);
    }

    let built = tryBuildWeekPairs(week, remainingByTeam, false);
    if (!built) {
      built = tryBuildWeekPairs(week, remainingByTeam, true);
    }

    if (!built) {
      throw new Error(`Could not generate a valid fill schedule for week ${week} while keeping 2 matches per team.`);
    }

    if (built.usedRepeat) {
      repeatedPairsUsed += 1;
    }

    built.pairs.forEach((pair) => {
      usedPairings.add(pair.pairKey);
      incrementWeekCount(week, String(pair.teamA._id));
      incrementWeekCount(week, String(pair.teamB._id));
      docs.push({
        seasonId: season._id,
        phase: "REGULAR",
        week,
        teamAId: pair.teamA._id,
        teamBId: pair.teamB._id,
        teamAName: pair.teamA.name,
        teamBName: pair.teamB.name,
        status: "TBD",
      });
    });
  }

  for (let week = 1; week <= weeks; week += 1) {
    for (const teamId of teamIds) {
      const finalCount = getWeekCount(week, teamId);
      if (finalCount !== matchesPerTeamPerWeek) {
        const team = teamById.get(teamId);
        throw new Error(
          `Auto-fill failed: ${team?.name || teamId} has ${finalCount} matches in week ${week}; ` +
          `expected ${matchesPerTeamPerWeek}.`,
        );
      }
    }
  }

  if (repeatedPairsUsed > 0) {
    console.log(
      `Warning: used repeated matchup pairs while filling ${repeatedPairsUsed} week(s) to keep 2 matches per team per week.`,
    );
  }

  return docs;
};

const run = async () => {
  const options = parseArgs();
  if (options.help) {
    printUsage();
    return;
  }

  await connectMongo();

  try {
    const season = await resolveSeason(options.season);
    if (!season) {
      throw new Error("Could not find a season. Use --season with season ID, season name, or 'Spring 2026'.");
    }

    if (season.status === "PLAYOFFS" || season.status === "COMPLETE") {
      throw new Error("Cannot manage regular schedule for a season that is already in PLAYOFFS or COMPLETE.");
    }

    const teams = await PoolLeagueTeam.find({ seasonId: season._id }).sort({ name: 1 });
    if (teams.length < 4) {
      throw new Error("At least 4 teams are required before loading or generating a schedule.");
    }

    if (teams.length % 2 !== 0) {
      throw new Error("Team count must be even before schedule generation.");
    }

    const existingRegularCount = await PoolLeagueMatch.countDocuments({
      seasonId: season._id,
      phase: "REGULAR",
    });

    if (existingRegularCount > 0 && !options.replaceExisting) {
      throw new Error(
        `Season already has ${existingRegularCount} regular-season match(es). ` +
        "Use --replace-existing if you want to wipe and reload.",
      );
    }

    if (options.replaceExisting) {
      await PoolLeagueMatch.deleteMany({
        seasonId: season._id,
        phase: { $in: ["REGULAR", "PLAYOFFS"] },
      });

      await PoolLeagueSeason.findByIdAndUpdate(season._id, {
        status: "SIGNUP",
        playoffsGenerated: false,
      });
    }

    const usedPairings = new Set();
    const teamsByName = new Map(teams.map((team) => [team.name.trim().toLowerCase(), team]));
    let scheduleDocs = [];

    if (!options.csv) {
      const result = await generateRegularSchedule(season._id);
      console.log(`Season: ${getSeasonLabel(season)} (${season._id})`);
      console.log(result.message);
      return;
    }

    const csvPath = path.resolve(process.cwd(), options.csv);
    if (!fs.existsSync(csvPath)) {
      throw new Error(`CSV file not found: ${csvPath}`);
    }

    const rows = parseCsvFile(csvPath);
    scheduleDocs = buildCsvMatches({
      rows,
      season,
      teamsByName,
      usedPairings,
    });

    if (!options.csv || options.fillRemainingRandom) {
      const randomDocs = buildRemainingRandomMatches({
        season,
        teams,
        usedPairings,
        existingDocs: scheduleDocs,
      });
      scheduleDocs = [...scheduleDocs, ...randomDocs];
    }

    if (scheduleDocs.length === 0) {
      throw new Error("No matches were generated from the provided options.");
    }

    await PoolLeagueMatch.insertMany(scheduleDocs);

    await PoolLeagueSeason.findByIdAndUpdate(season._id, {
      status: "REGULAR",
      playoffsGenerated: false,
    });

    const completeCount = scheduleDocs.filter((match) => match.status === "COMPLETE").length;
    const tbdCount = scheduleDocs.filter((match) => match.status === "TBD").length;

    console.log(`Season: ${getSeasonLabel(season)} (${season._id})`);
    console.log(`Inserted regular-season matches: ${scheduleDocs.length}`);
    console.log(`- COMPLETE: ${completeCount}`);
    console.log(`- TBD: ${tbdCount}`);
    console.log("Schedule load complete.");
  } finally {
    await disconnectMongo();
  }
};

run().catch((error) => {
  console.error("Schedule management failed:", error.message || error);
  process.exit(1);
});