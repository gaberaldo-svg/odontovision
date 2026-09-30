// Teste E2E da Fase 2: sobe o app, abre no Chrome via CDP, injeta a fixture
// no input de arquivo e verifica o que o browser realmente exibiu.
//
//   node scripts/e2e-dicom.mjs
//
// Requer o build de producao (npm run build) e Chrome/Edge instalado.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
// A fixture e a unica fonte do valor esperado: o E2E nao importa a logica de
// montagem do app, importa o phantom para conferir voxel a voxel.
import { huAtVoxel } from "./make-sample-series.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SAMPLE = join(ROOT, "samples", "phantom-64.dcm");
const SERIES_DIR = join(ROOT, "samples", "series");
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
        plano: el.dataset.measurePlane,
        corte: Number(el.dataset.measureSlice),
        huA: Number(el.dataset.huA),
        huB: Number(el.dataset.huB),
        delta: Number(el.dataset.deltaHu),
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

  const limparHu = await realClick("button", "limpar todas");
  check("cleanup: limpar todas", !limparHu.erro, limparHu.erro ?? "");
  check("lista vazia no fim", (await lerMedicoes()).length === 0);

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
