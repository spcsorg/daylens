"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export type FilterDef = { key: string; label: string; all: string; options: { value: string; label: string }[] };

export function Filters({ filters }: { filters: FilterDef[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setOpen(null);
    router.push(`${path}?${next}`);
  };
  const any = filters.some((f) => params.get(f.key));

  return (
    <div className="filters" ref={ref}>
      {filters.map((f) => {
        const value = params.get(f.key);
        const chosen = f.options.find((o) => o.value === value);
        return (
          <div className="filter-wrap" key={f.key}>
            <button type="button" className={`filter${chosen ? " set" : ""}`} aria-expanded={open === f.key} onClick={() => setOpen(open === f.key ? null : f.key)}>
              {chosen ? (
                <>
                  {f.label}: <b>{chosen.label}</b>
                </>
              ) : (
                f.label
              )}
              <Icon name="chevron-down" size={14} />
            </button>
            {open === f.key && (
              <div className="popover" role="menu">
                <button type="button" className="menu-item" role="menuitem" aria-current={!chosen} onClick={() => go({ [f.key]: null })}>
                  {f.all}
                  {!chosen && <span className="tick"><Icon name="check" /></span>}
                </button>
                {f.options.map((o) => (
                  <button key={o.value} type="button" className="menu-item" role="menuitem" aria-current={o.value === value} onClick={() => go({ [f.key]: o.value })}>
                    {o.label}
                    {o.value === value && <span className="tick"><Icon name="check" /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {any && (
        <button type="button" className="btn quiet small" onClick={() => go(Object.fromEntries(filters.map((f) => [f.key, null])))}>
          Clear filters
        </button>
      )}
    </div>
  );
}
