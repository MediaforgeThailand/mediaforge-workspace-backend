/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyModelDiscountToCredits,
  lookupBaseCost,
  lookupModelDiscountPercent,
  PricingConfigError,
} from "./pricing.ts";

/**
 * Fake Supabase client that the pricing module's lookup functions can
 * call directly. The shape mirrors the actual chain
 *   supabase.from(table).select(...).eq(...).in(...)
 * and the await-able terminal returns a predetermined { data, error }.
 */
type Row = {
  cost: number;
  model: string | null;
  pricing_type?: string | null;
  discount_percent?: number | null;
};

interface FakeQueryConfig {
  feature?: string;
  keys?: string[];
  rows: Row[];
}

function makeFakeSupabase(rowsByFeature: Record<string, Row[]>) {
  // deno-lint-ignore no-explicit-any
  return {
    from(table: string) {
      const tableRows: Row[] = table === "credit_costs" ? [] : [];
      void tableRows;

      const filters: { feature?: string; in?: string[] } = {};
      const chain = {
        select(_cols: string) {
          return chain;
        },
        eq(col: string, val: string) {
          if (col === "feature") filters.feature = val;
          return chain;
        },
        in(col: string, vals: string[]) {
          if (col === "model") filters.in = vals;
          return chain;
        },
        then(onFulfilled: (v: unknown) => unknown) {
          const featureRows = rowsByFeature[filters.feature ?? ""] ?? [];
          const data = featureRows.filter((r) =>
            (filters.in ?? []).includes(r.model ?? "__no_model__"),
          );
          return Promise.resolve({ data, error: null }).then(onFulfilled);
        },
      };
      return chain;
      // deno-lint-ignore no-explicit-any
    },
  } as any;
}

function makeFakeSupabaseError(message: string) {
  // deno-lint-ignore no-explicit-any
  return {
    from() {
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        in() {
          return chain;
        },
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve({ data: null, error: { message } }).then(onFulfilled);
        },
      };
      return chain;
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

/* ── applyModelDiscountToCredits ── */

Deno.test("applyModelDiscountToCredits — returns full amount for 0% discount", () => {
  assertEquals(applyModelDiscountToCredits(100, 0), 100);
});

Deno.test("applyModelDiscountToCredits — applies discount and ceils", () => {
  // 100 × (1 - 0.20) = 80
  assertEquals(applyModelDiscountToCredits(100, 20), 80);
  // 51 × 0.50 = 25.5 → ceil → 26
  assertEquals(applyModelDiscountToCredits(51, 50), 26);
});

Deno.test("applyModelDiscountToCredits — never drops below 1 credit when source > 0", () => {
  assertEquals(applyModelDiscountToCredits(2, 99), 1);
  assertEquals(applyModelDiscountToCredits(1, 100), 1);
});

Deno.test("applyModelDiscountToCredits — passes 0 through when amount is 0", () => {
  assertEquals(applyModelDiscountToCredits(0, 50), 0);
});

Deno.test("applyModelDiscountToCredits — coerces non-finite/negative discount to 0", () => {
  assertEquals(applyModelDiscountToCredits(100, NaN), 100);
  assertEquals(applyModelDiscountToCredits(100, -10), 100);
  assertEquals(applyModelDiscountToCredits(100, Infinity), 100);
});

Deno.test("applyModelDiscountToCredits — clamps discount to [0, 100]", () => {
  // 250% would otherwise produce negative — must stay ≥ 1
  assertEquals(applyModelDiscountToCredits(100, 250), 1);
});

Deno.test("applyModelDiscountToCredits — coerces non-numeric amount to 0", () => {
  // Strings/null/etc. don't parse to numbers → 0
  assertEquals(
    applyModelDiscountToCredits(NaN as unknown as number, 50),
    0,
  );
});

/* ── lookupBaseCost — banana provider ── */

Deno.test("lookupBaseCost — banana matches generic model row", async () => {
  const supabase = makeFakeSupabase({
    generate_freepik_image: [{ model: "nano-banana-pro", cost: 4 }],
  });
  const cost = await lookupBaseCost(
    supabase,
    { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
    {},
  );
  assertEquals(cost, 4);
});

Deno.test("lookupBaseCost — banana prefers size-specific row", async () => {
  const supabase = makeFakeSupabase({
    generate_freepik_image: [
      { model: "nano-banana-pro:square_1_1", cost: 6 },
      { model: "nano-banana-pro", cost: 4 },
    ],
  });
  const cost = await lookupBaseCost(
    supabase,
    { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
    { image_size: "square_1_1" },
  );
  assertEquals(cost, 6);
});

Deno.test("lookupBaseCost — banana throws PricingConfigError on missing row", async () => {
  const supabase = makeFakeSupabase({ generate_freepik_image: [] });
  await assertRejects(
    () =>
      lookupBaseCost(
        supabase,
        { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
        { model_name: "unknown-model" },
      ),
    PricingConfigError,
    "Pricing configuration missing",
  );
});

/* ── lookupBaseCost — chat_ai ── */

Deno.test("lookupBaseCost — chat_ai matches by model_name", async () => {
  const supabase = makeFakeSupabase({
    chat_ai: [{ model: "google/gemini-3-pro-preview", cost: 2 }],
  });
  const cost = await lookupBaseCost(
    supabase,
    { provider: "chat_ai", feature: "chat_ai", output_type: "text", is_async: false },
    { model_name: "google/gemini-3-pro-preview" },
  );
  assertEquals(cost, 2);
});

Deno.test("lookupBaseCost — chat_ai falls back to default when model is omitted", async () => {
  const supabase = makeFakeSupabase({
    chat_ai: [{ model: "google/gemini-3-pro-preview", cost: 2 }],
  });
  const cost = await lookupBaseCost(
    supabase,
    { provider: "chat_ai", feature: "chat_ai", output_type: "text", is_async: false },
    {},
  );
  assertEquals(cost, 2);
});

/* ── lookupBaseCost — DB error surfaces as PricingConfigError ── */

Deno.test("lookupBaseCost — DB read error becomes PricingConfigError", async () => {
  const supabase = makeFakeSupabaseError("connection reset");
  await assertRejects(
    () =>
      lookupBaseCost(
        supabase,
        { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
        {},
      ),
    PricingConfigError,
    "Pricing read failed",
  );
});

/* ── lookupModelDiscountPercent ── */

Deno.test("lookupModelDiscountPercent — 0 for mp3_input (free passthrough)", async () => {
  // No supabase calls expected; pass empty fake
  const supabase = makeFakeSupabase({});
  const pct = await lookupModelDiscountPercent(
    supabase,
    { provider: "mp3_input", feature: "mp3_input", output_type: "audio_url", is_async: false },
    {},
  );
  assertEquals(pct, 0);
});

Deno.test("lookupModelDiscountPercent — picks the maximum discount across matching rows", async () => {
  const supabase = makeFakeSupabase({
    generate_freepik_image: [
      { model: "nano-banana-pro:square_1_1", cost: 6, discount_percent: 25 },
      { model: "nano-banana-pro", cost: 4, discount_percent: 10 },
    ],
  });
  const pct = await lookupModelDiscountPercent(
    supabase,
    { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
    { image_size: "square_1_1" },
  );
  assertEquals(pct, 25);
});

Deno.test("lookupModelDiscountPercent — returns 0 when no row carries a discount", async () => {
  const supabase = makeFakeSupabase({
    generate_freepik_image: [{ model: "nano-banana-pro", cost: 4 }],
  });
  const pct = await lookupModelDiscountPercent(
    supabase,
    { provider: "banana", feature: "generate_freepik_image", output_type: "image_url", is_async: false },
    {},
  );
  assertEquals(pct, 0);
});
