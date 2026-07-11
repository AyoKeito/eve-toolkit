import { compactMagnitude, isNoValue } from "./ui-model.js";

// Shared number/label formatting for the LP leaderboard. Pure: depends only on the
// Intl formatters and the ui-model value helpers — no DOM, no app state.
export const numericFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
export const ratioFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
export const pctFormat = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

export function isk(value) {
  if (isNoValue(value)) return "-";
  return numericFormat.format(value);
}

export function ratio(value) {
  if (isNoValue(value)) return "-";
  return ratioFormat.format(value);
}

export function compact(value) {
  if (isNoValue(value)) return "-";
  return compactMagnitude(value, ratio);
}

export function ageLabel(isoValue) {
  if (!isoValue) return "-";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "-";
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function refreshedLabel(isoValue) {
  const label = ageLabel(isoValue);
  return label === "-" ? "not refreshed" : `${label} ago`;
}
