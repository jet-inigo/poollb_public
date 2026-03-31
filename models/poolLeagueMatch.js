import mongoose from "mongoose";

const poolLeagueMatchSchema = new mongoose.Schema({
  seasonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PoolLeagueSeason",
    required: true,
  },
  phase: {
    type: String,
    enum: ["REGULAR", "PLAYOFFS"],
    required: true,
  },
  week: Number,
  teamAId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PoolLeagueTeam",
    required: true,
  },
  teamBId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PoolLeagueTeam",
    required: true,
  },
  teamAName: { type: String, required: true },
  teamBName: { type: String, required: true },
  status: {
    type: String,
    enum: ["TBD", "COMPLETE"],
    default: "TBD",
  },
  teamAScore: Number,
  teamBScore: Number,
  winnerTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PoolLeagueTeam",
  },
  loserTeamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PoolLeagueTeam",
  },
  completedAt: Date,
  playoffRound: {
    type: String,
    enum: ["QF", "SF", "F"],
  },
  seriesKey: String,
  bestOf: Number,
  createdAt: { type: Date, default: Date.now },
});

poolLeagueMatchSchema.index({ seasonId: 1, phase: 1, week: 1, round: 1 });
poolLeagueMatchSchema.index({ seasonId: 1, phase: 1, seriesKey: 1 });

const PoolLeagueMatch = mongoose.model("PoolLeagueMatch", poolLeagueMatchSchema);

export default PoolLeagueMatch;
