"use client";

import { LoadProblem } from "./ui/LoadProblem";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <main className="signin">
      <LoadProblem what="the dashboard" reset={reset} />
    </main>
  );
}
