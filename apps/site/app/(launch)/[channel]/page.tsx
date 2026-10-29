import { CHANNELS } from "../../_v2/source";
import Remember from "../_launch/Remember";
import Waitlist from "../launch/page";

export const dynamicParams = false;

export function generateStaticParams() {
  return CHANNELS.map((channel) => ({ channel }));
}

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  return (
    <>
      <Remember source={channel} />
      <Waitlist />
    </>
  );
}
