# substore-scripts

个人 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 脚本仓库。

## sing-box

- 路径：`sing-box/substore.js`
- 用途：sing-box 模板 + 订阅集合 → 策略组/分流整理

### Raw 链接（Sub-Store 远程脚本）

```
https://raw.githubusercontent.com/SenreySong/substore-scripts/main/sing-box/substore.js
```

CDN 备选（GitHub 慢时可试）：

```
https://cdn.jsdelivr.net/gh/SenreySong/substore-scripts@main/sing-box/substore.js
```

### 使用说明

1. Sub-Store → 文件 → 脚本操作  
2. 脚本 URL 填上述 raw 地址  
3. 参数至少需要：`collectionName`（订阅集合名）

本地修改后：

```bash
git add sing-box/substore.js
git commit -m "update substore script"
git push
```
