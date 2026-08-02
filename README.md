# substore-scripts

个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 脚本。

用于：在 **配置模板** 基础上，合并 Sub-Store **订阅集合** 的节点，整理地区策略组与分流规则，输出可用的 sing-box 配置。

## 目录结构

```text
substore-scripts/
├── README.md
├── sing-box/
│   └── substore.js          # Sub-Store 脚本（远程 URL 指向此文件）
└── examples/                # 本地样例（已 gitignore，不会推送）
    └── config.sample.json   # 仅本机保留，勿提交
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

1. **文件**：远程/本地内容为 sing-box 完整 JSON 模板（本机可参考 `examples/config.sample.json`，该目录不上传）。
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

- 从集合 `collectionName` 拉取节点并写入模板。
- **`♾️Auto Select`**：仅挂 **新加坡 + 美国优化** 节点的 urltest（非全节点，降低 Windows TUN 风险）；专供 **rule_set / dashboard 下载**。
- **Main Proxy** 成员：地区组 + Direct（不挂 Auto Select）；**default = 成员列表第一项**。
- 地区组默认类型：`selector`。
- 默认开启 `interrupt_exist_connections`：切换节点/策略组时打断既有连接（可用参数关闭）。
- 广告 / QUIC 拦截使用 `action: reject` + `method: drop`。
- 美国子组展示名：优化 / **落地** / 家宽（兼容旧名「直连」）。
- 按 1.14 开启 `experimental.cache_file`（`store_fakeip` + `store_dns`）。
- 关闭 Clash API；开启官方 `services` API + dashboard（`127.0.0.1:9090`）。
- TUN 显式 `dns_mode: hijack` + `dns_address`（1.14.0-alpha.21 接口 DNS 劫持），并确保路由 `hijack-dns`。
- TUN IPv6 使用通用 ULA `fd00::1/126`；`route_exclude_address` 绕过常见局域网/链路本地段。
- **mixed 入站** `listen` 强制为 `0.0.0.0`（全接口，不仅本机）。

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
