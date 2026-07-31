# substore-scripts

个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 脚本仓库。

## sing-box

- 路径：`sing-box/substore.js`
- 用途：sing-box 模板 + 订阅集合 → 策略组/分流整理

### Raw 链接（Sub-Store 远程脚本）

```
https://raw.githubusercontent.com/SenreySong/substore-scripts/main/sing-box/substore.js
```

CDN 备选：

```
https://cdn.jsdelivr.net/gh/SenreySong/substore-scripts@main/sing-box/substore.js
```

### 参数

只需要一个：

| key | value 示例 | 说明 |
|-----|------------|------|
| `collectionName` | `VPS-ALL` | Sub-Store 订阅集合名 |

其它行为（selector、Main 标签、测速 URL 等）均写死在脚本内，无需再配。

### 使用说明

1. Sub-Store → 文件 → 脚本操作  
2. 脚本 URL 填上述 raw 地址  
3. 参数只填 `collectionName`

### 本地修改后推送

```bash
git add sing-box/substore.js
git commit -m "update substore script"
git push
```
