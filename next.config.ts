import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // O projeto vive dentro de "Documents\Default Project", e o Next encontra
  // um package-lock.json no diretorio pai e tenta usar como raiz do Turbopack.
  // Fixar a raiz aqui elimina esse aviso em toda build.
  turbopack: {
    root: path.resolve("."),
  },
};

export default nextConfig;