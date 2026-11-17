# 空间观测文件查看器

用于检查授权来源的一份原始资料并留存接收凭据。当前提供资料预览、原件接收、凭据列表与摘要回读，资料源可以在本地独立运行。

## 环境与运行

使用 Node.js 22.23.4，无第三方运行包。安装、检查与测试：

```sh
npm ci --ignore-scripts --offline
npm run build
npm test
npm run demo
```

`demo` 临时启动来源和查看服务，展示当前资料并核对保存后的原件；结束时关闭所有监听并移除临时目录。不会连接外部来源。`test` 校验已有预览、资料控制和原件持久化；测试通过只说明当前版本已有能力正常。

需要交互时分别运行 `npm run source` 与 `npm start`。来源默认监听本机 4310 端口，应用默认监听 4320；可用 `PORT`、`SOURCE_URL`、`DATA_DIR` 配置。`GET /preview` 获取预览，`POST /receipts` 接收当前资料，`GET /receipts` 查询凭据，`GET /objects/<摘要>` 回读原件。应用只允许配置到本机的资料服务。

结构化接收另设：`POST /intakes` 领取并把变量展开成带来源分类的时间线，`POST /range-requests` 按时间范围选择观测（范围外依据单列为 `supporting`），`POST /intakes/resume` 按锁定版本补齐未完成会话，`GET /sessions` 列出接收会话。时间线把物理记录（`physical`）、PREV 前值延续（`previous`）与 PAD 填充（`pad`）分开标注，缺测时段不会再看起来像反复测到同一个数。

## 目录

`source/` 负责资料源的发布日期和传输状态；`src/decode.mjs` 解释一份来源资料（含 `materialize` 结构化解析）；`src/intake.mjs` 把物理记录、稀疏规则与独立时间变量核对成三类来源分明的时间线并支持范围选择；`src/sessions.mjs` 持久化可补齐的接收会话与依据指纹；`src/catalog.mjs` 管理不可变原件及接收凭据；`src/app.mjs` 提供查看服务。资料含义及来源控制见 `docs/资料接口.md`。

## 容器

```sh
docker build -t cdf-sparse-observations .
docker run --rm --network none cdf-sparse-observations
```

镜像固定 Node.js 版本，构建期间不下载 npm 运行依赖。运行产生的原件保存在 `DATA_DIR`，不应写回来源文件。
