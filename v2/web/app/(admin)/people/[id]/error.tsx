"use client";

import { LoadProblem } from "../../../ui/LoadProblem";
import { Header } from "../../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Person" sub="" />
      <div className="scroll">
        <LoadProblem what="this person’s time" reset={reset} />
      </div>
    </>
  );
}
