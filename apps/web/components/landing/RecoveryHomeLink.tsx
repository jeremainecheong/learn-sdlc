'use client';

import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { homeHrefFor } from '@/lib/navigation';
import { useSession } from '@/lib/session';

/** Recovery stays in the same part of the application as the account. */
export function RecoveryHomeLink() {
  const user = useSession();
  const staff = user?.role === 'INSTRUCTOR' || user?.role === 'ADMIN';
  return <Link href={homeHrefFor(user)} className="lh-primary">
    {staff ? 'Open your classes' : 'Open your project'}
    <Icon name="arrow-right" size={15} />
  </Link>;
}
