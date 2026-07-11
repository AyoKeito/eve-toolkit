import type { Db } from "../db.js";
import { prepareCached } from "../lib/prepare-cache.js";

export interface MaterialLine {
  type_id: number;
  quantity: number;
}

export interface BlueprintRecipe {
  blueprint_type_id: number;
  product_type_id: number;
  runs: number;
  materials: MaterialLine[];
}

/** Null-safe runs coercion: any non-positive/absent value falls back to 1 run. */
function coerceRuns(n: number | null | undefined): number {
  return n && n > 0 ? n : 1;
}

/** Assemble a recipe from already-fetched product data and a materials list,
 * applying the shared runs coercion. Pure — shared with the snapshot bulk loader
 * so both recipe sources produce byte-identical records. */
export function buildRecipe(
  blueprintTypeId: number,
  productTypeId: number,
  runs: number | null | undefined,
  materials: MaterialLine[]
): BlueprintRecipe {
  return {
    blueprint_type_id: blueprintTypeId,
    product_type_id: productTypeId,
    runs: coerceRuns(runs),
    materials
  };
}

/** Build a recipe from a bp_manufacture row, parsing its `materials_json`
 * (malformed JSON falls back to an empty materials list). Pure. */
export function parseManufactureRow(row: {
  blueprint_type_id: number;
  product_type_id: number;
  runs: number;
  materials_json: string;
}): BlueprintRecipe {
  let materials: MaterialLine[];
  try {
    materials = JSON.parse(row.materials_json) as MaterialLine[];
  } catch {
    materials = [];
  }
  return buildRecipe(row.blueprint_type_id, row.product_type_id, row.runs, materials);
}

export function getBlueprintRecipe(db: Db, blueprintTypeId: number): BlueprintRecipe | null {
  const product = prepareCached(db, `
    SELECT blueprint_type_id, product_type_id, quantity AS runs
    FROM blueprint_products
    WHERE blueprint_type_id=?
    ORDER BY product_type_id
    LIMIT 1
  `).get(blueprintTypeId) as
    | { blueprint_type_id: number; product_type_id: number; runs: number }
    | undefined;
  if (product) {
    const materials = prepareCached(db, `
      SELECT material_type_id AS type_id, quantity
      FROM blueprint_materials
      WHERE blueprint_type_id=?
      ORDER BY material_type_id
    `).all(blueprintTypeId) as MaterialLine[];
    return buildRecipe(product.blueprint_type_id, product.product_type_id, product.runs, materials);
  }

  const row = prepareCached(db, `
    SELECT blueprint_type_id, product_type_id, runs, materials_json
    FROM bp_manufacture
    WHERE blueprint_type_id=?
  `).get(blueprintTypeId) as
    | { blueprint_type_id: number; product_type_id: number; runs: number; materials_json: string }
    | undefined;
  if (!row) return null;
  return parseManufactureRow(row);
}
