import PoolLeagueSeason from "../models/poolLeagueSeason.js";
import PoolLeagueTeam from "../models/poolLeagueTeam.js";
import PoolLeagueMatch from "../models/poolLeagueMatch.js";
import Player from "../models/players.js";

const REGULAR_WEEKS = 4;
const REGULAR_ROUNDS = 8;

const toId = (value) => String(value);

const getCurrentSeasonDescriptor = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const semester = month < 6 ? "Spring" : "Fall";
  return { year, semester };
};

const getOrCreateCurrentSeason = async () => {
  let season = await PoolLeagueSeason.findOne({
    status: { $in: ["SIGNUP", "REGULAR", "PLAYOFFS"] },
  }).sort({ createdAt: -1 });

  if (!season) {
    season = await PoolLeagueSeason.findOne({}).sort({ createdAt: -1 });
  }

  if (!season) {
    const descriptor = getCurrentSeasonDescriptor();
    season = await PoolLeagueSeason.create({
      ...descriptor,
      regularWeeks: REGULAR_WEEKS,
      regularRounds: REGULAR_ROUNDS,
      status: "SIGNUP",
    });
  }

  return season;
};

const getSeasonLabel = (season) => {
  if (!season) return "Unknown";
  if (season.seasonName) return season.seasonName;
  return `${season.semester} ${season.year}`;
};

const createTeam = async (seasonId, playerAId, playerBId, requestedName) => {
  const season = await PoolLeagueSeason.findById(seasonId);
  if (!season) {
    throw new Error("Season not found.");
  }

  if (season.status !== "SIGNUP") {
    throw new Error("Team registration is closed for this season.");
  }

  if (!playerAId || !playerBId) {
    throw new Error("Two players are required for a team.");
  }

  if (toId(playerAId) === toId(playerBId)) {
    throw new Error("A team must contain two different players.");
  }

  const players = await Player.find({ _id: { $in: [playerAId, playerBId] } });
  if (players.length !== 2) {
    throw new Error("One or more selected players were not found.");
  }

  const existingPlayerUsage = await PoolLeagueTeam.findOne({
    seasonId,
    playerIds: { $in: [playerAId, playerBId] },
  });

  if (existingPlayerUsage) {
    throw new Error("One of these players is already on a registered team.");
  }

  const playerNames = players.map((player) => player.name).sort();
  const name = (requestedName || "").trim() || `${playerNames[0]} | ${playerNames[1]}`;

  const existingName = await PoolLeagueTeam.findOne({ seasonId, name });
  if (existingName) {
    throw new Error("Team name already exists for this season.");
  }

  return PoolLeagueTeam.create({
    seasonId,
    name,
    playerIds: [playerAId, playerBId],
    playerNames,
  });
};

const buildRoundPairings = (teams, totalRounds) => {
  if (teams.length < 2 || teams.length % 2 !== 0) {
    throw new Error("An even number of teams is required to generate the schedule.");
  }

  const rounds = [];
  const usedPairings = new Set();

  const getPairingKey = (teamAId, teamBId) => {
    const ids = [toId(teamAId), toId(teamBId)].sort();
    return `${ids[0]}|${ids[1]}`;
  };

  for (let round = 1; round <= totalRounds; round += 1) {
    const pairings = [];
    const availableTeams = [...teams];

    while (availableTeams.length >= 2) {
      const randomIndex = Math.floor(Math.random() * availableTeams.length);
      const teamA = availableTeams.splice(randomIndex, 1)[0];

      let teamB = null;
      let attempts = 0;
      const maxAttempts = availableTeams.length;

      while (attempts < maxAttempts && !teamB) {
        const randomIndexB = Math.floor(Math.random() * availableTeams.length);
        const candidate = availableTeams[randomIndexB];
        const pairingKey = getPairingKey(teamA._id, candidate._id);

        if (!usedPairings.has(pairingKey)) {
          teamB = availableTeams.splice(randomIndexB, 1)[0];
          usedPairings.add(pairingKey);
        }
        attempts += 1;
      }

      if (teamB) {
        pairings.push([teamA, teamB]);
      } else if (availableTeams.length > 0) {
        // Fallback: pair remaining team with first available if needed
        const candidate = availableTeams[0];
        const pairingKey = getPairingKey(teamA._id, candidate._id);
        if (!usedPairings.has(pairingKey)) {
          teamB = availableTeams.splice(0, 1)[0];
          usedPairings.add(pairingKey);
          pairings.push([teamA, teamB]);
        }
      }
    }

    rounds.push({ round, pairings });
  }

  return rounds;
};

const generateRegularSchedule = async (seasonId) => {
  const season = await PoolLeagueSeason.findById(seasonId);
  if (!season) {
    throw new Error("Season not found.");
  }

  if (season.status !== "SIGNUP") {
    throw new Error("Regular season has already started for this season.");
  }

  const existing = await PoolLeagueMatch.countDocuments({ seasonId, phase: "REGULAR" });
  if (existing > 0) {
    return { created: 0, message: "Regular season schedule already exists." };
  }

  const teams = await PoolLeagueTeam.find({ seasonId }).sort({ name: 1 });

  if (teams.length < 4) {
    throw new Error("At least 4 teams are required before generating the regular season.");
  }

  if (teams.length % 2 !== 0) {
    throw new Error("Team count must be even before generating the schedule.");
  }

  const rounds = buildRoundPairings(teams, REGULAR_ROUNDS);
  const matchesToInsert = [];

  rounds.forEach((roundData) => {
    roundData.pairings.forEach(([teamA, teamB]) => {
      matchesToInsert.push({
        seasonId,
        phase: "REGULAR",
        week: Math.ceil(roundData.round / 2),
        teamAId: teamA._id,
        teamBId: teamB._id,
        teamAName: teamA.name,
        teamBName: teamB.name,
        status: "TBD",
      });
    });
  });

  await PoolLeagueMatch.insertMany(matchesToInsert);
  await PoolLeagueSeason.findByIdAndUpdate(seasonId, { status: "REGULAR" });

  return {
    created: matchesToInsert.length,
    message: "Regular season schedule generated.",
  };
};

const getHeadToHeadWins = (completedRegularMatches, teamAId, teamBId) => {
  const aId = toId(teamAId);
  const bId = toId(teamBId);

  let winsA = 0;
  let winsB = 0;

  completedRegularMatches.forEach((match) => {
    const teamsInMatch = [toId(match.teamAId), toId(match.teamBId)];
    if (!teamsInMatch.includes(aId) || !teamsInMatch.includes(bId)) {
      return;
    }

    if (toId(match.winnerTeamId) === aId) {
      winsA += 1;
    } else if (toId(match.winnerTeamId) === bId) {
      winsB += 1;
    }
  });

  return { winsA, winsB };
};

const computeStandings = async (seasonId) => {
  const teams = await PoolLeagueTeam.find({ seasonId }).sort({ name: 1 });

  const completedRegularMatches = await PoolLeagueMatch.find({
    seasonId,
    phase: "REGULAR",
    status: "COMPLETE",
  });

  const standingsMap = new Map();

  teams.forEach((team) => {
    standingsMap.set(toId(team._id), {
      teamId: toId(team._id),
      teamName: team.name,
      players: team.playerNames,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      pointDifferential: 0,
      winPct: 0,
      rank: 0,
    });
  });

  completedRegularMatches.forEach((match) => {
    const a = standingsMap.get(toId(match.teamAId));
    const b = standingsMap.get(toId(match.teamBId));

    if (!a || !b) {
      return;
    }

    const teamAScore = Number(match.teamAScore || 0);
    const teamBScore = Number(match.teamBScore || 0);

    a.pointsFor += teamAScore;
    a.pointsAgainst += teamBScore;

    b.pointsFor += teamBScore;
    b.pointsAgainst += teamAScore;

    if (toId(match.winnerTeamId) === toId(match.teamAId)) {
      a.wins += 1;
      b.losses += 1;
    } else if (toId(match.winnerTeamId) === toId(match.teamBId)) {
      b.wins += 1;
      a.losses += 1;
    }
  });

  const standings = Array.from(standingsMap.values());

  standings.forEach((entry) => {
    entry.pointDifferential = entry.pointsFor - entry.pointsAgainst;
    const totalMatches = entry.wins + entry.losses;
    entry.winPct = totalMatches === 0 ? 0 : entry.wins / totalMatches;
  });

  standings.sort((teamA, teamB) => {
    if (teamB.winPct !== teamA.winPct) {
      return teamB.winPct - teamA.winPct;
    }

    if (teamB.wins !== teamA.wins) {
      return teamB.wins - teamA.wins;
    }

    const headToHead = getHeadToHeadWins(
      completedRegularMatches,
      teamA.teamId,
      teamB.teamId,
    );

    if (headToHead.winsA !== headToHead.winsB) {
      return headToHead.winsB - headToHead.winsA;
    }

    if (teamB.pointDifferential !== teamA.pointDifferential) {
      return teamB.pointDifferential - teamA.pointDifferential;
    }

    if (teamB.pointsFor !== teamA.pointsFor) {
      return teamB.pointsFor - teamA.pointsFor;
    }

    return teamA.teamName.localeCompare(teamB.teamName);
  });

  standings.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return standings;
};

const isRegularSeasonComplete = async (seasonId) => {
  const season = await PoolLeagueSeason.findById(seasonId);
  if (!season) {
    return false;
  }

  const totalMatches = await PoolLeagueMatch.countDocuments({
    seasonId,
    phase: "REGULAR",
  });

  if (totalMatches === 0) {
    return false;
  }

  const completedMatches = await PoolLeagueMatch.countDocuments({
    seasonId,
    phase: "REGULAR",
    status: "COMPLETE",
  });

  return completedMatches >= totalMatches;
};

const createSeriesMatches = async ({
  seasonId,
  playoffRound,
  seriesKey,
  bestOf,
  teamA,
  teamB,
}) => {
  if (!teamA || !teamB) {
    return;
  }

  const existing = await PoolLeagueMatch.findOne({ seasonId, phase: "PLAYOFFS", seriesKey });
  if (existing) {
    return;
  }

  await PoolLeagueMatch.create({
    seasonId,
    phase: "PLAYOFFS",
    playoffRound,
    seriesKey,
    bestOf,
    teamAId: teamA._id,
    teamBId: teamB._id,
    teamAName: teamA.name,
    teamBName: teamB.name,
    status: "TBD",
    games: [],
  });
};

const seedPlayoffs = async (seasonId) => {
  const season = await PoolLeagueSeason.findById(seasonId);
  if (!season) {
    throw new Error("Season not found.");
  }

  if (season.playoffsGenerated) {
    return { created: false, message: "Playoffs already generated." };
  }

  const standings = await computeStandings(seasonId);

  if (standings.length < 8) {
    throw new Error("At least 8 teams are required for playoffs.");
  }

  const seedIds = standings.slice(0, 8).map((entry) => entry.teamId);
  const teams = await PoolLeagueTeam.find({ _id: { $in: seedIds } });
  const teamById = new Map(teams.map((team) => [toId(team._id), team]));

  const seed = (index) => teamById.get(seedIds[index - 1]);

  await createSeriesMatches({
    seasonId,
    playoffRound: "QF",
    seriesKey: "QF-1",
    bestOf: 3,
    teamA: seed(1),
    teamB: seed(8),
  });
  await createSeriesMatches({
    seasonId,
    playoffRound: "QF",
    seriesKey: "QF-2",
    bestOf: 3,
    teamA: seed(4),
    teamB: seed(5),
  });
  await createSeriesMatches({
    seasonId,
    playoffRound: "QF",
    seriesKey: "QF-3",
    bestOf: 3,
    teamA: seed(3),
    teamB: seed(6),
  });
  await createSeriesMatches({
    seasonId,
    playoffRound: "QF",
    seriesKey: "QF-4",
    bestOf: 3,
    teamA: seed(2),
    teamB: seed(7),
  });

  await PoolLeagueSeason.findByIdAndUpdate(seasonId, {
    playoffsGenerated: true,
    status: "PLAYOFFS",
  });

  return { created: true, message: "Playoff bracket generated." };
};

const getSeriesState = async (seasonId, seriesKey) => {
  const match = await PoolLeagueMatch.findOne({
    seasonId,
    phase: "PLAYOFFS",
    seriesKey,
  });

  if (!match) {
    return null;
  }

  const teamAWins = match.teamAScore || 0;
  const teamBWins = match.teamBScore || 0;
  const bestOf = match.bestOf;
  const neededWins = Math.floor(bestOf / 2) + 1;

  let winnerTeamId = null;
  if (teamAWins >= neededWins) {
    winnerTeamId = match.teamAId;
  } else if (teamBWins >= neededWins) {
    winnerTeamId = match.teamBId;
  }

  return {
    match,
    teamAWins,
    teamBWins,
    bestOf,
    neededWins,
    winnerTeamId,
  };
};

const tryCreateNextRoundSeries = async (seasonId, round, leftSeriesKey, rightSeriesKey, nextSeriesKey, bestOf) => {
  const left = await getSeriesState(seasonId, leftSeriesKey);
  const right = await getSeriesState(seasonId, rightSeriesKey);

  if (!left?.winnerTeamId || !right?.winnerTeamId) {
    return;
  }

  const [teamA, teamB] = await Promise.all([
    PoolLeagueTeam.findById(left.winnerTeamId),
    PoolLeagueTeam.findById(right.winnerTeamId),
  ]);

  const existing = await PoolLeagueMatch.findOne({
    seasonId,
    phase: "PLAYOFFS",
    seriesKey: nextSeriesKey,
  });

  if (!existing) {
    await createSeriesMatches({
      seasonId,
      playoffRound: round,
      seriesKey: nextSeriesKey,
      bestOf,
      teamA,
      teamB,
    });
    return;
  }

  if (existing.status === "COMPLETE") {
    return;
  }

  const existingTeamAId = existing.teamAId ? toId(existing.teamAId) : null;
  const existingTeamBId = existing.teamBId ? toId(existing.teamBId) : null;
  const nextTeamAId = teamA?._id ? toId(teamA._id) : null;
  const nextTeamBId = teamB?._id ? toId(teamB._id) : null;

  const teamChanged = existingTeamAId !== nextTeamAId || existingTeamBId !== nextTeamBId;

  if (!teamChanged) {
    return;
  }

  existing.teamAId = teamA._id;
  existing.teamBId = teamB._id;
  existing.teamAName = teamA.name;
  existing.teamBName = teamB.name;
  existing.teamAScore = undefined;
  existing.teamBScore = undefined;
  existing.winnerTeamId = undefined;
  existing.loserTeamId = undefined;
  existing.completedAt = undefined;
  existing.status = "TBD";

  await existing.save();
};

const updatePlayoffProgression = async (seasonId) => {
  await tryCreateNextRoundSeries(seasonId, "SF", "QF-1", "QF-2", "SF-1", 3);
  await tryCreateNextRoundSeries(seasonId, "SF", "QF-3", "QF-4", "SF-2", 3);
  await tryCreateNextRoundSeries(seasonId, "F", "SF-1", "SF-2", "F-1", 5);

  const finals = await getSeriesState(seasonId, "F-1");
  if (finals?.winnerTeamId) {
    await PoolLeagueSeason.findByIdAndUpdate(seasonId, { status: "COMPLETE" });
  } else {
    await PoolLeagueSeason.findByIdAndUpdate(seasonId, { status: "PLAYOFFS" });
  }
};

const submitMatchScore = async (matchId, winnerTeamName, inputTeamAScore = null, inputTeamBScore = null) => {
  const match = await PoolLeagueMatch.findById(matchId);

  if (!match) {
    throw new Error("Match not found.");
  }

  if (!winnerTeamName) {
    throw new Error("Please select a winner.");
  }

  const matchSeason = await PoolLeagueSeason.findById(match.seasonId);
  if (matchSeason?.startDate && new Date() < new Date(matchSeason.startDate)) {
    throw new Error("The season has not started yet. Scores cannot be submitted before the start date.");
  }

  if (match.phase === "PLAYOFFS") {
    // Playoff matches: accept series score (e.g., 2-1)
    if (inputTeamAScore === null || inputTeamBScore === null) {
      throw new Error("Series scores are required for playoff matches.");
    }

    const teamASeriesWins = parseInt(inputTeamAScore, 10);
    const teamBSeriesWins = parseInt(inputTeamBScore, 10);
    
    if (isNaN(teamASeriesWins) || isNaN(teamBSeriesWins) || teamASeriesWins < 0 || teamBSeriesWins < 0) {
      throw new Error("Invalid scores provided.");
    }
    
    if (teamASeriesWins === teamBSeriesWins) {
      throw new Error("Series cannot be tied. One team must win.");
    }

    // Validate winner matches higher score
    if (winnerTeamName === match.teamAName && teamASeriesWins <= teamBSeriesWins) {
      throw new Error("Winner must have higher series score.");
    }
    if (winnerTeamName === match.teamBName && teamBSeriesWins <= teamASeriesWins) {
      throw new Error("Winner must have higher series score.");
    }

    if (winnerTeamName === match.teamAName) {
      match.winnerTeamId = match.teamAId;
      match.loserTeamId = match.teamBId;
    } else {
      match.winnerTeamId = match.teamBId;
      match.loserTeamId = match.teamAId;
    }

    match.teamAScore = teamASeriesWins;
    match.teamBScore = teamBSeriesWins;
    match.status = "COMPLETE";
    match.completedAt = new Date();

    await match.save();
    await updatePlayoffProgression(match.seasonId);

  } else {
    // Regular season matches: 1-0 scoring system
    let winnerTeamId, loserTeamId;
    let teamAScore, teamBScore;

    if (winnerTeamName === match.teamAName) {
      winnerTeamId = match.teamAId;
      loserTeamId = match.teamBId;
      teamAScore = 1;
      teamBScore = 0;
    } else if (winnerTeamName === match.teamBName) {
      winnerTeamId = match.teamBId;
      loserTeamId = match.teamAId;
      teamAScore = 0;
      teamBScore = 1;
    } else {
      throw new Error("Invalid team selected.");
    }

    match.teamAScore = teamAScore;
    match.teamBScore = teamBScore;
    match.winnerTeamId = winnerTeamId;
    match.loserTeamId = loserTeamId;
    match.status = "COMPLETE";
    match.completedAt = new Date();

    await match.save();

    const regularSeasonDone = await isRegularSeasonComplete(match.seasonId);
    if (regularSeasonDone) {
      await seedPlayoffs(match.seasonId);
    }
  }

  return match;
};

const getTeamContext = async (seasonId, selectedTeamId) => {
  const teams = await PoolLeagueTeam.find({ seasonId }).sort({ name: 1 });
  const activeTeamId = selectedTeamId || (teams[0]?._id ? toId(teams[0]._id) : null);
  return { teams, activeTeamId };
};

const formatMatchStatus = (match) => {
  if (match.status === "COMPLETE") {
    return "Complete";
  }

  return "TBD";
};

const fillRandomResults = async (seasonId) => {
  const incompletedMatches = await PoolLeagueMatch.find({
    seasonId,
    phase: "REGULAR",
    status: { $ne: "COMPLETE" },
  });

  if (incompletedMatches.length === 0) {
    return { updated: 0, message: "No incomplete matches to fill." };
  }

  let updated = 0;
  for (const match of incompletedMatches) {
    const winner = Math.random() < 0.5 ? match.teamAName : match.teamBName;
    await submitMatchScore(match._id, winner);
    updated += 1;
  }

  return {
    updated,
    message: `Filled ${updated} random match result${updated > 1 ? "s" : ""}.`,
  };
};

export {
  computeStandings,
  createTeam,
  fillRandomResults,
  formatMatchStatus,
  generateRegularSchedule,
  getOrCreateCurrentSeason,
  getSeasonLabel,
  getTeamContext,
  isRegularSeasonComplete,
  seedPlayoffs,
  submitMatchScore,
};
