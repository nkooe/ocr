# OCR Service

基于 FastAPI 和本地 PaddleOCR 模型的 OCR 服务，包含 aaPanel Python 项目管理器自动部署脚本。

## 部署

完整安装步骤见 [`docs/INSTALL.md`](docs/INSTALL.md)，接口说明见 [`docs/API.md`](docs/API.md)。

1. 复制 `.env.deploy.example` 为 `.env.deploy`，填写当前 aaPanel 和项目参数。
2. 按实际业务修改 `ocr_access.json`；仓库内仅包含 `example.com` 和 RFC 保留地址。
3. 运行 `node deploy_aapanel.js`。

部署器会读取当前服务器 aaPanel Python 环境的实际 `bin_path`，不会固定 Python 补丁版本或解释器路径。

## 安全说明

- 不要提交 `.env.deploy`、Cookie、面板账号、访问令牌或真实业务域名。
- `ocr_access.json` 中的默认上游地址仅为占位示例，部署前必须替换。
- 历史压缩包、运行缓存和虚拟环境均由 `.gitignore` 排除。
