#!/bin/sh
# Checks docker/entrypoint.sh. Runs as root inside the base image with the real setpriv:
#   docker run --rm --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
#     --cap-add FSETID --cap-add SETUID --cap-add SETGID --cap-add SETPCAP --cap-add KILL \
#     --security-opt no-new-privileges:true -v "$PWD/docker:/t:ro" \
#     -e TRANSCODA_CONFIG_DIR=/tmp/cfg -e TRANSCODA_TRANSCODE_DIR=/tmp/tc \
#     -e TRANSCODA_PLUGIN_RUN_DIR=/tmp/run node:24.22.1-bookworm-slim sh /t/entrypoint.test.sh
set -u

EP="${ENTRYPOINT_UNDER_TEST:-/t/entrypoint.sh}"
fails=0

ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }

# expect_contains <name> <haystack> <needle>
expect_contains() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1 (missing '$3')" ;;
  esac
}
expect_absent() {
  case "$2" in
    *"$3"*) bad "$1 (found '$3')" ;;
    *) ok "$1" ;;
  esac
}
expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi
}

DUMP='cat /proc/self/status; echo "--env"; env; echo "--id"; id'

# (a) (b) (e) (f) (g): the happy path as PUID=1234.
out="$(PUID=1234 PGID=1234 sh "$EP" sh -c "$DUMP; umask 027; touch \"\$TRANSCODA_PLUGIN_RUN_DIR/staged\"; echo \"--stagedgid \$(stat -c %g \"\$TRANSCODA_PLUGIN_RUN_DIR/staged\")\"" 2>&1)"
status_line() { printf '%s\n' "$out" | grep -E "^$1:" | head -n1 | tr -s '[:space:]' ' '; }
expect_eq "(a) uid" "$(status_line Uid | cut -d' ' -f2-3)" "1234 1234"
expect_eq "(a) gid" "$(status_line Gid | cut -d' ' -f2-3)" "1234 1234"
expect_eq "(a) no supplementary groups" "$(status_line Groups | sed 's/ *$//')" "Groups:"
for c in CapInh CapPrm CapEff CapBnd CapAmb; do
  expect_eq "(a) $c" "$(status_line $c | cut -d' ' -f2)" "00000000000000e0"
done
expect_eq "(a) NoNewPrivs" "$(status_line NoNewPrivs | cut -d' ' -f2)" "1"
expect_contains "(b) plugin uid" "$out" "TRANSCODA_PLUGIN_UID=65001"
expect_contains "(b) plugin gid" "$out" "TRANSCODA_PLUGIN_GID=65001"
expect_contains "(b) run dir" "$out" "TRANSCODA_PLUGIN_RUN_DIR=/tmp/run"
expect_eq "(e) run dir mode and owner" "$(stat -c '%a %u:%g' /tmp/run)" "2710 1234:65001"
expect_eq "(f) config dir has no other bits" "$(stat -c %A /tmp/cfg | cut -c8-10)" "---"
expect_eq "(f) transcode dir has no other bits" "$(stat -c %A /tmp/tc | cut -c8-10)" "---"
expect_contains "(g) file created in the run dir belongs to the plugin group" "$out" "--stagedgid 65001"

# (c) PLUGIN_UID equal to PUID.
out="$(PUID=1234 PGID=1234 PLUGIN_UID=1234 sh "$EP" true 2>&1)"; rc=$?
expect_eq "(c) exit code" "$rc" "2"
expect_contains "(c) message" "$out" "PLUGIN_UID must differ from PUID"

# (d) PLUGIN_UID not a number.
out="$(PUID=1234 PGID=1234 PLUGIN_UID=abc sh "$EP" true 2>&1)"; rc=$?
expect_eq "(d) exit code" "$rc" "2"
expect_contains "(d) message" "$out" "PLUGIN_UID must be a number, got 'abc'"

# Same checks for the group.
out="$(PUID=1234 PGID=1234 PLUGIN_GID=1234 sh "$EP" true 2>&1)"; rc=$?
expect_eq "(c') exit code" "$rc" "2"
expect_contains "(c') message" "$out" "PLUGIN_GID must differ from PGID"
out="$(PUID=1234 PGID=1234 PLUGIN_GID=x1 sh "$EP" true 2>&1)"; rc=$?
expect_eq "(d') exit code" "$rc" "2"
expect_contains "(d') message" "$out" "PLUGIN_GID must be a number, got 'x1'"

# Range and root checks on all four ids.
for v in 4294967295 99999999999999999999 2147483648; do
  for var in PUID PLUGIN_UID PGID PLUGIN_GID; do
    out="$(env PUID=1234 PGID=1234 "$var=$v" sh "$EP" true 2>&1)"; rc=$?
    expect_eq "range $var=$v exit code" "$rc" "2"
    expect_contains "range $var=$v message" "$out" "$var out of range, got '$v'"
  done
done
for var in PLUGIN_UID PLUGIN_GID; do
  out="$(env PUID=1234 PGID=1234 "$var=0" sh "$EP" true 2>&1)"; rc=$?
  expect_eq "$var=0 exit code" "$rc" "2"
  expect_contains "$var=0 message" "$out" "$var must not be 0"
done

# Not covered here: the device-group path (/dev/dri, /dev/mpp_service, PLUGIN_GID must not be a
# device group); it needs a hardware host.

# (h) an unusable run dir: the command still starts, the three variables are absent.
out="$(PUID=1234 PGID=1234 TRANSCODA_PLUGIN_RUN_DIR=/proc/none sh "$EP" sh -c 'env; echo started' 2>&1)"; rc=$?
expect_eq "(h) exit code" "$rc" "0"
expect_contains "(h) command started" "$out" "started"
expect_contains "(h) warning" "$out" "plugin isolation is off"
expect_absent "(h) no plugin uid" "$out" "TRANSCODA_PLUGIN_UID"
expect_absent "(h) no plugin gid" "$out" "TRANSCODA_PLUGIN_GID"
expect_absent "(h) no run dir" "$out" "TRANSCODA_PLUGIN_RUN_DIR"

# (i) the unpreparable run dir leaves the server without any capability, and with no-new-privs.
out="$(PUID=1234 PGID=1234 TRANSCODA_PLUGIN_RUN_DIR=/proc/none sh "$EP" sh -c 'cat /proc/self/status; id -u' 2>&1)"
for c in CapInh CapPrm CapEff CapBnd CapAmb; do
  expect_eq "(i) unpreparable run dir: $c" "$(status_line $c | cut -d' ' -f2)" "0000000000000000"
done
expect_eq "(i) NoNewPrivs" "$(status_line NoNewPrivs | cut -d' ' -f2)" "1"
expect_eq "(i) uid" "$(status_line Uid | cut -d' ' -f2-3)" "1234 1234"

# (j) TRANSCODA_PLUGIN_ISOLATION=off: no plugin variables, run dir untouched, no capabilities.
rm -rf /tmp/run-off
out="$(PUID=1234 PGID=1234 TRANSCODA_PLUGIN_ISOLATION=off TRANSCODA_PLUGIN_RUN_DIR=/tmp/run-off sh "$EP" sh -c "$DUMP" 2>&1)"; rc=$?
expect_eq "(j) exit code" "$rc" "0"
for c in CapInh CapPrm CapEff CapBnd CapAmb; do
  expect_eq "(j) off: $c" "$(status_line $c | cut -d' ' -f2)" "0000000000000000"
done
expect_eq "(j) off: NoNewPrivs" "$(status_line NoNewPrivs | cut -d' ' -f2)" "1"
expect_eq "(j) off: uid" "$(status_line Uid | cut -d' ' -f2-3)" "1234 1234"
expect_absent "(j) off: no plugin uid" "$out" "TRANSCODA_PLUGIN_UID"
expect_absent "(j) off: no plugin gid" "$out" "TRANSCODA_PLUGIN_GID"
expect_absent "(j) off: no run dir variable" "$out" "TRANSCODA_PLUGIN_RUN_DIR"
if [ -e /tmp/run-off ]; then bad "(j) off: run dir was created"; else ok "(j) off: run dir not created"; fi

# PUID=0 works too (CT 111 setup).
out="$(PUID=0 PGID=0 sh "$EP" sh -c "$DUMP" 2>&1)"
expect_eq "PUID=0: CapEff" "$(status_line CapEff | cut -d' ' -f2)" "00000000000000e0"
expect_contains "PUID=0: plugin uid" "$out" "TRANSCODA_PLUGIN_UID=65001"

# No passwd/group writes: the entrypoint must not add accounts.
if grep -q '^transcoda' /etc/passwd /etc/group; then bad "no useradd/groupadd"; else ok "no useradd/groupadd"; fi

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all entrypoint checks passed"
