# 第三方调用开发文档

## 1. 接口地址

基础地址：

```text
https://ocr.example.com
```

固定识别接口：

```text
POST https://ocr.example.com/api/v1/ocr/recognize
```

请求头：

```http
Content-Type: application/json
Accept: application/json
```

业务接口只接受 `POST`。`GET /health` 仅用于健康检查，不执行 OCR。

## 2. 固定请求格式

请求体必须是 JSON 对象，并且必须包含 `source`。

| 字段 | 类型 | 必填条件 | 说明 |
| --- | --- | --- | --- |
| `source` | string | 始终必填 | `image`、`url`、`helipay`、`ahrcu` |
| `image_base64` | string | `source=image` | 图片 Base64，可以是纯 Base64 或 `data:image/...;base64,...` |
| `url` | string | `source=url` | 由 OCR 服务端抓取的图片地址 |

`source=helipay` 和 `source=ahrcu` 不需要额外传入图片或 URL，服务端会读取 `ocr_access.json` 中的上游配置。

当前接口不使用 API key、浏览器令牌或其他额外鉴权字段。调用方是否允许访问，只由全局域名白名单开关和精确域名白名单决定。

## 3. 四种识别来源

### 3.1 上传 Base64 图片

请求：

```json
{
  "source": "image",
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

适合第三方已经拿到图片二进制或验证码截图的场景。

### 3.2 识别外部图片 URL

请求：

```json
{
  "source": "url",
  "url": "https://upstream-a.example.com/api/captcha"
}
```

服务端只允许访问 `ocr_access.json` 的 `upstream_allowed_domains` 或 `upstream_allowed_ips`。外部 URL 必须满足：

- 协议为 `http` 或 `https`。
- 主机名命中上游白名单。
- 不包含账号密码或片段。
- 不跟随重定向。
- 默认拒绝解析到私有、保留、回环或未指定地址。

上游白名单和第三方调用者白名单不是一回事，不要把调用方域名填到 `upstream_allowed_domains`。

### 3.3 调用内置 Helipay 接口

请求：

```json
{
  "source": "helipay"
}
```

服务端使用 `ocr_access.json` 中 `helipay` 节点的 URL、请求头和 Cookie 获取图片，然后进行 OCR。

Helipay 使用专用轻量流程：先识别原图；如果未解析出合法的“单位数 + 运算符 + 单位数”算式，再识别一次蓝色文字裁剪增强图。`source=image` 和 `source=url` 如果检测到相同的蓝色验证码样式，也会使用这条流程。接口仍只返回固定四个字段。

### 3.4 调用内置 Ahrcu 接口

请求：

```json
{
  "source": "ahrcu"
}
```

服务端按照配置向 Ahrcu 发送 POST 请求，并将返回的图片交给 OCR。

如果服务端到 Ahrcu 的 DNS 结果存在不可达 IP，可以由管理员在
`ocr_access.json` 的 `ahrcu.resolve_ips` 中指定可用 IPv4。这个配置
只影响服务端连接目标，HTTP `Host` 和 TLS SNI 仍使用配置中的上游域名。

## 4. 固定返回格式

无论成功还是失败，接口 JSON 都只包含下面四个字段：

```json
{
  "code": 200,
  "message": "success",
  "result": "8+4=?",
  "answer": "12"
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | integer | 业务状态码，不使用 HTTP 状态码表达业务结果 |
| `message` | string | 状态说明，客户端应优先判断 `code` |
| `result` | string或null | 识别文本；算式保留识别出的算式，验证码或普通字符保留识别出的字符 |
| `answer` | string或null | 第三方直接使用的最终值；算式计算成功时返回计算结果，验证码或普通字符返回 `result`，识别为空时为 `null` |

HTTP 状态码固定为 `200`，第三方必须读取 JSON 中的 `code`。

### 4.1 验证码或普通字符

```json
{
  "code": 200,
  "message": "success",
  "result": "7456",
  "answer": "7456"
}
```

```json
{
  "code": 200,
  "message": "success",
  "result": "4c5A",
  "answer": "4c5A"
}
```

第三方只需要读取 `answer`。普通验证码和字符不是算式，`answer` 直接等于 `result`。

### 4.2 算术图片

```json
{
  "code": 200,
  "message": "success",
  "result": "8+4=?",
  "answer": "12"
}
```

`result` 保存识别出的算式文本，`answer` 返回计算后的字符串结果。算式识别不完整或无法安全计算时，`answer` 回填识别文本，避免第三方拿到空值。

## 5. 业务状态码

默认配置如下：

```json
{
  "success": 200,
  "invalid_request": 201,
  "domain_denied": 203,
  "service_error": 205
}
```

这些数值可以在 `ocr_access.json` 的 `response_codes` 中修改，但只改变 JSON 的 `code`，不会改变 HTTP 状态码。

| 默认 `code` | 含义 | 常见原因 |
| --- | --- | --- |
| `200` | 成功 | 图片获取和 OCR 处理成功 |
| `201` | 请求无效 | JSON 错误、缺少 `source`、字段类型错误或缺少必要字段 |
| `203` | 域名不允许 | 调用方没有携带要求的域名头，或域名不在白名单 |
| `205` | 服务处理失败 | 上游请求失败、模型处理失败或全局配置无效 |

错误响应仍保持四个字段，例如：

```json
{
  "code": 201,
  "message": "source is required",
  "result": null,
  "answer": null
}
```

## 6. 调用方域名白名单

全局配置项：

```json
{
  "caller_domain_whitelist_enabled": false,
  "caller_allowed_domains": [
    "client-a.example.com",
    "client-b.example.com"
  ]
}
```

### 6.1 关闭时

```json
{
  "caller_domain_whitelist_enabled": false
}
```

关闭后，服务允许浏览器测试，也允许没有 `Origin` 或 `Referer` 的服务端请求。

### 6.2 开启时

```json
{
  "caller_domain_whitelist_enabled": true
}
```

开启后，请求必须满足：

1. 请求带有 `Origin` 或 `Referer`。
2. `Origin` 或 `Referer` 的主机名精确命中 `caller_allowed_domains`。
3. 如果两个请求头同时存在，则两个主机名都必须在白名单中。

示例请求头：

```http
Origin: https://client-a.example.com
Referer: https://client-a.example.com/ocr-test
```

白名单只填写主机名：

```json
{
  "caller_allowed_domains": [
    "client-a.example.com",
    "api.client-b.example.com"
  ]
}
```

以下写法无效或不会匹配：

```text
*.example.com
https://client-a.example.com
client-a.example.com:8443
192.0.2.10
```

规则是严格精确匹配，不支持泛域名、不支持调用方 IP 白名单、不使用 key。修改 `ocr_access.json` 后按请求实时生效，不需要重启。

## 7. 调用示例

### 7.1 cURL 调用内置接口

```bash
curl -sS -X POST \
  https://ocr.example.com/api/v1/ocr/recognize \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"source":"helipay"}'
```

### 7.2 cURL 调用外部 URL

```bash
curl -sS -X POST \
  https://ocr.example.com/api/v1/ocr/recognize \
  -H "Content-Type: application/json" \
  -d '{"source":"url","url":"https://upstream-a.example.com/api/captcha"}'
```

### 7.3 PowerShell 上传本地图片

```powershell
$base64 = [Convert]::ToBase64String(
  [IO.File]::ReadAllBytes(".\captcha.png")
)
$body = @{
  source = "image"
  image_base64 = $base64
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Method Post `
  -Uri "https://ocr.example.com/api/v1/ocr/recognize" `
  -ContentType "application/json" `
  -Body $body
```

### 7.4 Python 调用

```python
import base64
from pathlib import Path

import requests


image_base64 = base64.b64encode(
    Path("captcha.png").read_bytes()
).decode("ascii")

response = requests.post(
    "https://ocr.example.com/api/v1/ocr/recognize",
    json={
        "source": "image",
        "image_base64": image_base64,
    },
    headers={
        "Origin": "https://client-a.example.com",
    },
    timeout=30,
)

data = response.json()
if data["code"] == 200:
    print(data["result"], data["answer"])
else:
    print(f"OCR failed: {data['code']} {data['message']}")
```

白名单关闭时可以删除示例中的 `Origin`。白名单开启时，服务端调用方也必须按实际接入域名发送允许的 `Origin` 或 `Referer`。

### 7.5 浏览器开发者工具测试

浏览器测试期间先将 `caller_domain_whitelist_enabled` 设为 `false`，然后在开发者工具 Console 执行：

```javascript
fetch("https://ocr.example.com/api/v1/ocr/recognize", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    source: "helipay"
  })
}).then(response => response.json()).then(console.log);
```

业务接口不支持在地址栏使用 GET 参数直接识别。测试完成后将全局白名单开关改回 `true`。

## 8. 第三方处理建议

1. 先判断 HTTP 响应是否能解析为 JSON。
2. 再判断 JSON 的 `code`，不要使用 HTTP `200` 判断业务成功。
3. 成功时直接读取 `answer`；`result` 仅用于保留原始识别文本和调试。
4. 失败时保留 `code` 和 `message`，不要依赖某一段固定错误文本。
5. 不要把上游 Cookie、面板账号或 `ocr_access.json` 内容放进第三方代码。
