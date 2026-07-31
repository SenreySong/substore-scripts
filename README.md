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

1. **文件**：内容为 sing-box 完整 JSON 模板（本机可参考 `examples/config.sample.json`，该目录不上传）。
2. **脚本操作**：URL 填上面的 raw 地址。
3. **参数**（只需要一个）：

| key | value 示例 | 说明 |
|-----|------------|------|
| `collectionName` | `VPS-ALL` | Sub-Store 里订阅集合的名称 |

其它行为写死在脚本内，无需再配。

## 脚本行为摘要

- 从集合 `collectionName` 拉取节点并写入模板。
- **不维护** `♾️Auto Select` 全节点 urltest 组。
- **Main Proxy** 成员：地区组 + Direct；**default = 成员列表第一项**。
- 地区组默认类型：`selector`。
- 广告 / QUIC 拦截使用 `action: reject` + `method: drop`。
- 美国子组展示名：优化 / **落地** / 家宽（兼容旧名「直连」）。
- 按 1.14 开启 `experimental.cache_file`（`store_fakeip` + `store_dns`）。
- TUN 显式 `dns_mode: hijack` + `dns_address`（1.14.0-alpha.21 接口 DNS 劫持），并确保路由 `hijack-dns`。

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
