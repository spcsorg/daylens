"use client";

import { useEffect } from "react";
import { rememberSource } from "../../_v2/source";

export default function Remember({ source }: { source: string }) {
  useEffect(() => rememberSource(source), [source]);
  return null;
}
