function arcPositionValue(mission) {
  return mission.arc_position ?? Number.MAX_SAFE_INTEGER;
}

function missionIdValue(mission) {
  return Number(mission.mission_id) || 0;
}

function branchSuffix(index) {
  if (index < 26) return String.fromCharCode(97 + index);
  return String(index + 1);
}

// Deterministic ordering for the legacy step view and branch-option badge labels:
// by arc depth, then ascending mission_id. (The DAG renderer derives column order
// from the explicit edge list instead, so no per-arc hardcoding is needed here.)
export function orderedArcMissions(missions) {
  return [...missions].sort((a, b) => {
    const positionDiff = arcPositionValue(a) - arcPositionValue(b);
    if (positionDiff !== 0) return positionDiff;
    return missionIdValue(a) - missionIdValue(b) || String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

export function arcMissionPositionLabels(missions) {
  const positionCounts = new Map();
  for (const mission of missions) {
    if (mission.arc_position == null) continue;
    positionCounts.set(mission.arc_position, (positionCounts.get(mission.arc_position) ?? 0) + 1);
  }

  const seenPositions = new Map();
  const labels = new Map();
  for (const mission of missions) {
    if (mission.arc_position == null) {
      labels.set(mission.mission_id, "-");
      continue;
    }

    const position = mission.arc_position;
    if ((positionCounts.get(position) ?? 0) < 2) {
      labels.set(mission.mission_id, String(position));
      continue;
    }

    const branchIndex = seenPositions.get(position) ?? 0;
    seenPositions.set(position, branchIndex + 1);
    labels.set(mission.mission_id, `${position}${branchSuffix(branchIndex)}`);
  }
  return labels;
}
