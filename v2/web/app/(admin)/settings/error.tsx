"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Settings" sub="" />
      <div className="scroll">
        <LoadProblem what="settings" reset={reset} />
      </div>
    </>
  );
}
