# Arcade voting Worker integration

The website's `arcade.html` uses two routes on the existing Worker. The Worker source is managed in the Cloudflare dashboard and is not present in the inspected GitHub repositories, so these changes must be added to that Worker before voting can be enabled.

## 1. D1 migration

Apply `migrations/0001_arcade_votes.sql` to the existing D1 database named `left4rcade`. It creates only `arcade_votes`; it does not alter `games`, `votes`, `pricing_poll_votes`, or `rate_limits`.

## 2. Add helpers before `export default`

```js
let arcadeRomIdsCache = null;
let arcadeRomIdsCacheUntil = 0;

async function getArcadeVoterHash(request) {
  const userAgent = request.headers.get("User-Agent") || "unknown";
  return sha256(
    `${getClientIp(request)}|${userAgent}|left4rcade-arcade-vote-v1`
  );
}

async function isKnownArcadeRom(romId) {
  if (!arcadeRomIdsCache || Date.now() >= arcadeRomIdsCacheUntil) {
    const response = await fetch("https://left4rcade.github.io/arcade-games.json", {
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (!response.ok) throw new Error("Could not load arcade ROM allowlist.");
    const data = await response.json();
    const games = Array.isArray(data) ? data : Array.isArray(data.games) ? data.games : [];
    if (!games.length) throw new Error("Arcade ROM allowlist is empty or invalid.");
    arcadeRomIdsCache = new Set(games.map(game => String(game.id || "")).filter(Boolean));
    arcadeRomIdsCacheUntil = Date.now() + 300000;
  }
  return arcadeRomIdsCache.has(romId);
}
```

The cache is per Worker isolate and expires after five minutes. The allowlist is the public catalogue; an unknown ROM is never inserted into D1.

## 3. Add routes before the final `return json({ error: "Not found." }, 404);`

```js
// Arcade ROM voting: list aggregate counts and this visitor's active votes.
if (path === "/api/arcade-votes" && request.method === "GET") {
  const voterHash = await getArcadeVoterHash(request);
  const result = await env.DB.prepare(`
    SELECT
      rom_id,
      SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up_votes,
      SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down_votes,
      MAX(CASE WHEN voter_hash = ? THEN vote ELSE 0 END) AS my_vote
    FROM arcade_votes
    WHERE vote != 0
    GROUP BY rom_id
  `).bind(voterHash).all();

  return json({ votes: result.results || [] });
}

// Arcade ROM voting: toggle or switch this visitor's vote.
const arcadeVoteMatch = path.match(/^\\/api\\/arcade\\/([^/]+)\\/vote$/);

if (arcadeVoteMatch && request.method === "POST") {
  let romId;
  try {
    romId = decodeURIComponent(arcadeVoteMatch[1]);
  } catch {
    return json({ error: "Invalid ROM ID." }, 400);
  }

  if (!/^[a-zA-Z0-9_.+-]{1,100}$/.test(romId)) {
    return json({ error: "Invalid ROM ID." }, 400);
  }

  const allowed = await checkRateLimit(request, env, "arcade-vote", 15);
  if (!allowed) {
    return json({ error: "Too many voting attempts. Please try again next minute." }, 429);
  }

  const parsed = await readJsonBody(request);
  if (parsed.error) return json({ error: parsed.error }, 400);

  const direction = parsed.body.direction;
  if (direction !== "up" && direction !== "down") {
    return json({ error: "Direction must be 'up' or 'down'." }, 400);
  }

  if (!(await isKnownArcadeRom(romId))) {
    return json({ error: "Arcade ROM not found." }, 404);
  }

  const voterHash = await getArcadeVoterHash(request);
  const requestedVote = direction === "up" ? 1 : -1;

  await env.DB.prepare(`
    INSERT INTO arcade_votes (rom_id, voter_hash, vote, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (rom_id, voter_hash) DO UPDATE SET
      vote = CASE
        WHEN arcade_votes.vote = excluded.vote THEN 0
        ELSE excluded.vote
      END,
      updated_at = datetime('now')
  `).bind(romId, voterHash, requestedVote).run();

  const totals = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up_votes,
      SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down_votes,
      MAX(CASE WHEN voter_hash = ? THEN vote ELSE 0 END) AS my_vote
    FROM arcade_votes
    WHERE rom_id = ?
  `).bind(voterHash, romId).first();

  return json({
    rom_id: romId,
    up_votes: Number(totals?.up_votes) || 0,
    down_votes: Number(totals?.down_votes) || 0,
    my_vote: Number(totals?.my_vote) || 0
  });
}
```

## 4. Behavior and checks

- First Up/Down click records `1` / `-1`.
- Clicking the same direction again stores `0`, withdrawing the vote.
- Clicking the opposite direction switches the active vote.
- The primary key `(rom_id, voter_hash)` prevents more than one row per visitor and ROM.
- Withdrawn votes remain as `0` rows for clean toggling, but are excluded from counts.
- The separate hash suffix prevents arcade votes from reusing the same identifier as request votes.
- A separate `arcade-vote` rate-limit action leaves the existing vote limits untouched.
- Existing request and pricing-poll endpoints remain unchanged.

Before deploying the Worker change, verify the JSON root shape and test both routes against a non-production copy or during a controlled test. After deploying, test Up, repeat Up (withdraw), Up-to-Down, invalid ROM, invalid direction, rate limiting, and that Game Requests and Pricing Poll still work.
