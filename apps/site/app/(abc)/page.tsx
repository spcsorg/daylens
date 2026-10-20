import { HeroLetter, HeroSearch, HeroStatements, ReelSection, Statements } from "../_components/Heroes";
import { Nav } from "../_components/Nav";
import {
  AssistantsSection,
  ClosingSection,
  FaqSection,
  Footer,
  HoursSection,
  LogRule,
  PrivacySection,
} from "../_components/Sections";
import { WithWithout } from "../_components/WithWithout";

const VARIANT = process.env.NEXT_PUBLIC_SITE_VARIANT ?? "a";

export default function Page() {
  return (
    <>
      <Nav />
      <LogRule />
      <main>
        {VARIANT === "b" ? (
          <>
            <HeroSearch />
            <ReelSection />
            <HoursSection />
            <WithWithout />
            <AssistantsSection />
            <PrivacySection />
          </>
        ) : VARIANT === "c" ? (
          <>
            <HeroLetter />
            <HoursSection />
            <PrivacySection />
          </>
        ) : (
          <>
            <HeroStatements />
            <Statements />
            <HoursSection />
            <WithWithout />
            <PrivacySection />
          </>
        )}
        <FaqSection />
        <ClosingSection title={VARIANT === "a" ? "Find anything you saw. So can your AI." : "Your day, remembered."} />
      </main>
      <Footer />
    </>
  );
}
