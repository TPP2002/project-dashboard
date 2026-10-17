# 在自己的 Linux 服务器部署协作看板

基础 Compose 启动看板服务，使用部署者自己的数据目录；可选 `compose.scheduler.yaml` 增加云端调度权威。两者不附带真实项目、外部认证或收费服务。网页默认只绑定服务器的 `127.0.0.1:6060`。原有本机模式不变；Compose 显式启用 `collaboration`。云端调度及 Windows 节点的组合仍须完成第 9 节所述的整体验证，不能仅因镜像包含代码就视为已经迁移。

认证后端与协作界面已接入，包含邀请注册、项目授权、成员领取任务，以及负责人主动信任常用浏览器。Dockerfile 会拒绝缺少协作初始化命令的源码。部署者仍须在自己的环境完成文末验收；单元测试和界面构建不代表容器、备份恢复或公网访问已经验证。

## 1. 环境与目录边界

- Linux 服务器；建议 Ubuntu 24.04 LTS。运行预算至少留给容器 1 CPU、1 GiB 内存，主机另留系统余量。构建与运行同机时建议至少 2 CPU、4 GiB 内存；已规划的 4 CPU、4 GiB 主机可作为小规模验证目标，尚无并发容量承诺。
- Docker Engine 28 或更新的受支持版本、Compose v2.24 或更新版本（`docker compose` 插件），可用的 BuildKit。低于 28 的 Docker 曾有回环发布端口仍可能被同网段访问的限制，见 [Docker 端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。部署前更新安全补丁，结合主机防火墙确认外部无法访问 6060。
- 容器使用官方 `node:24-bookworm-slim`，构建和运行均为 Node 24；宿主机无需另装 Node。`NODE_IMAGE` 可改为这个官方镜像的 `@sha256:...` 引用，由部署者填写真实 digest，不能用示例哈希。两阶段使用同一个参数。
- 至少为镜像/构建缓存预留 5 GiB，并另留数据、备份及一次完整恢复副本的空间；这是起步预算，不是已测上限。镜像与依赖下载需联网。
- 下列命令使用 Linux Bash、GNU tar、sha256sum、curl、sudo。应由获授权、能调用 Docker 的部署者执行。不要把 Docker 权限授予不可信用户。

源码目录只存代码和通用配置。`DASHBOARD_DATA_DIR` 指向部署者预先创建的目录，容器内统一映射为 `/data`；目录不存在时 Compose 报错，不替你创建。容器使用 UID/GID `1000:1000`，代码归 root 所有且根文件系统只读；仅 `/data` 持久可写，`/tmp` 是有容量上限的临时内存盘。若使用 rootless Docker 或 user namespace，需要由部署者核对宿主机对应的映射 UID，不能通过放开权限到 777 解决。

数据应全部留在这个目录内：

```text
data/
  registry.json           # 起始内容只有空 projects
  private/collaboration-auth.json      # 用户、邀请、会话和设备认证状态
  private/collaboration-auth.json.bak  # 上一次有效认证状态；不是完整数据备份
  boards/                 # 后续经正式 CLI 创建的项目账本及其活动流水
  ...                     # 锁、快照、设置和其它持久状态，一并备份
```

认证文件的具体名称由后端维护，不手写、不删掉重建。`registry.json` 后续登记的 `mainRepo`、`board`、`docsRoot` 等路径必须使用容器内的 `/data/...`，不能指向开发机路径，也不能指向 `/app`。保证所有账本及其附件都在 `/data` 内，不通过符号链接把真实数据藏到备份范围外。不挂载 Docker socket，不映射数据库端口，不把开发机主目录或调度共享盘带入容器。

## 2. 构建与首次初始化

本节只适用于**全新空数据目录**。若已存在任何数据，先按第 6 节备份，再验证原负责人的登录、用户权限和账本；不运行下面的空注册表初始化，也不重新执行负责人引导。认证损坏应停止并恢复，不能删除认证文件、换一个空目录假装原数据正常，或覆盖已有注册表。

在主控已合并并审核过的源码目录执行。以下示例将 `data` 放在源码旁；生产也可把 `.env` 中的 `DASHBOARD_DATA_DIR` 设成部署者自己的绝对路径。先创建配置，存在时立即停止：

```bash
set -euo pipefail
umask 077
test ! -e .env
cp .env.example .env
chmod 600 .env
```

编辑 `.env` 的非秘密设置，给 `DASHBOARD_IMAGE` 使用每次发布唯一的标签，`DASHBOARD_REVISION` 填已审核的源码提交号，固定 `NODE_IMAGE` digest。提交号进入镜像的 `org.opencontainers.image.revision` 标签，部署后与源码核对。不要把密码、设备令牌、邀请码、私钥放进 `.env`、构建参数、命令行参数值或 Git；不要在含秘密的终端开启 `set -x`、录屏或会话转录。

以默认 `./data` 为例，下面的 `mkdir` 遇到任何已有目录都会失败；**不要改成 `mkdir -p` 后重跑初始化**。若使用不同路径，同步修改此处 `data_dir` 与 `.env`：

```bash
set -euo pipefail
umask 077
data_dir="$PWD/data"
mkdir -- "$data_dir"
printf '%s\n' '{"schemaVersion":"1.0","projects":{}}' > "$data_dir/registry.json"
sudo chown -R 1000:1000 -- "$data_dir"
sudo chmod 700 -- "$data_dir"
sudo chmod 600 -- "$data_dir/registry.json"
docker compose config --quiet
docker compose build --pull dashboard
```

Dockerfile 对前端和独立调度包的锁文件分别执行 `npm ci`。前端执行现有 `core/scheduledJobs.cjs` 对应的 Vite 构建载荷，保留默认生产模式；调度包用锁定的 TypeScript 编译并检查公开运行依赖闭包。运行层不安装 tsx、编译器或任何 `node_modules`，只保留 Node、应用代码、调度编译产物和前端静态文件。`.dockerignore` 默认拒绝所有内容，再仅允许构建所需源码，排除历史、工位、环境文件、私有资料、已有 dist 和真实数据。

独立部署者的 Linux Docker 构建不依赖开发团队的私有调度共享盘；不要伪造 CI 环境变量或许可。**本仓施工方不得直接运行上述构建**，本机测试仍须调度，真实 Docker build/config/start/restart/恢复由主控在授权环境执行。此处列的是部署操作手册，不是本轮执行记录。

### 安全创建负责人

初始化命令：`node cli/collaboration.cjs init-owner --username <name> --password-file <protected-file>`。它仅允许首次创建，认证文件或其备份已存在时拒绝再次引导。启动命令不会自动调用它，不会重建认证库。

以下在服务器终端交互输入密码，密码不进入历史或容器环境；临时秘密文件放在 Linux 内存盘，以只读挂载交给 UID 1000。它不在构建上下文内，也不在长期数据备份里。仅在确认新目录且服务未启动时运行；若失败，保留数据排错，不循环引导：

```bash
(
  set -euo pipefail
  set +x
  umask 077
  secret_dir="$(mktemp -d /dev/shm/dashboard-owner.XXXXXXXX)"
  trap 'unset owner_password; rm -f -- "$secret_dir/password"; rmdir -- "$secret_dir"' EXIT
  read -r -p '负责人用户名: ' owner_name
  read -r -s -p '负责人密码: ' owner_password
  printf '\n'
  test -n "$owner_name" && test -n "$owner_password"
  printf '%s' "$owner_password" > "$secret_dir/password"
  unset owner_password
  sudo chown 1000:1000 -- "$secret_dir/password"
  sudo chmod 600 -- "$secret_dir/password"
  docker compose run --rm --no-deps --volume "$secret_dir/password:/run/owner-password:ro" \
    dashboard node cli/collaboration.cjs init-owner \
    --username "$owner_name" --password-file /run/owner-password
)
```

不要把占位用户名当密码，也不要用 `echo 明文密码`。不要在失败时删除认证文件。没有验证成功的负责人就不要开放成员入口。

## 3. 启停、日志和私有验证

```bash
docker compose up -d --no-build dashboard
docker compose ps
curl --fail --silent --output /dev/null http://127.0.0.1:6060/api/health
docker compose logs --tail 100 dashboard
docker compose restart dashboard
docker compose stop dashboard
# 需要再次启动时：
docker compose up -d --no-build dashboard
```

`restart: unless-stopped` 在异常退出或主机重启后按 Docker 策略恢复服务；主动 stop 后不会自行恢复。健康检查只读 `/api/health`、只看成功状态、不输出响应正文；`healthy` 仅代表 HTTP 存活，不证明登录、授权或数据恢复。`unhealthy` 本身不会触发 Docker 自动重启，不要用自动清空数据处理不健康状态。停止会留出 30 秒处理退出；备份前还需停止所有外部 CLI 写入者。

服务进程有约 1 CPU、1 GiB 内存（含 swap 总额限制）和 128 PID 的约束；`/tmp` 限 64 MiB。scrypt 登录会消耗显著内存，小服务器不得承诺无限并发；监控 OOM、健康失败、队列拒绝与磁盘占用。`json-file` 每份日志最多 10 MiB、保留 3 份，约 30 MiB/容器；更新产生的旧容器、构建缓存及备份另计。只导出经过检查的日志，不发布认证响应、Cookie、密码或设备令牌。

在自己的电脑上建立 SSH 隧道（把占位地址换成自己的 SSH 目标，不在仓库记录真实服务器）：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:6060:127.0.0.1:6060 user@your-server
```

浏览器打开 `http://127.0.0.1:6060`，与默认 `DASHBOARD_PUBLIC_ORIGIN` 完全一致。仅电脑和服务器回环端是 HTTP，中间通过 SSH 加密。确认负责人登录、空项目列表与退出，再验证服务重启后原负责人仍可登录。端口被占时同时修改 `DASHBOARD_BIND_PORT`、public origin 和隧道两端端口；不要混用 `localhost` 与 `127.0.0.1`。不能通过 `http://公网IP:6060` 输入密码，也不能把映射改成 `0.0.0.0` 作为远程访问捷径。

## 4. HTTPS、公开来源与备案边界

长期远程访问使用 HTTPS 反向代理。可选的 `compose.https.yaml` 和 `deploy/Caddyfile` 使用 Caddy 管理证书，代理经 Docker 私有网络连接 `dashboard:6060`；看板的宿主机 HTTP 映射仍只绑定回环地址。使用自己的宿主机代理时，上游为 `127.0.0.1:6060`。代理应：

1. 使用浏览器信任且名称匹配的有效证书；将 `DASHBOARD_PUBLIC_ORIGIN` 设为浏览器看到的准确 `https://主机名[:端口]`（无路径），变更后重新 `docker compose up -d --no-build dashboard`。
2. 保留原始 Host/Origin，删除传给应用的 `Forwarded` 和所有 `X-Forwarded-*` 头，包括代理默认添加的头。应用拒绝带这些头的写请求；Cookie 的 Secure 标志只依据配置的 `DASHBOARD_PUBLIC_ORIGIN`，不依赖代理头，不因来源回环就授予负责人身份。
3. 支持 SSE 长连接，关闭该流的响应缓冲并配置合适超时；限制请求体和速率。不要在访问日志记录 Cookie、Authorization、请求体或含令牌的邀请 URL；有查询参数的日志应脱敏或省略查询。
4. 用浏览器确认 HTTPS 会话 Cookie 的 `HttpOnly`、`Secure`、`SameSite` 属性，以及来源/CSRF 拒绝行为；不能为了让登录成功关闭这些检查。回环 HTTP 仅是后端契约允许的本机验证例外。

开放防火墙、TLS 和公网端口前另行获得授权并验证；不开放管理端口和 Docker socket。不把调度页面能显示当作底层调度已迁移；完整调度组合与切换要求见第 9 节。

没有域名也可以使用受信任的 IP 证书。Let's Encrypt 已公开提供 [IP 地址与 160 小时证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/)；模板显式选择其 `shortlived` ACME 配置，避免 Caddy 对 IP 默认使用私有 CA。证书有效期短，必须保留 Caddy 的证书数据、保持自动续期能访问签发机构及验证端口，并检查续期失败日志。此能力不改变服务器所在地的接入要求，也不保证某次实际签发成功。

私有验证通过且批准开放后，在源码外新建归 UID/GID 1000 所有的 0700 目录存放证书；在未入库的 `.env` 中填写 `CADDY_DATA_DIR`、`DASHBOARD_PUBLIC_HOST`（仅 IP 或主机名，不含协议、端口或路径），将 `DASHBOARD_PUBLIC_ORIGIN` 改成对应的 `https://...`。模板使用固定 Caddy 版本，实际发布可将 `CADDY_BASE_IMAGE` 固定到已验证的官方镜像摘要。代理构建只移除官方二进制的低端口文件能力：容器监听 8080/8443，运行时无需该能力。证书目录含私钥，不与项目成员共享。

```bash
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml build caddy
# 核对服务、数据路径和端口后再执行；需已批准 TCP 80/443 入站。
docker compose -f compose.yaml -f compose.https.yaml up -d --no-build dashboard caddy
docker compose -f compose.yaml -f compose.https.yaml logs --tail 100 caddy
```

TCP 80 用于证书验证和跳转，TCP 443 用于 HTTPS；模板不发布 UDP 或 Caddy 管理 API。若同时启用调度或 owner-node，所有管理命令都须附上正在使用的那些 Compose 文件，避免意外丢掉配置。使用受信任浏览器及 `curl --fail https://你的IP/api/health` 验证证书、登录、邀请和成员权限；配置校验与容器运行不代表证书已经签发。不要关闭证书校验来让测试通过。

中国内地部署需区分 IP 测试与长期服务。腾讯云 [是否需要备案 FAQ](https://cloud.tencent.com/document/product/243/19630/) 说明未解析域名、仅通过公网 IP 测试可暂不备案；其 [备案场景：IP 访问的网站](https://cloud.tencent.com/document/product/243/18910) 同时说明，内地 IP 网站长期提供互联网信息服务仍涉及备案义务，腾讯云系统不直接办理 IP 备案，需向当地主管部门咨询。邀请制、封闭成员或换端口不等于永久豁免。按服务器地域、服务用途和接入商要求确认后再对外提供服务。以上链接核对于 2026-10-18，政策变化时以官方及主管部门答复为准。

## 5. 更新与镜像回退

先记下并保留当前镜像，再按第 6 节制作停写备份。不要清理回退镜像或复用同一标签覆盖它：

```bash
set -euo pipefail
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
container_id="$(docker compose ps -q dashboard)"
test -n "$container_id"
old_image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
rollback_image="dashboard-selfhost:rollback-$stamp"
docker image tag "$old_image_id" "$rollback_image"
printf '%s\n' "$rollback_image" "$old_image_id"
```

将引用记入受保护的运维记录。取得主控已验证的新源码，检查新版本的数据格式兼容性，编辑 `.env` 使用新的唯一 `DASHBOARD_IMAGE` 标签，然后执行已获授权的 `docker compose build --pull dashboard`。停止写入、完成备份后，执行 `docker compose up -d --no-build dashboard`。核对健康、负责人登录、项目、成员权限和重启持久性，保留旧镜像到回退窗口结束。

若需要回退且确认旧镜像兼容当前数据：先停止所有写入者，再备份当前最新数据，将 `.env` 中 `DASHBOARD_IMAGE` 改成上面保留的旧引用，使用 `docker compose up -d --no-build --pull never dashboard`。不要重新 build 同一标签。若旧镜像不兼容新数据，保持停写，按第 7 节把旧备份恢复到新目录验证后再决定切换；说明回退点以后新增数据如何迁移或处理。**不能把旧数据副本解压覆盖已经产生新写入的当前目录，也不能把已过时的演练副本直接当成最新数据切换。**

## 6. 一致备份

备份必须包含整个数据目录（注册表、账本、活动流水、认证状态、设置、附件、快照），以及实际使用的 `compose.yaml`、`.env`、额外代理/Compose 配置和镜像引用。用户、邀请、会话、设备信息即便只保存哈希也属敏感数据；备份限制访问、加密离机保存，密钥与备份分开。不要上传公开对象存储、Git 或工单附件。容器日志不是数据备份。

先停止定时任务、外部 CLI 和所有其它写入者。下面从正在运行的唯一实例定位 `/data` 的真实宿主机路径，停止服务后归档，任何一步失败均停下排错。备份目录放在数据目录和源码之外：

```bash
set -euo pipefail
umask 077
backup_root=/srv/dashboard-backups
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" -- "$backup_root"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$backup_root/$stamp"
mkdir -m 700 -- "$backup_dir"
container_id="$(docker compose ps -q dashboard)"
test -n "$container_id"
data_dir="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container_id")"
test -n "$data_dir" && sudo test -d "$data_dir"
image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
rollback_image="dashboard-selfhost:backup-$stamp"
docker image tag "$image_id" "$rollback_image"
printf '%s\n' "$rollback_image" > "$backup_dir/image-ref.txt"
printf '%s\n' "$image_id" > "$backup_dir/image-id.txt"
cp -- compose.yaml .env "$backup_dir/"
# 若实际使用其它 Compose/代理配置，也复制到此备份目录并保护。
docker compose stop dashboard
# 再确认外部写入者也已停止；不要用暂停进程代替正常关闭。
sudo tar --numeric-owner -czf - -C "$data_dir" . > "$backup_dir/data.tar.gz"
# 保存精确镜像，便于换主机恢复；空间需另计。
docker image save "$rollback_image" > "$backup_dir/image.tar"
gzip -t "$backup_dir/data.tar.gz"
tar -tzf "$backup_dir/data.tar.gz" > /dev/null
(
  cd "$backup_dir"
  sha256sum data.tar.gz image.tar compose.yaml .env image-ref.txt image-id.txt > SHA256SUMS
  sha256sum --check SHA256SUMS
)
chmod 600 -- "$backup_dir/"*
# 仅在备份及校验成功后恢复服务和外部写入者。
docker compose up -d --no-build dashboard
```

自定义额外配置也应加入校验清单。归档成功只说明文件可读，必须定期执行恢复演练。监控宿主机可用空间和 inode：数据没有自动容量配额、账本也没有已测最大用户/任务数，需按实际增长设告警和保留策略。至少留一份离机备份与一个可用恢复副本的容量，不随意删除锁、认证或活动流水腾空间。

## 7. 恢复到新的空目录，验证后切换

先确定可信备份和恢复时间点；以下仅操作**新建恢复目录**，不覆盖原 data。原服务可继续运行时只能做演练；真正切换前必须安排停写并制作最终一致备份，重新恢复最终备份或经确认处理演练期间的新写入。

```bash
set -euo pipefail
umask 077
backup_dir=/srv/dashboard-backups/REPLACE_WITH_BACKUP_ID
test -d "$backup_dir"
(cd "$backup_dir" && sha256sum --check SHA256SUMS)
# 仅使用自己保管的可信归档，先核查条目没有绝对路径、.. 或外部链接。
tar -tzf "$backup_dir/data.tar.gz" | less
restore_dir="$(mktemp -d "$PWD/dashboard-restore.XXXXXXXX")"
mkdir -m 700 -- "$restore_dir/data"
cp -- "$backup_dir/compose.yaml" "$backup_dir/.env" "$restore_dir/"
sudo tar --numeric-owner --same-owner -xzf "$backup_dir/data.tar.gz" -C "$restore_dir/data"
sudo test -f "$restore_dir/data/registry.json"
sudo test -f "$restore_dir/data/private/collaboration-auth.json"
docker image load -i "$backup_dir/image.tar"
cat "$backup_dir/image-ref.txt"
printf '恢复演练目录：%s\n' "$restore_dir"
```

进入上面打印的恢复目录，编辑复制的 `.env`（不会修改生产配置）：

- `COMPOSE_PROJECT_NAME` 改成全新名称，例如 `dashboard-restore`；启动时仍显式传 `-p dashboard-restore`。
- `DASHBOARD_DATA_DIR` 改成这个**新目录内 data 的绝对路径**，绝不能仍指向原生产目录。
- `DASHBOARD_IMAGE` 改为备份 `image-ref.txt` 中的引用；`DASHBOARD_BIND_PORT=6061`，`DASHBOARD_PUBLIC_ORIGIN=http://127.0.0.1:6061`，只用于新的私有演练隧道。
- 保持 UID/GID 与原部署一致，核对恢复后目录和文件权限；若使用 user namespace，先按实际映射处理。不要自动改成 root 运行，不执行 `init-owner`，不创建空注册表。

```bash
docker compose -p dashboard-restore config --quiet
# 启动前人工核对下面配置的 /data source 为新恢复目录且端口仅 127.0.0.1:6061。
docker compose -p dashboard-restore config
# 仍未启动服务时，撤销历史备份里的登录凭据和邀请。
docker compose -p dashboard-restore run --rm --no-deps dashboard \
  node cli/collaboration.cjs revoke-all-credentials --confirm-revoke
docker compose -p dashboard-restore up -d --no-build --pull never dashboard
docker compose -p dashboard-restore ps
curl --fail --silent --output /dev/null http://127.0.0.1:6061/api/health
docker compose -p dashboard-restore restart dashboard
```

通过新的 SSH 隧道 `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:6061:127.0.0.1:6061 user@your-server` 打开回环网页。验证原负责人登录、用户与邀请、项目账本、成员权限、任务归属和进度，以及重启后仍持久化；未登录和越权请求须拒绝。不得以健康状态代替这些验证。

**恢复旧备份可能让备份以后已撤销的邀请、用户权限、设备或会话重新有效。** 在恢复目录中、服务尚未启动时，先执行 `docker compose -p dashboard-restore run --rm --no-deps dashboard node cli/collaboration.cjs revoke-all-credentials --confirm-revoke`。这会在当前有效认证库中清除所有会话、撤销全部设备和邀请，保留用户、密码哈希与项目授权；不会用更旧的认证备份替换当前状态。随后保持私有隔离，对照撤销记录重新核对授权、禁用失效用户，必要时通过受保护密码文件重置负责人密码。验证旧凭据被拒绝后才能对外切换，不通过删认证文件代替撤销。

验证通过且最终数据时间点已确认后：停止原服务和外部写入者，保留原数据及最新备份；停止演练服务，将新实例 public origin 改回批准的实际来源并重新创建容器，再将代理上游或回环端口切到新实例。切换端口前确保旧实例已释放该端口。只有一个实例能成为写入主实例，两个实例不能挂载同一数据目录。回退同样先停写、备份切换后的新写入，不用原旧目录覆盖新目录。

## 8. 主控收单清单与忽略项

每个部署都需在选定源码和实际服务器上检查以下项目。源码测试、配置校验、镜像构建和实际访问分别留有结果，不能互相代替：

1. `docker compose config`、真实构建、镜像内容/构建上下文无秘密，官方 Node 24、UID 1000、只读根、限额与回环端口实际生效。
2. 合并后的后端正确支持 mode/host/port/public origin；缺失、损坏认证状态拒绝服务，无默认公开登录或自动负责人重建。
3. 全新空 registry 初始化、安全密码文件输入、负责人登录；健康检查不输出敏感正文。
4. 前后端认证与授权、重启持久化；停止期间一致备份、新目录新项目恢复、撤销旧会话/设备、更新和镜像回退均真实验证。
5. 只保留外部部署必需能力；没有把云端调度页面作为底层调度跨平台迁移的证据。

不要提交本地 `.env`、`.env.*`（保留 `.env.example`）、实际数据目录、`private/`、`secrets/`、`backups/`、恢复目录、`compose.override.yaml` 及其它含真实地址的部署覆盖文件。归档、证书/私钥、密码输入临时文件和镜像导出也不能提交；把数据、备份、证书、秘密统一放在源码之外。`.dockerignore` 只管构建上下文，不代替 Git 忽略规则，也不保证已跟踪文件自动退出版本控制。

## 9. 云端调度与 Windows 执行节点

这部分组合正在联调。完整交付必须证明真实 Linux 权威、SSH 连接和 Windows 执行节点之间能够完成任务、取消、断线恢复及产物读取；目前不能将基础看板的私有验证结果视为该组合已通过。

云端保留唯一调度账本及派单决策，Windows 保留进程身份核验和实际命令执行。执行节点主动通过 SSH 连接服务器，无需开放 Windows 入站端口。SSH 的主机密钥必须预先核对，禁止关闭严格校验或转发代理。CLI 经本机受保护连接访问当前权威，断线时不能回退写旧共享盘。已有 AI 工具、仓库和素材留在各自节点，负责人功能经独立的 owner-node 通道访问；学校成员不能使用这些管理入口。

首次安装执行节点时，先在受保护的父目录中执行 `node dist/cli.cjs init-node --data <尚不存在的绝对目录> --machine <当前机器名> --head <安装版本的40位提交号>`，然后把返回目录填为 `node.lifecycleRoot`。该入口建立空生命周期、五态目录和带摘要的冷初始化凭据，最后才发布控制文件；任何已有目录都会被拒绝，失败留下的部分目录也不能自动覆盖。迁移已有节点继续使用原记录及迁移流程，不能用初始化命令重置旧工单。

准备两个源码之外的目录，在 `.env` 填入 `SCHEDULER_DATA_DIR` 和 `SCHEDULER_CONFIG_DIR`。前者包含实际 `sched/` 状态；后者存放私有 `cloud.json` 及每个固定 SSH 入口的配置。容器内路径分别为 `/scheduler`、`/run/scheduler`。文件归服务 UID 1000 所有，目录 0700、文件 0600，不把凭据写入环境文件。Unix socket 使用容器临时目录下的私有子目录，例如 `/tmp/scheduler-ipc`，不把过期 socket 当作持久账本恢复。

`cloud.json` 的 `version` 为 1，包含明确的 `dataRoot`、公开调度包的部署 `catalog`、`authority` 和 `transport`。入口从权威启动结果读取实际代际，再启动受保护 socket；不能把旧配置中的代际当作当前值。Windows 使用 `cloud-scheduler node --config <绝对配置路径>`，配置提供该节点的 `catalog`、`gateway` 和 `node`。各节点、机器、项目目录和菜单都由部署者填写，仓库不提供开发者的真实配置。

要让服务器在多台电脑之间分配任务，部署目录 `catalog.machines` 必须包含每台执行机，项目的 `machines` 列出允许执行该项目的机器；每台机器对应独立的受保护 SSH 入口和节点身份。按负载自动选择时省略项目的 `preferredMachines`：该字段是显式优先级，在两台机器均能接单时优先于预计完成时间。各节点上报实际负载、内存和执行槽；服务器先检查可用容量及环境，再比较运行、代码搬运和预热开销，不按任务数量平均分配。离线或过期心跳不算空闲容量。

跨机开关另存于调度数据的 `sched/_control/hub.json`，不在 `catalog` 内。首次部署时显式填写 `schema: 1`、`portable: "on"`、启用的 `projects` 和 `workTypes`；迁移时保留并核对已有配置。项目菜单必须标记可搬运，命令要能被菜单识别，且节点具备对应环境。需要历史实际占用及内存准入时沿用已验证的 `managedLoad`、`residentActualUsage`、`actualUsageAdmission`、`coresHistoryCorrect`、`memoryFloor` 配置。缺少开关时默认关闭跨机，不能只启动两个节点就认为已开启。

自动快照还需要该项目已核对的基准提交：普通项目存于 `sched/repos/<项目id>.head`，配置为 `legacyProjectId` 的项目使用数据目录根部的 `code-head.txt`。提交须在执行节点的本地仓库中存在，更新基准和代码准备走部署方已有的同步流程。安装依赖、专用设备操作、显式 `--pin` 及未识别的命令仍在提交机器执行；保留 CLI 给出的原因，不能通过伪造菜单或取消来源检查强行搬运。

完成单独配置及验证后，用同一组 Compose 文件管理两项服务：

```bash
docker compose -f compose.yaml -f compose.scheduler.yaml config --quiet
docker compose -f compose.yaml -f compose.scheduler.yaml up -d --no-build
docker compose -f compose.yaml -f compose.scheduler.yaml ps
docker compose -f compose.yaml -f compose.scheduler.yaml logs --tail 100 scheduler
```

该覆盖文件不给调度服务发布 TCP 端口；看板只读其状态目录，仅 `sched/commands` 投递目录可写。调度容器预算为 1 CPU、768 MiB 内存，与看板预算分开。健康检查只判断云端心跳是否持续更新，不替代一次真实任务执行。Windows 节点离线时页面应显示不可用，不能把它标为空闲。

调度容器通过 `flock --no-fork` 持有数据目录中的固定 `authority.flock` 文件，阻止不同容器 PID 空间同时成为写者。内核锁随进程退出释放，Node 直接接收停止信号；不要删除或替换此文件。已有调度账本的代际、租约和提交检查仍然生效，取得文件锁不会跳过业务恢复。

迁移必须先升级并验证读者和客户端，再停止旧派单员及其自动重启来源，确认没有双写后启用云端权威。停止或恢复调度服务会影响执行租约，应先停止接收新工作并等待现有工作收场。备份除了第 6 节的看板数据，还必须包括停写后的调度数据、私有配置和版本记录；恢复到新目录，保留当前权威的代际和未决任务信息，确认旧会话不能重新授权执行，再恢复节点连接。不能删除未决任务或将未知进程视为已停止来制造空队列。
