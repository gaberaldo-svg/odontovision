// Teste E2E da Fase 2: sobe o app, abre no Chrome via CDP, injeta a fixture
// no input de arquivo e verifica o que o browser realmente exibiu.
//
//   node scripts/e2e-dicom.mjs
//
// Requer o build de producao (npm run build) e Chrome/Edge instalado.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SAMPLE = join(ROOT, "samples", "phantom-64.dcm");
const PORT = 3210;
const CDP_PORT = 9222;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome/Edge nao encontrado. Defina CHROME_PATH.");
  return found;
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* ainda subindo */
    }
    await sleep(400);
  }
  throw new Error(`timeout esperando ${url}`);
}

/** Cliente CDP minimo sobre o WebSocket nativo do Node. */
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", reject, { once: true });
    });
    cdp.#ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = cdp.#pending.get(msg.id);
        if (!p) return;
        cdp.#pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const fn of cdp.#listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    return cdp;
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
    });
  }

  close() {
    this.#ws.close();
  }
}

const server = spawn("npm.cmd", ["run", "start", "--", "-p", String(PORT)], {
  cwd: ROOT,
  shell: true,
  stdio: "ignore",
});

let browser;
let cdp;
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // A fixture e gitignored (sao dados binarios regeneraveis).
  if (!existsSync(SAMPLE)) {
    console.log("fixture ausente, gerando com `npm run sample` ...");
    await new Promise((resolve, reject) => {
      const gen = spawn(process.execPath, [join(HERE, "make-sample-dcm.mjs")], {
        cwd: ROOT,
        stdio: "ignore",
      });
      gen.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`gerador saiu com codigo ${code}`)),
      );
      gen.on("error", reject);
    });
  }
  if (!existsSync(SAMPLE)) throw new Error("fixture nao encontrada apos gerar");

  console.log(`\nsubindo app em :${PORT} ...`);
  await waitForHttp(`http://localhost:${PORT}/`);

  const profile = join(tmpdir(), `odontovision-e2e-${Date.now()}`);
  console.log(`abrindo Chrome headless (CDP :${CDP_PORT}) ...`);
  browser = spawn(findBrowser(), [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ], { stdio: "ignore" });

  await waitForHttp(`http://localhost:${CDP_PORT}/json/version`);

  const targets = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);

  const consoleLines = [];
  const pageErrors = [];

  cdp.on("Runtime.consoleAPICalled", (p) => {
    const text = (p.args ?? [])
      .map((a) => a.value ?? a.description ?? JSON.stringify(a.preview ?? {}) ?? "")
      .join(" ");
    consoleLines.push({ level: p.type, text });
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description ?? "exception");
  });

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");

  console.log(`navegando para http://localhost:${PORT}/ ...`);
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
  await sleep(3500);

  console.log("\n-- pagina carregou --");
  const { result: probeRemote } = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      title: document.title,
      hasFileLoader: !!document.querySelector('input[type=file]'),
      accept: document.querySelector('input[type=file]')?.accept ?? null,
      botoes: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 6),
    }))()`,
    returnByValue: true,
  });
  const probe = probeRemote.value ?? {};
  check("title OdontoVision", /OdontoVision/i.test(probe.title ?? ""), probe.title ?? "(vazio)");
  check("input[type=file] presente", probe.hasFileLoader === true);
  check("accept inclui .dcm", /\.dcm/.test(probe.accept ?? ""), probe.accept ?? "");
  check(
    "botao 'Ler arquivo .dcm' existe",
    (probe.botoes ?? []).some((b) => /Ler arquivo/i.test(b)),
    (probe.botoes ?? []).join(" | ").slice(0, 70),
  );

  console.log(`\ninjetando ${SAMPLE} no input ...`);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "input[type=file]",
  });
  if (!nodeId) throw new Error("input[type=file] nao encontrado no DOM");
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [SAMPLE] });

  // o React onChange dispara;aguarda o worker responder
  let status = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[role=status]')?.textContent?.trim() ?? null`,
      returnByValue: true,
    });
    status = result.value;
    if (status) break;
  }

  console.log("\n-- o browser leu o arquivo --");
  check("status apareceu na UI", !!status, status ?? "(vazio)");
  check(
    "status bate com a fixture",
    /64x64/.test(status ?? "") && /46 tags/.test(status ?? "") && /0\.25 x 0\.25 mm/.test(status ?? ""),
  );

  const groupHeader = consoleLines.find((l) => /\[OdontoVision\]/.test(l.text));
  check("console.group com o nome do arquivo", !!groupHeader, groupHeader ? groupHeader.text : "");

  const tableRow = consoleLines.find((l) => l.level === "table");
  check("console.table com os metadados", !!tableRow);

  const pixelLine = consoleLines.find((l) => /pixelData:/.test(l.text));
  check("console.log com pixelData", !!pixelLine, pixelLine ? pixelLine.text.slice(0, 90) : "");

  const tagLine = consoleLines.find((l) => /tags lidas/.test(l.text));
  check("console.log com contagem de tags", !!tagLine, tagLine ? tagLine.text : "");

  check("nenhuma excecao na pagina", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

  console.log("\n-- worker e transferencia --");
  const { result: wireRemote } = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const all = performance.getEntriesByType('resource').map(r => r.name);
      return {
        workerChunks: all.filter(n => /lib_dicom_worker_ts/.test(decodeURIComponent(n))),
        todosChunks: all.filter(n => /_next\\/static\\/chunks/.test(n)).length,
      };
    })()`,
    returnByValue: true,
  });
  const wire = wireRemote.value ?? { workerChunks: [] };
  check(
    "worker (chunk dicom) baixado pelo browser",
    wire.workerChunks.length > 0,
    `${wire.workerChunks.length} chunk(s), ${wire.todosChunks} chunks no total`,
  );

  if (process.env.VERBOSE) {
    console.log("\n=== console do browser ===");
    for (const l of consoleLines) console.log(`[${l.level}] ${l.text}`);
  }

  console.log(`\n${failures === 0 ? "E2E OK" : `E2E: ${failures} falha(s)`}`);
} catch (err) {
  console.error("\nERRO NO E2E:", err.message);
  failures++;
} finally {
  cdp?.close();
  browser?.kill();
  server.kill();
  await sleep(600);
  process.exit(failures === 0 ? 0 : 1);
}
