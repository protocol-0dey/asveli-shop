#!/usr/bin/env bash
# ASVELI — copy server data to Google Drive (or any rclone remote) before the OVH servers go away.
#
#   ./backup-to-gdrive.sh plan   /srv/data /var/lib/asveli        # count and size only: nothing is uploaded
#   ./backup-to-gdrive.sh run    /srv/data /var/lib/asveli        # upload; run it again after any stop
#   ./backup-to-gdrive.sh verify                                  # compare every uploaded part with its checksum
#
# How it works
#   * Every folder is cut into parts of about PART_GB (default 20) gigabytes. Each part is its own tar.zst archive,
#     so one part can be restored without the others, and a broken upload costs one part, not the whole run.
#   * SQLite databases are copied with sqlite3 .backup (a consistent copy even while the app writes);
#     PostgreSQL, if it runs here, with pg_dumpall. Live -wal/-shm files are skipped.
#   * Google Drive accepts about 750 GB a day per account. When the limit is hit, the script stops cleanly.
#     Run it again later (next day): finished parts are skipped, the run continues where it stopped.
#   * A part counts as done only after the MD5 that Google Drive reports equals the MD5 of the bytes we sent.
#
# Settings (environment): REMOTE (default gdrive:asveli-backup), PART_GB (20), ZSTD_LEVEL (3), WORK (/var/tmp/asveli-backup)
# Nothing is ever deleted on the server or on the remote by this script.
set -Eeuo pipefail

REMOTE="${REMOTE:-gdrive:asveli-backup}"
PART_GB="${PART_GB:-20}"
ZSTD_LEVEL="${ZSTD_LEVEL:-3}"
WORK="${WORK:-/var/tmp/asveli-backup}"
HOST="$(hostname -s 2>/dev/null || echo server)"
DEST="$REMOTE/$HOST"
STATE="$WORK/done.tsv"          # name <TAB> md5 <TAB> bytes  — one line per uploaded part
LOG="$WORK/backup.log"
PART_BYTES=$(( ${PART_MB:-$(( PART_GB * 1024 ))} * 1024 * 1024 ))   # PART_MB overrides (tests)
mkdir -p "$WORK/lists" "$WORK/db"
touch "$STATE"

say() { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG" >&2; }
die() { say "STOP: $*"; exit 1; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 B"; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing '$1'. Install: sudo apt-get install -y ${2:-$1}"; }
is_done() { grep -q -F "$1"$'\t' "$STATE"; }

# label for a source folder: /srv/data/x -> srv_data_x
label() { local s="${1#/}"; s="${s%/}"; s="${s//\//_}"; echo "${s:-root}"; }

check_tools() {
  need tar; need zstd; need md5sum coreutils; need find findutils; need numfmt coreutils
  if [ "${1:-}" = run ]; then
    need rclone "rclone   (newer: curl https://rclone.org/install.sh | sudo bash)"
    rclone lsf "$REMOTE" --max-depth 1 >/dev/null 2>&1 || rclone mkdir "$REMOTE" 2>/dev/null \
      || die "rclone cannot open '$REMOTE'. Set it up once with: rclone config  (new remote 'gdrive', type 'drive', scope 'drive'). See ops/BACKUP.md."
  fi
}

# Cut the file list of one folder into parts of about PART_BYTES. Lists are NUL-separated, paths relative to the folder.
make_lists() {
  local src="$1" name="$2" dir="$WORK/lists/$2"
  if [ -f "$dir/.complete" ]; then return; fi
  rm -rf "$dir"; mkdir -p "$dir"
  local n=1 acc=0 out size path
  out="$dir/$(printf 'part-%04d' "$n").list"; : > "$out"
  # skip live SQLite side files and database files (copied separately and consistently)
  while IFS=$'\t' read -r -d '' size path; do
    if [ "$acc" -gt 0 ] && [ $(( acc + size )) -gt "$PART_BYTES" ]; then
      n=$(( n + 1 )); acc=0; out="$dir/$(printf 'part-%04d' "$n").list"; : > "$out"
    fi
    printf '%s\0' "$path" >> "$out"; acc=$(( acc + size ))
  done < <(find "$src" -xdev \( -type f -o -type l \) \
             ! -name '*-wal' ! -name '*-shm' ! -name '*-journal' \
             ! -name '*.db' ! -name '*.sqlite' ! -name '*.sqlite3' \
             -printf '%s\t%P\0')
  touch "$dir/.complete"
}

# Stream stdin to the remote as one object; record it as done only if Drive's MD5 equals ours.
upload_stream() {
  local rel="$1" sumfile="$WORK/.md5.$$" bytesfile="$WORK/.bytes.$$" rc=0
  tee >(md5sum | cut -d' ' -f1 > "$sumfile") >(wc -c > "$bytesfile") \
    | rclone rcat "$DEST/$rel" --drive-stop-on-upload-limit --drive-chunk-size 128M --retries 5 --low-level-retries 20 \
        --log-file "$LOG" --log-level NOTICE || rc=$?
  sleep 1
  if [ "$rc" -ne 0 ]; then
    rm -f "$sumfile" "$bytesfile"
    if grep -q -i 'upload limit\|userRateLimitExceeded\|quota' "$LOG" 2>/dev/null && tail -n 50 "$LOG" | grep -q -i 'limit\|quota'; then
      die "Google Drive daily upload limit reached (about 750 GB/day). Run the same command again in 24 hours — finished parts are skipped."
    fi
    die "upload of $rel failed (rclone exit $rc). Look at $LOG, then run the same command again."
  fi
  local ours theirs bytes
  ours="$(cat "$sumfile")"; bytes="$(tr -d ' ' < "$bytesfile")"; rm -f "$sumfile" "$bytesfile"
  theirs="$(rclone md5sum "$DEST/$rel" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$theirs" ] && [ "$theirs" != "$ours" ] && die "checksum mismatch on $rel (ours $ours, drive $theirs). Run again: the part is uploaded anew."
  printf '%s\t%s\t%s\n' "$rel" "$ours" "$bytes" > "$WORK/.pending"
}

# Run "producer | upload_stream rel" and mark the part done only if every step succeeded.
# tar exit 1 means "some file changed while being read" (live data): the part is kept, the warning is in the log.
commit() {
  local rel="$1"; shift
  local -a st=("$@")
  local i
  for i in "${!st[@]}"; do
    if [ "${st[$i]}" -ne 0 ] && ! { [ "$i" -eq 0 ] && [ "${TAR_STEP:-0}" = 1 ] && [ "${st[$i]}" -eq 1 ]; }; then
      rm -f "$WORK/.pending"; die "making $rel failed (step $((i+1)) exit ${st[$i]}); the part is NOT marked done. Look at $LOG and run again."
    fi
  done
  [ -s "$WORK/.pending" ] || die "upload of $rel did not finish; run again."
  cat "$WORK/.pending" >> "$STATE"; rm -f "$WORK/.pending"
  say "ok  $rel  $(human "$(cut -f3 "$STATE" | tail -1)")"
}

backup_folder() {
  local src="$1" name; name="$(label "$src")"
  [ -d "$src" ] || die "not a folder: $src"
  say "folder $src  →  $DEST/$name/"
  make_lists "$src" "$name"
  local list part total; total=$(ls "$WORK/lists/$name"/part-*.list 2>/dev/null | wc -l)
  for list in "$WORK/lists/$name"/part-*.list; do
    part="$(basename "$list" .list)"
    local rel="$name/$part.tar.zst"
    if is_done "$rel"; then continue; fi
    [ -s "$list" ] || { printf '%s\t%s\t%s\n' "$rel" "-" 0 >> "$STATE"; continue; }
    say "upload $rel  ($part of $total)"
    set +e
    tar -C "$src" --no-recursion --null -T "$list" -cf - 2>> "$LOG" | zstd -q -T0 "-$ZSTD_LEVEL" | upload_stream "$rel"
    local -a st=("${PIPESTATUS[@]}"); set -e
    TAR_STEP=1 commit "$rel" "${st[@]}"
  done
  # the file lists travel with the data: they say which part holds which file
  local idx="$name/_index.tar.zst"
  if ! is_done "$idx"; then
    set +e; tar -C "$WORK/lists/$name" -cf - . | zstd -q -T0 -19 | upload_stream "$idx"; local -a st=("${PIPESTATUS[@]}"); set -e
    commit "$idx" "${st[@]}"
  fi
}

backup_databases() {
  local src db rel
  for src in "$@"; do
    while IFS= read -r -d '' db; do
      rel="_databases/$(label "$db").sqlite.zst"
      is_done "$rel" && continue
      command -v sqlite3 >/dev/null 2>&1 || die "found SQLite database $db but sqlite3 is missing: sudo apt-get install -y sqlite3"
      # SQLite magic header check: skip files that only look like databases by name
      head -c 16 "$db" 2>/dev/null | grep -q 'SQLite format 3' || continue
      say "database $db (consistent copy)"
      local snap="$WORK/db/$(label "$db").sqlite"
      sqlite3 "$db" ".timeout 60000" ".backup '$snap'" || die "sqlite3 .backup failed for $db"
      set +e; zstd -q -T0 "-$ZSTD_LEVEL" -c "$snap" | upload_stream "$rel"; local -a st=("${PIPESTATUS[@]}"); set -e
      commit "$rel" "${st[@]}"
      rm -f "$snap"
    done < <(find "$src" -xdev -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0)
  done
  if command -v pg_dumpall >/dev/null 2>&1 && pgrep -x postgres >/dev/null 2>&1; then
    rel="_databases/postgresql-all.sql.zst"
    if ! is_done "$rel"; then
      say "database PostgreSQL (pg_dumpall)"
      set +e; sudo -u postgres pg_dumpall | zstd -q -T0 "-$ZSTD_LEVEL" | upload_stream "$rel"; local -a st=("${PIPESTATUS[@]}"); set -e
      commit "$rel" "${st[@]}"
    fi
  fi
}

plan() {
  local src total=0 files=0 s f
  printf '%-40s %12s %14s\n' FOLDER FILES SIZE
  for src in "$@"; do
    [ -d "$src" ] || { echo "not a folder: $src"; continue; }
    read -r f s < <(find "$src" -xdev -type f -printf '%s\n' | awk '{n++; t+=$1} END {print n+0, t+0}')
    printf '%-40s %12s %14s\n' "$src" "$f" "$(human "$s")"
    total=$(( total + s )); files=$(( files + f ))
  done
  echo
  echo "Total: $files files, $(human "$total") before compression."
  echo "Parts of ${PART_GB} GB: about $(( total / PART_BYTES + 1 ))."
  echo "Google Drive takes about 750 GB a day: at least $(( total / (750*1000*1000*1000) + 1 )) day(s) without compression;"
  echo "zstd usually makes text, JSON, CSV and databases 2–5 times smaller, photos and video stay the same."
  echo "Free space for the work folder ($WORK): $(df -h --output=avail "$WORK" | tail -1 | tr -d ' ')"
  [ "$files" -gt 50000000 ] && echo "NOTE: more than 50 million files — making the part lists takes a while (this is normal)."
  return 0
}

verify() {
  check_tools run
  local bad=0 rel md5 bytes theirs
  while IFS=$'\t' read -r rel md5 bytes; do
    [ "$md5" = "-" ] && continue
    theirs="$(rclone md5sum "$DEST/$rel" 2>/dev/null | cut -d' ' -f1)"
    if [ "$theirs" = "$md5" ]; then echo "ok   $rel"; else echo "BAD  $rel  (expected $md5, drive '${theirs:-missing}')"; bad=$(( bad + 1 )); fi
  done < "$STATE"
  [ "$bad" -eq 0 ] && echo "All $(grep -c . "$STATE") parts match." || { echo "$bad part(s) differ: remove their lines from $STATE and run again."; exit 1; }
}

cmd="${1:-}"; shift || true
case "$cmd" in
  plan)   [ $# -gt 0 ] || die "give the folders to copy"; check_tools; plan "$@" ;;
  run)    [ $# -gt 0 ] || die "give the folders to copy"; check_tools run
          say "start  → $DEST  (parts ${PART_GB} GB, zstd -$ZSTD_LEVEL)"
          backup_databases "$@"
          for s in "$@"; do backup_folder "$s"; done
          rclone copyto "$STATE" "$DEST/_done.tsv" >/dev/null 2>&1 || true
          say "FINISHED: everything is on $DEST. Check with: $0 verify" ;;
  verify) verify ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
