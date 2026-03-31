import mongoose from "mongoose";
import dotenv from "dotenv";
import PoolLeagueSeason from "../models/poolLeagueSeason.js";

dotenv.config();

const {
  MONGO_HOSTNAME,
  MONGO_INITDB_ROOT_USERNAME,
  MONGO_INITDB_ROOT_PASSWORD,
  MONGO_INITDB_DATABASE,
} = process.env;

const connectMongo = async () => {
  const url = new URL(`mongodb://${MONGO_HOSTNAME}:27017/${MONGO_INITDB_DATABASE}`);
  url.username = MONGO_INITDB_ROOT_USERNAME;
  url.password = MONGO_INITDB_ROOT_PASSWORD;
  url.search = new URLSearchParams({
    retryWrites: "true",
    w: "majority",
    authSource: "admin",
  }).toString();

  await mongoose.connect(url.toString(), {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
};

const disconnectMongo = async () => {
  await mongoose.disconnect();
};

const getSeasonLabel = (season) => {
  if (!season) return "Unknown";
  return season.seasonName || `${season.semester} ${season.year}`;
};

const resolveSeason = async (seasonArg = "") => {
  if (seasonArg) {
    const trimmed = seasonArg.trim();

    if (/^[a-f\d]{24}$/i.test(trimmed)) {
      const byId = await PoolLeagueSeason.findById(trimmed);
      if (byId) return byId;
    }

    const semesterMatch = trimmed.match(/^(Spring|Fall)\s+(\d{4})$/i);
    if (semesterMatch) {
      const semester = semesterMatch[1][0].toUpperCase() + semesterMatch[1].slice(1).toLowerCase();
      const year = parseInt(semesterMatch[2], 10);
      const bySemester = await PoolLeagueSeason.findOne({ semester, year });
      if (bySemester) return bySemester;
    }

    const byName = await PoolLeagueSeason.findOne({
      seasonName: { $regex: `^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });

    if (byName) return byName;

    return null;
  }

  const active = await PoolLeagueSeason.findOne({
    status: { $in: ["SIGNUP", "REGULAR", "PLAYOFFS"] },
  }).sort({ createdAt: -1 });

  if (active) return active;

  return PoolLeagueSeason.findOne({}).sort({ createdAt: -1 });
};

export {
  connectMongo,
  disconnectMongo,
  getSeasonLabel,
  resolveSeason,
};