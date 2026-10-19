# substore-scripts

个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 脚本。

用于：在已迁移的 **sing-box 1.15 完整配置模板** 基础上，合并 Sub-Store **订阅集合** 的节点，整理地区策略组与分流规则。脚本不再负责旧模板的版本迁移。

## 目录结构

```text
substore-scripts/
├── README.md
├── sing-box/
│   └── substore.js          # Sub-Store 脚本（远程 URL 指向此文件）
└── examples/                # 本地样例（已 gitignore，不会推送）
    └── config-1.15.0.json   # 当前参考模板，仅本机保留，勿提交
```

## Raw 链接

Sub-Store 远程脚本：

```text
https://raw.githubusercontent.com/SenreySong/substore-scripts/main/sing-box/substore.js
```

CDN 备选：

```text
https://cdn.jsdelivr.net/gh/SenreySong/substore-scripts@main/sing-box/substore.js
```

## Sub-Store 用法

1. **文件**：远程/本地内容为 sing-box 完整 JSON 模板（本机可参考 `examples/config-1.15.0.json`，该目录不上传）。
2. **脚本操作**：模式选 **链接 (link)**，URL 必须带 hash 参数（见下）。
3. **参数**（只需要一个）：

| key | value 示例 | 说明 |
|-----|------------|------|
| `collectionName` | `VPS-ALL` | Sub-Store 里订阅集合的名称（必填） |
| `interruptExistConnections` | `1` / `0` | 切换节点/策略组时是否打断既有连接；默认 `1`（开启） |

### 参数怎么传（必读）

**`mode: link` 时，Sub-Store 只从脚本 URL 的 `#` 后解析 `$arguments`，前端「参数」表会被忽略。**

正确写法（推荐直接整段贴进脚本 URL）：

```text
https://raw.githubusercontent.com/SenreySong/substore-scripts/main/sing-box/substore.js#collectionName=VPS-ALL
```

需要强制刷新脚本缓存时再加：

```text
https://raw.githubusercontent.com/SenreySong/substore-scripts/main/sing-box/substore.js#collectionName=VPS-ALL&noCache
```

注意：

- 第一个 `#` 后面才是参数；**多个参数用 `&` 连接**，不要写成 `#a=1#b=2`
- 只填 raw 地址、却把 `collectionName` 写在参数表里 → 脚本会因缺参抛错
- Sub-Store 在「文件」脚本出错且已有 `$content` 时**会静默回退原模板**（日志里往往没有 ERROR），表现就是 curl 仍是未处理的样例 JSON

若坚持用「参数」表，必须把脚本模式改成**非 link**（把脚本正文贴进内容框 / script 模式），此时 `arguments` 表才会生效。

其它行为写死在脚本内；仅 `collectionName` 必填，`interruptExistConnections` 可选。

## 脚本行为摘要

- 从集合 `collectionName` 拉取节点并写入模板；保留地区归组、节点排序和策略组成员整理。
- 模板需自行提供 `DNS-DIRECT` 和原生 `services` API 服务；脚本不再硬编码五种 DNS 服务器类型，也不创建缺失的 API 服务。
- 只处理订阅节点遗留的 `domain_strategy`：迁移至 `domain_resolver.strategy`，优先保留节点已有解析策略。
- **`♾️Auto Select`**：仅挂 **新加坡 + 美国优化** 节点的 urltest（非全节点，降低 Windows TUN 风险）；专供 **rule_set / dashboard 下载**。
- **Main Proxy** 成员：地区组 + Direct（不挂 Auto Select）；**default = 成员列表第一项**。
- 地区组默认类型：`selector`。
- 英国、德国等欧洲国家统一进入 **`🇪🇺 欧洲策略组`**；香港及其他未单列地区进入 `🌐 Other`。
- 节点名任意位置包含 **`赠`** 的节点优先进入 **`🎁 赠送策略组`**，不再按原国家或地区归组。
- 默认开启 `interrupt_exist_connections`：切换节点/策略组时打断既有连接（可用参数关闭）。
- Disney 规则集与分流由模板提供，脚本不额外注入，也不因 Disney 创建流媒体兜底组。
- 不再生成 `Bittorrent` 专用规则或出站，下载工具按其余分流规则处理。
- 脚本新增的 QUIC 拦截使用 `action: reject` + `method: drop`；模板广告拦截保持原有规则。
- 美国子组展示名：优化 / **落地** / 家宽（兼容旧名「直连」）。
- 不再新增 `Direct` / `Global` 路由或 DNS 模式规则；模板自带的模式规则及其 `GLOBAL` / `Global` 策略组保留。
- **缓存配置**（`experimental.cache_file`）完全按模板，脚本不改写。
- **Fake-IP**（`DNS-FAKEIP` 的 `inet4_range` / `inet6_range`、原有 DNS 规则、`dns.strategy`）保留模板配置，不额外注入模式 DNS 规则。本地参考模板为 `examples/config-1.15.0.json`。
- `GeoSite-Private` 使用远程规则集，匹配路由器、本地域名、特殊用途域名和私网反向解析域名并直连；不再注入 `GeoLocation-!CN`，避免把本来就由 `route.final` 走主代理的流量重复提前分流。
- 移除旧 `experimental.clash_api`，在模板现有的原生 API 服务上启用 dashboard；监听地址、端口、认证和访问控制完全沿用模板。
- 规则集与面板下载统一使用 Auto Select，无合适节点时使用 Direct；只覆盖 HTTP 客户端的下载出站，保留其已有协议、TLS、请求头等字段。引用共享客户端时使用内联副本，不修改共享配置。
- **TUN / mixed 入站、DNS 解析链和默认解析器**完全按 1.15 模板，不再删除 `stack`、改写监听地址或重复注入 DNS 劫持规则；旧字段应在模板中完成迁移。
- 不再自动创建 `Block` 出站，拒绝流量使用模板或脚本中的 `action: reject`。
- 合并前清理空模板组，合并后统一清洗一次策略组成员和默认值；识别有效 outbounds 与 endpoints，不再按规则集名称含 `local` 就删除模板路由。

## 本地开发

```bash
cd ~/code/github/substore-scripts

vim sing-box/substore.js

git add sing-box/substore.js
git -c commit.gpgsign=false commit -m "update substore script"
git push origin main
```

## Git 远程

```text
origin  https://github.com/SenreySong/substore-scripts.git
```

分支：`main`
