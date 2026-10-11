const ALLOWED_ORIGIN = "https://left4rcade.github.io";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getVoterHash(request) {
  const userAgent = request.headers.get("User-Agent") || "unknown";
  return sha256(
    \`\${getClientIp(request)}|\${userAgent}|left4rcade-vote-v1\`
  );
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";

  return value
    .replace(/[\\u0000-\\u001F\\u007F]/g, " ")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function checkRateLimit(request, env, action, limit) {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("User-Agent") || "unknown";
  const rateKey = await sha256(
    \`\${ip}|\${userAgent}|left4rcade-rate-v1\`
  );

  const windowStart = Math.floor(Date.now() / 60000);

  // Remove expired rate-limit windows older than 24 hours.
  await env.DB.prepare(
    "DELETE FROM rate_limits WHERE window_start < ?"
  ).bind(windowStart - 1440).run();

  await env.DB.prepare(\`
    INSERT INTO rate_limits
      (rate_key, action, window_start, request_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT (rate_key, action, window_start)
    DO UPDATE SET request_count = request_count + 1
  \`).bind(rateKey, action, windowStart).run();

  const result = await env.DB.prepare(\`
    SELECT request_count
    FROM rate_limits
    WHERE rate_key = ? AND action = ? AND window_start = ?
  \`).bind(rateKey, action, windowStart).first();

  return (result?.request_count ?? 0) <= limit;
}

async function readJsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return { error: "Content-Type must be application/json." };
  }

  const text = await request.text();

  if (text.length > 12000) {
    return { error: "Request body is too large." };
  }

  try {
    const body = JSON.parse(text);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "Invalid JSON body." };
    }

    return { body };
  } catch {
    return { error: "Invalid JSON body." };
  }
}

// Arcade voting uses a separate hash namespace from game-request voting.
async function getArcadeVoterHash(request) {
  const userAgent = request.headers.get("User-Agent") || "unknown";
  return sha256(
    \`\${getClientIp(request)}|\${userAgent}|left4rcade-arcade-vote-v1\`
  );
}

// Cache the public ROM allowlist in each Worker isolate for five minutes.
let arcadeRomIdsCache = null;
let arcadeRomIdsCacheUntil = 0;

async function isKnownArcadeRom(romId) {
  if (!arcadeRomIdsCache || Date.now() >= arcadeRomIdsCacheUntil) {
    const response = await fetch("https://left4rcade.github.io/arcade-games.json", {
      cf: { cacheTtl: 300, cacheEverything: true }
    });

    if (!response.ok) {
      throw new Error("Could not load arcade ROM allowlist.");
    }

    const data = await response.json();
    const games = Array.isArray(data)
      ? data
      : Array.isArray(data.games)
        ? data.games
        : [];

    if (!games.length) {
      throw new Error("Arcade ROM allowlist is empty or invalid.");
    }

    arcadeRomIdsCache = new Set(
      games.map(game => String(game.id || "")).filter(Boolean)
    );
    arcadeRomIdsCacheUntil = Date.now() + 300000;
  }

  return arcadeRomIdsCache.has(romId);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    try {
      // List game requests.
      if (path === "/api/requests" && request.method === "GET") {
        const result = await env.DB.prepare(\`
          SELECT id, name, platform, reason, created_at, votes
          FROM games
          ORDER BY votes DESC, created_at ASC
        \`).all();

        return json({ requests: result.results || [] });
      }

      // Submit a new game request.
      if (path === "/api/requests" && request.method === "POST") {
        const allowed = await checkRateLimit(
          request, env, "request", 5
        );

        if (!allowed) {
          return json({
            error: "Too many requests. Please try again next minute."
          }, 429);
        }

        const parsed = await readJsonBody(request);

        if (parsed.error) {
          return json({ error: parsed.error }, 400);
        }

        const name = cleanString(parsed.body.name, 120);
        const platform = cleanString(parsed.body.platform, 120);
        const reason = cleanString(parsed.body.reason, 1000);

        if (!name) {
          return json({ error: "Game name is required." }, 400);
        }

        const duplicate = await env.DB.prepare(\`
          SELECT id
          FROM games
          WHERE lower(trim(name)) = lower(trim(?))
          LIMIT 1
        \`).bind(name).first();

        if (duplicate) {
          return json({
            error: "This game has already been requested.",
            id: duplicate.id
          }, 409);
        }

        let insertResult;

        try {
          insertResult = await env.DB.prepare(\`
            INSERT INTO games (name, platform, reason)
            VALUES (?, ?, ?)
          \`).bind(name, platform, reason).run();
        } catch (error) {
          // Handles concurrent submissions caught by the unique index.
          if (String(error?.message || error).includes(
            "idx_games_name_unique"
          )) {
            return json({
              error: "This game has already been requested."
            }, 409);
          }

          throw error;
        }

        const game = await env.DB.prepare(\`
          SELECT id, name, platform, reason, created_at, votes
          FROM games
          WHERE id = ?
        \`).bind(insertResult.meta.last_row_id).first();

        return json({ request: game }, 201);
      }

      // Monthly willingness-to-pay poll: read results.
      if (path === "/api/pricing-poll" && request.method === "GET") {
        const results = await env.DB.prepare(\`
          SELECT amount, COUNT(*) AS votes
          FROM pricing_poll_votes
          GROUP BY amount
        \`).all();

        const totalRow = await env.DB.prepare(\`
          SELECT COUNT(*) AS total
          FROM pricing_poll_votes
        \`).first();

        const userAgent = request.headers.get("User-Agent") || "unknown";
        const pollHash = await sha256(
          \`\${getClientIp(request)}|\${userAgent}|left4rcade-pricing-poll-v1\`
        );

        const existingVote = await env.DB.prepare(\`
          SELECT 1 AS voted
          FROM pricing_poll_votes
          WHERE voter_hash = ?
        \`).bind(pollHash).first();

        return json({
          results: results.results || [],
          total: Number(totalRow?.total) || 0,
          hasVoted: Boolean(existingVote)
        });
      }

      // Monthly willingness-to-pay poll: submit one answer.
      if (path === "/api/pricing-poll" && request.method === "POST") {
        const allowed = await checkRateLimit(
          request, env, "pricing-poll", 3
        );

        if (!allowed) {
          return json({
            error: "Too many attempts. Please try again next minute."
          }, 429);
        }

        const parsed = await readJsonBody(request);

        if (parsed.error) {
          return json({ error: parsed.error }, 400);
        }

        const amount = parsed.body.amount;
        const choices = ["$0", "$1", "$5", "$10", "$20+", "Not sure"];

        if (!choices.includes(amount)) {
          return json({ error: "Invalid poll option." }, 400);
        }

        const userAgent = request.headers.get("User-Agent") || "unknown";
        const pollHash = await sha256(
          \`\${getClientIp(request)}|\${userAgent}|left4rcade-pricing-poll-v1\`
        );

        const inserted = await env.DB.prepare(\`
          INSERT OR IGNORE INTO pricing_poll_votes (voter_hash, amount)
          VALUES (?, ?)
        \`).bind(pollHash, amount).run();

        if ((inserted.meta?.changes ?? 0) === 0) {
          return json({
            error: "You have already submitted a poll response."
          }, 409);
        }

        const results = await env.DB.prepare(\`
          SELECT amount, COUNT(*) AS votes
          FROM pricing_poll_votes
          GROUP BY amount
        \`).all();

        const totalRow = await env.DB.prepare(\`
          SELECT COUNT(*) AS total
          FROM pricing_poll_votes
        \`).first();

        return json({
          message: "Poll response recorded.",
          results: results.results || [],
          total: Number(totalRow?.total) || 0
        }, 201);
      }

      // Arcade ROM voting: list aggregate counts and this visitor's active votes.
      if (path === "/api/arcade-votes" && request.method === "GET") {
        const voterHash = await getArcadeVoterHash(request);
        const result = await env.DB.prepare(\`
          SELECT
            rom_id,
            SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up_votes,
            SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down_votes,
            MAX(CASE WHEN voter_hash = ? THEN vote ELSE 0 END) AS my_vote
          FROM arcade_votes
          WHERE vote != 0
          GROUP BY rom_id
        \`).bind(voterHash).all();

        return json({ votes: result.results || [] });
      }

      // Arcade ROM voting: toggle an existing direction or switch directions.
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

        const allowed = await checkRateLimit(
          request, env, "arcade-vote", 15
        );

        if (!allowed) {
          return json({
            error: "Too many voting attempts. Please try again next minute."
          }, 429);
        }

        const parsed = await readJsonBody(request);

        if (parsed.error) {
          return json({ error: parsed.error }, 400);
        }

        const direction = parsed.body.direction;

        if (direction !== "up" && direction !== "down") {
          return json({
            error: "Direction must be 'up' or 'down'."
          }, 400);
        }

        if (!(await isKnownArcadeRom(romId))) {
          return json({ error: "Arcade ROM not found." }, 404);
        }

        const voterHash = await getArcadeVoterHash(request);
        const requestedVote = direction === "up" ? 1 : -1;

        await env.DB.prepare(\`
          INSERT INTO arcade_votes (rom_id, voter_hash, vote, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT (rom_id, voter_hash) DO UPDATE SET
            vote = CASE
              WHEN arcade_votes.vote = excluded.vote THEN 0
              ELSE excluded.vote
            END,
            updated_at = datetime('now')
        \`).bind(romId, voterHash, requestedVote).run();

        const totals = await env.DB.prepare(\`
          SELECT
            SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up_votes,
            SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down_votes,
            MAX(CASE WHEN voter_hash = ? THEN vote ELSE 0 END) AS my_vote
          FROM arcade_votes
          WHERE rom_id = ?
        \`).bind(voterHash, romId).first();

        return json({
          rom_id: romId,
          up_votes: Number(totals?.up_votes) || 0,
          down_votes: Number(totals?.down_votes) || 0,
          my_vote: Number(totals?.my_vote) || 0
        });
      }

      // Vote for an existing game request.
      const voteMatch = path.match(/^\\/api\\/requests\\/(\\d+)\\/vote$/);

      if (voteMatch && request.method === "POST") {
        const gameId = Number(voteMatch[1]);

        if (!Number.isSafeInteger(gameId) || gameId < 1) {
          return json({ error: "Invalid game ID." }, 400);
        }

        const allowed = await checkRateLimit(
          request, env, "vote", 15
        );

        if (!allowed) {
          return json({
            error: "Too many voting attempts. Please try again next minute."
          }, 429);
        }

        const game = await env.DB.prepare(
          "SELECT id FROM games WHERE id = ?"
        ).bind(gameId).first();

        if (!game) {
          return json({ error: "Game request not found." }, 404);
        }

        const voterHash = await getVoterHash(request);

        // D1 batch executes these statements transactionally.
        // INSERT OR IGNORE protects against duplicate and concurrent votes.
        const results = await env.DB.batch([
          env.DB.prepare(\`
            INSERT OR IGNORE INTO votes (game_id, voter_hash)
            VALUES (?, ?)
          \`).bind(gameId, voterHash),

          // Reconcile the counter against the actual vote records.
          env.DB.prepare(\`
            UPDATE games
            SET votes = (
              SELECT COUNT(*)
              FROM votes
              WHERE votes.game_id = games.id
            )
            WHERE id = ?
          \`).bind(gameId)
        ]);

        const inserted = results[0]?.meta?.changes ?? 0;

        if (inserted === 0) {
          return json({
            error: "You have already voted for this game."
          }, 409);
        }

        const updatedGame = await env.DB.prepare(\`
          SELECT id, name, platform, reason, created_at, votes
          FROM games
          WHERE id = ?
        \`).bind(gameId).first();

        return json({
          message: "Vote recorded successfully.",
          request: updatedGame
        });
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      // Keep technical details out of public responses.
      console.error("Left4RCade API error:", error?.message || "Unknown error");

      return json({ error: "Internal server error." }, 500);
    }
  }
};
