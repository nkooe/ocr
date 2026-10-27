# OCR API 安装部署文档

## 1. 项目说明

本项目使用 FastAPI、PaddleOCR 和 aaPanel Python 项目管理。

默认运行信息：

- 业务域名：`ocr.example.com`（示例保留域名，部署时替换）
- 项目端口：`47259`
- 业务接口：`POST /api/v1/ocr/recognize`
- 健康检查：`GET /health`
- OCR 模型：项目内置 `models/` 目录

部署脚本不会固定 Python 版本、解释器路径或服务器目录。它会自动读取 aaPanel 已有的 Python 环境；没有可用面板环境时，会自动探测服务器 PATH 中可执行的 `python3` 或 `python`。依赖安装由项目自己的 `launcher.py` 处理，不走 aaPanel 的 requirements 安装链路。

## 2. 部署前准备

### 2.1 aaPanel 服务器

服务器需要具备：

1. 已安装 aaPanel。
2. 已启用 aaPanel Python 项目管理。
3. 面板账号具有 Python 项目、文件和项目启动管理权限。
4. DNS 的 `A` 记录已经指向服务器公网 IPv4。
5. 服务器可以访问 Python 包源和上游图片接口。
6. aaPanel Python 项目管理可以调用一个可执行的 Python 解释器；解释器没有 pip 也可以，项目会自动引导。

PaddleOCR 依赖 OpenCV。部署脚本默认会检测 `cv2`、`PaddleOCR` 导入状态，并在 Debian、Ubuntu、CentOS、Rocky、AlmaLinux 等常见系统上自动安装 `libGL`、`glib2`、`libgomp` 运行库。只有关闭 `AUTO_INSTALL_SYSTEM_DEPS` 或系统包管理器不受支持时，才需要手动安装。

### 2.2 部署机器

部署机器需要安装 Node.js 18 或更高版本，用于执行 `deploy_aapanel.js`。不需要在部署机器上安装 Python、PaddlePaddle 或 PaddleOCR。

### 2.3 本地项目文件

部署前确认以下内容存在：

```text
app/
models/
requirements.txt
launcher.py
ocr_access.json
ocr_access.example.jsonc
.env.deploy.example
deploy_aapanel.js
```

当 `OCR_REQUIRE_LOCAL_MODELS=true` 时，`models/` 下必须包含完整的检测模型和识别模型。部署脚本会在上传前检查模型文件。

## 3. 配置部署参数

复制模板：

```powershell
Copy-Item .env.deploy.example .env.deploy
```

编辑 `.env.deploy`，填写当前服务器的面板信息：

```text
AAPANEL_BASE_URL=https://your-panel-host:port
AAPANEL_ENTRANCE=/your-panel-entrance
AAPANEL_USERNAME=your-panel-username
AAPANEL_PASSWORD=your-panel-password
```

项目参数示例：

```text
PROJECT_NAME=ocr
PROJECT_DOMAIN=ocr.example.com
PROJECT_PORT=47259
PROJECT_DOMAIN_PORT=80
PROJECT_USER=root
# 可选。填写 aaPanel 中的环境名称；留空时自动选择可执行的 Python。
PYTHON_ENV_NAME=
REMOTE_ROOT=
PRESERVE_REMOTE_ACCESS_CONFIG=false
OCR_REQUIRE_LOCAL_MODELS=true
AUTO_INSTALL_SYSTEM_DEPS=true
PIP_SOURCE=default
INSTALL_WAIT_SECONDS=7200
VERIFY_PUBLIC_URL=true
PROJECT_SCHEME=https
```

参数说明：

- `AAPANEL_BASE_URL`：只填面板根地址，不要拼接入口路径。
- `AAPANEL_ENTRANCE`：面板登录入口，例如 `/your-panel-entrance`。
- `PROJECT_DOMAIN`：aaPanel Python 项目绑定的域名。
- `PROJECT_PORT`：项目监听端口，默认 `47259`。
- `PROJECT_DOMAIN_PORT`：域名绑定条目使用的公开反向代理端口，默认 `80`；不是 OCR 进程监听端口。只有当前 aaPanel 版本明确要求时才改成 `PROJECT_PORT`。
- `PROJECT_USER`：aaPanel Python 项目的运行用户，选择 `root`。添加或修改 Python 项目时，面板里的运行权限也选择 `root`；普通 `www` 用户可能无权执行面板虚拟环境指向的解释器。
- `PYTHON_ENV_NAME`：可选，填写 aaPanel 中的环境名称。留空时脚本会自动探测可执行环境，不固定 Python 版本。
- `REMOTE_ROOT`：已有项目时自动读取面板中的项目目录。新建项目时填写目标服务器上的绝对目录，例如 `/opt/ocr`；脚本不会把某台服务器的目录写死到程序中。
- `PRESERVE_REMOTE_ACCESS_CONFIG`：设为 `true` 时，重新部署不覆盖服务器已有的 `ocr_access.json`。
- `OCR_REQUIRE_LOCAL_MODELS`：设为 `true` 时强制使用项目内模型，不允许静默下载模型。
- `AUTO_INSTALL_SYSTEM_DEPS`：设为 `true` 时，依赖安装后自动检测 `cv2`、`PaddleOCR` 等导入，缺少 `libGL`、`glib2`、`libgomp` 时自动按系统包管理器安装。
- `PIP_SOURCE`：项目自动安装依赖使用的源；支持 `default`、`aliyun`、
  `tsinghua`、`tencent`、`huawei`、`pypi` 或完整的 HTTP(S) 包索引地址。
  wheel 会缓存在项目的 `.runtime/pip-cache`，同一 Python ABI 下再次部署会复用缓存。
- `VERIFY_PUBLIC_URL`：设为 `true` 时，部署结束后自动检查 HTTPS `/health`。
- `AUTO_APPLY_SSL`：设为 `true` 时，域名没有匹配证书会调用 aaPanel SSL 管理器申请 Let's Encrypt HTTP-01 证书并自动部署；设为 `false` 时只绑定已安装的匹配证书。

`.env.deploy` 包含面板密码，只保存在本地，不要上传或提交。项目已将 `.env.deploy` 加入忽略规则。

## 4. 配置域名和证书

1. 在 DNS 服务商处将你的项目域名（示例：`ocr.example.com`）的 `A` 记录指向服务器公网 IPv4。
2. 确认域名已经解析到当前服务器。
3. 执行部署脚本。`AUTO_APPLY_SSL=true` 时脚本会调用 aaPanel SSL 管理器申请 Let's Encrypt HTTP-01 证书、部署到 Python 项目并回读校验；已有匹配证书则直接绑定，不会套用其他域名证书。
4. 确认 HTTPS 访问：

```text
https://ocr.example.com/health
```

证书申请和续期由 aaPanel 管理器负责。部署脚本不写死证书文件路径，只通过面板接口申请、读取并绑定；申请失败会输出 aaPanel 任务状态和日志路径，不会把其他域名证书套到当前项目。

## 5. 执行自动部署

在项目根目录执行：

```powershell
node deploy_aapanel.js
```

### 5.1 Python Project 配置

**aaPanel 的 Python Project 是唯一的管理和启动入口。**

部署脚本只负责第一次安装：

1. 自动检测 aaPanel 的 Python 环境。
2. 自动处理 pip，绕过 `ensurepip` 错误。
3. 通过 aaPanel API 创建 Python Project。
4. 自动配置：
   - 项目名：`ocr`
   - 启动方式：`Command Startup`
   - 框架：`FastAPI`
   - 启动命令：`项目所选 Python 环境的解释器绝对路径 /www/wwwroot/ocr/launcher.py`
   - 用户：`root`
   - 端口：`47259`
5. 项目创建完成后，项目会出现在 aaPanel 的 **Python Project** 列表中。

如果需要在 aaPanel 页面手动确认项目配置，填写如下：

| 面板字段 | 内容 |
| --- | --- |
| Project Name | `ocr` |
| Python Environment | 选择当前服务器可用的 Python 环境 |
| Startup Way | `Command Startup` |
| Project Path | 当前服务器实际项目目录 |
| Current Framework | `fastapi` |
| Startup Command | `实际解释器绝对路径 /实际项目路径/launcher.py` |
| Environment Variables | `None` |
| Startup User | `root` |
| Startup | 开启 |

启动命令里的解释器必须与 **Python Environment** 指向同一环境。不要填写
`/www/server/panel/pyenv/bin/python`，它是 aaPanel 自身的运行环境；版本可能与项目环境不同，
会造成二进制依赖重复下载或无法导入。可在项目环境列表中复制完整的 `bin_path`。
例如，aaPanel 安装的是 Python 3.11.1 时，目录名可以包含完整版本号，但解释器文件名通常只包含主版本和次版本：

```text
/www/server/pyporject_evn/versions/3.11.1/bin/python3.11 /www/wwwroot/ocr/launcher.py
```

上面的路径只是示例，不要自行拼成 `python3.11.1`，也不要使用 `*` 通配符。
换服务器后必须原样复制新服务器 aaPanel 当前显示的 `bin_path`。

不要选择 aaPanel 的自动 requirements 安装，由项目自己的 `launcher.py` 处理依赖。

### 5.2 首次启动验证

项目添加完成后，进入服务器项目目录打开终端，执行：

```bash
cd /www/wwwroot/ocr
/项目环境的实际/bin/python /www/wwwroot/ocr/launcher.py
```

首次运行会自动安装项目依赖和 OCR 运行库。出现下面内容就表示启动成功：

```text
Successfully installed ...
Application startup complete.
Uvicorn running on http://0.0.0.0:47259
```

确认成功后，在当前终端按 `Ctrl+C` 停止这次手动启动，再回到 aaPanel 的 **Python Project** 点击启动。不要让终端里的进程和 aaPanel 项目同时运行，否则会因为 `47259` 端口已被占用而启动失败。

之后直接在 **Python Project** 里进行：

- 启动
- 停止
- 重启
- 查看日志
- 修改配置
- 设置开机启动
- 管理域名和反向代理

日常运行不需要再次执行 Node 部署脚本。

### 5.3 使用部署脚本同步项目

首次安装或更新文件时，在本地项目根目录执行：

```powershell
node deploy_aapanel.js
```

脚本会读取当前服务器的 Python 环境和项目目录，不固定 Python 版本、解释器路径或服务器目录；然后同步源码、模型、配置和文档。

## 6. 部署后检查

### 6.1 健康检查

```bash
curl -sS https://ocr.example.com/health
```

正常结果：

```json
{
  "code": 200,
  "message": "success",
  "result": "ok",
  "answer": null
}
```

### 6.2 检查项目状态

在 aaPanel 的 Python 项目管理中确认：

- 项目名称为 `ocr`。
- 运行状态为运行中。
- 监听端口为 `47259`。
- 项目域名使用你自己的域名；本文统一以保留域名 `ocr.example.com` 为例。
- 运行权限为 `root`。
- 项目日志没有 `ImportError`、模型缺失或启动失败。

### 6.3 检查业务接口

```bash
curl -sS -X POST \
  https://ocr.example.com/api/v1/ocr/recognize \
  -H "Content-Type: application/json" \
  -d '{"source":"helipay"}'
```

接口具体参数和返回格式见 [第三方调用开发文档](API.md)。

## 7. 全局访问配置

运行时配置文件是项目根目录的 `ocr_access.json`，不是带注释的模板文件。模板 `ocr_access.example.jsonc` 仅用于参考，不能直接当作 JSON 解析。

首次部署可以保持：

```json
{
  "caller_domain_whitelist_enabled": false
}
```

这样方便浏览器或 Postman 测试。正式限制调用方时改为：

```json
{
  "caller_domain_whitelist_enabled": true
}
```

然后在 `caller_allowed_domains` 中填写第三方调用方的精确域名。修改配置后，每个请求都会重新读取文件，不需要重启项目。

调用方白名单和上游 URL 白名单是两套配置：

- `caller_allowed_domains`：校验第三方请求者域名，只支持精确域名，不支持泛域名和 IP。
- `upstream_allowed_domains`、`upstream_allowed_ips`：限制服务器可以访问的外部图片地址，用于 `source=url`。

具体规则见 [第三方调用开发文档](API.md)。

## 8. 更换服务器

更换服务器时只需要：

1. 将完整项目复制到新的部署机器。
2. 重新填写新的 `.env.deploy`。
3. 使用新服务器的 aaPanel 地址、入口和账号。
4. 根据新域名修改 `PROJECT_DOMAIN`。
5. 确认 DNS 已指向新服务器；`AUTO_APPLY_SSL=true` 时无需提前手动申请证书。
6. 重新执行 `node deploy_aapanel.js`。

不要复制旧服务器的 Python 解释器路径、虚拟环境目录或项目绝对路径。新服务器只需填写新的面板信息、域名和实际项目目录；脚本会自动选择解释器并在新项目目录重新准备 `.runtime`。

## 9. 常见故障

### 项目启动后立即停止

先看 aaPanel Python 项目日志。常见原因：

- Python 环境没有安装完整依赖。
- aaPanel 项目添加时没有选择 `Command Startup`。
- 项目启动命令使用了相对路径；请填写 Python 解释器和 `/www/wwwroot/ocr/launcher.py` 的绝对路径。
- 本地模型缺失或模型目录不完整。
- OpenCV 找不到 `libGL.so.1`。
- 项目端口已经被其他进程占用。
- 项目用户没有读取 Python 虚拟环境或模型文件的权限。
- 服务器无法访问 Python 包源或 `bootstrap.pypa.io`。

如果 HTTPS 打开的是其他网站而不是 OCR，先不要继续调 SSL：这表示 Python
进程没有监听 `47259`，或域名没有在 **Domain Manager** 中绑定到这个项目。
先在 aaPanel **Project logs** 查看退出原因，再确认 **Domain Manager** 中存在
`ocr.example.com:80`，并在 **Mapping** 中开启外网映射。

### `No module named ensurepip`

不要在全新服务器上直接用 aaPanel 页面手动创建项目。aaPanel 会在项目代码启动前强制初始化服务器依赖，部分 Python 3.13 系统会因此触发这个错误。使用 `node deploy_aapanel.js`，部署脚本会在调用 aaPanel 创建项目之前自动引导 pip，然后再由 `launcher.py` 安装项目依赖。

### `ImportError: libGL.so.1`

部署脚本和 `launcher.py` 默认都会自动处理。只有当前用户不是 root、包管理器不受支持或你关闭了自动处理时，才需要手动安装：

```bash
apt-get update
apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1
```

Debian 13 如果提示找不到 `libglib2.0-0`，程序会自动改用 `libglib2.0-0t64`。

### 返回 `code=205`

`205` 表示服务端处理失败或全局配置文件无效。检查：

1. `ocr_access.json` 是否是合法 JSON。
2. 上游地址是否命中上游白名单。
3. 上游接口是否需要更新 Cookie。
4. PaddleOCR 模型是否正常加载。
5. aaPanel 项目日志中的完整错误信息。

如果 Ahrcu 返回网络错误，优先检查服务器到
上游服务域名和端口的连通性。上游 DNS 可能返回多个地址，
其中部分地址在当前服务器网络下不可达。可以在 `ocr_access.json` 的
`ahrcu.resolve_ips` 中填写实测可用 IPv4，程序仍会使用原域名作为
`Host` 和 TLS SNI。

### 修改白名单没有立即生效

确认修改的是正在运行项目根目录下的 `ocr_access.json`，并且 JSON 文件保存成功。该文件按请求读取，不需要重启；如果 JSON 格式错误，服务会返回配置错误。

## 10. 编码约定

- 所有文本文件使用 UTF-8 无 BOM。
- 不在代码中固定 Python 版本或解释器路径。
- 不在代码中固定某台服务器的项目目录。
- `.env` 和 `.env.deploy` 不进入部署文件清单。
