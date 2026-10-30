async function operator(input, targetPlatform, context) {
  // collectionName 必填
  // Sub-Store 远程脚本传参格式（注意：多个参数用 &，不要写多个 #）：
  //   https://example.com/script.js#collectionName=VPS-ALL&noCache
  // 非 link 模式才使用前端参数表
  const args =
    typeof $arguments !== "undefined" &&
    typeof $arguments === "object" &&
    $arguments
      ? $arguments
      : {};

  const collectionName =
    args.collectionName ||
    args.collection ||
    args.col ||
    args.name ||
    "";
  const MAIN_PROXY_TAG = "🌏️Main Proxy";
  // 仅新加坡 + 美国优化节点参与测速，不改写规则集或面板下载配置。
  const AUTO_SELECT_TAG = "♾️Auto Select";
  const TEST_URL = "https://cp.cloudflare.com";
  // 逻辑名 → 实际 outbound tag（优先复用模板已有组）
  const appTagMap = {
    mainProxy: MAIN_PROXY_TAG,
    openai: "OpenAI",
    ai: "AI",
    tiktok: "Tiktok",
    twitter: "Twitter",
    telegram: "Telegram",
    google: "Google",
    amazonOracle: "Amazon|Oracle",
    apple: "Apple",
    spotify: "Spotify",
    microsoft: "Microsoft",
  };

  if (!collectionName) {
    const keys = Object.keys(args || {});
    throw new Error(
      "缺少 collectionName 参数。" +
        "远程脚本 URL 正确写法：.../substore.js#collectionName=VPS-ALL&noCache" +
        "（多个参数用 & 连接，不要写两个 #）。" +
        "也可在 Sub-Store 参数表填 collectionName。" +
        (keys.length ? ` 当前收到的参数键: ${keys.join(", ")}` : " 当前 $arguments 为空"),
    );
  }

  if (!input || input.$content == null) {
    throw new Error("这个脚本需要放在“文件”的脚本操作里");
  }

  const parser =
    typeof ProxyUtils !== "undefined" && ProxyUtils.JSON5
      ? ProxyUtils.JSON5
      : JSON;

  const config = parser.parse(input.$content);
  validateTemplate(config);

  if (!Array.isArray(config.outbounds)) {
    config.outbounds = [];
  }

  if (!Array.isArray(config.endpoints)) {
    config.endpoints = [];
  }

  if (!config.route || typeof config.route !== "object") {
    config.route = {};
  }

  if (!Array.isArray(config.route.rules)) {
    config.route.rules = [];
  }

  if (!Array.isArray(config.route.rule_set)) {
    config.route.rule_set = [];
  }

  // 订阅节点可能用 name 而不是 tag
  for (const outbound of config.outbounds) {
    if (outbound && !outbound.tag && outbound.name) {
      outbound.tag = String(outbound.name);
    }
  }

  // 尽早删掉空的 Auto Select，避免后续任何阶段带着 empty urltest
  // （样例里 Auto Select.outbounds=[] 会直接触发 missing tags）
  stripBrokenPolicyGroups(config);

  const originalGroups = config.outbounds.filter(isPolicyGroup);
  const originalGroupTags = new Set(
    originalGroups.map((item) => item && item.tag).filter(Boolean),
  );

  // 保留模板中的内置出站和常见策略组成员，不重命名直连出站。
  const preserveSet = new Set([
    "Direct",
    "Proxy",
    "PROXY",
    "proxy",
    "Reject",
    "REJECT",
    "reject",
    "Global",
    "GLOBAL",
    "COMPATIBLE",
  ]);

  const generated = await produceArtifact({
    type: "collection",
    name: collectionName,
    platform: "sing-box",
    produceOpts: {
      "include-unsupported-proxy": true,
    },
  });

  const data = JSON.parse(generated);
  const incomingOutbounds = Array.isArray(data.outbounds) ? data.outbounds : [];
  const incomingEndpoints = Array.isArray(data.endpoints) ? data.endpoints : [];

  // 仅适配订阅生成的旧拨号字段，不再对完整模板执行版本迁移。
  for (const nodes of [incomingOutbounds, incomingEndpoints]) {
    for (const node of nodes) normalizeIncomingNode(node);
  }

  const existingTags = new Set([
    ...config.outbounds.map((item) => item && item.tag).filter(Boolean),
    ...config.endpoints.map((item) => item && item.tag).filter(Boolean),
  ]);

  const addedOutbounds = [];
  const addedEndpoints = [];
  const incomingNodeTags = [];

  for (const outbound of incomingOutbounds) {
    if (!outbound || !outbound.tag) continue;
    // 跳过订阅里自带的空策略组 / 特殊出站，只收叶子代理
    if (isPolicyGroup(outbound)) continue;
    if (["direct", "block", "dns", "reject"].includes(String(outbound.type || "").toLowerCase())) {
      continue;
    }

    incomingNodeTags.push(outbound.tag);

    const existing = findOutboundByTag(outbound.tag);
    if (existing) {
      // 模板已有同名策略组时，不要跳过节点：给节点加后缀以免 collison
      if (isPolicyGroup(existing)) {
        let n = 1;
        let alt = `${outbound.tag}-node`;
        while (existingTags.has(alt)) {
          n += 1;
          alt = `${outbound.tag}-node${n}`;
        }
        outbound.tag = alt;
        incomingNodeTags[incomingNodeTags.length - 1] = alt;
      } else {
        // 同名叶子：用订阅覆盖模板占位
        const idx = config.outbounds.indexOf(existing);
        if (idx >= 0) config.outbounds[idx] = outbound;
        continue;
      }
    }

    existingTags.add(outbound.tag);
    addedOutbounds.push(outbound);
  }

  for (const endpoint of incomingEndpoints) {
    if (!endpoint || !endpoint.tag) continue;

    incomingNodeTags.push(endpoint.tag);

    if (existingTags.has(endpoint.tag)) continue;

    existingTags.add(endpoint.tag);
    addedEndpoints.push(endpoint);
  }

  // 先把节点写入 config，再建策略组，避免 selector 引用尚不存在的 tag
  config.outbounds.push(...addedOutbounds);
  config.endpoints.push(...addedEndpoints);

  const allNodeTags = collectAllNodeTags();
  const nodeTagSet = new Set(allNodeTags);
  const buckets = new Map();

  for (const tag of allNodeTags) {
    const info = getNodeGroupInfo(tag);
    if (!info) continue;

    if (!buckets.has(info.key)) {
      buckets.set(info.key, {
        info,
        nodeTags: [],
      });
    }

    buckets.get(info.key).nodeTags.push(tag);
  }

  for (const bucket of buckets.values()) {
    bucket.nodeTags = sortRegionNodeTags(bucket.nodeTags);
  }

  const generatedGroupTags = [];
  const usSubgroupTags = [];

  for (const { info, nodeTags } of buckets.values()) {
    if (!nodeTags.length) continue;

    const group = ensureNodeGroup(info, nodeTags);
    if (!group) continue;

    generatedGroupTags.push(group.tag);

    if (info.regionCode === "US" && info.usBucket) {
      usSubgroupTags.push(group.tag);
    }
  }

  ensureUSParentGroup(usSubgroupTags);

  const generatedGroupTagSet = new Set(generatedGroupTags);
  pruneStaleRegionShells(generatedGroupTagSet);
  const regionGroupTagsOrdered = orderRegionGroupTags(generatedGroupTags);

  // Auto Select：只挂新加坡 + 美国优化，下载用途由模板决定。
  const autoSelectGroup = ensureAutoSelectGroup();

  const managedAppGroupTags = ensureGfsAppGroups(
    regionGroupTagsOrdered,
    allNodeTags,
  );

  const generatedGroupTagSetAll = new Set([
    ...generatedGroupTagSet,
    ...managedAppGroupTags,
    ...(autoSelectGroup ? [AUTO_SELECT_TAG] : []),
  ]);

  // 已由 ensureGfsAppGroups / syncExtra / Auto Select 处理的组，避免二次灌入
  const legacySyncedTags = new Set([
    MAIN_PROXY_TAG,
    appTagMap.mainProxy,
    appTagMap.openai,
    appTagMap.ai,
    appTagMap.tiktok,
    appTagMap.twitter,
    appTagMap.telegram,
    appTagMap.google,
    appTagMap.amazonOracle,
    appTagMap.apple,
    appTagMap.spotify,
    appTagMap.microsoft,
    // GitHub 不再由脚本接管；模板已有组保持原有成员与规则关系。
    ...originalGroups
      .filter(
        (item) => item && normalizePolicyTag(item.tag) === "github",
      )
      .map((item) => item.tag),
    // Clash mode 由模板定义；保留其 GLOBAL/Global 组原有成员。
    ...originalGroups
      .filter(
        (item) => item && normalizePolicyTag(item.tag) === "global",
      )
      .map((item) => item.tag),
    "🇨🇳China Services",
    "🌸Bahamut",
    "📺Bilibili",
    "🎙️Discord",
    "🎨Pixiv",
    AUTO_SELECT_TAG,
    "全部节点",
  ]);

  for (const group of originalGroups) {
    if (!group) continue;
    if (!findOutboundByTag(group.tag)) continue;
    if (generatedGroupTagSetAll.has(group.tag)) continue;
    if (legacySyncedTags.has(group.tag)) continue;
    if (isUSParentTag(group.tag)) continue;
    if (isStaleRegionShellTag(group.tag)) continue;

    const preserved = [];

    for (const tag of group.outbounds || []) {
      if (shouldPreserveGroupMember(tag, generatedGroupTagSetAll)) {
        preserved.push(canonicalizeMemberTag(tag));
      }
    }

    // urltest 组填节点 tag；selector 组填地区策略组
    const replacements =
      group.type === "urltest" ? allNodeTags : regionGroupTagsOrdered;

    group.outbounds = uniqueList([...preserved, ...replacements]);
    syncSelectorDefault(group);
  }

  applyGfsRouteAndRulesets();

  // 所有组装和引用替换结束后，清理策略组成员并排序。
  removeUnusedAllNodesGroup();
  sanitizePolicyGroupMembers();
  reorderOutboundsPutRegionsFirst(regionGroupTagsOrdered);
  input.$content = JSON.stringify(config, null, 2);
  return input;

  // ─── 固定分组：赠送优先，其余按日/新/台/欧洲/美×3/Other 归组 ───

  function getUSSubgroupDefs() {
    return {
      opt: {
        key: "us-opt",
        groupName: "🇺🇸 美国优化策略组",
        aliases: [
          "🇺🇸 美国优化策略组",
          "美国优化策略组",
          "美国优化",
          "US-Optimized",
          "US-Opt",
        ],
      },
      direct: {
        key: "us-direct",
        groupName: "🇺🇸 美国落地策略组",
        aliases: [
          "🇺🇸 美国落地策略组",
          "美国落地策略组",
          "美国落地",
          // 旧名兼容，便于模板/缓存里仍写「直连」时能归并改名
          "🇺🇸 美国直连策略组",
          "美国直连策略组",
          "美国直连",
          "US-Direct",
          "US-Landing",
        ],
      },
      home: {
        key: "us-home",
        groupName: "🇺🇸 美国家宽策略组",
        aliases: [
          "🇺🇸 美国家宽策略组",
          "美国家宽策略组",
          "美国家宽",
          "US-Home",
          "US-家宽",
        ],
      },
    };
  }

  function getOtherGroupDef() {
    return {
      key: "other",
      groupName: "🌐 Other",
      aliases: ["🌐 Other", "🌐Other", "Other", "其它", "其他", "OTHER"],
      isOther: true,
    };
  }

  function getGiftGroupDef() {
    return {
      key: "gift",
      groupName: "🎁 赠送策略组",
      aliases: [
        "🎁 赠送策略组",
        "🎁赠送策略组",
        "赠送策略组",
        "赠送",
        "🇭🇰 赠送策略组",
      ],
    };
  }

  function getEuropeGroupDef() {
    return {
      key: "europe",
      groupName: "🇪🇺 欧洲策略组",
      aliases: [
        "🇪🇺 欧洲策略组",
        "🇪🇺欧洲策略组",
        "欧洲策略组",
        "欧洲",
        "Europe",
        "EU",
      ],
    };
  }

  function getFixedRegionDisplayDef(regionCode) {
    const code = String(regionCode || "").toUpperCase();
    const table = {
      JP: {
        groupName: "🇯🇵 日本策略组",
        aliases: ["🇯🇵 日本策略组", "日本策略组", "日本", "JP"],
      },
      SG: {
        groupName: "🇸🇬 新加坡策略组",
        aliases: ["🇸🇬 新加坡策略组", "新加坡策略组", "新加坡", "SG"],
      },
      TW: {
        groupName: "🇹🇼 台湾策略组",
        aliases: ["🇹🇼 台湾策略组", "台湾策略组", "台湾", "台灣", "TW"],
      },
    };

    return table[code] || null;
  }

  function isUSOptimizedName(name) {
    const s = String(name || "").toLowerCase();
    return /\bpro\b/.test(s) || /\beb\b/.test(s) || /megabox/.test(s);
  }

  function isUSHomeName(name) {
    return /home|家宽/i.test(String(name || ""));
  }

  function getUSBucket(name) {
    if (isUSOptimizedName(name)) return "opt";
    if (isUSHomeName(name)) return "home";
    return "direct";
  }

  function isUSParentTag(tag) {
    const raw = String(tag || "").trim();
    if (!raw) return false;

    const stripped = stripLeadingFlag(raw).trim();
    const upper = stripped.toUpperCase();

    if (upper === "US" || upper === "USA" || upper === "美国") return true;

    const flag = getFirstFlag(raw);
    if (flag === "🇺🇸" && (!stripped || upper === "US" || upper === "USA")) {
      return true;
    }

    return false;
  }

  function ensureUSParentGroup(subgroupTags) {
    if (!Array.isArray(subgroupTags) || subgroupTags.length === 0) return;

    const aliases = uniqueList([
      "US",
      "US",
      "🇺🇸 US",
      "🇺🇸US",
      "美国",
      "🇺🇸 美国",
    ]);

    let group = config.outbounds.find(
      (item) =>
        item && isPolicyGroup(item) && aliases.includes(String(item.tag || "")),
    );

    if (!group) return;

    const preserved = [];
    for (const tag of group.outbounds || []) {
      if (preserveSet.has(tag)) preserved.push(tag);
      if (
        originalGroupTags.has(tag) &&
        !isUSParentTag(tag) &&
        !subgroupTags.includes(tag) &&
        !getNodeGroupInfo(tag)
      ) {
        preserved.push(tag);
      }
    }

    group.outbounds = uniqueList([...preserved, ...subgroupTags]);
    if (group.type === "urltest") {
      group.url = TEST_URL;
    }
    syncSelectorDefault(group);
  }

  function orderRegionGroupTags(tags) {
    const preferred = [
      "🇯🇵 日本策略组",
      "🇸🇬 新加坡策略组",
      "🇹🇼 台湾策略组",
      "🇪🇺 欧洲策略组",
      "🇺🇸 美国优化策略组",
      "🇺🇸 美国落地策略组",
      "🇺🇸 美国家宽策略组",
      "🎁 赠送策略组",
      "🎁赠送策略组",
      "赠送策略组",
      "赠送",
      "🇭🇰 赠送策略组",
      "🌐 Other",
    ];

    const set = new Set(tags);
    const ordered = [];

    for (const tag of preferred) {
      if (set.has(tag)) {
        ordered.push(tag);
        set.delete(tag);
      }
    }

    const rest = [...set].sort((a, b) =>
      String(a).localeCompare(String(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    return [...ordered, ...rest];
  }

  function isStaleRegionShellTag(tag) {
    const raw = String(tag || "").trim();
    if (!raw) return false;

    // 模板旧地区短名 / 赠送组：无对应节点时清掉空壳
    if (/^[A-Z]{2}$/.test(raw)) return true;

    const staleNames = new Set([
      "美国优化",
      "美国落地",
      "美国直连",
      "美国家宽",
      "日本",
      "新加坡",
      "台湾",
      "德國",
      "德国",
      "🇩🇪德国策略组",
      "🇩🇪 德国策略组",
      "德国策略组",
      "香港",
      "🇭🇰 香港策略组",
      "香港策略组",
      "🎁 赠送策略组",
      "🎁赠送策略组",
      "赠送",
      "🇭🇰 赠送策略组",
      "赠送策略组",
    ]);

    return staleNames.has(raw);
  }

  function removeOutboundCompletely(tag) {
    if (!tag) return;

    config.outbounds = config.outbounds.filter(
      (item) => !(item && item.tag === tag),
    );
    existingTags.delete(tag);
    originalGroupTags.delete(tag);

    for (const outbound of config.outbounds) {
      if (!outbound || typeof outbound !== "object") continue;

      if (Array.isArray(outbound.outbounds)) {
        outbound.outbounds = outbound.outbounds.filter((item) => item !== tag);
        if (outbound.default === tag) {
          syncSelectorDefault(outbound);
        }
      }
    }

    for (const rule of config.route.rules) {
      if (rule && rule.outbound === tag) {
        rule.outbound = MAIN_PROXY_TAG;
      }
    }

    for (const server of Array.isArray(config.dns && config.dns.servers)
      ? config.dns.servers
      : []) {
      if (server && server.detour === tag) {
        server.detour = MAIN_PROXY_TAG;
      }
    }
  }

  function pruneStaleRegionShells(generatedSet) {
    const staleTags = config.outbounds
      .filter(
        (item) =>
          item &&
          isPolicyGroup(item) &&
          isStaleRegionShellTag(item.tag) &&
          !generatedSet.has(item.tag),
      )
      .map((item) => item.tag);

    for (const tag of staleTags) {
      removeOutboundCompletely(tag);
    }
  }

  function collectAllNodeTags() {
    const result = [];
    const seen = new Set();

    // 只收集真实存在的叶子节点 / endpoint，不把模板策略组里的「幽灵成员」当节点
    for (const tag of incomingNodeTags) {
      addNodeTag(tag);
    }

    for (const outbound of config.outbounds) {
      if (!outbound || !outbound.tag || isPolicyGroup(outbound)) continue;
      addNodeTag(outbound.tag);
    }

    for (const endpoint of config.endpoints) {
      if (!endpoint || !endpoint.tag) continue;
      addNodeTag(endpoint.tag);
    }

    return result;

    function addNodeTag(tag) {
      if (!tag || seen.has(tag)) return;
      // 必须是已存在的 outbound/endpoint（incoming 已 push 进 config）
      if (!existingTags.has(tag) && !findOutboundByTag(tag)) {
        const ep = (config.endpoints || []).some((e) => e && e.tag === tag);
        if (!ep) return;
      }
      if (!getNodeGroupInfo(tag)) return;

      seen.add(tag);
      result.push(tag);
    }
  }

  function shouldPreserveGroupMember(tag, generatedSet) {
    if (!tag || typeof tag !== "string") return false;

    // 保留模板使用的直连别名。
    if (isDirectAliasTag(tag)) return preserveSet.has("Direct");

    if (preserveSet.has(tag)) return true;

    if (originalGroupTags.has(tag) && !generatedSet.has(tag)) {
      return true;
    }

    if (generatedSet.has(tag)) {
      return false;
    }

    if (nodeTagSet.has(tag)) {
      return false;
    }

    if (getNodeGroupInfo(tag)) {
      return false;
    }

    return true;
  }

  function isPolicyGroup(outbound) {
    return (
      outbound &&
      Array.isArray(outbound.outbounds) &&
      ["selector", "urltest"].includes(outbound.type)
    );
  }

  function ensureNodeGroup(info, nodeTags) {
    const aliases = getGroupAliases(info);
    let group = config.outbounds.find(
      (item) =>
        item && isPolicyGroup(item) && aliases.includes(String(item.tag || "")),
    );

    const nextTag = resolveGroupTag(info, aliases);
    if (!nextTag) return null;

    // 只保留真实存在的叶子 tag
    const leafSet = new Set(
      config.outbounds
        .filter((item) => item && item.tag && !isPolicyGroup(item))
        .map((item) => item.tag),
    );
    for (const ep of config.endpoints || []) {
      if (ep && ep.tag) leafSet.add(ep.tag);
    }
    const safeNodes = uniqueList(
      (nodeTags || []).filter((t) => t && leafSet.has(t)),
    );
    if (!safeNodes.length) return null;

    if (group) {
      if (!Array.isArray(group.outbounds)) return null;

      if (group.tag !== nextTag) {
        renameOutboundTag(group.tag, nextTag);
      }

      group.type = "selector";
      group.outbounds = safeNodes;
      delete group.url;
      syncSelectorDefault(group);
      return group;
    }

    group = {
      type: "selector",
      tag: nextTag,
      outbounds: safeNodes,
    };

    syncSelectorDefault(group);

    config.outbounds.push(group);
    existingTags.add(group.tag);
    originalGroupTags.add(group.tag);

    return group;
  }

  function resolveGroupTag(info, aliases) {
    const preferred = info.groupName;

    // 优先保留模板已有短名（如 JP / 美国落地），避免改名导致其它组引用断裂
    for (const alias of aliases) {
      const existingGroup = config.outbounds.find(
        (item) => item && isPolicyGroup(item) && item.tag === alias,
      );
      if (existingGroup && existingGroup.tag) {
        return existingGroup.tag;
      }
    }

    if (!existingTags.has(preferred)) {
      return preferred;
    }

    for (const alias of aliases) {
      if (!existingTags.has(alias)) {
        return alias;
      }
    }

    return null;
  }

  function getGroupAliases(info) {
    const aliases = [];
    const baseTag = info.groupName;
    const regionCode = info.regionCode || normalizeCountryCode(info.groupName);

    aliases.push(baseTag);

    if (Array.isArray(info.extraAliases)) {
      for (const alias of info.extraAliases) {
        aliases.push(alias);
      }
    }

    if (regionCode && !info.isOther) {
      const flag = countryCodeToFlag(regionCode);
      if (flag) {
        aliases.push(`${flag} ${baseTag}`);
        aliases.push(`${flag}${baseTag}`);
        aliases.push(regionCode);
        aliases.push(`${flag} ${regionCode}`);
        aliases.push(`${flag}${regionCode}`);
      }
    }

    if (info.flag) {
      aliases.push(`${info.flag} ${baseTag}`);
      aliases.push(`${info.flag}${baseTag}`);
    }

    return uniqueList(aliases);
  }

  function renameOutboundTag(oldTag, newTag) {
    if (!oldTag || !newTag || oldTag === newTag) return;

    for (const outbound of config.outbounds) {
      if (!outbound || typeof outbound !== "object") continue;

      if (outbound.tag === oldTag) {
        outbound.tag = newTag;
      }

      if (Array.isArray(outbound.outbounds)) {
        outbound.outbounds = outbound.outbounds.map((tag) =>
          tag === oldTag ? newTag : tag,
        );
      }

      if (outbound.default === oldTag) {
        outbound.default = newTag;
      }
    }

    for (const rule of config.route.rules) {
      if (!rule || typeof rule !== "object") continue;
      if (rule.outbound === oldTag) {
        rule.outbound = newTag;
      }
    }

    for (const server of Array.isArray(config.dns && config.dns.servers)
      ? config.dns.servers
      : []) {
      if (server && server.detour === oldTag) {
        server.detour = newTag;
      }
    }

    existingTags.delete(oldTag);
    existingTags.add(newTag);

    if (originalGroupTags.has(oldTag)) {
      originalGroupTags.delete(oldTag);
      originalGroupTags.add(newTag);
    }
  }

  function syncSelectorDefault(group) {
    if (!group || group.type !== "selector") return;

    if (!Array.isArray(group.outbounds) || group.outbounds.length === 0) {
      delete group.default;
      return;
    }

    if (!group.default || !group.outbounds.includes(group.default)) {
      group.default = group.outbounds[0];
    }
  }

  function uniqueList(list) {
    const result = [];
    const seen = new Set();

    for (const item of list) {
      if (!item || seen.has(item)) continue;

      seen.add(item);
      result.push(item);
    }

    return result;
  }

  function findOutboundByTag(tag) {
    return config.outbounds.find((item) => item && item.tag === tag);
  }

  function isLeafProxyOutbound(outbound) {
    if (!outbound || !outbound.tag || typeof outbound !== "object") return false;
    if (isPolicyGroup(outbound)) return false;

    const type = String(outbound.type || "");
    if (
      [
        "direct",
        "block",
        "dns",
        "selector",
        "urltest",
        "tor",
        "ssh",
        "relay",
      ].includes(type)
    ) {
      return false;
    }

    return true;
  }

  function collectExistingLeafProxyTags() {
    const result = [];

    for (const outbound of config.outbounds) {
      if (!isLeafProxyOutbound(outbound)) continue;
      result.push(outbound.tag);
    }

    for (const endpoint of Array.isArray(config.endpoints)
      ? config.endpoints
      : []) {
      if (!endpoint || !endpoint.tag) continue;
      result.push(endpoint.tag);
    }

    return uniqueList(result);
  }

  // 收集 Auto Select 成员：仅新加坡 + 美国优化（不含赠送组与其它地区）
  function collectAutoSelectNodeTags() {
    const result = [];
    for (const tag of collectExistingLeafProxyTags()) {
      const info = getNodeGroupInfo(tag);
      if (!info || info.isOther) continue;
      if (info.regionCode === "SG") {
        result.push(tag);
        continue;
      }
      if (info.regionCode === "US" && info.usBucket === "opt") {
        result.push(tag);
      }
    }
    return uniqueList(result);
  }

  // 维护 ♾️Auto Select（urltest）：只挂 SG + 美国优化。
  function ensureAutoSelectGroup() {
    const members = collectAutoSelectNodeTags();
    if (!members.length) {
      // 没有可用节点则移除空组，避免 missing tags
      config.outbounds = config.outbounds.filter(
        (item) => !(item && item.tag === AUTO_SELECT_TAG),
      );
      existingTags.delete(AUTO_SELECT_TAG);
      originalGroupTags.delete(AUTO_SELECT_TAG);
      return null;
    }

    let group = findOutboundByTag(AUTO_SELECT_TAG);
    if (!group) {
      group = {
        type: "urltest",
        tag: AUTO_SELECT_TAG,
        outbounds: members,
        url: TEST_URL,
        interval: "3m",
        tolerance: 150,
      };
      config.outbounds.push(group);
      existingTags.add(AUTO_SELECT_TAG);
      originalGroupTags.add(AUTO_SELECT_TAG);
    } else {
      group.type = "urltest";
      group.outbounds = members;
      group.url = TEST_URL;
      if (!group.interval) group.interval = "3m";
      if (group.tolerance == null) group.tolerance = 150;
      delete group.default;
    }

    return group;
  }

  // 去掉无用的「全部节点」组，引用改写到 Main Proxy
  function removeUnusedAllNodesGroup() {
    const allNodes = findOutboundByTag("全部节点");
    if (!allNodes) return;

    const replacement = MAIN_PROXY_TAG;

    for (const outbound of config.outbounds) {
      if (!outbound || !Array.isArray(outbound.outbounds)) continue;
      outbound.outbounds = outbound.outbounds.map((tag) =>
        tag === "全部节点" ? replacement : tag,
      );
      if (outbound.default === "全部节点") {
        outbound.default = replacement;
      }
    }

    for (const rule of config.route.rules || []) {
      if (rule && rule.outbound === "全部节点") {
        rule.outbound = replacement;
      }
    }

    config.outbounds = config.outbounds.filter(
      (item) => !(item && item.tag === "全部节点"),
    );
    existingTags.delete("全部节点");
    originalGroupTags.delete("全部节点");
  }

  // 去掉策略组里不存在的 tag，防止 initialize outbound: missing tags
  function sanitizePolicyGroupMembers() {
    const available = new Set([
      ...config.outbounds.map((item) => item && item.tag).filter(Boolean),
      ...(Array.isArray(config.endpoints) ? config.endpoints : [])
        .map((item) => item && item.tag)
        .filter(Boolean),
    ]);

    for (const outbound of config.outbounds) {
      if (!isPolicyGroup(outbound)) continue;

      const next = [];
      for (const rawTag of outbound.outbounds || []) {
        if (typeof rawTag !== "string" || !rawTag) continue;
        const tag = canonicalizeMemberTag(rawTag);
        // Direct 统一后，可用集合里可能只有 Direct
        if (!available.has(tag)) continue;
        // 禁止自引用
        if (tag === outbound.tag) continue;
        // 业务策略组不挂 Auto Select / 全部节点（Auto 仅用于下载）
        if (tag === "全部节点") continue;
        if (tag === AUTO_SELECT_TAG && outbound.tag !== AUTO_SELECT_TAG) {
          continue;
        }
        next.push(tag);
      }

      // urltest/selector 不能为空
      if (!next.length) {
        if (outbound.tag === AUTO_SELECT_TAG) {
          // Auto 空了由 ensureAutoSelectGroup 处理，这里不塞 Direct 进 urltest
          continue;
        }
        if (available.has("Direct") && outbound.tag !== "Direct") {
          next.push("Direct");
        } else {
          // 从其它真实节点里随便塞一个，避免空组
          for (const t of available) {
            if (t && t !== outbound.tag && !isPolicyGroup(findOutboundByTag(t))) {
              next.push(t);
              break;
            }
          }
        }
      }

      outbound.outbounds = uniqueList(next);

      // default 也必须存在
      if (
        outbound.type === "selector" &&
        outbound.default &&
        !outbound.outbounds.includes(outbound.default)
      ) {
        delete outbound.default;
      }
      syncSelectorDefault(outbound);
    }
  }

  // 国家/地区策略组排在所有策略组最前面，节点 outbound 仍在后
  function reorderOutboundsPutRegionsFirst(regionTags) {
    const regionGroups = [];
    const otherGroups = [];
    const leaves = [];
    const used = new Set();

    for (const tag of regionTags || []) {
      const item = findOutboundByTag(tag);
      if (!item || used.has(item.tag)) continue;
      regionGroups.push(item);
      used.add(item.tag);
    }

    for (const item of config.outbounds) {
      if (!item || !item.tag || used.has(item.tag)) continue;
      if (isPolicyGroup(item)) {
        otherGroups.push(item);
      } else {
        leaves.push(item);
      }
      used.add(item.tag);
    }

    config.outbounds = [...regionGroups, ...otherGroups, ...leaves];
  }

  function ensureSelectorGroup(tag, members) {
    let group = findOutboundByTag(tag);
    if (!group) {
      group = {
        type: "selector",
        tag,
        outbounds: [],
      };
      config.outbounds.push(group);
      existingTags.add(tag);
      originalGroupTags.add(tag);
    } else if (!isPolicyGroup(group)) {
      return null;
    } else {
      group.type = "selector";
    }

    // 只写入当前已存在的 tag，杜绝 missing tags
    const available = new Set([
      ...config.outbounds.map((item) => item && item.tag).filter(Boolean),
      ...(config.endpoints || []).map((item) => item && item.tag).filter(Boolean),
    ]);
    const safeMembers = uniqueList(
      (members || [])
        .map((t) => canonicalizeMemberTag(t))
        .filter((t) => t && t !== tag && available.has(t)),
    );
    if (!safeMembers.length) {
      if (available.has("Direct") && tag !== "Direct") safeMembers.push("Direct");
    }
    group.outbounds = safeMembers;
    syncSelectorDefault(group);
    return group;
  }

  // 识别常见直连别名，但不改动模板出站。
  function isDirectAliasTag(tag) {
    return typeof tag === "string" && /^direct$/i.test(tag.trim());
  }

  function canonicalizeMemberTag(tag) {
    if (typeof tag !== "string") return tag;
    if (isDirectAliasTag(tag) && !findOutboundByTag(tag)) {
      const direct = config.outbounds.find(
        (outbound) => outbound && outbound.type === "direct",
      );
      return direct ? direct.tag : tag;
    }
    return tag;
  }

  function stripBrokenPolicyGroups(targetConfig) {
    if (!targetConfig || !Array.isArray(targetConfig.outbounds)) return;

    const AUTO = AUTO_SELECT_TAG;
    const available = () => new Set([
      ...targetConfig.outbounds.map((item) => item && item.tag).filter(Boolean),
      ...targetConfig.endpoints.map((item) => item && item.tag).filter(Boolean),
    ]);
    const removedTags = new Set();

    // 业务组不挂 Auto；Auto 自身成员保留。
    for (const outbound of targetConfig.outbounds) {
      if (!outbound || !Array.isArray(outbound.outbounds)) continue;
      if (outbound.tag === AUTO) continue;
      outbound.outbounds = outbound.outbounds.filter((t) => t && t !== AUTO);
      if (outbound.default === AUTO) delete outbound.default;
    }

    // 反复清：空组、全是无效成员的组
    let changed = true;
    while (changed) {
      changed = false;
      const tags = available();
      const nextOutbounds = [];
      for (const outbound of targetConfig.outbounds) {
        if (!outbound) continue;
        if (
          outbound.type === "selector" ||
          outbound.type === "urltest"
        ) {
          const members = uniqueList(
            (outbound.outbounds || []).filter(
              (t) => typeof t === "string" && t && t !== outbound.tag && tags.has(t),
            ),
          );
          if (!members.length) {
            // 空组及其引用在节点合并前一并处理。
            removedTags.add(outbound.tag);
            changed = true;
            continue;
          }
          outbound.outbounds = members;
          if (outbound.type === "urltest") {
            delete outbound.default;
          } else {
            if (outbound.default && !members.includes(outbound.default)) {
              outbound.default = members[0];
            }
            if (!outbound.default) {
              outbound.default = members[0];
            }
          }
        }
        nextOutbounds.push(outbound);
      }
      if (nextOutbounds.length !== targetConfig.outbounds.length) {
        changed = true;
      }
      targetConfig.outbounds = nextOutbounds;
    }

    // 只改写本次实际删除的组，不把未解析的配置错误静默掩盖为代理。
    const tags = available();
    const fallback = tags.has(MAIN_PROXY_TAG)
      ? MAIN_PROXY_TAG
      : tags.has("Direct")
        ? "Direct"
        : [...tags][0];

    function rewriteRemovedGroupRules(rules) {
      for (const rule of rules) {
        if (!rule || typeof rule !== "object") continue;
        if (removedTags.has(rule.outbound)) rule.outbound = fallback;
        if (Array.isArray(rule.rules)) rewriteRemovedGroupRules(rule.rules);
      }
    }
    rewriteRemovedGroupRules(targetConfig.route.rules);
    for (const server of (targetConfig.dns && targetConfig.dns.servers) || []) {
      if (server && removedTags.has(server.detour)) server.detour = fallback;
    }
  }

  // 优先复用模板已有策略组：先精确 tag，再去 emoji / 忽略大小写
  function resolveAppGroupTag(preferred, aliases = []) {
    const existing = config.outbounds
      .filter((item) => item && isPolicyGroup(item) && item.tag)
      .map((item) => item.tag);
    return matchPolicyGroupTag(existing, preferred, aliases);
  }

  function ensureResolvedAppGroup(key, preferred, aliases, members) {
    const tag = resolveAppGroupTag(preferred, aliases);
    appTagMap[key] = tag;

    const group = ensureSelectorGroup(tag, members, {
    });

    return group;
  }


  function ensureGfsAppGroups(regionTags, nodeTags) {
    const tags = new Set();
    const regions = uniqueList(regionTags);

    // 主选择器：仅地区组 + Direct（不挂 Auto Select，避免业务分流测速风暴）
    const mainProxyMembers = uniqueList([...regions, "Direct"]);
    const mainProxyGroup = ensureResolvedAppGroup(
      "mainProxy",
      MAIN_PROXY_TAG,
      [MAIN_PROXY_TAG, "Proxy", "PROXY"],
      mainProxyMembers,
    );
    if (mainProxyGroup) {
      tags.add(mainProxyGroup.tag);
      // 默认取策略组成员第一个（当前顺序：地区组 → Direct）
      if (
        Array.isArray(mainProxyGroup.outbounds) &&
        mainProxyGroup.outbounds.length > 0
      ) {
        mainProxyGroup.default = mainProxyGroup.outbounds[0];
      }
    }

    const mainTag = appTagMap.mainProxy || MAIN_PROXY_TAG;
    const regionPlusMain = uniqueList([...regions, mainTag]);

    const appDefs = [
      {
        key: "openai",
        preferred: "OpenAI",
        aliases: ["OpenAI", "🤖OpenAI"],
        members: regionPlusMain,
      },
      {
        key: "ai",
        preferred: "AI",
        aliases: ["🤖AI", "AI"],
        members: regionPlusMain,
      },
      {
        key: "tiktok",
        preferred: "Tiktok",
        aliases: ["Tiktok", "TikTok", "🎵Tiktok"],
        members: uniqueList([...regions, mainTag, ...nodeTags]),
      },
      {
        key: "twitter",
        preferred: "Twitter",
        aliases: ["Twitter", "𝕏Twitter", "🐦Twitter"],
        members: regionPlusMain,
      },
      {
        key: "telegram",
        preferred: "Telegram",
        aliases: ["✈️Telegram", "Telegram"],
        members: regionPlusMain,
      },
      {
        key: "google",
        preferred: "Google",
        aliases: ["🔍Google", "Google"],
        members: regionPlusMain,
      },
      {
        key: "amazonOracle",
        preferred: "Amazon|Oracle",
        aliases: ["Amazon|Oracle", "Amazon", "Oracle"],
        members: regionPlusMain,
      },
      {
        key: "apple",
        preferred: "Apple",
        aliases: ["🍎Apple", "Apple"],
        members: uniqueList([...regions, mainTag, "Direct"]),
      },
      {
        key: "spotify",
        preferred: "Spotify",
        aliases: ["Spotify", "🎵Spotify", "spotify"],
        members: regionPlusMain,
      },
      {
        key: "microsoft",
        preferred: "Microsoft",
        aliases: ["💻Microsoft", "Microsoft"],
        members: regionPlusMain,
      },
    ];

    for (const def of appDefs) {
      const group = ensureResolvedAppGroup(
        def.key,
        def.preferred,
        def.aliases,
        def.members,
      );
      if (group) tags.add(group.tag);
    }


    // 模板里有、但不在上述 GFS 映射中的应用组：只同步地区成员，不改名
    syncExtraTemplateGroups(regions, nodeTags, tags);

    return tags;
  }

  function syncExtraTemplateGroups(regions, nodeTags, alreadyManaged) {
    const extras = [
      "🇨🇳China Services",
      "🌸Bahamut",
      "📺Bilibili",
      "🎙️Discord",
      "🎨Pixiv",
    ];
    const existingGroupTags = config.outbounds
      .filter((item) => item && isPolicyGroup(item) && item.tag)
      .map((item) => item.tag);

    for (const extra of extras) {
      const tag = findPolicyTagByNames(existingGroupTags, [extra]);
      if (!tag || alreadyManaged.has(tag)) continue;

      const group = findOutboundByTag(tag);
      if (!group || !isPolicyGroup(group)) continue;

      const preserved = [];
      for (const member of group.outbounds || []) {
        if (shouldPreserveGroupMember(member, generatedGroupTagSet)) {
          if (
            !regions.includes(member) &&
            !nodeTagSet.has(member) &&
            member !== appTagMap.mainProxy &&
            member !== MAIN_PROXY_TAG
          ) {
            preserved.push(member);
          }
        }
      }

      if (group.type === "urltest") {
        group.outbounds = uniqueList(nodeTags);
        group.url = TEST_URL;
      } else {
        group.outbounds = uniqueList([
          ...preserved,
          ...regions,
          appTagMap.mainProxy || MAIN_PROXY_TAG,
        ]);
      }

      syncSelectorDefault(group);
      alreadyManaged.add(tag);
    }
  }

  // ─── 分流 / rule_set 智能合并（GFS → 远程 .srs） ───────────

  function getGfsRulesetDefs() {
    const geo = "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo";
    // 模板已自带 AD/AI/Apple/Google/Microsoft/Telegram/Netflix/Bahamut 等 -Site 规则集，
    // 脚本只注入模板没有的规则集（CN/广告等大类不再重复注入）
    return [
      { tag: "openai", url: `${geo}/geosite/openai.srs` },
      { tag: "spotify", url: `${geo}/geosite/spotify.srs` },
      { tag: "amazon", url: `${geo}/geosite/amazon.srs` },
      { tag: "oracle", url: `${geo}/geosite/oracle.srs` },
      { tag: "tiktok", url: `${geo}/geosite/tiktok.srs` },
      { tag: "twitter", url: `${geo}/geosite/twitter.srs` },
      { tag: "twitter-ip", url: `${geo}/geoip/twitter.srs` },
      {
        tag: "grok",
        url: "https://github.com/vernette/rulesets/raw/master/srs/grok.srs",
      },
    ];
  }

  function ensureRemoteRuleset(def) {
    let item = config.route.rule_set.find(
      (entry) => entry && entry.tag === def.tag,
    );

    if (!item) {
      item = { tag: def.tag };
      config.route.rule_set.push(item);
    }

    item.type = "remote";
    item.format = "binary";
    item.url = def.url;
    delete item.path;
    delete item.rules;
    return item;
  }

  function ruleSetList(rule) {
    if (!rule) return [];
    if (Array.isArray(rule.rule_set)) return rule.rule_set;
    if (typeof rule.rule_set === "string") return [rule.rule_set];
    return [];
  }

  function hasAnyRuleSet(rule, tags) {
    const set = new Set(ruleSetList(rule));
    return tags.some((tag) => set.has(tag));
  }

  function getManagedGfsRules() {
    const t = {
      openai: appTagMap.openai || "OpenAI",
      tiktok: appTagMap.tiktok || "Tiktok",
      twitter: appTagMap.twitter || "Twitter",
      amazonOracle: appTagMap.amazonOracle || "Amazon|Oracle",
      spotify: appTagMap.spotify || "Spotify",
    };

    return [
      {
        id: "gfs-twitter",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "twitter",
            "twitter-ip",
            "grok",
            "twitter-geosite.srs",
            "twitter-geoip.srs",
          ]),
        rule: {
          action: "route",
          rule_set: ["twitter", "twitter-ip", "grok"],
          outbound: t.twitter,
        },
      },
      {
        id: "gfs-openai",
        test: (rule) =>
          hasAnyRuleSet(rule, ["openai", "openai-geosite.json"]),
        rule: {
          action: "route",
          rule_set: ["openai"],
          outbound: t.openai,
        },
      },
      {
        id: "gfs-spotify",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "spotify",
            "spotify-geosite.srs",
            "spotify-geosite.json",
            "Spotify-Site",
          ]) || rule.outbound === t.spotify,
        rule: {
          action: "route",
          rule_set: ["spotify"],
          outbound: t.spotify,
        },
      },
      {
        id: "gfs-amazon-oracle",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "amazon",
            "oracle",
            "amazon-geosite.srs",
            "oracle-geosite.srs",
          ]),
        rule: {
          action: "route",
          rule_set: ["amazon", "oracle"],
          outbound: t.amazonOracle,
        },
      },
      {
        id: "gfs-tiktok",
        test: (rule) =>
          hasAnyRuleSet(rule, ["tiktok", "tiktok-geosite.json"]),
        rule: {
          action: "route",
          rule_set: ["tiktok"],
          outbound: t.tiktok,
        },
      },
    ];
  }

  function isLeadingTemplateControlRule(rule) {
    if (!rule || typeof rule !== "object") return false;

    if (rule.action === "hijack-dns" || rule.action === "sniff") return true;
    if (rule.protocol === "dns") return true;
    if (rule.ip_is_private === true) return true;
    if (rule.action === "reject") return true;

    const ports = Array.isArray(rule.port) ? rule.port : [rule.port];
    return ports.some((port) =>
      [25, 587, 465, 143, 993, 110, 995, 53].includes(port),
    );
  }

  function applyGfsRouteAndRulesets() {
    for (const def of getGfsRulesetDefs()) {
      ensureRemoteRuleset(def);
    }

    const managed = getManagedGfsRules();
    // 只替换脚本管理的应用分流，模板其它规则保持原有相对顺序。
    const templateRules = config.route.rules.filter(
      (rule) => !managed.some((item) => item.test(rule)),
    );
    const injectedRules = managed.map((item) => ({ ...item.rule }));

    // 保留模板开头连续的 DNS / 基础控制规则，应用分流插入其后。
    let insertAt = 0;
    while (
      insertAt < templateRules.length &&
      isLeadingTemplateControlRule(templateRules[insertAt])
    ) {
      insertAt += 1;
    }

    templateRules.splice(insertAt, 0, ...injectedRules);
    config.route.rules = templateRules;
  }

  function normalizeIncomingNode(node) {
    if (!node || typeof node !== "object") return;
    if (!node.tag && node.name) node.tag = String(node.name);

    const strategy = node.domain_strategy;
    delete node.domain_strategy;
    if (!strategy || strategy === "as_is" || node.detour) return;

    const resolver = node.domain_resolver || config.route.default_domain_resolver;
    if (!resolver) {
      throw new Error(`订阅节点 ${node.tag || node.name || "未命名"} 缺少域名解析器，无法迁移 domain_strategy`);
    }
    const options = typeof resolver === "string" ? { server: resolver } : resolver;
    node.domain_resolver = {
      ...options,
      strategy: (node.domain_resolver && options.strategy) || strategy,
    };
  }

  // 输入必须是已迁移的完整 1.15 模板；只校验脚本直接依赖的配置。
  function validateTemplate(template) {
    if (!template || typeof template !== "object" || Array.isArray(template)) {
      throw new Error("配置模板必须是 JSON 对象");
    }
  }

  function isReservedOutboundTag(tag) {
    const raw = String(tag || "").trim();
    if (!raw) return true;

    // 内置出站 / 常见保留名，禁止被地区前缀误识别（如 Direct → DE）
    if (
      /^(direct|block|reject|dns|proxy|global|compatible|pass|blackhole)$/i.test(
        raw,
      )
    ) {
      return true;
    }

    return false;
  }

  function getNodeGroupInfo(name) {
    const raw = String(name || "").trim();
    if (!raw) return null;
    if (isReservedOutboundTag(raw)) return null;

    const baseName = stripLeadingFlag(raw);

    // 赠送标记优先于国家/地区识别，名称任意位置含「赠」均进入赠送组。
    if (/赠/.test(raw)) {
      const gift = getGiftGroupDef();
      return {
        raw,
        flag: "🎁",
        baseName,
        regionCode: null,
        usBucket: null,
        groupName: gift.groupName,
        extraAliases: gift.aliases,
        key: gift.key,
        isOther: false,
      };
    }

    // 去掉方括号前缀后再识别地区。
    const regionCode = getRegionCode(baseName);

    if (regionCode && EUROPE_REGION_CODES.has(regionCode)) {
      const europe = getEuropeGroupDef();
      return {
        raw,
        flag: "🇪🇺",
        baseName,
        regionCode: "EU",
        usBucket: null,
        groupName: europe.groupName,
        extraAliases: europe.aliases,
        key: europe.key,
        isOther: false,
      };
    }

    // 固定国家和欧洲之外（含无法识别地区）一律 Other
    if (!regionCode || !FIXED_REGION_CODES.has(regionCode)) {
      const other = getOtherGroupDef();
      return {
        raw,
        flag: getFirstFlag(raw) || "🌐",
        baseName,
        regionCode: regionCode || null,
        usBucket: null,
        groupName: other.groupName,
        extraAliases: other.aliases,
        key: other.key,
        isOther: true,
      };
    }

    if (regionCode === "US") {
      const usBucket = getUSBucket(raw);
      const def = getUSSubgroupDefs()[usBucket];

      return {
        raw,
        flag: getFirstFlag(raw) || "🇺🇸",
        baseName,
        regionCode: "US",
        usBucket,
        groupName: def.groupName,
        extraAliases: def.aliases,
        key: def.key,
        isOther: false,
      };
    }

    const display = getFixedRegionDisplayDef(regionCode);
    if (!display) {
      const other = getOtherGroupDef();
      return {
        raw,
        flag: getFirstFlag(raw) || "🌐",
        baseName,
        regionCode,
        usBucket: null,
        groupName: other.groupName,
        extraAliases: other.aliases,
        key: other.key,
        isOther: true,
      };
    }

    return {
      raw,
      flag: getFirstFlag(raw) || countryCodeToFlag(regionCode),
      baseName,
      regionCode,
      usBucket: null,
      groupName: display.groupName,
      extraAliases: display.aliases,
      key: regionCode.toLowerCase(),
      isOther: false,
    };
  }

  function stripLeadingFlag(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";

    const flag = getFirstFlag(text);
    if (!flag) {
      return text;
    }

    const index = text.indexOf(flag);
    const stripped = text.slice(index + flag.length).trim();

    return stripped || text;
  }

  function getRegionCode(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;

    // 去掉方括号前缀后再识别地区
    const cleaned = text.replace(/^\[[^\]]*\]/g, "").trim();

    const firstPart = cleaned.split("-")[0];
    const fromFirst = extractCountryPrefix(firstPart);
    if (fromFirst) return fromFirst;

    return extractCountryPrefix(cleaned);
  }

  function sanitizeGroupName(part) {
    return String(part || "")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[(){}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractCountryPrefix(part) {
    const value = sanitizeGroupName(part);
    if (!value) return null;

    const match = value.match(/^[A-Za-z]+/);
    if (!match) return null;

    const lettersOnly = match[0].toUpperCase();
    return normalizeCountryCode(lettersOnly);
  }

  function normalizeCountryCode(rawCode) {
    const value = String(rawCode || "").toUpperCase();
    if (!value) return null;

    const mapped = COUNTRY_CODE_ALIASES[value] || value;
    if (!KNOWN_REGION_CODES.has(mapped)) return null;

    return mapped;
  }

  function getFirstFlag(raw) {
    const chars = [...String(raw || "")];

    for (let i = 0; i < chars.length - 1; i++) {
      const first = chars[i].codePointAt(0);
      const second = chars[i + 1].codePointAt(0);

      if (isRegionalIndicator(first) && isRegionalIndicator(second)) {
        return chars[i] + chars[i + 1];
      }
    }

    return null;
  }

  function isRegionalIndicator(codePoint) {
    return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
  }

  function countryCodeToFlag(code) {
    const normalized = String(code || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) {
      return "";
    }

    return [...normalized]
      .map((char) => String.fromCodePoint(char.charCodeAt(0) + 127397))
      .join("");
  }
}

const COUNTRY_CODE_ALIASES = {
  UK: "GB",
  USA: "US",
  JPN: "JP",
  AUS: "AU",
  DEU: "DE",
  HKG: "HK",
  TWN: "TW",
  MAC: "MO",
  KOR: "KR",
  SGP: "SG",
};

// 联合国 M49 的欧洲主权国家；统一合并为欧洲策略组。
const EUROPE_REGION_CODES = new Set([
  "AD",
  "AL",
  "AT",
  "BA",
  "BE",
  "BG",
  "BY",
  "CH",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MC",
  "MD",
  "ME",
  "MK",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "RU",
  "SE",
  "SI",
  "SK",
  "SM",
  "UA",
  "VA",
]);

// 仅这些国家单独建组；欧洲统一进欧洲组，香港及其余全部进 Other
const FIXED_REGION_CODES = new Set(["JP", "SG", "TW", "US"]);

// 策略组名归一：去掉国旗 / emoji / 装饰字母，只留字母数字与中文，再转小写
function normalizePolicyTag(tag) {
  return String(tag || "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0F\u200D\u20E3]/g, "")
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function findPolicyTagByNames(existingTags, names) {
  const list = Array.isArray(existingTags) ? existingTags.filter(Boolean) : [];
  const rawNames = (names || []).filter(Boolean);

  for (const name of rawNames) {
    if (list.includes(name)) return name;
  }

  const wanted = new Set(rawNames.map(normalizePolicyTag).filter(Boolean));
  if (!wanted.size) return "";

  for (const tag of list) {
    if (wanted.has(normalizePolicyTag(tag))) return tag;
  }

  return "";
}

function matchPolicyGroupTag(existingTags, preferred, aliases) {
  const found = findPolicyTagByNames(existingTags, [
    preferred,
    ...(Array.isArray(aliases) ? aliases : []),
  ]);
  return found || preferred;
}

// ─── 地区组内节点排序（大小写不敏感） ─────────────────────────
// 优先级：
// 1) 含「赠」的最后
// 2) 地区码后首段为 DL/V6，或后续独立段为 DL/V6 的靠前
// 3) 机场/机房代码（地区后首个非线路/非供应商段）按字符序
// 4) 供应商：DMIT → Megabox/BWH（等同）→ Lightlayer → 其它
// 5) 全名自然序（同名带序号 01/02…）
function sortRegionNodeTags(nodeTags) {
  const list = Array.isArray(nodeTags) ? [...nodeTags] : [];
  list.sort(compareRegionNodeTags);
  return list;
}

function compareRegionNodeTags(a, b) {
  const ka = buildRegionNodeSortKey(a);
  const kb = buildRegionNodeSortKey(b);

  if (ka.gift !== kb.gift) return ka.gift - kb.gift;
  if (ka.dlV6 !== kb.dlV6) return ka.dlV6 - kb.dlV6;
  if (ka.airport !== kb.airport) {
    return ka.airport.localeCompare(kb.airport, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
  if (ka.provider !== kb.provider) return ka.provider - kb.provider;

  return ka.nameKey.localeCompare(kb.nameKey, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function buildRegionNodeSortKey(raw) {
  const text = String(raw || "").trim();
  const gift = /赠/.test(text) ? 1 : 0;
  const cleaned = normalizeNodeNameForSort(text);
  // 方括号内的连字符不拆（如 [E-DMIT] / [DMIT-P]）
  const parts = splitNodeNameParts(cleaned);
  const afterRegion = parts.length > 1 ? parts.slice(1) : parts.slice();

  const dlV6 = hasDlOrV6Priority(afterRegion) ? 0 : 1;
  const airport = extractAirportCodeForSort(afterRegion);
  const provider = getProviderSortRank(cleaned);
  const nameKey = cleaned.toLowerCase();

  return { gift, dlV6, airport, provider, nameKey };
}

function normalizeNodeNameForSort(raw) {
  let s = String(raw || "").trim();
  // [赠] / 赠送 标记
  s = s.replace(/\[赠\]/gi, " ");
  s = s.replace(/赠送?/g, " ");
  // 国旗 emoji（区域指示符成对）
  s = s.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  // 常见形态：🇯🇵JP-xxx / 🇯🇵 JP-xxx
  s = s.replace(/\s*-\s*/g, "-");
  return s.trim();
}

function splitNodeNameParts(cleaned) {
  const text = String(cleaned || "").trim();
  if (!text) return [];

  const parts = [];
  let buf = "";
  let depth = 0;

  for (const ch of text) {
    if (ch === "[") depth += 1;
    if (ch === "-" && depth === 0) {
      if (buf) parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
    if (ch === "]" && depth > 0) depth -= 1;
  }

  if (buf) parts.push(buf);
  return parts;
}

function stripSortTokenDecor(token) {
  return String(token || "")
    .replace(/^\[+/, "")
    .replace(/\]+$/, "")
    .trim();
}

function isDlOrV6Token(token) {
  const t = stripSortTokenDecor(token).toLowerCase();
  return t === "dl" || t === "v6";
}

function isBracketToken(token) {
  return /^\[[^\]]+\]$/.test(String(token || "").trim());
}

function isBareProviderToken(token) {
  const t = stripSortTokenDecor(token).toLowerCase();
  return /^(bwh|dmit|e-dmit|p-dmit|dmit-e|dmit-p|lightlayer|megabox|mega\s*box)$/.test(
    t,
  );
}

function hasDlOrV6Priority(afterRegion) {
  if (!Array.isArray(afterRegion) || afterRegion.length === 0) return false;
  // 地区后第一段就是 DL/V6
  if (isDlOrV6Token(afterRegion[0])) return true;
  // 地区-机场-DL / 地区-*-V6 等：任意独立段为 DL/V6
  return afterRegion.some((part) => isDlOrV6Token(part));
}

function extractAirportCodeForSort(afterRegion) {
  if (!Array.isArray(afterRegion) || afterRegion.length === 0) return "";

  const first = afterRegion[0];
  if (isDlOrV6Token(first)) return "";
  if (isBracketToken(first)) return "";
  if (isBareProviderToken(first)) return "";

  return stripSortTokenDecor(first).toLowerCase();
}

function getProviderSortRank(name) {
  const s = String(name || "").toLowerCase();
  if (/dmit/.test(s)) return 1;
  // BWH 与 Megabox 等同
  if (/\bbwh\b|megabox|mega\s*box/.test(s)) return 2;
  if (/lightlayer/.test(s)) return 3;
  return 10;
}

const KNOWN_REGION_CODES = new Set([
  ...EUROPE_REGION_CODES,
  "AE",
  "AR",
  "AU",
  "BH",
  "BR",
  "CA",
  "CL",
  "CN",
  "CO",
  "EG",
  "HK",
  "ID",
  "IL",
  "IN",
  "JP",
  "KR",
  "KZ",
  "MA",
  "MO",
  "MX",
  "MY",
  "NG",
  "NZ",
  "PH",
  "PK",
  "SA",
  "SG",
  "TH",
  "TR",
  "TW",
  "US",
  "VN",
  "ZA",
]);

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizePolicyTag,
    findPolicyTagByNames,
    matchPolicyGroupTag,
  };
}
