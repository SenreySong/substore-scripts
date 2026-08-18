const assert = require("assert");
const {
  normalizePolicyTag,
  findPolicyTagByNames,
  matchPolicyGroupTag,
  resolveStreamingTargets,
} = require("../sing-box/substore.js");

function testNormalizePolicyTag() {
  assert.strictEqual(normalizePolicyTag("💬Twitter"), "twitter");
  assert.strictEqual(normalizePolicyTag("🔍Google"), "google");
  assert.strictEqual(normalizePolicyTag("🤖AI"), "ai");
  assert.strictEqual(normalizePolicyTag("🤖OpenAI"), "openai");
  assert.strictEqual(normalizePolicyTag("𝕏Twitter"), "twitter");
  assert.strictEqual(normalizePolicyTag("✈️Telegram"), "telegram");
  assert.strictEqual(normalizePolicyTag("🍎Apple"), "apple");
  assert.strictEqual(normalizePolicyTag("💻Microsoft"), "microsoft");
  assert.strictEqual(normalizePolicyTag("🐙GitHub"), "github");
  assert.strictEqual(normalizePolicyTag("🎵Tiktok"), "tiktok");
  assert.strictEqual(normalizePolicyTag("TikTok"), "tiktok");
  assert.strictEqual(normalizePolicyTag("🎥Disney"), "disney");
  assert.strictEqual(normalizePolicyTag("国外流媒体"), "国外流媒体");
  assert.strictEqual(normalizePolicyTag("📺Streaming"), "streaming");
  assert.strictEqual(normalizePolicyTag("Amazon|Oracle"), "amazonoracle");
  assert.strictEqual(normalizePolicyTag("🌏️Main Proxy"), "mainproxy");
}

function testMatchMergesEmojiAndCase() {
  const existing = [
    "💬Twitter",
    "🔍Google",
    "🤖AI",
    "✈️Telegram",
    "🍎Apple",
    "💻Microsoft",
    "🎥Disney",
    "🎥Netflix",
  ];

  assert.strictEqual(
    matchPolicyGroupTag(existing, "Twitter", ["Twitter", "𝕏Twitter"]),
    "💬Twitter",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "Google", ["Google"]),
    "🔍Google",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "telegram", ["Telegram"]),
    "✈️Telegram",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "Microsoft", ["microsoft"]),
    "💻Microsoft",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "GitHub", ["Github", "🐙GitHub"]),
    "GitHub",
  );
}

function testOpenAIStaysIndependent() {
  const existing = ["🤖AI", "💬Twitter"];

  assert.strictEqual(
    matchPolicyGroupTag(existing, "OpenAI", ["OpenAI", "🤖OpenAI"]),
    "OpenAI",
  );
  assert.strictEqual(normalizePolicyTag("OpenAI"), "openai");
  assert.notStrictEqual(normalizePolicyTag("🤖AI"), normalizePolicyTag("OpenAI"));
  assert.strictEqual(
    findPolicyTagByNames(existing, ["OpenAI", "🤖OpenAI"]),
    "",
  );
  assert.strictEqual(
    matchPolicyGroupTag(["🤖OpenAI", "🤖AI"], "OpenAI", ["OpenAI", "🤖OpenAI"]),
    "🤖OpenAI",
  );
}

function testStreamingDroppedWhenTemplateCoversAll() {
  const plan = resolveStreamingTargets(
    ["🔍Google", "🎥Disney", "🎥Netflix", "🌸Bahamut"],
    "🔍Google",
  );

  assert.strictEqual(plan.needsStreamingGroup, false);
  assert.strictEqual(plan.youtube, "🔍Google");
  assert.strictEqual(plan.disney, "🎥Disney");
  assert.strictEqual(plan.streamingTag, "");
  assert.strictEqual(plan.existingStreamingTag, "");
}

function testStreamingKeptWhenDisneyMissing() {
  const plan = resolveStreamingTargets(["🔍Google", "🤖AI"], "🔍Google");

  assert.strictEqual(plan.needsStreamingGroup, true);
  assert.strictEqual(plan.youtube, "🔍Google");
  assert.strictEqual(plan.disney, "国外流媒体");
  assert.strictEqual(plan.streamingTag, "国外流媒体");
}

function testStreamingReusesExistingAndDedicatedYoutube() {
  const plan = resolveStreamingTargets(
    ["▶️YouTube", "📺Streaming"],
    "🔍Google",
  );

  assert.strictEqual(plan.needsStreamingGroup, true);
  assert.strictEqual(plan.youtube, "▶️YouTube");
  assert.strictEqual(plan.disney, "📺Streaming");
  assert.strictEqual(plan.existingStreamingTag, "📺Streaming");
  assert.strictEqual(plan.streamingTag, "📺Streaming");
}

function testUserTemplateLatestMerge() {
  const existing = [
    "🌏️Main Proxy",
    "🇨🇳China Services",
    "🍎Apple",
    "🔍Google",
    "💻Microsoft",
    "🤖AI",
    "💡Adobe",
    "🌸Bahamut",
    "📺Bilibili",
    "🎙️Discord",
    "🎥Disney",
    "🎥Netflix",
    "🎨Pixiv",
    "💬Reddit",
    "🎮Steam",
    "✈️Telegram",
    "💬Twitter",
  ];

  assert.strictEqual(
    matchPolicyGroupTag(existing, "Twitter", ["Twitter", "𝕏Twitter", "🐦Twitter"]),
    "💬Twitter",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "OpenAI", ["OpenAI", "🤖OpenAI"]),
    "OpenAI",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "AI", ["🤖AI", "AI"]),
    "🤖AI",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "Tiktok", ["Tiktok", "TikTok", "🎵Tiktok"]),
    "Tiktok",
  );
  assert.strictEqual(
    matchPolicyGroupTag(existing, "GitHub", ["GitHub", "Github", "🐙GitHub"]),
    "GitHub",
  );

  const plan = resolveStreamingTargets(existing, "🔍Google");
  assert.strictEqual(plan.needsStreamingGroup, false);
  assert.strictEqual(plan.youtube, "🔍Google");
  assert.strictEqual(plan.disney, "🎥Disney");
}

function testStreamingRemovesCatchallWhenCovered() {
  const plan = resolveStreamingTargets(
    ["🔍Google", "🎥Disney", "国外流媒体"],
    "🔍Google",
  );

  assert.strictEqual(plan.needsStreamingGroup, false);
  assert.strictEqual(plan.youtube, "🔍Google");
  assert.strictEqual(plan.disney, "🎥Disney");
  assert.strictEqual(plan.existingStreamingTag, "国外流媒体");
}

function main() {
  testNormalizePolicyTag();
  testMatchMergesEmojiAndCase();
  testOpenAIStaysIndependent();
  testStreamingDroppedWhenTemplateCoversAll();
  testStreamingKeptWhenDisneyMissing();
  testStreamingReusesExistingAndDedicatedYoutube();
  testUserTemplateLatestMerge();
  testStreamingRemovesCatchallWhenCovered();
  console.log("policy-group-merge: 8 组断言全部通过");
}

main();
