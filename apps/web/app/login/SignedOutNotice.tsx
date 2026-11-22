'use client';

import { useEffect, useState } from 'react';
import { SIGNED_OUT_NOTICE, takeSignedOut } from '@/lib/auth-signout';
import { Notice } from '@/components/ui';

/**
 * What a managed sign-out ended, said once on the sign-in page.
 *
 * Pressing Sign out ends the LearnSDLC session on this browser. It does not
 * sign anyone out of Google, and a person on a shared machine needs to know
 * that before they walk away. The sentence is asked for by a per-tab mark that
 * only a managed sign-out leaves (lib/auth-signout.ts), and the mark is spent
 * on first read, so a reload or a later visit shows the form alone.
 *
 * Read in an effect: the mark is spent on read, and the effect's state
 * survives the development double run, where a read during render would be
 * spent on the render React throws away.
 */
export function SignedOutNotice() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (takeSignedOut()) setShown(true);
  }, []);
  if (!shown) return null;
  return (
    <Notice tone="info" role="status" testId="signed-out">
      {SIGNED_OUT_NOTICE}
    </Notice>
  );
}
