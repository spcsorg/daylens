import { Header } from "../../ui/parts";

export default function Loading() {
  return (
    <>
      <Header title="Attendance and leave" sub="Loading…" />
      <div className="scroll">
        <div className="skel" style={{ height: 30, width: 240, marginBottom: 24 }} />
        <div className="skel" style={{ height: 420 }} />
      </div>
    </>
  );
}
