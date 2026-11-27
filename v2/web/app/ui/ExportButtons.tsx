"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { ToastView, useToast } from "./controls";

/** Excel and CSV downloads of the table on screen, with the same filters. A failed export says so instead of saving an error page. */
export function ExportButtons({ table, params, disabled }: { table: "people" | "timesheets" | "attendance"; params: Record<string, string | undefined>; disabled?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, notify] = useToast();
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));

  const save = async (format: "xlsx" | "csv") => {
    setBusy(format);
    try {
      query.set("format", format);
      const res = await fetch(`/export/${table}?${query}`);
      if (!res.ok) throw new Error((await res.text()) || "Couldn’t export: the file didn’t build. Try again.");
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${table}.${format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
      notify({ text: `Saved ${name}` });
    } catch (e) {
      notify({ text: e instanceof TypeError ? "Couldn’t export: Daylens didn’t answer. Try again." : (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className="btn secondary small" disabled={disabled || !!busy} aria-busy={busy === "xlsx"} onClick={() => save("xlsx")}>
        <Icon name="download" />
        Excel
      </button>
      <button type="button" className="btn quiet small" disabled={disabled || !!busy} aria-busy={busy === "csv"} onClick={() => save("csv")}>
        CSV
      </button>
      <ToastView toast={toast} />
    </>
  );
}
