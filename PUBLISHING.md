# 发布指南 / Publishing guide

这个包已经具备发布条件（`npm pack` 干净、`dsh.bundle` 与 `dsh.client` 都已声明）。但要真正让其他人能一键安装，需要**两步**，而这两步都需要你的凭据——我这边没有 npm 登录态，也没有 GitHub 访问权限。

## 发布路径

```
npm publish  →  awesome-dsh-plugin 收录  →  用户在「设置 → 插件市场」里一键安装
```

`dshmarket`（已装在你的 profile 里）只从 [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) 的精选目录读取插件。所以**光发 npm 不会被市场发现**，必须再提交一次收录。

---

## 第 1 步：发布到 npm

### ⚠️ 先看这个：本机默认会发错地方

本机 `.npmrc` 里写的是**腾讯镜像**：

```
registry=https://mirrors.tencent.com/npm/
```

镜像是**只读**的，`npm publish` 打到镜像上**一定失败**（而且 `npm login` 也会让你登录镜像，登录不上去）。

**这个坑已经堵好了**：`package.json` 里固定了发布目标，不管 `.npmrc` 指向哪里都发到官方源：

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

你可以自己验证一行——它必须打印 `registry.npmjs.org`：

```sh
npm publish --dry-run 2>&1 | grep 'Publishing to'
```

### 完整命令

在**你自己的终端**里执行（不是在 DSH 对话里）：

```sh
# 1. 进入包目录
cd /vol2/@apphome/fn-deepseek-harness/profiles/日常/dsh-model-relay

# 2. 登录官方源（见下方三种方式，选一种）
npm login --registry=https://registry.npmjs.org/

# 3. 确认登录身份
npm whoami --registry=https://registry.npmjs.org/

# 4. 先干跑一次，确认要发的文件清单和发布目标
npm publish --dry-run

# 5. 正式发布
npm publish
```

`publishConfig` 已经写好了 `access: public`，所以**不需要**再加 `--access public`。

### 登录的三种方式

**A. 交互式（最省事）**

```sh
npm login --registry=https://registry.npmjs.org/
```

会提示输入用户名、密码、邮箱。npm 11 默认走浏览器授权（`--auth-type=web`）：它打印一个 URL，你在能上网的浏览器里打开、点确认即可。**NAS 上没有浏览器也没关系**，把 URL 复制到你自己电脑上打开。

**B. 用户名密码直接登录（脚本友好）**

```sh
npm login --registry=https://registry.npmjs.org/ --auth-type=legacy
```

**C. 用 Access Token（最适合无浏览器的服务器）**

⚠️ **注意 token 类型**：npm 现在的 token 分 **Classic** 和 **Granular** 两种，Classic 已被废弃/吊销。要发新包，必须建 **Granular Access Token**，并且**勾选 "Bypass 2FA"**——否则即使 token 有效，`npm publish` 仍会报 E403（见下节）。旧资料里的 "Automation token" 是已过时的叫法。

先去 <https://www.npmjs.com/settings/~/tokens> → **Generate New Token** → **Granular Access Token**：

| 选项 | 该选什么 | 为什么 |
| --- | --- | --- |
| Token name | 随意，如 `nas-publish` | 便于日后识别/吊销 |
| Expiration | 按需（可设 90 天） | 长期 token 风险更高 |
| **Bypass 2FA** | **必须勾选** | 不勾就会 E403 |
| Packages and scopes | 选 **All packages**（或至少 Read and write） | 首次发布新包必须能创建新包 |
| CIDR | 可留空 | 留空则不限制来源 IP |

建好后：

```sh
npm config set //registry.npmjs.org/:_authToken=npm_你的token
npm whoami --registry=https://registry.npmjs.org/
```

token 会写进 `~/.npmrc`（即 `/vol2/@apphome/fn-deepseek-harness/.npmrc`）。**这是敏感文件，别提交、别外传。**

> 若你以 `root` 跑发布（日志在 `/root/.npm/_logs/`），token 会写进 `/root/.npmrc`，**与服务账号的那份是两套**。两个身份要各自配置，别混淆。

### E403：2FA 拦住发布（本次实际遇到）

完整报错：

```
npm ERR! code E403
npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/dsh-model-relay
npm ERR! Two-factor authentication or granular access token with bypass 2fa enabled
       is required to publish packages.
```

**先分清两种错误**，它们的修法完全不同：

| 错误码 | 含义 | 说明 |
| --- | --- | --- |
| `ENEEDAUTH` | **没登录** | 需要先 `npm login` 或配 token |
| `E403` + 上面这段 | **登录成功，但缺 2FA 豁免** | 就是本次的情况 |

看到 E403 说明**认证本身没问题**——你的账号开了 2FA，而 npm 要求发布动作要么现场提供 OTP，要么用一个明确允许绕过 2FA 的 granular token。

**修法一：现场给 OTP（最快，临时用）**

```sh
npm publish --otp=123456      # 填你验证器 App 里的 6 位码
```

`--otp` 的码**只有效一次**，且 30 秒就换。所以每次都重新取码。

**修法二：建一个 bypass-2FA 的 granular token（推荐，一劳永逸）**

按上节方式 C 建 token 时**勾上 "Bypass 2FA"**，配好后直接 `npm publish`，不用再输 OTP。

**修法三：用 CLI 建（无需打开网页）**

```sh
npm token create --bypass-2fa --registry=https://registry.npmjs.org/
```

会提示输入密码和 OTP，成功后打印 token。**这串 token 只显示这一次**，立刻保存。

> 排错时别被 npm 那句 "or one of your dependencies are requesting a package version that is forbidden" 误导——那是 npm 对 403 的通用兜底文案，跟依赖无关。真正的判据是**上面那行** `Two-factor authentication or granular access token...`。

### 包名占用

`dsh-model-relay` 目前**未被占用**（已核实官方 registry 返回 404）。发布前可再确认一次：

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-model-relay
# 404 = 可用
```

### 发布前自检

```sh
npm pack --dry-run     # 应恰好 9 个文件，无 test/ 杂物
npm run check          # 三个文件语法检查
npm test               # 48 项测试
```

`npm pack --dry-run` 期望的输出：

```
LICENSE  README.md  compatibility.json  cordis.patch.yml
lib/client.js  lib/index.d.ts  lib/index.js  lib/keys.js  package.json
```

### 发布之后

```sh
# 确认已上线
npm view dsh-model-relay version
```

用户即可安装：

```sh
dsh plugin --profile web add dsh-model-relay
```

### 发新版

改完代码后改 `version`（语义化版本），再 `npm publish`：

```sh
npm version patch    # 0.1.0 -> 0.1.1
npm publish
```

> 同一个版本号**不能发两次**，npm 会拒绝。必须升版本号。

---

## 第 2 步：提交到插件目录

收录后才会出现在「插件市场」里。

方案：**专用仓库 `qilin-zhu/dsh-model-relay`**，插件放在仓库根目录。`package.json` 的 `repository` / `homepage` / `bugs` 和 `registry/awesome-dsh-plugin.yml` 都已经按这个仓库配好了。

### ⚠️ 先记住收录的两个硬门槛

**1. 仓库必须创建满 1 天。** CI 自动检查，专门用来挡「PR 前几分钟才建仓库」的。所以**今天先建仓库推代码，明天再提 PR**。没达标就重新提交，不会留下不良记录。

**2. 仓库必须有真实可用的代码。** 占位仓库、纯 README 仓库不收。

### 2a. 建仓库并推代码

**仓库 `qilin-zhu/dsh-model-relay` 已经建好了**（含一个 Apache-2.0 LICENSE 的 initial commit），本地也已经初始化 git 并对齐了远程历史，**只差最后一步 push**。

本地当前状态：

```
98cf8b8  feat: 模型中转站 — OpenAI 兼容的模型中转接口   ← 待推送
e1e3346  Initial commit                              ← 远程已有
```

所以**不要再 `git init`**（会破坏已有历史），直接推送即可：

```sh
cd /vol2/@apphome/fn-deepseek-harness/profiles/日常/dsh-model-relay
git push origin main
```

**推送时会要凭据**，不能用账号密码（GitHub 早就禁了）。两种方式：

- **HTTPS + Personal Access Token**：用户名填 `qilin-zhu`，密码处粘贴一个 token（GitHub → Settings → Developer settings → Personal access tokens → 勾 `repo` 权限）
- **SSH**：把公钥加到 GitHub，remote 换成 `git@github.com:qilin-zhu/dsh-model-relay.git`

推完确认（**必须是 200**）：

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/qilin-zhu/dsh-model-relay/main/package.json
```

### 许可证：Apache-2.0

你建仓库时选了 Apache 2.0，所以本地已统一为 Apache-2.0，三处一致：

| 位置 | 值 |
| --- | --- |
| `LICENSE` | 完整 Apache License 2.0 全文（与仓库里那份逐字一致） |
| `package.json` | `"license": "Apache-2.0"` |
| `README.md` | `Apache-2.0` |

> 注意：npm 上已发布的 0.1.0 里写的是 **MIT**（发布时的旧值）。0.1.1 会带上正确的 `Apache-2.0`。

### 2c. 给仓库加 `dsh-plugin` topic（收录要求）

在仓库页面 → 右上角齿轮（About 旁）→ Topics → 添加 **`dsh-plugin`**。收录规则明确要求这一项。

### 2b. 提交收录条目

**方式是给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 开一个 PR，只加一个文件。**

文件路径（专用仓库形式，`<owner>__<repo>.yml`）：

```
data/plugins/qilin-zhu__dsh-model-relay.yml
```

内容就是 `registry/awesome-dsh-plugin.yml` 里的那份：

```yaml
url: https://github.com/qilin-zhu/dsh-model-relay
name: qilin-zhu/dsh-model-relay
category: model
description:
  en: 'Model relay station: serve any registered DSH model over an OpenAI-compatible /v1 API, with API keys, a LAN listener and a settings page.'
  zh: '模型中转站：把 DSH 里已注册的模型以 OpenAI 兼容的 /v1 接口提供给其他项目，带 API 密钥管理、局域网监听和设置页。'
```

PR 步骤：

1. 在 GitHub 上 fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 在你的 fork 里新建上面那个文件（路径和文件名**必须完全一致**）
3. 向 `main` 开 PR
4. 等 CI 跑绿 + 维护者合并。合并后两个 README 自动重新生成，**你不需要跑任何命令**

注意：

- `url` 必须与仓库**完全一致**。
- 两个 README 由脚本从 `data/plugins/*.yml` 生成，**不要手工编辑**。
- `description.en` 含 `: `（冒号+空格）时**必须加引号**，否则 YAML 解析失败——上面已经加好了。
- 只有 `description.en` 是必填；中文留空也行，维护者会补。
- **一条收录对应一个文件**，不会和别人冲突——这是这个仓库刻意的设计。
- **描述必须属实**：维护者会对着代码核。别写夸大或营销词。我们的描述只说功能。
- 一个 PR 最多 3 条（你只有 1 条，不用担心）。

### CI 会依次检查

1. **条目数量** —— 每 PR ≤ 3 条
2. **`dsh.bundle`** —— 从你仓库的 `package.json` 读取（根目录或 `packages/`·`plugins/`·`apps/` 子包）；**只声明 `dsh.client` 会在这里失败**
3. **仓库年龄** —— 满 1 天
4. **`awesome-lint` 与站点构建** —— 双语一致性、分隔符等

哪一项失败，CI 会指出要改什么。**在同一分支上推修复即可，不用重开 PR。**

### 前置条件（已满足）

收录要求仓库的 `package.json` 声明 `dsh.bundle`。本包已声明：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

> 最常见的被拒原因是只声明了 `dsh.client`——那样**无法安装**。

### npm 包不是必须的

没有 npm 包也能收录，只是市场里不显示下载量。`dshmarket` 会依次尝试：npm 包 → 作者的 GitHub Release 预构建 tarball → 整仓源码下载。所以**即使你不发 npm，只推到 GitHub 也能被安装**，只是首次安装会慢一些（要从源码下载）。

---

## 关于版本兼容声明

`engines.dsh` 声明为 `>=0.1.5-rc.2 <0.2.0-0`，用于市场的兼容性徽标。

**peer 依赖用带预发布分支的 `||` 范围**，例如：

```json
"@deepseek-ai/dsh-llm": "^0.1.5-rc.2 || ^0.1.6-alpha.1"
```

这不是为了"宽松"，而是 semver 的预发布规则逼出来的：**只有范围里某个比较符与目标版本 `major.minor.patch` 元组完全一致、且自身带预发布标签时，预发布版本才会被放行。**

| 写法 | 0.1.5-rc.2 | 0.1.5 | 0.1.6-rc.1 |
| --- | --- | --- | --- |
| `0.1.5-rc.2`（精确钉住） | ✅ | ❌ | ❌ |
| `>=0.1.5-rc.2 <0.2.0-0`（看着很宽） | ✅ | ✅ | ❌ |
| `^0.1.5-rc.2 \|\| ^0.1.6-alpha.1` | ✅ | ✅ | ✅ |

第二行是陷阱：它**看起来**覆盖了整个 0.1.x，却匹配不到 `0.1.6-rc.1`，用户会在 `npm install` 时撞上 `ERESOLVE` 还得自己手工绕。收录指南专门警告过这一点，`dshmarket` 也用的 `||` 分支写法。

> 精确钉住（第一种）不会害用户 ERESOLVE，但会让插件在 harness 升到下一个 rc 时直接装不上，得跟着发版。`||` 写法更耐用。

---

## npm 发布状态：0.1.1 已上线 ✅

| 版本 | 状态 | 说明 |
| --- | --- | --- |
| `0.1.0` | 已发布 | 元数据是旧值（`repository` 指向 `tnnevol/fn-os-apps`、`author` 是 `tnnevol`、license MIT）。**已被 0.1.1 取代**，不用管它 |
| `0.1.1` | **已发布，`latest`** | 元数据已修正：`qilin-zhu/dsh-model-relay`、`author: qilin-zhu`、Apache-2.0、peer 范围 `\|\|` 分支 |

**0.1.0 无法撤回**（npm 不允许删除已发布版本，超过 72 小时更是完全锁死）。它留在版本列表里无害——`latest` 指向 0.1.1，用户 `npm install dsh-model-relay` 拿到的就是 0.1.1。

### E409 是什么意思

```sh
npm ERR! code E409
npm ERR! 409 Conflict - PUT https://registry.npmjs.org/dsh-model-relay
npm ERR! Cannot publish over previously staged version "0.1.1".
```

**这不是失败，是「你已经发过了」。** npm 在你第一次 `publish` 时就把 0.1.1 写进了 registry，第二次同版本再发，服务端拒绝覆盖——`staged` 是 npm 对「该版本已存在于发布流程中」的措辞。

判断方法（别只看 `npm view`）：

```sh
curl -s https://registry.npmjs.org/dsh-model-relay | grep -o '"latest":"[^"]*"'
# 或
curl -s -o /dev/null -w '%{http_code}\n' \
  https://registry.npmjs.org/dsh-model-relay/0.1.1     # 200 = 已发布
```

### 为什么 `npm view` 会显示 0.1.0

两个原因叠加，**它显示的版本不可信**：

1. 本机 `.npmrc` 指向**腾讯镜像**，镜像同步官方源有延迟，新版本不会立刻出现。
2. 以 `root` 跑时 npm 缓存目录（`/root/.npm`）有权限问题，`npm view` 可能直接报错。

要拿准值就显式指定官方源，或用 curl：

```sh
npm view dsh-model-relay version --registry=https://registry.npmjs.org/
```

### 想发下一版

```sh
npm version patch        # 0.1.1 -> 0.1.2
npm publish --otp=123456
```

**同一版本号永远不能发两次**，必须升版本号。

---

## 一页速查

```sh
# ---- 第 1 步：npm ✅ 已完成（0.1.1 是 latest）----
# 无需再发。确认：
curl -s https://registry.npmjs.org/dsh-model-relay | grep -o '"latest":"[^"]*"'
# 下次发新版才需要：
#   npm version patch && npm publish --otp=123456

# ---- 第 2a 步：推代码（今天做）----
# 仓库已建好、本地已 commit，只需 push：
cd /vol2/@apphome/fn-deepseek-harness/profiles/日常/dsh-model-relay
git push origin main
# 再到仓库页面加 topic: dsh-plugin

# ---- 第 2b 步：提收录 PR（仓库满 1 天后）----
# fork awesome-dsh-plugin/awesome-dsh-plugin
# 新建 data/plugins/qilin-zhu__dsh-model-relay.yml
# 内容 = registry/awesome-dsh-plugin.yml
# 开 PR 到 main，等 CI 绿 + 合并
```

## 最可能踩的五个坑

| 坑 | 症状 | 处理 |
| --- | --- | --- |
| 发到腾讯镜像 | `npm publish` 失败 / 让你登录镜像 | 已用 `publishConfig.registry` 固定；`--dry-run` 自查 |
| **2FA 拦住发布** | `E403 ... granular access token with bypass 2fa` | `npm publish --otp=123456`，或建带 Bypass 2FA 的 granular token |
| **重复发布** | `E409 ... Cannot publish over previously staged version` | **不是失败**，是已经发过了。升版本号再发 |
| 仓库目录没推 | 收录条目 url 是死链，PR 被打回 | 先做 2a，`curl` 确认返回 200 |
| 只声明 `dsh.client` | 装了不生效 / 被拒 | 本包已同时声明 `dsh.bundle` |
| 误信 `npm view` | 显示旧版本，以为没发成功 | 它走腾讯镜像 + root 缓存有问题；用 `curl` 或加 `--registry` |

## 需要我代劳时

如果你改主意想让我执行，需要提供其中之一：

1. **npm token**：`npm config set //registry.npmjs.org/:_authToken=npm_xxx`，或提供 `NPM_TOKEN` 环境变量。
2. **GitHub 访问**：`gh` CLI 未安装，且没有可用 token；提交目录 PR 需要 fork + PR 权限。

发布是不可撤销的公开动作，所以默认由你执行。
