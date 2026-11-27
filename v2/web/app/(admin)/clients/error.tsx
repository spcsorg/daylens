"use client";

import { LoadProblem } from "../../ui/LoadProblem";
import { Header } from "../../ui/parts";

export default function Failed({ reset }: { reset: () => void }) {
  return (
    <>
      <Header title="Clients and projects" sub="" />
      <div className="scroll">
        <LoadProblem what="clients and projects" reset={reset} />
      </div>
    </>
  );
}
