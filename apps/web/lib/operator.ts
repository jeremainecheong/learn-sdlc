/**
 * Who is legally responsible for this deployment, and where mail actually
 * arrives.
 *
 * These are read from the environment rather than hard-coded because a contact
 * address must be one that receives mail: a placeholder on a reserved domain
 * (RFC 2606) can never receive any, and a privacy policy whose only contact
 * address is undeliverable offers the reader nothing.
 *
 * An unconfigured installation must not invent an operator or a mailbox.
 */
export const OPERATOR = {
  name:
    process.env.NEXT_PUBLIC_OPERATOR_NAME ||
    'LearnSDLC installation operator',
  email: process.env.NEXT_PUBLIC_OPERATOR_EMAIL || null,
};
