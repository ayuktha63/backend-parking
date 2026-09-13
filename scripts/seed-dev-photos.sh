#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# DEVELOPMENT PHOTO SEED
#
# Uploads a photograph for each seeded parking area THROUGH THE REAL API, so the
# whole write path is exercised: owner auth → POST /owner/config/photos → magic
# byte validation → disk → parking_photos row → cover selection → the customer's
# discovery card.
#
# It does not touch the database directly. If this script works, the operator's
# in-app upload works, because it is the same endpoint.
#
# THE HONESTY BOUNDARY
#   These are stock photographs of real car parks, attached to FICTIONAL lots
#   that exist only in a local development database. That is the same thing an
#   operator does when they photograph their own facility — the row is real, the
#   file is real, the URL is real.
#
#   It is NOT a claim that any particular building is any particular lot, and
#   nothing here should ever run against a database with real parking areas in
#   it. The customer app renders whatever the server returns; keeping that
#   truthful is a matter of who uploads what, which is exactly why the upload
#   belongs to the operator.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

API="${API:-http://localhost:3939/api/v1}"
PHONE="${OWNER_PHONE:-9876500001}"
LOG="${SERVER_LOG:-/tmp/parqx-server.log}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "→ requesting OTP for $PHONE"
BEFORE=$(grep -c "OTP delivered to the log" "$LOG" 2>/dev/null || echo 0)
until [ "$(grep -c 'OTP delivered to the log' "$LOG" 2>/dev/null || echo 0)" -gt "$BEFORE" ]; do
  RESP=$(curl -sS -X POST "$API/auth/owner/otp/request" \
    -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}")
  echo "$RESP" | grep -q COOLDOWN && sleep 5 || true
  sleep 2
done

REQUEST_ID=$(echo "$RESP" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
CODE=$(grep "OTP delivered to the log" "$LOG" | tail -1 | sed -n 's/.*"code":"\([0-9]\{6\}\)".*/\1/p')
echo "→ verifying"
TOKEN=$(curl -sS -X POST "$API/auth/owner/otp/verify" \
  -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"otp\":\"$CODE\",\"request_id\":\"$REQUEST_ID\"}" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

[ -z "$TOKEN" ] && { echo "could not sign in"; exit 1; }
echo "→ signed in"

# Parking area → an Unsplash photograph matching the lot's character.
# Multi-storey, surface, basement, street-level: each lot gets an image that
# looks like the kind of place it is described as.
upload() {
  local area_id="$1" url="$2" caption="$3"
  local file="$WORK/$area_id.jpg"

  curl -sS -L --max-time 40 -o "$file" "$url" || { echo "  ✗ download failed"; return 0; }
  local bytes; bytes=$(wc -c < "$file" | tr -d ' ')
  [ "$bytes" -lt 2000 ] && { echo "  ✗ too small ($bytes bytes)"; return 0; }

  local out
  out=$(curl -sS -X POST "$API/owner/config/photos?parking_area_id=$area_id&caption=$(echo "$caption" | sed 's/ /%20/g')" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: image/jpeg' \
    --data-binary "@$file")

  if echo "$out" | grep -q '"url"'; then
    printf "  ✓ area %-3s %6s KB  %s\n" "$area_id" "$((bytes/1024))" "$caption"
  else
    printf "  ✗ area %-3s %s\n" "$area_id" "$out"
  fi
}

echo "→ uploading"
while IFS='|' read -r id url caption; do
  [ -z "$id" ] && continue
  upload "$id" "$url" "$caption"
done <<'PHOTOS'
1|https://images.unsplash.com/photo-1590674899484-d5640e854abe?w=1400&q=80|Covered parking level
49|https://images.unsplash.com/photo-1573348722427-f1d6819fdf98?w=1400&q=80|Multi-storey parkade
50|https://images.unsplash.com/photo-1545179605-1296651e9d43?w=1400&q=80|Metro station parking
51|https://images.unsplash.com/photo-1470224114660-3f6686c562eb?w=1400&q=80|Basement level
52|https://images.unsplash.com/photo-1506521781263-d8422e82f27a?w=1400&q=80|Surface parking bays
53|https://images.unsplash.com/photo-1519003722824-194d4455a60c?w=1400&q=80|Street level parking
54|https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?w=1400&q=80|Tech park parking
55|https://images.unsplash.com/photo-1597007029837-0b2b7eee6e1e?w=1400&q=80|Station yard
56|https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=1400&q=80|Layout parking
57|https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?w=1400&q=80|Park gate parking
PHOTOS

echo "→ done"
