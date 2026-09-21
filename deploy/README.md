# deploy/ —— 运维配置（不在 systemd/路径里，git 管不到那部分）

## nginx-vibe.conf

`/etc/nginx/sites-enabled/vibe.198107.xyz` 的仓库副本。这是**镜像**，不是部署源——
nginx 读的是 /etc/nginx 那份，本文件只是让改动进版本控制、可 diff、可回滚。

### 同步方向

**仓库副本 → 线上**（改了本文件之后）：

```bash
diff deploy/nginx-vibe.conf /etc/nginx/sites-enabled/vibe.198107.xyz   # 看差异
cp   deploy/nginx-vibe.conf /etc/nginx/sites-enabled/vibe.198107.xyz
nginx -t && nginx -s reload
```

**线上 → 仓库副本**（在 /etc/nginx 直接改过之后）：

```bash
cp /etc/nginx/sites-enabled/vibe.198107.xyz deploy/nginx-vibe.conf
git add deploy/nginx-vibe.conf && git commit -m "sync: nginx vibe config"
```

### 为什么要镜像

nginx 配置不在 git 里，漂移后 **forbidden_origin 会静默复发**：
`/api/` 全部 403，而每个页面各自的 catch 只渲染一行小字，
界面上表现是「按钮点了没反应」，极难定位。

必须保留的两行（`deploy/nginx-vibe.conf` 的 `location /api/` 块内）：

```nginx
proxy_set_header Origin "http://127.0.0.1:5930";
proxy_set_header Sec-Fetch-Site "same-origin";
```

后端 `orchestrator/src/api.ts` 的 `crossSiteReject()` 只接受
`127.0.0.1`/`localhost` 的 Origin。公网部署时浏览器的 Origin 是
`https://vibe.198107.xyz`，必须在这里归一化——等价于 Vite dev 代理在
`desktop/vite.config.ts` 做的事。

自动更新脚本每次 merge 后校验线上与副本一致；不一致会在 Telegram
通知里标 `❌ nginx 配置与仓库副本一致: 已漂移`。

### 凭据说明

本文件含真实的 `Bearer <VRA_API_TOKEN>`（nginx 无法读变量，必须写死）。
仓库是私有 fork（spy007111/Vibe-Research），token 轮换后需同步改
`.local/api.env` 与本文件两处。
