// Barramento minimo para abrir o seletor de arquivos a partir de qualquer
// lugar da UI sem duplicar o <input type="file">. Existe um unico input
// (dentro do FileLoader); os botoes so pedem para abre-lo.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Assina a abertura do seletor. Retorna a funcao de cancelamento. */
export function onOpenFilePicker(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pede a abertura do seletor de arquivos. */
export function openFilePicker(): void {
  for (const listener of listeners) listener();
}
