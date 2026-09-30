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

  // Headless abre em 800x600, abaixo do breakpoint `lg` (1024px) onde a sidebar
  // fica visivel. Sem isso, [data-hu] nunca existe e o teste de HU falha.
  const VIEW_W = 1600;
  const VIEW_H = 1000;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEW_W,
    height: VIEW_H,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log(`navegando para http://localhost:${PORT}/ (viewport ${VIEW_W}x${VIEW_H}) ...`);
  await cdp.send("Page.navigate", { url: `http://localhost:${PORT}/` });
  await sleep(3500);

  console.log("\n-- pagina carregou --");
  const { result: probeRemote } = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      title: document.title,
      hasFileLoader: !!document.querySelector('input[type=file]'),
      accept: document.querySelector('input[type=file]')?.accept ?? null,
      botoes: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 6),
      canvasAntes: document.querySelectorAll('canvas').length,
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
  check("nenhum canvas antes de carregar", probe.canvasAntes === 0, `${probe.canvasAntes}`);

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

  const volumeLine = consoleLines.find((l) => /volume:/.test(l.text));
  check("console.log com o volume", !!volumeLine, volumeLine ? volumeLine.text.slice(0, 90) : "");

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

  // --- Fase 3: o canvas mostra a imagem real? ---
  // A fixture e um phantom concentrico em camadas. Na coluna central:
  //   y 0-6 ar (-900) | 8-18 mole (120) | 20-22 casca (900)
  //   y 24-38 nucleo (2200) | 40-42 casca | 44-54 mole | 56-63 ar
  // Normalizado sobre a altura: ar=0.03, mole=0.25, casca=0.32,
  // nucleo=0.50, cascaInf=0.64.
  console.log("\n-- canvas renderizou a imagem real --");
  const readProfile = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const c = document.querySelector('canvas');
        if (!c) return { erro: 'sem canvas' };
        const ctx = c.getContext('2d');
        const w = c.width, h = c.height;
        const cinza = (fx, fy) => {
          const d = ctx.getImageData(Math.round(w * fx), Math.round(h * fy), 1, 1).data;
          return d[0];
        };
        return {
          w, h,
          dpr: window.devicePixelRatio || 1,
          cssW: c.clientWidth, cssH: c.clientHeight,
          // retangulo do canvas em coordenadas da viewport, para o mouse
          rect: (({ x, y, width, height }) => ({ x, y, width, height }))(c.getBoundingClientRect()),
          ar: cinza(0.5, 0.03),
          mole: cinza(0.5, 0.25),
          casca: cinza(0.5, 0.32),
          nucleo: cinza(0.5, 0.50),
          cascaInf: cinza(0.5, 0.64),
          arInf: cinza(0.5, 0.97),
          cor: (() => { const d = ctx.getImageData(Math.round(w/2), Math.round(h/2), 1, 1).data; return [d[0],d[1],d[2],d[3]]; })(),
        };
      })()`,
      returnByValue: true,
    });
    return result.value ?? {};
  };

  const cv = await readProfile();
  check("canvas existe", !cv.erro, cv.erro ?? "");
  check("canvas tem pixels", (cv.w ?? 0) > 0 && (cv.h ?? 0) > 0, `${cv.w}x${cv.h} @dpr${cv.dpr}`);
  check("render em cinza opaco (R=G=B, A=255)",
    cv.cor?.[0] === cv.cor?.[1] && cv.cor?.[1] === cv.cor?.[2] && cv.cor?.[3] === 255,
    `${cv.cor?.join("/")}`);

  // Janela da fixture: wc=400 ww=400 -> corte em 200 e 600.
  // ar e mole ficam pretos; casca e nucleo ficam brancos.
  check("ar preto", cv.ar === 0, `cinza=${cv.ar}`);
  check("tecido mole preto (abaixo de 200)", cv.mole === 0, `cinza=${cv.mole}`);
  check("casca branca (acima de 600)", cv.casca === 255, `cinza=${cv.casca}`);
  check("nucleo branco", cv.nucleo === 255, `cinza=${cv.nucleo}`);
  check("casca inferior branca", cv.cascaInf === 255, `cinza=${cv.cascaInf}`);
  check("ar inferior preto", cv.arInf === 0, `cinza=${cv.arInf}`);

  // Contraste antes do preset, para comparar depois.
  const antes = { mole: cv.mole, nucleo: cv.nucleo, ar: cv.ar, casca: cv.casca };

  // --- O preset W/L realmente redesenha os pixels? ---
  console.log("\n-- preset W/L altera o contraste renderizado --");

  /** Clique de verdade: Base UI abre o menu em pointerdown, nao em click. */
  const realClick = async (selector, textMatch) => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = ${textMatch ? `els.find(e => new RegExp(${JSON.stringify(textMatch)}, 'i').test(e.textContent ?? ''))` : "els[0]"};
        if (!el) return { erro: 'alvo nao encontrado' };
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, texto: el.textContent?.trim() ?? '' };
      })()`,
      returnByValue: true,
    });
    const v = result.value ?? {};
    if (v.erro) return v;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(v.x),
        y: Math.round(v.y),
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(400);
    return v;
  };

  const btnWl = await realClick("button", "W/L");
  check("botao W/L clicado", !btnWl.erro, btnWl.texto ?? btnWl.erro ?? "");

  const { result: itensRemote } = await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('[data-slot=dropdown-menu-item]')].map(e => e.textContent.trim())`,
    returnByValue: true,
  });
  const itens = itensRemote.value ?? [];
  check("menu de presets realmente abriu", itens.length >= 3, `itens: ${itens.join(", ")}`);

  const pick = await realClick("[data-slot=dropdown-menu-item]", "Osso Geral");
  check("preset 'Osso Geral' acionado", !pick.erro && /Osso Geral/.test(pick.texto ?? ""), pick.texto ?? pick.erro ?? "");
  await sleep(600);

  // O item precisa ter alterado o estado do store, nao so fechado o menu.
  const { result: rotuloWl } = await cdp.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find(b => /W\\/L|Osso Geral|Esmalte/.test(b.textContent))?.textContent?.trim() ?? ""`,
    returnByValue: true,
  });
  check("trigger mostra o preset ativo", /Osso Geral/.test(rotuloWl.value ?? ""), `rotulo="${rotuloWl.value}"`);

  // fecha o menu para nao interceptar o mouse no canvas
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);

  const depois = await readProfile();
  // Osso Geral = ww 2000 / wc 450 -> janela [-550, 1450].
  // Com a janela nativa 400/400 = [200, 600] o tecido mole (120) e o ar ficam
  // pretos e a casca (900) satura. Ao abrir a janela o mole entra e a casca dessatura.
  check("ar continua preto em Osso Geral", (depois.ar ?? -1) === 0, `cinza=${depois.ar}`);
  check("mole ~85 em Osso Geral", Math.abs((depois.mole ?? 0) - 85) <= 2, `cinza=${depois.mole}`);
  check("casca ~185 em Osso Geral", Math.abs((depois.casca ?? 0) - 185) <= 2, `cinza=${depois.casca}`);
  check("nucleo satura em Osso Geral", (depois.nucleo ?? 0) === 255, `cinza=${depois.nucleo}`);
  check("contraste aumentou (mole saiu do preto)", (depois.mole ?? 0) > antes.mole,
    `${antes.mole} -> ${depois.mole}`);
  check("casca dessaturou", (depois.casca ?? 255) < antes.casca,
    `${antes.casca} -> ${depois.casca}`);

  // --- HU real sob o cursor ---
  console.log("\n-- HU lido do volume sob o cursor --");
  // dispatchMouseEvent usa coordenadas da viewport, entao somamos o rect do canvas.
  const lerHu = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-hu]')?.textContent?.trim() ?? null`,
      returnByValue: true,
    });
    return result.value;
  };
  const passarMouse = async (fx, fy) => {
    const x = Math.round(cv.rect.x + cv.rect.width * fx);
    const y = Math.round(cv.rect.y + cv.rect.height * fy);
    // dois eventos: o primeiro pode ser tratado como entrada, o segundo move de fato
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 1, y, button: "none" });
    await sleep(320);
    return lerHu();
  };
  const paraNum = (t) => {
    const n = Number.parseInt(String(t ?? "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };

  // Varre a linha vertical central. Cada fracao esta dentro de uma camada do
  // phantom, mas o teste nao deve depender de acerto de geometria: o que importa
  // e que aparecam valores negativos E positivos coerentes com as camadas.
  const amostras = [];
  for (const fy of [0.02, 0.06, 0.12, 0.16, 0.22, 0.26, 0.32, 0.45, 0.55, 0.62, 0.66, 0.90, 0.94, 0.98]) {
    const texto = await passarMouse(0.5, fy);
    amostras.push({ fy, texto, hu: paraNum(texto) });
  }
  console.log("  varredura:", amostras.map((a) => `${a.fy}:${a.texto ?? "vazio"}`).join("  "));

  const lidos = amostras.map((a) => a.hu).filter((v) => v !== null);
  check("HU aparece na sidebar em varios pontos", lidos.length >= 8,
    `${lidos.length}/${amostras.length} pontos com HU`);
  check("HU na casca ~900", lidos.some((v) => Math.abs(v - 900) < 60),
    amostras.filter((a) => a.hu !== null).map((a) => `${a.fy}:${a.hu}`).join(" "));
  check("HU negativo no ar", lidos.some((v) => v < -500 && v > -1000),
    amostras.filter((a) => a.hu !== null).map((a) => `${a.fy}:${a.hu}`).join(" "));
  check("HU varia com a camada (nao e constante)", new Set(lidos).size >= 3,
    `distintos: ${[...new Set(lidos)].join(", ")}`);

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
