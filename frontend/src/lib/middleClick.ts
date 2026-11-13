export function suppressMiddleClick(e: MouseEvent): void {
  if (e.button !== 1) return;
  if (!(e.target as Element | null)?.closest?.("a")) return;
  e.preventDefault();
}