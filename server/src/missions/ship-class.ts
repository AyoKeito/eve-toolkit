export function shipClassFromGroupName(groupName: string | null | undefined): string | null {
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

export function shipClassFromTypeName(typeName: string | null | undefined): string | null {
  const name = typeName ?? "";
  if (/archive|tower|sentry|battery|bunker|structure|container/i.test(name)) return "Structure";
  if (/gistii|frigate|rogue|thug|hunter/i.test(name)) return "Frigate";
  if (/gistum|cruiser/i.test(name)) return "Cruiser";
  if (/gistatis|battlecruiser/i.test(name)) return "Battlecruiser";
  if (/gist|cherubim|seraphim|throne|saint|nephilim/i.test(name)) return "Battleship";
  return null;
}

export function missionShipClass(
  typeName: string | null | undefined,
  groupName: string | null | undefined,
  existing: string | null | undefined
): string | null {
  return existing || shipClassFromGroupName(groupName) || shipClassFromTypeName(typeName);
}
