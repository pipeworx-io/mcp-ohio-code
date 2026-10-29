# Ohio Code — Ohio Revised Code by citation

Give it `2903.02`, get back the murder statute; or search the whole Revised Code by topic. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Caveats

- **Fails silently upstream.** A nonexistent section returns HTTP 200 with the
  site chrome and no statute. On the live path the pack keys on the statute
  container, present on a real section and absent on a miss, so a miss is
  reported as `section_not_found`.
- Section numbers are not contiguous; repealed sections are normal (the stored
  copy lists exactly the sections the Revised Code currently carries).

## Tools

`oh_revised_code({section: "2903.02"})` → statutory text and effective date. A zero-padded
spelling (`009.17`) and an `ORC` prefix are read as the same citation as `9.17`.

`oh_code_search({query: "EDGE certification minority business", limit: 10})` → ranked sections
with citation, chapter, heading and an opening excerpt; pass a result's `section` to
`oh_revised_code` for the full text. It is a full-text match over the stored Revised Code,
not semantic search, so use the statute's own words. A query that matches nothing returns
`found:false`; an index that did not answer returns `reason: "index_unreachable"`, which
means the infrastructure failed, not that nothing matches.

## What `text` contains (fleet #3598)

`text` is the section body only, as the Ohio Legislative Service Commission publishes the
Revised Code. The effective date comes back separately in `effective_date_note`. The stored
copy is **cleaner** than the old live read, whose text ran on past the statute into the
surrounding page text; nothing from the law itself is missing. Every answer carries a
`text_scope` field: the stored copy (`served_from: "stored-copy"`) is the body alone, while
the live fallback returns text from the start of the statute container to the end of the
source page and can still carry trailing page text.

## Stored copy and `data_as_of` (fleet #3546)

The Ohio Laws site answers US data centres but stalls or refuses from Singapore: over 7 days external callers saw 10 successes against 61 "down" from there. A cache cannot help a first touch, so the Ohio Revised Code is stored, one JSON
object per chapter, in the shared statute store (R2, `statutes/oh/`) that the Illinois,
Indiana, North Carolina, Wisconsin and Wyoming packs also use. The gateway hands the
pack its R2 binding and the pack reads only the object a call names (a very large
chapter is a small head plus parts, and a call reads the head and one part). A section
found there is answered with no upstream request; the response says
`served_from: "stored-copy"` and carries `data_as_of` (when that chapter was last read
from the source). A section the copy cannot answer (chapter missing, object unreadable,
or listed with no stored text) falls back to the live read. Absence is never remembered:
a chapter published later is served as soon as it exists.

Nothing is loaded at module scope: the data never enters the gateway bundle.

## Refresh

```
node mcps/ohio-code/scripts/bake-chapters.mjs            # all chapters -> mcps/ohio-code/.bake/
node mcps/ohio-code/scripts/bake-chapters.mjs --only X   # one chapter
node mcps/ohio-code/scripts/bake-chapters.mjs --resume   # keep source pages already fetched
node mcps/ohio-code/scripts/upload-chapters.mjs          # publish to R2 (statutes/oh/), changed files only
```

The source is the Legislative Service Commission's Revised Code; a chapter page carries the text of all of its sections, so the refresh makes one request per chapter (about 1,000), not one per section. Sequential, with a delay between requests, an honest user agent, bounded
retries, and a stop on the first 429/403/451. Exit 0 only if every chapter was fetched
and parsed and the totals clear the floors (default 900 chapters, 15,000 sections with text); anything less exits 1 with the
counts. A chapter whose text is unchanged keeps its previous `data_as_of`. The baked
files are a working copy, not committed (`.bake/` is gitignored); `upload-chapters.mjs`
writes only the files whose content hash differs from the one recorded in
`statutes/oh/_manifest.json`, so a refresh that finds nothing new writes nothing. It
uses `wrangler r2 object put --remote` under the operator login; no API token.

## Topic search (fleet #3779)

The search index is built from the same baked chapters the section reader serves, so what is
searchable is exactly what `oh_revised_code` returns. It is one full-text index (shared search
shard `oh-statutes`, heading plus text per section). A hit is only an id and a score, so the id
encodes the citation and the heading and excerpt are read from the stored chapter; there is no
second index to keep in step. Load or refresh it after a bake:

```
node scripts/ingest-ohio-statutes.mjs      # reads mcps/ohio-code/.bake/, no new crawl
```

## Data source

Ohio Legislative Service Commission, Ohio Revised Code. Ohio statutes are public record.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ohio-code": {
      "url": "https://gateway.pipeworx.io/ohio-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ohio-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/oh_revised_code \
  -H 'Content-Type: application/json' \
  -d '{"section":"2903.02"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/oh_revised_code`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ohio-code` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ohio-code/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ohio-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ohio-code"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ohio Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
