import { isPositiveFinite } from "./num.js";

export interface OrderLevel {
  price: number;
  qty: number;
  order_id?: number | null;
  location_id?: number | null;
  system_id?: number | null;
  is_jita44?: number | null;
}

export interface ConsumedOrder extends OrderLevel {
  consumed_qty: number;
  value: number;
  is_phantom?: true;
}

export interface WalkResult {
  requested_qty: number;
  filled_qty: number;
  missing_qty: number;
  total_value: number;
  avg_price: number;
  insufficient_depth: boolean;
  orders: ConsumedOrder[];
}

let loggedInvalidBookRow = false;

function logInvalidBookRow(): void {
  if (loggedInvalidBookRow) return;
  loggedInvalidBookRow = true;
  console.warn("Skipping invalid order book row during depth walk");
}

export function walkOrders(levels: OrderLevel[], requestedQty: number): WalkResult {
  const qty = isPositiveFinite(requestedQty) ? requestedQty : 0;
  let remaining = qty;
  let total = 0;
  const consumed: ConsumedOrder[] = [];

  for (const level of levels) {
    if (remaining <= 0) break;
    if (!isPositiveFinite(level.price) || !isPositiveFinite(level.qty)) {
      logInvalidBookRow();
      continue;
    }
    const take = Math.min(remaining, level.qty);
    if (take <= 0) continue;
    const value = take * level.price;
    total += value;
    remaining -= take;
    consumed.push({ ...level, consumed_qty: take, value });
  }

  let phantomValue = 0;
  if (remaining > 0 && consumed.length > 0) {
    const last = consumed[consumed.length - 1]!;
    if (!isPositiveFinite(last.price)) {
      logInvalidBookRow();
    } else {
      const value = remaining * last.price;
      phantomValue = value;
      total += value;
      consumed.push({
        price: last.price,
        qty: remaining,
        order_id: last.order_id,
        location_id: last.location_id,
        system_id: last.system_id,
        is_jita44: last.is_jita44,
        consumed_qty: remaining,
        value,
        is_phantom: true
      });
    }
  }

  const filledQty = qty - remaining;
  const realTotal = total - phantomValue;
  return {
    requested_qty: qty,
    filled_qty: filledQty,
    missing_qty: remaining,
    total_value: total,
    avg_price: filledQty > 0 ? realTotal / filledQty : 0,
    insufficient_depth: remaining > 0,
    orders: consumed
  };
}
