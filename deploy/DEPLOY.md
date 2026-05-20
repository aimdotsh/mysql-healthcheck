# MySQL Healthcheck SaaS — Docker 部署指南

适用于 v5.0.3+。底层是 `docker-compose.yml` + 可选 `nginx` 反向代理。

## TL;DR（最快上线）

```bash
# 1. 在 Linux 服务器拉代码
sudo mkdir -p /opt/mysql-healthcheck && sudo chown $USER /opt/mysql-healthcheck
cd /opt/mysql-healthcheck
git clone -b SaaS https://github.com/aimdotsh/mysql-healthcheck.git .

# 2. 准备数据目录
sudo mkdir -p /var/lib/mysql-healthcheck
sudo chown 1001:1001 /var/lib/mysql-healthcheck   # 容器内 uid=1001

# 3. （可选）配置环境变量
cp deploy/env.example .env
# 编辑 .env，至少改 API_KEY

# 4. 起服务
docker compose up -d
docker compose logs -f       # Ctrl+C 不会停容器，只是退出日志查看

# 5. 验证
curl http://127.0.0.1:3000/api/v1/health
# {"version":"5.0.3", ...}
```

之后浏览器访问 `http://<服务器IP>:3000`。

> 注意：默认 compose 把端口绑在 `127.0.0.1:3000`，**外网访问不到**。要么改成 `0.0.0.0:3000:3000`（不推荐 — 无 HTTPS / 无鉴权），要么配 nginx 反向代理（推荐，见下）。

---

## 完整步骤

### 1. 服务器准备

- **OS**：Ubuntu 22.04 / Debian 12 / RHEL 9 / Rocky 9（任何能跑 Docker 24+ 的发行版）
- **Docker**：≥ 24.0（含 Compose plugin）
- **资源**：最低 2 vCPU / 4 GB RAM / 20 GB 磁盘（生成报告时单实例峰值 ~1.5 GB；存储增长按上传量）

如果没有 Docker：

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # 让当前用户免 sudo，需重新登录生效

# CentOS / RHEL / Rocky
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

### 2. 拉代码

```bash
sudo mkdir -p /opt/mysql-healthcheck && sudo chown $USER /opt/mysql-healthcheck
cd /opt/mysql-healthcheck
git clone -b SaaS https://github.com/aimdotsh/mysql-healthcheck.git .
```

### 3. 数据目录

```bash
sudo mkdir -p /var/lib/mysql-healthcheck
sudo chown 1001:1001 /var/lib/mysql-healthcheck   # Dockerfile 里 USER mysqlhc uid=1001
```

> 若想用 docker volume 而非 bind mount，编辑 `docker-compose.yml` 启用 `volumes:` 段。

### 4. （可选）环境变量

```bash
cp deploy/env.example .env
vim .env
```

至少建议改：
- `API_KEY`：长随机字符串。设置后所有 `/api/v1/*` 调用要带 `Authorization: Bearer <key>`
- `MAX_FILE_SIZE_MB`：单文件上限。默认 50 MB；若客户 collector 输出很大可调高

### 5. 起服务

```bash
docker compose up -d            # 构建 + 启动（首次 build 慢，~3-5 min）
docker compose ps               # 看状态
docker compose logs -f saas     # 看日志，Ctrl+C 退出查看
```

健康检查：
```bash
docker inspect mysql-hc-saas --format='{{.State.Health.Status}}'
# 期望：healthy
```

### 6. Nginx 反向代理（生产推荐）

服务器上装 nginx + certbot：

```bash
# Ubuntu / Debian
sudo apt install -y nginx certbot python3-certbot-nginx

# RHEL / Rocky
sudo dnf install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

复制 nginx 配置：

```bash
sudo cp deploy/nginx.conf.sample /etc/nginx/conf.d/mysql-healthcheck.conf
sudo vim /etc/nginx/conf.d/mysql-healthcheck.conf  # 改 server_name 为你的域名
sudo nginx -t && sudo systemctl reload nginx
```

申请 HTTPS 证书（域名要先解析到本机 IP）：

```bash
sudo certbot --nginx -d mysql-hc.example.com --agree-tos -m admin@example.com
# certbot 自动改 nginx 配置 + 加 HTTPS + 自动续期
```

### 7. 防火墙

```bash
# ufw (Ubuntu/Debian)
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# 3000 端口不开放，已绑 127.0.0.1，只接受本机请求

# firewalld (RHEL/Rocky)
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

---

## 日常运维

### 升级新版本

```bash
cd /opt/mysql-healthcheck
git pull origin SaaS
docker compose build               # 重新构建镜像
docker compose up -d               # 滚动重启
docker image prune -f              # 清理旧镜像
```

或一行命令（合并到 `deploy/upgrade.sh`）：

```bash
./deploy/upgrade.sh
```

### 查日志

```bash
docker compose logs -f saas        # 实时
docker compose logs --tail=200 saas  # 最近 200 行
```

容器内日志会自动按 `20m × 5 files` 轮转（compose 已配 logging driver），不会撑爆磁盘。

### 备份

数据全在 `/var/lib/mysql-healthcheck`，简单 tar 即可：

```bash
sudo tee /etc/cron.daily/mysql-hc-backup <<'EOF'
#!/bin/sh
DATE=$(date +%Y%m%d)
tar -czf /backup/mysql-hc-$DATE.tar.gz -C /var/lib mysql-healthcheck
find /backup -name 'mysql-hc-*.tar.gz' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/mysql-hc-backup
```

只备份 `history/` 也行（最关键的元数据；uploads/reports 丢了顶多重传一次）。

### 监控

`docker compose ps` 看健康状态。要接 Prometheus 可以加：

```yaml
# docker-compose.yml 加 service
prometheus-node-exporter:
  image: prom/node-exporter
  network_mode: host
  pid: host
  restart: unless-stopped
```

应用层没埋 metrics，需要的话提需求。

### 故障排查

| 现象 | 排查 |
|---|---|
| `docker compose up` 失败 | `docker compose logs saas` 看具体报错 |
| `Cannot find module '@resvg/resvg-js'` | 镜像构建时未装好原生模块，重新 `docker compose build --no-cache` |
| 上传 413 Request Entity Too Large | nginx `client_max_body_size` 不够；或 multer `MAX_FILE_SIZE_MB` 不够 |
| 容器内时区是 UTC | docker-compose.yml 加 `TZ: Asia/Shanghai` |
| `Permission denied` 写 `/data` | `/var/lib/mysql-healthcheck` 没 chown 给 uid 1001 |
| 重启后历史记录丢了 | 没挂 volume，或 volume 路径不对 |
| Healthcheck 一直 unhealthy | `docker exec mysql-hc-saas wget --spider http://localhost:3000/api/v1/health` 手动测 |

---

## 安全清单

- [ ] `API_KEY` 已设置（除非完全内网）
- [ ] HTTPS 已启用（certbot 自动续期）
- [ ] 防火墙只放 80/443
- [ ] `/var/lib/mysql-healthcheck` 权限正确（uid 1001）
- [ ] 备份 cron 已就位
- [ ] Docker 容器以非 root 用户运行（Dockerfile 已配，无需额外处理）
- [ ] 日志轮转生效（compose 已配，无需额外处理）

---

## 卸载

```bash
docker compose down                # 停服务 + 删容器
docker image rm mysql-healthcheck-saas:latest
sudo rm -rf /var/lib/mysql-healthcheck   # 删数据（不可逆，谨慎）
sudo rm -rf /opt/mysql-healthcheck       # 删源码
sudo rm /etc/nginx/conf.d/mysql-healthcheck.conf  # 删 nginx 配置
```
