/// <reference lib="deno.ns" />
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculatePricing, NODE_TYPE_REGISTRY } from "./pricing.ts";

Deno.test("calculatePricing — owner runs are flagged as test_run with no rev share", () => {
  const result = calculatePricing(10, 4.0, true, 0);
  assertEquals(result.transaction_type, "test_run");
  assertEquals(result.rev_share_amount, 0);
  assertEquals(result.discount_applied, 0);
  assertEquals(result.deduction, 40); // 10 × 4 (no discount path for owner)
  assertEquals(result.raw_price, 40);
});

Deno.test("calculatePricing — consumer runs charge raw_price = ceil(base × markup)", () => {
  const result = calculatePricing(10, 4.0, false, 0);
  assertEquals(result.transaction_type, "consumer_run");
  assertEquals(result.raw_price, 40);
  assertEquals(result.deduction, 40);
});

Deno.test("calculatePricing — fractional cost is rounded UP via ceil", () => {
  // 7 × 1.4 = 9.8 → ceil = 10
  const result = calculatePricing(7, 1.4, false, 0);
  assertEquals(result.raw_price, 10);
  assertEquals(result.deduction, 10);
});

Deno.test("calculatePricing — 20% rev share is applied to (final - base) for consumer runs", () => {
  // base 10, markup 4 → raw 40, no discount → final 40
  // rev_share = floor((40 - 10) * 0.20) = 6
  const result = calculatePricing(10, 4.0, false, 0);
  assertEquals(result.rev_share_amount, 6);
});

Deno.test("calculatePricing — discount is floored to integer credits", () => {
  // base 10, markup 4 → raw 40
  // discount 25% → floor(40 * 0.25) = 10 → final = 30
  // rev_share = floor((30 - 10) * 0.20) = 4
  const result = calculatePricing(10, 4.0, false, 25);
  assertEquals(result.discount_percent, 25);
  assertEquals(result.discount_applied, 10);
  assertEquals(result.deduction, 30);
  assertEquals(result.rev_share_amount, 4);
});

Deno.test("calculatePricing — final deduction never drops below 1 credit", () => {
  // base 1, markup 1.0 → raw 1, discount 99% → floor(1 * 0.99) = 0 → final 1
  const result = calculatePricing(1, 1.0, false, 99);
  assertEquals(result.deduction, 1);
});

Deno.test("calculatePricing — rev_share_amount is clamped at 0 (never negative)", () => {
  // base 100, markup 1.0 → raw 100. Discount 90% → floor(100 * 0.9) = 90 → final 10
  // rev_share = floor((10 - 100) * 0.20) = -18 → clamped to 0
  const result = calculatePricing(100, 1.0, false, 90);
  assertEquals(result.rev_share_amount, 0);
});

Deno.test("NODE_TYPE_REGISTRY — every entry declares the four required fields", () => {
  for (const [key, def] of Object.entries(NODE_TYPE_REGISTRY)) {
    assert(def.provider, `${key} is missing provider`);
    assert(def.feature, `${key} is missing feature`);
    assert(def.output_type, `${key} is missing output_type`);
    assertEquals(typeof def.is_async, "boolean", `${key}.is_async must be boolean`);
  }
});

Deno.test("NODE_TYPE_REGISTRY — async flag matches provider category expectations", () => {
  // Video-producing nodes should always be async
  const videoNodes = Object.entries(NODE_TYPE_REGISTRY).filter(
    ([, def]) => def.output_type === "video_url",
  );
  assert(videoNodes.length > 0, "expected at least one video_url node in registry");
  for (const [key, def] of videoNodes) {
    assertEquals(def.is_async, true, `${key} produces video_url and should be async`);
  }
});

Deno.test("NODE_TYPE_REGISTRY — chat nodes return text and run synchronously", () => {
  const chat = NODE_TYPE_REGISTRY["chatAiNode"];
  assert(chat, "chatAiNode missing from registry");
  assertEquals(chat.output_type, "text");
  assertEquals(chat.is_async, false);
});

Deno.test("NODE_TYPE_REGISTRY — both video aliases share the same provider/feature", () => {
  const a = NODE_TYPE_REGISTRY["klingVideoNode"];
  const b = NODE_TYPE_REGISTRY["videoGenNode"];
  assert(a, "klingVideoNode missing");
  assert(b, "videoGenNode missing");
  assertEquals(a.provider, b.provider);
  assertEquals(a.feature, b.feature);
  assertEquals(a.output_type, b.output_type);
});
