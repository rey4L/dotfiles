#!/usr/bin/env bash

set -u -o pipefail

external="HDMI-A-1"
internal="eDP-1"
internal_mode="highres@60"
internal_pos="0x0"
internal_scale="2"
external_mode="2560x1440@60"
external_pos="0x0"
external_scale="1"

runtime_dir="${XDG_RUNTIME_DIR:-/tmp}"
lock_file="${runtime_dir}/toggle-monitors.lock"
log_file="${HOME}/.cache/hyprland/toggle-monitors.log"
debug="${TOGGLE_MONITORS_DEBUG:-0}"

mkdir -p "${HOME}/.cache/hyprland"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*" >>"${log_file}"
  if [[ "${debug}" == "1" ]]; then
    printf '%s\n' "$*" >&2
  fi
}

notify() {
  local title="$1"
  local body="$2"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "${title}" "${body}"
  fi
}

run_batch() {
  local commands="$1"
  log "batch start: ${commands}"
  if hyprctl --quiet --batch "${commands}" >/dev/null 2>&1; then
    log "batch ok"
    return 0
  fi
  local rc=$?
  log "batch failed rc=${rc}"
  return "${rc}"
}

run_hyprctl() {
  log "hyprctl: $*"
  if hyprctl --quiet "$@" >/dev/null 2>&1; then
    log "hyprctl ok"
    return 0
  fi
  local rc=$?
  log "hyprctl failed rc=${rc}: $*"
  return "${rc}"
}

workspace_ids_on_monitor() {
  local monitor="$1"
  local workspaces
  if ! workspaces="$(hyprctl -j workspaces 2>/dev/null)"; then
    log "failed to query workspaces for migration"
    return 0
  fi

  jq -r --arg monitor "${monitor}" '
    .[]
    | select(.monitor == $monitor)
    | select((.id | type) == "number" and .id >= 0)
    | .id
  ' <<<"${workspaces}" 2>/dev/null
}

monitor_right_edge() {
  local monitor="$1"
  local monitors
  if ! monitors="$(hyprctl -j monitors 2>/dev/null)"; then
    log "failed to query monitors for transition position"
    return 1
  fi

  jq -r --arg monitor "${monitor}" '
    .[]
    | select(.name == $monitor)
    | ((.x // 0) + ((.width / .scale) | ceil))
  ' <<<"${monitors}" 2>/dev/null
}

move_workspaces_to_monitor() {
  local source="$1"
  local target="$2"
  local workspace_id
  local moved=0

  while IFS= read -r workspace_id; do
    [[ -z "${workspace_id}" ]] && continue
    if run_hyprctl dispatch moveworkspacetomonitor "${workspace_id}" "${target}"; then
      moved=$((moved + 1))
      sleep 0.05
    fi
  done < <(workspace_ids_on_monitor "${source}")

  log "workspace migration ${source}->${target} moved=${moved}"
}

apply_single_monitor_profile() {
  local target="$1"
  local target_mode="$2"
  local target_scale="$3"
  local source="$4"
  local transition_x

  transition_x="$(monitor_right_edge "${source}" || printf 'auto')"
  [[ -z "${transition_x}" ]] && transition_x="auto"

  run_hyprctl keyword monitor "${target},${target_mode},${transition_x}x0,${target_scale}" || return 1
  sleep 0.35

  run_hyprctl dispatch focusmonitor "${target}" || true
  move_workspaces_to_monitor "${source}" "${target}"
  sleep 0.15

  run_hyprctl dispatch focusmonitor "${target}" || true
  run_hyprctl keyword monitor "${source},disable" || return 1
  sleep 0.15

  run_hyprctl keyword monitor "${target},${target_mode},0x0,${target_scale}"
}

if ! exec 9>"${lock_file}"; then
  log "failed to open lock file: ${lock_file}"
  notify "Display profile" "Could not acquire toggle lock"
  exit 1
fi

if ! flock -n 9; then
  log "toggle skipped: lock busy"
  notify "Display profile" "Toggle already running"
  exit 0
fi

active_monitors="$(hyprctl monitors 2>/dev/null || true)"
all_monitors="$(hyprctl monitors all 2>/dev/null || printf '%s' "$active_monitors")"

if [[ -z "${active_monitors}" ]]; then
  log "failed to query active monitors"
  notify "Display profile" "Failed to query monitors"
  exit 1
fi

active_count="$(printf '%s\n' "${active_monitors}" | grep -c '^Monitor ' || true)"
external_active=0
external_connected=0
internal_active=0

if printf '%s\n' "${active_monitors}" | grep -q "^Monitor ${external} "; then
  external_active=1
fi

if printf '%s\n' "${all_monitors}" | grep -q "^Monitor ${external} "; then
  external_connected=1
fi

if printf '%s\n' "${active_monitors}" | grep -q "^Monitor ${internal} "; then
  internal_active=1
fi

log "state active_count=${active_count} internal_active=${internal_active} external_active=${external_active} external_connected=${external_connected}"

if [[ "${external_active}" == "1" ]]; then
  # Target: laptop only. Keep at least one output enabled and hand off workspaces first.
  if apply_single_monitor_profile "${internal}" "${internal_mode}" "${internal_scale}" "${external}"; then
    profile="Laptop only"
  else
    profile="Laptop toggle failed"
    notify "Display profile" "${profile}"
    exit 1
  fi
elif [[ "${external_connected}" == "1" ]]; then
  # Target: external only. Keep at least one output enabled and hand off workspaces first.
  if apply_single_monitor_profile "${external}" "${external_mode}" "${external_scale}" "${internal}"; then
    profile="External only"
  else
    # Safety fallback: if we only had one active output, force internal back up.
    if [[ "${active_count}" -le 1 ]]; then
      run_batch "keyword monitor ${internal},${internal_mode},${internal_pos},${internal_scale}" || true
    fi
    profile="External toggle failed"
    notify "Display profile" "${profile}"
    exit 1
  fi
elif [[ "${internal_active}" == "1" ]]; then
  # No-op: already in laptop-only with no external connector available.
  profile="Laptop only (external not connected)"
  log "no-op: ${profile}"
else
  # Recovery path if internal is unexpectedly disabled.
  if run_batch "keyword monitor ${internal},${internal_mode},${internal_pos},${internal_scale}"; then
    profile="Laptop only (external not connected)"
  else
    profile="Laptop recovery failed"
    notify "Display profile" "${profile}"
    exit 1
  fi
fi

log "profile applied: ${profile}"
notify "Display profile" "${profile}"

exit 0
