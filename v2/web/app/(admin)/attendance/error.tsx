"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Attendance and leave" sub="" />
      <div className="scroll">
        <LoadProblem what="attendance" reset={reset} />
      </div>
    </>
  );
}
