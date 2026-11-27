"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the page on an interval, which is how "Active now" stays current. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
