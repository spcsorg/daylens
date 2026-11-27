import { Header } from "../../ui/parts";

export default function Loading() {
  return (
    <>
      <Header title="Clients and projects" sub="Loading…" />
      <div className="scroll">
        <div className="split">
          <div className="skel" style={{ height: 520 }} />
          <div className="skel" style={{ height: 520 }} />
        </div>
      </div>
    </>
  );
}
