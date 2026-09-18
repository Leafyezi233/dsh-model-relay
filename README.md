# 模型中转站 (dsh-model-relay)

给 DeepSeek Harness 挂一个 OpenAI 兼容的 `/v1` 接口，把 harness 里已注册的大模型（比如 `@tnnevol/dsh-codebuddy` 里的 CodeBuddy 模型）反代出去，其他项目用标准 OpenAI 客户端就能调用。

在 **设置 → 模型中转站** 里可以看到所有接口地址、创建和管理 API 密钥、开关鉴权、查看可用模型。

## 为什么不是"再登一次"

这个插件**不碰任何凭据**。它自己不读、不存、不刷新 token，而是把请求交给 DSH 的 `llm` 服务转发——也就是直接复用已注册的 provider 适配器。

这不是风格偏好，是正确性要求：CodeBuddy 的 refresh token 会轮换，而且 `@tnnevol/dsh-codebuddy` 内部用**单飞（single-flight）** 保证并发刷新只发生一次。如果本插件自己再建一个 session，两次刷新会互相作废，结果是 Web 界面里的登录被踢掉。走 `ctx.llm` 就不可能出现这种情况。

由此还顺带复用了上游插件的账号故障转移、额度感知、图片序列化和模型目录。

## 安装

发布到 npm 后，最简单的方式是在 DSH 里打开 **设置 → 插件市场** 搜索「模型中转站」一键安装。

命令行安装：

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-model-relay

# 本地开发（file: 链接）
dsh plugin --profile web add /绝对路径/dsh-model-relay
```

装完重启 Web profile，服务地址是：

```
http://127.0.0.1:3080/v1
```

> 本插件尚未发布到 npm 与插件目录。发布步骤见 [PUBLISHING.md](PUBLISHING.md)。

## 用法

任意 OpenAI 客户端都可以，`base_url` 指向上面的地址。

**鉴权是可选的**：还没创建密钥、也没在配置里写固定密钥时，接口对所有人开放（随便填一个 `sk-xxx` 或留空都行）。创建第一个密钥后自动开始校验。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3080/v1", api_key="sk-dshgw-...")

resp = client.chat.completions.create(
    model="codebuddy_deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

```sh
curl http://127.0.0.1:3080/v1/models

curl http://127.0.0.1:3080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"codebuddy_deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

支持的接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 列出所有已注册 provider 的模型 |
| `POST` | `/v1/chat/completions` | 对话，支持 `stream: true` |

请求体与 OpenAI Chat Completions 一致：`model`、`messages`、`stream`、`tools`、`tool_choice`、`temperature`、`max_tokens`、`stop`、`reasoning_effort`。支持 `role: "tool"` 的工具结果回传、assistant 的 `tool_calls` 回放、以及 `image_url` 图片输入（data URL 或远程 URL）。

流式响应是标准 SSE，以 `data: [DONE]` 结束。

## 模型名怎么写

**推荐用 `供应商_模型`，例如 `codebuddy_deepseek-v4-flash`。**

不同供应商的模型 id 会重名。实测这套组合里 `deepseek-v4-flash` 和 `deepseek-v4-pro` **同时**存在于 `deepseek-official` 和 `codebuddy`。所以每个模型都按 `<供应商>_<模型id>` 命名，`/v1/models` 返回的 `id` 就是这个形式。

用下划线而不是斜杠，是为了让模型名对客户端保持**单个不透明 token**：有些 OpenAI 兼容工具会把 `/` 当作路径分隔符，而且斜杠会和下面这种旧写法混淆。

三种写法都接受，优先级从高到低：

| 写法 | 例子 | 说明 |
| --- | --- | --- |
| `供应商_模型` | `codebuddy_deepseek-v4-flash` | 推荐，唯一无歧义 |
| `供应商/模型` | `codebuddy/deepseek-v4-flash` | 旧写法，仍兼容 |
| 裸模型名 | `glm-5.2` | 先查 `defaultProvider`，再找目录里的唯一匹配，都没有时若只注册了一个供应商就用它 |

裸名在多个供应商上都存在时返回 400，并在错误信息里给出全部可选的全名，例如：

```
model "deepseek-v4-flash" is served by several providers;
use a namespaced id such as codebuddy_deepseek-v4-flash, deepseek-official_deepseek-v4-flash
```

响应里的 `model` 字段回显你请求时用的全名，方便对照日志。

模型目录是**建议性**的：适配器接受未列出的 id。目录会缓存 30 秒。

## 设置页

装好后打开 **设置 → 模型中转站**，页面上有：

- **接口地址**：Base URL、两个端点、一段可直接复制的 Python 示例
- **API 密钥**：创建（带备注名）、删除、以及开启/关闭鉴权
- **可用模型**：当前暴露的模型清单

### 密钥是怎么处理的

- 服务端只保存 **SHA-256 哈希**，明文只在创建弹窗里显示一次，关掉就再也拿不回来——丢了就删掉重建。
- 列表里显示的是 `sk-dshgw-abcd…wxyz` 这种可辨认的掩码，不能用来调用。
- 密钥文件默认在 `~/.dsh/model-relay-keys.json`，权限 `0600`；**权限被放宽的文件会被当作不存在**，不会被信任。
- 写入是原子替换 + 串行化队列，连续创建多个密钥不会互相覆盖。

### 一个刻意的安全取舍

**删掉最后一个密钥，接口仍然保持锁定**，必须显式点"关闭鉴权"才会重新开放。

这不是偷懒：如果删除密钥会自动放开接口，那么"清理一个不再使用的密钥"这个日常动作就会静默地把接口暴露给所有人。权限只应由明确的操作放开，而不是由清理动作的副作用放开。页面上有对应的提示文案。

## 反向代理（飞牛统一网关等）

**调用模型请用端口地址，不要走反向代理。**

页面上显示的 Base URL 是 `http://<host>:<port>/v1`，其中 port 是 DSH 实际监听的端口（从 `ctx.webServer.port` 读取，不是页面地址）。这样做的原因：

- 反向代理会**重写路径**。飞牛网关把应用挂在 `/app/fn-deepseek-harness` 下，转发前剥掉这个前缀，并按自己的白名单给页面资源加前缀。SSE 流式响应和这个网关的路径改写叠加起来很容易出问题。
- 直接打端口就绕开了所有这些不确定性。

页面上会提示当前是"只监听本机"还是"监听所有网卡"，据此判断其他机器能否调用。

## 局域网访问

想让同一网络的其他设备（手机、笔记本、另一台服务器）也能调用，开一个**独立监听端口**：

```yaml
- id: dsh-model-relay
  inject:
    - llm
    - webServer
  config:
    lanPort: 3081
```

然后其他设备用：

```
http://<这台机器的局域网IP>:3081/v1
```

设置页的"局域网访问"卡片会直接列出可用的 IP 地址，每个都能一键复制。

**只列出真正的局域网地址。** 装了 Docker/libvirt 的机器通常会有十几个 `172.x`/`br-*` 虚拟网桥地址，局域网设备根本连不上。这些会被过滤掉（`docker`、`br-`、`veth`、`virbr`、`vmnet`、`wg`、`tailscale` 等前缀），默认路由所在网卡的地址排在最前。被隐藏的数量会在卡片下方注明，方便排查——万一你的可用地址恰好落在某个网桥上，能看出是过滤导致的，而不是"没有地址"。

### 为什么是独立端口，而不是把 Web UI 也开到局域网

`lanPort` 起的是一个**只提供模型接口**的 `node:http` 服务：

- 它**不会**代理 DSH 界面。在这上面访问 `/` 或 `/api/...` 都是 404。
- 它的访问面只有 `GET /v1/models` 和 `POST /v1/chat/completions` 两条。
- 如果改成把 DSH Web 服务器本身绑到 `0.0.0.0`，那么会话 Cookie 登录、设置接口、以及所有其他 DSH 路由都会一起暴露到网络上——那不是这个功能想要的东西。

### 必须配密钥

**开启局域网监听前请先创建一个 API 密钥。** 没有密钥时，这个端口对同网络的**任何设备**开放。启动时如果发现没配密钥，日志会打一条警告，设置页上也会显示红色提示。

密钥校验在两条监听上是同一套：本机调用和局域网调用都认同一份密钥。

### 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `lanPort` | `false` | `false` 关闭；端口号开启独立监听；`0` 让系统分配一个空闲端口 |
| `lanHost` | `0.0.0.0` | 监听地址。只想给某一个网卡用时填该网卡的 IP |

`lanPort` 是整数（0–65535）或 `false`，其他值会在加载时直接报错，而不是等到运行时才发现。

### 防火墙

如果局域网连不上，先确认主机防火墙放行了这个端口。以飞牛/群晖这类 NAS 为例，通常需要在系统防火墙里额外放行 TCP 3081。

### 设置页自身是怎么在网关下工作的

设置页需要在网关下也能用，所以它的请求走了一个专门的约定：

- **端点挂在 `/api/model-relay`**，而不是插件私有的通道名。`/api` 是每个部署（包括飞牛网关的白名单）都一定会转发的唯一前缀；插件私有通道名不在白名单里，请求根本到不了 DSH——这正是早先设置页报 `transport failure ... HTTP 404` 的原因。
- **客户端用相对路径** `api/model-relay` 并对着 `document.baseURI` 解析。网关会把 `<base>` 设成带前缀的地址，相对路径因此自动带上前缀；写成根绝对路径 `/api/...` 会以 origin 为基准解析，前缀就丢了。
- 该端点复用 Connection 的信任校验与浏览器鉴权，所以只有已登录的 DSH 页面能管理密钥，`/v1` 自身不提供任何密钥管理入口。

## 配置（可选）

在 `profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-model-relay
  inject:
    - llm
    - webServer
  config:
    # 挂载点，默认 /v1
    path: /v1
    # 固定密钥：配了就校验，没配就放行。支持 Authorization: Bearer 和 x-api-key。
    # 与设置页创建的密钥同时生效；配置里存在固定密钥时，设置页无法关闭鉴权。
    apiKeys:
      - sk-your-key
    # 只暴露这些 provider，默认全部
    providers:
      - codebuddy
    # 裸模型名的优先 provider
    defaultProvider: codebuddy
    # 跨域响应头，默认 true
    cors: true
    # 密钥存储路径，默认 <DSH_HOME>/model-relay-keys.json
    keysFile: /path/to/keys.json
    # 局域网独立监听端口（详见上文"局域网访问"）；false 或不写即关闭
    lanPort: 3081
    # 监听地址，默认 0.0.0.0
    lanHost: 0.0.0.0
```

> 本插件的 bundle patch 会复写 `connection` 那一行的 `inject`（loader patch 是整值替换，不合并）。它必须保持为所有需要 connection RPC 的插件所要求依赖的并集——目前是 `webRuntime` 和 `webServer`。以后再有插件加自己的 RPC 通道，也要一起维护这个并集。

## 边界

- **默认只监听本机**。DSH Web 默认绑 `127.0.0.1`；局域网访问要用 `lanPort` 开独立端口，并且**一定要先配密钥**。
- **密钥管理只走设置页**。管理端点挂在 DSH 已鉴权的 connection carrier 上（`/api/model-relay`），`/v1` 自身不提供任何密钥管理接口。
- **没有 `/v1/embeddings`、`/v1/images`** 等接口。这个网关只做对话和模型列表；DSH 的 `llm` 服务没有 embedding 能力，所以这里不会假装有。
- **图片输入依赖附件服务**。`ctx.attachments` 没挂载时，带图请求会被明确拒绝（400），而不是静默丢图。
- 请求体上限 32 MiB，超出返回 413。

## 开发

```sh
node --check lib/index.js && node --check lib/keys.js && node --check lib/client.js
node test/gateway.test.mjs   # 协议翻译 + 路由 + 设置端点
node test/keys.test.mjs      # 密钥存储：哈希、权限、并发、锁定语义
```

测试用假的 `llm` 服务和真实的 `node:http` 服务器驱动路由，验证 OpenAI 协议翻译的往返形状；密钥测试跑在真实临时目录上。都不需要登录账号，也不发外部请求。

> **改了代码后确认一下安装副本。** pnpm 对 `file:` 依赖用的是**硬链接**（不是拷贝，也不是软链）：源文件和 `node_modules` 里的副本是同一个 inode。
>
> 这带来一个反直觉的坑：
>
> - **原地写入**（`echo >> file`、`sed -i` 之外的直接写）会同步到两边——因为本来就是同一份内容。
> - **先写临时文件再 rename**（`write`/`edit` 这类工具、多数编辑器保存时都是这么做的）会**悄悄断开硬链接**。源文件更新了，副本还是旧内容，而且没有任何报错。
>
> 所以改完源码后如果行为没变，别怀疑代码——先对一下内容：
>
> ```sh
> diff -r lib/ /绝对路径/profiles/web/node_modules/dsh-model-relay/lib/
> ```
>
> 不一致就重新执行 `dsh plugin --profile web add file:/绝对路径/dsh-model-relay`。注意 pnpm 可能报 "Already up to date" 而不重新链接，这种情况先 `remove` 再 `add`。
>
> 想让改动彻底自动生效，可以把依赖换成 `link:`。

## License

Apache-2.0
