# 前后端分离自托管部署

面向在服务器或 NAS 上跑 Web 服务的场景。桌面版用户不需要本目录。

与其它编排文件的分工：

| 文件 | 用途 |
| --- | --- |
| `docker-compose.deploy.yml` | 本手册的完整编排：PostgreSQL + Qdrant + 后端 + Web |
| `docker-compose.qdrant.yml` | 只单独起一个 Qdrant，给宿主机源码运行的后端用 |
| `nginx/ai-novel-web.conf` | 镜像内置的 Web 配置（`Dockerfile.web` 使用），只伺服 SPA，不代理 API |
| `nginx/ai-novel-web-proxy.conf` | 本编排使用的 Web 配置，SPA + `/api` 反向代理到后端容器 |
| `.env.example` | 变量模板，复制为 `.env` 后填写 |

## 架构约定

```
浏览器 ──▶ web (nginx, 对外 8080)
              ├─ 静态资源：宿主机 client/dist 只读挂载
              └─ /api/   ─▶ api (node, 3000，仅内网)
                              ├─ postgres:5432  命名卷 ai-novel-postgres
                              ├─ qdrant:6333    命名卷 ai-novel-qdrant
                              └─ 图片资产       命名卷 ai-novel-storage
```

只有 `web` 发布端口。后端监听容器内 `0.0.0.0:3000` 但不映射到宿主机，因此外部不可直接访问；`ALLOW_LAN=false` 与访问令牌仍然保留，作为纵深防御。

## 前置条件

- Docker 与 docker-compose v2。
- Node.js 与 pnpm 满足根 `package.json` 的 `engines`，仅用于在宿主机打包前端。
- 本机已有的镜像（名称可在 `.env` 覆盖，不需要联网拉取）：
  - 后端基础镜像 `node:24-alpine`（`Dockerfile.api` 的默认 `NODE_IMAGE`）
  - `postgres:16.15`、`qdrant/qdrant:v1.19`、`nginx:1.30.2`

如果本机镜像带着私有仓库前缀（例如 `docker.m.daocloud.io/library/node:24-alpine`），先用 `docker tag` 补一个短名，再在 `.env` 里覆盖镜像变量。

## 部署步骤

在仓库根目录执行，`infra/` 下的命令先 `cd infra`。

### 1. 准备变量

```bash
cd infra
cp .env.example .env
```

必填两项：`POSTGRES_PASSWORD`、`AI_NOVEL_ACCESS_TOKEN`。令牌生成一条随机的强值即可：

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'
```

`.env` 已被 `.gitignore` 忽略，不要提交。

### 2. 构建后端镜像

```bash
docker build -f Dockerfile.api -t ai-novel-api:latest .
```

`Dockerfile.api` 在 `node:24-alpine`（musl）上编译依赖：`better-sqlite3` 没有 musl 预编译包，需要容器内的 `python3 make g++` 现场编译；Prisma 引擎按 `linux-musl-openssl-3.0.x` 下载。基础镜像不同时可加 `--build-arg NODE_IMAGE=...`。

### 3. 宿主机打包前端

前端不进镜像，产物以只读卷挂载：

```bash
pnpm install --frozen-lockfile --filter @ai-novel/shared --filter @ai-novel/client
pnpm --filter @ai-novel/shared build
pnpm --filter @ai-novel/client build
```

产物在 `client/dist`，由 `.env` 的 `CLIENT_DIST_PATH`（默认 `../client/dist`）指向。

只安装 `shared` 与 `client` 两个 workspace 是有意为之：`server` 的依赖里有 musl/glibc 原生模块，宿主机 Python 偏旧时 `better-sqlite3` 源码编译会失败，而后端已经容器化，不需要在宿主机装它。

前端在宿主机编译，因此 `VITE_API_BASE_URL` 无需设置：Web 构建默认把 API 指向同源 `/api`，正好命中 nginx 的反代。只有前后端不同源时才需要显式指定。

### 4. 起数据库与向量库，执行迁移

```bash
docker-compose -f docker-compose.deploy.yml up -d postgres qdrant
docker-compose -f docker-compose.deploy.yml --profile tools run --rm migrate --dry-run
docker-compose -f docker-compose.deploy.yml --profile tools run --rm migrate --fresh-empty-ok
```

必须走 `migrate` 这个一次性任务，不要在空库上直接 `prisma migrate deploy`：历史迁移目录里混有 SQLite 方言 SQL，裸 deploy 在空 PostgreSQL 上会失败。脚本按库的真实状态分类（空库 / 已被管理 / 遗留库 / 存在失败记录），只在不损坏数据的前提下应用当前 schema 并把历史目录登记为已应用。`--dry-run` 只做分类不改数据，先看结论再执行是推荐做法。

### 5. 启动后端与前端

```bash
docker-compose -f docker-compose.deploy.yml up -d
docker-compose -f docker-compose.deploy.yml ps
```

### 6. 验证

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/            # 200：SPA 可加载
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/novels   # 401：访问令牌闸门生效
curl -s -H "Authorization: Bearer $(grep '^AI_NOVEL_ACCESS_TOKEN=' .env | cut -d= -f2)" \
  http://127.0.0.1:8080/api/novels                                          # 200：后端 → Prisma → PostgreSQL 可读
docker-compose -f docker-compose.deploy.yml logs --tail=50 api
```

`/api/health` 不要求令牌，它只用于容器健康检查，不能用它验证鉴权。

浏览器打开 `http://<服务器地址>:8080`，在访问令牌闸门填入 `AI_NOVEL_ACCESS_TOKEN`，随后到系统设置配置模型供应商并跑一次连接测试。模型密钥保存在 PostgreSQL 里，容器重建不会丢；也可以用环境变量注入：在 `infra/api.env` 里写 `OPENAI_API_KEY=` 这类条目即可（该文件不存在时编排会跳过）。首次启动会自动写入内置创作资源（流派、故事模式、写法模板、反 AI 规则），日志里的 `built-in creative resources bootstrapped` 就是数据库写入成功的证据。

## 升级

```bash
git pull
docker build -f Dockerfile.api -t ai-novel-api:latest .
pnpm --filter @ai-novel/shared build && pnpm --filter @ai-novel/client build
docker-compose -f docker-compose.deploy.yml up -d                       # 重建 api 容器
docker-compose -f docker-compose.deploy.yml --profile tools run --rm migrate
```

先备份再升级：

```bash
docker-compose -f docker-compose.deploy.yml stop api web
docker run --rm -v ai-novel-web_ai-novel-postgres:/db -v "$PWD:/out" postgres:16.15 \
  pg_dump -U ai_novel -d ai_novel -F c -f /out/backup.dump
docker-compose -f docker-compose.deploy.yml start api web
```

数据库文件不要在运行时直接拷贝或替换；停容器、备份卷之后再迁移。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 页面能开、接口全 401 | 令牌闸门输入的 `AI_NOVEL_ACCESS_TOKEN` 与后端不一致，改 `.env` 后 `up -d api` |
| PostgreSQL 或 Qdrant 反复重启，日志 `Operation not permitted` | 宿主 Docker 低于 20.10.10，默认 seccomp 未放行 `clone3`；本编排已对这两个服务放宽 seccomp，升级 Docker 后可移除该配置 |
| 漫画/分镜图片 404 | 资源路径都在 `/api` 下；若自定义过 nginx 配置，确认 `location /api/` 代理存在 |
| 流式输出卡住不返回 | nginx 需要 `proxy_buffering off`，用本目录的 `ai-novel-web-proxy.conf`，不要换成镜像内置配置 |
| 长任务中途断流 | 反代读超时已放宽到 3600s；若前置还有网关，需要同步调大该层超时 |
| `migrate` 报 legacy / failed-history | 脚本判定该库不是它管理的对象或存在失败迁移记录，保留证据手工核对，脚本不会替你 stamp 或 reset |
| 首次起后端容器一直 unhealthy | 看 `logs api`：通常是迁移没跑，或 `DATABASE_URL` 连不到 `postgres` 服务名 |

## 备份要点

- `ai-novel-postgres`：小说正文、设定、任务状态、模型配置。
- `ai-novel-storage`：生成的图片资产。
- `ai-novel-qdrant`：向量索引，丢了可重建，但重新索引需要消耗模型调用。
