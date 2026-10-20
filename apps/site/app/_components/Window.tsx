import Image from "next/image";
import { SCREENS, type ScreenKey } from "../_lib/content";

export function Window({
  screen,
  priority = false,
  sizes = "(min-width: 1240px) 1120px, 94vw",
}: {
  screen: ScreenKey;
  priority?: boolean;
  sizes?: string;
}) {
  const s = SCREENS[screen];
  return (
    <div className="window">
      <Image src={s.src} alt={s.alt} fill sizes={sizes} priority={priority} quality={90} />
    </div>
  );
}
