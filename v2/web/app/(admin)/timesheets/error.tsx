"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Timesheets" sub="" />
      <div className="scroll">
        <LoadProblem what="the timesheets" reset={reset} />
      </div>
    </>
  );
}
