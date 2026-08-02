async function operator(input, targetPlatform, context) {
  // 仅接受 collectionName，其余行为写死在脚本内
  // Sub-Store 远程脚本传参格式（注意：多个参数用 &，不要写多个 #）：
  //   https://example.com/script.js#collectionName=VPS-ALL&noCache
  // 也可在前端「参数」表里配置 key=collectionName
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
  // 仅新加坡 + 美国优化节点的 urltest；规则集 / 面板下载走它（非全节点，降低 Windows TUN 风险）
  const AUTO_SELECT_TAG = "♾️Auto Select";
  const TEST_URL = "https://cp.cloudflare.com";
  // 切换节点 / 策略组时打断既有连接（sing-box: interrupt_exist_connections）
  // 可被 URL 参数覆盖：interruptExistConnections=0/1 或 true/false
  const INTERRUPT_EXIST_CONNECTIONS = parseBoolish(
    args.interruptExistConnections ??
      args.interrupt_exist_connections ??
      args.interrupt,
    true,
  );
  // 运行时由 ensureAutoSelectGroup 决定：有节点则 Auto Select，否则 Direct
  let RULE_SET_DETOUR = AUTO_SELECT_TAG;
  // TUN 常量必须在 applySingBox114Dns 调用前初始化（避免 TDZ）
  const TUN_IPV4_DEFAULT = "172.19.0.1/30";
  const TUN_IPV6_DEFAULT = "fd00::1/126";
  const TUN_ROUTE_EXCLUDE_DEFAULT = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "fc00::/7",
    "fe80::/10",
  ];

  // 逻辑名 → 实际 outbound tag（优先复用模板已有组）
  const appTagMap = {
    allNodes: AUTO_SELECT_TAG,
    mainProxy: MAIN_PROXY_TAG,
    openai: "OpenAI",
    ai: "AI",
    tiktok: "Tiktok",
    twitter: "Twitter",
    telegram: "Telegram",
    google: "Google",
    amazonOracle: "Amazon|Oracle",
    apple: "Apple",
    streaming: "国外流媒体",
    spotify: "Spotify",
    microsoft: "Microsoft",
    github: "GitHub",
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

  applySingBox114Dns(config);
  applySingBox114CacheFile(config);
  applySingBox114ApiDashboard(config);

  const originalGroups = config.outbounds.filter(isPolicyGroup);
  const originalGroupTags = new Set(
    originalGroups.map((item) => item && item.tag).filter(Boolean),
  );

  const preserveSet = new Set([
    "Direct",
    "DIRECT",
    "direct",
    "Proxy",
    "PROXY",
    "proxy",
    "Block",
    "BLOCK",
    "block",
    "Reject",
    "REJECT",
    "reject",
    "Global",
    "GLOBAL",
    "COMPATIBLE",
    "Bittorrent",
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

  for (const outbound of incomingOutbounds) {
    if (!outbound || typeof outbound !== "object") continue;
    if (!outbound.tag && outbound.name) outbound.tag = String(outbound.name);
    delete outbound.domain_strategy;
  }

  for (const endpoint of incomingEndpoints) {
    if (!endpoint || typeof endpoint !== "object") continue;
    if (!endpoint.tag && endpoint.name) endpoint.tag = String(endpoint.name);
    delete endpoint.domain_strategy;
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
  addedOutbounds.length = 0;
  addedEndpoints.length = 0;

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
    bucket.nodeTags = sortNodeTags(bucket.info, bucket.nodeTags);
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

  ensureBuiltinOutbounds();

  // Auto Select：只挂新加坡 + 美国优化，供 rule_set / dashboard 下载
  const autoSelectGroup = ensureAutoSelectGroup();
  if (autoSelectGroup) {
    RULE_SET_DETOUR = AUTO_SELECT_TAG;
    appTagMap.allNodes = AUTO_SELECT_TAG;
  } else {
    RULE_SET_DETOUR = "Direct";
    appTagMap.allNodes = "";
  }

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
    appTagMap.streaming,
    appTagMap.spotify,
    appTagMap.microsoft,
    appTagMap.github,
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
    if (generatedGroupTagSetAll.has(group.tag)) continue;
    if (legacySyncedTags.has(group.tag)) continue;
    if (isUSParentTag(group.tag)) continue;
    if (isStaleRegionShellTag(group.tag)) continue;

    const preserved = [];

    for (const tag of group.outbounds || []) {
      if (shouldPreserveGroupMember(tag, generatedGroupTagSetAll)) {
        preserved.push(tag);
      }
    }

    // urltest 组填节点 tag；selector 组填地区策略组
    const replacements =
      group.type === "urltest" ? allNodeTags : regionGroupTagsOrdered;

    group.outbounds = uniqueList([...preserved, ...replacements]);
    syncSelectorDefault(group);
  }

  applyGfsRouteAndRulesets(RULE_SET_DETOUR);
  applyDownloadDetourToDashboard(RULE_SET_DETOUR);

  // 清洗：删「全部节点」、保留 Auto Select，去掉悬空引用
  removeUnusedAllNodesGroup();
  removeClashGlobalGroup();
  sanitizePolicyGroupMembers();
  // 国家/地区策略组排在所有策略组最前
  reorderOutboundsPutRegionsFirst(regionGroupTagsOrdered);
  // 重排后再清洗一次 default / 悬空引用
  sanitizePolicyGroupMembers();
  // 最终硬校验：任何策略组不得再引用不存在的 tag / 不得为空
  // （不再删除非空的 Auto Select）
  stripBrokenPolicyGroups(config);
  // strip 之后再确保 Auto Select 仍在且成员正确，并统一下载 detour
  const autoAfterStrip = ensureAutoSelectGroup();
  RULE_SET_DETOUR = autoAfterStrip ? AUTO_SELECT_TAG : "Direct";
  syncAllRemoteDownloadDetours(RULE_SET_DETOUR);
  sanitizePolicyGroupMembers();
  // 统一写入：切换节点/策略组是否打断既有连接
  applyInterruptExistConnections(INTERRUPT_EXIST_CONNECTIONS);

  input.$content = JSON.stringify(config, null, 2);
  return input;

  // ─── 固定地区组：日/新/台/美×3，德港及其余进 Other（不再做赠送组） ───

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
      "🇺🇸 美国优化策略组",
      "🇺🇸 美国落地策略组",
      "🇺🇸 美国家宽策略组",
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

    // 模板旧地区短名 / 已废弃的赠送组：无对应节点时清掉空壳
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

  function sortNodeTags(_info, nodeTags) {
    return sortRegionNodeTags(nodeTags);
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
      group.interrupt_exist_connections = INTERRUPT_EXIST_CONNECTIONS;
      delete group.url;
      syncSelectorDefault(group);
      return group;
    }

    group = {
      type: "selector",
      tag: nextTag,
      outbounds: safeNodes,
      interrupt_exist_connections: INTERRUPT_EXIST_CONNECTIONS,
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

  function ensurePlainOutbound(tag, type) {
    let item = findOutboundByTag(tag);
    if (item) return item;

    item = { type, tag };
    if (type === "direct" && tag === "Direct") {
      item.domain_resolver = "DNS-DIRECT";
    }

    config.outbounds.push(item);
    existingTags.add(tag);
    return item;
  }

  function ensureBuiltinOutbounds() {
    ensurePlainOutbound("Direct", "direct");
    ensurePlainOutbound("direct", "direct");
    ensurePlainOutbound("Block", "block");
    ensurePlainOutbound("Bittorrent", "direct");
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

  // 收集 Auto Select 成员：仅新加坡 + 美国优化（不含赠送以外的其它地区）
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

  // 维护 ♾️Auto Select（urltest）：只挂 SG + 美国优化，专供规则/面板下载
  function ensureAutoSelectGroup() {
    const members = collectAutoSelectNodeTags();
    if (!members.length) {
      // 没有可用节点则移除空组，避免 missing tags
      config.outbounds = config.outbounds.filter(
        (item) => !(item && item.tag === AUTO_SELECT_TAG),
      );
      existingTags.delete(AUTO_SELECT_TAG);
      originalGroupTags.delete(AUTO_SELECT_TAG);
      appTagMap.allNodes = "";
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
        interrupt_exist_connections: INTERRUPT_EXIST_CONNECTIONS,
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
      group.interrupt_exist_connections = INTERRUPT_EXIST_CONNECTIONS;
      delete group.default;
    }

    appTagMap.allNodes = AUTO_SELECT_TAG;
    return group;
  }

  // 统一 remote rule_set + dashboard 的下载 detour
  function syncAllRemoteDownloadDetours(detour) {
    const d = detour || "Direct";
    for (const item of Array.isArray(config.route.rule_set)
      ? config.route.rule_set
      : []) {
      if (!item || item.type !== "remote") continue;
      delete item.download_detour;
      item.http_client = buildRuleSetHttpClient(d);
    }
    applyDownloadDetourToDashboard(d);
  }

  function applyDownloadDetourToDashboard(detour) {
    const d = detour || "Direct";
    if (!Array.isArray(config.services)) return;

    for (const svc of config.services) {
      if (!svc || svc.type !== "api") continue;

      if (svc.dashboard === true || svc.dashboard == null) {
        svc.dashboard = {
          enabled: true,
          http_client: buildRuleSetHttpClient(d),
        };
      } else if (typeof svc.dashboard === "object") {
        svc.dashboard.enabled = true;
        svc.dashboard.http_client = buildRuleSetHttpClient(d);
      }
    }
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

  // 去掉仅服务 clash 模式的 GLOBAL 组
  function removeClashGlobalGroup() {
    const globalGroup = findOutboundByTag("GLOBAL");
    if (!globalGroup && !findOutboundByTag("Global")) return;

    for (const tag of ["GLOBAL", "Global"]) {
      if (!findOutboundByTag(tag)) continue;

      for (const outbound of config.outbounds) {
        if (!outbound || !Array.isArray(outbound.outbounds)) continue;
        outbound.outbounds = outbound.outbounds.filter((item) => item !== tag);
        if (outbound.default === tag) {
          syncSelectorDefault(outbound);
        }
      }

      for (const rule of config.route.rules || []) {
        if (rule && rule.outbound === tag) {
          rule.outbound = MAIN_PROXY_TAG;
        }
      }

      config.outbounds = config.outbounds.filter(
        (item) => !(item && item.tag === tag),
      );
      existingTags.delete(tag);
      originalGroupTags.delete(tag);
    }
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
      for (const tag of outbound.outbounds || []) {
        if (typeof tag !== "string" || !tag) continue;
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
        } else if (available.has("direct") && outbound.tag !== "direct") {
          next.push("direct");
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
    const regionSet = new Set(regionTags || []);
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

  function ensureSelectorGroup(tag, members, options = {}) {
    let group = findOutboundByTag(tag);
    const interrupt =
      options.interrupt_exist_connections == null
        ? INTERRUPT_EXIST_CONNECTIONS
        : !!options.interrupt_exist_connections;

    if (!group) {
      group = {
        type: "selector",
        tag,
        outbounds: [],
        interrupt_exist_connections: interrupt,
      };
      config.outbounds.push(group);
      existingTags.add(tag);
      originalGroupTags.add(tag);
    } else if (!isPolicyGroup(group)) {
      return null;
    } else {
      group.type = "selector";
      group.interrupt_exist_connections = interrupt;
    }

    // 只写入当前已存在的 tag，杜绝 missing tags
    const available = new Set([
      ...config.outbounds.map((item) => item && item.tag).filter(Boolean),
      ...(config.endpoints || []).map((item) => item && item.tag).filter(Boolean),
    ]);
    const safeMembers = uniqueList(
      (members || []).filter(
        (t) => t && t !== tag && available.has(t),
      ),
    );
    if (!safeMembers.length) {
      if (available.has("Direct") && tag !== "Direct") safeMembers.push("Direct");
      else if (available.has("direct") && tag !== "direct") safeMembers.push("direct");
    }
    group.outbounds = safeMembers;
    syncSelectorDefault(group);
    return group;
  }

  // 删除空策略组 / 悬空引用；非空 Auto Select 保留
  function stripBrokenPolicyGroups(targetConfig) {
    if (!targetConfig || !Array.isArray(targetConfig.outbounds)) return;

    const AUTO = AUTO_SELECT_TAG;
    const available = () =>
      new Set(
        targetConfig.outbounds.map((item) => item && item.tag).filter(Boolean),
      );

    // 业务组里不要挂 Auto（Auto 仅下载用）；Auto 自身成员保留
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
            // 空策略组直接丢弃（避免 missing tags）
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

    // 路由 / DNS 里指向已删组的，改 Main 或 Direct
    const tags = available();
    const fallback = tags.has(MAIN_PROXY_TAG)
      ? MAIN_PROXY_TAG
      : tags.has("Direct")
        ? "Direct"
        : [...tags][0];

    for (const rule of (targetConfig.route && targetConfig.route.rules) || []) {
      if (rule && rule.outbound && !tags.has(rule.outbound)) {
        rule.outbound = fallback;
      }
    }
    for (const server of (targetConfig.dns && targetConfig.dns.servers) || []) {
      if (server && server.detour && !tags.has(server.detour)) {
        server.detour = fallback;
      }
    }
  }

  // 优先复用模板已有策略组，没有再按 preferred 新建
  function resolveAppGroupTag(preferred, aliases = []) {
    const candidates = uniqueList([...(aliases || []), preferred]);

    for (const tag of candidates) {
      const group = findOutboundByTag(tag);
      if (group && isPolicyGroup(group)) {
        return group.tag;
      }
    }

    return preferred;
  }

  function ensureResolvedAppGroup(key, preferred, aliases, members) {
    const tag = resolveAppGroupTag(preferred, aliases);
    appTagMap[key] = tag;

    const group = ensureSelectorGroup(tag, members, {
      interrupt_exist_connections: INTERRUPT_EXIST_CONNECTIONS,
    });

    return group;
  }

  function applyInterruptExistConnections(enabled) {
    const value = !!enabled;
    for (const outbound of config.outbounds || []) {
      if (!outbound || !isPolicyGroup(outbound)) continue;
      outbound.interrupt_exist_connections = value;
    }
  }

  function ensureGfsAppGroups(regionTags, nodeTags) {
    const tags = new Set();
    const regions = uniqueList(regionTags);

    // 主选择器：仅地区组 + Direct（不挂 Auto Select，避免业务分流测速风暴）
    const mainProxyMembers = uniqueList([
      ...regions,
      "direct",
      "Direct",
    ]);
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
        members: uniqueList([...regions, mainTag, "direct", "Direct"]),
      },
      {
        key: "streaming",
        preferred: "国外流媒体",
        aliases: ["国外流媒体", "Streaming", "📺Streaming"],
        members: regionPlusMain,
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
      {
        key: "github",
        preferred: "GitHub",
        aliases: ["GitHub", "Github", "🐙GitHub"],
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

    for (const tag of extras) {
      if (alreadyManaged.has(tag)) continue;

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
    return [
      {
        tag: "Category-Ads",
        url: `${geo}/geosite/category-ads-all.srs`,
      },
      {
        tag: "category-httpdns-cn-ads",
        url: `${geo}/geosite/category-httpdns-cn@ads.srs`,
      },
      {
        tag: "GeoIP-Private",
        url: `${geo}/geoip/private.srs`,
      },
      {
        tag: "GeoSite-Private",
        url: `${geo}/geosite/private.srs`,
      },
      {
        tag: "GeoIP-CN",
        url: `${geo}/geoip/cn.srs`,
      },
      {
        tag: "GeoSite-CN",
        url: `${geo}/geosite/cn.srs`,
      },
      {
        tag: "GeoLocation-!CN",
        url: `${geo}/geosite/geolocation-!cn.srs`,
      },
      { tag: "openai", url: `${geo}/geosite/openai.srs` },
      { tag: "jetbrains-ai", url: `${geo}/geosite/jetbrains-ai.srs` },
      {
        tag: "bytedance-ai-!cn",
        url: `${geo}/geosite/bytedance-ai-!cn.srs`,
      },
      { tag: "anthropic", url: `${geo}/geosite/anthropic.srs` },
      { tag: "apple", url: `${geo}/geosite/apple.srs` },
      { tag: "disney", url: `${geo}/geosite/disney.srs` },
      { tag: "bahamut", url: `${geo}/geosite/bahamut.srs` },
      { tag: "netflix", url: `${geo}/geosite/netflix.srs` },
      { tag: "netflix-ip", url: `${geo}/geoip/netflix.srs` },
      { tag: "youtube", url: `${geo}/geosite/youtube.srs` },
      { tag: "spotify", url: `${geo}/geosite/spotify.srs` },
      { tag: "amazon", url: `${geo}/geosite/amazon.srs` },
      { tag: "oracle", url: `${geo}/geosite/oracle.srs` },
      { tag: "microsoft", url: `${geo}/geosite/microsoft.srs` },
      { tag: "github", url: `${geo}/geosite/github.srs` },
      { tag: "tiktok", url: `${geo}/geosite/tiktok.srs` },
      { tag: "telegram", url: `${geo}/geosite/telegram.srs` },
      { tag: "telegram-ip", url: `${geo}/geoip/telegram.srs` },
      { tag: "google", url: `${geo}/geosite/google.srs` },
      { tag: "google-ip", url: `${geo}/geoip/google.srs` },
      { tag: "google-gemini", url: `${geo}/geosite/google-gemini.srs` },
      { tag: "twitter", url: `${geo}/geosite/twitter.srs` },
      { tag: "twitter-ip", url: `${geo}/geoip/twitter.srs` },
      {
        tag: "grok",
        url: "https://github.com/vernette/rulesets/raw/master/srs/grok.srs",
      },
    ];
  }

  function ensureRemoteRuleset(def, detour) {
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
    // sing-box 1.14：download_detour 已废弃，改用 http_client
    delete item.download_detour;
    item.http_client = buildRuleSetHttpClient(detour);

    return item;
  }

  // 1.14 remote rule-set 下载走哪条出站（用户要求走主代理）
  function buildRuleSetHttpClient(detour) {
    return {
      engine: "go",
      version: 2,
      detour: detour || MAIN_PROXY_TAG,
    };
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

  function isLocalOnlyRule(rule) {
    const sets = ruleSetList(rule);
    if (!sets.length) return false;
    return sets.every(
      (tag) =>
        tag === "本地直连专用" ||
        tag === "本地代理专用" ||
        /local/i.test(String(tag)),
    );
  }

  function getManagedGfsRules() {
    const t = {
      openai: appTagMap.openai || "OpenAI",
      ai: appTagMap.ai || "AI",
      tiktok: appTagMap.tiktok || "Tiktok",
      twitter: appTagMap.twitter || "Twitter",
      telegram: appTagMap.telegram || "Telegram",
      google: appTagMap.google || "Google",
      amazonOracle: appTagMap.amazonOracle || "Amazon|Oracle",
      apple: appTagMap.apple || "Apple",
      streaming: appTagMap.streaming || "国外流媒体",
      spotify: appTagMap.spotify || "Spotify",
      microsoft: appTagMap.microsoft || "Microsoft",
      github: appTagMap.github || "GitHub",
      main: appTagMap.mainProxy || MAIN_PROXY_TAG,
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
        id: "gfs-bt",
        test: (rule) =>
          Array.isArray(rule && rule.process_name) &&
          rule.process_name.some((name) =>
            /qBittorrent|Transmission|uTorrent|Folx|BitComet|Thunder|Xunlei/i.test(
              String(name),
            ),
          ),
        rule: {
          action: "route",
          process_name: [
            "qBittorrent",
            "Transmission",
            "uTorrent",
            "Folx",
            "BitComet",
            "Thunder",
            "Xunlei",
          ],
          outbound: "Bittorrent",
        },
      },
      {
        id: "gfs-ads",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "Category-Ads",
            "category-httpdns-cn-ads",
            "category-httpdns-cn@ads-geosite.json",
          ]) &&
          (rule.outbound === "Block" ||
            rule.action === "reject" ||
            rule.outbound === "block"),
        // 用 reject/drop，避免 UDP packet 走 outbound/block 时刷
        // "listen packet connection ... operation not permitted"
        rule: {
          action: "reject",
          rule_set: ["Category-Ads", "category-httpdns-cn-ads"],
          method: "drop",
        },
      },
      {
        id: "gfs-quic",
        test: (rule) =>
          rule &&
          rule.protocol === "quic" &&
          (rule.outbound === "Block" ||
            rule.action === "reject" ||
            rule.outbound === "block"),
        // 同上：QUIC/UDP 拒绝不要 route 到 Block 出站
        rule: {
          action: "reject",
          protocol: "quic",
          method: "drop",
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
        id: "gfs-ai",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "jetbrains-ai",
            "bytedance-ai-!cn",
            "anthropic",
            "jetbrains-ai-geosite.json",
            "bytedance-ai-!cn-geosite.json",
            "anthropic-geosite.json",
            "AI-Site",
          ]),
        rule: {
          action: "route",
          rule_set: ["jetbrains-ai", "bytedance-ai-!cn", "anthropic"],
          outbound: t.ai,
        },
      },
      {
        id: "gfs-apple",
        test: (rule) =>
          (hasAnyRuleSet(rule, ["apple", "apple-geosite.json", "Apple-Site"]) &&
            !hasAnyRuleSet(rule, ["apple-cn", "apple-cn-geosite.json"])) ||
          rule.outbound === t.apple,
        rule: {
          action: "route",
          rule_set: ["apple"],
          outbound: t.apple,
        },
      },
      // YouTube 比 Google 更具体，必须单独且排在 Google 前，避免被 google geosite 吃掉
      {
        id: "gfs-youtube",
        test: (rule) =>
          hasAnyRuleSet(rule, ["youtube", "youtube-geosite.srs", "youtube-geosite.json"]),
        rule: {
          action: "route",
          rule_set: ["youtube"],
          outbound: t.streaming,
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
        id: "gfs-streaming",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "disney",
            "bahamut",
            "netflix",
            "netflix-ip",
            "disney-geosite.json",
            "bahamut-geosite.json",
            "netflix-geosite.json",
            "netflix-geoip.json",
          ]),
        rule: {
          action: "route",
          rule_set: ["disney", "bahamut", "netflix", "netflix-ip"],
          outbound: t.streaming,
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
        id: "gfs-microsoft",
        test: (rule) =>
          (hasAnyRuleSet(rule, [
            "microsoft",
            "microsoft-geosite.json",
            "Microsoft-Site",
          ]) &&
            !hasAnyRuleSet(rule, [
              "microsoft@cn",
              "microsoft@cn-geosite.json",
            ])) ||
          rule.outbound === t.microsoft,
        rule: {
          action: "route",
          rule_set: ["microsoft"],
          outbound: t.microsoft,
        },
      },
      {
        id: "gfs-github",
        test: (rule) =>
          hasAnyRuleSet(rule, ["github", "github-geosite.json"]),
        rule: {
          action: "route",
          rule_set: ["github"],
          outbound: t.github,
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
      {
        id: "gfs-telegram",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "telegram",
            "telegram-ip",
            "telegram-geosite.json",
            "telegram-geoip.json",
            "Telegram-Site",
            "Telegram-IP",
          ]) || rule.outbound === t.telegram,
        rule: {
          action: "route",
          rule_set: ["telegram", "telegram-ip"],
          outbound: t.telegram,
        },
      },
      // Google 规则集较宽，必须排在 YouTube / 国外流媒体之后
      {
        id: "gfs-google",
        test: (rule) =>
          (hasAnyRuleSet(rule, [
            "google",
            "google-ip",
            "google-gemini",
            "google-geosite.json",
            "google-geoip.json",
            "google-gemini-geosite.json",
            "Google-Site",
          ]) ||
            rule.outbound === t.google) &&
          !hasAnyRuleSet(rule, ["youtube", "youtube-geosite.srs", "youtube-geosite.json"]),
        rule: {
          action: "route",
          rule_set: ["google", "google-ip", "google-gemini"],
          outbound: t.google,
        },
      },
      {
        id: "gfs-private-ip",
        test: (rule) => hasAnyRuleSet(rule, ["GeoIP-Private"]),
        rule: {
          action: "route",
          rule_set: ["GeoIP-Private"],
          outbound: "Direct",
        },
      },
      {
        id: "gfs-private-site",
        test: (rule) => hasAnyRuleSet(rule, ["GeoSite-Private"]),
        rule: {
          action: "route",
          rule_set: ["GeoSite-Private"],
          outbound: "Direct",
        },
      },
      {
        id: "gfs-cn-site",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "GeoSite-CN",
            "cn-geosite.json",
            "apple-cn-geosite.json",
            "category-httpdns-cn-geosite.json",
            "microsoft@cn-geosite.json",
            "tencent-geosite.json",
            "aliyun-geosite.json",
            "bytedance-geosite.json",
          ]) &&
          rule.outbound !== t.main &&
          rule.outbound !== MAIN_PROXY_TAG &&
          rule.outbound !== "Proxy",
        rule: {
          action: "route",
          rule_set: ["GeoSite-CN"],
          outbound: "Direct",
        },
      },
      {
        id: "gfs-cn-ip",
        test: (rule) =>
          hasAnyRuleSet(rule, ["GeoIP-CN", "cn-geoip.json"]),
        rule: {
          action: "route",
          rule_set: ["GeoIP-CN"],
          outbound: "Direct",
        },
      },
      {
        id: "gfs-not-cn",
        test: (rule) =>
          hasAnyRuleSet(rule, [
            "GeoLocation-!CN",
            "aliyun@!cn-geosite.json",
            "tencent@!cn-geosite.json",
            "bytedance@!cn-geosite.json",
          ]),
        rule: {
          action: "route",
          rule_set: ["GeoLocation-!CN"],
          outbound: t.main,
        },
      },
    ];
  }

  function isInfraRouteRule(rule) {
    if (!rule || typeof rule !== "object") return false;

    // sniff / DNS 必须最前
    if (rule.action === "sniff" || rule.action === "hijack-dns") return true;
    if (rule.protocol === "dns") return true;

    if (
      Array.isArray(rule.inbound) &&
      rule.inbound.some((name) => /dns/i.test(String(name)))
    ) {
      return true;
    }

    if (rule.port === 53) return true;
    if (Array.isArray(rule.port) && rule.port.length === 1 && rule.port[0] === 53) {
      return true;
    }

    return false;
  }

  // 拒绝类：广告 / quic / reject / Block —— 应紧跟 sniff/dns，先于分流
  function isRejectRouteRule(rule) {
    if (!rule || typeof rule !== "object") return false;
    if (isInfraRouteRule(rule)) return false;

    if (rule.action === "reject") return true;

    const outbound = String(rule.outbound || "");
    if (/^(block|reject)$/i.test(outbound)) return true;

    if (rule.protocol === "quic" && /^(block|reject)?$/i.test(outbound || "block")) {
      // quic + Block / reject，或仅 protocol quic 的拒绝语义由 managed 处理
      if (!outbound || /^(block|reject)$/i.test(outbound)) return true;
    }

    if (
      hasAnyRuleSet(rule, [
        "Category-Ads",
        "category-httpdns-cn-ads",
        "category-httpdns-cn@ads-geosite.json",
        "AD-Site",
      ]) &&
      (rule.action === "reject" || /^(block|reject)$/i.test(outbound))
    ) {
      return true;
    }

    return false;
  }

  function isCnBroadRouteRule(rule) {
    return hasAnyRuleSet(rule, [
      "China-Site",
      "China-IP",
      "GeoSite-CN",
      "GeoIP-CN",
      "cn-geosite.json",
      "cn-geoip.json",
    ]);
  }

  function isNotCnBroadRouteRule(rule) {
    return hasAnyRuleSet(rule, [
      "GeoLocation-!CN",
      "aliyun@!cn-geosite.json",
      "tencent@!cn-geosite.json",
      "bytedance@!cn-geosite.json",
    ]);
  }

  function isPrivateRouteRule(rule) {
    if (!rule || typeof rule !== "object") return false;
    if (rule.ip_is_private === true) return true;
    return hasAnyRuleSet(rule, ["GeoIP-Private", "GeoSite-Private"]);
  }

  function applyGfsRouteAndRulesets(detour) {
    const downloadDetour = detour || MAIN_PROXY_TAG;

    for (const def of getGfsRulesetDefs()) {
      ensureRemoteRuleset(def, downloadDetour);
    }

    const managed = getManagedGfsRules();
    const managedById = new Map(managed.map((item) => [item.id, item]));

    // 顺序：sniff/dns → 拒绝 → 分流（精确→应用）→ private → CN → !CN
    // 不注入 clash_mode，纯 sing-box TUN 规则模式
    const managedTiers = {
      // 拒绝类靠前（广告 / quic）
      reject: ["gfs-ads", "gfs-quic"],
      // 应用分流：YouTube → Spotify → 流媒体 → … → Google（最宽）
      specific: [
        "gfs-twitter",
        "gfs-openai",
        "gfs-ai",
        "gfs-apple",
        "gfs-youtube",
        "gfs-spotify",
        "gfs-streaming",
        "gfs-amazon-oracle",
        "gfs-microsoft",
        "gfs-github",
        "gfs-tiktok",
        "gfs-telegram",
        "gfs-google",
      ],
      // BT 是分流到专用出站，不是拒绝
      divert: ["gfs-bt"],
      private: ["gfs-private-ip", "gfs-private-site"],
      cn: ["gfs-cn-site", "gfs-cn-ip"],
      notcn: ["gfs-not-cn"],
    };

    function managedRulesOf(tierIds) {
      const result = [];
      for (const id of tierIds) {
        const item = managedById.get(id);
        if (!item) continue;
        result.push({ ...item.rule });
      }
      return result;
    }

    const existingRules = Array.isArray(config.route.rules)
      ? config.route.rules
      : [];

    const infra = [];
    const rejectKept = [];
    const precise = [];
    const privateKept = [];
    const cnKept = [];
    const notCnKept = [];

    for (const rule of existingRules) {
      if (!rule || typeof rule !== "object") continue;
      if (isLocalOnlyRule(rule)) continue;
      // 去掉 clash 模式规则，走默认 sing-box TUN 分流即可
      if (rule.clash_mode) continue;
      if (managed.some((item) => item.test(rule))) continue;

      if (isInfraRouteRule(rule)) {
        infra.push(rule);
      } else if (isRejectRouteRule(rule)) {
        // 模板拒绝规则（AD-Site reject、逻辑 reject 等）
        rejectKept.push(rule);
      } else if (isCnBroadRouteRule(rule)) {
        // 模板 China-Site / China-IP：靠后，不抢精确规则
        cnKept.push(rule);
      } else if (isNotCnBroadRouteRule(rule)) {
        notCnKept.push(rule);
      } else if (isPrivateRouteRule(rule)) {
        privateKept.push(rule);
      } else {
        // 域名 / 进程 / 独立 rule_set 等分流规则
        precise.push(rule);
      }
    }

    config.route.rules = [
      // 1. sniff / DNS 最前
      ...infra,
      // 2. 拒绝类（模板 + 广告/quic）
      ...rejectKept,
      ...managedRulesOf(managedTiers.reject),
      // 3. 分流规则（精确域名/进程/应用 → BT）
      ...precise,
      ...managedRulesOf(managedTiers.specific),
      ...managedRulesOf(managedTiers.divert),
      // 4. Private / CN / !CN 大盘靠后
      ...privateKept,
      ...managedRulesOf(managedTiers.private),
      ...cnKept,
      ...managedRulesOf(managedTiers.cn),
      ...notCnKept,
      ...managedRulesOf(managedTiers.notcn),
    ];

    // 统一 1.14 rule_set 下载：http_client，移除已废弃的 download_detour
    for (const item of config.route.rule_set) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "remote") continue;

      delete item.download_detour;
      item.http_client = buildRuleSetHttpClient(downloadDetour);
    }

    if (!config.route.final) {
      config.route.final = MAIN_PROXY_TAG;
    }
  }

  function applyTunAddressAndBypass(inbound) {
    let addresses = Array.isArray(inbound.address)
      ? inbound.address.map(String)
      : inbound.address
        ? [String(inbound.address)]
        : [];

    // 旧文档式 v6 前缀 → 更通用的 fd00::/126
    addresses = addresses.map((item) => {
      if (/^fdfe:dcba:9876::/i.test(item)) return TUN_IPV6_DEFAULT;
      return item;
    });

    const hasV4 = addresses.some((a) => a.includes(".") && !a.includes(":"));
    const hasV6 = addresses.some((a) => a.includes(":"));
    if (!hasV4) addresses.unshift(TUN_IPV4_DEFAULT);
    if (!hasV6) addresses.push(TUN_IPV6_DEFAULT);

    inbound.address = uniqueList(addresses);

    // 合并局域网绕过，不覆盖模板已有项；不排除 FakeIP 198.18.0.0/15
    const existingExclude = Array.isArray(inbound.route_exclude_address)
      ? inbound.route_exclude_address.map(String)
      : inbound.route_exclude_address
        ? [String(inbound.route_exclude_address)]
        : [];
    inbound.route_exclude_address = uniqueList([
      ...existingExclude,
      ...TUN_ROUTE_EXCLUDE_DEFAULT,
    ]);
  }

  // 从 TUN address 推导 dns_address（取接口地址 +1，与官方文档示例一致）
  function deriveTunDnsAddresses(addresses) {
    const result = [];
    for (const item of addresses || []) {
      const raw = String(item || "").trim();
      if (!raw) continue;
      const ip = raw.split("/")[0];
      if (!ip) continue;

      if (ip.includes(":")) {
        // IPv6：末段 +1（::1 → ::2）
        const parts = ip.split(":");
        let i = parts.length - 1;
        while (i >= 0 && parts[i] === "") i -= 1;
        if (i < 0) continue;
        const n = parseInt(parts[i] || "0", 16);
        if (Number.isNaN(n)) continue;
        parts[i] = (n + 1).toString(16);
        result.push(parts.join(":"));
      } else {
        const parts = ip.split(".").map((x) => Number(x));
        if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) continue;
        parts[3] = (parts[3] + 1) & 0xff;
        result.push(parts.join("."));
      }
    }
    return uniqueList(result);
  }

  // 1.14.0-alpha.21：dns_mode=hijack + dns_address
  function applyTunDnsHijack(inbound) {
    inbound.dns_mode = "hijack";

    const derived = deriveTunDnsAddresses(inbound.address);
    if (derived.length > 0) {
      // 显式写入时不会自动 hijack-dns，需配合路由 hijack-dns 规则
      inbound.dns_address = derived;
    } else {
      // 未推导成功则交给内核默认（按 address 下一跳自动生成并劫持）
      delete inbound.dns_address;
    }
  }

  // 确保路由侧有 DNS 劫持（显式 dns_address 时必须；无则作双保险）
  function ensureRouteDnsHijackRules(targetConfig) {
    if (!targetConfig.route || typeof targetConfig.route !== "object") {
      targetConfig.route = {};
    }
    if (!Array.isArray(targetConfig.route.rules)) {
      targetConfig.route.rules = [];
    }

    const rules = targetConfig.route.rules;
    const hasProtocolDnsHijack = rules.some(
      (rule) =>
        rule &&
        rule.action === "hijack-dns" &&
        (rule.protocol === "dns" ||
          (Array.isArray(rule.protocol) && rule.protocol.includes("dns"))),
    );
    const hasPort53Hijack = rules.some(
      (rule) =>
        rule &&
        rule.action === "hijack-dns" &&
        (rule.port === 53 ||
          (Array.isArray(rule.port) && rule.port.includes(53))),
    );

    // 插在规则列表靠前位置（在已有 sniff 之后尽量靠前）
    let insertAt = 0;
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i] && rules[i].action === "sniff") insertAt = i + 1;
    }

    const toInsert = [];
    if (!hasProtocolDnsHijack) {
      toInsert.push({ protocol: "dns", action: "hijack-dns" });
    }
    if (!hasPort53Hijack) {
      toInsert.push({ port: 53, action: "hijack-dns" });
    }

    if (toInsert.length) {
      rules.splice(insertAt, 0, ...toInsert);
    }
  }

  // sing-box 1.14：独立 cache_file；store_rdrc 已废弃，改用 store_dns
  // 参考：https://sing-box.sagernet.org/configuration/experimental/cache-file/
  function applySingBox114CacheFile(targetConfig) {
    if (!targetConfig.experimental || typeof targetConfig.experimental !== "object") {
      targetConfig.experimental = {};
    }

    const prev =
      targetConfig.experimental.cache_file &&
      typeof targetConfig.experimental.cache_file === "object"
        ? targetConfig.experimental.cache_file
        : {};

    targetConfig.experimental.cache_file = {
      enabled: true,
      // 空则默认 cache.db；保留模板自定义 path / cache_id
      path: prev.path || "cache.db",
      store_fakeip: true,
      store_dns: true,
    };

    if (prev.cache_id) {
      targetConfig.experimental.cache_file.cache_id = prev.cache_id;
    }

    // 废弃字段清理（1.14 起 store_rdrc → store_dns）
    delete targetConfig.experimental.cache_file.store_rdrc;
    delete targetConfig.experimental.cache_file.rdrc_timeout;
  }

  // 关闭 Clash API，开启 sing-box 1.14 官方 API + Dashboard
  // 文档：https://sing-box.sagernet.org/configuration/service/api/
  function applySingBox114ApiDashboard(targetConfig) {
    if (!targetConfig.experimental || typeof targetConfig.experimental !== "object") {
      targetConfig.experimental = {};
    }

    // 彻底关掉旧 Clash API（含 external_controller / external_ui）
    delete targetConfig.experimental.clash_api;

    if (!Array.isArray(targetConfig.services)) {
      targetConfig.services = [];
    }

    // 去掉非 api 以外的残留时不要误删其它 service；只保证有一条 type=api
    let api = targetConfig.services.find(
      (item) => item && item.type === "api",
    );

    if (!api) {
      api = {
        type: "api",
        tag: "sing-box-api",
        listen: "127.0.0.1",
        listen_port: 9090,
        secret: "",
        access_control_allow_private_network: true,
        // 面板资源下载 detour 稍后由 syncAllRemoteDownloadDetours 统一写入
        dashboard: true,
      };
      targetConfig.services.push(api);
    } else {
      if (!api.tag) api.tag = "sing-box-api";
      if (!api.listen) api.listen = "127.0.0.1";
      if (api.listen_port == null || api.listen_port === "") {
        api.listen_port = 9090;
      }
      if (api.access_control_allow_private_network == null) {
        api.access_control_allow_private_network = true;
      }

      if (api.dashboard === false || api.dashboard == null) {
        api.dashboard = true;
      } else if (typeof api.dashboard === "object") {
        api.dashboard.enabled = true;
      }
    }
  }

  function applySingBox114Dns(targetConfig) {
    if (!targetConfig.dns || typeof targetConfig.dns !== "object") {
      throw new Error("配置模板缺少 dns 配置");
    }

    if (!Array.isArray(targetConfig.dns.servers)) {
      throw new Error("配置模板缺少 dns.servers");
    }

    if (!Array.isArray(targetConfig.dns.rules)) {
      targetConfig.dns.rules = [];
    }

    const resolver = requireDnsServer("DNS-RESOLVER", "udp");
    delete resolver.detour;

    const nodeResolver = requireDnsServer("DNS-NODE-RESOLVER", "https");
    nodeResolver.domain_resolver = "DNS-RESOLVER";
    delete nodeResolver.detour;

    const directResolver = requireDnsServer("DNS-DIRECT", "https");
    directResolver.domain_resolver = "DNS-RESOLVER";
    delete directResolver.detour;

    const proxyResolver = requireDnsServer("DNS-PROXY", "https");
    proxyResolver.detour = MAIN_PROXY_TAG;
    delete proxyResolver.domain_resolver;

    const googleResolver = requireDnsServer("DNS-GOOGLE", "https");
    googleResolver.detour = "🔍Google";
    delete googleResolver.domain_resolver;

    const fakeIpResolver = requireDnsServer("DNS-FAKEIP", "fakeip");
    fakeIpResolver.inet4_range = "198.18.0.0/15";
    fakeIpResolver.inet6_range = "fc00::/18";

    let fakeIpRule = targetConfig.dns.rules.find(
      (rule) => rule && rule.server === "DNS-FAKEIP",
    );

    if (!fakeIpRule) {
      fakeIpRule = {
        action: "route",
        server: "DNS-FAKEIP",
      };
      targetConfig.dns.rules.push(fakeIpRule);
    }

    fakeIpRule.query_type = ["A", "AAAA"];
    fakeIpRule.action = "route";
    // 与 cache_file.store_fakeip / store_dns 配合，允许缓存
    delete fakeIpRule.disable_cache;

    // 1.14：DNS cache 按 transport 分键，independent_cache 已废弃
    delete targetConfig.dns.independent_cache;

    targetConfig.dns.strategy = "prefer_ipv4";

    if (!targetConfig.route || typeof targetConfig.route !== "object") {
      targetConfig.route = {};
    }

    targetConfig.route.default_domain_resolver = {
      server: "DNS-DIRECT",
    };

    for (const inbound of Array.isArray(targetConfig.inbounds)
      ? targetConfig.inbounds
      : []) {
      if (!inbound || inbound.type !== "tun") continue;

      applyTunAddressAndBypass(inbound);

      // sing-box 1.14.0-alpha.21+：TUN DNS 模式与接口 DNS 劫持
      // https://sing-box.sagernet.org/configuration/inbound/tun/#dns_mode
      applyTunDnsHijack(inbound);
    }

    ensureRouteDnsHijackRules(targetConfig);

    for (const outbound of targetConfig.outbounds) {
      if (!outbound || typeof outbound !== "object") continue;

      delete outbound.domain_strategy;

      if (outbound.type === "direct" && outbound.tag === "Direct") {
        outbound.domain_resolver = "DNS-DIRECT";
      }
    }

    for (const endpoint of targetConfig.endpoints) {
      if (!endpoint || typeof endpoint !== "object") continue;
      delete endpoint.domain_strategy;
    }

    function requireDnsServer(tag, type) {
      const server = targetConfig.dns.servers.find(
        (item) => item && item.tag === tag,
      );

      if (!server) {
        throw new Error(`配置模板缺少 DNS 服务器：${tag}`);
      }

      if (server.type !== type) {
        throw new Error(
          `DNS 服务器 ${tag} 类型应为 ${type}，实际为 ${server.type || "未设置"}`,
        );
      }

      delete server.address;
      delete server.address_resolver;
      delete server.address_strategy;
      delete server.domain_strategy;

      return server;
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
    // 去掉 [赠] 等前缀后再识别地区；赠送节点按真实地区归组，不再单独成组
    const regionCode = getRegionCode(baseName);

    // 固定国家之外（含无法识别地区）一律 Other
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

    // 去掉 [赠] 等前缀后再识别地区
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

// 仅这些国家单独建组；德/港及其余全部进 Other
const FIXED_REGION_CODES = new Set(["JP", "SG", "TW", "US"]);

function parseBoolish(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return !!defaultValue;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(s)) return true;
  if (["0", "false", "no", "off", "n"].includes(s)) return false;
  return !!defaultValue;
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
  "AE",
  "AR",
  "AT",
  "AU",
  "BE",
  "BG",
  "BH",
  "BR",
  "BY",
  "CA",
  "CH",
  "CL",
  "CN",
  "CO",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EG",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HK",
  "HR",
  "HU",
  "ID",
  "IE",
  "IL",
  "IN",
  "IS",
  "IT",
  "JP",
  "KR",
  "KZ",
  "LT",
  "LU",
  "LV",
  "MA",
  "MD",
  "MK",
  "MO",
  "MX",
  "MY",
  "NG",
  "NL",
  "NO",
  "NZ",
  "PH",
  "PK",
  "PL",
  "PT",
  "RO",
  "RS",
  "RU",
  "SA",
  "SE",
  "SG",
  "SI",
  "SK",
  "TH",
  "TR",
  "TW",
  "UA",
  "US",
  "VN",
  "ZA",
]);
