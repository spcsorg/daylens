import { Header } from "../../ui/parts";

export default function Loading() {
  return (
    <>
      <Header title="Timesheets" sub="Loading…" />
      <div className="scroll">
        <div className="skel" style={{ height: 40, width: 420, marginBottom: 24 }} />
        {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skel" style={{ height: 44, marginBottom: 10 }} />)}
      </div>
    </>
  );
}
