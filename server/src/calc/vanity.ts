export interface VanityTypeInput {
  type_id?: number | null;
  name?: string | null;
  group_id?: number | null;
  group_name?: string | null;
  category_id?: number | null;
  category_name?: string | null;
}

const VANITY_CATEGORY_IDS = new Set([30, 91, 2118]);
const VANITY_CATEGORY_NAMES = new Set(["apparel", "skins", "personalization"]);
const VANITY_GROUP_IDS = new Set([
  1083,
  1084,
  1088,
  1089,
  1090,
  1091,
  1092,
  1271,
  1670,
  1950,
  1951,
  1952,
  1953,
  1954,
  1955,
  4040,
  4057,
  4471,
  4726,
  368726
]);

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function hasSkinToken(value: string | null | undefined): boolean {
  return /(^|[^a-z0-9])skins?([^a-z0-9]|$)/i.test(String(value ?? ""));
}

export function isVanityType(type: VanityTypeInput): boolean {
  if (type.category_id !== null && type.category_id !== undefined && VANITY_CATEGORY_IDS.has(type.category_id)) {
    return true;
  }
  if (VANITY_CATEGORY_NAMES.has(normalize(type.category_name))) {
    return true;
  }
  if (type.group_id !== null && type.group_id !== undefined && VANITY_GROUP_IDS.has(type.group_id)) {
    return true;
  }
  return hasSkinToken(type.group_name) || hasSkinToken(type.name);
}
