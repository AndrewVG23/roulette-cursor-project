#!/usr/bin/env bash
set -euo pipefail

# Creates the apex CNAME Cloudflare Pages needs for cashforcopper.us.
# Requires a Cloudflare API token with Zone > DNS > Edit for this zone.
# Create one at: https://dash.cloudflare.com/profile/api-tokens
# Template: "Edit zone DNS"

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN first}"
ZONE_ID="${CLOUDFLARE_ZONE_ID:-1f8dedbabf81c0ac4b067d56f11c1624}"
TARGET="${PAGES_TARGET:-cashforcopper.pages.dev}"
DOMAIN="${APEX_DOMAIN:-cashforcopper.us}"

api() {
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" "$@"
}

existing="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=CNAME&name=${DOMAIN}")"
record_id="$(python3 - <<PY
import json, sys
data = json.load(sys.stdin)
for r in data.get("result") or []:
    print(r["id"])
    break
PY
<<<"$existing")"

payload="$(cat <<JSON
{
  "type": "CNAME",
  "name": "${DOMAIN}",
  "content": "${TARGET}",
  "proxied": true,
  "ttl": 1
}
JSON
)"

if [[ -n "$record_id" ]]; then
  echo "Updating existing CNAME for ${DOMAIN}..."
  result="$(api -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${record_id}" -d "$payload")"
else
  echo "Creating CNAME for ${DOMAIN} -> ${TARGET}..."
  result="$(api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" -d "$payload")"
fi

python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
if not data.get("success"):
    raise SystemExit(f"DNS update failed: {data.get('errors')}")
r = data["result"]
print(f"OK: {r['type']} {r['name']} -> {r['content']} (proxied={r.get('proxied')})")
PY
<<<"$result"

echo "Waiting for DNS..."
for _ in $(seq 1 12); do
  if dig +short CNAME "${DOMAIN}" @1.1.1.1 | grep -q . || dig +short A "${DOMAIN}" @1.1.1.1 | grep -q .; then
    echo "DNS is resolving."
    break
  fi
  sleep 5
done

# www has no record today. Point it at the same Pages host.
WWW="www.${DOMAIN}"
www_existing="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=CNAME&name=${WWW}")"
www_id="$(python3 - <<PY
import json, sys
data = json.load(sys.stdin)
for r in data.get("result") or []:
    print(r["id"])
    break
PY
<<<"$www_existing")"

www_payload="$(cat <<JSON
{
  "type": "CNAME",
  "name": "${WWW}",
  "content": "${TARGET}",
  "proxied": true,
  "ttl": 1
}
JSON
)"

if [[ -n "$www_id" ]]; then
  echo "Updating existing CNAME for ${WWW}..."
  www_result="$(api -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${www_id}" -d "$www_payload")"
else
  echo "Creating CNAME for ${WWW} -> ${TARGET}..."
  www_result="$(api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" -d "$www_payload")"
fi

python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
if not data.get("success"):
    raise SystemExit(f"www DNS update failed: {data.get('errors')}")
r = data["result"]
print(f"OK: {r['type']} {r['name']} -> {r['content']} (proxied={r.get('proxied')})")
PY
<<<"$www_result"

echo "Add www.${DOMAIN} as a custom domain on the cashforcopper Pages project if it is not listed there yet."
