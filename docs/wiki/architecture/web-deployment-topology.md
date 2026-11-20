# Web 自托管部署拓扑与构建约束

## 背景

项目有三条交付路径：桌面版（后端以子进程内嵌）、Docker 自托管 Web、宿主机源码运行。桌面版是普通用户主路径，自托管 Web 面向服务器/NAS 用户。

在桌面版成熟后，自托管路径长期缺少一个可执行的完整编排：仓库里只有 `Dockerfile.api`、`Dockerfile.web` 和一个只起向量库的独立 Qdrant 编排（后被完整编排取代并删除），没有把 PostgreSQL、Qdrant、后端、Web 组织到一起的编排文件，也没有说明空库如何初始化。结果是部署者容易踩到两个已知陷阱：在空 PostgreSQL 上直接跑 `prisma migrate deploy`（会失败），以及把后端端口直接暴露到公网。

本次部署还在受限环境里暴露了几类与代码无关但会反复出现的构建约束：镜像仓库不可达、宿主 glibc/Python 版本过旧无法编译原生模块、宿主 Docker 的默认 seccomp 策略过严。这些约束都需要写清楚归属边界，否则每次部署都会重新诊断一遍。

## 决策

1. **编排文件独立于镜像构建**：使用 `infra/docker-compose.deploy.yml`，不修改 `Dockerfile.web` 的镜像内置用途。Web 容器改用官方 `nginx` 镜像加只读绑定挂载，而不是构建 `Dockerfile.web`。
2. **前端产物在宿主机编译，以只读卷注入 nginx**：静态资源更新只需重新编译并刷新浏览器，不需要重建镜像。这也让"复用本机已有镜像"在离线环境里成立。
3. **后端镜像基础镜像固定为 `node:24-alpine`**：与本机已有镜像对齐，同时通过 `NODE_IMAGE` 构建参数保留切换空间。
4. **唯一对外端口是 Web 的 `8080`**：后端监听容器内 `0.0.0.0:3000` 但不发布宿主机端口；数据库与向量库只在内部网络可达。
5. **迁移是编排内的一次性任务**：`migrate` 服务挂 `tools` profile，入口固定为 `scripts/deploy-prisma-postgres.cjs`。
6. **镜像名直接写在编排的 `image:` 字段，不留 `.env` 变量**：postgres/nginx 固定取内网仓库 `10.62.107.200:30085/agentops/middleware/` 的 arm64 标签，后端与迁移用本机构建的 `ai-novel-api:latest`；qdrant 在内网仓库没有对应 repository，保留 Docker Hub 官方名。不留变量是为了避免“编排默认值与 .env 覆盖值”两处事实源。

## 当前规则

### 访问边界

- 只有 `web` 服务可以带 `ports`。`api`、`postgres`、`qdrant` 一律不发布宿主机端口。
- `api` 必须设 `HOST=0.0.0.0`，否则 nginx 的反向代理无法连上（容器内默认只绑回环地址）。
- `ALLOW_LAN=false` 与访问令牌闸门在自托管拓扑下**仍然保留**。端口不外露是网络边界，令牌是应用边界，两者是纵深防御，不能因为"只有内网可达"就关掉其中一个。
- 需要收窄监听面时改 `WEB_BIND_ADDR=127.0.0.1`，不要改后端端口映射。

### 前端与 nginx 配置

- Web 配置使用 `infra/nginx/ai-novel-web-proxy.conf`（SPA + `/api` 反代）。`infra/nginx/ai-novel-web.conf` 是 `Dockerfile.web` 的内置配置，只伺服静态文件、不含反代，两者不可混用。
- SPA 路由回退必须是 `try_files $uri $uri/ /index.html`。缺少回退时，刷新 `/novels` 这类深链会得到 404。
- 入口页响应必须带 `Cache-Control: no-cache`。Vite 产物文件名带内容哈希，因此 `no-cache` 足够安全：入口页每次协商，哈希资源命中长缓存。若入口页被强缓存，升级后用户仍加载旧资源清单。
- `/api/` 反代必须保留 `proxy_buffering off`。LLM 流式输出和 SSE 进度推送依赖它，缓冲会让首字延迟到整段生成完成，长任务还会被截断。这条是运行契约，不是性能调优。
- **安全头只在静态资源 location 内声明**。后端已通过 helmet 给 API 响应设置安全头，反代层再对 `/api/` 添加会产生同名双头。
- 在某个 `location` 内声明 `add_header` 后，server 级的 `add_header` 对该 location **全部失效**（nginx 继承规则）。因此每个带 `add_header` 的 location 都要把安全头完整重复一遍，不能只依赖 server 级声明。

### 后端镜像构建

- 基础镜像是 musl（alpine）。`better-sqlite3` 没有 musl 预编译包，构建阶段必须安装 `python3 make g++` 现场编译；运行阶段需要 `libstdc++` 让编译产物可加载。
- `Dockerfile.api` 的 runtime 阶段安装 `postgresql-client`，让迁移任务能在这一个镜像里完成 `psql` 安全探查，不额外引入工具镜像。
- `shared` 包的 COPY 清单必须覆盖 `shared/types`、`shared/utils` 和入口文件。漏掉 `shared/utils` 会让类型检查在容器内报 `TS2307`，而宿主机因为目录完整不会复现，属于镜像构建专属故障。
- 宿主机安装依赖只 filter 到 `shared` 与 `client`。后端已容器化，在宿主机装 `server` 依赖会触发原生模块源码编译，在 Python 偏旧的宿主上直接失败。

### 数据库初始化

- 空 PostgreSQL 库必须走 `scripts/deploy-prisma-postgres.cjs`。历史迁移目录混有 SQLite 方言 SQL，裸 `prisma migrate deploy` 在空 PG 上不可用。
- 先用 `--dry-run` 取分类结论（空库 / 已被管理 / 遗留库 / 存在失败记录），再对空库执行 `--fresh-empty-ok`。脚本只在确认不会损坏既有数据时才应用 schema 并把历史目录登记为已应用。
- 不允许用 `prisma migrate reset`、删卷、或手工 stamp 来"绕过"脚本报出的 legacy / failed-history 判定。这类判定说明目标库不是脚本可安全接管的对象，必须人工核对。

## 示例

推荐：

```bash
cd infra && cp .env.example .env          # 镜像名、端口、挂载路径全部在 .env 覆盖
docker build -f Dockerfile.api -t ai-novel-api:latest .
docker-compose -f docker-compose.deploy.yml --profile tools run --rm migrate --dry-run
docker-compose -f docker-compose.deploy.yml up -d
```

不推荐：

- 把镜像名改回 `.env` 变量加默认值的形式，形成两处事实源。
- 用 `Dockerfile.web` 构建镜像后再挂 nginx 配置文件，两个配置来源会互相覆盖。
- 在空库上直接 `prisma migrate deploy`，或为了让后端"先起来"跳过迁移。
- 把 `api` 的 3000 端口发布到宿主机以便调试，然后忘记收回。
- 在 `location /api/` 里追加 `add_header X-Content-Type-Options`，与后端 helmet 形成重复头。

## 失败模式

| 表现 | 根因 | 排查/处理 |
| --- | --- | --- |
| `postgres`、`qdrant` 反复重启，日志 `Operation not permitted` / `OS can't spawn worker thread` | 宿主 Docker < 20.10.10，默认 seccomp 未放行 `clone3`，glibc 与 Rust 程序起线程失败 | 编排已对这两个服务加 `security_opt: [seccomp:unconfined]`；升级 Docker 后应删除该放宽。alpine/musl 与 Debian nginx 不受影响，可用它们做对照实验定位 |
| 镜像 `pull` 失败（registry connection reset） | 环境无法访问 Docker Hub | 用本机已有镜像 `docker tag` 补短名，在 `.env` 覆盖镜像变量 |
| 后端构建报 `Cannot find module './utils/...'` | `Dockerfile.api`/`Dockerfile.web` 未 COPY `shared/utils` | 补齐 COPY，不要在 `shared/index.ts` 里删导出规避 |
| 宿主机 `pnpm install` 卡在 `better-sqlite3` 源码编译并报 Python `SyntaxError` | 宿主 Python 过旧，node-gyp 脚本用了新语法 | 改用 workspace filter 只装前端依赖 |
| 页面能打开、接口全 401 | 令牌闸门输入值与后端 `AI_NOVEL_ACCESS_TOKEN` 不一致 | 对齐 `.env` 后 `up -d api` |
| 升级后界面不更新 | 入口页被强缓存 | 检查 `/` 响应是否 `Cache-Control: no-cache` |
| 流式输出整段等待或直接断流 | 反代开缓冲，或前置网关超时过短 | 用本目录配置；`/api` 读超时已放宽到 3600s，链路更长需同步调大上层 |
| `/api/health` 返回 200 就认为鉴权正常 | 该端点在 `middleware/auth.ts` 的公开白名单里，仅供容器健康检查 | 用 `/api/novels` 验证：无令牌 401、带令牌 200 |

## 相关模块

- `Dockerfile.api`、`Dockerfile.web`
- `infra/docker-compose.deploy.yml`、`infra/nginx/ai-novel-web-proxy.conf`、`infra/README.md`、`infra/.env.example`
- `scripts/deploy-prisma-postgres.cjs`
- `server/src/config/database.ts`（`AI_NOVEL_DATABASE_MODE` / `DATABASE_URL` 读取）
- `server/src/app.ts`（`app.use("/api", authMiddleware)` 统一拦住 API）、`server/src/routes/health.ts`
- `server/src/middleware/auth.ts`（访问令牌校验；`GET /api/health` 在其公开白名单里，因此健康检查不需要令牌）
- `client/src/lib/constants.ts`（`VITE_API_BASE_URL` 默认同源 `/api`）
- `docs/wiki/architecture/access-token-boundary.md`
- `docs/wiki/architecture/configuration-conventions.md`
- `docs/wiki/architecture/desktop-api-assets.md`（桌面端是另一套交付拓扑，不要与本篇混用）

## 来源文档

- 部署手册：`../../../infra/README.md`
- 开发者部署说明：`../../../mintlify-docs/developers/deployment.mdx`
- 公开安装说明：`../../public/installation.md`
