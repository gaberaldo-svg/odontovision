import type { DicomVolume } from "./types.ts";
import { voxelSizeMm } from "./volume.ts";

/**
 * Renderizacao 3D por MIP (Maximum Intensity Projection) com limiar em HU.
 *
 * Um raio por pixel atravessa o volume e fica com o **maior** HU que encontra
 * acima do limiar. E a tecnica de sempre em imagem medica: e o que separa a
 * parede do seno maxilar do resto, porque so importa o pico do raio, e nao uma
 * media. Alpha-blending daria um visual mais "nuvem", mais bonito e mais lento,
 * sem revelar estrutura nenhuma a mais.
 *
 * **O limiar e o que faz a imagem aparecer.** Sem ele o raio para no ar
 * (-1000) e a imagem sai preta. O padrao de osso e o que o usuario ve num
 * visualizador comercial.
 *
 * Ortoografica, sem perspectiva: e o que a clinica espera de MPR/3D e remove
 * uma classe inteira de bugs de camera.
 */

export interface Opcoes3d {
  /** Largura do canvas de saida, em pixels. */
  width: number;
  height: number;
  /** Rotacao em torno do eixo Y (vertical da tela), em radianos. */
  yaw: number;
  /** Rotacao em torno do eixo X, em radianos. */
  pitch: number;
  /** Zoom: pixels por milimetro. */
  zoom: number;
  /** Ignora voxels abaixo deste HU. E o "ver so o osso". */
  limiarHu: number;
  /** Janela/centro para mapear HU em cinza. */
  windowWidth: number;
  windowCenter: number;
}

/**
 * Metade das dimensoes fisicas, em mm, do volume.
 *
 * Usar o tamanho fisico e o que impede a imagem de sair esticada: no phantom o
 * eixo z vale 1,00 mm por voxel contra 0,25 em x e y, entao um voxel 3D sem
 * esta conta aparece 4x mais alto. E a mesma pegadinha do aspecto dos planos
 * MPR, so que agora em tres eixos.
 */
export function semiExtremos(volume: DicomVolume): { x: number; y: number; z: number } {
  const s = voxelSizeMm(volume);
  return {
    x: (volume.columns * s.x) / 2,
    y: (volume.rows * s.y) / 2,
    z: (volume.slices * s.z) / 2,
  };
}

/** Matriz 3x3 de rotacao (yaw em Y, depois pitch em X), linha a linha. */
function rotacao(yaw: number, pitch: number): [number, number, number][] {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = Ry(yaw) * Rx(pitch)
  return [
    [cy, sy * sp, sy * cp],
    [0, cp, -sp],
    [-sy, cy * sp, cy * cp],
  ];
}

/**
 * Desenha o volume e devolve os pixels em RGBA, prontos para `putImageData`.
 *
 * `data` e alocado aqui todo servidor para nao alocar um array por quadro: quem
 * chama reaproveita.
 *
 * O parametro de tipo do `Uint8ClampedArray` e explicito porque o TS 5.7 exige
 * `ArrayBuffer` (e nao `ArrayBufferLike`) para passar a `ImageData`, e o
 * padrao seria `ArrayBufferLike`.
 */
export function renderMip(volume: DicomVolume, opts: Opcoes3d): Uint8ClampedArray<ArrayBuffer> {
  const { width, height, yaw, pitch, zoom, limiarHu, windowWidth, windowCenter } = opts;
  const out = new Uint8ClampedArray(width * height * 4);
  const semi = semiExtremos(volume);
  const R = rotacao(yaw, pitch);
  // Ritransposta e a inversa para ortogonal: em vez de transpor a matriz,
  // multiplica-se direto pelos vetores-linha, que ja dao a base da camera.
  const r0 = R[0], r1 = R[1], r2 = R[2];

  const cols = volume.columns, rows = volume.rows, slices = volume.slices;
  const { values, rescaleSlope: slope, rescaleIntercept: intercept } = volume;
  if (cols === 0 || rows === 0 || slices === 0) return out;

  // Passo em mm: metade do menor voxel, para nao pular estrutura fina nem
  // multiplicar a conta sem necessidade.
  const s = voxelSizeMm(volume);
  const passo = Math.max(0.05, Math.min(s.x, s.y, s.z) * 0.5);

  // Meia diagonal: garante cobrir o volume em qualquer rotacao sem testar
  // intersecao com cada face da caixa.
  const alcance = Math.hypot(semi.x, semi.y, semi.z);

  for (let py = 0; py < height; py++) {
    const vy = ((height / 2 - py) / zoom);
    for (let px = 0; px < width; px++) {
      const vx = ((px - width / 2) / zoom);

      // ORTOGRÁFICA: todos os raios são PARALELOS. O que muda por pixel é a
      // origem, no plano da câmera, e não a direção. Construir aqui um raio
      // "da câmera para o pixel" (o que parece natural) faz o raio do canto
      // varrer o volume inteiro na diagonal — a imagem sai com osso nos
      // cantos onde deveria haver ar, e o limiar não separa nada.
      //
      // R é ortogonal, então a inversa é a transposta: multiplicar pelos
      // vetores-LINHA de R já entrega base e direção no mundo.
      // R^T·(0,0,-1) = (-r2[0], -r2[1], -r2[2]): o i-esimo da transposta e a
      // coluna i de R, e aqui isso é a LINHA i de R com o sinal trocado.
      const dx = -r2[0];
      const dy = -r2[1];
      const dz = -r2[2];
      const ox = r0[0] * vx + r1[0] * vy + r2[0] * alcance;
      const oy = r0[1] * vx + r1[1] * vy + r2[1] * alcance;
      const oz = r0[2] * vx + r1[2] * vy + r2[2] * alcance;

      let pico = -Infinity;
      for (let t = 0; t < alcance * 2; t += passo) {
        const x = ox + dx * t;
        const y = oy + dy * t;
        const z = oz + dz * t;
        if (Math.abs(x) > semi.x || Math.abs(y) > semi.y || Math.abs(z) > semi.z) continue;
        // Mundo (mm, centrado) -> indice de voxel. A amostra fica no CENTRO do
        // voxel: amostrar a canto e o mesmo deslize de meio voxel que a
        // documentacao do projeto descreve para o canvas 2D.
        const vx3 = Math.floor((x + semi.x) / s.x);
        const vy3 = Math.floor((y + semi.y) / s.y);
        const vz3 = Math.floor((z + semi.z) / s.z);
        if (vx3 < 0 || vx3 >= cols || vy3 < 0 || vy3 >= rows || vz3 < 0 || vz3 >= slices) continue;
        // Rescale inlined: esta e a linha mais quente do render, e uma chamada
        // de funcao por amostra (milhoes) custa caro.
        const hu = values[(vz3 * rows + vy3) * cols + vx3] * slope + intercept;
        if (hu > pico) pico = hu;
      }

      const i = (py * width + px) * 4;
      if (!Number.isFinite(pico) || pico < limiarHu) {
        // Abaixo do limiar: preto, com alfa opaco. Alfa 0 deixaria o fundo da
        // pagina aparecer e a imagem pareceria "suja".
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
        continue;
      }
      // Mesma curva de janela do 2D (huToGray): o osso fica com o mesmo
      // brilho nos dois modos, e comparar uma imagem com a outra deixa de
      // depender de duas constantes de janela diferentes.
      const ww = Math.max(1, windowWidth);
      const lower = windowCenter - ww / 2;
      let v: number;
      if (pico <= lower) v = 0;
      else if (pico >= lower + ww) v = 255;
      else v = Math.round(((pico - lower) / ww) * 255);
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}
