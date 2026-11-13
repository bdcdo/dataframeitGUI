// Dispara no navegador o download de um Blob gerado no cliente (os exports em
// CSV/XLSX). Compartilhado pelos cards de export da página Documentos.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
