/**
 * The revocation, written as SQL rather than as a number computed in
 * JavaScript. Two writers that both read 3 and both write 4 revoke once
 * between them and leave a token minted at 4 alive; the database adding one
 * to whatever it currently holds cannot collapse that way. Quoted because
 * Postgres folds an unquoted identifier to lower case and the column is
 * `tokenVersion`; sqlite reads the same quoting.
 *
 * Use it as the value of `tokenVersion` in an update: every session token
 * minted before the update stops being accepted.
 */
export const BUMP_TOKEN_VERSION = () => '"tokenVersion" + 1';
