const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const LOCAL_ROOT = path.resolve(__dirname);
const DEPLOY_ENV = {
  ...readKeyValueFile(path.join(LOCAL_ROOT, ".env.deploy")),
  ...process.env,
};

const AAPANEL_BASE_URL = requireValue("AAPANEL_BASE_URL");
const AAPANEL_ENTRANCE = requireValue("AAPANEL_ENTRANCE");
const USERNAME = requireValue("AAPANEL_USERNAME");
const PASSWORD = requireValue("AAPANEL_PASSWORD");
const PROJECT_NAME = DEPLOY_ENV.PROJECT_NAME || "ocr";
const PROJECT_DOMAIN = DEPLOY_ENV.PROJECT_DOMAIN || "";
const PROJECT_PORT = readPositiveInt("PROJECT_PORT", 47259);
const PROJECT_SCHEME = DEPLOY_ENV.PROJECT_SCHEME || "https";
// aaPanel stores Python-project domain bindings as `host:listen_port`.
// Keep the public HTTP port configurable because older panel versions use
// 80 here while newer versions expect the Python project's actual port.
const PROJECT_DOMAIN_PORT = readPositiveInt(
  "PROJECT_DOMAIN_PORT",
  80,
);
const PROJECT_USER = DEPLOY_ENV.PROJECT_USER || "root";
const PYTHON_ENV_NAME = String(DEPLOY_ENV.PYTHON_ENV_NAME || "").trim();
const CONFIG_REMOTE_ROOT = DEPLOY_ENV.REMOTE_ROOT || "";
const PRESERVE_REMOTE_ACCESS_CONFIG = readBool(
  "PRESERVE_REMOTE_ACCESS_CONFIG",
  false,
);
const OCR_REQUIRE_LOCAL_MODELS = readBool(
  "OCR_REQUIRE_LOCAL_MODELS",
  true,
);
const AUTO_INSTALL_SYSTEM_DEPS = readBool("AUTO_INSTALL_SYSTEM_DEPS", true);
const PIP_SOURCE = normalizePipSource(DEPLOY_ENV.PIP_SOURCE);
const PIP_INDEX_URL = pipIndexUrl(PIP_SOURCE);
const INSTALL_WAIT_SECONDS = readPositiveInt("INSTALL_WAIT_SECONDS", 7200);
const PANEL_LOGIN_WAIT_SECONDS = readPositiveInt(
  "PANEL_LOGIN_WAIT_SECONDS",
  60,
);
const VERIFY_PUBLIC_URL = readBool("VERIFY_PUBLIC_URL", true);
const SYNC_ONLY = readBool("SYNC_ONLY", false);
// Ask aaPanel's SSL manager to issue a Let's Encrypt certificate when the
// project does not already have one. Set false when certificates are managed
// centrally and must only be attached by this deployment.
const AUTO_APPLY_SSL = readBool("AUTO_APPLY_SSL", true);
const MIN_PYTHON_VERSION = [3, 9];
const MAX_PYTHON_VERSION_EXCLUSIVE = [3, 14];

const agent = AAPANEL_BASE_URL.startsWith("http://")
  ? new http.Agent({ keepAlive: true })
  : new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let cookie = "";
let sessionToken = "";
let requestToken = "";
let panelApiMode = "legacy";
let preserveRemoteAccessConfig = false;
let activeProjectUser = PROJECT_USER;

function readKeyValueFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      values[key] = value;
    }
  }
  return values;
}

function requireValue(name) {
  const value = DEPLOY_ENV[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing deployment setting: ${name}`);
  }
  return String(value).trim();
}

function readBool(name, defaultValue) {
  const rawValue = DEPLOY_ENV[name];
  if (rawValue === undefined || rawValue === "") {
    return defaultValue;
  }
  const value = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function readPositiveInt(name, defaultValue) {
  const rawValue = DEPLOY_ENV[name];
  const value = rawValue === undefined || rawValue === ""
    ? defaultValue
    : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizePipSource(value) {
  const source = String(value || "aliyun").trim().toLowerCase();
  if (source === "default") {
    return "aliyun";
  }
  if (
    ["aliyun", "tsinghua", "tencent", "huawei", "pypi"].includes(source) ||
    /^https?:\/\//.test(source)
  ) {
    return source;
  }
  throw new Error(
    "PIP_SOURCE must be default, aliyun, tsinghua, tencent, huawei, pypi, " +
      "or a full HTTP(S) package-index URL",
  );
}

function pipIndexUrl(source) {
  const sources = {
    aliyun: "https://mirrors.aliyun.com/pypi/simple",
    tsinghua: "https://pypi.tuna.tsinghua.edu.cn/simple",
    tencent: "https://mirrors.cloud.tencent.com/pypi/simple",
    huawei: "https://repo.huaweicloud.com/repository/pypi/simple",
    pypi: "https://pypi.org/simple",
  };
  return sources[source] || source;
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runtimeSitePath(remoteRoot) {
  return path.posix.join(remoteRoot, ".runtime", "site-packages");
}

function runtimeTempPath(remoteRoot) {
  return path.posix.join(remoteRoot, ".runtime", "tmp");
}

function runtimeCachePath(remoteRoot) {
  return path.posix.join(remoteRoot, ".runtime", "pip-cache");
}

function normalizePublicKey(value) {
  const match = value.match(
    /-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----/,
  );
  if (!match) {
    throw new Error("aaPanel public key is missing");
  }
  const body = match[1].replace(/\s+/g, "");
  return [
    "-----BEGIN PUBLIC KEY-----",
    ...body.match(/.{1,64}/g),
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");
}

function rsaEncrypt(value, publicKey) {
  return crypto.publicEncrypt(
    {
      key: normalizePublicKey(publicKey),
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(value),
  ).toString("base64");
}

function updateCookie(setCookie) {
  if (!setCookie) {
    return;
  }

  const jar = new Map();
  for (const item of cookie.split("; ").filter(Boolean)) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      jar.set(item.slice(0, separator), item.slice(separator + 1));
    }
  }

  for (const value of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
    const firstPart = value.split(";")[0];
    const separator = firstPart.indexOf("=");
    if (separator > 0) {
      jar.set(firstPart.slice(0, separator), firstPart.slice(separator + 1));
    }
  }

  cookie = [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function request(method, requestPath, { headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, AAPANEL_BASE_URL);
    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",
      Accept: "application/json,text/html,*/*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Accept-Encoding": "identity",
      Connection: "keep-alive",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    };

    const transport = url.protocol === "http:" ? http : https;
    const requestObject = transport.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        agent,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          updateCookie(response.headers["set-cookie"]);
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          let data = text;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            // Keep non-JSON responses as text for diagnostics.
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            buffer,
            data,
          });
        });
      },
    );

    requestObject.on("error", reject);
    if (body && body.length) {
      requestObject.write(body);
    }
    requestObject.end();
  });
}

function encodeForm(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function buildMultipart(fields, fileField, fileBuffer) {
  const boundary = `----ocr-${crypto.randomBytes(12).toString("hex")}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`,
      "utf8",
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fileField}"; filename="chunk.bin"\r\n` +
    "Content-Type: application/octet-stream\r\n\r\n",
    "utf8",
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function authHeaders(contentType, body) {
  return {
    "X-Http-Token": requestToken,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  };
}

function sessionPath(requestPath) {
  return `/apsess_${sessionToken}${requestPath}`;
}

function panelRoute(modernPath, legacyPath = modernPath) {
  return panelApiMode === "modern"
    ? modernPath
    : sessionPath(legacyPath);
}

async function getLoginPage() {
  const deadline = Date.now() + PANEL_LOGIN_WAIT_SECONDS * 1000;
  let lastResponse = null;
  do {
    lastResponse = await request("GET", AAPANEL_ENTRANCE, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (lastResponse.status === 200) {
      return lastResponse;
    }
    if (lastResponse.status !== 404 || Date.now() >= deadline) {
      break;
    }
    await delay(5000);
  } while (Date.now() < deadline);

  throw new Error(
    `aaPanel entrance ${AAPANEL_ENTRANCE} returned HTTP ` +
      `${lastResponse ? lastResponse.status : "unknown"}. ` +
      "Check the panel security entrance or authorized-IP setting.",
  );
}

async function login() {
  const page = await getLoginPage();

  const readLoginValue = (name) => {
    const match = page.text.match(
      new RegExp(`class=["']${name}["'][^>]*data=["']([^"']+)["']`),
    );
    if (!match) {
      throw new Error(`aaPanel login field missing: ${name}`);
    }
    return match[1];
  };

  const modernLoginToken = (
    page.text.match(/vite_public_login_token\s*=\s*["']([^"']+)/) || []
  )[1];
  const modernPublicKey = (
    page.text.match(/vite_public_encryption\s*=\s*["']([^"']+)/) || []
  )[1];

  let loginBody;
  if (modernLoginToken && modernPublicKey) {
    panelApiMode = "modern";
    loginBody = encodeForm({
      username: rsaEncrypt(
        md5(md5(USERNAME + modernLoginToken)),
        modernPublicKey,
      ),
      password: rsaEncrypt(
        md5(md5(PASSWORD) + "_bt.cn"),
        modernPublicKey,
      ),
      safe_mode: "1",
    });
  } else {
    panelApiMode = "legacy";
    const lastToken = readLoginValue("last_token");
    sessionToken = readLoginValue("apsess_token");
    const publicKey = readLoginValue("public_key");
    loginBody = encodeForm({
      username: rsaEncrypt(md5(md5(USERNAME + lastToken)), publicKey),
      password: rsaEncrypt(md5(md5(PASSWORD) + "_bt.cn"), publicKey),
      code: "",
    });
  }

  const loginResponse = await request("POST", "/login", {
    headers: {
      ...authHeaders(
        "application/x-www-form-urlencoded; charset=UTF-8",
        loginBody,
      ),
      "X-Requested-With": "XMLHttpRequest",
      Referer: new URL(AAPANEL_ENTRANCE, AAPANEL_BASE_URL).toString(),
    },
    body: loginBody,
  });
  if (!loginResponse.data || !loginResponse.data.status) {
    throw new Error(`aaPanel login failed: ${loginResponse.text}`);
  }

  const home = await request("GET", panelRoute("/", "/"), {
    headers: { Accept: "text/html,*/*" },
  });
  const tokenMatch =
    home.text.match(/vite_public_request_token\s*=\s*["']([^"']+)/) ||
    home.text.match(/id="request_token_head"[^>]*token="([^"]+)"/);
  if (!tokenMatch) {
    throw new Error("aaPanel request token missing");
  }
  requestToken = tokenMatch[1];
}

async function panelApi(requestPath, values = {}) {
  const body = encodeForm(values);
  return request("POST", panelRoute(requestPath, `/v2${requestPath}`), {
    headers: {
      ...authHeaders(
        "application/x-www-form-urlencoded; charset=UTF-8",
        body,
      ),
      "X-Requested-With": "XMLHttpRequest",
      Referer: new URL("/", AAPANEL_BASE_URL).toString(),
    },
    body,
  });
}

async function panelFileApi(action, values = {}) {
  const body = encodeForm(values);
  return request(
    "POST",
    panelRoute(
      `/files?action=${encodeURIComponent(action)}`,
      `/files?action=${encodeURIComponent(action)}`,
    ),
    {
      headers: {
        ...authHeaders(
          "application/x-www-form-urlencoded; charset=UTF-8",
          body,
        ),
        "X-Requested-With": "XMLHttpRequest",
        Referer: new URL("/", AAPANEL_BASE_URL).toString(),
      },
      body,
    },
  );
}

async function remoteShell(
  shell,
  workingDirectory = "/tmp",
  timeoutMilliseconds = 120000,
) {
  const response = await panelFileApi("ExecShell", {
    path: workingDirectory,
    shell,
  });
  assertPanelSuccess(response, "ExecShell");

  const deadline = Date.now() + timeoutMilliseconds;
  let lastMessage = "";
  while (Date.now() < deadline) {
    await delay(1000);
    const statusResponse = await panelFileApi("GetExecShellMsg");
    if (!statusResponse.data) {
      continue;
    }
    const message = statusResponse.data.msg || statusResponse.data.message;
    if (message && message !== "FILE_SHELL_EMPTY") {
      lastMessage = String(message);
    }
    if (statusResponse.data.status === true) {
      return lastMessage;
    }
  }

  throw new Error(`Remote shell command timed out: ${lastMessage}`);
}

function assertPanelSuccess(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} HTTP ${response.status}: ${response.text}`);
  }
  if (!response.data) {
    throw new Error(`${label} returned a non-JSON response: ${response.text}`);
  }
  if (
    response.data.status === false ||
    response.data.status === -1 ||
    (
      response.data.status === 1 &&
      response.data.message &&
      response.data.message.status === false
    )
  ) {
    throw new Error(`${label} failed: ${response.text}`);
  }
}

function getMessageData(response, label) {
  assertPanelSuccess(response, label);
  if (Object.prototype.hasOwnProperty.call(response.data, "message")) {
    return response.data.message;
  }
  if (
    response.data.status === true &&
    Object.prototype.hasOwnProperty.call(response.data, "data")
  ) {
    return response.data.data;
  }
  return response.data;
}

function isExistingMessage(value) {
  return /exist|already|已存在|目录存在|文件存在/i.test(String(value));
}

async function remoteTextFile(remotePath) {
  const response = await panelFileApi("GetFileBody", {
    path: remotePath,
  });
  if (!response.data || response.data.status === false) {
    return null;
  }
  const content = response.data.data;
  return typeof content === "string" ? content : null;
}

async function shouldPreserveRemoteFile(remotePath) {
  if (!preserveRemoteAccessConfig) {
    return false;
  }
  const content = await remoteTextFile(remotePath);
  return content !== null && content.trim().length > 0;
}

async function ensureDirectory(directory) {
  const normalized = path.posix.normalize(directory);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;
    const response = await panelFileApi("CreateDir", {
      path: current,
      name: part,
    });
    if (
      response.data &&
      (response.data.status === false || response.data.status === -1) &&
      !isExistingMessage(response.data.msg || response.text)
    ) {
      throw new Error(`CreateDir ${current} failed: ${response.text}`);
    }
  }
}

async function saveRemoteText(remotePath, content) {
  const createResponse = await panelFileApi("CreateFile", {
    path: remotePath,
  });
  if (
    createResponse.data &&
    (createResponse.data.status === false ||
      createResponse.data.status === -1) &&
    !isExistingMessage(createResponse.data.msg || createResponse.text)
  ) {
    throw new Error(`CreateFile ${remotePath} failed: ${createResponse.text}`);
  }

  const saveResponse = await panelFileApi("SaveFileBody", {
    path: remotePath,
    data: content,
    encoding: "utf-8",
  });
  assertPanelSuccess(saveResponse, `SaveFileBody ${remotePath}`);
}

async function uploadRemoteBinary(remoteDirectory, fileName, fileBuffer) {
  const chunkSize = 10 * 1024 * 1024;
  let offset = 0;
  while (offset < fileBuffer.length) {
    const chunk = fileBuffer.subarray(
      offset,
      Math.min(offset + chunkSize, fileBuffer.length),
    );
    const multipart = buildMultipart(
      {
        f_path: remoteDirectory,
        f_name: fileName,
        f_size: fileBuffer.length,
        f_start: offset,
      },
      "blob",
      chunk,
    );
    const response = await request(
      "POST",
      panelRoute("/files?action=upload", "/files?action=upload"),
      {
        headers: {
          ...authHeaders(multipart.contentType, multipart.body),
          "X-Requested-With": "XMLHttpRequest",
          Referer: new URL("/", AAPANEL_BASE_URL).toString(),
        },
        body: multipart.body,
      },
    );
    assertPanelSuccess(response, `upload ${remoteDirectory}/${fileName}`);
    const nextOffset = Number(response.data.message);
    offset = Number.isInteger(nextOffset) && nextOffset > offset
      ? nextOffset
      : offset + chunk.length;
  }
}

async function remoteFileSize(remotePath) {
  const output = await remoteShell(
    [
      `file_path=${shellQuote(remotePath)}`,
      "[ -f \"$file_path\" ] && printf '__SIZE__%s__\\n' \"$(stat -c %s \"$file_path\")\" || true",
    ].join("\n"),
    "/tmp",
    30000,
  );
  const match = String(output).match(/__SIZE__(\d+)__/);
  return match ? Number(match[1]) : null;
}

function shouldSkip(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    parts.some((part) =>
      [".git", ".venv", ".runtime", "__pycache__", "node_modules"].includes(part)
    )
  ) {
    return true;
  }
  return (
    normalized.endsWith(".pyc") ||
    normalized === ".env" ||
    normalized === ".env.deploy" ||
    normalized === "panel_home.html" ||
    normalized.startsWith("deploy_") ||
    normalized.startsWith("diagnose_") ||
    normalized.startsWith("inspect_") ||
    normalized.startsWith("repair_") ||
    normalized.startsWith("patch_") ||
    normalized.startsWith("bind_")
  );
}

function collectLocalFiles(relativeDirectory = "") {
  const absoluteDirectory = path.join(LOCAL_ROOT, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(absoluteDirectory, {
    withFileTypes: true,
  })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (shouldSkip(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectLocalFiles(relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function localProjectFiles() {
  const required = [
    "app",
    "launcher.py",
    "requirements.txt",
    "ocr_access.json",
    "ocr_access.example.jsonc",
    ".env.example",
    ".env.deploy.example",
    ".gitignore",
  ];
  const files = [];
  for (const relativePath of required) {
    const absolutePath = path.join(LOCAL_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Required local project file is missing: ${relativePath}`);
    }
    if (fs.statSync(absolutePath).isDirectory()) {
      files.push(...collectLocalFiles(relativePath));
    } else {
      files.push(relativePath);
    }
  }
  for (const optionalDirectory of ["models", "packages", "docs"]) {
    files.push(...collectLocalFiles(optionalDirectory));
  }
  for (const optionalFile of ["README.md"]) {
    if (fs.existsSync(path.join(LOCAL_ROOT, optionalFile))) {
      files.push(optionalFile);
    }
  }
  return [...new Set(files)].filter((relativePath) => !shouldSkip(relativePath));
}

function assertLocalModelPackage() {
  if (!OCR_REQUIRE_LOCAL_MODELS) {
    return;
  }

  for (const relativeDirectory of [
    "models/PP-OCRv5_server_det_infer",
    "models/PP-OCRv5_server_rec_infer",
  ]) {
    const modelDirectory = path.join(LOCAL_ROOT, relativeDirectory);
    if (!fs.existsSync(modelDirectory)) {
      throw new Error(
        `OCR_REQUIRE_LOCAL_MODELS=true but ${relativeDirectory} is missing`,
      );
    }

    const modelFiles = collectLocalFiles(relativeDirectory);
    const hasWeights = modelFiles.some((file) =>
      /\.pdiparams$/i.test(file),
    );
    const hasConfig = modelFiles.some((file) =>
      /(?:^|\/)(?:inference|model)\.(?:yml|yaml|json)$/i.test(
        file.replace(/\\/g, "/"),
      ),
    );
    if (!hasWeights || !hasConfig) {
      throw new Error(
        `${relativeDirectory} is not a complete Paddle inference model`,
      );
    }
  }
}

async function uploadProject(remoteRoot) {
  await ensureDirectory(remoteRoot);
  const remoteAccessPath = path.posix.join(remoteRoot, "ocr_access.json");
  const preserveAccessFile = await shouldPreserveRemoteFile(remoteAccessPath);
  if (preserveAccessFile) {
    console.log("preserving remote ocr_access.json");
  }

  for (const relativePath of localProjectFiles()) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (normalized === "ocr_access.json" && preserveAccessFile) {
      continue;
    }
    const remotePath = path.posix.join(remoteRoot, normalized);
    const remoteDirectory = path.posix.dirname(remotePath);
    await ensureDirectory(remoteDirectory);
    const localPath = path.join(LOCAL_ROOT, relativePath);
    const content = fs.readFileSync(localPath);
    if (/\.(?:py|txt|json|jsonc|md|env|gitignore|example)$/i.test(normalized)) {
      await saveRemoteText(remotePath, content.toString("utf8"));
    } else {
      if (
        normalized.startsWith("models/") &&
        await remoteFileSize(remotePath) === content.length
      ) {
        console.log(`kept existing ${normalized}`);
        continue;
      }
      await uploadRemoteBinary(
        remoteDirectory,
        path.posix.basename(remotePath),
        content,
      );
    }
    console.log(`uploaded ${normalized}`);
  }
}

async function getProjects() {
  const response = await panelApi("/project/python/GetProjectList", {
    p: 1,
    limit: 100,
    search: PROJECT_NAME,
  });
  const message = getMessageData(response, "GetProjectList");
  return Array.isArray(message.data) ? message.data : [];
}

async function getEnvironments() {
  const response = await panelApi("/mod/python/environment/list_environment");
  const message = getMessageData(response, "list_environment");
  return Array.isArray(message.env_list) ? message.env_list : [];
}

async function ensurePythonEnvironment(project) {
  const environments = await getEnvironments();
  if (project) {
    const selectedExisting = getExistingProjectEnvironment(project, environments);
    if (selectedExisting && selectedExisting.bin_path) {
      if (await isPythonExecutable(selectedExisting.bin_path)) {
        return selectedExisting;
      }
      console.log(
        `aaPanel project ${PROJECT_NAME} points to a missing Python interpreter ` +
          `${selectedExisting.bin_path}; selecting an available environment`,
      );
    }

    // A project can retain a deleted virtualenv path after its environment is
    // removed in aaPanel. Reuse the normal environment selection logic so the
    // project can be repaired instead of repeatedly running nohup against a
    // dead interpreter.
    const candidates = environments
      .filter((item) => typeof item.bin_path === "string" && item.bin_path)
      .sort((left, right) => {
        const leftIsVenv = left.type === "venv" ? 1 : 0;
        const rightIsVenv = right.type === "venv" ? 1 : 0;
        return rightIsVenv - leftIsVenv;
      });
    for (const candidate of candidates) {
      if (await isPythonExecutable(candidate.bin_path)) {
        return candidate;
      }
    }

    const discovered = await discoverSystemPython();
    if (discovered) {
      return discovered;
    }

    throw new Error(
      `Existing aaPanel project ${PROJECT_NAME} has no usable Python interpreter. ` +
        "Create/select a Python environment in aaPanel, then deploy again.",
    );
  }

  if (PYTHON_ENV_NAME) {
    const selected = environments.find(
      (item) =>
        String(item.venv_name || item.name || "").trim() === PYTHON_ENV_NAME,
    );
    if (!selected || !selected.bin_path) {
      throw new Error(
        `aaPanel virtual environment not found: ${PYTHON_ENV_NAME}. ` +
          `Available environments: ${environments
            .map((item) => item.venv_name || item.name || item.version)
            .join(", ")}`,
      );
    }
    if (!await isPythonExecutable(selected.bin_path)) {
      throw new Error(
        `aaPanel Python environment ${PYTHON_ENV_NAME} is missing or unsupported. ` +
          "This project supports CPython 3.9 through 3.13.",
      );
    }
    return selected;
  }

  const candidates = environments
    .filter((item) => typeof item.bin_path === "string" && item.bin_path)
    .sort((left, right) => {
      const leftIsVenv = left.type === "venv" ? 1 : 0;
      const rightIsVenv = right.type === "venv" ? 1 : 0;
      return rightIsVenv - leftIsVenv;
    });

  for (const candidate of candidates) {
    if (await isPythonExecutable(candidate.bin_path)) {
      return candidate;
    }
  }

  const discovered = await discoverSystemPython();
  if (discovered) {
    return discovered;
  }

  throw new Error(
    "No executable Python interpreter was found through aaPanel or the system PATH.",
  );
}

async function isPythonExecutable(pythonPath) {
  try {
    const minimum = JSON.stringify(MIN_PYTHON_VERSION);
    const maximum = JSON.stringify(MAX_PYTHON_VERSION_EXCLUSIVE);
    const output = await remoteShell(
      [
        "set -e",
        `python_path=${shellQuote(pythonPath)}`,
        `"$python_path" -c 'import sys; raise SystemExit(0 if tuple(${minimum}) <= sys.version_info[:2] < tuple(${maximum}) else 78)'`,
        "printf '__OCR_PYTHON_READY__\\n'",
      ].join("\n"),
      "/tmp",
      30000,
    );
    return String(output).includes("__OCR_PYTHON_READY__");
  } catch {
    return false;
  }
}

async function discoverSystemPython() {
  try {
    const output = await remoteShell(
      [
        "set -e",
        "for candidate in python3 python; do",
        "  if command -v \"$candidate\" >/dev/null 2>&1 && \"$candidate\" -c 'import sys' >/dev/null 2>&1; then",
        "    printf '__OCR_PYTHON_PATH__%s__\\n' \"$(command -v \"$candidate\")\"",
        "    break",
        "  fi",
        "done",
      ].join("\n"),
      "/tmp",
      30000,
    );
    const match = String(output).match(/__OCR_PYTHON_PATH__(.+?)__/);
    if (!match) {
      return null;
    }
    return {
      name: `system (${match[1]})`,
      venv_name: "",
      version: "",
      bin_path: match[1],
      type: "system",
    };
  } catch {
    return null;
  }
}

function projectStartupCommand(environment, remoteRoot) {
  const pythonPath = environment && environment.bin_path
    ? environment.bin_path
    : "python";
  // aaPanel normally changes into the project directory, but command-startup
  // workers on some panel versions do not.  Use an absolute script path so a
  // valid project cannot fail simply because its worker cwd is different.
  const launcherPath = path.posix.join(remoteRoot, "launcher.py");
  return `${shellQuote(pythonPath)} ${shellQuote(launcherPath)}`;
}

function resolveRemoteRoot(project) {
  const config = projectConfigOf(project);
  const existingPath = config && config.path;
  const remoteRoot = existingPath || CONFIG_REMOTE_ROOT;
  if (!remoteRoot) {
    throw new Error(
      "REMOTE_ROOT is required when the aaPanel Python project does not exist. " +
        "Set it to an absolute directory on the target server.",
    );
  }
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error(`REMOTE_ROOT must be an absolute Linux path: ${remoteRoot}`);
  }
  return path.posix.normalize(remoteRoot);
}

function getEnvironmentRoot(environment) {
  if (environment && environment.vpath) {
    return path.posix.normalize(environment.vpath);
  }
  const binPath = path.posix.normalize(environment.bin_path);
  const binDirectory = path.posix.dirname(binPath);
  return path.posix.basename(binDirectory) === "bin"
    ? path.posix.dirname(binDirectory)
    : binDirectory;
}

function getExistingProjectEnvironment(project, environments) {
  const config = projectConfigOf(project);
  const configuredPython = String(config.python_bin || "").trim();
  if (configuredPython) {
    return environments.find(
      (item) => String(item.bin_path || "").trim() === configuredPython,
    ) || {
      name: PROJECT_NAME,
      venv_name: config.venv_name || "",
      version: config.version || "",
      bin_path: configuredPython,
    };
  }

  const configuredVpath = String(config.vpath || "").trim();
  if (configuredVpath) {
    return environments.find(
      (item) =>
        item.bin_path &&
        getEnvironmentRoot(item) === path.posix.normalize(configuredVpath),
    ) || null;
  }

  return null;
}

function projectConfigNeedsUpdate(project, environment, remoteRoot) {
  const config = projectConfigOf(project);
  const expected = buildProjectConfig(project, environment, remoteRoot);
  return [
    "port",
    "stype",
    "path",
    "user",
    "framework",
    "xsgi",
    "requirement_path",
    "env_file",
    "vpath",
    "python_bin",
    "project_cmd",
    "auto_run",
    "processes",
    "threads",
    "is_http",
  ].some((key) => String(config[key] || "") !== String(expected[key] || ""));
}

async function prepareAaPanelPython(environment, remoteRoot) {
  const pythonPath = shellQuote(environment.bin_path);
  const tempPath = shellQuote(runtimeTempPath(remoteRoot));
  const commandLines = [
    "set -e",
    `python_path=${pythonPath}`,
    `tmp_path=${tempPath}`,
    "mkdir -p \"$tmp_path\"",
    "if ! \"$python_path\" -m pip --version >/dev/null 2>&1; then",
    "  installer=\"$tmp_path/get-pip.py\"",
    "  if command -v curl >/dev/null 2>&1; then",
    "    curl -fsSL --retry 3 https://bootstrap.pypa.io/get-pip.py -o \"$installer\"",
    "  elif command -v wget >/dev/null 2>&1; then",
    "    wget -q --tries=3 https://bootstrap.pypa.io/get-pip.py -O \"$installer\"",
    "  else",
    "    echo 'curl or wget is required to bootstrap aaPanel Python pip'",
    "    exit 87",
    "  fi",
    "  if ! \"$python_path\" \"$installer\" --disable-pip-version-check; then",
    "    \"$python_path\" \"$installer\" --disable-pip-version-check --break-system-packages",
    "  fi",
    "  rm -f \"$installer\"",
    "fi",
    "\"$python_path\" -m pip --version >/dev/null 2>&1",
    "printf '__OCR_AAPANEL_PIP_READY__\\n'",
  ];
  const output = await remoteShell(
    commandLines.join("\n"),
    "/tmp",
    Math.max(300000, INSTALL_WAIT_SECONDS * 1000),
  );
  if (!String(output).includes("__OCR_AAPANEL_PIP_READY__")) {
    throw new Error(
      "Could not prepare pip for the aaPanel Python environment." +
        `\n${output}`,
    );
  }
  console.log("aaPanel Python pip is ready");
}

async function preparePythonRuntime(environment, remoteRoot) {
  const pythonPath = shellQuote(environment.bin_path);
  const sitePath = shellQuote(runtimeSitePath(remoteRoot));
  const tempPath = shellQuote(runtimeTempPath(remoteRoot));
  const cachePath = shellQuote(runtimeCachePath(remoteRoot));
  const pipSource = PIP_INDEX_URL
    ? `--index-url ${shellQuote(PIP_INDEX_URL)}`
    : "";
  const pipInstall = [
    `${pythonPath} -m pip install`,
    "--disable-pip-version-check",
    "--no-input",
    "--upgrade",
    "--target \"$site_path\"",
    pipSource,
    "-r \"$project_root/requirements.txt\"",
  ].filter(Boolean).join(" ");
  const commandLines = [
    "set -e",
    `python_path=${pythonPath}`,
    `project_root=${shellQuote(remoteRoot)}`,
    `site_path=${sitePath}`,
    `tmp_path=${tempPath}`,
    `cache_path=${cachePath}`,
    "expected_site=\"$project_root/.runtime/site-packages\"",
    "if [ \"$site_path\" != \"$expected_site\" ]; then",
    "  echo 'Refusing to rebuild an unexpected Python runtime directory'",
    "  exit 89",
    "fi",
    "mkdir -p \"$site_path\" \"$tmp_path\" \"$cache_path\"",
    "exec 9>\"$project_root/.runtime/install.lock\"",
    "if command -v flock >/dev/null 2>&1; then",
    `  flock -w ${INSTALL_WAIT_SECONDS} 9 || { echo 'Timed out waiting for the Python runtime install lock'; exit 90; }`,
    "fi",
    "\"$python_path\" -c 'import sys' >/dev/null",
    "python_abi=$(\"$python_path\" -c 'import sys; print(sys.implementation.cache_tag)')",
    "abi_marker=\"$site_path/.ocr-python-abi\"",
    "reset_site=0",
    "if [ -f \"$abi_marker\" ] && [ \"$(cat \"$abi_marker\")\" != \"$python_abi\" ]; then",
    "  reset_site=1",
    "elif find \"$site_path\" -type f -name '*.cpython-*.so' ! -name \"*.${python_abi}-*.so\" -print -quit | grep -q .; then",
    "  reset_site=1",
    "fi",
    "if [ \"$reset_site\" = 1 ]; then",
    "  echo \"Python ABI changed; rebuilding $site_path for $python_abi\"",
    "  find \"$site_path\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
    "fi",
    "export PYTHONPATH=\"$site_path${PYTHONPATH:+:$PYTHONPATH}\"",
    "export TMPDIR=\"$tmp_path\" TEMP=\"$tmp_path\" TMP=\"$tmp_path\"",
    "export PIP_CACHE_DIR=\"$cache_path\"",
    "requirements_marker=\"$site_path/.ocr-requirements-sha256\"",
    "requirements_hash=$(\"$python_path\" -c 'import hashlib, pathlib, sys; print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' \"$project_root/requirements.txt\")",
    "metadata_code='import importlib.metadata as m; [m.version(name) for name in (\"fastapi\", \"uvicorn\", \"python-multipart\", \"Pillow\", \"numpy\", \"setuptools\", \"paddlepaddle\", \"paddleocr\")]'",
    "runtime_ready=0",
    "if \"$python_path\" -c \"$metadata_code\" >/dev/null 2>&1; then",
    "  if [ ! -f \"$requirements_marker\" ] || [ \"$(cat \"$requirements_marker\")\" = \"$requirements_hash\" ]; then",
    "    runtime_ready=1",
    "  fi",
    "fi",
    "if ! \"$python_path\" -m pip --version >/dev/null 2>&1; then",
    "  installer=$(mktemp)",
    "  if command -v curl >/dev/null 2>&1; then",
    "    curl -fsSL --retry 3 https://bootstrap.pypa.io/get-pip.py -o \"$installer\"",
    "  elif command -v wget >/dev/null 2>&1; then",
    "    wget -q --tries=3 https://bootstrap.pypa.io/get-pip.py -O \"$installer\"",
    "  else",
    "    echo 'curl or wget is required to bootstrap pip'",
    "    exit 87",
    "  fi",
    "  if ! \"$python_path\" \"$installer\" --target \"$site_path\" --disable-pip-version-check; then",
    "    \"$python_path\" \"$installer\" --target \"$site_path\" --disable-pip-version-check --break-system-packages",
    "  fi",
    "  rm -f \"$installer\"",
    "fi",
    "if ! \"$python_path\" -m pip --version >/dev/null 2>&1; then",
    "  echo 'pip bootstrap completed but pip is still unavailable'",
    "  exit 88",
    "fi",
    "if [ \"$runtime_ready\" = 1 ]; then",
    "  echo 'Python requirements are already installed; reusing project runtime'",
    "else",
    `  if ! ${pipInstall}; then`,
    `    ${pipInstall} --break-system-packages`,
    "  fi",
    "fi",
    "printf '%s\\n' \"$python_abi\" > \"$abi_marker\"",
    "printf '%s\\n' \"$requirements_hash\" > \"$requirements_marker\"",
    "printf '__OCR_PYTHON_RUNTIME_READY__\\n'",
  ];
  const command = commandLines.join("\n");
  const output = await remoteShell(
    command,
    "/tmp",
    Math.max(300000, INSTALL_WAIT_SECONDS * 1000),
  );
  if (!String(output).includes("__OCR_PYTHON_RUNTIME_READY__")) {
    throw new Error(
      "Python runtime preparation failed. " +
        "The deployment script could not bootstrap pip or install requirements." +
        `\n${output}`,
    );
  }
  console.log(
    `Python runtime ready in ${runtimeSitePath(remoteRoot)}`,
  );
}

async function addProjectDomain() {
  if (!PROJECT_DOMAIN) {
    return;
  }

  const response = await panelApi("/project/python/AddProjectDomain", {
    data: JSON.stringify({
      name: PROJECT_NAME,
      project_name: PROJECT_NAME,
      domains: [`${PROJECT_DOMAIN}:${PROJECT_DOMAIN_PORT}`],
    }),
  });
  assertPanelSuccess(response, "AddProjectDomain");
  console.log(`aaPanel project domain configured: ${PROJECT_DOMAIN}`);
}

async function ensureProjectDomain() {
  const info = await getProjectInfo();
  const domains = projectDomainEntries(info);
  const matched = domains.some(
    (entry) => domainEntryHost(entry) === PROJECT_DOMAIN.toLowerCase(),
  );
  if (!matched) {
    await addProjectDomain();
  }
}

async function bindProjectExtranet() {
  if (!PROJECT_DOMAIN) {
    return;
  }

  const response = await panelApi("/project/python/BindExtranet", {
    name: PROJECT_NAME,
  });
  assertPanelSuccess(response, "BindExtranet");
  console.log(`aaPanel extranet mapping enabled: ${PROJECT_DOMAIN}`);
  await reloadReverseProxy();
}

async function reloadReverseProxy() {
  const output = await remoteShell(
    [
      "set -e",
      "if [ -x /www/server/nginx/sbin/nginx ]; then",
      "  /www/server/nginx/sbin/nginx -t",
      "  /www/server/nginx/sbin/nginx -s reload",
      "elif command -v nginx >/dev/null 2>&1; then",
      "  nginx -t",
      "  nginx -s reload",
      "elif [ -x /www/server/apache/bin/apachectl ]; then",
      "  /www/server/apache/bin/apachectl -t",
      "  /www/server/apache/bin/apachectl -k graceful",
      "elif [ -x /usr/local/lsws/bin/lswsctrl ]; then",
      "  /usr/local/lsws/bin/lswsctrl reload",
      "else",
      "  echo 'No supported aaPanel reverse proxy was found'",
      "  exit 91",
      "fi",
      "printf '__OCR_REVERSE_PROXY_RELOADED__\\n'",
    ].join("\n"),
    "/tmp",
    120000,
  );
  if (!String(output).includes("__OCR_REVERSE_PROXY_RELOADED__")) {
    throw new Error(`aaPanel reverse proxy reload was not verified:\n${output}`);
  }
  console.log("aaPanel reverse proxy configuration reloaded");
}

async function getProjectSSL() {
  // Python projects expose their effective certificate through GetProjectInfo
  // even on panel builds that do not implement a dedicated Python SSL API.
  try {
    const info = await getProjectInfo();
    if (info && info.ssl && typeof info.ssl === "object") {
      return info.ssl;
    }
  } catch {
    // Fall through to version-specific endpoints below.
  }

  // Python projects and classic websites use different SSL APIs.  Newer
  // aaPanel builds expose the former under /project/python, while older
  // builds create a site record when BindExtranet is enabled.
  const candidates = [
    ["/project/python/GetSSL", { name: PROJECT_NAME }],
    ["/project/python/GetProjectSSL", { name: PROJECT_NAME }],
    ["/project/python/GetSSLConf", { name: PROJECT_NAME }],
    ["/site", { action: "GetSSL", siteName: PROJECT_NAME }],
  ];
  const errors = [];
  for (const [endpoint, values] of candidates) {
    try {
      const response = await panelApi(endpoint, values);
      const message = getMessageData(response, endpoint);
      if (message && typeof message === "object") {
        return message;
      }
    } catch (error) {
      errors.push(`${endpoint}: ${String(error.message || error)}`);
    }
  }
  if (errors.length) {
    console.log(`aaPanel SSL status API unavailable; trying write API (${errors[0]})`);
  }
  return {};
}

async function getInstalledCertificates() {
  const response = await panelApi("/ssl", {
    action: "GetCertList",
    p: 1,
    limit: 200,
  });
  const message = getMessageData(response, "GetCertList");
  if (Array.isArray(message)) {
    return message;
  }
  if (!message || typeof message !== "object") {
    return [];
  }
  for (const key of ["data", "cert_list", "certList", "list", "rows"]) {
    if (Array.isArray(message[key])) {
      return message[key];
    }
  }
  return [];
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text || !(["[", "{"].includes(text[0]))) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function certificateDomains(certificate) {
  if (!certificate || typeof certificate !== "object") {
    return [];
  }

  const values = [
    certificate.certName,
    certificate.name,
    certificate.subject,
    certificate.domain,
    certificate.domains,
    certificate.dns,
    certificate.dns_name,
    certificate.domainList,
    certificate.verify_domains,
    certificate.subjectAltName,
    certificate.subject_alt_name,
    certificate.san,
    certificate.cert_data && certificate.cert_data.dns,
  ];
  const domains = [];
  for (const value of values) {
    const parsedValue = parseMaybeJson(value);
    if (parsedValue !== value) {
      values.push(parsedValue);
      continue;
    }
    if (Array.isArray(value)) {
      domains.push(...value);
    } else if (typeof value === "string") {
      domains.push(...value.split(/[\s,;]+/));
    }
  }
  return domains
    .map((value) => String(value)
      .trim()
      .toLowerCase()
      .replace(/^dns:/, "")
      .replace(/^\*\./, ""))
    .filter(Boolean)
    .map((value) => value.replace(/[.]$/, ""));
}

function certificateName(certificate) {
  if (!certificate || typeof certificate !== "object") {
    return "";
  }
  return String(
      certificate.certName ||
      certificate.name ||
      certificate.cert_name ||
      certificate.ssl_id ||
      certificate.id ||
      "",
  ).trim();
}

function sslBindingEnabled(value) {
  const data = parseMaybeJson(value);
  if (!data || typeof data !== "object") {
    return false;
  }
  // GetProjectInfo returns the certificate metadata directly for Python
  // projects instead of the classic {status, cert_data} shape.
  const directDomains = certificateDomains(data);
  const targetDomain = PROJECT_DOMAIN.toLowerCase();
  if (
    Array.isArray(data.dns) &&
    data.dns.some((item) => String(item).trim()) &&
    (data.issuer || data.issuer_O || data.notAfter || data.subject) &&
    (!targetDomain || directDomains.includes(targetDomain))
  ) {
    return true;
  }
  const status = data.status;
  const statusEnabled = status === true || status === 1 || status === "1";
  const certData = parseMaybeJson(
    data.cert_data || data.certData || data.certificate || data.ssl || {},
  );
  if (!certData || typeof certData !== "object") {
    return statusEnabled;
  }
  const hasCertificate = [
    certData.dns,
    certData.cert,
    certData.cert_pem,
    certData.certName,
    certData.cert_name,
    certData.key,
    certData.key_pem,
  ].some((item) => item !== undefined && item !== null && String(item).trim());
  return statusEnabled && hasCertificate;
}

async function applyLetsEncryptCertificate() {
  if (!AUTO_APPLY_SSL || !PROJECT_DOMAIN || PROJECT_SCHEME !== "https") {
    return false;
  }

  const projectInfo = await getProjectInfo();
  const siteId = Number(projectInfo && projectInfo.id);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error(
      `Cannot apply aaPanel SSL for Python project ${PROJECT_NAME}: site id is missing`,
    );
  }

  const response = await panelApi("/ssl_domain?action=apply_new_ssl", {
    domains: JSON.stringify([PROJECT_DOMAIN]),
    auth_type: "http",
    auto_wildcard: 0,
    // deploy=1 means aaPanel deploys the issued certificate to the selected
    // site/project as part of the asynchronous task.
    deploy: 1,
    site_id: siteId,
  });
  const message = getMessageData(response, "apply_new_ssl");
  const taskId = Number(message && message.task_id);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error(
      `aaPanel SSL request did not return a task id: ${JSON.stringify(message)}`,
    );
  }

  console.log(`aaPanel Let's Encrypt task started: ${taskId}`);
  const deadline = Date.now() + INSTALL_WAIT_SECONDS * 1000;
  let latest = message;
  while (Date.now() < deadline) {
    await delay(5000);
    const statusResponse = await panelApi(
      "/ssl_domain?action=ssl_tasks_status",
      { task_id: taskId },
    );
    latest = getMessageData(statusResponse, "ssl_tasks_status");
    if (!latest || typeof latest !== "object") {
      continue;
    }
    const status = Number(latest.task_status);
    if (status >= 100) {
      const result = String(latest.task_result || "");
      if (/fail|error|failed|失败|错误/i.test(result)) {
        throw new Error(`aaPanel SSL task failed: ${result}`);
      }
      console.log(`aaPanel Let's Encrypt certificate issued for ${PROJECT_DOMAIN}`);
      return true;
    }
    if (status < 0) {
      throw new Error(
        `aaPanel SSL task failed: ${JSON.stringify(latest)}`,
      );
    }
  }

  throw new Error(
    `aaPanel SSL task ${taskId} did not finish within ${INSTALL_WAIT_SECONDS} seconds` +
      `\nLast task state: ${JSON.stringify(latest)}`,
  );
}

async function setProjectCertificate(certName) {
  const payload = {
    name: PROJECT_NAME,
    project_name: PROJECT_NAME,
    certName,
    cert_name: certName,
    ssl: 1,
  };
  const candidates = [
    ["/project/python/SetSSL", payload],
    ["/project/python/SetProjectSSL", payload],
    ["/project/python/SetSSLConf", payload],
    ["/ssl", {
      action: "SetCertToSite",
      certName,
      siteName: PROJECT_NAME,
      projectName: PROJECT_NAME,
    }],
  ];
  const errors = [];
  for (const [endpoint, values] of candidates) {
    try {
      const response = await panelApi(endpoint, values);
      assertPanelSuccess(response, endpoint);
      console.log(`aaPanel SSL API accepted: ${endpoint}`);
      return endpoint;
    } catch (error) {
      errors.push(`${endpoint}: ${String(error.message || error)}`);
    }
  }
  throw new Error(
    `aaPanel could not bind certificate ${certName} to Python project ${PROJECT_NAME}.\n` +
      errors.join("\n"),
  );
}

async function bindInstalledProjectCertificate() {
  if (!PROJECT_DOMAIN || PROJECT_SCHEME !== "https") {
    return;
  }

  const current = await getProjectSSL();
  if (sslBindingEnabled(current)) {
    console.log(`aaPanel project certificate already enabled: ${PROJECT_DOMAIN}`);
    return;
  }

  let certificates = [];
  try {
    certificates = await getInstalledCertificates();
  } catch (error) {
    if (!AUTO_APPLY_SSL) {
      throw error;
    }
    console.log(
      `aaPanel certificate list API unavailable; using automatic issuance: ` +
        `${String(error.message || error)}`,
    );
  }
  const targetDomain = PROJECT_DOMAIN.toLowerCase();
  const matched = certificates.find((certificate) =>
    certificateDomains(certificate).includes(targetDomain),
  );
  const certName = certificateName(matched);
  if (!matched || !certName) {
    if (!AUTO_APPLY_SSL) {
      throw new Error(
        `No installed aaPanel certificate covers ${PROJECT_DOMAIN}. ` +
          "Apply or install this exact domain certificate in aaPanel first, " +
          "or set AUTO_APPLY_SSL=true.",
      );
    }
    await applyLetsEncryptCertificate();
    await bindProjectExtranet();
    await delay(1500);
    const applied = await getProjectSSL();
    if (!sslBindingEnabled(applied)) {
      throw new Error(
        `aaPanel issued a certificate but Python project SSL was not verified for ` +
          `${PROJECT_DOMAIN}: ${JSON.stringify(applied)}`,
      );
    }
    console.log(`aaPanel Let's Encrypt certificate bound and verified: ${PROJECT_DOMAIN}`);
    return;
  }

  const endpoint = await setProjectCertificate(certName);

  // Rebuild the Python project's vhost so the new certificate is used.
  await bindProjectExtranet();
  await delay(1500);
  const updated = await getProjectSSL();
  if (!sslBindingEnabled(updated)) {
    throw new Error(
      `aaPanel certificate API ${endpoint} returned success but binding was not verified for ` +
        `${PROJECT_DOMAIN}: ${JSON.stringify(updated)}`,
    );
  }
  console.log(`aaPanel certificate bound and verified: ${PROJECT_DOMAIN}`);
}

async function waitForPreparation() {
  const deadline = Date.now() + INSTALL_WAIT_SECONDS * 1000;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      latest = await getProjectInfo();
    } catch (error) {
      if (/Installation in Progress|请勿操作|Please Do Not Operate/i.test(
        String(error.message || error),
      )) {
        await delay(5000);
        continue;
      }
      throw error;
    }
    const status = projectConfigOf(latest).prep_status;
    if (status !== "running") {
      return latest;
    }
    await delay(5000);
  }
  throw new Error(
    `aaPanel project preparation did not finish within ${INSTALL_WAIT_SECONDS} seconds` +
      `\nLast project state: ${JSON.stringify(latest)}`,
  );
}

function projectConfigOf(project) {
  if (!project || typeof project !== "object") {
    return {};
  }
  const rawConfig = project.project_config || project;
  if (typeof rawConfig === "string") {
    try {
      const parsed = JSON.parse(rawConfig);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return rawConfig && typeof rawConfig === "object" ? rawConfig : {};
}

function buildProjectConfig(project, environment, remoteRoot) {
  const oldConfig = projectConfigOf(project);
  const domainEntries = Array.isArray(oldConfig.domains)
    ? [...oldConfig.domains]
    : [];
  const domainEntry = PROJECT_DOMAIN
    ? `${PROJECT_DOMAIN}:${PROJECT_DOMAIN_PORT}`
    : "";
  if (domainEntry && !domainEntries.includes(domainEntry)) {
    domainEntries.push(domainEntry);
  }

  return {
    ...oldConfig,
    pjname: PROJECT_NAME,
    port: PROJECT_PORT,
    stype: "command",
    path: remoteRoot,
    user: activeProjectUser,
    requirement_path: project ? (oldConfig.requirement_path || "") : "",
    env_file: path.posix.join(remoteRoot, ".env"),
    env_list: Array.isArray(oldConfig.env_list) ? oldConfig.env_list : [],
    framework: "fastapi",
    vpath: getEnvironmentRoot(environment),
    version: environment.version || "",
    python_bin: environment.bin_path,
    project_cmd: projectStartupCommand(environment, remoteRoot),
    // aaPanel normalizes command-startup projects to this value even when
    // the application itself is ASGI/FastAPI.
    xsgi: "command",
    rfile: oldConfig.rfile || "",
    call_app: oldConfig.call_app || "app",
    auto_run: true,
    processes: 1,
    threads: 1,
    is_http: oldConfig.is_http ?? true,
    domains: domainEntries,
    bind_extranet: oldConfig.bind_extranet ?? 1,
  };
}

async function createOrUpdateProject(project, environment, remoteRoot) {
  const projectConfig = buildProjectConfig(project, environment, remoteRoot);
  const endpoint = project
    ? "/project/python/ChangeProjectConf"
    : "/project/python/CreateProject";
  const data = project
    ? { name: PROJECT_NAME, data: projectConfig }
    : projectConfig;
  const values = { data: JSON.stringify(data) };
  const response = await panelApi(endpoint, values);
  assertPanelSuccess(response, endpoint);
  console.log(
    project
      ? "updated aaPanel Python project"
      : "created aaPanel Python project",
  );
}

async function runRemoteCheck(command, timeoutMilliseconds = 120000) {
  try {
    const output = await remoteShell(command, "/tmp", timeoutMilliseconds);
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: String(error.stack || error.message || error),
    };
  }
}

function pythonImportCheckCommand(environment, remoteRoot) {
  const sitePath = runtimeSitePath(remoteRoot);
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(sitePath)})`,
    "import cv2, PIL, numpy",
    "import paddleocr",
  ].join("; ");
  return [
    `${shellQuote(environment.bin_path)} -c `,
    shellQuote(code),
  ].join("");
}

function installSystemDependenciesCommand() {
  return [
    "set -e",
    "if command -v apt-get >/dev/null 2>&1; then",
    "  export DEBIAN_FRONTEND=noninteractive",
    "  apt-get update",
    "  apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 || apt-get install -y --no-install-recommends libgl1 libglib2.0-0t64 libgomp1",
    "elif command -v dnf >/dev/null 2>&1; then",
    "  dnf install -y mesa-libGL glib2 libgomp",
    "elif command -v yum >/dev/null 2>&1; then",
    "  yum install -y mesa-libGL glib2 libgomp",
    "else",
    "  echo 'Unsupported Linux package manager. Install OpenCV runtime libraries manually: libGL, glib2, libgomp.'",
    "  exit 86",
    "fi",
  ].join("\n");
}

async function ensureSystemDependencies(environment, remoteRoot) {
  const check = await runRemoteCheck(
    pythonImportCheckCommand(environment, remoteRoot),
    180000,
  );
  if (check.ok) {
    console.log("Python OCR runtime imports verified");
    return;
  }

  if (!AUTO_INSTALL_SYSTEM_DEPS) {
    throw new Error(
      "Python OCR runtime import check failed and AUTO_INSTALL_SYSTEM_DEPS=false" +
        `\n${check.output}`,
    );
  }

  console.log("installing missing Linux runtime libraries for OCR");
  await remoteShell(
    installSystemDependenciesCommand(),
    "/tmp",
    Math.max(300000, INSTALL_WAIT_SECONDS * 1000),
  );

  const retry = await runRemoteCheck(
    pythonImportCheckCommand(environment, remoteRoot),
    180000,
  );
  if (!retry.ok) {
    throw new Error(
      "Python OCR runtime import check still failed after installing system dependencies" +
        `\nBefore:\n${check.output}\nAfter:\n${retry.output}`,
    );
  }
  console.log("Linux runtime libraries for OCR are ready");
}

async function getProjectInfo() {
  const response = await panelApi("/project/python/GetProjectInfo", {
    name: PROJECT_NAME,
  });
  return getMessageData(response, "GetProjectInfo");
}

function projectDomainEntries(info) {
  const config = projectConfigOf(info);
  return Array.isArray(config.domains) ? config.domains : [];
}

function domainEntryHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/", 1)[0]
    .split(":", 1)[0];
}

async function verifyProjectDomain() {
  if (!PROJECT_DOMAIN) {
    return;
  }

  const info = await getProjectInfo();
  const domains = projectDomainEntries(info);
  const matched = domains.some(
    (entry) => domainEntryHost(entry) === PROJECT_DOMAIN.toLowerCase(),
  );
  if (!matched) {
    throw new Error(
      `aaPanel project domain binding was not verified: ${PROJECT_DOMAIN}` +
        `\nConfigured domains: ${JSON.stringify(domains)}`,
    );
  }
  console.log(`aaPanel project domain verified: ${PROJECT_DOMAIN}`);
}

async function stopProject() {
  const info = await getProjectInfo();
  if (info.run !== true) {
    return;
  }

  const response = await panelApi("/project/python/StopProject", {
    name: PROJECT_NAME,
  });
  assertPanelSuccess(response, "/project/python/StopProject");

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await delay(2000);
    const latest = await getProjectInfo();
    if (latest.run !== true) {
      console.log("aaPanel project stopped for configuration repair");
      return;
    }
  }
  throw new Error(`aaPanel project ${PROJECT_NAME} did not stop within 60 seconds`);
}

async function startProject() {
  const info = await getProjectInfo();
  const endpoint = info.run
    ? "/project/python/RestartProject"
    : "/project/python/StartProject";
  const response = await panelApi(endpoint, { name: PROJECT_NAME });
  assertPanelSuccess(response, endpoint);

  const deadline = Date.now() + 90000;
  let latest = info;
  while (Date.now() < deadline) {
    await delay(3000);
    latest = await getProjectInfo();
    if (latest.run === true) {
      console.log("aaPanel project is running");
      return latest;
    }
  }

  const logResponse = await panelApi("/project/python/GetProjectLog", {
    name: PROJECT_NAME,
  });
  throw new Error(
    `aaPanel project did not start.\n${logResponse.text}\n` +
      `Last project state: ${JSON.stringify(latest)}`,
  );
}

const publicAgent = new https.Agent({
  rejectUnauthorized: true,
  keepAlive: true,
});

function requestExternal(rawUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const externalRequest = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: publicAgent,
        headers: { Accept: "application/json" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    externalRequest.setTimeout(15000, () => {
      externalRequest.destroy(new Error("public health check timed out"));
    });
    externalRequest.on("error", reject);
    externalRequest.end();
  });
}

async function verifyPublicHealth() {
  if (!VERIFY_PUBLIC_URL || !PROJECT_DOMAIN) {
    return;
  }

  const url = `${PROJECT_SCHEME}://${PROJECT_DOMAIN}/health`;
  const deadline = Date.now() + 90000;
  let lastError = "no response";

  // aaPanel and the reverse proxy can need a few seconds after a restart.
  while (Date.now() < deadline) {
    try {
      const response = await requestExternal(url);
      if (response.status < 200 || response.status >= 300) {
        lastError = `HTTP ${response.status}`;
      } else {
        const data = JSON.parse(response.text);
        if (
          data.code === 200 &&
          data.result === "ok" &&
          data.answer === null
        ) {
          console.log(`public health check passed: ${url}`);
          return;
        }
        lastError = `unexpected response: ${response.text}`;
      }
    } catch (error) {
      lastError = String(error.message || error);
    }
    await delay(3000);
  }

  throw new Error(
    `Public health check failed: ${url}; last result: ${lastError}`,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  assertLocalModelPackage();
  preserveRemoteAccessConfig = PRESERVE_REMOTE_ACCESS_CONFIG;
  await login();
  console.log("aaPanel session established");

  const projects = await getProjects();
  const projectSummary =
    projects.find((item) => item.name === PROJECT_NAME) || null;
  let project = projectSummary;
  if (project) {
    try {
      project = await getProjectInfo();
    } catch (error) {
      if (!/Installation in Progress|请勿操作|Please Do Not Operate/i.test(
        String(error.message || error),
      )) {
        throw error;
      }
    }
  }
  const remoteRoot = resolveRemoteRoot(project);
  activeProjectUser = PROJECT_USER;

  if (SYNC_ONLY) {
    console.log(`local project: ${LOCAL_ROOT}`);
    console.log(`remote project: ${remoteRoot}`);
    await uploadProject(remoteRoot);
    console.log("sync-only upload completed");
    return;
  }

  const environment = await ensurePythonEnvironment(project);

  if (project && projectConfigOf(project).prep_status === "running") {
    project = await waitForPreparation();
  }

  console.log(`local project: ${LOCAL_ROOT}`);
  console.log(`remote project: ${remoteRoot}`);
  console.log(
    `aaPanel Python environment: ${environment.venv_name || environment.name}`,
  );

  const needsConfigUpdate = project && projectConfigNeedsUpdate(
    project,
    environment,
    remoteRoot,
  );
  if (needsConfigUpdate) {
    await stopProject();
  }

  await uploadProject(remoteRoot);
  await saveRemoteText(
    path.posix.join(remoteRoot, ".env"),
    [
      "OCR_MAX_IMAGE_BYTES=8388608",
      `OCR_REQUIRE_LOCAL_MODELS=${OCR_REQUIRE_LOCAL_MODELS ? "true" : "false"}`,
      `OCR_PIP_INDEX_URL=${PIP_INDEX_URL}`,
      "",
    ].join("\n"),
  );
  await prepareAaPanelPython(environment, remoteRoot);
  await preparePythonRuntime(environment, remoteRoot);

  if (!project) {
    await createOrUpdateProject(null, environment, remoteRoot);
    await waitForPreparation();
    project = await getProjectInfo();
    await ensureSystemDependencies(environment, remoteRoot);
    await startProject();
  } else {
    if (needsConfigUpdate) {
      await createOrUpdateProject(project, environment, remoteRoot);
      await ensureSystemDependencies(environment, remoteRoot);
      await startProject();
    } else {
      console.log("aaPanel project configuration is already current");
      await ensureSystemDependencies(environment, remoteRoot);
      await startProject();
    }
  }
  await ensureProjectDomain();
  await bindProjectExtranet();
  await bindInstalledProjectCertificate();
  await verifyProjectDomain();
  await verifyPublicHealth();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  LOCAL_ROOT,
  PROJECT_NAME,
  PROJECT_DOMAIN,
  PROJECT_PORT,
  login,
  request,
  encodeForm,
  getRequestToken: () => requestToken,
  panelApi,
  panelFileApi,
};
