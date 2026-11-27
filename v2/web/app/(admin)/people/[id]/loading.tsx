import { Header } from "../../../ui/parts";

export default function Loading() {
  return (
    <>
      <Header title="Loading…" sub="" back="/people" />
      <div className="scroll">
        <div className="stats">
          {[1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 112 }} />)}
        </div>
        <div className="grid-2">
          <div className="skel" style={{ height: 360 }} />
          <div className="skel" style={{ height: 360 }} />
        </div>
      </div>
    </>
  );
}
