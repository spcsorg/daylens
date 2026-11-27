"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="People" sub="" />
      <div className="scroll">
        <LoadProblem what="the team table" reset={reset} />
      </div>
    </>
  );
}
