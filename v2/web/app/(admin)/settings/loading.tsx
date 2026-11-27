import { Header } from "../../ui/parts";

export default function Loading() {
  return (
    <>
      <Header title="Settings" sub="Loading…" />
      <div className="scroll">
        <div className="skel" style={{ height: 36, width: 220, marginBottom: 24 }} />
        <div className="skel" style={{ height: 360, maxWidth: 760 }} />
      </div>
    </>
  );
}
