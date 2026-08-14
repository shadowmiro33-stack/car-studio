const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");
const { pathToFileURL } = require("url");

let mainWindow = null;
let localServer = null;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

function safeAssetPath(clientRoot, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl).pathname);
  const relativePath = pathname.replace(/^\/+/, "");
  const candidate = path.resolve(clientRoot, relativePath);
  const rootWithSeparator = `${path.resolve(clientRoot)}${path.sep}`;
  return candidate.startsWith(rootWithSeparator) ? candidate : null;
}

function createAssetBinding(clientRoot) {
  return {
    async fetch(request) {
      const assetPath = safeAssetPath(clientRoot, request.url);
      if (!assetPath) return new Response("Forbidden", { status: 403 });

      try {
        const stat = await fs.promises.stat(assetPath);
        if (!stat.isFile()) return new Response("Not found", { status: 404 });
        const body = await fs.promises.readFile(assetPath);
        return new Response(body, {
          status: 200,
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": MIME_TYPES[path.extname(assetPath).toLowerCase()] || "application/octet-stream",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

async function serveStaticAsset(nodeRequest, nodeResponse, clientRoot, origin) {
  if (nodeRequest.method !== "GET" && nodeRequest.method !== "HEAD") return false;

  const assetPath = safeAssetPath(clientRoot, `${origin}${nodeRequest.url || "/"}`);
  if (!assetPath) return false;

  try {
    const stat = await fs.promises.stat(assetPath);
    if (!stat.isFile()) return false;

    nodeResponse.statusCode = 200;
    nodeResponse.setHeader(
      "content-type",
      MIME_TYPES[path.extname(assetPath).toLowerCase()] || "application/octet-stream",
    );
    nodeResponse.setHeader("content-length", stat.size);
    if (nodeRequest.url?.startsWith("/_next/static/")) {
      nodeResponse.setHeader("cache-control", "public, max-age=31536000, immutable");
    }

    if (nodeRequest.method === "HEAD") {
      nodeResponse.end();
    } else {
      fs.createReadStream(assetPath).pipe(nodeResponse);
    }
    return true;
  } catch {
    return false;
  }
}

async function sendWebResponse(nodeResponse, webResponse) {
  nodeResponse.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => nodeResponse.setHeader(name, value));

  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(webResponse.body);
    stream.on("error", reject);
    nodeResponse.on("finish", resolve);
    stream.pipe(nodeResponse);
  });
}

async function startLocalServer() {
  const serverEntry = path.join(__dirname, "dist", "server", "index.js");
  const clientRoot = path.join(__dirname, "dist", "client");
  const workerModule = await import(pathToFileURL(serverEntry).href);
  const worker = workerModule.default;
  const assets = createAssetBinding(clientRoot);

  localServer = http.createServer(async (request, response) => {
    try {
      const address = localServer.address();
      const origin = `http://127.0.0.1:${address.port}`;
      if (await serveStaticAsset(request, response, clientRoot, origin)) return;
      const method = request.method || "GET";
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value != null) headers.set(name, value);
      }

      const init = { method, headers };
      if (method !== "GET" && method !== "HEAD") {
        init.body = Readable.toWeb(request);
        init.duplex = "half";
      }

      const webRequest = new Request(`${origin}${request.url || "/"}`, init);
      const pending = [];
      const executionContext = {
        passThroughOnException() {},
        waitUntil(promise) { pending.push(Promise.resolve(promise)); },
      };
      const webResponse = await worker.fetch(webRequest, { ASSETS: assets }, executionContext);
      await sendWebResponse(response, webResponse);
      Promise.allSettled(pending).catch(() => {});
    } catch (error) {
      console.error("Local server request failed:", error);
      if (!response.headersSent) response.statusCode = 500;
      response.end("Internal server error");
    }
  });

  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });

  return localServer.address().port;
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    title: "CAR STUDIO AI",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    const port = await startLocalServer();
    await createWindow(port);
  } catch (error) {
    console.error("CAR STUDIO AI startup failed:", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (localServer) localServer.close();
  if (process.platform !== "darwin") app.quit();
});
