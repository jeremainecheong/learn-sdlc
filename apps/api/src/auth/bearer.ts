/** The token an `Authorization: Bearer <token>` header carries, or null for any other header or none. */
export function bearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}
