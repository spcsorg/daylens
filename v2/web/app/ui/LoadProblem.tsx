"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";
import { Icon } from "./Icon";

/** The couldn't-load state of every screen: what failed, and a way to try again. */
export function LoadProblem({ what, reset }: { what: string; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="notice problem" role="alert">
      <Icon name="alert" />
      <span>Couldn’t load {what}. The dashboard can’t reach Daylens right now.</span>
      <button
        type="button"
        className="notice-action"
        onClick={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      >
        Try again
      </button>
    </div>
  );
}
