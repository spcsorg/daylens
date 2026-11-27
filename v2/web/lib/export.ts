import writeXlsxFile from "write-excel-file/node";
import type { Table } from "./tables";

/** The one way a table leaves Daylens (FR-24): Excel or CSV, built on the server from the rows the screen shows. */

export type Format = "xlsx" | "csv";

/** CSV text a spreadsheet would run as a formula starts with a quote instead. Excel cells are written as text, so they never run. */
const inert = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function toCsv(table: Table): string {
  const cell = (v: string | number | null) => {
    if (v === null) return "";
    if (typeof v === "number") return String(v);
    const s = inert(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return "\uFEFF" + [table.columns, ...table.rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export async function toXlsx(table: Table): Promise<Buffer> {
  const header = table.columns.map((value) => ({ value, fontWeight: "bold" as const }));
  return writeXlsxFile([header, ...table.rows], {
    sheet: table.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31),
    stickyRowsCount: 1,
    columns: table.columns.map((c, i) => ({ width: Math.min(40, Math.max(8, c.length + 2, ...table.rows.map((r) => String(r[i] ?? "").length + 2))) })),
  }).toBuffer();
}

/** A download response: `file` is the name without its extension. */
export async function download(table: Table, format: Format, file: string): Promise<Response> {
  const body = format === "csv" ? toCsv(table) : new Uint8Array(await toXlsx(table));
  const type = format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new Response(body, { headers: { "content-type": type, "content-disposition": `attachment; filename="${file}.${format}"`, "cache-control": "no-store" } });
}
