import { CodeXml, GitBranch, Layers3, Workflow } from "lucide-react";
import "./homepage-atmosphere.css";

/** Decorative side-gutter details; render as the first child of .lh-hero. */
export function HeroAtmosphere() {
  return (
    <div className="lh-hero-atmosphere" aria-hidden="true">
      <span className="lh-floating-chip lh-floating-code">
        <CodeXml size={29} strokeWidth={1.65} focusable="false" />
      </span>
      <span className="lh-floating-chip lh-floating-git">
        <GitBranch size={27} strokeWidth={1.65} focusable="false" />
      </span>
      <span className="lh-floating-chip lh-floating-layers">
        <Layers3 size={29} strokeWidth={1.65} focusable="false" />
      </span>
      <span className="lh-floating-chip lh-floating-workflow">
        <Workflow size={26} strokeWidth={1.65} focusable="false" />
      </span>
    </div>
  );
}
