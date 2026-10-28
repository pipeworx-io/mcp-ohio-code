interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared full-text-search helpers for every caller of the FTS5 case/statute
 * search shard (workers/gateway/src/search-shard.ts, `op match ?`).
 *
 * THE BUG THIS FIXES (fleet #3070). Several packs sent the caller's raw text
 * straight into FTS5's MATCH operator. A comma, a '?', or an AND/OR/NOT/NEAR
 * in the question is FTS5 syntax, so the shard throws a SQLite error — and
 * the pack reported that as `index_unreachable`, an infrastructure failure,
 * when the real problem was punctuation in a plain-language question. Even
 * once the syntax is sanitized, ANDing every word of a whole sentence
 * ("what does X require") returns zero hits, because no statute section
 * contains the literal word "what" — a silent, wrong "no match" for what is
 * actually a query-shape problem, not an absence of an answer.
 *
 * Two packs independently built the identical fix — illinois-code
 * (bdc38b2c2) and france-legi's core.ts — before this existed. Lifted here so
 * every other caller of the shard (north-carolina-code, indiana-code,
 * wyoming-code, the court-listener case-law fan-out in caselaw-search.ts, and
 * any future statute pack) gets it for free instead of re-deriving it a
 * third, fourth, fifth time.
 */

type FtsMode = 'all' | 'any';

/**
 * Caller text -> a safe FTS5 MATCH expression. Every word (or quoted phrase)
 * is re-quoted as an FTS5 string literal, so FTS5 operators (AND/OR/NOT/
 * NEAR), column filters, and stray punctuation in a plain-language question
 * — commas, question marks, the very things a real caller's sentence is full
 * of — cannot change the query's meaning or throw a syntax error. Non-letter,
 * non-digit characters are simply dropped by the `\p{L}\p{N}` match, which is
 * what turns "bond, and license" (a syntax error against `op match ?`) into
 * a clean three-term query.
 *
 * `mode: 'all'` ANDs every term (precise, for a short deliberate query);
 * `mode: 'any'` ORs them (a relaxed retry for a whole sentence — see
 * `shardSearch` below, which is the fallback policy this exists to support).
 *
 * `extraTerm`, when given, is ANDed on as its own already-resolved literal
 * (e.g. a jurisdiction/code token every hit must also carry). Resolving a
 * caller-facing id into that literal — france-legi's `codeToken` — is the
 * caller's job, not this function's; this only assembles the final MATCH
 * string.
 *
 * Returns null when the text has no searchable words at all (e.g. "???").
 */
function ftsQuery(text: string, mode: FtsMode, extraTerm?: string | null): string | null {
  const parts: string[] = [];
  const re = /"([^"]+)"|([\p{L}\p{N}]+)/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[1] ?? m[2];
    const words = raw.match(/[\p{L}\p{N}]+/gu);
    if (!words?.length) continue;
    parts.push(`"${words.join(' ')}"`);
  }
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0] : mode === 'all' ? parts.join(' AND ') : `(${parts.join(' OR ')})`;
  return extraTerm ? `${body} AND "${extraTerm}"` : body;
}

interface FtsHit {
  opinion_id: number;
  score: number;
}

interface FtsShardResult {
  hits: FtsHit[];
  /** Which query actually produced `hits`. Null only when the text had no
   *  searchable words at all (`ftsQuery` returned null) and the shard was
   *  never called. */
  mode: FtsMode | null;
  /** False only on a genuine shard/transport failure — non-2xx, a network
   *  error, or a body that doesn't parse. That is a real infrastructure
   *  problem and callers MUST report it as one (e.g. `index_unreachable`).
   *  A legitimate zero-hit search still reports `ok: true` with `hits: []`
   *  — callers MUST NOT collapse that distinction (silent-zero-policy). */
  ok: boolean;
}

interface ShardStub {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/**
 * Query ONE shard stub with the ALL->ANY fallback: try an ALL-words match
 * first (the precise read of a short, deliberate query — "currency exchange
 * license fee"), and only retry with an OR-ranked ANY-word match when the
 * query has more than one word and the ALL attempt came back empty. A long
 * plain-language question ANDs every one of its words, including stopwords
 * like "what" or "does" that statute/opinion text is unlikely to contain
 * verbatim — that AND-of-a-sentence zero is not evidence the answer is
 * absent, it's the ALL mode being too strict for a sentence shaped input.
 * bm25's own idf weighting discounts a word that appears in nearly every
 * document, so the ANY retry needs no separate stopword list (same reasoning
 * search-shard.ts's own "NO STOPWORD LIST" note gives for not stripping
 * function words from the index itself).
 */
async function shardSearch(
  stub: ShardStub,
  text: string,
  limit: number,
  extraTerm?: string | null,
): Promise<FtsShardResult> {
  const runQuery = async (matchQuery: string): Promise<FtsHit[]> => {
    const res = await stub.fetch('https://shard/query', {
      method: 'POST',
      body: JSON.stringify({ q: matchQuery, limit }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`shard_http_${res.status}`);
    const out = (await res.json()) as { results?: FtsHit[] };
    return out.results ?? [];
  };

  const allQuery = ftsQuery(text, 'all', extraTerm);
  if (!allQuery) return { hits: [], mode: null, ok: true };

  try {
    let hits = await runQuery(allQuery);
    let mode: FtsMode = 'all';
    if (!hits.length && /\s/.test(text)) {
      const anyQuery = ftsQuery(text, 'any', extraTerm);
      if (anyQuery) {
        hits = await runQuery(anyQuery);
        mode = 'any';
      }
    }
    return { hits, mode, ok: true };
  } catch {
    return { hits: [], mode: null, ok: false };
  }
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Ohio Revised Code — state statutes by citation.
 *
 * The simplest URL of the four states: the citation IS the path.
 *
 *   codes.ohio.gov/ohio-revised-code/section-2903.02
 *
 * SILENT FAILURE, same as the rest: a nonexistent section returns HTTP 200
 * with the site chrome and no statute. Ohio's tell is clean — a real section
 * renders a `laws-body` container and a miss renders none. Verified both ways
 * (2903.02 has it, 2903.9999 does not) rather than assumed.
 *
 * STORED COPY (fleet #3546): the site answers US data centres and stalls or
 * refuses from Singapore (10 successes against 61 "down" from SG over 7 days),
 * so the Revised Code is also stored, one JSON object per chapter in the shared
 * statute store (R2 `statutes/oh/ch-<n>.json`; a chapter too large for one
 * object is a small head plus `ch-<n>.p<k>.json` parts), refreshed by
 * scripts/bake-chapters.mjs and published by scripts/upload-chapters.mjs. The
 * gateway hands the pack its R2 binding as `_r2` (manifest injectR2); the pack
 * reads only the object(s) a call names. A section in the stored copy is
 * answered with NO upstream fetch. Only a section the copy cannot answer
 * (chapter missing, object malformed, R2 unreadable, section listed without
 * stored text) falls back to the live path below. Nothing is evaluated at
 * module scope.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Ohio Revised Code');
}

const BASE = 'https://codes.ohio.gov/ohio-revised-code/section-';
const UA = 'pipeworx-mcp-ohio-code/1.0 (+https://pipeworx.io)';

function toText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|br|tr|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// -- stored copy (R2, injected as _r2) ---------------------------------------
interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
interface StoredSection { h: string | null; t: string; e?: string | null }
interface StoredHead {
  chapter: string;
  dataAsOf: string;
  toc: string[];
  sections?: Record<string, StoredSection>;
  parts?: number;
  partOf?: Record<string, number>;
}
interface StoredPart { sections: Record<string, StoredSection> }

// Per-isolate memo of parsed objects. Bounded and short-lived so a refresh of the stored copy reaches callers
// within MEMO_TTL_MS. ABSENCE IS NEVER MEMOISED: a missing object or a failed read is retried on the next call,
// so a chapter published later is not latched as missing.
const MEMO_MAX = 6;
const MEMO_TTL_MS = 10 * 60 * 1000;
const memo = new Map<string, { at: number; doc: unknown }>();

async function readStored<T>(r2: unknown, key: string, valid: (d: any) => boolean): Promise<T | null> {
  if (!r2 || typeof (r2 as R2Like).get !== 'function') return null;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.doc as T;
  try {
    const obj = await (r2 as R2Like).get(key);
    if (!obj) return null;
    const d = JSON.parse(await obj.text());
    if (!valid(d)) return null;
    memo.delete(key);
    memo.set(key, { at: Date.now(), doc: d });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return d as T;
  } catch {
    return null;
  }
}

type Stored = { head: StoredHead; hit: StoredSection | null };

/** The stored chapter head, plus this section's text when the copy has it. Null = go to the live path. */
async function storedSection(r2: unknown, chapter: string, section: string): Promise<Stored | null> {
  const head = await readStored<StoredHead>(r2, `statutes/oh/ch-${chapter}.json`,
    (d) => d && Array.isArray(d.toc) && typeof d.dataAsOf === 'string' && (d.sections || (typeof d.parts === 'number' && d.partOf)));
  if (!head) return null;
  if (head.sections) return { head, hit: head.sections[section] ?? null };
  const k = head.partOf?.[section];
  if (k === undefined) return { head, hit: null };
  const part = await readStored<StoredPart>(r2, `statutes/oh/ch-${chapter}.p${k}.json`, (d) => d && d.sections);
  if (!part) return null; // the part is unreadable: do not claim "not found", ask the source
  return { head, hit: part.sections[section] ?? null };
}

/**
 * What `text` contains, carried on every answer (fleet #3598). The stored copy is the
 * statute container only, with the effective date split out; the live read returned
 * everything after the container opened, so its text carried trailing page text.
 */
const TEXT_SCOPE_STORED =
  "Statute text only: the section body. The effective date is returned separately in effective_date_note; surrounding page text is NOT included.";
const TEXT_SCOPE_LIVE =
  "Text from the start of the statute container to the end of the source page; can include trailing page text that the stored copy leaves out.";

const tools: McpToolExport['tools'] = [
  {
    name: 'oh_revised_code',
    description:
      'Get the FULL TEXT of a section of the Ohio Revised Code — Ohio state statutes — by citation. "ORC 2903.02" is section 2903.02 (murder). Returns the statutory text (the section body only, with no surrounding page text) and its effective date as a separate field; `text_scope` says what a given answer contains. Keyless. Use for "what does Ohio Revised Code 2903.02 say", "text of ORC 4511.19", or to check an Ohio statute a case relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section as cited, e.g. "2903.02" or "4511.19". Title and chapter are encoded in the number.' },
      },
      required: ['section'],
    },
  },
  {
    name: 'oh_code_search',
    description:
      'Search the Ohio Revised Code BY TOPIC or keyword rather than by section number -- "EDGE certification minority business", "county competitive bidding threshold", "OVI penalties", "landlord security deposit". Covers all chapters of the Revised Code. Returns ranked sections with citation, heading and an opening excerpt; call oh_revised_code with a result\'s section for the full text. Full-text match, not semantic search. A query with no hits returns found:false. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "minority business enterprise certification".' },
        limit: { type: 'number', description: 'Max results, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

// -- topic search: FTS5 shard "oh-statutes" (loaded by scripts/ingest-ohio-statutes.mjs, fleet #3779) ------------
// A search hit is only an id and a score. The id IS the citation, so no second index has to be kept in step with the
// shard: id = chapter * 1e10 + Number("1" + <digits after the point>), the leading 1 keeping "02" distinct from "2".
// The heading and excerpt are read from the stored chapter the section reader already uses.
const ID_CHAPTER = 1e10;
export function sectionFromId(id: number): { chapter: string; section: string } | null {
  if (!Number.isSafeInteger(id) || id < ID_CHAPTER) return null;
  const chapter = Math.floor(id / ID_CHAPTER);
  const frac = String(id % ID_CHAPTER);
  if (frac.length < 2 || frac[0] !== '1') return null;
  return { chapter: String(chapter), section: `${chapter}.${frac.slice(1)}` };
}

async function ohCodeSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return { found: false, reason: 'empty_query',
      message: 'oh_code_search needs a query -- search by topic, e.g. "minority business certification".',
      hint: 'To look up a known section number use oh_revised_code instead.' };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const ns = args._searchShards as DurableObjectNamespace | undefined;
  if (!ns || !args._r2) {
    return { found: false, reason: 'search_unavailable',
      message: 'Topic search runs through Pipeworx\'s full-text index and is not available in a standalone install of this pack.',
      hint: 'oh_revised_code (section lookup) still works standalone.' };
  }
  // Over-fetch: a hit the stored copy cannot resolve is dropped below.
  const sr = await shardSearch(ns.get(ns.idFromName('oh-statutes')), q, Math.min(100, Math.max(limit * 3, 30)));
  if (!sr.ok) {
    return { found: false, reason: 'index_unreachable',
      message: 'The Ohio Revised Code search index did not answer. This is an infrastructure failure, not an absence of matching sections.' };
  }
  if (!sr.hits.length) {
    return { found: false, query: q,
      message: `No section matched "${q}" in the Ohio Revised Code index.`,
      hint: 'Try fewer or more general words -- this is a full-text match, not semantic search.' };
  }
  const cands = sr.hits
    .map((h) => ({ ref: sectionFromId(h.opinion_id), score: h.score }))
    .filter((c): c is { ref: { chapter: string; section: string }; score: number } => !!c.ref)
    .slice(0, limit * 2);
  const resolved = await Promise.all(cands.map(async (c) => ({ c, st: await storedSection(args._r2, c.ref.chapter, c.ref.section) })));
  const rows = resolved.filter((r) => r.st?.hit).slice(0, limit);
  if (!rows.length) {
    return { found: false, reason: 'index_unreachable',
      message: 'Search hits did not resolve against the stored Revised Code. This is an infrastructure failure, not an absence of matching sections.' };
  }
  return {
    found: true,
    query: q,
    match: sr.mode === 'any' ? 'any_word' : 'all_words',
    count: rows.length,
    results: rows.map(({ c, st }) => {
      const t = st!.hit!.t;
      return {
        citation: `Ohio Rev. Code \u00A7 ${c.ref.section}`,
        section: c.ref.section,
        chapter: c.ref.chapter,
        heading: st!.hit!.h ?? null,
        excerpt: t.length > 600 ? `${t.slice(0, 600).trimEnd()}...` : t,
        score: c.score,
      };
    }),
    data_as_of: rows.map((r) => r.st!.head.dataAsOf).sort().pop(),
    source: 'Ohio Legislative Service Commission, Ohio Revised Code (full-text search)',
    hint: 'Call oh_revised_code with the section from a result to get its full text.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'oh_code_search') return ohCodeSearch(args);
  if (name !== 'oh_revised_code') throw new Error(`Unknown tool: ${name}`);

  const typed = String(args.section ?? '').trim().replace(/\s+/g, '').replace(/^(?:ORC|R\.?C\.?)/i, '').replace(/^§/, '');
  // Canonical form: no leading zeros on the chapter number ("009.17" is section 9.17, in chapter 9). The store and
  // the source both key on "9.17"; the zero-padded spelling used to miss the stored chapter and reach a source that
  // refuses some data centres (fleet #3772). The part after the point keeps its zeros: 9.01 is not 9.1.
  const raw = typed.replace(/^0+(?=\d)/, '');
  if (!/^\d{1,5}(\.\d+)?$/.test(raw)) {
    return {
      found: false,
      reason: 'unparsed_section',
      message: `"${args.section}" is not an Ohio Revised Code citation.`,
      hint: 'Ohio sections look like "2903.02" (murder) or "4511.19" (OVI).',
    };
  }

  const url = `${BASE}${encodeURIComponent(raw)}`;

  // Stored copy first: no upstream fetch at all.
  const stored = await storedSection(args._r2, raw.split('.')[0], raw);
  if (stored) {
    const { head, hit } = stored;
    if (hit) {
      return {
        citation: `Ohio Rev. Code § ${raw}`,
        section: raw,
        heading: hit.h ?? null,
        text: hit.t,
        text_chars: hit.t.length,
        effective_date_note: hit.e ? `Effective: ${hit.e}` : null,
        url,
        source: 'Ohio Legislative Service Commission, Ohio Revised Code',
        attribution: 'Ohio statutes are public record.',
        text_scope: TEXT_SCOPE_STORED,
        served_from: 'stored-copy', stale: false, data_as_of: head.dataAsOf,
      };
    }
    if (!head.toc.includes(raw)) {
      return { found: false, reason: 'section_not_found', section: raw, data_as_of: head.dataAsOf,
        served_from: 'stored-copy',
        message: `No section ${raw} in the Ohio Revised Code (chapter ${head.chapter} as of ${head.dataAsOf}).`,
        hint: 'Section numbers are not contiguous — repealed sections are normal.' };
    }
    // Listed in the chapter but no text stored: ask the source.
  }

  const res = await pwFetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Ohio Laws returned HTTP ${res.status} for ${raw}`);
  const html = await res.text();

  // Structural: the statute container is present only on a real section.
  if (!html.includes('laws-body')) {
    return {
      found: false,
      reason: 'section_not_found',
      section: raw,
      message: `No section ${raw} in the Ohio Revised Code. The site returns a page for any section number, so this means it does not exist rather than that the request failed.`,
      hint: 'Section numbers are not contiguous — repealed sections are normal.',
    };
  }

  // Start past the container's closing '>' — slicing at the attribute leaves
  // 'laws-body">' as the first characters of the statute.
  const i = html.indexOf('laws-body');
  const text = toText(html.slice(html.indexOf('>', i) + 1));
  const effective = (text.match(/Effective[^\n]{0,80}/i) ?? [])[0];

  return {
    citation: `Ohio Rev. Code § ${raw}`,
    section: raw,
    text,
    text_chars: text.length,
    effective_date_note: effective ? effective.trim() : null,
    url,
    source: 'Ohio Laws (codes.ohio.gov), keyless',
    attribution: 'Ohio statutes are public record.',
    text_scope: TEXT_SCOPE_LIVE,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
