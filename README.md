# Pool Leaderboard

## Self-hosting

**Requirements**

- Docker Compose

**Setup**

1. Clone the repository
2. Create `players.csv`, `teams.csv`, `seasons.csv`, and `.env` from the given sample files
3. Create and run containers:

```bash
docker-compose up -d --build
```

## Pool League

1. Define 2-player teams in `teams.csv` as `Player A Name,Player B Name` (see `teams-sample.csv`).
2. Define the season in `seasons.csv` (see `seasons-sample.csv`).
3. Restart the app so teams are seeded for the current season.
4. Generate/load the regular-season schedule from the server (not the website):

```bash
# Full random schedule for active season
node scripts/manageSeasonSchedule.js

# Load schedule from CSV (supports partially completed season)
node scripts/manageSeasonSchedule.js --csv ./schedule-sample.csv --replace-existing

# Load first weeks from CSV, then randomly generate remaining matches without repeated matchups
node scripts/manageSeasonSchedule.js --csv ./schedule-sample.csv --fill-remaining-random --replace-existing
```

5. Use the team selector to view weekly matches and submit scores.
6. View completed matches in `/poolLeague/history` and rankings in `/poolLeague/standings`.
7. Playoffs (top 8 seeds, QF → SF → F) are seeded automatically only when all regular-season matches are complete.
8. You can force-start playoffs at any time from the server:

```bash
# Active season
node scripts/forceStartPlayoffs.js

# Specific season
node scripts/forceStartPlayoffs.js "Spring 2026"
```
