"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Overview" sub="" />
      <div className="scroll">
        <LoadProblem what="these hours" reset={reset} />
      </div>
    </>
  );
}
