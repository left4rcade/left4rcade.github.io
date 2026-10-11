-- Left4RCade arcade ROM voting
-- Apply this migration to the existing D1 database "left4rcade".
-- Does not alter games, votes, pricing_poll_votes, or rate_limits.

CREATE TABLE IF NOT EXISTS arcade_votes (
  rom_id TEXT NOT NULL,
  voter_hash TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK (vote IN (-1, 0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rom_id, voter_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_arcade_votes_rom_vote
  ON arcade_votes (rom_id, vote);

CREATE INDEX IF NOT EXISTS idx_arcade_votes_voter
  ON arcade_votes (voter_hash);
