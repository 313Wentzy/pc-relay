export function mountConsole(
  root: HTMLElement,
  options?: {
    controls?: HTMLElement | null;
    authorize?: () => Promise<{ relay: string; ticket: string }>;
  },
): () => void;
