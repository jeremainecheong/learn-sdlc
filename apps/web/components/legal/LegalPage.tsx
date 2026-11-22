import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, FileText, ShieldCheck } from "lucide-react";
import { OPERATOR } from "@/lib/operator";
import { PublicLayout } from "@/components/landing/PublicLayout";
import "./legal.css";

/** Policies share the public design with a readable measure and native section links. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  const privacy = title.startsWith("Privacy");
  const sections: { id: string; title: string }[] = [];
  const content = Children.map(children, (child) => {
    if (
      !isValidElement<{ children: ReactNode; id?: string }>(child) ||
      child.type !== "h2"
    )
      return child;
    const heading = String(child.props.children);
    const id = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-$/, "");
    sections.push({ id, title: heading });
    return cloneElement(child, { id });
  });
  const Symbol = privacy ? ShieldCheck : FileText;
  return (
    <PublicLayout active={privacy ? "privacy" : "terms"} showStart={false}>
      <div className="lh-legal-wrap">
        <header className="lh-legal-heading">
          <span className="lh-kicker">
            <Symbol size={16} />{" "}
            {privacy ? "Your information, explained" : "Learning together"}
          </span>
          <h1>{title}</h1>
          <p>Last updated {updated}</p>
        </header>
        <div className="lh-legal-layout">
          <aside className="lh-legal-sidebar">
            <nav className="lh-legal-toc lh-frost" aria-label="On this page">
              <h2>On this page</h2>
              <ol>
                {sections.map(({ id, title: heading }) => (
                  <li key={id}>
                    <a href={`#${id}`}>{heading}</a>
                  </li>
                ))}
              </ol>
              <a href="#contact">
                Contact the operator <ArrowUpRight size={14} />
              </a>
            </nav>
            <Link
              className="lh-legal-related"
              href={privacy ? "/terms" : "/privacy"}
            >
              {privacy ? "Read the terms of use" : "Read the privacy policy"}{" "}
              <ArrowUpRight size={16} />
            </Link>
          </aside>
          <article className="lh-legal-document lh-frost" aria-label={title}>
            {content}
            <section className="lh-legal-contact" aria-labelledby="contact">
              <h2 id="contact">Contact the operator</h2>
              <p>
                Questions about this page, requests about your data, and
                security reports go to the operator of your LearnSDLC
                installation.
              </p>
              <dl>
                <div>
                  <dt>Operator</dt>
                  <dd>{OPERATOR.name}</dd>
                </div>
                <div>
                  <dt>Contact</dt>
                  <dd>
                    {OPERATOR.email ? (
                      <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
                    ) : (
                      "Contact the person or institution that provided your access to LearnSDLC."
                    )}
                  </dd>
                </div>
              </dl>
            </section>
          </article>
        </div>
      </div>
    </PublicLayout>
  );
}
