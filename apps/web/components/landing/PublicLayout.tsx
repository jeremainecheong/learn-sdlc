import Link from "next/link";
import { ArrowRight, ArrowUp, ArrowUpRight } from "lucide-react";
import { Mark } from "@/components/Mark";
import { Aurora } from "./Aurora";
import "./public-navigation.css";
import "./public-interactions.css";

export function PublicBrand() {
  return (
    <Link href="/" className="lh-brand" aria-label="LearnSDLC home">
      <Mark size={39} className="lh-brand-mark" />
      <span className="lh-wordmark">
        learn<span>sdlc</span>
      </span>
    </Link>
  );
}
const links = [
  ["home", "/", "Home"],
  ["how", "/how-it-works", "How it works"],
  ["learn", "/what-you-learn", "What you’ll learn"],
] as const;
export function PublicLayout({
  active,
  children,
  showStart = true,
}: {
  active: "home" | "how" | "learn" | "privacy" | "terms" | "status";
  children: React.ReactNode;
  showStart?: boolean;
}) {
  return (
    <div className="marketing" data-public-page={active} id="public-top">
      <Aurora />
      <header className="lh-top">
        <nav className="lh-nav lh-frost" aria-label="Main navigation">
          <PublicBrand />
          <div className="lh-navlinks">
            {links.map(([key, href, label]) => (
              <Link
                key={key}
                href={href}
                className="lh-navlink"
                aria-current={key === active ? "page" : undefined}
              >
                {label}
              </Link>
            ))}
          </div>
          <div className="lh-auth-actions">
            <Link href="/login" className="lh-signin">
              Sign in
            </Link>
            <Link href="/register" className="lh-primary">
              Create an account <ArrowUpRight size={17} />
            </Link>
          </div>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
        {showStart && (
          <section className="lh-start lh-frost">
            <div>
              <h2>Your first project starts here.</h2>
              <p>
                Create an account and start learning the decisions behind
                working software.
              </p>
            </div>
            <Link className="lh-primary" href="/register">
              Create an account <ArrowUpRight size={18} />
            </Link>
          </section>
        )}
      </main>
      <div className="lh-content">
        <footer className="lh-footer">
          <div className="lh-footer-main">
            <div className="lh-footer-brand">
              <PublicBrand />
              <div className="lh-footer-tagline">
                Understand the process.
                <br />
                Own what you build.
              </div>
              <p className="lh-footer-description">
                Learn how software comes together through practical work,
                thoughtful decisions, and a little curiosity.
              </p>
            </div>
            <nav className="lh-footer-column" aria-label="Explore">
              <h2>Explore</h2>
              <ul className="lh-footer-links">
                {links.map(([key, href, label]) => (
                  <li key={key}>
                    <Link className="lh-footer-link" href={href}>
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav className="lh-footer-column" aria-label="Your next step">
              <h2>Your next step</h2>
              <ul className="lh-footer-links">
                <li>
                  <Link className="lh-footer-link" href="/register">
                    Create an account <ArrowRight size={13} />
                  </Link>
                </li>
                <li>
                  <Link className="lh-footer-link" href="/login">
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link className="lh-footer-link" href="/privacy">
                    Privacy
                  </Link>
                </li>
                <li>
                  <Link className="lh-footer-link" href="/terms">
                    Terms of use
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <div className="lh-footer-bottom">
            <span>© {new Date().getFullYear()} LearnSDLC</span>
            <a className="lh-back-top" href="#public-top">
              Back to top <ArrowUp size={14} />
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
