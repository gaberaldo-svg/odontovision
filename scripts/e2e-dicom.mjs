// Teste E2E da Fase 2: sobe o app, abre no Chrome via CDP, injeta a fixture
// no input de arquivo e verifica o que o browser realmente exibiu.
//
//   node scripts/e2e-dicom.mjs
//
// Requer o build de producao (npm run build) e Chrome/Edge instalado.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
// A fixture e a unica fonte do valor esperado: o E2E nao importa a logica de
// montagem do app, importa o phantom para conferir voxel a voxel.
import { huAtVoxel } from "./make-sample-series.mjs";
import { buildFile, el, us, encapsulatedPixelData } from "./lib/dicom-writer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SAMPLE = join(ROOT, "samples", "phantom-64.dcm");
const SERIES_DIR = join(ROOT, "samples", "series");
// Opcional: `npm run fetch:real` traz um JPEG Baseline/Extended real. Sem ele o
// bloco de JPEG e PULADO, com aviso visivel — nunca um "passou" silencioso.
const JPEG_REAL = join(ROOT, "samples", "real", "JPEG-lossy.dcm");
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
      // Lista inteira, sem cortar: o check abaixo procura por "some", e limitar
      // em 6 quebrou o teste da vez que o cabecalho ganhou os botoes de modo
      // (MPR/3D) -- "Pasta" saiu da janela sem ninguem mexer nela.
      botoes: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean),
      canvasAntes: document.querySelectorAll('canvas').length,
    }))()`,
    returnByValue: true,
  });
  const probe = probeRemote.value ?? {};
  check("title OdontoVision", /OdontoVision/i.test(probe.title ?? ""), probe.title ?? "(vazio)");
  check("input[type=file] presente", probe.hasFileLoader === true);
  check("accept inclui .dcm", /\.dcm/.test(probe.accept ?? ""), probe.accept ?? "");
  check(
    "botoes '.dcm' e 'Pasta' existem",
    (probe.botoes ?? []).some((b) => /^\.?dcm$/i.test(b)) && (probe.botoes ?? []).some((b) => /Pasta/i.test(b)),
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
    /64x64/.test(status ?? "") && /47 tags/.test(status ?? "") && /0\.25 x 0\.25 mm/.test(status ?? ""),
    status ?? "",
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

  // --- Fase 4a: serie de 32 cortes, MPR nos tres planos ---
  console.log("\n== FASE 4a: MPR ==");

  if (!existsSync(SERIES_DIR)) {
    console.log("fixture de serie ausente, gerando com `npm run sample:series` ...");
    await new Promise((resolve, reject) => {
      const gen = spawn(process.execPath, [join(HERE, "make-sample-series.mjs")], {
        cwd: ROOT,
        stdio: "ignore",
      });
      gen.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`gerador saiu com codigo ${code}`)),
      );
      gen.on("error", reject);
    });
  }
  const arquivosSerie = readdirSync(SERIES_DIR)
    .filter((f) => f.endsWith(".dcm"))
    .sort();
  check("32 cortes na fixture de serie", arquivosSerie.length === 32, `${arquivosSerie.length}`);

  // Reusa o mesmo input, agora com os 32 arquivos: e o caminho que a UI
  // percorre quando o usuario seleciona a serie inteira.
  const { root: root2 } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId: nodeId2 } = await cdp.send("DOM.querySelector", {
    nodeId: root2.nodeId,
    selector: "input[type=file][multiple]",
  });
  check("input multi-selecao presente", Boolean(nodeId2), nodeId2 ? "" : "nao encontrei input[multiple]");
  await cdp.send("DOM.setFileInputFiles", {
    nodeId: nodeId2,
    files: arquivosSerie.map((f) => join(SERIES_DIR, f)),
  });

  let statusSerie = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[role=status]')?.textContent?.trim() ?? null`,
      returnByValue: true,
    });
    statusSerie = result.value;
    if (statusSerie && /32 cortes/.test(statusSerie)) break;
  }
  check("UI reporta a serie montada", /64x64x32/.test(statusSerie ?? "") && /32 cortes/.test(statusSerie ?? ""),
    statusSerie ?? "(vazio)");
  check("UI informa a estrategia de ordenacao", /ordenado por instanceNumber/.test(statusSerie ?? ""),
    statusSerie ?? "(vazio)");
  check("UI informa o z spacing", /z 1\.00 mm/.test(statusSerie ?? ""), statusSerie ?? "(vazio)");

  /** Estado dos tres viewports: existe canvas? indice atual? quantos cortes? */
  const lerViewports = async () => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const out = {};
        for (const el of document.querySelectorAll('[data-viewport]')) {
          const nome = el.dataset.viewport;
          const canvas = el.querySelector('canvas');
          const rotulo = el.querySelector('[data-slice-index]');
          let dark = true, meio = 0;
          if (canvas && canvas.width > 0) {
            const ctx = canvas.getContext('2d');
            // Um plano renderizado tem uma mancha clara no meio (o nucleo).
            const d = ctx.getImageData(Math.round(canvas.width/2), Math.round(canvas.height/2), 1, 1).data;
            meio = d[0];
            dark = d[0] === 0 && d[1] === 0 && d[2] === 0;
          }
          out[nome] = {
            temCanvas: Boolean(canvas),
            indisponivel: /indispon/i.test(el.textContent ?? ''),
            valor: rotulo ? Number(rotulo.dataset.sliceIndex) : null,
            max: rotulo ? Number(rotulo.dataset.sliceCount) : null,
            dark, meio,
            rect: canvas ? (({x,y,width,height}) => ({x,y,width,height}))(canvas.getBoundingClientRect()) : null,
          };
        }
        return out;
      })()`,
      returnByValue: true,
    });
    // Sem isto, uma excecao dentro do probe vira {} silencioso e o teste
    // falha com "tres viewports presentes" sem dizer por que.
    if (exceptionDetails) {
      throw new Error(
        `probe lerViewports: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    }
    return result.value ?? {};
  };

  const vp = await lerViewports();
  check("tres viewports presentes", Boolean(vp.Axial && vp.Coronal && vp.Sagital),
    Object.keys(vp).join(", "));
  check("Axial tem canvas", vp.Axial?.temCanvas === true);
  check("Coronal deixou de estar indisponivel", vp.Coronal?.indisponivel === false, `indisponivel=${vp.Coronal?.indisponivel}`);
  check("Sagital deixou de estar indisponivel", vp.Sagital?.indisponivel === false, `indisponivel=${vp.Sagital?.indisponivel}`);
  check("Coronal tem canvas", vp.Coronal?.temCanvas === true);
  check("Sagital tem canvas", vp.Sagital?.temCanvas === true);

  check("axial tem 32 cortes", vp.Axial?.max === 32, `cortes=${vp.Axial?.max}`);
  check("coronal percorre 64 linhas", vp.Coronal?.max === 64, `cortes=${vp.Coronal?.max}`);
  check("sagital percorre 64 colunas", vp.Sagital?.max === 64, `cortes=${vp.Sagital?.max}`);

  // O centro do volume e material denso: nenhum dos tres planos pode sair
  // todo preto, o que seria o sintoma de "MPR desenhou a imagem errada".
  check("axial tem conteudo no centro", vp.Axial?.dark === false, `cinza=${vp.Axial?.meio}`);
  check("coronal tem conteudo no centro", vp.Coronal?.dark === false, `cinza=${vp.Coronal?.meio}`);
  check("sagital tem conteudo no centro", vp.Sagital?.dark === false, `cinza=${vp.Sagital?.meio}`);

  // --- geometria da fixture ---
  // Replicada aqui de proposito: o teste precisa saber onde cada voxel cai na
  // tela, mas nao deve copiar a logica de montagem do app.
  const COLS = 64;
  const SLICES = 32;
  const Z_ASPECT = 4; // 1.00 mm de z contra 0.25 mm de pixel
  const PLANOS = {
    Axial: { cols: COLS, rows: COLS, aspect: 1, u: "x", v: "y" },
    Coronal: { cols: COLS, rows: SLICES, aspect: Z_ASPECT, u: "x", v: "z" },
    Sagital: { cols: COLS, rows: SLICES, aspect: Z_ASPECT, u: "y", v: "z" },
  };

  /**
   * Onde a imagem de verdade esta dentro do canvas.
   *
   * O canvas e quadrado (o `aspect-square` do viewport resolve), mas a imagem
   * do plano entra centrada e sobra tarja preta nas duas pontas -- no coronal e
   * no sagital a tarja e enorme, porque a matriz e baixa em Z (32 linhas) e
   * alta em aspecto (4x). Medir por fracao da ALTURA do canvas aponta para o
   * vazio, que e o que fazia o coronal ler ar em todo lugar sem nenhum erro na
   * tela.
   */
  const imagemDoPlano = (plano, rect) => {
    const g = PLANOS[plano];
    // `rows * aspect`: e o que o app compara com `columns` para escolher o
    // scale. Esquecer o aspect aqui faz o ponto cair fora da imagem e o teste
    // acusar MPR quebrado quando o MPR esta certo.
    const escala = Math.min(rect.width, rect.height) / Math.max(g.cols, g.rows * g.aspect);
    const largura = g.cols * escala;
    const altura = g.rows * escala * g.aspect;
    return {
      x: rect.x + (rect.width - largura) / 2,
      y: rect.y + (rect.height - altura) / 2,
      escala,
      g,
    };
  };

  /** Coordenada de viewport do centro do voxel (u, v) dentro do plano. */
  const pontoNoVoxel = async (plano, u, v) => {
    const rect = (await lerViewports())[plano]?.rect;
    if (!rect) return null;
    const img = imagemDoPlano(plano, rect);
    return {
      x: Math.round(img.x + (u + 0.5) * img.escala),
      y: Math.round(img.y + (v + 0.5) * img.escala * img.g.aspect),
    };
  };

  const mouseNoVoxel = async (plano, u, v) => {
    const p = await pontoNoVoxel(plano, u, v);
    if (!p) return { texto: null, alvo: "sem viewport" };
    // Quem esta de fato sob o ponto? Se um overlay cobre o canvas, o hover
    // nunca chega no viewport e o HU fica com o valor anterior.
    const { result: alvoRemote } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        if (!el) return "nada";
        const vp = el.closest('[data-viewport]');
        return (vp ? vp.dataset.viewport : "fora") + "/" + el.tagName.toLowerCase();
      })()`,
      returnByValue: true,
    });
    const alvo = alvoRemote.value ?? "?";
    // dois eventos: o primeiro pode ser tratado como entrada, o segundo move de fato
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none", pointerType: "mouse" });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x + 1, y: p.y, button: "none", pointerType: "mouse" });
    await sleep(320);
    return { texto: await lerHu(), alvo };
  };

  const cliqueNoVoxel = async (plano, u, v) => {
    const p = await pontoNoVoxel(plano, u, v);
    if (!p) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type, x: p.x, y: p.y, button: "left", clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0, pointerType: "mouse",
      });
    }
    await sleep(700);
    return true;
  };

  // --- crosshair sincronizado entre os tres planos ---
  // O indice de cada viewport e uma coordenada do voxel: Axial=z, Coronal=y,
  // Sagital=x. Clicar num plano entao mexe nas DUAS coordenadas livres e
  // preserva a do proprio plano.
  console.log("\n-- crosshair a partir do plano axial --");
  const antesAxial = await lerViewports();
  const cliqueouAxial = await cliqueNoVoxel("Axial", 4, 9);
  check("clique no canvas do axial registrado", cliqueouAxial);
  const depoisAxial = await lerViewports();
  check("sagital (X) foi para o voxel 4", depoisAxial.Sagital?.valor === 4,
    `x: ${antesAxial.Sagital?.valor} -> ${depoisAxial.Sagital?.valor}`);
  check("coronal (Y) foi para o voxel 9", depoisAxial.Coronal?.valor === 9,
    `y: ${antesAxial.Coronal?.valor} -> ${depoisAxial.Coronal?.valor}`);
  check("axial (Z) nao se moveu, ele e o plano clicado",
    depoisAxial.Axial?.valor === antesAxial.Axial?.valor,
    `z: ${antesAxial.Axial?.valor} -> ${depoisAxial.Axial?.valor}`);

  // Clicar no coronal mexe em X (u) e Z (v), e preserva Y.
  console.log("\n-- crosshair a partir do plano coronal --");
  const antesCor = await lerViewports();
  await cliqueNoVoxel("Coronal", 52, 20);
  const depoisCor = await lerViewports();
  check("sagital (X) acompanhou o coronal -> 52", depoisCor.Sagital?.valor === 52,
    `x: ${antesCor.Sagital?.valor} -> ${depoisCor.Sagital?.valor}`);
  check("axial (Z) acompanhou o coronal -> 20", depoisCor.Axial?.valor === 20,
    `z: ${antesCor.Axial?.valor} -> ${depoisCor.Axial?.valor}`);
  check("coronal (Y) ficou onde estava", depoisCor.Coronal?.valor === antesCor.Coronal?.valor,
    `y: ${antesCor.Coronal?.valor} -> ${depoisCor.Coronal?.valor}`);
  check("axial (Z) respeita o limite de 32 cortes", depoisCor.Axial?.valor <= 31,
    `z=${depoisCor.Axial?.valor}`);

  // --- HU exato nos tres planos ---
  // Recentraliza o crosshair no voxel central: com o crosshair no canto, os
  // planos ortogonais ficam inteiramente no ar e nao ha o que comparar.
  console.log("\n-- HU exato nos tres planos --");
  await cliqueNoVoxel("Axial", 32, 31);
  const centro = await lerViewports();
  check("crosshair recentralizado no voxel central",
    centro.Sagital?.valor === 32 && centro.Coronal?.valor === 31,
    `x=${centro.Sagital?.valor} y=${centro.Coronal?.valor}`);

  // (u, v) de cada plano -> voxel, respeitando o eixo que o plano fixa.
  const voxelDoPlano = {
    Axial: (u, v, i) => ({ x: u, y: v, z: i }),
    Coronal: (u, v, i) => ({ x: u, y: i, z: v }),
    Sagital: (u, v, i) => ({ x: i, y: u, z: v }),
  };

  // Atravessa o phantom inteiro no eixo u: ar -> mole -> casca -> nucleo ->
  // massa deslocada -> ar. E no eixo v para provar o aspecto 4x do z.
  const PONTOS = [
    [4, 15], [10, 15], [18, 15], [25, 15], [32, 15], [48, 15], [59, 15],
    [32, 4], [32, 26],
  ];

  const perfisPorPlano = {};
  for (const plano of ["Axial", "Coronal", "Sagital"]) {
    const corte = (await lerViewports())[plano]?.valor;
    const linhas = [];
    const alvos = new Set();
    let todosCerto = true;
    for (const [u, v] of PONTOS) {
      const vox = voxelDoPlano[plano](u, v, corte);
      const esperado = huAtVoxel(vox.x, vox.y, vox.z);
      const { texto, alvo } = await mouseNoVoxel(plano, u, v);
      const lido = paraNum(texto);
      alvos.add(alvo);
      const bate = lido === esperado;
      if (!bate) todosCerto = false;
      linhas.push(`u${u}v${v}=${lido ?? "vazio"}${bate ? "" : ` esperado ${esperado}`}`);
    }
    perfisPorPlano[plano] = linhas.join(" ");
    console.log(`  ${plano} [corte ${corte}]: ${perfisPorPlano[plano]}`);
    check(`${plano}: HU exato do phantom em ${PONTOS.length} pontos`, todosCerto, perfisPorPlano[plano]);
    check(`${plano}: o canvas esta sob o ponteiro`,
      [...alvos].every((a) => a.startsWith(plano)), [...alvos].join(", "));
  }

  // O phantom e assimetrico de proposito: se os tres planos lessem a mesma
  // imagem, um deles estaria desenhando o corte errado.
  check("os tres planos devolvem perfis diferentes",
    new Set(Object.values(perfisPorPlano)).size === 3);

  // --- regua em mm ---
  // A serie e 0,25 mm por voxel na imagem e 1,00 mm entre cortes. As medidas
  // abaixo usam um 3-4-5 de voxels: 12 colunas = 3,00 mm e 16 linhas = 4,00 mm,
  // o que fecha em 5,00 mm exatos em qualquer plano. Se um eixo trocar o
  // espacamento, o resultado sai 3,16 mm ou 5,66 mm -- e o teste acusa.
  console.log("\n-- regua: dois cliques viram uma medida em mm --");

  /** Lista da sidebar: as medicoes confirmadas, como o usuario ve. */
  const lerMedicoes = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => [...document.querySelectorAll('[data-measure]')].map(el => ({
        mm: Number(el.dataset.mm),
        deg: Number(el.dataset.deg),
        kind: el.dataset.measureKind,
        plano: el.dataset.measurePlane,
        corte: Number(el.dataset.measureSlice),
        huA: Number(el.dataset.huA),
        huB: Number(el.dataset.huB),
        huC: el.dataset.huC === undefined ? undefined : Number(el.dataset.huC),
        delta: el.dataset.deltaHu === undefined ? undefined : Number(el.dataset.deltaHu),
        texto: el.textContent.trim(),
      })))()`,
      returnByValue: true,
    });
    return result.value ?? [];
  };

  /** Quantas regras cada viewport esta desenhando. */
  const lerRegras = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const out = {};
        for (const el of document.querySelectorAll('[data-viewport]')) {
          out[el.dataset.viewport] = Number(el.dataset.rulers);
        }
        return out;
      })()`,
      returnByValue: true,
    });
    return result.value ?? {};
  };

  const lerErroMedida = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-measure-error]')?.textContent?.trim() ?? null`,
      returnByValue: true,
    });
    return result.value;
  };

  const apertarEsc = async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    });
    await sleep(250);
  };

  const btnRegua = await realClick('[aria-label="Regua"]');
  check("botao da Regua clicado", !btnRegua.erro, btnRegua.erro ?? "");

  const corteAxial = (await lerViewports()).Axial?.valor;
  // axial: 12 colunas de u e 16 linhas de v, ambos a 0,25 mm.
  await cliqueNoVoxel("Axial", 10, 10);
  check("primeiro clique nao fecha medida", (await lerMedicoes()).length === 0);
  await cliqueNoVoxel("Axial", 22, 26);
  const medidas = await lerMedicoes();
  check("segundo clique fecha uma medida", medidas.length === 1, `n=${medidas.length}`);
  check("distancia axial = 5,00 mm", medidas[0]?.mm === 5, `mm=${medidas[0]?.mm}`);
  check("medida pertence ao plano e ao corte do clique",
    medidas[0]?.plano === "axial" && medidas[0]?.corte === corteAxial,
    `${medidas[0]?.plano} ${medidas[0]?.corte} (corte ${corteAxial})`);
  check("sidebar mostra a medida com 2 casas", /5\.00 mm/.test(medidas[0]?.texto ?? ""),
    medidas[0]?.texto ?? "");
  check("regua desenhada no axial", (await lerRegras()).Axial === 1,
    JSON.stringify(await lerRegras()));
  check("nada desenhado nos outros planos",
    (await lerRegras()).Coronal === 0 && (await lerRegras()).Sagital === 0);

  // --- a medida e do plano e do corte onde foi feita ---
  // Clicar no coronal mexe em X e Z: o axial vai para outro corte e deve
  // esconder a regua. A lista continua com o mesmo item -- nada foi perdido.
  console.log("\n-- a medida so aparece no plano e no corte de origem --");
  const outroCorte = (corteAxial + 8) % 32;
  await cliqueNoVoxel("Coronal", 10, outroCorte);
  const regrasNoOutroCorte = await lerRegras();
  check("axial mudou de corte e escondeu a regua",
    regrasNoOutroCorte.Axial === 0, JSON.stringify(regrasNoOutroCorte));
  check("coronal nunca mostra a regua do axial", regrasNoOutroCorte.Coronal === 0);
  check("a medida continua na lista", (await lerMedicoes()).length === 1);
  // O clique no coronal abriu uma ancora; Escape a descarta para o proximo teste.
  await apertarEsc();

  // Volta o axial ao corte original: agora a regua precisa reaparecer.
  await cliqueNoVoxel("Coronal", 10, corteAxial);
  await apertarEsc();
  check("voltando ao corte a regua volta", (await lerRegras()).Axial === 1,
    JSON.stringify(await lerRegras()));

  // --- o eixo vertical do coronal vale 1,00 mm, nao 0,25 ---
  console.log("\n-- regua no coronal: eixo v usa o espacamento entre cortes --");
  await cliqueNoVoxel("Coronal", 10, 8);
  await cliqueNoVoxel("Coronal", 22, 12);
  const medidaCoronal = (await lerMedicoes()).at(-1);
  check("distancia coronal = 5,00 mm", medidaCoronal?.mm === 5, `mm=${medidaCoronal?.mm}`);
  check("medida coronal guardada como coronal", medidaCoronal?.plano === "coronal",
    medidaCoronal?.plano ?? "");

  // --- Escape cancela a origem ---
  // A origem e um clique, e a medida fecha no seguinte. Depois do Escape a
  // ancora some, entao a distancia final diz QUAL par foi usado.
  console.log("\n-- Escape cancela a regua em andamento --");
  await apertarEsc(); // limpa o par que sobrou do coronal
  const base = (await lerMedicoes()).length;
  await cliqueNoVoxel("Axial", 10, 10); // origem A
  await apertarEsc();
  await cliqueNoVoxel("Axial", 40, 40); // sem Escape, fecharia A->B
  await cliqueNoVoxel("Axial", 44, 56); // com Escape, fecha B->C
  const aposEsc = await lerMedicoes();
  check("Escape nao cria medida nenhuma", aposEsc.length === base + 1, `n=${aposEsc.length}`);
  // B->C: du 4 e dv 16 voxels = 1,00 mm e 4,00 mm -> 4,12 mm. A->B daria 0,00.
  check("a ancora descartada virou B->C", aposEsc.at(-1)?.mm === 4.12,
    `mm=${aposEsc.at(-1)?.mm}`);

  // --- recusas visiveis ---
  console.log("\n-- a regua recusa e explica --");
  await apertarEsc();
  await cliqueNoVoxel("Axial", 20, 20);
  await cliqueNoVoxel("Axial", 20, 20); // mesmo ponto
  check("ponto igual nao cria medida", (await lerMedicoes()).length === aposEsc.length);
  check("ponto igual mostra aviso", await lerErroMedida() !== null, await lerErroMedida() ?? "");

  // --- remover e limpar ---
  console.log("\n-- remover e limpar medicoes --");
  await apertarEsc();
  const remover = await realClick('[aria-label^="Remover medicao"]');
  check("botao de remover encontrado", !remover.erro, remover.erro ?? "");
  await sleep(200);
  const depoisDeRemover = await lerMedicoes();
  check("medidia removida da lista", depoisDeRemover.length === aposEsc.length - 1,
    `n=${depoisDeRemover.length}`);
  // O que esta desenhado tem que ser exatamente o que pertence a este plano e
  // a ESTE corte agora -- o axial ja nao esta no corte original, entao a
  // comparacao usa o indice atual e nao o do primeiro clique.
  const corteAgora = (await lerViewports()).Axial?.valor;
  const esperadasNoAxial = depoisDeRemover.filter(
    (m) => m.plano === "axial" && m.corte === corteAgora).length;
  check("regua do canvas acompanha a lista", (await lerRegras()).Axial === esperadasNoAxial,
    `desenhadas=${(await lerRegras()).Axial} lista no corte ${corteAgora}=${esperadasNoAxial}`);

  const limpar = await realClick("button", "limpar todas");
  check("limpar todas clicado", !limpar.erro, limpar.erro ?? "");
  await sleep(200);
  check("lista vazia depois de limpar", (await lerMedicoes()).length === 0);
  check("nenhuma regua no canvas", Object.values(await lerRegras()).every((n) => n === 0),
    JSON.stringify(await lerRegras()));

  // --- HU nas pontas e delta ---
  // O invariant que importa: o HU da ponta tem que ser exatamente o numero que
  // o readout mostra quando o cursor passa no mesmo voxel. Se a regua lesse o
  // HU por outro caminho, ela discordaria do dado que o usuario confere.
  console.log("\n-- a regua le o HU dos dois pontos --");
  const corteDaMedida = (await lerViewports()).Axial?.valor;
  await cliqueNoVoxel("Axial", 10, 10);
  await cliqueNoVoxel("Axial", 22, 26);
  const comHu = (await lerMedicoes()).at(-1);
  // axial: u=x, v=y, corte = z.
  const huAesperado = huAtVoxel(10, 10, corteDaMedida);
  const huBesperado = huAtVoxel(22, 26, corteDaMedida);
  check("HU da ponta A confere com o phantom", comHu?.huA === huAesperado,
    `regua=${comHu?.huA} phantom=${huAesperado}`);
  check("HU da ponta B confere com o phantom", comHu?.huB === huBesperado,
    `regua=${comHu?.huB} phantom=${huBesperado}`);
  check("delta = ponta B menos ponta A", comHu?.delta === huBesperado - huAesperado,
    `delta=${comHu?.delta} esperado=${huBesperado - huAesperado}`);
  check("sidebar mostra os dois HU", new RegExp(`${huAesperado}.*${huBesperado} HU`).test(comHu?.texto ?? ""),
    comHu?.texto ?? "");

  // Passa o cursor pela ponta A e compara com o que a regua guardou.
  const naPontaA = await mouseNoVoxel("Axial", 10, 10);
  check("readout sob o cursor = HU da ponta A", paraNum(naPontaA.texto) === comHu?.huA,
    `cursor=${naPontaA.texto} regua=${comHu?.huA}`);
  const naPontaB = await mouseNoVoxel("Axial", 22, 26);
  check("readout sob o cursor = HU da ponta B", paraNum(naPontaB.texto) === comHu?.huB,
    `cursor=${naPontaB.texto} regua=${comHu?.huB}`);

  // --- o delta tem sinal, e a ordem decide o sinal ---
  console.log("\n-- o delta troca de sinal com a ordem dos pontos --");
  await apertarEsc();
  await cliqueNoVoxel("Axial", 22, 26);
  await cliqueNoVoxel("Axial", 10, 10);
  const invertida = (await lerMedicoes()).at(-1);
  check("mesmo comprimento medido ao contrario", invertida?.mm === comHu?.mm,
    `mm=${invertida?.mm}`);
  check("pontas trocadas de lugar", invertida?.huA === comHu?.huB && invertida?.huB === comHu?.huA,
    `${invertida?.huA}->${invertida?.huB}`);
  check("delta com sinal invertido", invertida?.delta === -comHu?.delta,
    `delta=${invertida?.delta} esperado=${-comHu?.delta}`);
  check("delta negativo aparece com o sinal", invertida?.delta < 0 ? /-\d+ HU/.test(invertida?.texto ?? "") : true,
    invertida?.texto ?? "");

  // --- HU no coronal: o eixo v e z, e o HU do ponto tem que acompanhar ---
  console.log("\n-- HU no coronal: a ponta em v le z --");
  await apertarEsc();
  // Dois pontos no MESMO u e em v diferentes: se v lesse y em vez de z, os
  // dois cairiam no mesmo voxel e o teste passaria sem ver nada. A varredura
  // escolhe um v cujo HU e de fato diferente, senao o par seria ar nos dois.
  const yCorr = (await lerViewports()).Coronal?.valor;
  const U = 32;
  const huBase = huAtVoxel(U, yCorr, corteDaMedida);
  const outroV = [...Array(32).keys()]
    .map((z) => (corteDaMedida + 1 + z) % 32)
    .find((z) => huAtVoxel(U, yCorr, z) !== huBase);
  check("achou um z com HU diferente do corte da medida", outroV !== undefined,
    `huBase=${huBase}`);
  await cliqueNoVoxel("Coronal", U, corteDaMedida);
  await cliqueNoVoxel("Coronal", U, outroV);
  const corHu = (await lerMedicoes()).at(-1);
  // coronal: u=x, v=z, corte = y.
  check("HU da ponta em v confere com o phantom", corHu?.huB === huAtVoxel(U, yCorr, outroV),
    `regua=${corHu?.huB} phantom=${huAtVoxel(U, yCorr, outroV)}`);
  check("as duas pontas tem HU diferente", corHu?.huA !== corHu?.huB,
    `${corHu?.huA} vs ${corHu?.huB}`);
  check("delta no coronal bate", corHu?.delta === corHu?.huB - corHu?.huA,
    `delta=${corHu?.delta}`);
  // E o mesmo no eixo u: dois pontos com o mesmo v e u diferentes tambem tem
  // que diferir, provando que o eixo horizontal nao esta hardcoded.
  await apertarEsc();
  const huBaseU = huAtVoxel(U, yCorr, outroV);
  const outroU = [...Array(64).keys()]
    .map((x) => (U + 1 + x) % 64)
    .find((x) => huAtVoxel(x, yCorr, outroV) !== huBaseU);
  check("achou um x com HU diferente", outroU !== undefined, `huBaseU=${huBaseU}`);
  await cliqueNoVoxel("Coronal", U, outroV);
  await cliqueNoVoxel("Coronal", outroU, outroV);
  const corHuU = (await lerMedicoes()).at(-1);
  check("HU da ponta em u confere", corHuU?.huA === huAtVoxel(U, yCorr, outroV),
    `regua=${corHuU?.huA} phantom=${huAtVoxel(U, yCorr, outroV)}`);
  check("pontas no eixo u tem HU diferente", corHuU?.huA !== corHuU?.huB,
    `${corHuU?.huA} vs ${corHuU?.huB}`);

  // --- angulo em tres pontos ---
  // Triangulo de voxels escolhido para nao servir os dois planos: os bracos
  // sao (4,4) e (4,-4), que somam zero no axial (grade isotropica de 0,25) e
  // por isso dao 90,0 graus la. No coronal o eixo v vale 1,00 mm, entao o mesmo
  // triangulo vira 151,9. Se o angulo fosse calculado na grade, os dois
  // planos responderiam 90 e o teste passaria sem ver nada.
  console.log("\n-- angulo: tres cliques viram uma medida em graus --");
  // Zera a lista antes: os testes de regua deixam medidas para tras e as
  // contagens abaixo so significam alguma coisa com a lista limpa.
  await realClick("button", "limpar todas");
  // Volta o axial ao corte de referencia antes de medir: os testes de regua
  // mexeram em z ao clicar no coronal, e o angulo herdaria o corte errado --
  // o que faria o HU dos tres pontos bater com outro voxel sem sinal na tela.
  await cliqueNoVoxel("Coronal", 10, corteAxial);
  await apertarEsc();
  const btnAngulo = await realClick('[aria-label="Angulo"]');
  check("botao do Angulo clicado", !btnAngulo.erro, btnAngulo.erro ?? "");

  await cliqueNoVoxel("Axial", 34, 18);
  check("primeiro clique do angulo nao fecha medida", (await lerMedicoes()).length === 0);
  await cliqueNoVoxel("Axial", 30, 14);
  check("segundo clique ainda nao fecha medida", (await lerMedicoes()).length === 0);
  await cliqueNoVoxel("Axial", 34, 10);
  const medidasAposAngulo = await lerMedicoes();
  const angAx = medidasAposAngulo.at(-1);
  check("terceiro clique fecha uma medida", medidasAposAngulo.length === 1, `n=${medidasAposAngulo.length}`);
  check("kind = angle na lista", angAx?.kind === "angle", angAx?.kind ?? "");
  check("angulo no axial = 90,0 graus", angAx?.deg === 90, `deg=${angAx?.deg}`);
  check("sidebar mostra os graus", /90\.0°/.test(angAx?.texto ?? ""), angAx?.texto ?? "");
  check("angulo desenhado no axial", (await lerRegras()).Axial === 1,
    JSON.stringify(await lerRegras()));

  check("angulo do axial fica no corte de referencia",
    angAx?.plano === "axial" && angAx?.corte === corteAxial,
    `${angAx?.plano} ${angAx?.corte} (esperado axial ${corteAxial})`);

  // O mesmo triangulo no coronal. O corte de uma medida coronal e o y, nao o z:
  // no coronal o eixo v e z, entao o primeiro clique fixa y=10.
  await cliqueNoVoxel("Coronal", 10, (corteAxial + 8) % 32);
  await apertarEsc();
  const btnAngulo2 = await realClick('[aria-label="Angulo"]');
  check("tool Angulo reativada no coronal", !btnAngulo2.erro, btnAngulo2.erro ?? "");
  await cliqueNoVoxel("Coronal", 34, 18);
  await cliqueNoVoxel("Coronal", 30, 14);
  await cliqueNoVoxel("Coronal", 34, 10);
  const angCor = (await lerMedicoes()).at(-1);
  check("angulo no coronal = 151,9 graus, nao os 90,0 da grade",
    angCor?.deg === 151.9, `deg=${angCor?.deg}`);
  check("o coronal nao devolve o mesmo numero do axial",
    angCor?.deg !== angAx?.deg, `${angCor?.deg} vs ${angAx?.deg}`);
  check("angulo guardado como coronal, no corte y do clique",
    angCor?.plano === "coronal" && angCor?.corte === 10,
    `${angCor?.plano} ${angCor?.corte}`);

  // Os tres pontos tem HU, e o vertice entra na conta.
  check("tres pontos com HU no axial",
    angAx?.huA === huAtVoxel(34, 18, corteAxial)
      && angAx?.huB === huAtVoxel(30, 14, corteAxial)
      && angAx?.huC === huAtVoxel(34, 10, corteAxial),
    `A=${angAx?.huA}/${huAtVoxel(34, 18, corteAxial)} `
    + `B=${angAx?.huB}/${huAtVoxel(30, 14, corteAxial)} `
    + `C=${angAx?.huC}/${huAtVoxel(34, 10, corteAxial)}`);
  check("angulo nao tem deltaHU", angAx?.delta === undefined, `delta=${angAx?.delta}`);

  // Vertice em cima da ponta: recusado e explicado. O par valido fica de pe, e o
  // clique seguinte completa a medida com ele -- perder os pontos por um erro
  // de um clique seria o pior comportamento aqui.
  console.log("\n-- o angulo recusa vertice degenerado --");
  await apertarEsc();
  await realClick('[aria-label="Angulo"]');
  await cliqueNoVoxel("Coronal", 30, 14);
  await cliqueNoVoxel("Coronal", 36, 18);
  await cliqueNoVoxel("Coronal", 36, 18);
  // Os dois angulos anteriores (axial e coronal) seguem na lista, entao a
  // contagem comeca em 2.
  check("vertice igual a ponta e recusado", (await lerMedicoes()).length === 2,
    `n=${(await lerMedicoes()).length}`);
  check("erro explica o vertice",
    /vertice/i.test((await lerErroMedida()) ?? ""), (await lerErroMedida()) ?? "sem erro");
  await cliqueNoVoxel("Coronal", 34, 10);
  const depoisDoErro = (await lerMedicoes()).at(-1);
  check("o par anterior sobreviveu a recusa", (await lerMedicoes()).length === 3,
    `n=${(await lerMedicoes()).length}`);
  // O vertice guardado e (36,18), com o par (30,14) e a ponta nova (34,10):
  // em coronal, u vale 0,25 e v vale 1,00. Nao precisa ser a prova do angulo
  // em mm -- o do axial ja e -- so que ele usa o par que sobrou, nao um novo.
  check("o angulo Recusado-usou o par guardado", depoisDoErro?.deg === 17,
    `deg=${depoisDoErro?.deg}`);

  // --- relatorio exportavel ---
  // No momento em que isto roda a lista tem o angulo do axial, o do coronal e
  // o do teste de vertice: tres medidas em tres planos/cortes diferentes.
  console.log("\n-- relatorio: o exame inteiro, nao so o corte na tela --");
  const lerRelatorio = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const pre = document.querySelector('[data-report]');
        if (!pre) return null;
        return {
          texto: pre.textContent,
          linhas: pre.textContent.split('\\n').filter(l => l.trim().length > 0),
        };
      })()`,
      returnByValue: true,
    });
    return result.value;
  };

  const rel = await lerRelatorio();
  check("relatorio renderizado", rel !== null);
  check("relatorio traz o cabecalho do exame",
    rel?.texto.startsWith("RELATORIO ODONTOVISION\nPaciente: "), JSON.stringify(rel?.texto.slice(0, 30) ?? ""));
  check("relatorio traz exame e data",
    /Exame: \S+/.test(rel?.texto ?? "") && /Data: \S+/.test(rel?.texto ?? ""));
  check("relatorio traz o voxel", /Voxel: \d+\.\d+ x \d+\.\d+ x \d+\.\d+ mm/.test(rel?.texto ?? ""),
    (rel?.texto ?? "").split("\n").find((l) => l.startsWith("Voxel:")) ?? "");
  // As tres medidas estao em linhas da tabela, inclusive as de outros cortes.
  const linhaDados = rel?.linhas.filter((l) => /^\d+ /.test(l.trim())) ?? [];
  check("relatorio lista as 3 medicoes, de todos os cortes", linhaDados.length === 3,
    `n=${linhaDados.length}`);
  // Sao tres angulos, todos criados aqui: as distancias ficaram para tras,
  // no bloco de testes da regua, que limpa a lista antes de comecar.
  check("relatorio tem tres angulos e nenhuma regua",
    linhaDados.filter((l) => l.includes("angulo")).length === 3
      && linhaDados.every((l) => !l.includes("distancia")),
    linhaDados.join(" || "));
  // A tabela precisa estar alinhada: uma coluna grudada nela e o sinal de que
  // o preenchimento quebrou, e nao aparece em nenhum outro lugar.
  check("colunas da tabela separadas por espaco",
    linhaDados.every((l) => !/distanciaAxial|anguloCoronal|anguloSagital|mm\d/.test(l)),
    linhaDados.join(" || "));
  check("relatorio mostra o total", rel?.texto.includes("Medicoes: 3"), rel?.texto ?? "");

  // O CSV nao e um atributo do DOM: o botao monta um Blob. Ler o texto do
  // relatorio e o que da para conferir sem interceptar o download, entao o
  // E2E garante o conteudo e o unit test garante o CSV byte a byte.
  check("botao de baixar CSV existe",
    (await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Baixar CSV'))`,
      returnByValue: true,
    })).result.value === true);
  check("botao de copiar existe",
    (await cdp.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Copiar'))`,
      returnByValue: true,
    })).result.value === true);

  // --- anotacao de texto ---
  // Digita o rotulo NA SIDEBAR e clica no canvas. O campo e a fonte da verdade:
  // o que o usuario digitar e o que fica amarrado ao ponto.
  console.log("\n-- anotacao: escrever e clicar amarra um rotulo ao ponto --");
  const lerAnotacoes = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => [...document.querySelectorAll('[data-annotation]')].map(el => ({
        texto: el.dataset.annotationText,
        plano: el.dataset.annotationPlane,
        corte: Number(el.dataset.annotationSlice),
        u: Number(el.dataset.annotationU),
        v: Number(el.dataset.annotationV),
        visivel: el.textContent.trim(),
      })))()`,
      returnByValue: true,
    });
    return result.value ?? [];
  };
  const lerRotulosNoCanvas = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const out = {};
        for (const el of document.querySelectorAll('[data-viewport]')) {
          out[el.dataset.viewport] = Number(el.dataset.annotations);
        }
        return out;
      })()`,
      returnByValue: true,
    });
    return result.value ?? {};
  };
  const temAviso = async () => (await cdp.send("Runtime.evaluate", {
    expression: `!!document.querySelector('[data-annotation-hint]')`,
    returnByValue: true,
  })).result.value;

  // Assigning .value direto NAO dispara o onChange do React: precisa do setter
  // nativo do prototype, senao o teste "passa" sem o store ter visto nada.
  // Devolve o valor que o campo ficou, para o teste conferir o efeito.
  const digitarRotulo = async (texto) => {
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-annotation-input]');
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(texto)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    });
    await sleep(200);
    return (await cdp.send("Runtime.evaluate", {
      expression: `(document.querySelector('[data-annotation-input]') || {}).value ?? null`,
      returnByValue: true,
    })).result.value;
  };

  // O corte de referencia: os testes de regua e de angulo mexeram em z ao
  // clicar no coronal, e o axial pode ter ficado em outro corte. Sem voltar
  // aqui, cada anotacao nasceria num corte diferente e nenhuma contagem bateria.
  await cliqueNoVoxel("Coronal", 10, corteAxial);
  await apertarEsc();
  const corteDasAnotacoes = (await lerViewports()).Axial?.valor;
  check("axial voltou ao corte de referencia", corteDasAnotacoes === corteAxial,
    `${corteDasAnotacoes} (esperado ${corteAxial})`);

  await realClick('[aria-label="Anotacao"]');
  // O hint aparece so com a tool ativa E o campo vazio: e por isso que o
  // usuario descobre antes de clicar, e nao depois.
  check("aviso aparece com o campo vazio e a tool ativa", (await temAviso()) === true);

  await digitarRotulo("Nucleo pulposo");
  check("aviso some assim que ha texto", (await temAviso()) === false);

  await cliqueNoVoxel("Axial", 40, 34);
  const anotacoes = await lerAnotacoes();
  check("um clique cria uma anotacao", anotacoes.length === 1, `n=${anotacoes.length}`);
  check("texto do campo e o rotulo", anotacoes[0]?.texto === "Nucleo pulposo",
    JSON.stringify(anotacoes[0]?.texto));
  check("anotacao no plano e corte do clique",
    anotacoes[0]?.plano === "axial" && anotacoes[0]?.corte === corteDasAnotacoes,
    `${anotacoes[0]?.plano} ${anotacoes[0]?.corte}`);
  check("anotacao desenhada no axial", (await lerRotulosNoCanvas()).Axial === 1,
    JSON.stringify(await lerRotulosNoCanvas()));
  check("nada desenhado nos outros planos",
    (await lerRotulosNoCanvas()).Coronal === 0 && (await lerRotulosNoCanvas()).Sagital === 0);
  check("sidebar mostra o rotulo", (anotacoes[0]?.visivel ?? "").includes("Nucleo pulposo"),
    anotacoes[0]?.visivel ?? "");

  // O texto continua no campo: anotar duas vezes seguidas e o caso comum
  // ("canal" e "nervo" no mesmo corte) e nao deve exigir redigitar.
  await digitarRotulo("Canal radicular");
  await cliqueNoVoxel("Axial", 22, 20);
  const duas = await lerAnotacoes();
  check("segunda anotacao com outro texto", duas.length === 2, `n=${duas.length}`);
  check("as duas no mesmo axial", duas.every((a) => a.plano === "axial" && a.corte === corteDasAnotacoes),
    duas.map((a) => `${a.texto}@${a.plano}${a.corte}`).join(" "));
  check("dois rotulos desenhados", (await lerRotulosNoCanvas()).Axial === 2,
    JSON.stringify(await lerRotulosNoCanvas()));

  // Texto longo e cortado com reticencias, e o cortado e o que fica na lista
  // E no canvas: sao a mesma string, nunca uma mais longa que a outra.
  await digitarRotulo("Alveolo mandibular direito setor posterior regiao muito longa mesmo");
  await cliqueNoVoxel("Axial", 12, 12);
  const cortada = (await lerAnotacoes()).at(-1);
  check("rotulo longo cortado no limite",
    cortada?.texto.length === 60 && cortada?.texto.endsWith("\u2026"),
    `len=${cortada?.texto.length} fim=${JSON.stringify(cortada?.texto.slice(-6))}`);
  check("o rotulo cortado e o mesmo na lista",
    (cortada?.visivel ?? "").includes(cortada?.texto ?? "\u0000"),
    (cortada?.visivel ?? "").slice(0, 90));

  // Trocar de corte esconde o rotulo, como com a regua: "Mandibula" no corte 20
  // nao descreve o corte 28.
  // Sai da tool Anotacao antes de navegar: com ela ativa, CADA clique no canvas
  // cria um rotulo, e os cliques de navegacao virariam anotacoes de brinde.
  // (Foi assim que este teste falhou a primeira vez.)
  console.log("\n-- anotacao tambem pertence ao plano e ao corte --");
  await realClick('[aria-label="Janela/Contraste"]');
  await cliqueNoVoxel("Coronal", 10, (corteDasAnotacoes + 8) % 32);
  check("axial mudou de corte e escondeu os rotulos",
    (await lerRotulosNoCanvas()).Axial === 0, JSON.stringify(await lerRotulosNoCanvas()));
  check("as anotacoes continuam na lista", (await lerAnotacoes()).length === 3,
    `n=${(await lerAnotacoes()).length}`);
  await cliqueNoVoxel("Coronal", 10, corteDasAnotacoes);

  // Anotacao em outro plano: a de coronal tem de aparecer so la.
  await realClick('[aria-label="Anotacao"]');
  await digitarRotulo("Sinfise mandibular");
  await cliqueNoVoxel("Coronal", 30, 14);
  check("anotacao no coronal", (await lerAnotacoes()).at(-1)?.plano === "coronal",
    (await lerAnotacoes()).at(-1)?.plano ?? "");
  // Volta ao axial: o clique no coronal move z, entao o axial ficou em outro
  // corte e os tres rotulos de la sumiram. Isso e o filtro por corte
  // funcionando, e o E2E precisa voltar para conferir a contagem.
  await realClick('[aria-label="Janela/Contraste"]');
  await cliqueNoVoxel("Coronal", 10, corteDasAnotacoes);
  const porPlano = await lerRotulosNoCanvas();
  check("anotacao do coronal so aparece no coronal", porPlano.Coronal === 1,
    JSON.stringify(porPlano));
  check("os tres rotulos do axial voltaram com o corte", porPlano.Axial === 3,
    JSON.stringify(porPlano));
  check("sagital nunca mostra rotulo de outro plano", porPlano.Sagital === 0,
    JSON.stringify(porPlano));
  // Campo vazio: o clique nao cria nada. E o mesmo `if` do store, entao o
  // caminho do clique e o do Enter nao podem divergir.
  await realClick('[aria-label="Anotacao"]');
  await digitarRotulo("   ");
  await cliqueNoVoxel("Axial", 18, 44);
  check("campo so com espacos nao cria anotacao", (await lerAnotacoes()).length === 4,
    `n=${(await lerAnotacoes()).length}`);
  check("e o aviso reaparece", (await temAviso()) === true);

  // Remover e limpar.
  console.log("\n-- remover e limpar anotacoes --");
  const removerRotulo = await realClick('[aria-label^="Remover anotacao"]');
  check("botao de remover anotacao clicado", !removerRotulo.erro, removerRotulo.erro ?? "");
  const aposRemover = await lerAnotacoes();
  check("restou uma a menos", aposRemover.length === 3, `n=${aposRemover.length}`);

  // O texto do campo e rascunho, nao resultado: limpar a lista nao pode
  // apagar o que o usuario ja escreveu. Sai da tool antes, porque com ela ativa
  // o proximo clique no canvas viraria anotacao.
  const textoAntes = await digitarRotulo("Anotacao preservada");
  check("campo aceita o rascunho", textoAntes === "Anotacao preservada",
    JSON.stringify(textoAntes));
  await realClick('[aria-label="Janela/Contraste"]');
  // Foto do estado ANTES do "limpar": e o que prova que ele nao mexeu em nada
  // alem da lista de anotacoes.
  const antesDeLimpar = await lerMedicoes();
  // Alvo por aria-label, nao por texto. Do texto "limpar" existem TRES botoes
  // na tela: "limpar" (anotacoes), "limpar todas" (medicoes) e o "Limpar" do
  // topo, que chama clearExam e desmonta a sidebar inteira -- o que zera a
  // lista de medicoes e o relatorio junto, sem nenhum erro visivel. Era
  // exatamente o que o E2E estava fazendo quando comecou a falhar em cascata.
  const limparAnots = await realClick('[aria-label="Limpar anotacoes"]');
  check("botao de limpar anotacoes clicado", !limparAnots.erro, limparAnots.erro ?? "");
  check("a sidebar continua montada depois de limpar",
    (await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector('[data-annotation-input]')`,
      returnByValue: true,
    })).result.value === true);
  check("a lista de medicoes nao foi tocada",
    (await lerMedicoes()).length === antesDeLimpar.length,
    `${antesDeLimpar.length} -> ${(await lerMedicoes()).length}`);
  check("lista de anotacoes vazia", (await lerAnotacoes()).length === 0);
  check("nenhum rotulo desenhado",
    Object.values(await lerRotulosNoCanvas()).every((n) => n === 0),
    JSON.stringify(await lerRotulosNoCanvas()));
  // A prova de que o rascunho sobrevive: o campo e controlado pelo estado, entao
  // o valor continua na tela sem precisar redigitar. Se `limpar` tivesse
  // chamado `setAnnotationText("")`, isto viraria string vazia.
  const textoAposLimpar = (await cdp.send("Runtime.evaluate", {
    expression: `(document.querySelector('[data-annotation-input]') || {}).value ?? null`,
    returnByValue: true,
  })).result.value;
  check("o texto do campo sobrevive ao limpar", textoAposLimpar === textoAntes,
    `antes=${JSON.stringify(textoAntes)} depois=${JSON.stringify(textoAposLimpar)}`);

  // As tres medicoes do bloco de angulo tem de continuar la: "limpar" e das
  // ANOTACOES, e um botao que levasse as medicoes junto seria perda de
  // trabalho sem aviso.
  check("as 3 medicoes do bloco de angulo sobreviveram a limpar anotacoes",
    antesDeLimpar.length === 3 && antesDeLimpar.every((m) => m.kind === "angle"),
    `n=${antesDeLimpar.length} kinds=${antesDeLimpar.map((m) => m.kind).join(" ")}`);
  check("anotacoes nao entram na lista de medicoes",
    antesDeLimpar.every((m) => m.kind !== "text"),
    antesDeLimpar.map((m) => m.kind).join(" "));
  check("relatorio ainda conta as medicoes",
    (await lerRelatorio())?.texto.includes(`Medicoes: ${antesDeLimpar.length}`),
    (await lerRelatorio())?.texto.split("\n").find((l) => l.startsWith("Medicoes:")) ?? "");

  // Esvaziar a lista esvazia o relatorio tambem: as duas coisas andam juntas.
  await realClick("button", "limpar todas");
  const relVazio = await lerRelatorio();
  check("relatorio vazio avisa", relVazio?.texto.includes("Nenhuma medicao registrada."),
    relVazio?.linhas.at(-1) ?? "");
  check("relatorio vazio conta zero", relVazio?.texto.includes("Medicoes: 0"));
  check("relatorio vazio ainda traz o cabecalho do exame",
    relVazio?.texto.startsWith("RELATORIO ODONTOVISION\nPaciente: "));
  check("lista vazia no fim", (await lerMedicoes()).length === 0);

  // --- anotacoes no relatorio ---
  // O defeito que esta fase corrige: existia anotacao na tela e o arquivo
  // exportado nao tinha nenhuma. Ver o texto renderizado; o CSV byte a byte e
  // do unit test, porque o botao monta um Blob que a pagina nao consegue ler.
  console.log("\n-- relatorio inclui as anotacoes --");
  await realClick('[aria-label="Anotacao"]');
  await digitarRotulo("Canal mandibular inferior");
  await cliqueNoVoxel("Axial", 24, 40);
  // Aspas no rotulo: e o caso que quebra CSV de verdade, porque fecha a
  // celula. O unit test prova o dobramento; aqui so que o texto sobrevive
  // inteiro ate a tela.
  await digitarRotulo('Sinfise, parte "central"');
  await cliqueNoVoxel("Coronal", 32, 16);

  // O "limpar todas" do bloco do relatorio ja esvaziou a lista de medicoes,
  // entao este bloco cria uma regua para ter as duas secoes com conteudo.
  await realClick('[aria-label="Regua"]');
  await digitarRotulo("Distancia da regua");
  await cliqueNoVoxel("Axial", 16, 16);
  await cliqueNoVoxel("Axial", 34, 16);
  const medidasAntes = await lerMedicoes();
  check("uma regua criada para o relatorio", medidasAntes.length === 1,
    `n=${medidasAntes.length} kind=${medidasAntes[0]?.kind}`);

  const relComNotas = await lerRelatorio();
  check("relatorio agora conta as anotacoes",
    relComNotas?.texto.includes("Anotacoes: 2"),
    relComNotas?.texto.split("\n").find((l) => l.startsWith("Anotacoes:")) ?? "");
  check("relatorio tem secao ANOTACOES", relComNotas?.texto.includes("ANOTACOES"),
    (relComNotas?.texto ?? "").slice(-160));
  check("relatorio traz o texto da anotacao do axial",
    relComNotas?.texto.includes("Canal mandibular inferior"), "");
  check("relatorio traz o texto da anotacao do coronal",
    relComNotas?.texto.includes('Sinfise, parte "central"'), "");
  check("relatorio traz o ponto da anotacao",
    relComNotas?.texto.includes("(24,40)"), "");
  check("anotacao nao aparece na tabela de medicoes",
    !(relComNotas?.texto ?? "").includes("anotacao    Axial"), "");
  // Cabecalho de coluna da secao de anotacoes: sem ele, o (u,v) lido solto
  // parece valor de medida.
  check("secao de anotacoes tem PONTE e ROTULO",
    /PONTE\s+ROTULO/.test(relComNotas?.texto ?? ""), "");
  // E o relatorio continua sendo do exame inteiro, com a regua E as anotacoes.
  check("relatorio ainda lista a regua",
    relComNotas?.texto.includes("Medicoes: 1"),
    relComNotas?.texto.split("\n").find((l) => l.startsWith("Medicoes:")) ?? "");
  check("relatorio mostra as duas secoes com conteudo",
    relComNotas?.texto.includes("ANOTACOES") && relComNotas?.texto.includes("90.0") === false,
    relComNotas?.texto.split("\n").filter((l) => /^(Medicoes|Anotacoes|ANOTACOES|#)/.test(l)).join(" | "));

  // Limpar as anotacoes tira do relatorio tambem: o arquivo tem de refletir o
  // que esta na tela.
  await realClick('[aria-label="Janela/Contraste"]');
  await realClick('[aria-label="Limpar anotacoes"]');
  const relSemNotas = await lerRelatorio();
  check("limpar anotacoes limpa a secao do relatorio",
    relSemNotas?.texto.includes("Anotacoes: 0")
      && !relSemNotas?.texto.includes("Canal mandibular inferior"),
    relSemNotas?.texto.split("\n").find((l) => l.startsWith("Anotacoes:")) ?? "");
  check("secao ANOTACOES some quando nao ha nenhuma",
    !relSemNotas?.texto.includes("ANOTACOES"), (relSemNotas?.texto ?? "").slice(-120));
  check("as medidas continuam no relatorio",
    relSemNotas?.texto.includes("Medicoes: 1"), relSemNotas?.texto.split("\n").find((l) => l.startsWith("Medicoes:")) ?? "");
  // --- JPEG Baseline/Extended pelo decoder do navegador ---
  // O JPEG em si não é nosso (é o do navegador); o que se prova aqui é que o
  // caminho inteiro funciona: fragmento -> createImageBitmap -> canvas ->
  // valores -> volume -> tela, e que o aviso de "HU aproximado" aparece.
  //
  // Este é o único bloco que depende de `npm run fetch:real`. Sem o arquivo ele
  // é pulado COM AVISO, nunca marcado como passou: um check pulado que parece
  // verde é pior que nenhum.
  if (!existsSync(JPEG_REAL)) {
    console.log("\n-- JPEG: PULADO (rode `npm run fetch:real`) --");
  } else {
    // --- JPEG de 12 bits: tem de recusar COM MOTIVO ---
    // O `JPEG-lossy.dcm` real e JPEG Extended de 12 bits, que o navegador nao
    // decodifica. O que se prova e que a recusa diz "12 bits" e nao o
    // genérico "nao pode decodificar": uma mensagem que nao explica o motivo
    // deixa o usuario sem saber se o arquivo esta corrompido ou se o app e
    // limitado.
    console.log("\n-- JPEG de 12 bits: recusa explicando o motivo --");
    await injetarArquivo(JPEG_REAL);
    let jstatus = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[role=status]')?.textContent?.trim() ?? null`,
        returnByValue: true,
      });
      jstatus = result.value;
      if (jstatus && /12 bits|n.o pode|comprim/i.test(jstatus)) break;
    }
    check("recusa nomeando a precisão de 12 bits",
      !!jstatus && /12 bits/.test(jstatus), jstatus ?? "(vazio)");
    check("não é a recusa genérica de 'comprimido'",
      !!jstatus && !/Sintaxe de transferencia comprimida\. Decodificacao/.test(jstatus),
      (jstatus ?? "").slice(0, 70));
    check("não avisa HU aproximado num arquivo que não abriu",
      (await cdp.send("Runtime.evaluate", {
        expression: `!document.querySelector('[data-hu-aproximado]')`,
        returnByValue: true,
      })).result.value === true);
  }

  // --- JPEG de 8 bits: caminho feliz, com o JPEG gerado pelo próprio navegador ---
  // Não existe no pydicom uma imagem JPEG em tons de cinza de 8 bits, então o
  // arquivo é montado aqui: o browser ENCODEIA um JPEG 8-bit, e o app o
  // DECODIFICA. Isso prova o caminho inteiro — fragmento → createImageBitmap →
  // canvas → valores → volume → tela — com a verdade dos dois lados do mesmo
  // decoder, e sem depender de download.
  console.log("\n-- JPEG de 8 bits: o browser decodifica o que ele mesmo codificou --");
  {
    const gerado = (await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const w = 64, h = 48;
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        // Mesma fantasia da fixture: ar em volta, osso no meio, tecido mole.
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const d = Math.hypot(x - 32, y - 24);
          const g = d > 26 ? 20 : d > 20 ? 120 : 220;
          img.data[i*4] = g; img.data[i*4+1] = g; img.data[i*4+2] = g; img.data[i*4+3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 1 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return { w, h, jpegB64: btoa(s) };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })).result;
    if (gerado?.exceptionDetails || !gerado?.value) {
      throw new Error(`falha ao gerar o JPEG no browser: ${JSON.stringify(gerado).slice(0, 200)}`);
    }
    const { w, h, jpegB64 } = gerado.value;

    const jpeg = Buffer.from(jpegB64, "base64");
    check("o browser produziu um JPEG", jpeg[0] === 0xff && jpeg[1] === 0xd8,
      `${jpeg.length} bytes, inicio ${jpeg.subarray(0, 2).toString("hex")}`);

    // Embrulha num .dcm: PEG do dataset + (7FE0,0010) OB com comprimento
    // indefinido + item da Basic Offset Table + item do frame + delimitador.
    const dcm = embrulhaDcm(jpeg, { columns: w, rows: h });
    const destino = join(ROOT, "samples", "jpeg-8bits-gerado.dcm");
    writeFileSync(destino, dcm);

    await injetarArquivo(destino);
    let st = null;
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[role=status]')?.textContent?.trim() ?? null`,
        returnByValue: true,
      });
      st = result.value;
      if (st && /64x48|corte|bits|nao|recus/i.test(st)) break;
    }
    check("o JPEG de 8 bits foi aceito", !!st && /64x48/.test(st), st ?? "(vazio)");

    const aviso = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-hu-aproximado]')?.textContent?.trim() ?? null`,
      returnByValue: true,
    })).result.value;
    check("aviso de HU aproximado aparece", !!aviso && /aproximado/i.test(aviso),
      (aviso ?? "(sem aviso)").slice(0, 50));

    // O valor lido tem de estar perto do que foi codificado. JPEG e com perda,
    // entao a tolerancia e o que a compressao permite -- e ainda assim muito
    // mais apertada do que "o numero existe".
    // O valor lido tem de estar perto do que foi codificado. JPEG e com perda,
    // entao a tolerancia cobre a perda e nao o bug. Um valor 0 ou 32767
    // reprovaria.
    // Posiciona o cursor no meio do "osso" (o centro da imagem).
    const pos = (await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-viewport="Axial"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`,
      returnByValue: true,
    })).result.value;
    if (!pos) throw new Error("viewport Axial ausente depois de carregar o JPEG");
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: pos.x, y: pos.y, button: "none",
    });
    await sleep(400);
    const { result: med2 } = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-hu]');
        // data-hu e um atributo SEM VALOR: o numero esta no texto. Ler
        // dataset.hu daria Number("") = 0 e o check passaria com o HU errado.
        const t = el?.textContent?.trim() ?? '';
        const n = Number.parseInt(t, 10);
        return { texto: t, hu: Number.isFinite(n) ? n : null };
      })()`,
      returnByValue: true,
    });
    const huCentro = med2.value?.hu;
    check("HU no centro lido", huCentro !== null && huCentro !== undefined,
      JSON.stringify(med2.value ?? null));
    // 220 foi codificado no centro; o JPEG com quality 1 e 8-bit, entao a
    // tolerancia cobre a perda e nao o bug. Um valor 0 ou 32767 reprovaria.
    check("HU proximo do codificado (220 +- 12)",
      typeof huCentro === "number" && Math.abs(huCentro - 220) <= 12, `HU=${huCentro}`);

    // Volta para a fixture: o resto do E2E depende dela.
    await injetarArquivo(SAMPLE);
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[role=status]')?.textContent?.trim() ?? null`,
        returnByValue: true,
      });
      if (result.value && /64x64/.test(result.value)) break;
    }
    check("o aviso some ao trocar de exame",
      (await cdp.send("Runtime.evaluate", {
        expression: `!document.querySelector('[data-hu-aproximado]')`,
        returnByValue: true,
      })).result.value === true);
  }

  /**
   * Injeta um arquivo no input[type=file] e dispara o onChange do React.
   * Declarada como `function` e nao `const` de proposito: o bloco de JPEG
   * acima usa estas duas, e funcao declarada e hoisted.
   */
  async function injetarArquivo(caminho) {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type=file]",
    });
    if (!nodeId) throw new Error("input[type=file] nao encontrado no DOM");
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [caminho] });
    await sleep(300);
  }

  /**
   * Embrulha um JPEG cru num .dcm minimo, usando o MESMO writer das fixtures.
   *
   * Reimplementar o group 0002 aqui foi o que quebrou: a primeira versao
   * esqucia o group length e o dicom-parser lancava "missing required meta
   * header attribute 0002,0010" -- um erro do arquivo de teste, nao do app.
   */
  function embrulhaDcm(jpeg, { columns, rows }) {
    return Buffer.from(buildFile(
      {
        sopClassUid: "1.2.840.10008.5.1.4.1.1.7",
        sopInstanceUid: "1.2.3.4.5.6.7",
        transferSyntaxUid: "1.2.840.10008.1.2.4.50",
        implClassUid: "1.2.3.4.5.6.8",
        implVersion: "ODONTOVISION_TEST",
      },
      [
        el(0x0028, 0x0010, "US", us(rows)),
        el(0x0028, 0x0011, "US", us(columns)),
        el(0x0028, 0x0002, "US", us(1)),
        el(0x0028, 0x0004, "CS", new TextEncoder().encode("MONOCHROME2 ")),
        el(0x0028, 0x0008, "IS", new TextEncoder().encode("1")),
        el(0x0028, 0x0100, "US", us(8)),
        el(0x0028, 0x0101, "US", us(8)),
        el(0x0028, 0x0103, "US", us(0)),
        el(0x0028, 0x0030, "DS", new TextEncoder().encode("0.25\\0.25")),
        encapsulatedPixelData([new Uint8Array(jpeg)]),
      ],
    ));
  }

  // --- 3D por MIP ---
  // O render e JS puro, entao o E2E confere o que importa: o modo existe, o
  // canvas pinta alguma coisa (uma imagem toda preta passaria numa checagem de
  // "o canvas existe"), o limiar muda o resultado e o arraste rotaciona.
  console.log("\n-- 3D: reconstrucao por MIP, limiar e rotacao --");
  {
    const clicar3d = async (sel) => {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        })()`,
        returnByValue: true,
      });
      if (!result.value) throw new Error(`alvo 3D ausente: ${sel}`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", {
          type, x: result.value.x, y: result.value.y, button: "left", clickCount: 1,
        });
      }
      await sleep(600);
    };

    // O botao de modo vive no cabecalho, fora do fluxo MPR.
    await clicar3d('[aria-label="Ver 3D"]');
    const modo = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-view-mode]')?.dataset.viewMode ?? null`,
      returnByValue: true,
    })).result.value;
    check("modo 3D ativado", modo === "3d", String(modo));
    check("viewport 3D existe", (await cdp.send("Runtime.evaluate", {
      expression: `!!document.querySelector('[data-viewport="Volume3D"]')`,
      returnByValue: true,
    })).result.value === true);
    check("os viewports MPR sairam da tela no modo 3D", (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-viewport="Axial"]').length === 0`,
      returnByValue: true,
    })).result.value === true);

    // Amostra o conteudo do canvas 3D: conta de pixels claros, o que
    // distingue "reconstruiu" de "tela preta".
    const contarAcesos = async () => (await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const c = document.querySelector('[data-viewport="Volume3D"] canvas');
        if (!c) return null;
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let acesos = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 0) acesos++;
        return { acesos, total: d.length / 4, w: c.width, h: c.height };
      })()`,
      returnByValue: true,
    })).result.value;

    const comOsso = await contarAcesos();
    check("o 3D renderizou algo visivel", comOsso && comOsso.acesos > 100,
      comOsso ? `${comOsso.acesos} acesos de ${comOsso.total}` : "sem canvas");
    check("a 3D nao esta toda branca (senao o limiar nao filtra nada)",
      comOsso && comOsso.acesos < comOsso.total * 0.95,
      comOsso ? `${((comOsso.acesos / comOsso.total) * 100).toFixed(0)}% acesos` : "");

    // Limiar no maximo: tudo acima da estrutura, tela preta.
    const limiarAlto = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[aria-label="Limiar de HU"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '2500');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
    void limiarAlto;
    await sleep(1200);
    const semOsso = await contarAcesos();
    check("limiar alto esvazia a imagem", semOsso && semOsso.acesos === 0,
      semOsso ? `${semOsso.acesos} acesos` : "");
    check("o atributo do limiar acompanhou o slider",
      (await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('[data-viewport="Volume3D"]')?.dataset['3dThreshold'] ?? null`,
        returnByValue: true,
      })).result.value === "2500");

    // Volta para um limiar que mostra osso e mede a rotacao.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[aria-label="Limiar de HU"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '300');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    });
    await sleep(1200);

    const pos3d = (await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-viewport="Volume3D"] canvas');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`,
      returnByValue: true,
    })).result.value;

    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: pos3d.x, y: pos3d.y, button: "left", clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: pos3d.x + 120, y: pos3d.y + 40, button: "left",
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: pos3d.x + 120, y: pos3d.y + 40, button: "left", clickCount: 1,
    });
    await sleep(1200);

    const yawDepois = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-viewport="Volume3D"]')?.dataset['3dYaw'] ?? null`,
      returnByValue: true,
    })).result.value;
    check("o arraste girou a cena", yawDepois !== null && Math.abs(Number(yawDepois) + 0.7) > 0.05,
      `yaw=${yawDepois}`);
    const depoisDoGiro = await contarAcesos();
    check("girar mudou a imagem renderizada",
      depoisDoGiro && comOsso && depoisDoGiro.acesos !== comOsso.acesos,
      `antes=${comOsso?.acesos} depois=${depoisDoGiro?.acesos}`);

    // Volta para MPR: o resto do E2E depende das tres vistas.
    await clicar3d('[aria-label="Ver MPR"]');
    check("voltou para MPR", (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-view-mode]')?.dataset.viewMode === 'mpr'`,
      returnByValue: true,
    })).result.value === true);
    check("os tres viewports voltaram", (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('[data-viewport="Axial"]').length === 1`,
      returnByValue: true,
    })).result.value === true);
  }

  check("nenhuma excecao na pagina apos a serie", pageErrors.length === 0,
    pageErrors.join(" | ").slice(0, 200));

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
