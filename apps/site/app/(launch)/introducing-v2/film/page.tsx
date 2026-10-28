import { notFound } from "next/navigation";
import Recorder from "./Recorder";

// The stage the recorder films (scripts/film.mjs). Local only.
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Recorder />;
}
