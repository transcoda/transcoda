#!/bin/sh
# Container entrypoint: drop root to PUID/PGID (linuxserver.io style), then exec the command.
# The server keeps only CAP_SETUID, CAP_SETGID and CAP_KILL (ambient) so it can start each
# plugin host as PLUGIN_UID:PLUGIN_GID through setpriv; ids are numeric, nothing is written
# under /etc (read-only rootfs). When plugin isolation is off (the run dir could not be prepared, or
# TRANSCODA_PLUGIN_ISOLATION=off) the server will never switch users and gets no capabilities at all.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-022}"
CONFIG_DIR="${TRANSCODA_CONFIG_DIR:-/config}"
TRANSCODE_DIR="${TRANSCODA_TRANSCODE_DIR:-/transcode}"
PLUGIN_UID="${PLUGIN_UID:-65001}"
PLUGIN_GID="${PLUGIN_GID:-65001}"
RUN_DIR="${TRANSCODA_PLUGIN_RUN_DIR:-/run/transcoda/plugins}"

log() {
  echo "transcoda-entrypoint: $*" >&2
}

umask "$UMASK"

# Started with --user: no privileges to switch users, so run as-is.
if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

# check_id <name> <value>: a plain decimal number within the signed 32-bit range (4294967295 is
# setpriv's "leave unchanged" sentinel and must never reach it).
check_id() {
  case "$2" in '' | *[!0-9]*) log "$1 must be a number, got '$2'"; exit 2 ;; esac
  if [ "${#2}" -gt 10 ] || [ "$2" -gt 2147483647 ]; then
    log "$1 out of range, got '$2'"
    exit 2
  fi
}
check_id PUID "$PUID"
check_id PGID "$PGID"
check_id PLUGIN_UID "$PLUGIN_UID"
check_id PLUGIN_GID "$PLUGIN_GID"
if [ "$PLUGIN_UID" -eq 0 ]; then log "PLUGIN_UID must not be 0"; exit 2; fi
if [ "$PLUGIN_GID" -eq 0 ]; then log "PLUGIN_GID must not be 0"; exit 2; fi
if [ "$PLUGIN_UID" -eq "$PUID" ]; then log "PLUGIN_UID must differ from PUID"; exit 2; fi
if [ "$PLUGIN_GID" -eq "$PGID" ]; then log "PLUGIN_GID must differ from PGID"; exit 2; fi

# Supplementary groups for hardware transcoding devices (VAAPI/QSV render nodes, Rockchip MPP).
groups=""
for dev in /dev/dri/* /dev/mpp_service; do
  [ -c "$dev" ] || continue
  gid="$(stat -c %g "$dev")"
  if [ "$gid" -eq 0 ]; then
    log "skipping $dev: owned by group root"
    continue
  fi
  case ",$groups," in
    *",$gid,"*) ;;
    *) groups="${groups:+$groups,}$gid" ;;
  esac
done

if [ -n "$groups" ]; then
  case ",$groups," in
    *",$PLUGIN_GID,"*) log "PLUGIN_GID must not be a device group"; exit 2 ;;
  esac
fi

mkdir -p "$CONFIG_DIR" "$TRANSCODE_DIR"
chown "$PUID:$PGID" "$CONFIG_DIR" "$TRANSCODE_DIR" || log "warning: could not chown $CONFIG_DIR or $TRANSCODE_DIR"
if [ "${TRANSCODA_CHOWN_CONFIG:-0}" = "1" ]; then
  chown -R "$PUID:$PGID" "$CONFIG_DIR" || log "warning: could not chown -R $CONFIG_DIR"
fi

# The plugin user must not reach the database, secret.key or the bundles' manifests.
chmod o-rwx "$CONFIG_DIR" "$TRANSCODE_DIR" || log "warning: could not chmod $CONFIG_DIR or $TRANSCODE_DIR"

# Staging dir for plugin bundles (a tmpfs in compose): the server writes, the plugin group reads.
# 2710 needs CAP_FSETID here, else the setgid bit is dropped silently.
isolated=1
if [ "${TRANSCODA_PLUGIN_ISOLATION:-}" = "off" ]; then
  isolated=0
  unset TRANSCODA_PLUGIN_UID TRANSCODA_PLUGIN_GID TRANSCODA_PLUGIN_RUN_DIR
elif mkdir -p "$RUN_DIR" 2>/dev/null && chown "$PUID:$PLUGIN_GID" "$RUN_DIR" && chmod 2710 "$RUN_DIR"; then
  export TRANSCODA_PLUGIN_UID="$PLUGIN_UID" TRANSCODA_PLUGIN_GID="$PLUGIN_GID" TRANSCODA_PLUGIN_RUN_DIR="$RUN_DIR"
else
  log "warning: could not prepare $RUN_DIR (mount a tmpfs at /run/transcoda); plugin isolation is off"
  isolated=0
  unset TRANSCODA_PLUGIN_UID TRANSCODA_PLUGIN_GID TRANSCODA_PLUGIN_RUN_DIR
fi

# setpriv keeps root's environment; there is no passwd entry for the service user.
export HOME="$CONFIG_DIR"

# Pass the groups explicitly: --init-groups looks the user up by uid, which picks the
# wrong account when PUID duplicates an existing uid.
if [ -n "$groups" ]; then
  group_opt="--groups=$groups"
else
  group_opt="--clear-groups"
fi
if [ "$isolated" -eq 1 ]; then
  exec setpriv --reuid="$PUID" --regid="$PGID" "$group_opt" \
    --bounding-set=-all,+setuid,+setgid,+kill \
    --inh-caps=-all,+setuid,+setgid,+kill \
    --ambient-caps=-all,+setuid,+setgid,+kill \
    --no-new-privs -- "$@"
fi
# Same uid, no capabilities: nothing for the server (or ffmpeg, or a plugin host) to inherit.
exec setpriv --reuid="$PUID" --regid="$PGID" "$group_opt" \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs -- "$@"
