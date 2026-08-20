import type { PdfTextExtractor } from "./types.ts";

/** Usa pdftotext local. A execução nunca envia o PDF a serviços de terceiros. */
export class LocalPdftotextExtractor implements PdfTextExtractor {
  async extract(pdf: Uint8Array): Promise<string> {
    const file = await Deno.makeTempFile({ suffix: ".pdf" });
    try {
      await Deno.writeFile(file, pdf);
      const command = new Deno.Command("pdftotext", {
        args: ["-raw", "-enc", "UTF-8", file, "-"],
      });
      const result = await command.output();
      if (!result.success) {
        throw new Error(
          new TextDecoder().decode(result.stderr).trim() || "pdftotext falhou",
        );
      }
      return new TextDecoder().decode(result.stdout);
    } finally {
      await Deno.remove(file).catch(() => undefined);
    }
  }
}
