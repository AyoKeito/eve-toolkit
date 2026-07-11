// Mirrors server/src/missions/ship-class.ts — keep in sync with that file.

/**
 * Derive ship class from the SDE invGroups.groupName for an NPC type.
 * @param {string|null|undefined} groupName
 * @returns {string|null}
 */
export function shipClassFromGroupName(groupName) {
  const name = groupName ?? "";
  if (/frigate/i.test(name)) return "Frigate";
  if (/destroyer/i.test(name)) return "Destroyer";
  if (/battlecruiser/i.test(name)) return "Battlecruiser";
  if (/cruiser/i.test(name)) return "Cruiser";
  if (/battleship/i.test(name)) return "Battleship";
  if (/carrier/i.test(name)) return "Carrier";
  if (/dreadnought/i.test(name)) return "Dreadnought";
  if (/industrial/i.test(name)) return "Industrial";
  if (/sentry|battery|tower|bunker|structure|container/i.test(name)) return "Structure";
  return null;
}

/**
 * Derive ship class from the SDE invTypes.typeName as a fallback when the
 * group name is not diagnostic (e.g. generic "NPC" groups).
 * @param {string|null|undefined} typeName
 * @returns {string|null}
 */
export function shipClassFromTypeName(typeName) {
  const name = typeName ?? "";
  if (/archive|tower|sentry|battery|bunker|structure|container/i.test(name)) return "Structure";
  if (/gistii|frigate|rogue|thug|hunter/i.test(name)) return "Frigate";
  if (/gistum|cruiser/i.test(name)) return "Cruiser";
  if (/gistatis|battlecruiser/i.test(name)) return "Battlecruiser";
  if (/gist|cherubim|seraphim|throne|saint|nephilim/i.test(name)) return "Battleship";
  return null;
}

/**
 * Resolve the final ship class for an NPC, preferring any already-set value,
 * then group-name lookup, then type-name lookup.
 * @param {string|null|undefined} typeName
 * @param {string|null|undefined} groupName
 * @param {string|null|undefined} existing
 * @returns {string|null}
 */
export function missionShipClass(typeName, groupName, existing) {
  return existing || shipClassFromGroupName(groupName) || shipClassFromTypeName(typeName);
}
