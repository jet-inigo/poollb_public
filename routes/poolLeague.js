import express from "express";
import PoolLeagueMatch from "../models/poolLeagueMatch.js";
import PoolLeagueTeam from "../models/poolLeagueTeam.js";
import {
  computeStandings,
  // fillRandomResults, // TESTING - commented out for main build
  formatMatchStatus,
  getOrCreateCurrentSeason,
  getSeasonLabel,
  getTeamContext,
  isRegularSeasonComplete,
  seedPlayoffs,
  submitMatchScore,
} from "../services/poolLeagueService.js";

const router = express.Router();

const serializeMatch = (match, selectedTeamId) => {
  const isTeamA = String(match.teamAId) === String(selectedTeamId);
  const opponent = isTeamA ? match.teamBName : match.teamAName;
  const teamScore = isTeamA ? match.teamAScore : match.teamBScore;
  const opponentScore = isTeamA ? match.teamBScore : match.teamAScore;

  return {
    id: String(match._id),
    opponent,
    matchup: `${match.teamAName} vs ${match.teamBName}`,
    winnerTeamId: match.winnerTeamId ? String(match.winnerTeamId) : null,
    teamName: isTeamA ? match.teamAName : match.teamBName,
    teamAId: String(match.teamAId),
    teamBId: String(match.teamBId),
    teamAName: match.teamAName,
    teamBName: match.teamBName,
    statusLabel: formatMatchStatus(match),
    phase: match.phase,
    week: match.week,
    round: match.round,
    completedAt: match.completedAt,
    teamScore,
    opponentScore,
    playoffRound: match.playoffRound,
    seriesKey: match.seriesKey,
    bestOf: match.bestOf,
  };
};

router.get("/", (_, res) => {
  res.redirect("/poolLeague/this-week");
});

router.get("/this-week", async (req, res) => {
  try {
    let season = await getOrCreateCurrentSeason();
    const seasonLabel = getSeasonLabel(season);

    // Auto-seed playoffs if the regular season end date has passed
    if (season.status === "REGULAR") {
      try {
        const done = await isRegularSeasonComplete(season._id);
        if (done) {
          await seedPlayoffs(season._id);
          season = await getOrCreateCurrentSeason();
        }
      } catch (_) {
        // Not ready yet (e.g. not enough teams), ignore
      }
    }
    const selectedTeamId = req.query.teamId;
    const teams = await PoolLeagueTeam.find({ seasonId: season._id }).sort({ name: 1 });
    const activeTeamId = selectedTeamId || null; // Default to null (all matches)

    const isPlayoffsView = season.status === "PLAYOFFS" || season.status === "COMPLETE";
    const regularWeeks = season.regularWeeks || 4;
    let currentWeek = 1;

    if (!isPlayoffsView) {
      if (season.startDate) {
        const now = new Date();
        const startDate = new Date(season.startDate);
        const dayMs = 24 * 60 * 60 * 1000;
        const daysBetween = Math.max(1, season.daysBetweenWeeks || 7);

        if (now >= startDate) {
          const elapsedDays = Math.floor((now - startDate) / dayMs);
          let adjustedElapsedDays = elapsedDays;

          // Pause week advancement during any configured break window.
          if (season.breakAfterWeek) {
            const breakStartOffsetDays = season.breakAfterWeek * daysBetween;
            if (elapsedDays >= breakStartOffsetDays) {
              const breakDurationDays = (season.breakWeeks || 1) * daysBetween;
              const daysSinceBreakStart = elapsedDays - breakStartOffsetDays;
              const pausedDays = Math.min(daysSinceBreakStart, breakDurationDays);
              adjustedElapsedDays -= pausedDays;
            }
          }

          const elapsedWeeks = Math.floor(adjustedElapsedDays / daysBetween);
          currentWeek = Math.min(regularWeeks, elapsedWeeks + 1);
        }
      } else {
        // Fallback for older seasons without startDate: infer current week from completed rounds.
        const completedRounds = await PoolLeagueMatch.countDocuments({
          seasonId: season._id,
          phase: "REGULAR",
          status: "COMPLETE",
        });
        const totalMatchesPerRound = teams.length > 0 ? teams.length / 2 : 1;
        const roundsFinished = totalMatchesPerRound > 0 ? Math.floor(completedRounds / totalMatchesPerRound) : 0;
        currentWeek = Math.min(regularWeeks, Math.floor(roundsFinished / 2) + 1);
      }
    }

    let isBreakWeek = false;
    if (!isPlayoffsView && season.breakAfterWeek && season.startDate) {
      const daysBetween = season.daysBetweenWeeks || 7;
      const breakStart = new Date(season.startDate);
      breakStart.setDate(breakStart.getDate() + season.breakAfterWeek * daysBetween);
      const breakEnd = new Date(breakStart);
      breakEnd.setDate(breakEnd.getDate() + (season.breakWeeks || 1) * daysBetween);
      const now = new Date();
      isBreakWeek = now >= breakStart && now < breakEnd;
    }

    let matches = [];
    const baseFilter = {
      seasonId: season._id,
    };

    if (isPlayoffsView) {
      baseFilter.phase = "PLAYOFFS";
      if (activeTeamId) {
        baseFilter.$or = [{ teamAId: activeTeamId }, { teamBId: activeTeamId }];
      }
      const ROUND_ORDER = { F: 1, SF: 2, QF: 3 };
      matches = await PoolLeagueMatch.find(baseFilter).sort({ seriesKey: 1, createdAt: 1 });
      matches.sort((matchA, matchB) => {
        const roundA = ROUND_ORDER[matchA.playoffRound] ?? 99;
        const roundB = ROUND_ORDER[matchB.playoffRound] ?? 99;
        if (roundA !== roundB) return roundA - roundB;

        const matchAComplete = matchA.status === "COMPLETE" ? 1 : 0;
        const matchBComplete = matchB.status === "COMPLETE" ? 1 : 0;
        if (matchAComplete !== matchBComplete) return matchAComplete - matchBComplete;

        return (matchA.seriesKey || "").localeCompare(matchB.seriesKey || "");
      });
    } else {
      const weekVisibilityFilter = currentWeek <= 1
        ? { week: 1 }
        : {
          $or: [
            { week: currentWeek },
            { week: { $lt: currentWeek }, status: { $ne: "COMPLETE" } },
          ],
        };

      const regularFilters = [
        { seasonId: season._id, phase: "REGULAR" },
        weekVisibilityFilter,
      ];

      if (activeTeamId) {
        regularFilters.push({ $or: [{ teamAId: activeTeamId }, { teamBId: activeTeamId }] });
      }

      matches = await PoolLeagueMatch.find({ $and: regularFilters }).sort({
        week: 1,
        createdAt: 1,
      });
    }

    res.render("poolLeagueThisWeek", {
      seasonLabel,
      season,
      teams,
      activeTeamId,
      currentWeek,
      isPlayoffsView,
      isBreakWeek,
      matches: matches.map((match) => serializeMatch(match, activeTeamId)),
      success: req.query.success || "",
      error: req.query.error || "",
    });
  } catch (error) {
    console.error("Pool League this-week error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/history", async (req, res) => {
  try {
    const season = await getOrCreateCurrentSeason();
    const seasonLabel = getSeasonLabel(season);
    const teams = await PoolLeagueTeam.find({ seasonId: season._id }).sort({ name: 1 });
    const activeTeamId = req.query.teamId || null;

    const filter = {
      seasonId: season._id,
      status: "COMPLETE",
    };

    if (activeTeamId) {
      filter.$or = [{ teamAId: activeTeamId }, { teamBId: activeTeamId }];
    }

    const matches = await PoolLeagueMatch.find(filter).sort({ completedAt: -1, createdAt: -1 });

    const rows = matches.map((match) => {
      const winner = String(match.winnerTeamId) === String(match.teamAId) ? match.teamAName : match.teamBName;
      return {
        id: String(match._id),
        phase: match.phase,
        matchup: `${match.teamAName} vs ${match.teamBName}`,
        score: `${match.teamAScore} - ${match.teamBScore}`,
        winner,
        completedAt: match.completedAt,
        playoffRound: match.playoffRound,
      };
    });

    res.render("poolLeagueHistory", {
      seasonLabel,
      teams,
      activeTeamId,
      rows,
    });
  } catch (error) {
    console.error("Pool League history error:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/standings", async (req, res) => {
  try {
    const season = await getOrCreateCurrentSeason();
    const seasonLabel = getSeasonLabel(season);
    const standings = await computeStandings(season._id);

    res.render("poolLeagueStandings", {
      seasonLabel,
      standings,
      status: season.status,
    });
  } catch (error) {
    console.error("Pool League standings error:", error);
    res.status(500).send("Internal Server Error");
  }
});

/* TESTING ROUTES - commented out for main build
router.post("/fill-random-results", async (_, res) => {
  try {
    const season = await getOrCreateCurrentSeason();
    const result = await fillRandomResults(season._id);
    const message = encodeURIComponent(result.message);
    res.redirect(`/poolLeague/this-week?success=${message}`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Failed to fill results");
    res.redirect(`/poolLeague/this-week?error=${message}`);
  }
});

router.post("/force-start-playoffs", async (_, res) => {
  try {
    const season = await getOrCreateCurrentSeason();
    const result = await seedPlayoffs(season._id);
    const message = encodeURIComponent(result.message);
    res.redirect(`/poolLeague/this-week?success=${message}`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Failed to start playoffs");
    res.redirect(`/poolLeague/this-week?error=${message}`);
  }
});
*/

router.post("/match/:matchId/score", async (req, res) => {
  try {
    await submitMatchScore(
      req.params.matchId, 
      req.body.winner,
      req.body.teamAScore || null,
      req.body.teamBScore || null
    );
    const teamIdParam = req.body.teamId ? `&teamId=${req.body.teamId}` : "";
    res.redirect(`/poolLeague/this-week?success=Score%20saved${teamIdParam}`);
  } catch (error) {
    const teamIdParam = req.body.teamId ? `&teamId=${req.body.teamId}` : "";
    const message = encodeURIComponent(error.message || "Could not save score");
    res.redirect(`/poolLeague/this-week?error=${message}${teamIdParam}`);
  }
});

export default router;
