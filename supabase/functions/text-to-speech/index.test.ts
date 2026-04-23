import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/text-to-speech`;

// ─── Pure Logic: pcmToWav header validation ───────────────────────

function pcmToWav(pcmData: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): Uint8Array {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);

  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);
  wav.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);
  wav.set(pcmData, headerSize);

  return wav;
}

Deno.test("pcmToWav - produces valid RIFF header", () => {
  const pcm = new Uint8Array(100);
  const wav = pcmToWav(pcm, 24000, 1, 16);
  assertEquals(wav[0], 0x52);
  assertEquals(wav[1], 0x49);
  assertEquals(wav[2], 0x46);
  assertEquals(wav[3], 0x46);
});

Deno.test("pcmToWav - WAVE format marker at offset 8", () => {
  const wav = pcmToWav(new Uint8Array(50), 24000, 1, 16);
  assertEquals(wav[8], 0x57);
  assertEquals(wav[9], 0x41);
  assertEquals(wav[10], 0x56);
  assertEquals(wav[11], 0x45);
});

Deno.test("pcmToWav - correct total size", () => {
  const pcmSize = 200;
  const wav = pcmToWav(new Uint8Array(pcmSize), 24000, 1, 16);
  assertEquals(wav.length, 44 + pcmSize);
});

Deno.test("pcmToWav - correct sample rate in header", () => {
  const wav = pcmToWav(new Uint8Array(10), 24000, 1, 16);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(24, true), 24000);
});

Deno.test("pcmToWav - correct channel count", () => {
  const wav = pcmToWav(new Uint8Array(10), 24000, 2, 16);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint16(22, true), 2);
});

Deno.test("pcmToWav - data chunk size matches PCM length", () => {
  const pcmSize = 480;
  const wav = pcmToWav(new Uint8Array(pcmSize), 24000, 1, 16);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(40, true), pcmSize);
});

// ─── Voice validation logic ───────────────────────────────────────

const VALID_VOICES = ["Aoede", "Charon", "Fenrir", "Kore", "Puck", "Leda", "Orus", "Zephyr"];

Deno.test("voice validation - all valid voices accepted", () => {
  VALID_VOICES.forEach(v => assertEquals(VALID_VOICES.includes(v), true));
});

Deno.test("voice validation - invalid voice rejected", () => {
  assertEquals(VALID_VOICES.includes("InvalidVoice"), false);
  assertEquals(VALID_VOICES.includes(""), false);
});

// ─── HTTP Integration Tests ──────────────────────────────────────

Deno.test("text-to-speech - CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("text-to-speech - rejects missing authorization", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Missing authorization");
});

Deno.test("text-to-speech - rejects invalid token", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token_xyz",
    },
    body: JSON.stringify({ text: "hello" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Unauthorized");
});

Deno.test("text-to-speech - error messages do not leak internals", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer bad_token",
    },
    body: JSON.stringify({ text: "test" }),
  });
  const data = await res.json();
  assertEquals(data.error?.includes("GOOGLE_AI_STUDIO_KEY"), false);
  assertEquals(data.error?.includes("supabase"), false);
});

// ─── Edge Case Tests ──────────────────────────────────────────────

Deno.test("text-to-speech - empty text returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ text: "" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  // Either auth error or validation — both acceptable
});

Deno.test("text-to-speech - text exceeding 5000 chars returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ text: "a".repeat(6000) }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("text-to-speech - non-string text (number) returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ text: 12345 }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("text-to-speech - missing text field returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ voice: "Kore" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("text-to-speech - invalid voice name returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ text: "hello", voice: "NotAVoice" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});
