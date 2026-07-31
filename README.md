# substore-scripts

个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 脚本与 sing-box 配置样例。

用于：在 **配置模板** 基础上，合并 Sub-Store **订阅集合** 的节点，整理地区策略组与分流规则，输出可用的 sing-box 配置。

## 目录结构

```text
substore-scripts/
├── README.md
├── sing-box/
│   └── substore.js          # Sub-Store 脚本（远程 URL 指向此文件）
└── examples/
    └── config.sample.json   # sing-box 模板样例（无真实节点密钥时可对照）
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

1. **文件**：内容为 sing-box 完整 JSON 模板（可参考 `examples/config.sample.json` 结构）。
2. **脚本操作**：类型选脚本，URL 填上面的 raw 地址。
3. **参数**（只需要一个）：

| key | value 示例 | 说明 |
|-----|------------|------|
| `collectionName` | `VPS-ALL` | Sub-Store 里订阅集合的名称 |

其它行为写死在脚本内，无需再配 `groupType` / `urltestUseNodeTags` 等。

4. 预览或保存生成结果，再导入官方 sing-box / 其它客户端。

## 脚本行为摘要

- 从集合 `collectionName` 拉取节点并写入模板。
- **不维护** `♾️Auto Select` 全节点 urltest 组。
- **Main Proxy** 成员：地区组 + Direct；**default = 成员列表第一项**。
- 地区组默认类型：`selector`。
- 广告 / QUIC 拦截使用 `action: reject` + `method: drop`（减少 `outbound/block` 的 UDP 报错噪音）。
- 美国子组展示名：优化 / **落地** / 家宽（兼容旧名「直连」）。

## 样例配置说明

`examples/config.sample.json` 为模板结构参考，包含：

- DNS / FakeIP
- TUN（含 IPv6）
- 分流 rule_set 与 route.rules
- 策略组骨架（Main、地区、业务组）

**注意：**

- 样例中的节点 tag 名为占位/脱敏后的结构展示，使用前请用自己的订阅集合生成真实配置。
- 不要把含 UUID、密码的完整配置提交到公开仓库。

## 本地开发

```bash
cd ~/code/github/substore-scripts

# 改脚本
vim sing-box/substore.js

# 改样例
vim examples/config.sample.json

git add -A
git commit -m "更新说明"
git push origin main
```

推送后 raw 一般几分钟内更新；jsDelivr 可能有缓存，可用 raw 或带 commit hash 的 CDN 链接。

## Git 远程

```text
origin  https://github.com/SenreySong/substore-scripts.git
```

分支：`main`

## 相关客户端

- [sing-box](https://github.com/SagerNet/sing-box)
- [Sub-Store](https://github.com/sub-store-org/Sub-Store)
