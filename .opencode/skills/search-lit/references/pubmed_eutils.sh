#!/bin/bash
# PubMed E-utilities CLI wrapper (+ Europe PMC fallback)
# Fallback when PubMed MCP server is unavailable
# Usage: bash pubmed_eutils.sh <command> <args...>
#
# NCBI commands (blocked from mainland China networks fairly often):
#   search <query> [retmax]       -- Search PubMed, return PMIDs
#   fetch <pmid1,pmid2,...>       -- Fetch article metadata (XML)
#   fetch_json <pmid1,pmid2,...>  -- Fetch article summary (JSON, DocSum)
#   related <pmid> [retmax]       -- Find related articles
#   cite_lookup <title>           -- Search by exact title to verify citation
#
# Europe PMC commands (ebi.ac.uk -- reachable from mainland China; use these
# when NCBI fails with SSL/timeout errors; results cover PubMed via SRC:MED):
#   epmc_search <query> [retmax]      -- Search Europe PMC, JSON records
#   epmc_cite_lookup <title>          -- Verify a citation by title
#   epmc_fetch <pmid1,pmid2,...>      -- Fetch records for PMIDs
#
# Environment:
#   NCBI_API_KEY  -- Optional. Increases NCBI rate limit from 3/sec to 10/sec.
#
# Rate limiting: NCBI 3 req/sec without key; Europe PMC be polite (~1 req/sec).
# This script sleeps 350ms between chained calls.

set -uo pipefail   # NOTE: no -e; _curl reports failures as JSON instead of aborting

BASE="https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
EPMC="https://www.ebi.ac.uk/europepmc/webservices/rest"
TOOL="claude-code-search-lit"
EMAIL="noreply@example.com"
DB="pubmed"
SLEEP=0.35

API_KEY_PARAM=""
if [ -n "${NCBI_API_KEY:-}" ]; then
  API_KEY_PARAM="&api_key=${NCBI_API_KEY}"
  SLEEP=0.1
fi

_sleep() { sleep "$SLEEP"; }

# _curl <url> [extra curl args...]
# Never lets set -e style aborts eat the error: on any failure prints a JSON
# error object to stdout and returns 1, so callers/parsers always get parseable output.
_curl() {
  local url="$1"; shift
  local out http_code body rc
  out=$(curl -sS -w '\n%{http_code}' -A "Mozilla/5.0 (${TOOL})" "$@" "$url" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    printf '{"error": "curl failed (exit %s): %s", "url": "%s"}\n' "$rc" "$(printf '%s' "$out" | tail -n1 | tr '"' "'")" "$url"
    return 1
  fi
  http_code=$(printf '%s' "$out" | tail -n1)
  body=$(printf '%s\n' "$out" | sed '$d')
  case "$http_code" in
    2*|3*) printf '%s\n' "$body"; return 0 ;;
    *) printf '{"error": "HTTP %s", "url": "%s"}\n' "$http_code" "$url"; return 1 ;;
  esac
}

# ---- NCBI ----

cmd_search() {
  local query="${1:?Usage: search <query> [retmax]}"
  local retmax="${2:-20}"
  # --data-urlencode does the escaping: no shell->python interpolation, so quotes,
  # $(), backticks etc. in the query are data, never code.
  _curl "${BASE}/esearch.fcgi" -G \
    --data-urlencode "db=${DB}" \
    --data-urlencode "term=${query}" \
    --data-urlencode "retmax=${retmax}" \
    --data-urlencode "retmode=json" \
    --data-urlencode "tool=${TOOL}" \
    --data-urlencode "email=${EMAIL}" \
    ${NCBI_API_KEY:+--data-urlencode "api_key=${NCBI_API_KEY}"}
}

cmd_fetch() {
  local ids="${1:?Usage: fetch <pmid1,pmid2,...>}"
  _curl "${BASE}/efetch.fcgi?db=${DB}&id=${ids}&rettype=xml&retmode=xml&tool=${TOOL}&email=${EMAIL}${API_KEY_PARAM}"
}

cmd_fetch_json() {
  local ids="${1:?Usage: fetch_json <pmid1,pmid2,...>}"
  _curl "${BASE}/esummary.fcgi?db=${DB}&id=${ids}&retmode=json&tool=${TOOL}&email=${EMAIL}${API_KEY_PARAM}"
}

cmd_related() {
  local pmid="${1:?Usage: related <pmid> [retmax]}"
  local retmax="${2:-10}"
  local result linked_ids
  result=$(_curl "${BASE}/elink.fcgi?dbfrom=${DB}&db=${DB}&id=${pmid}&cmd=neighbor_score&retmode=json&tool=${TOOL}&email=${EMAIL}${API_KEY_PARAM}") || { printf '%s\n' "$result"; return 1; }
  # retmax passed as argv, not interpolated into the python source
  linked_ids=$(printf '%s' "$result" | python3 -c "
import sys, json
retmax = int(sys.argv[1])
data = json.load(sys.stdin)
links = data.get('linksets', [{}])[0].get('linksetdbs', [{}])
for db in links:
    if db.get('linkname') == 'pubmed_pubmed':
        ids = [str(l['id']) for l in db.get('links', [])[:retmax]]
        print(','.join(ids))
        break
" "$retmax" 2>/dev/null || echo "")
  if [ -n "$linked_ids" ]; then
    _sleep
    cmd_fetch_json "$linked_ids"
  else
    echo '{"error": "No related articles found"}'
  fi
}

cmd_cite_lookup() {
  local title="${1:?Usage: cite_lookup <title>}"
  cmd_search "${title}[Title]" 5
}

# ---- Europe PMC (mainland-China reachable) ----

cmd_epmc_search() {
  local query="${1:?Usage: epmc_search <query> [retmax]}"
  local retmax="${2:-20}"
  _curl "${EPMC}/search" -G \
    --data-urlencode "query=${query}" \
    --data-urlencode "format=json" \
    --data-urlencode "pageSize=${retmax}" \
    --data-urlencode "resultType=core"
}

cmd_epmc_cite_lookup() {
  local title="${1:?Usage: epmc_cite_lookup <title>}"
  cmd_epmc_search "TITLE:\"${title}\"" 5
}

cmd_epmc_fetch() {
  local ids="${1:?Usage: epmc_fetch <pmid1,pmid2,...>}"
  local q
  q=$(printf '%s' "$ids" | tr ',' '\n' | sed 's/^/EXT_ID:/' | paste -sd' ' - | sed 's/ / OR /g')
  cmd_epmc_search "$q" 50
}

# Dispatch
case "${1:-help}" in
  search)           shift; cmd_search "$@" ;;
  fetch)            shift; cmd_fetch "$@" ;;
  fetch_json)       shift; cmd_fetch_json "$@" ;;
  related)          shift; cmd_related "$@" ;;
  cite_lookup)      shift; cmd_cite_lookup "$@" ;;
  epmc_search)      shift; cmd_epmc_search "$@" ;;
  epmc_cite_lookup) shift; cmd_epmc_cite_lookup "$@" ;;
  epmc_fetch)       shift; cmd_epmc_fetch "$@" ;;
  help|*)
    echo "Usage: bash pubmed_eutils.sh <command> <args...>"
    echo "NCBI:       search, fetch, fetch_json, related, cite_lookup"
    echo "Europe PMC: epmc_search, epmc_cite_lookup, epmc_fetch  (use when NCBI is blocked)"
    ;;
esac
